/**
 * engine.js 单测（R4 / R5 / R7 / R9 + T6 / T6b / T6c / T7 / T8 / T9 / T9b / T-Err1-3 / T-R4b / T-R8 变体）
 *
 * mock 策略（testplan §3）：真实 DSH Session（表层契约/事件校验）+ mock ctx
 * （llm.stream 脚本化摘要 / tokenMeter measure+estimateMessage 读数 / sessionProjections.snapshot）。
 * 计数断言（任务书 §6 与 design §3.4 定一执行）：llm 摘要调用次数（purposes）、
 * tokenMeter measure（投影复测）次数、落地（replace）次数、compaction 生命周期组数。
 */
import { describe, it, expect } from 'vitest';
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { CACompactionEngine } from '../lib/engine.js';
import { gradeTransactions } from '../lib/grade.js';
import {
  newSession,
  appendHeader,
  appendTurn,
  appendUser,
  appendToolPair,
  makeEngineCtx,
  foldView,
  replaceEvents,
  compactionLifecycles,
  makeAgent,
  Session,
  CompactionId,
} from './helpers.js';

/** 8 turn 会话：t1 FAR、t2 REL、t3-t6 ACT（年龄不足）、t7-t8 tail ACT（ageThresholdTurns=6） */
function buildStandardSession(id = 'eng') {
  const session = newSession(id);
  appendHeader(session);
  appendTurn(session, 1, { userText: 'alpha completely different text one', thought: 'r1' });
  appendTurn(session, 2, { userText: 'shared common prefix beta', thought: 'r2' });
  appendTurn(session, 3, { userText: 'shared common prefix gamma', thought: 'r3' });
  for (let i = 4; i <= 8; i += 1) appendTurn(session, i, { userText: 'ordinary tail text ' + i, thought: 'r' + i });
  return session;
}

/** 7 turn 会话：t1 FAR、t2 REL、t3 FAR、t4 FAR、t5 REL、t6-t7 tail（ageThresholdTurns=1）→ segments [[2],[5]] */
function buildMultiSegmentSession(id = 'eng-multi') {
  const session = newSession(id);
  appendHeader(session);
  appendTurn(session, 1, { userText: 'alpha completely different one', thought: 'r1' });
  appendTurn(session, 2, { userText: 'shared common prefix beta', thought: 'r2' });
  appendTurn(session, 3, { userText: 'shared common prefix gamma', thought: 'r3' });
  appendTurn(session, 4, { userText: 'omega unrelated zeta', thought: 'r4' });
  appendTurn(session, 5, { userText: 'shared common prefix delta', thought: 'r5' });
  appendTurn(session, 6, { userText: 'shared common prefix epsilon', thought: 'r6' });
  appendTurn(session, 7, { userText: 'tail seven', thought: 'r7' });
  return session;
}

/** 全 FAR 会话（P1 场景）：相邻 user 文本无公共词、LCS 归一化相似度 < 0.5 → 候选全为 FAR、无 REL 段。
 *  8 turn + ageThresholdTurns=1 + tailN=2 → 候选 t1-t6 全 FAR，segments=[]（selectSegments 非 null 但空段）。 */
function buildFAROnlySession(id = 'eng-far') {
  const session = newSession(id);
  appendHeader(session);
  const texts = [
    'alpha crimson badger one',
    'bravo indigo falcon two',
    'charlie jade heron three',
    'delta azure otter four',
    'echo amber puma five',
    'foxtrot coral viper six',
    'golf teal wolf seven',
    'hotel mauve lynx eight',
  ];
  texts.forEach((text, i) => appendTurn(session, i + 1, { userText: text, thought: 'r' + (i + 1) }));
  return session;
}

/** 打开下一轮（自动压缩/直调 compactRegion 前置：end 位于开放轮首条事件之前） */
function openNextTurn(session: ReturnType<typeof newSession>, turnNo: number) {
  session.append('turn/start', { turn: turnNo });
}

describe('R4 CACompactionEngine 类形态（T1/T10 单测级）', () => {
  it('继承 CompactionEngine + 三方法签名一致 + Service 注册（ctx.compaction）', () => {
    const session = buildStandardSession();
    const view = foldView(session);
    const harness = makeEngineCtx(session, view);
    const engine = new CACompactionEngine(harness.ctx, {});
    expect(engine).toBeInstanceOf(CompactionEngine);
    expect(typeof engine.compactIfNeeded).toBe('function');
    expect(typeof engine.compactNow).toBe('function');
    expect(typeof engine.compactRegion).toBe('function');
    expect(engine.constructor.name).toBe('CACompactionEngine');
    expect(harness.ctx.compaction).toBe(engine); // Service 构造即注册
    // 默认配置（§4.1 对齐）
    expect(engine.config.tailN).toBe(2);
    expect(engine.config.thresholdRatio).toBe(0.8);
    expect(engine.config.retainRatio).toBe(0.16); // 继承兼容键（B66）
    expect(engine.config.maxTokens).toBe(8192);
    expect(engine.config.auto).toBe(true);
    expect(engine.config.compactionRetries).toBe(1);
    // 水位压力话题切割默认（index.js apply 透传面；2026-08-18 修复回归）
    expect(engine.config.topicSplitStartChars).toBe(5000);
    expect(engine.config.topicSplitPeakChars).toBe(20000);
    expect(engine.config.jaccardPenaltyMax).toBe(0.3);
    expect(engine.config.topicSplitForceAtPeak).toBe(true);
    // 按 session 隔离镜像字段为公开属性（index.js planHandoff 读取面；2026-08-18 修复回归）
    expect(engine.lastContextBySession).toBeInstanceOf(WeakMap);
    expect(engine.lastPressureAttemptBySession).toBeInstanceOf(WeakMap);
    expect(engine.overflowLatchBySession).toBeInstanceOf(WeakMap);
  });

  it('冻结定级按 session 隔离：A 的冻结 grades 不串入 B（多会话回归）', () => {
    const sessionA = buildStandardSession('grade-a');
    const viewA = foldView(sessionA);
    const sessionB = newSession('grade-b');
    appendHeader(sessionB);
    appendTurn(sessionB, 1, { userText: '继续', thought: 'r1' }); // 简短确认轮
    const viewB = foldView(sessionB);
    const harness = makeEngineCtx(sessionA, viewA);
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const gradesA = engine.gradeView(viewA, { session: sessionA });
    expect(gradesA.get(1)).toBe('FAR'); // A 产生冻结快照
    const gradesB = engine.gradeView(viewB, { session: sessionB });
    expect(gradesB.get(1)).toBe('ACT'); // B 首轮走自己的首轮语义，不复用 A 的 FAR
    expect(gradesB.size).toBe(1);
  });
});

