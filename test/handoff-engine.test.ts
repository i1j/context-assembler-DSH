/**
 * ca-v7 7.3 H9/H11/H12 — engine 集成单测（任务书 A §3.5，红线基线，主笔/测试线）。
 * 覆盖：summarizeContent purpose 透传 + handoff 专用指令、lastPressureAttempt（B55 放弃语义）、
 * overflowLatch 一次性写入（恢复成功/失败）。
 * 夹具对齐既有 engine.test.ts：appendHeader（routedTarget）+ 8 turn REL 会话 + openNextTurn(9)。
 */
import { describe, it, expect } from 'vitest';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { CACompactionEngine } from '../lib/engine.js';
import { HANDOFF_BRANCH_INSTRUCTION } from '../lib/handoff-branch-summary.js';
import {
  newSession,
  appendHeader,
  appendTurn,
  foldView,
  makeEngineCtx,
  makeAgent,
} from './helpers.js';

function openNextTurn(session: any, turnNo: number) {
  session.append('turn/start', { turn: turnNo });
  session.append('step/start', { turn: turnNo, step: 1 });
}

/** 8 turn 会话（t1 FAR、t2 REL、t3-t6 ACT、t7-t8 tail）+ 开第 9 轮（压力路径复用既有口径） */
function buildPressureSession(id: string) {
  const session = newSession(id);
  appendHeader(session);
  appendTurn(session, 1, { userText: 'alpha completely different text one', thought: 'r1' });
  appendTurn(session, 2, { userText: 'shared common prefix beta', thought: 'r2' });
  appendTurn(session, 3, { userText: 'shared common prefix gamma', thought: 'r3' });
  for (let i = 4; i <= 8; i += 1) appendTurn(session, i, { userText: 'ordinary tail text ' + i, thought: 'r' + i });
  openNextTurn(session, 9);
  return session;
}

