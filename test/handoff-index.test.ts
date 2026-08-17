/**
 * ca-v7 7.3 H13/H14 — index.js 集成单测（任务书 A §3.6，红线基线，主笔/测试线）。
 * 覆盖：runHandoffCheck（无 caHandoff 7.3 不生效 / 压力触发 → execute 收到 plan / 无触发零调用 /
 * overflowLatch 消费复位）、getInjectionRejectStreak 导出面。
 */
import { describe, it, expect } from 'vitest';
import { runHandoffCheck, planHandoff, getInjectionRejectStreak } from '../lib/index.js';
import { CACompactionEngine } from '../lib/engine.js';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { TOPIC_STATE_KEY } from '../lib/topic-state.js';
import { VIEW_KEY } from '../lib/view.js';
import { newSession, appendTurn, appendHeader, foldView, makeEngineCtx, makeAgent } from './helpers.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeCtx(session: any, over: any = {}) {
  const view = foldView(session);
  const calls = { execute: [] as unknown[], sessionState: [] as unknown[] };
  const caHandoff = {
    mode: 'suggest',
    async sessionState() {
      calls.sessionState.push(arguments);
      return { lastHandoffAt: null, existingBranchKeys: [], parentDepth: 0 };
    },
    async execute(plan: any, agent: any, extra: any) {
      calls.execute.push({ plan, agent, extra });
      return null;
    },
  };
  return {
    calls,
    ctx: {
      caHandoff,
      get(name: string) { return (this as Record<string, unknown>)[name]; },
      sessionProjections: {
        snapshot() {
          return {
            values: {
              [VIEW_KEY]: view,
              [TOPIC_STATE_KEY]: { topicClusters: over.topicClusters ?? 0, farRatio: over.farRatio ?? 0 },
              ['ca-v7/tool-trace']: [],
            },
          };
        },
      },
      tokenMeter: { measure: () => ({ totalTokens: over.totalTokens ?? 1000 }) },
      ...over.ctx,
    },
    engine: {
      lastContext: over.contextWindow ?? 100000,
      lastPressureAttempt: over.lastPressureAttempt ?? null,
      overflowLatch: over.overflowLatch ?? null,
      gradeView: () => new Map(),
    },
    config: {
      handoffEnabled: over.handoffEnabled ?? true,
      handoffPressureRatio: over.handoffPressureRatio ?? 0.8,
      handoffMinTurns: 6,
      handoffMaxDepth: 1,
      handoffCooldownMs: 300000,
      tailN: 2,
      ...over.config,
    },
  };
}