describe('R5 三区降级（T6 单次 replace）', () => {
  it('FAR 原文消失 + REL 单摘要节点（仅 REL 内容，FAR 不进摘要 B17）+ ACT/tail 保留 + 完整事件序列 + provider/model 非空', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['compact summary text'] });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const nodes = [...session.surface.nodes];
    const start = nodes[0]; // t1 user
    const end = nodes[3]; // t2 fin
    const result = await engine.compactRegion(start, end, agent, new AbortController().signal);

    expect(result).toBeTruthy();
    expect(result.shadowedSeqs).toEqual([start, nodes[1], nodes[2], end]);
    expect(replaceEvents(session).length).toBe(1); // 单次 replace
    expect(session.surface.replaceGeneration).toBe(1);

    const derived = session.deriveMessages().map((m) => JSON.stringify(m.content));
    expect(derived.some((c) => c.includes('alpha completely different text one'))).toBe(false);
    expect(derived.some((c) => c.includes('shared common prefix beta'))).toBe(false);
    const checkpoint = derived.filter((c) => c.includes('<ca-checkpoint>'));
    expect(checkpoint.length).toBe(1); // REL 单摘要节点
    expect(checkpoint[0]).toContain('compact summary text');
    expect(checkpoint[0]).not.toContain('alpha completely different text one'); // FAR 不进摘要（B17）
    expect(derived.some((c) => c.includes('shared common prefix gamma'))).toBe(true); // t3 ACT 段保留
    for (let i = 4; i <= 8; i += 1) {
      expect(derived.some((c) => c.includes('ordinary tail text ' + i))).toBe(true);
      expect(derived.some((c) => c.includes('r' + i))).toBe(true);
    }

    const life = compactionLifecycles(session);
    expect(life.groups.length).toBe(1);
    expect(life.groups[0].summary).not.toBeNull();
    expect(life.groups[0].end).not.toBeNull();
    expect(life.starts.length).toBe(life.ends.length);

    const summaryEvent = life.groups[0].summary!;
    const data = summaryEvent.data as { summary: unknown[]; provider: string; model: string; caCarrierDetail?: { carriedTxnIds: number[] } };
    expect(Array.isArray(data.summary) && data.summary.length > 0).toBe(true);
    expect(typeof data.provider).toBe('string');
    expect(data.provider.length).toBeGreaterThan(0);
    expect(typeof data.model).toBe('string');
    expect(data.model.length).toBeGreaterThan(0);
    expect((data as { shadowedSeqs?: unknown }).shadowedSeqs).toEqual([start, nodes[1], nodes[2], end]);
    expect(data.caCarrierDetail?.carriedTxnIds).toEqual([1, 2]); // 直调区间内事务
  });
});

describe('R5 未闭合工具对拒绝（T6b）', () => {
  it('抛契约异常（原生 Error，非 ManualCompactionError，无 code）+ 无表层变更 + 日志含拒绝记录', async () => {
    const session = newSession('t6b');
    appendHeader(session);
    session.append('turn/start', { turn: 1 });
    appendUser(session, 'user turn 1');
    appendToolPair(session, 1, 1, { callId: 'open-call', resultText: null }); // 无 result → 未闭合
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    openNextTurn(session, 2);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['summary', 'summary'] }); // 两次直调各一次摘要
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    const nodes = [...session.surface.nodes];
    const before = session.events.length;
    await expect(
      engine.compactRegion(nodes[0], nodes[nodes.length - 1], agent, new AbortController().signal),
    ).rejects.toThrow(Error);
    try {
      await engine.compactRegion(nodes[0], nodes[nodes.length - 1], agent, new AbortController().signal);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).not.toBeInstanceOf(ManualCompactionError);
      expect((err as { code?: string }).code).toBeUndefined();
      expect((err as Error).message).toContain('平衡');
    }
    expect(session.events.length).toBe(before); // 无表层变更（无新事件）
    expect(replaceEvents(session).length).toBe(0);
    expect(harness.warnLog.join(' ')).toContain('compactRegion 拒绝'); // 日志含拒绝记录（F52）
  });
});