describe('H9 summarizeContent purpose 透传', () => {
  it('默认 purpose=compaction；options.purpose 透传 ctx.llm.stream', async () => {
    const session = newSession('h9a');
    appendHeader(session);
    appendTurn(session, 1, { userText: 'u1', thought: 'r1' });
    const harness = makeEngineCtx(session, foldView(session), { summaries: ['ok'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    await engine.summarizeContent(session, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], agent, new AbortController().signal);
    expect(harness.purposes).toEqual(['compaction']);
  });

  it("purpose='handoff-branch' → 透传 + 指令为 HANDOFF_BRANCH_INSTRUCTION（末消息文本命中）", async () => {
    const session = newSession('h9b');
    appendHeader(session);
    appendTurn(session, 1, { userText: 'u1', thought: 'r1' });
    const harness = makeEngineCtx(session, foldView(session), { summaries: ['分支摘要 JSON'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    const agent = makeAgent(session);
    await engine.summarizeContent(
      session,
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      agent,
      new AbortController().signal,
      { purpose: 'handoff-branch' },
    );
    expect(harness.purposes).toEqual(['handoff-branch']);
    const lastInput = harness.streamInputs[0].join('');
    expect(lastInput).toContain('source_txn_ids'); // handoff 指令特征
    expect(HANDOFF_BRANCH_INSTRUCTION).toContain('source_txn_ids');
  });
});

describe('H11 lastPressureAttempt（compactIfNeeded 返回前写入）', () => {
  it('构造器初始化为 null', () => {
    const session = newSession('h11a');
    const harness = makeEngineCtx(session, []);
    const engine = new CACompactionEngine(harness.ctx, {});
    expect(engine.lastPressureAttempt).toBeNull();
    expect(engine.overflowLatch).toBeNull();
  });

  it('低于阈值早退 → gaveUp:false + projected/thresholdTokens 有值', async () => {
    const session = buildPressureSession('h11b');
    const harness = makeEngineCtx(session, foldView(session), { totalTokens: 50000, contextWindow: 128000 });
    const engine = new CACompactionEngine(harness.ctx, {});
    await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);
    expect(engine.lastPressureAttempt).not.toBeNull();
    expect(engine.lastPressureAttempt!.gaveUp).toBe(false);
    expect(engine.lastPressureAttempt!.projected).toBe(50000);
    expect(engine.lastPressureAttempt!.thresholdTokens).toBeCloseTo(0.8 * 128000, 0);
  });

  it('B55 放弃（重试耗尽不收敛）→ gaveUp:true', async () => {
    const session = buildPressureSession('h11c');
    const harness = makeEngineCtx(session, foldView(session), {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['X'.repeat(20000), 'Y'.repeat(20000)],
    });
    const engine = new CACompactionEngine(harness.ctx, {});
    const result = await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);
    expect(result).toBeNull(); // A50 终态（既有行为）
    expect(engine.lastPressureAttempt!.gaveUp).toBe(true);
  });

  it('压力路径落地 → gaveUp:false', async () => {
    const session = buildPressureSession('h11d');
    const harness = makeEngineCtx(session, foldView(session), {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['ok'],
    });
    const engine = new CACompactionEngine(harness.ctx, {});
    const result = await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);
    expect(result).not.toBeNull();
    expect(engine.lastPressureAttempt!.gaveUp).toBe(false);
  });
});

describe('H12 overflowLatch（_registerOverflowRecovery 一次性写入）', () => {
  async function fireOverflow(harness: any, agent: any) {
    const listener = harness.listeners['agent/request-error'];
    return listener(
      { agent, failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal: new AbortController().signal },
      async () => undefined,
    );
  }

  it('恢复成功 → {recovered:true, seq:0}，单次写入', async () => {
    const session = buildPressureSession('h12a');
    const harness = makeEngineCtx(session, foldView(session), { totalTokens: 110000, nodeTokens: 3000, summaries: ['overflow summary text'] });
    const engine = new CACompactionEngine(harness.ctx, {});
    await fireOverflow(harness, makeAgent(session));
    expect(engine.overflowLatch).not.toBeNull();
    expect(engine.overflowLatch!.sessionId).toBe(session.id);
    expect(engine.overflowLatch!.recovered).toBe(true);
    expect(engine.overflowLatch!.seq).toBe(0);
  });

  it('恢复退化（result=null）→ {recovered:false}', async () => {
    const session = buildPressureSession('h12b');
    const harness = makeEngineCtx(session, foldView(session), { totalTokens: 110000, nodeTokens: 3000, summaries: [''] });
    const engine = new CACompactionEngine(harness.ctx, {});
    await fireOverflow(harness, makeAgent(session));
    expect(engine.overflowLatch!.recovered).toBe(false);
  });

  it('按 session 隔离的 WeakMap 以公开属性形态存在（index.js planHandoff 读取面，2026-08-18 修复回归）', async () => {
    const sessionA = buildPressureSession('h12c-a');
    const sessionB = buildPressureSession('h12c-b');
    const harness = makeEngineCtx(sessionA, foldView(sessionA), {
      totalTokens: 110000,
      nodeTokens: 3000,
      summaries: ['overflow summary text'],
    });
    const engine = new CACompactionEngine(harness.ctx, {});
    // 生产引擎形态：按 session 的 WeakMap 必须是公开属性（旧实现为 _ 前缀私有名，
    // index.js planHandoff 读不到 → 恒回落到共享镜像，跨会话串扰）
    expect(engine.lastContextBySession).toBeInstanceOf(WeakMap);
    expect(engine.lastPressureAttemptBySession).toBeInstanceOf(WeakMap);
    expect(engine.overflowLatchBySession).toBeInstanceOf(WeakMap);
    await fireOverflow(harness, makeAgent(sessionA));
    expect(engine.overflowLatchBySession.get(sessionA)).toEqual(engine.overflowLatch);
    expect(engine.overflowLatchBySession.get(sessionB)).toBeUndefined(); // B 无自己的 latch
  });
});
