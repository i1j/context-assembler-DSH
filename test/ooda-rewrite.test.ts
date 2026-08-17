/**
 * lib/ooda-rewrite.js 单测（7.1 + 部分 7.2 thought：Fct 多事务 OODA 装配，thought+tool 合流）。
 *
 * TDD 契约（先红后绿）：
 *   planOodaRewrites    —— 只 thought/fin 行；tail 硬保护；surfaceSeqs 可见性；doneSeqs 幂等；
 *                          fct status=done 才替换；经济门槛；after=formatFctAffairs；升序；fail-open。
 *   executeThoughtRewrites —— 真实 DSH Session：content 替换为 Fct 文本；保留 tool-call block；
 *                          message.id/role/source 保持；surfaceOp/sourceEventSeqs 形状。
 *   assembleOodaCtx     —— dry-run 留档统计（rawChars/afterChars/savedChars/savePct）。
 *   collectOrientCards  —— 每事务首段 thought/fin → orient 卡（决策 44 运行时版）。
 *   maybeRewriteThoughts —— mock 4B 队列：tail 外事务入队（idempotent）；dry-run 只留档不注入；
 *                          done 事务 plan→execute 落地。
 */
import { describe, it, expect } from 'vitest';
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { newSession, appendTurn, appendUser, appendAssistant, foldView } from './helpers.js';
import { createFctOodaQueue } from '../lib/fct-ooda.js';
import {
  planOodaRewrites,
  executeThoughtRewrites,
  assembleOodaCtx,
  collectOrientCards,
  maybeRewriteThoughts,
} from '../lib/ooda-rewrite.js';

const okAffairs = (hdl = '连接池扩容') => [
  { hdl, turns: [1], ooda: { '现象与问题': ['连接池耗尽'], '背景与约束': ['上限100'], '决策与方案': ['扩容到200'], '后续行动': [] } },
];

/** view 夹具：3 个事务，事务 1/2 各带长 thought，事务 3 是尾部 */
function oodaView() {
  return [
    { type: 'user', transaction_id: 1, elm_ref: 1, text: '帮我修连接池' },
    { type: 'thought', transaction_id: 1, elm_ref: 10, text: 'x'.repeat(900), ooda_stage: 'decide' },
    { type: 'user', transaction_id: 2, elm_ref: 2, text: '继续' },
    { type: 'fin', transaction_id: 2, elm_ref: 20, text: 'y'.repeat(900), ooda_stage: 'decide' },
    { type: 'user', transaction_id: 3, elm_ref: 3, text: '新任务' },
    { type: 'thought', transaction_id: 3, elm_ref: 30, text: 'z'.repeat(900), ooda_stage: 'decide' },
  ];
}