describe('H13 runHandoffCheck', () => {
  it('无 ctx.caHandoff → null（7.3 不生效，零调用）', async () => {
    const session = newSession('rhc1');
    appendTurn(session, 1, { userText: 'u1', thought: 'r1' });
    const h = makeCtx(session);
    const r = await runHandoffCheck({ ...h.ctx, caHandoff: undefined }, makeAgent(session), h.engine, h.config, silentLog);
    expect(r).toBeNull();
  });

  it('压力触发（ratio≥0.80）→ execute 收到 status=plan 的 plan', async () => {
    const session = newSession('rhc2');
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const h = makeCtx(session, { totalTokens: 90000, contextWindow: 100000 });
    const r = await runHandoffCheck(h.ctx, makeAgent(session), h.engine, h.config, silentLog);
    expect(h.calls.execute.length).toBe(1);
    const { plan, extra } = h.calls.execute[0] as { plan: any; extra: any };
    expect(plan.status).toBe('plan');
    expect(plan.kind).toBe('pressure');
    expect(extra.signalRecords.length).toBeGreaterThan(0);
    expect(r).toBeNull(); // execute 返回 null → receipt null
  });

  it('无触发（压力/噪声均 false）→ execute 零调用', async () => {
    const session = newSession('rhc3');
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const h = makeCtx(session, { totalTokens: 1000, contextWindow: 100000 });
    const r = await runHandoffCheck(h.ctx, makeAgent(session), h.engine, h.config, silentLog);
    expect(h.calls.execute.length).toBe(0);
    expect(r).toBeNull();
  });

  it('handoffEnabled=false → null 零调用', async () => {
    const session = newSession('rhc4');
    appendTurn(session, 1, { userText: 'u1', thought: 'r1' });
    const h = makeCtx(session, { handoffEnabled: false, totalTokens: 90000, contextWindow: 100000 });
    expect(await runHandoffCheck(h.ctx, makeAgent(session), h.engine, h.config, silentLog)).toBeNull();
    expect(h.calls.execute.length).toBe(0);
  });

  it('overflowLatch 消费复位（检查后置 null）', async () => {
    const session = newSession('rhc5');
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const latch = { sessionId: session.id, at: Date.now(), recovered: false, seq: 0 };
    const h = makeCtx(session, { totalTokens: 90000, contextWindow: 100000, overflowLatch: latch });
    await runHandoffCheck(h.ctx, makeAgent(session), h.engine, h.config, silentLog);
    expect(h.engine.overflowLatch).toBeNull();
  });

  it('overflowLatch 按 session 隔离：其他会话的 latch 不被消费（多会话回归）', async () => {
    const sessionA = newSession('rhc5-a');
    const sessionB = newSession('rhc5-b');
    for (let i = 1; i <= 8; i += 1) appendTurn(sessionB, i, { userText: `u${i}`, thought: `r${i}` });
    const latchA = { sessionId: sessionA.id, at: Date.now(), recovered: false, seq: 0 };
    const h = makeCtx(sessionB, { totalTokens: 1000, contextWindow: 100000, overflowLatch: latchA });
    // 生产引擎形态：按 session 的 WeakMap 存在，镜像字段是「最近一次写入」（属于 A）
    const engine = h.engine as unknown as Record<string, unknown>;
    engine.overflowLatchBySession = new WeakMap();
    engine.lastContextBySession = new WeakMap();
    engine.lastPressureAttemptBySession = new WeakMap();
    await runHandoffCheck(h.ctx, makeAgent(sessionB), h.engine, h.config, silentLog);
    expect(h.engine.overflowLatch).toBe(latchA); // B 的检查不得清掉 A 的 latch
  });

  it('overflowLatch 本会话 entry 消费后从 WeakMap 删除（镜像字段同步置空）', async () => {
    const session = newSession('rhc5-c');
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const latch = { sessionId: session.id, at: Date.now(), recovered: false, seq: 0 };
    const h = makeCtx(session, { totalTokens: 90000, contextWindow: 100000, overflowLatch: latch });
    const map = new WeakMap<any, any>([[session, latch]]);
    const engine = h.engine as unknown as Record<string, unknown>;
    engine.overflowLatchBySession = map;
    engine.lastContextBySession = new WeakMap();
    engine.lastPressureAttemptBySession = new WeakMap();
    await runHandoffCheck(h.ctx, makeAgent(session), h.engine, h.config, silentLog);
    expect(map.get(session)).toBeUndefined();
    expect(h.engine.overflowLatch).toBeNull();
  });

  it('execute 抛错 → 捕获为 null 不抛出（fail-open，继续轮次）', async () => {
    const session = newSession('rhc6');
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const h = makeCtx(session, { totalTokens: 90000, contextWindow: 100000 });
    (h.ctx.caHandoff as any).execute = async () => { throw new Error('boom'); };
    const r = await runHandoffCheck(h.ctx, makeAgent(session), h.engine, h.config, silentLog);
    expect(r).toBeNull();
  });
});