describe('R5 交错 grade 多次 replace（T6c 直调场景）', () => {
  it('交错 2 次 replace + ACT 段原文逐字保留 + 2 组 start→summary→end 完整序列（F54 独立观测）', async () => {
    const session = newSession('t6c');
    appendHeader(session);
    appendTurn(session, 1, { userText: 'ACT segment one preserved', thought: 'a1' });
    appendTurn(session, 2, { userText: 'FAR segment two', thought: 'a2' });
    appendTurn(session, 3, { userText: 'REL segment three', thought: 'a3' });
    appendTurn(session, 4, { userText: 'ACT segment four preserved', thought: 'a4' });
    appendTurn(session, 5, { userText: 'REL segment five', thought: 'a5' });
    openNextTurn(session, 6);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['summary-1', 'summary-2'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    const nodes = [...session.surface.nodes];
    await engine.compactRegion(nodes[2], nodes[5], agent, new AbortController().signal);
    await engine.compactRegion(nodes[8], nodes[9], agent, new AbortController().signal);

    const replaces = replaceEvents(session);
    expect(replaces.length).toBe(2); // 2 次 replace
    const life = compactionLifecycles(session);
    expect(life.groups.length).toBe(2); // 2 组生命周期
    expect(life.groups.every((g) => g.summary !== null && g.end !== null)).toBe(true);
    expect(life.starts.length).toBe(life.ends.length);
    const derived = session.deriveMessages().map((m) => JSON.stringify(m.content));
    expect(derived.filter((c) => c.includes('<ca-checkpoint>')).length).toBe(2); // 2 个摘要节点
    expect(derived.some((c) => c.includes('summary-1'))).toBe(true);
    expect(derived.some((c) => c.includes('summary-2'))).toBe(true);
    expect(derived.some((c) => c.includes('ACT segment one preserved'))).toBe(true); // ACT 段 1 逐字保留
    expect(derived.some((c) => c.includes('ACT segment four preserved'))).toBe(true); // ACT 段 4 逐字保留
    expect(derived.some((c) => c.includes('FAR segment two'))).toBe(false);
    expect(derived.some((c) => c.includes('REL segment three'))).toBe(false);
    expect(derived.some((c) => c.includes('REL segment five'))).toBe(false);
  });
});

describe('R5 压力路径多段（D63/D60/D62）', () => {
  it('段集合整体一次落地（compactRegion 调用总数 = 1）+ llm 计数 = N×尝试次数 + 投影复测 = 尝试次数', async () => {
    const session = buildMultiSegmentSession();
    openNextTurn(session, 8);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['segment-A summary', 'segment-B summary'],
    });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 1 });
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).not.toBeNull();
    expect(replaceEvents(session).length).toBe(1); // 段集合整体一次落地（D60）
    expect(session.surface.replaceGeneration).toBe(1);
    expect(harness.purposes).toEqual(['compaction', 'compaction']); // N(2) × 尝试(1) = 2（D63）
    // 投影复测 = 尝试次数 = 1（measure：entry + project + landing = 3）
    expect(harness.measureCalls.length).toBe(3);
    // 检查点含两段摘要
    const checkpoint = session.deriveMessages().find((m) => JSON.stringify(m.content).includes('<ca-checkpoint>'))!;
    const textBlocks = (checkpoint.content as { type?: string; text?: string }[]).filter(
      (b) => b.type === 'text' && b.text && !b.text.includes('<ca-checkpoint>') && !b.text.includes('</ca-checkpoint>') && !b.text.includes('这是一条自动生成的'),
    );
    expect(textBlocks.length).toBe(2);
    expect(textBlocks.some((b) => b.text === 'segment-A summary')).toBe(true);
    expect(textBlocks.some((b) => b.text === 'segment-B summary')).toBe(true);
    // 候选 t1-t5 表层节点 = 5 turn × (user+assistant) = 10 个（合并区间整体遮蔽）
    expect(result!.shadowedSeqs.length).toBe(10);
  });

  it('部分段退化（B70/B72）：集合中一段空串 → 整次尝试按退化终止 + llm 计数 = 退化段序号 + 投影复测 = 0', async () => {
    const session = buildMultiSegmentSession();
    openNextTurn(session, 8);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['segment-A ok', ''], // N=2 段，退化段 = 第 2 段（k=2）
    });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 1 });
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).toBeNull();
    expect(harness.purposes.length).toBe(2); // llm 计数 = 退化段序号 k=2（早退语义 B72/D67）
    expect(harness.measureCalls.length).toBe(1); // 投影复测 = 0（退化拦截先于复测——仅入口压力检查）
    expect(replaceEvents(session).length).toBe(0);
  });

  it('重试中退化守卫（B73/B75/D70）：首尝试投影超阈值 → 重试 → 重试中一段退化 → 整次终止（0 落地、无重试继续）', async () => {
    const session = buildMultiSegmentSession();
    openNextTurn(session, 8);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['X'.repeat(50000), 'Y'.repeat(50000), 'Z-retry ok', ''], // 重试退化段 = 末段 k=N=2 → 2N=4
    });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 1 });
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).toBeNull();
    expect(harness.purposes.length).toBe(4); // 2N = 4（B75 通式：k=N → 2N 可复现）
    expect(harness.measureCalls.length).toBe(2); // entry + 首尝试投影复测 1 次（D70）
    expect(replaceEvents(session).length).toBe(0);
    expect(session.surface.replaceGeneration).toBe(0);
  });
});