describe('planOodaRewrites（thought 行装配计划）', () => {
  it('P1 只 thought/fin 行；user/toolCall/toolResult/synthetic 跳过', () => {
    const view = [
      ...oodaView(),
      { type: 'toolCall', transaction_id: 1, elm_ref: 11, text: 'bash x', ooda_stage: 'act' },
      { type: 'toolResult', transaction_id: 1, elm_ref: 12, text: 'L1 x', ooda_stage: 'observe' },
      { type: 'synthetic', transaction_id: 9, elm_ref: 90, text: 'plugin' },
    ];
    const fct = new Map([[1, { status: 'done', affairs: okAffairs() }]]);
    const plan = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set([10, 20, 30, 11, 12, 90]) });
    expect(plan.map((p) => p.seq)).toEqual([10]); // 事务 1 的 thought；事务 2 无 fct；事务 3 tail(0) 但无 fct
  });

  it('P2 tail 硬保护：最后 tailN 个 user 轮的事务不替换', () => {
    const view = oodaView();
    const fct = new Map([
      [1, { status: 'done', affairs: okAffairs() }],
      [2, { status: 'done', affairs: okAffairs('b') }],
      [3, { status: 'done', affairs: okAffairs('c') }],
    ]);
    const plan = planOodaRewrites(view, fct, { tailTurns: 2, minSavingChars: 100, surfaceSeqs: new Set([10, 20, 30]) });
    expect(plan.map((p) => p.txnId)).toEqual([1]); // 事务 2/3 在 tail 保护区
  });

  it('P3 surfaceSeqs 可见性：已遮蔽（不在表层）跳过', () => {
    const view = oodaView();
    const fct = new Map([[1, { status: 'done', affairs: okAffairs() }]]);
    const plan = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set([]) });
    expect(plan).toEqual([]); // seq 10 不在表层
  });

  it('P4 doneSeqs 幂等：已替换跳过', () => {
    const view = oodaView();
    const fct = new Map([[1, { status: 'done', affairs: okAffairs() }]]);
    const plan = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set([10, 20, 30]), doneSeqs: new Set([10]) });
    expect(plan).toEqual([]);
  });

  it('P5 fct 未就绪（pending/failed/缺省）→ 跳过（fail-open，宁留原文）', () => {
    const view = oodaView();
    const fct = new Map([
      [1, { status: 'pending' }],
      [2, { status: 'failed', affairs: null }],
    ]);
    const plan = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set([10, 20, 30]) });
    expect(plan).toEqual([]);
  });

  it('P6 经济门槛：savingChars < minSavingChars 跳过；after=formatFctAffairs', () => {
    const view = oodaView();
    const fct = new Map([[1, { status: 'done', affairs: okAffairs() }]]);
    const after = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 1000, surfaceSeqs: new Set([10, 20, 30]) });
    expect(after).toEqual([]); // 900 字符原文 → Fct 摘要约 60 字符，节省 ~840 < 1000
    const plan = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set([10, 20, 30]) });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ seq: 10, txnId: 1, rawChars: 900 });
    expect(plan[0].after).toContain('1. 连接池扩容');
    expect(plan[0].after).toContain('现象与问题: 连接池耗尽');
    expect(plan[0].savingChars).toBe(900 - plan[0].after.length);
  });

  it('P7 升序输出；无 fct 可替 → 空计划', () => {
    const view = oodaView();
    const fct = new Map([[1, { status: 'done', affairs: okAffairs() }]]);
    const plan = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set([10, 20, 30]) });
    expect(plan[0].seq).toBe(10);
    expect(planOodaRewrites(view, new Map(), { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set([10, 20, 30]) })).toEqual([]);
  });
});

describe('collectOrientCards（运行时事务首段 think）', () => {
  it('C1 每事务首段 thought/fin → orient 卡（决策 44 运行时版）；questionText=事务 user 文本', () => {
    const cards = collectOrientCards(oodaView());
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ cardKind: 'orient', seq: 10, txnId: 1, questionText: '帮我修连接池' });
    expect(cards[1]).toMatchObject({ cardKind: 'orient', seq: 20, txnId: 2, questionText: '继续' });
    expect(cards[2]).toMatchObject({ cardKind: 'orient', seq: 30, txnId: 3, questionText: '新任务' });
    expect(cards[0].preview).toBe('x'.repeat(900).slice(0, 160)); // preview 截断
  });

  it('C2 非首段 thought 不入；synthetic 跳过', () => {
    const view = [
      ...oodaView(),
      { type: 'thought', transaction_id: 1, elm_ref: 11, text: 'second', ooda_stage: 'decide' },
      { type: 'synthetic', transaction_id: 9, elm_ref: 90, text: 'p', ooda_stage: 'decide' },
    ];
    const cards = collectOrientCards(view);
    expect(cards.map((c) => c.seq)).toEqual([10, 20, 30]);
  });
});

