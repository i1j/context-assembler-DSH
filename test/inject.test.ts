/**
 * inject.js + index.js pre-step 注入链路单测（R3 / T4 / T4b / T4c-1 / T4c-2 / T4c-2b / T4c-3 / T5）
 *
 * mock 策略（testplan §3）：真实 Session（事件日志驱动视图 fold）+ mock ctx
 * （sessionProjections.snapshot / llm.stream / tokenMeter.estimateMessage / on 记录 listener）；
 * 经 apply() 挂载后直调 pre-step listener 传 mock next（E1）。
 * 计数：返回批次中 source.plugin='ca-v7' 消息数；llm 摘要调用（purposes）计数。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { apply, Config } from '../lib/index.js';
import { decideInjection, buildInjectionContent, buildInjectionMessage, findCheckpointOverlap, OVERLAP_MIN_LEN } from '../lib/inject.js';
import { rebuildInjectHistory } from '../lib/index.js';
import {
  newSession,
  appendTurn,
  appendPluginInjection,
  appendCompactionSummary,
  appendCompactionPrune,
  appendCompactionSummary as appendSummary,
  makeEngineCtx,
  foldView,
  richTxn,
  appendHeader,
  appendUser,
  makeAgent,
} from './helpers.js';

/** pre-step 运行器：调挂载的 listener 传 mock next */
async function runPreStep(
  harness: ReturnType<typeof makeEngineCtx>,
  agent: { session: ReturnType<typeof newSession>; options: { provider: string; model: string } },
  step: number,
  opts: { kind?: 'enter' | 'reject'; messages?: unknown[] } = {},
) {
  const listener = harness.listeners['agent/pre-step'] as (
    payload: { agent: unknown; step: number; signal: AbortSignal },
    next: () => Promise<{ kind: string; messages: unknown[] }>,
  ) => Promise<{ kind: string; messages: unknown[] }>;
  const next = async () => ({
    kind: opts.kind ?? 'enter',
    messages: opts.messages ?? [{ role: 'user', content: [{ type: 'text', text: '真实用户消息' }] }],
  });
  return listener({ agent, step, signal: new AbortController().signal }, next);
}

/** 挂载插件并返回 harness（view 可动态——liveView 时每次 snapshot 重折） */
function mount(session: ReturnType<typeof newSession>, view: unknown[], opts: { liveView?: boolean; config?: Record<string, unknown> } = {}) {
  const harness = makeEngineCtx(session, view as never, { liveView: opts.liveView });
  harness.ctx.sessionProjections.register = () => () => {};
  harness.ctx.sessionProjections.onChanged = () => () => {};
  const config = Config(opts.config ?? {});
  apply(harness.ctx, config);
  return harness;
}

/** 从返回批次计数 ca-v7 注入消息 */
function countCaV7(decision: { messages: unknown[] }): number {
  return decision.messages.filter(
    (m) => (m as { source?: { plugin?: string } }).source?.plugin === 'ca-v7',
  ).length;
}

/** 3 turn 会话 + turn 1 FAR 遮蔽未承载 + turn 2 REL 承载（T4 fixture 前置） */
function buildT4Session() {
  const session = newSession('t4');
  appendTurn(session, 1, { userText: 'turn 1 用户问题', thought: 'turn 1 回复' });
  appendTurn(session, 2, { userText: 'shared common prefix beta', thought: 'r2' });
  appendTurn(session, 3, { userText: 'shared common prefix gamma', thought: 'r3' });
  const surfaceSeqs = [...session.surface.nodes];
  const t1Seqs = surfaceSeqs.filter((s) => s <= session.events[5].seq); // turn 1 user+fin
  const t2Seqs = surfaceSeqs.filter((s) => s > session.events[5].seq && s <= session.events[9].seq); // turn 2
  // 合并遮蔽 turn1+turn2；摘要承载 turn 2（REL），turn 1 未承载（B17）
  appendSummary(session, {
    shadowedSeqs: [...t1Seqs, ...t2Seqs],
    carriedTxnIds: [2],
    summaryText: 'checkpoint summary text',
  });
  session.append('turn/start', { turn: 4 }); // turn 4 已开启
  return session;
}