describe('R5/R8 压力触发 + 收敛重试（T8）', () => {
  it('路径 A（重试成功）：首段不缩容 → 重试段缩容 → 落地；llm 计数 = 2；唯一一次落地；replaceGeneration 仅前进一次', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['X'.repeat(20000), 'compact summary text'],
    });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const generationBefore = session.surface.replaceGeneration;
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.shadowedSeqs.length).toBe(4); // t1+t2 表层节点
    expect(harness.purposes).toEqual(['compaction', 'compaction']); // 第二次摘要生成发生
    const derived = session.deriveMessages().map((m) => JSON.stringify(m.content));
    expect(derived.some((c) => c.includes('compact summary text'))).toBe(true); // 最终基于重试产物（B65）
    expect(derived.some((c) => c.includes('X'.repeat(20)))).toBe(false); // 不缩容摘要被拒绝
    expect(replaceEvents(session).length).toBe(1); // 唯一一次落地
    expect(session.surface.replaceGeneration).toBe(generationBefore + 1); // replaceGeneration 仅前进一次
    expect(harness.measureCalls.length).toBe(4); // entry + 2×project + landing
  });

  it('路径 B（重试耗尽）：全程不缩容 → 返回 null、0 次落地、replaceGeneration 不前进 + warn 日志（B55）', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['X'.repeat(20000), 'Y'.repeat(20000)],
    });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const generationBefore = session.surface.replaceGeneration;
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).toBeNull(); // A50 终态
    expect(harness.purposes.length).toBe(2); // compactionRetries=1 → 1 次重试
    expect(replaceEvents(session).length).toBe(0);
    expect(session.surface.replaceGeneration).toBe(generationBefore);
    expect(harness.warnLog.join(' ')).toMatch(/阈值|放弃/);
  });

  it('T-R8 A51：compactionRetries=2 → 两次重试（llm 计数 = 3）+ 唯一一次落地', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['X'.repeat(20000), 'Y'.repeat(20000), 'compact summary text'],
    });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6, compactionRetries: 2 });
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).not.toBeNull();
    expect(harness.purposes.length).toBe(3); // 首次摘要 + 2 次重试（D52 观测公式）
    expect(replaceEvents(session).length).toBe(1); // 重试不落地
  });

  it('投影复测公式（B56/D62）：projected = measure.totalTokens − Σ(遮蔽 seq tokens) + Σ estimateMessage(包装 user Message)', async () => {
    const session = newSession('proj');
    appendHeader(session);
    appendTurn(session, 1, { userText: 'u1', thought: 'r1' });
    appendTurn(session, 2, { userText: 'u2', thought: 'r2' });
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 1000, nodeTokens: 100 });
    harness.ctx.tokenMeter.measure = () => ({
      totalTokens: 1000,
      nodes: [
        { seq: 1, tokens: 100 },
        { seq: 2, tokens: 200 },
      ],
    });
    harness.ctx.tokenMeter.estimateMessage = (m: { content?: { text?: string }[] }) =>
      (m?.content ?? []).reduce((s, b) => s + (b?.text?.length ?? 0), 0);
    const engine = new CACompactionEngine(harness.ctx, {});
    const summaryMsg = engine.wrapSummary([{ type: 'text', text: 'abc' }]);
    expect(engine.project(session, [1], [summaryMsg])).toBe(903); // 1000 − 100 + 3
    const s2 = engine.wrapSummary([{ type: 'text', text: 'de' }]);
    expect(engine.project(session, [1, 2], [summaryMsg, s2])).toBe(1000 - 300 + 5); // 多段求和（D62）
  });
});

describe('R9 溢出触发（T8 溢出变体 + T-R4b A61）', () => {
  function overflowHarness(config: Record<string, unknown>, summaries: (string | null)[]) {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000, nodeTokens: 3000, summaries });
    const engine = new CACompactionEngine(harness.ctx, config);
    return { session, harness, engine };
  }

  async function fireOverflow(harness: ReturnType<typeof makeEngineCtx>, agent: ReturnType<typeof makeAgent>, next?: () => Promise<unknown>) {
    const listener = harness.listeners['agent/request-error'] as (
      payload: { agent: unknown; failure: { code: string }; signal: AbortSignal },
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    return listener(
      { agent, failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal: new AbortController().signal },
      next ?? (async () => undefined),
    );
  }

  it('溢出触发：compactIfNeeded 以 trigger=context-overflow 被调用 + 整体单次摘要（llm 计数 = 1）+ 落地复用本次溢出摘要（B74/B76/B78）', async () => {
    const { session, harness } = overflowHarness({ gradeAgeThresholdTurns: 6 }, ['overflow summary text']);
    const agent = makeAgent(session);
    const result = await fireOverflow(harness, agent);
    expect(result).toEqual({ kind: 'retry' });
    expect(harness.purposes).toEqual(['compaction']); // llm 计数 = 1（B78 整体单次摘要）
    expect(replaceEvents(session).length).toBe(1);
    expect(session.surface.replaceGeneration).toBe(1);
    const derived = session.deriveMessages().map((m) => JSON.stringify(m.content));
    expect(derived.some((c) => c.includes('overflow summary text'))).toBe(true);
  });

  it('溢出×退化（B59）：溢出触发 + 摘要空串 → 不落地 + warn 日志（退化拦截全局适用）', async () => {
    const { session, harness } = overflowHarness({ gradeAgeThresholdTurns: 6 }, ['']);
    const agent = makeAgent(session);
    const result = await fireOverflow(harness, agent);
    expect(result).toBeUndefined(); // 退化 → next() 委托（保留原始请求错误）
    expect(replaceEvents(session).length).toBe(0);
    expect(session.surface.replaceGeneration).toBe(0);
    expect(harness.warnLog.join(' ')).toContain('退化');
  });

  it('溢出×auto=false（A61/T-R4b）：auto 门控仅压力路径，溢出恢复不受限', async () => {
    const { session, harness, engine } = overflowHarness({ gradeAgeThresholdTurns: 6, auto: false }, ['overflow summary text']);
    const agent = makeAgent(session);
    const before = harness.measureCalls.length;
    const pressureResult = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(pressureResult).toBeNull();
    expect(harness.measureCalls.length).toBe(before); // 无自动压力压缩事件
    const result = await fireOverflow(harness, agent);
    expect(result).toEqual({ kind: 'retry' });
    expect(replaceEvents(session).length).toBe(1);
  });
});