describe('executeThoughtRewrites（真实 Session）', () => {
  it('E1 长 reasoning → Fct 文本；content 只留 text；message.id/role/source 保持；表层替换生效', () => {
    const session = newSession('s-ooda-e1');
    // 一个完整事务：user + 长 thought（assistant 文本）+ turn/end 闭合
    session.append('turn/start', { turn: 1 });
    appendUser(session, '修连接池');
    const thought = session.append(
      'assistant/message',
      { turn: 1, step: 2, message: createAssistantMessage({ content: [{ type: 'text', text: 'x'.repeat(800) }], source: { provider: 'p', model: 'm' } }) },
      { surfaceOp: 'append' },
    );
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

    const fct = new Map([[1, { status: 'done', affairs: okAffairs() }]]);
    const view = foldView(session);
    const surface = new Set(session.surface.nodes ?? []);
    const plan = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: surface });
    expect(plan).toHaveLength(1);
    expect(plan[0].seq).toBe(thought.seq);

    const applied = executeThoughtRewrites(session, plan);
    expect(applied).toHaveLength(1);
    expect(applied[0].seq).toBe(thought.seq);
    // 表层替换生效：原 seq 被遮蔽，新 seq 在表层
    expect(session.surface.nodes).not.toContain(thought.seq);
    // 新事件 content 只含 Fct 文本
    const appended = session.events.find((e): e is Extract<SessionEvent, { type: 'assistant/message' }> => e.type === 'assistant/message' && e.seq === applied[0].appendedSeq);
    const content = (appended?.data?.message?.content ?? []) as any[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect((content[0] as { text?: string }).text).toContain('1. 连接池扩容');
    expect(appended?.data?.message?.source).toEqual({ kind: 'model', provider: 'p', model: 'm' });
  });

  it('E2 保留 tool-call block（保 pairing，8-15 P0）', () => {
    const session = newSession('s-ooda-e2');
    session.append('turn/start', { turn: 1 });
    appendUser(session, '跑命令');
    const asst = session.append(
      'assistant/message',
      { turn: 1, step: 2, message: createAssistantMessage({ content: [{ type: 'reasoning', text: 'reasoning'.repeat(120) }, { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' }], source: { provider: 'p', model: 'm' } }) },
      { surfaceOp: 'append' },
    );
    session.append('tool/call', { turn: 1, step: 2, callId: CallId('c1'), name: 'bash', arguments: '{}' });
    session.append('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false }) }, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

    const fct = new Map([[1, { status: 'done', affairs: okAffairs() }]]);
    const view = foldView(session);
    const plan = planOodaRewrites(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set(session.surface.nodes ?? []) });
    const applied = executeThoughtRewrites(session, plan);
    const appended = session.events.find((e): e is Extract<SessionEvent, { type: 'assistant/message' }> => e.type === 'assistant/message' && e.seq === applied[0].appendedSeq);
    const content = (appended?.data?.message?.content ?? []) as any[];
    expect(content.map((b) => b.type)).toEqual(['text', 'tool-call']); // text + 保留 tool-call
    expect((content[1] as { id?: string }).id).toBe('c1');
  });

  it('E3 目标非 assistant/message → 跳过', () => {
    const session = newSession('s-ooda-e3');
    const applied = executeThoughtRewrites(session, [{ seq: 999, txnId: 1, before: '', after: 'x', rawChars: 0, savingChars: 0 }]);
    expect(applied).toEqual([]);
  });
});

describe('assembleOodaCtx（dry-run 留档）', () => {
  it('A1 stats 统计：rawChars/afterChars/savedChars/savePct；replacements 含 before/after', () => {
    const view = oodaView();
    const fct = new Map([[1, { status: 'done', affairs: okAffairs() }]]);
    const assembly = assembleOodaCtx(view, fct, { tailTurns: 0, minSavingChars: 100, surfaceSeqs: new Set([10, 20, 30]) });
    expect(assembly.plan).toHaveLength(1);
    expect(assembly.replacements[0]).toMatchObject({ seq: 10, txnId: 1, rawChars: 900 });
    expect(assembly.replacements[0].before).toBe('x'.repeat(900));
    expect(assembly.replacements[0].after).toContain('1. 连接池扩容');
    expect(assembly.stats.planned).toBe(1);
    expect(assembly.stats.rawChars).toBe(900);
    expect(assembly.stats.afterChars).toBe(assembly.replacements[0].after.length);
    expect(assembly.stats.savedChars).toBe(900 - assembly.replacements[0].after.length);
    expect(assembly.stats.savePct).toBeGreaterThan(0);
  });
});

describe('maybeRewriteThoughts（集成：mock 4B 队列 + 真实 Session）', () => {
  const log = { info: () => {}, warn: () => {} };

  function makeSession() {
    const session = newSession('s-ooda-m');
    appendTurn(session, 1, { userText: '修连接池', thought: 'x'.repeat(800), close: true });
    appendTurn(session, 2, { userText: '继续', thought: 'y'.repeat(800), close: true });
    appendTurn(session, 3, { userText: '新任务', thought: 'z'.repeat(800), close: true });
    return session;
  }

  it('M1 入队：tail 外未生成事务被 enqueue（每事务一次，idempotent）', () => {
    const session = makeSession();
    const view = foldView(session);
    let enqueued: number[] = [];
    const queue = createFctOodaQueue({ run4B: async () => ({ status: 'ok', affairs: okAffairs() }) });
    // 手动调用：用真实 queue + dry-run，观察 enqueued（通过 stats 或 get 状态推断）
    maybeRewriteThoughts({}, { session }, view, { oodaRewriteEnabled: true, oodaRewriteDryRun: true, tailN: 1, oodaMinSavingChars: 100 }, log, queue);
    // tailN=1 → 事务 1/2 滑出保护区（事务 3 尾部）→ 应入队 2 个
    expect(queue.stats(session).pending + queue.stats(session).done + queue.stats(session).failed).toBe(2);
  });

  it('M2 dry-run：只留档不注入（applied=0，dryRun=true，plan 有内容）；重复调用不重复入队', async () => {
    const session = makeSession();
    const queue = createFctOodaQueue({ run4B: async () => ({ status: 'ok', affairs: okAffairs() }) });
    const view = () => foldView(session);
    const r1 = maybeRewriteThoughts({}, { session }, view(), { oodaRewriteEnabled: true, oodaRewriteDryRun: true, tailN: 1, oodaMinSavingChars: 100 }, log, queue);
    expect(r1.applied).toBe(0);
    expect(r1.dryRun).toBe(true);
    // 等队列出结果
    await new Promise((res) => setTimeout(res, 100));
    const r2 = maybeRewriteThoughts({}, { session }, view(), { oodaRewriteEnabled: true, oodaRewriteDryRun: true, tailN: 1, oodaMinSavingChars: 100 }, log, queue);
    // 事务 1/2 已入队不重复；此时 fct done → 应出计划
    expect(r2.dryRun).toBe(true);
    expect(r2.plan.length).toBeGreaterThanOrEqual(1);
    expect(queue.stats(session).done).toBe(2); // 每事务一次 4B
  });

  it('M3 非 dry-run：done 事务 plan→execute 落地（thought 行被替换）', async () => {
    const session = makeSession();
    const queue = createFctOodaQueue({ run4B: async () => ({ status: 'ok', affairs: okAffairs() }) });
    const view = () => foldView(session);
    const r1 = maybeRewriteThoughts({}, { session }, view(), { oodaRewriteEnabled: true, oodaRewriteDryRun: false, tailN: 1, oodaMinSavingChars: 100 }, log, queue);
    expect(r1.applied).toBe(0); // 队列异步，首轮无 done
    await new Promise((res) => setTimeout(res, 200));
    const r2 = maybeRewriteThoughts({}, { session }, view(), { oodaRewriteEnabled: true, oodaRewriteDryRun: false, tailN: 1, oodaMinSavingChars: 100 }, log, queue);
    expect(r2.applied).toBeGreaterThanOrEqual(1);
    // 已替换 seq 不再二次计划
    const r3 = maybeRewriteThoughts({}, { session }, view(), { oodaRewriteEnabled: true, oodaRewriteDryRun: false, tailN: 1, oodaMinSavingChars: 100 }, log, queue);
    expect(r3.applied).toBe(0);
  });

  it('M4 开关关闭 → 空操作；异常 → fail-open（不抛错）', () => {
    const session = makeSession();
    const queue = createFctOodaQueue({ run4B: async () => ({ status: 'ok', affairs: okAffairs() }) });
    const r = maybeRewriteThoughts({}, { session }, foldView(session), { oodaRewriteEnabled: false }, log, queue);
    expect(r).toEqual({ applied: 0, plan: [], dryRun: false });
    const r2 = maybeRewriteThoughts({}, { session: null as any }, foldView(session), { oodaRewriteEnabled: true, oodaRewriteDryRun: true }, log, queue);
    expect(r2.applied).toBe(0); // session 缺失 fail-open
  });
});