describe('H13b planHandoff（handoff 优先两阶段：只规划不执行）', () => {
  it('压力触发 → 返回 plan + records，execute 零调用', async () => {
    const session = newSession('rhc7');
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const h = makeCtx(session, { totalTokens: 90000, contextWindow: 100000 });
    const prepared = await planHandoff(h.ctx, makeAgent(session), h.engine, h.config, silentLog);
    expect(prepared?.plan.status).toBe('plan');
    expect(prepared?.plan.kind).toBe('pressure');
    expect(Array.isArray(prepared?.records)).toBe(true);
    expect(prepared?.records.length).toBeGreaterThan(0);
    expect(h.calls.execute.length).toBe(0); // 规划阶段绝不 spawn/落库
  });

  it('mode off → null（回落压缩路径）', async () => {
    const session = newSession('rhc8');
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const h = makeCtx(session, { totalTokens: 90000, contextWindow: 100000 });
    (h.ctx.caHandoff as { mode: string }).mode = 'off';
    expect(await planHandoff(h.ctx, makeAgent(session), h.engine, h.config, silentLog)).toBeNull();
    expect(h.calls.execute.length).toBe(0);
  });

  it('handoffPressureRatio 覆写：低于新线不触发，高于新线触发且 signalRecords 阈值同步', async () => {
    // 覆写为 0.5：ratio 0.45 < 0.5 → 不触发
    const low = newSession('rhc9');
    for (let i = 1; i <= 8; i += 1) appendTurn(low, i, { userText: `u${i}`, thought: `r${i}` });
    const hLow = makeCtx(low, { totalTokens: 45000, contextWindow: 100000, config: { handoffPressureRatio: 0.5 } });
    expect(await planHandoff(hLow.ctx, makeAgent(low), hLow.engine, hLow.config, silentLog)).toBeNull();

    // 覆写为 0.5：ratio 0.55 ≥ 0.5 → 触发（默认 0.8 下本不触发）
    const high = newSession('rhc10');
    for (let i = 1; i <= 8; i += 1) appendTurn(high, i, { userText: `u${i}`, thought: `r${i}` });
    const hHigh = makeCtx(high, { totalTokens: 55000, contextWindow: 100000, config: { handoffPressureRatio: 0.5 } });
    const prepared = await planHandoff(hHigh.ctx, makeAgent(high), hHigh.engine, hHigh.config, silentLog);
    expect(prepared?.plan.status).toBe('plan');
    const ratioRec = prepared?.records.find((r: { kind: string }) => r.kind === 'pressure_ratio');
    expect(ratioRec).toBeTruthy();
    expect(JSON.parse((ratioRec as { valueJson: string }).valueJson).threshold).toBe(0.5);
  });

  it('真实引擎形态：B 会话的 planHandoff 不得消费 A 会话的 overflow latch（2026-08-18 修复回归）', async () => {
    const sessionA = newSession('rhc11-a');
    const sessionB = newSession('rhc11-b');
    for (let i = 1; i <= 8; i += 1) appendTurn(sessionA, i, { userText: `a${i}`, thought: `ra${i}` });
    for (let i = 1; i <= 8; i += 1) appendTurn(sessionB, i, { userText: `b${i}`, thought: `rb${i}` });
    // 真实引擎挂在 A 的 ctx 上（Service 级单例跨会话共享）
    const harness = makeEngineCtx(sessionA, foldView(sessionA), {
      totalTokens: 110000,
      nodeTokens: 3000,
      contextWindow: 100000,
      summaries: ['overflow summary text'],
    });
    const engine = new CACompactionEngine(harness.ctx, {});
    // 真实溢出恢复路径 → A 的 latch 写入（公开字段名）
    const listener = harness.listeners['agent/request-error'];
    await listener(
      { agent: makeAgent(sessionA), failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal: new AbortController().signal },
      async () => undefined,
    );
    expect(engine.overflowLatchBySession.get(sessionA)).toBeDefined();
    // B 会话（低压力、无噪声）跑 planHandoff：不得消费 A 的 latch
    const ctxB: Record<string, unknown> = {
      caHandoff: {
        mode: 'suggest',
        async sessionState() { return { lastHandoffAt: null, existingBranchKeys: [], parentDepth: 0 }; },
        async execute() { return null; },
      },
      get(name: string) { return (this as Record<string, unknown>)[name]; },
      sessionProjections: {
        snapshot() {
          return {
            values: {
              [VIEW_KEY]: foldView(sessionB),
              [TOPIC_STATE_KEY]: { topicClusters: 0, farRatio: 0 },
              ['ca-v7/tool-trace']: [],
            },
          };
        },
      },
      tokenMeter: { measure: () => ({ totalTokens: 1000 }) },
    };
    const configB = {
      handoffEnabled: true,
      handoffPressureRatio: 0.8,
      handoffMinTurns: 6,
      handoffMaxDepth: 1,
      handoffCooldownMs: 300000,
      tailN: 2,
    };
    const r = await planHandoff(ctxB, makeAgent(sessionB), engine, configB, silentLog);
    expect(r).toBeNull(); // B 无触发
    // A 的 latch 未被 B 消费：WeakMap entry 保留、共享镜像未被置空
    expect(engine.overflowLatchBySession.get(sessionA)).toBeDefined();
    expect(engine.overflowLatch).toEqual(engine.overflowLatchBySession.get(sessionA));
  });
});

describe('H14 getInjectionRejectStreak', () => {
  it('导出存在；陌生会话默认 0', () => {
    const session = newSession('h14a');
    expect(typeof getInjectionRejectStreak).toBe('function');
    expect(getInjectionRejectStreak(session)).toBe(0);
  });
});