describe('R3 decideInjection 决策表（C22/B4）', () => {
  it('shadowed+unloaded+未注入 → inject（候选）；carried/visible/已注入 → skip', () => {
    const view = [
      ...richTxn(1, { userText: 'u1', finText: 'f1', visibility: 'shadowed', carrierState: 'unloaded' }),
      ...richTxn(2, { userText: 'u2', finText: 'f2', visibility: 'shadowed', carrierState: 'carried' }),
      ...richTxn(3, { userText: 'u3', finText: 'f3', visibility: 'visible', carrierState: 'unloaded' }),
    ];
    const cfg = { enabled: true, tokenLimit: 500, k: 1 };
    const d1 = decideInjection(view, cfg, new Set());
    expect(d1.action).toBe('inject');
    expect(d1.candidateTxnIds).toEqual([1]);
    expect(d1.reason).toContain('FAR');
    // carried 跳过（行 2）
    const d2 = decideInjection(view.filter((e) => e.transaction_id !== 1), cfg, new Set());
    expect(d2.action).toBe('skip');
    expect(d2.reason).toContain('no FAR shadowed');
    // 已注入跳过（行 4）
    const d3 = decideInjection(view, cfg, new Set([1]));
    expect(d3.action).toBe('skip');
    // 配置关闭
    expect(decideInjection(view, { ...cfg, enabled: false }, new Set()).action).toBe('skip');
  });

  it('A33 衰减：注入历史含事务 → 不重注入', () => {
    const view = [...richTxn(1, { userText: 'u1', finText: 'f1', visibility: 'shadowed', carrierState: 'unloaded' })];
    expect(decideInjection(view, { enabled: true, tokenLimit: 500, k: 1 }, new Set([1])).action).toBe('skip');
  });
});

describe('R3 内容确定性拼装（D26/D29，无 LLM）', () => {
  it('buildInjectionContent：user Elm 在前 + ooda_stage 标注；sections 长度 = min(k, 候选数)', () => {
    const view = [
      ...richTxn(1, { userText: 'turn 1 用户原文', finText: 'turn 1 回复' }),
      ...richTxn(2, { userText: 'turn 2 用户原文', finText: 'turn 2 回复' }),
    ];
    const content = buildInjectionContent(view, [1, 2], 2);
    expect(content.startsWith('turn 1 用户原文')).toBe(true); // 以首个候选 user 原文开头
    expect(content).toContain('[transaction: 1]');
    expect(content).toContain('[ooda_stage: orient]');
    expect(content).toContain('turn 2 用户原文');
    // sections 长度 = min(k, 候选数)
    const msg = buildInjectionMessage(view, [1, 2], { enabled: true, tokenLimit: 100000, k: 2 }, () => 0);
    expect(msg.message.source).toMatchObject({ kind: 'plugin', plugin: 'ca-v7', form: 'snapshot' });
    const sections = (msg.message.source as unknown as { sections: { name: string; text: string }[] }).sections;
    expect(sections.filter((s) => s.name.startsWith('transaction-')).length).toBe(2);
    expect(sections.find((s) => s.name === 'transaction_refs')?.text).toBe(JSON.stringify([1, 2]));
  });

  it('token 超限截断：保持 user 原文前缀、token ≤ 上限（二分最长前缀）', () => {
    const view = [...richTxn(1, { userText: 'prefix-of-user-text', finText: 'fin' })];
    const estimate = (m: { content?: { type?: string; text?: string }[] }) =>
      (m?.content ?? []).reduce((s, b) => s + (b.text ? b.text.length : 0), 0);
    const msg = buildInjectionMessage(view, [1], { enabled: true, tokenLimit: 10, k: 1 }, estimate as never);
    const text = (msg.message.content as { text?: string }[])[0]?.text ?? '';
    expect(estimate({ content: [{ type: 'text', text }] })).toBeLessThanOrEqual(10);
    // 截断保持 user 原文前缀（截断后文本是原文的前缀）
    expect('prefix-of-user-text'.startsWith(text.replace(/\n.*$/s, ''))).toBe(true);
    expect(text.startsWith('prefix-of-user-text'.slice(0, 10))).toBe(true);
    // 截断后 transaction-* section 与 content 一致（durable 记录 = 模型实际输入）
    const sections = (msg.message.source as unknown as { sections: { name: string; text: string }[] }).sections;
    const tx = sections.find((s) => s.name === 'transaction-1');
    expect(tx?.text).toBe(text);
    expect(sections.find((s) => s.name === 'transaction_refs')?.text).toBe(JSON.stringify([1]));
  });
});