describe('R7 摘要失败/退化保守降级（T9/T9b）', () => {
  function runSummaryCase(summaries: (string | null | { text: string; finishKind?: 'max-tokens' | 'error' })[], config: Record<string, unknown> = {}) {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000, nodeTokens: 3000, summaries: summaries as never });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6, ...config });
    return { session, harness, engine };
  }

  it('T9 reject：mock reject → 区间未被替换 + 无未匹配 start + 日志含降级 + 不进入投影复测 + 不消耗预算（llm 计数 = 1）', async () => {
    const { session, harness, engine } = runSummaryCase([null]);
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).toBeNull();
    expect(replaceEvents(session).length).toBe(0);
    const life = compactionLifecycles(session);
    expect(life.groups.length).toBe(0); // 无未匹配 start
    expect(harness.purposes.length).toBe(1); // reject 同退化归属（B64）
    expect(harness.measureCalls.length).toBe(1); // 仅入口压力检查，不进入投影复测（D54）
    expect(harness.warnLog.join(' ')).toMatch(/退化|失败/);
    void agent;
  });

  it('T9b 空串：退化摘要不固化 + 不进入投影复测 + 不触发重试（llm 计数 = 1）', async () => {
    const { session, harness, engine } = runSummaryCase(['']);
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).toBeNull();
    expect(replaceEvents(session).length).toBe(0);
    expect(harness.purposes.length).toBe(1); // 退化不消耗预算、不触发重试（B54）
    expect(harness.measureCalls.length).toBe(1);
    expect(harness.warnLog.join(' ')).toContain('退化');
    void agent;
  });

  it('T9b max-tokens 截断（finish.kind=max-tokens）：退化判定成立（D4 构造）', async () => {
    const { session, harness, engine } = runSummaryCase([{ text: 'partial output text', finishKind: 'max-tokens' }]);
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).toBeNull();
    expect(replaceEvents(session).length).toBe(0);
    expect(harness.purposes.length).toBe(1);
    expect(harness.warnLog.join(' ')).toContain('max-tokens');
    void agent;
  });

  it('T9b 重试尝试退化（B60）：首次摘要不缩容进入重试、重试段退化 → 终止尝试序列（llm 计数 = 2、无第三次、0 次 compactRegion）', async () => {
    const { session, harness, engine } = runSummaryCase(['X'.repeat(20000), '']);
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).toBeNull();
    expect(harness.purposes.length).toBe(2); // 无第三次摘要
    expect(replaceEvents(session).length).toBe(0);
    expect(session.surface.replaceGeneration).toBe(0);
    expect(harness.measureCalls.length).toBe(2); // entry + 首尝试投影复测 1 次（D57）
    void agent;
  });
});

describe('T-Err1-3 seam 异常', () => {
  it('T-Err1 busy 双入口：compactIfNeeded 未匹配 start → ManualCompactionError code=busy；compactNow 同', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    session.append('compaction/start', { compactionId: CompactionId('stray'), turn: 9 } as never); // 未匹配 start
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000, nodeTokens: 3000, summaries: ['summary', 'summary'] }); // 两次 compactNow 各一次摘要
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    await expect(engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).rejects.toBeInstanceOf(ManualCompactionError);
    await expect(engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).rejects.toMatchObject({ code: 'busy' });
    const idleAgent = { ...agent, runMaintenance: async (task: (s: AbortSignal) => Promise<unknown>) => task(new AbortController().signal) };
    await expect(engine.compactNow(idleAgent, new AbortController().signal)).rejects.toBeInstanceOf(ManualCompactionError);
    await expect(engine.compactNow(idleAgent, new AbortController().signal)).rejects.toMatchObject({ code: 'busy' });
    expect(replaceEvents(session).length).toBe(0); // 无重复表层变更
  });

  it('手动压缩摘要退化 → ManualCompactionError code=summary 不被外层归一为 busy（分类回归）', async () => {
    const session = buildStandardSession();
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: [{ text: '' }] }); // 空文本 → DegenerateSummaryError
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const idleAgent = { ...agent, runMaintenance: async (task: (s: AbortSignal) => Promise<unknown>) => task(new AbortController().signal) };
    await expect(engine.compactNow(idleAgent, new AbortController().signal)).rejects.toMatchObject({ code: 'summary' });
    expect(replaceEvents(session).length).toBe(0);
    expect(compactionLifecycles(session).starts.length).toBe(0);
  });

  it('compactNow 入口信号已 abort → ManualCompactionError code=cancelled（封闭集，非原生 AbortError）', () => {
    const session = buildStandardSession();
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['summary'] });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const idleAgent = { ...agent, runMaintenance: async (task: (s: AbortSignal) => Promise<unknown>) => task(new AbortController().signal) };
    const ac = new AbortController();
    ac.abort();
    expect(() => engine.compactNow(idleAgent, ac.signal)).toThrow(ManualCompactionError);
    try {
      engine.compactNow(idleAgent, ac.signal);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('cancelled');
    }
  });

  it('compactNow 运行中 maintenance 信号 abort → code=cancelled（不落 busy）', async () => {
    const session = buildStandardSession();
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['summary'] });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const abortedAgent = {
      ...agent,
      runMaintenance: async (task: (s: AbortSignal) => Promise<unknown>) => task(AbortSignal.abort()),
    };
    await expect(engine.compactNow(abortedAgent, new AbortController().signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(replaceEvents(session).length).toBe(0);
  });

  it('压力压缩中调用方 signal abort → 错误原样冒泡（不被退化归类吞成 null）', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000, nodeTokens: 3000, summaries: [null] });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const ac = new AbortController();
    ac.abort();
    await expect(engine.compactIfNeeded(agent, 'pressure', ac.signal)).rejects.toThrow('mock llm reject');
    expect(replaceEvents(session).length).toBe(0);
  });

  it('T-Err1 compactRegion + 已有活动压缩 → 契约异常（原生 Error，非 ManualCompactionError）', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    session.append('compaction/start', { compactionId: CompactionId('stray2'), turn: 9 } as never);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['summary'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    const nodes = [...session.surface.nodes];
    try {
      await engine.compactRegion(nodes[0], nodes[3], agent, new AbortController().signal);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).not.toBeInstanceOf(ManualCompactionError);
      expect((err as { code?: string }).code).toBeUndefined();
      expect((err as Error).message).toMatch(/锁已活动|活动/);
    }
    expect(replaceEvents(session).length).toBe(0);
  });

  it('T-Err2 崩溃遗留锁（end-seed 之前的 stray start）→ 非 busy 不阻塞 + 压缩正常完成（F53）', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    session.append('compaction/start', { compactionId: CompactionId('legacy'), turn: 9 } as never);
    session.append('session/end-seed', {}); // end-seed 位于 stray start 之后 → 遗留锁（非 busy）
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000, nodeTokens: 3000, summaries: ['legacy recovery summary'] });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).not.toBeNull(); // 产生 CompactionResult
    expect(replaceEvents(session).length).toBe(1); // 表层推进
    expect(session.surface.replaceGeneration).toBe(1);
    const life = compactionLifecycles(session);
    expect(life.groups.length).toBe(2); // 遗留 start + 本次 start
    const latest = life.groups[life.groups.length - 1];
    expect(latest.summary).not.toBeNull();
    expect(latest.end).not.toBeNull();
  });

  it('T-Err3 无开放轮次 compactRegion → 抛契约异常（非 ManualCompactionError，无 code）+ 无表层变更', async () => {
    const session = buildStandardSession(); // 全部 turn 已闭合（无开放轮次）
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['summary'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    const nodes = [...session.surface.nodes];
    const before = session.events.length;
    try {
      await engine.compactRegion(nodes[0], nodes[3], agent, new AbortController().signal);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).not.toBeInstanceOf(ManualCompactionError);
      expect((err as { code?: string }).code).toBeUndefined();
      expect((err as Error).message).toContain('开放轮次');
    }
    expect(session.events.length).toBe(before);
  });

  it('runMaintenance 活跃 + 手动 compactNow → 同步抛 ManualCompactionError（契约背书）', () => {
    const session = buildStandardSession();
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['summary'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = {
      session,
      options: { provider: 'p', model: 'm' },
      runMaintenance: () => {
        throw new ManualCompactionError('busy', 'agent is active');
      },
    };
    expect(() => engine.compactNow(agent as never, new AbortController().signal)).toThrow(ManualCompactionError);
  });
});