describe('R3 pre-step 注入（T4）', () => {
  it('T4 fixture 前置：turn 1 未承载 + 不可见；批次含 1 条 ca-v7 消息（role=user/文本非空/token≤上限/尾部）+ 内容公式 + 无 LLM', async () => {
    const session = buildT4Session();
    const view = foldView(session);
    // fixture 前置检查（D63）：turn 1 承载状态 = unloaded、可见性 = shadowed
    const t1Elm = view.find((e) => e.transaction_id === 1);
    expect(t1Elm?.carrierState).toBe('unloaded');
    expect(t1Elm?.visibility).toBe('shadowed');
    const harness = mount(session, view);
    const decision = await runPreStep(harness, makeAgent(session), 1);
    expect(decision.kind).toBe('enter');
    expect(countCaV7(decision)).toBe(1);
    const injected = (decision.messages as { source: { plugin: string }; content: { type: string; text: string }[] }[]).find(
      (m) => m.source?.plugin === 'ca-v7',
    )!;
    expect(injected.content[0].type).toBe('text');
    const text = injected.content[0].text;
    expect(text.length).toBeGreaterThan(0);
    // 内容公式（D55/D22'）：以 turn 1 user 原文开头 + 含 ooda_stage 标注
    expect(text.startsWith('turn 1 用户问题')).toBe(true);
    expect(text).toContain('ooda_stage');
    // token ≤ 上限（estimateMessage 口径）
    const tokens = (injected.content as { text: string }[]).reduce((s, b) => s + b.text.length, 0);
    expect(tokens).toBeLessThanOrEqual(500);
    // 尾部追加：注入消息位于批次尾部
    expect(decision.messages[decision.messages.length - 1]).toBe(injected);
    // 与检查点无 ≥20 字符重叠（D45）
    expect(findCheckpointOverlap(text, session.events)).toBeNull();
    // 注入路径无 LLM（purposes 计数 = 0——无压缩触发）
    expect(harness.purposes.length).toBe(0);
  });

  it('T4b：turn 1 首 step 不注入（无已闭合事务）+ 正向配对（批次含 turn 1 真实 user）+ 负向分支（非 enter 不追加）', async () => {
    const session = newSession('t4b');
    const view = foldView(session); // 空视图（无已闭合事务）
    const harness = mount(session, view);
    const userMsg = { role: 'user', content: [{ type: 'text', text: 'turn 1 真实用户消息' }] };
    const decision = await runPreStep(harness, makeAgent(session), 1, { messages: [userMsg] });
    expect(decision.kind).toBe('enter');
    expect(countCaV7(decision)).toBe(0); // 无注入
    expect(decision.messages).toContain(userMsg); // 正向配对：turn 1 自身真实 user 仍在批次
    // 负向分支（F25）：mock next 返回非 enter（拒绝）→ 不追加
    const rejected = await runPreStep(harness, makeAgent(session), 1, { kind: 'reject', messages: [userMsg] });
    expect(countCaV7(rejected)).toBe(0);
  });

  it('T4c-1：无遮蔽事务不注入；prune 变体（B38）——仅 tool-result 被 prune 事务可见性不变 + 计数不增长', async () => {
    const session = newSession('t4c1');
    appendTurn(session, 1, { userText: 'turn 1', thought: 'r1' });
    appendTurn(session, 2, { userText: 'turn 2', thought: 'r2' });
    const surfaceSeqs = [...session.surface.nodes];
    appendCompactionPrune(session, [surfaceSeqs[surfaceSeqs.length - 1]]); // prune 仅 tool-result 单节点
    session.append('turn/start', { turn: 3 });
    const view = foldView(session);
    expect(view.every((e) => e.visibility === 'visible')).toBe(true); // prune 不改变事务可见性
    const harness = mount(session, view);
    const decision = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(decision)).toBe(0); // prune 不产生候选
  });

  it('T4c-2：REL 承载事务跳过（计数 0）+ debug 承载状态 = carried', async () => {
    const session = newSession('t4c2');
    appendTurn(session, 1, { userText: 'shared prefix alpha', thought: 'r1' });
    appendTurn(session, 2, { userText: 'shared prefix beta', thought: 'r2' });
    appendTurn(session, 3, { userText: 'tail', thought: 'r3' });
    const surfaceSeqs = [...session.surface.nodes];
    const t1Seqs = surfaceSeqs.slice(0, 2);
    appendSummary(session, { shadowedSeqs: t1Seqs, carriedTxnIds: [1], summaryText: 'checkpoint summary text' });
    session.append('turn/start', { turn: 4 });
    const view = foldView(session);
    expect(view.find((e) => e.transaction_id === 1)?.carrierState).toBe('carried'); // debug 承载状态 = carried
    const harness = mount(session, view);
    const decision = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(decision)).toBe(0); // 候选全为 REL 已承载，跳过
  });

  it('T4c-2b：无 caCarrierDetail 的 compaction/summary → 承载状态 unloaded + 保守候选注入（计数 1，F18 缺省语义）', async () => {
    const session = newSession('t4c2b');
    appendTurn(session, 1, { userText: 'turn 1 用户', thought: 'r1' });
    appendTurn(session, 2, { userText: 'turn 2 用户', thought: 'r2' });
    const t1Seqs = [...session.surface.nodes].slice(0, 2);
    appendSummary(session, { shadowedSeqs: t1Seqs, summaryText: 'checkpoint summary text' }); // 不附带 caCarrierDetail
    session.append('turn/start', { turn: 3 });
    const view = foldView(session);
    expect(view.find((e) => e.transaction_id === 1)?.carrierState).toBe('unloaded'); // 缺省 unloaded
    const harness = mount(session, view);
    const decision = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(decision)).toBe(1); // 保守候选注入正向配对（宁重复勿丢失）
  });

  it('T4c-3：重叠拒绝注入（计数 0 + 日志含 transaction_id 与重叠片段）+ 后续轮 A33 衰减计数仍 0', async () => {
    const session = newSession('t4c3');
    const userText = '这是一段用于重叠判定的用户消息文本，足够长以构造 ≥20 字符重叠片段';
    appendTurn(session, 1, { userText, thought: 'r1' });
    appendTurn(session, 2, { userText: 'turn 2 用户', thought: 'r2' });
    const t1Seqs = [...session.surface.nodes].slice(0, 2);
    // mock 固定检查点摘要文本（含与 turn 1 user 文本 ≥20 字符重叠片段，D61）
    appendSummary(session, { shadowedSeqs: t1Seqs, summaryText: userText });
    session.append('turn/start', { turn: 3 });
    const view = foldView(session);
    const harness = mount(session, view);
    const decision = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(decision)).toBe(0); // 重叠判定拒绝
    // 日志含 transaction_id 与重叠片段（A35）
    const log = harness.warnLog.join(' ');
    expect(log).toContain('注入重叠拒绝');
    expect(log).toContain('transaction_id');
    expect(log).toContain('重叠片段');
    // 后续轮（turn 4 首 step）计数仍 0（A33 衰减——重叠拒绝事务不再作为候选）
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
    session.append('turn/start', { turn: 4 });
    const view2 = foldView(session);
    harness.ctx.sessionProjections.snapshot = () => ({ asOfSeq: -1, values: { 'ca-v7/view': view2 } });
    const decision2 = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(decision2)).toBe(0);
  });
});