describe('T-R4b backend auto 开关', () => {
  it('auto=false：无自动压力压缩（measure 零调用）+ 手动 compactNow 仍返回 CompactionResult（正向配对）', async () => {
    const session = buildStandardSession();
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000, nodeTokens: 3000, summaries: ['manual summary'] });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6, auto: false });
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).toBeNull();
    expect(harness.measureCalls.length).toBe(0);
    expect(harness.purposes.length).toBe(0);
    const idleAgent = { ...agent, runMaintenance: async (task: (s: AbortSignal) => Promise<unknown>) => task(new AbortController().signal) };
    let flushCalled = 0;
    harness.ctx.sessions.flush = async () => { flushCalled += 1; };
    const manual = await engine.compactNow(idleAgent, new AbortController().signal);
    expect(manual).not.toBeNull();
    expect(manual!.shadowedSeqs.length).toBeGreaterThan(0);
    expect(replaceEvents(session).length).toBe(1);
    expect(flushCalled).toBe(1); // 手动路径持久化检查点
    expect(session.surface.replaceGeneration).toBe(1);
  });
});

describe('R5 compactIfNeeded 守卫', () => {
  it('无路由目标（无 request/header）→ null（不触发）', async () => {
    const session = newSession('no-target');
    appendTurn(session, 1, { userText: 'u1', thought: 'r1' });
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000 });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    expect(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull();
    expect(harness.purposes.length).toBe(0);
  });

  it('无 context 容量 → 跳过 + warn', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000, noContext: true });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    expect(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull();
    expect(harness.warnLog.join(' ')).toContain('context 容量');
  });

  it('无候选（全部 ACT）→ null（T4c-1 引擎侧对应）', async () => {
    const session = newSession('no-cand');
    appendHeader(session);
    appendTurn(session, 1, { userText: 'u1', thought: 'r1' });
    appendTurn(session, 2, { userText: 'u2', thought: 'r2' });
    openNextTurn(session, 3);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000 });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    expect(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull();
    expect(replaceEvents(session).length).toBe(0);
  });
});

describe('R6 tail 保留（T7 引擎侧）', () => {
  it('tail 各 user 消息文本 + assistant 响应原文逐字出现在派生消息（压缩后）', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 110000, nodeTokens: 3000, summaries: ['compact summary text'] });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(result).not.toBeNull();
    const derived = session.deriveMessages().map((m) => JSON.stringify(m.content));
    for (const t of [7, 8]) {
      expect(derived.some((c) => c.includes('ordinary tail text ' + t))).toBe(true);
      expect(derived.some((c) => c.includes('r' + t))).toBe(true); // assistant 响应原文
    }
    expect(derived.some((c) => c.includes('shared common prefix gamma'))).toBe(true); // 非 tail ACT 段保留
  });
});