describe('R3 非首 step / 不重复注入（T5）', () => {
  it('首 step 注入后非首 step 计数不增长；无新增候选不重复注入', async () => {
    const session = buildT4Session(); // turn 4 已开启
    const view = foldView(session);
    const harness = mount(session, view);
    // turn 4 首 step → 注入 1 次
    const d1 = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(d1)).toBe(1);
    // 注入消息 durable 尾部追加（模拟 agent 循环落地——注入历史重建数据源，B29）
    const injected1 = (d1.messages as { source: { plugin?: string; sections: { name: string; text: string }[] }; content: { text: string }[] }[]).find(
      (m) => m.source?.plugin === 'ca-v7',
    )!;
    const refsSection = injected1.source.sections.find((s) => s.name === 'transaction_refs');
    const refs = JSON.parse(refsSection!.text) as number[];
    appendPluginInjection(session, injected1.content[0].text, refs);
    // turn 4 第 2 step → 计数不增长（非首 step，A19/T5）
    const d2 = await runPreStep(harness, makeAgent(session), 2);
    expect(countCaV7(d2)).toBe(0);
    // turn 5 首 step → 无新增候选事务，不重复注入（计数维持 1，D33/A31）
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } });
    session.append('turn/start', { turn: 5 });
    const view5 = foldView(session);
    harness.ctx.sessionProjections.snapshot = () => ({ asOfSeq: -1, values: { 'ca-v7/view': view5 } });
    const d3 = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(d3)).toBe(0); // 已注入事务不再注入（增量去重 + 记忆语义）
  });

  it('遮蔽变体（D59）：注入消息被后续压缩遮蔽后再进 turn 首 step → 计数不增长（A33 不重注入）', async () => {
    const session = newSession('t5-shadow');
    appendTurn(session, 1, { userText: 'turn 1 用户', thought: 'r1' });
    appendTurn(session, 2, { userText: 'turn 2 用户', thought: 'r2' });
    const t1Seqs = [...session.surface.nodes].slice(0, 2);
    appendSummary(session, { shadowedSeqs: t1Seqs, summaryText: 'checkpoint summary text' });
    session.append('turn/start', { turn: 3 });
    const view = foldView(session);
    const harness = mount(session, view);
    const d1 = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(d1)).toBe(1); // 注入 1 次
    // 注入消息 durable 落地（A33：注入历史按 transaction_id 跟踪，注入消息被遮蔽后不重注入）
    const injectedMsg = (d1.messages as { source: { plugin?: string; sections: { name: string; text: string }[] }; content: { text: string }[] }[]).find(
      (m) => m.source?.plugin === 'ca-v7',
    )!;
    const refsSection = injectedMsg.source.sections.find((s) => s.name === 'transaction_refs');
    const refs = JSON.parse(refsSection!.text) as number[];
    const injectedSeq = appendPluginInjection(session, injectedMsg.content[0].text, refs);
    // 注入消息被后续压缩遮蔽（其 seq 进入遮蔽集合）
    appendSummary(session, { shadowedSeqs: [injectedSeq], summaryText: 'later checkpoint' });
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
    session.append('turn/start', { turn: 4 });
    const view2 = foldView(session);
    harness.ctx.sessionProjections.snapshot = () => ({ asOfSeq: -1, values: { 'ca-v7/view': view2 } });
    const d2 = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(d2)).toBe(0); // 不重注入（A33 衰减）
  });

  it('自动路径变体（A36/D60/B1）：pre-step 内 compactIfNeeded 同步 await 摘要 → 同轮首 step 注入可见本轮遮蔽（计数 +1）', async () => {
    // 8 turn：t1 FAR、t2 REL、t3+ ACT；压力超阈值（totalTokens=110000 > 0.8*128000）
    const session = newSession('t5-auto');
    appendHeader(session);
    appendTurn(session, 1, { userText: 'alpha completely different text one', thought: 'r1' });
    appendTurn(session, 2, { userText: 'shared common prefix beta', thought: 'r2' });
    appendTurn(session, 3, { userText: 'shared common prefix gamma', thought: 'r3' });
    for (let i = 4; i <= 8; i += 1) appendTurn(session, i, { userText: 'ordinary tail text ' + i, thought: 'r' + i });
    session.append('turn/start', { turn: 9 });
    const view = foldView(session); // 压缩前：无遮蔽
    expect(view.every((e) => e.visibility === 'visible')).toBe(true);
    const harness = mount(session, view, { liveView: true, config: { gradeAgeThresholdTurns: 6 } });
    harness.ctx.tokenMeter.measure = (s: { events: unknown[]; surface: { nodes: readonly number[] } }) => ({
      logRevision: s.events.length,
      baseline: { kind: 'none', tokens: 0 },
      surfaceDeltaTokens: 0,
      totalTokens: 110000,
      surfaceTokens: 110000,
      nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 3000 })),
    });
    const decision = await runPreStep(harness, makeAgent(session), 1);
    expect(countCaV7(decision)).toBe(1); // 同轮首 step 注入一次（压缩同步完成后可见本轮遮蔽）
    // llm 摘要调用 = 1（仅压缩摘要；注入路径无 LLM）
    expect(harness.purposes).toEqual(['compaction']);
    // 压力未触发（无新遮蔽）→ 同轮首 step 计数不增长（无新增候选）
    const session2 = newSession('t5-auto2');
    appendTurn(session2, 1, { userText: 'turn 1', thought: 'r1' });
    appendTurn(session2, 2, { userText: 'turn 2', thought: 'r2' });
    session2.append('turn/start', { turn: 3 });
    const view2 = foldView(session2);
    const harness2 = mount(session2, view2, { liveView: true });
    harness2.ctx.tokenMeter.measure = () => ({
      totalTokens: 1000, // 低于阈值 → 不触发
      nodes: [],
    });
    harness2.ctx.llm.resolveModelInfo = async () => ({ provider: 'p', id: 'm', name: 'm', context: { contextWindow: 128000 } });
    const decision2 = await runPreStep(harness2, makeAgent(session2), 1);
    expect(countCaV7(decision2)).toBe(0);
    expect(harness2.purposes.length).toBe(0);
  });
});

describe('R3 注入历史重建（B29 / T-R3r 单测级）', () => {
  it('自 source.plugin=ca-v7 消息的 transaction_refs 命名 section 重建历史', () => {
    const session = newSession('hist');
    appendTurn(session, 1, { userText: 'turn 1', thought: 'r1' });
    appendPluginInjection(session, '注入文本', [1, 2]);
    const history = rebuildInjectHistory(session);
    expect(history.has(1)).toBe(true);
    expect(history.has(2)).toBe(true);
    // 非 ca-v7 插件消息不计数
    const session2 = newSession('hist2');
    appendTurn(session2, 1, { userText: 't', thought: 'r' });
    session2.append(
      'user/message',
      {
        id: 'x',
        role: 'user',
        content: [{ type: 'text', text: '其他插件' }],
        source: { kind: 'plugin', plugin: 'other', form: 'snapshot', sections: [] },
      } as never,
      { surfaceOp: 'append' },
    );
    expect(rebuildInjectHistory(session2).size).toBe(0);
  });

  it('重叠拒绝阈值常量 = 20', () => {
    expect(OVERLAP_MIN_LEN).toBe(20);
  });
});