describe('R5 检查点可再压缩（A10/C15/T10b 单测级）', () => {
  it('旧检查点作为新摘要输入一部分（不丢弃）；派生历史 isCompactCheckpointSource 消息数 = 1（D34 公式化）', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view0 = foldView(session);
    const harness0 = makeEngineCtx(session, view0, { totalTokens: 110000, nodeTokens: 3000, summaries: ['first checkpoint summary'] });
    const engine0 = new CACompactionEngine(harness0.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const r1 = await engine0.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(r1).not.toBeNull();
    // 新历史沿用相似文本（t4-t9 相似 → t8 判 REL，检查点节点随 txn 8 进入候选/摘要输入）
    for (let i = 9; i <= 14; i += 1) appendTurn(session, i, { userText: 'ordinary tail text ' + i, thought: 'r' + i });
    openNextTurn(session, 15);
    const view1 = foldView(session);
    // 二次压缩：t1/t2 已被旧检查点完全遮蔽（无表层节点），不再进入候选（不发起空输入摘要调用）；
    // 唯一候选 REL 段 = txn 8（承载旧检查点节点）→ 一次摘要调用
    const harness1 = makeEngineCtx(session, view1, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['merged checkpoint with old facts'],
    });
    const engine1 = new CACompactionEngine(harness1.ctx, { gradeAgeThresholdTurns: 6 });
    const r2 = await engine1.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    expect(r2).not.toBeNull();
    // 旧检查点文本作为新摘要输入一部分（不丢弃，B27/A10）——stream 输入含首次检查点摘要文本
    const allInputs = harness1.streamInputs.flat().join('|');
    expect(allInputs).toContain('first checkpoint summary');
    expect(harness1.purposes.length).toBe(1); // 无空输入段 → 不再为纯指令输入发起 LLM 调用
    const { isCompactCheckpointSource } = await import('@deepseek-ai/dsh-compaction');
    const checkpointMsgs = session.deriveMessages().filter((m) => {
      const src = (m as { source?: unknown }).source as { kind?: string; plugin?: string } | undefined;
      return src ? isCompactCheckpointSource(src as never) : false;
    });
    expect(checkpointMsgs.length).toBe(1); // 旧检查点已被新摘要合并（D34 公式化）
    const last = JSON.stringify(checkpointMsgs[checkpointMsgs.length - 1].content);
    expect(last).toContain('merged checkpoint with old facts'); // 新摘要节点承载
  });
});

describe('P1 修复：FAR-only 会话压缩返回 null（R5）', () => {
  /** 前置校验：定级确为「有 FAR 候选、无 REL 段」（防止夹具漂移导致用例空转） */
  function assertFAROnlyPremise(view: ReturnType<typeof foldView>) {
    const grades = gradeTransactions(view, { tailN: 2, ageThresholdTurns: 1, similarityThreshold: 0.5 });
    const values = [...grades.values()];
    expect(values.filter((g) => g === 'REL')).toHaveLength(0); // 无 REL 段
    expect(values.filter((g) => g === 'FAR').length).toBeGreaterThan(0); // 存在 FAR 候选
  }

  it('FAR-only 会话 compactNow（/compact）→ 返回 null（不抛错）+ 0 compaction 事件 + 0 落地 + 表层不变', async () => {
    const session = buildFAROnlySession();
    const view = foldView(session);
    assertFAROnlyPremise(view);
    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['should never be consumed'],
    });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 1 });
    const agent = {
      ...makeAgent(session),
      runMaintenance: async (task: (s: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    };
    const nodesBefore = [...session.surface.nodes];
    const eventsBefore = session.events.length;

    const result = await engine.compactNow(agent, new AbortController().signal);

    expect(result).toBeNull(); // 无可摘要内容 → null（不抛错，P1 修复）
    expect(harness.purposes.length).toBe(0); // 未触发任何摘要生成
    expect(harness.measureCalls.length).toBe(0); // 手动路径无 tokenMeter 读数
    expect(session.events.filter((e) => e.type.startsWith('compaction/')).length).toBe(0); // 0 compaction 事件
    expect(replaceEvents(session).length).toBe(0); // 0 落地（0 compactRegion 调用）
    expect(session.surface.replaceGeneration).toBe(0);
    expect([...session.surface.nodes]).toEqual(nodesBefore); // 表层不变
    expect(session.events.length).toBe(eventsBefore); // 无新事件
  });

  it('FAR-only 会话 compactIfNeeded(pressure) → 返回 null + 0 compaction 事件 + 0 落地 + 表层不变', async () => {
    const session = buildFAROnlySession();
    const view = foldView(session);
    assertFAROnlyPremise(view);
    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['should never be consumed'],
    });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 1 });
    const agent = makeAgent(session);
    const nodesBefore = [...session.surface.nodes];
    const eventsBefore = session.events.length;

    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);

    expect(result).toBeNull(); // 无可摘要内容 → null（P1 修复）
    expect(harness.purposes.length).toBe(0); // 未触发任何摘要生成
    expect(harness.measureCalls.length).toBe(1); // 仅入口压力检查，无投影复测
    expect(session.events.filter((e) => e.type.startsWith('compaction/')).length).toBe(0); // 0 compaction 事件
    expect(replaceEvents(session).length).toBe(0); // 0 落地（0 compactRegion 调用）
    expect(session.surface.replaceGeneration).toBe(0);
    expect([...session.surface.nodes]).toEqual(nodesBefore); // 表层不变
    expect(session.events.length).toBe(eventsBefore); // 无新事件
  });
});

describe('P2-1 修复：冻结定级首拍过早陷阱——压缩路径 fresh 定级（单话题会话可压缩）', () => {
  it('turn 1 首拍冻结全 ACT 后 compactNow 仍按当前视图成熟度定级并落地（fresh 不读冻结快照）', async () => {
    const session = newSession('eng-p21');
    appendHeader(session);
    // 单话题 8 turn：相邻 user 文本高度相似（LCS ≥ 0.5 → REL）；ageThresholdTurns=6 → t1/t2 为成熟候选
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `shared common prefix omega ${i}`, thought: 'r' + i });
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['p21 compact summary'] });
    const engine = new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const idleAgent = { ...agent, runMaintenance: async (task: (s: AbortSignal) => Promise<unknown>) => task(new AbortController().signal) };

    // 生产陷阱前提：tool 回写路径在 turn 1 即首拍（视图仅 txn1 → tail 保护 → 全 ACT 冻结）
    const viewT1 = view.filter((e) => e.transaction_id === 1);
    const early = engine.gradeView(viewT1, { session });
    expect(early.get(1)).toBe('ACT'); // 首拍冻结 = 全 ACT（陷阱存在性前置断言）
    // 冻结快照下若走 gradeView：全部 ACT、无 REL 候选（对照断言，防止夹具漂移）
    const frozen = engine.gradeView(view, { session });
    expect([...frozen.values()].filter((g) => g === 'REL')).toHaveLength(0);

    const result = await engine.compactNow(idleAgent, new AbortController().signal);

    expect(result).toBeTruthy(); // fresh 定级找到 REL 段（t1/t2）→ 压缩发生
    expect(result.shadowedSeqs.length).toBeGreaterThan(0);
    expect(replaceEvents(session).length).toBe(1); // 单次 replace
    const derived = session.deriveMessages().map((m) => JSON.stringify(m.content));
    expect(derived.some((c) => c.includes('shared common prefix omega 1'))).toBe(false); // t1 REL 被遮蔽
    expect(derived.some((c) => c.includes('<ca-checkpoint>'))).toBe(true); // 摘要节点落地
  });
});

describe('B2 修复：溢出路径 FAR-only 守卫（P1 语义覆盖 overflow）', () => {
  it('FAR-only + context-overflow → 0 摘要调用、0 落地、委托 next 保留原始请求错误', async () => {
    const session = buildFAROnlySession();
    openNextTurn(session, 9);
    const view = foldView(session);
    const grades = gradeTransactions(view, { tailN: 2, ageThresholdTurns: 1, similarityThreshold: 0.5 });
    expect([...grades.values()].filter((g) => g === 'REL')).toHaveLength(0);
    expect([...grades.values()].filter((g) => g === 'FAR').length).toBeGreaterThan(0);

    const harness = makeEngineCtx(session, view, {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['should never be consumed'],
    });
    new CACompactionEngine(harness.ctx, { gradeAgeThresholdTurns: 1 });
    const listener = harness.listeners['agent/request-error'] as (
      payload: { agent: unknown; failure: { code: string }; signal: AbortSignal },
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const result = await listener(
      { agent: makeAgent(session), failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal: new AbortController().signal },
      async () => 'next-result',
    );

    expect(result).toBe('next-result'); // 委托 next：原始请求错误语义保留
    expect(harness.purposes).toHaveLength(0); // 空输入不得生成空检查点
    expect(replaceEvents(session)).toHaveLength(0); // 0 落地
    expect(session.events.filter((e) => e.type.startsWith('compaction/')).length).toBe(0);
  });
});

describe('B3 修复：compactRegion 契约校验先于 LLM 摘要（零 token 拒绝）', () => {
  function unbalancedSession() {
    const session = newSession('b3-unbalanced');
    appendHeader(session);
    session.append('turn/start', { turn: 1 });
    appendUser(session, 'user turn 1');
    appendToolPair(session, 1, 1, { callId: 'open-call', resultText: null }); // 未闭合工具对
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    openNextTurn(session, 2);
    return session;
  }

  it('未闭合工具对 → 抛契约异常且 llm 摘要调用次数 = 0', async () => {
    const session = unbalancedSession();
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['should not consume'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    const nodes = [...session.surface.nodes];
    await expect(
      engine.compactRegion(nodes[0], nodes[nodes.length - 1], agent, new AbortController().signal),
    ).rejects.toThrow(/平衡/);
    expect(harness.purposes).toHaveLength(0); // 校验在摘要之前（B3）
    expect(replaceEvents(session)).toHaveLength(0);
  });

  it('无开放轮次 → 抛契约异常且 llm 摘要调用次数 = 0', async () => {
    const session = buildStandardSession(); // 全部 turn 已闭合
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { summaries: ['should not consume'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    const nodes = [...session.surface.nodes];
    await expect(
      engine.compactRegion(nodes[0], nodes[3], agent, new AbortController().signal),
    ).rejects.toThrow(/开放轮次/);
    expect(harness.purposes).toHaveLength(0);
    expect(replaceEvents(session)).toHaveLength(0);
  });
});

describe('B4 修复：txnsInRange 以表层位置为准（replace 后高 seq 检查点位于前部）', () => {
  it('数值反向但位置有序的区间仍能正确识别 carriedTxnIds', async () => {
    const session = buildStandardSession();
    openNextTurn(session, 9);
    const view0 = foldView(session);
    const harness0 = makeEngineCtx(session, view0, { summaries: ['first checkpoint'] });
    const engine0 = new CACompactionEngine(harness0.ctx, { gradeAgeThresholdTurns: 6 });
    const agent = makeAgent(session);
    const nodes0 = [...session.surface.nodes];
    await engine0.compactRegion(nodes0[0], nodes0[3], agent, new AbortController().signal);

    // replace 后：高 seq 检查点位于表层前部，start/end 数值反向但位置有序
    const view1 = foldView(session);
    const surface = [...session.surface.nodes];
    expect(surface.length).toBeGreaterThan(2);
    expect(surface[0]).toBeGreaterThan(surface[1]); // 前置条件：数值 seq 非单调
    const harness1 = makeEngineCtx(session, view1, { summaries: ['second checkpoint'] });
    const engine1 = new CACompactionEngine(harness1.ctx, { gradeAgeThresholdTurns: 6 });
    await engine1.compactRegion(surface[0], surface[1], agent, new AbortController().signal);

    const summaries = session.events.filter((e) => e.type === 'compaction/summary') as Array<{
      data?: { caCarrierDetail?: { carriedTxnIds: number[] } };
    }>;
    const latest = summaries[summaries.length - 1]?.data?.caCarrierDetail?.carriedTxnIds ?? [];
    expect(latest).toContain(3); // t3 用户行位于区间内
    expect(latest).toContain(8); // 高 seq 检查点 synthetic Elm 归属最近已闭合事务 txn8
  });
});