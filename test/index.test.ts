/**
 * index.js 单测（R1 / R8 / T1 / T-R8 单测级）
 *
 * 覆盖：package.json 包形态断言（R1）；Config schema 键全集 + 默认值 + min=1 校验（R8）；
 * apply 装配（投影注册/引擎注册/pre-step listener 挂载/debug 导出缓存）；apply 异常不冒泡（F51）；
 * injectionEnabled 关闭不注入；K=2 变体 sections 长度 = min(K, 候选数)（T-R8）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply, Config, name, inject, rebuildInjectHistory, resolveRealityPick, getLlmTraceStore, backfillCoverage } from '../lib/index.js';
import { VIEW_KEY, exportView } from '../lib/view.js';
import { TOOL_TRACE_KEY, exportToolTrace, initToolTraceState, applyToolTraceState, viewToolTraceState } from '../lib/tool-trace.js';
import { TOPIC_STATE_KEY } from '../lib/topic-state.js';
import {
  newSession,
  appendTurn,
  appendHeader,
  appendUser,
  appendCompactionSummary,
  foldView,
  makeEngineCtx,
  makeAgent,
  richTxn,
} from './helpers.js';

describe('R1 插件包形态（T1 静态部分）', () => {
  it('package.json：peerDependencies 含 @deepseek-ai/cordis、exports 含 ".": {types, default}、dsh.bundle 清单指向 cordis.patch.yml', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.peerDependencies?.['@deepseek-ai/cordis']).toBeTruthy();
    expect(pkg.exports?.['.']).toBeTruthy();
    expect(pkg.exports['.'].types).toContain('lib/types/index.d.ts');
    expect(pkg.exports['.'].default).toContain('lib/index.js');
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    expect(pkg.type).toBe('module');
  });

  it('插件入口形态：name=ca-v7、inject 声明、Config schema 导出', () => {
    expect(name).toBe('ca-v7');
    expect(inject).toEqual(['sessionProjections', 'llm', 'tokenMeter', 'sessions']);
    expect(typeof Config).toBe('function');
  });
});

describe('R8 配置 schema（T-R8）', () => {
  it('键全集 + 默认值：tailN=2、thresholdRatio=0.8、retainRatio=0.16、maxTokens=8192、injectionTokenLimit=500、injectionK=1、auto=true、compactionRetries=1', () => {
    const cfg = Config({});
    expect(cfg).toEqual({
      tailN: 2,
      gradeAgeThresholdTurns: 6,
      gradeSimilarityThreshold: 0.5,
      topicSwitchEntry: 0,
      topicSplitStartChars: 5000,
      topicSplitPeakChars: 20000,
      jaccardPenaltyMax: 0.3,
      topicSplitForceAtPeak: true,
      summarizationProvider: '',
      summarizationModel: '',
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      maxTokens: 8192,
      injectionEnabled: true,
      injectionTokenLimit: 500,
      injectionK: 1,
      auto: true,
      compactionRetries: 1,
      handoffEnabled: true,
      handoffPressureRatio: 0.8,
      handoffMinTurns: 6,
      handoffMaxDepth: 1,
      handoffCooldownMs: 300000,
      toolTraceEnabled: true,
      llmTraceEnabled: true,
      llmTraceMaxCalls: 256,
      toolRewriteEnabled: true,
      toolRewriteMinSavingChars: 400,
      toolRewriteDryRun: false,
      oodaRewriteEnabled: false,
      oodaRewriteDryRun: true,
      oodaMinSavingChars: 400,
      oodaThinkBudget: 2000,
      oodaBackfillUrl: 'http://127.0.0.1:11435',
      oodaBackfillModel: 'qwen3-4b-instruct:32k',
      oodaBackfillTimeoutMs: 60000,
      oodaBackfillMaxConcurrent: 2,
      oodaBackfillMaxQueue: 16,
      entityGraphEnabled: true,
      entityGraphDbPath: '',
      toolBackfillEnabled: true,
      toolBackfillUrl: 'http://127.0.0.1:11435',
      toolBackfillModel: 'qwen3-4b-instruct:32k',
      toolBackfillTimeoutMs: 30000,
      toolBackfillMaxConcurrent: 2,
      toolBackfillMaxQueue: 16,
      realityRecallEnabled: false,
      realityDbPath: './ca_cache/ca_topics.db',
      realityEmbedUrl: 'http://127.0.0.1:11435/api/embed',
      realityEmbedModel: 'qwen3-embedding:0.6b',
      realityTopK: 1,
      realityPoolSize: 15,
      realityPickMode: '4b',
      realityPickUrl: 'http://127.0.0.1:11435',
      realityPickModel: 'qwen3-4b-instruct:32k',
      realityMinScore: 0.5,
      realityTokenLimit: 500,
    });
    // 键全集
    const keys = Object.keys(cfg);
    for (const k of [
      'tailN', 'gradeAgeThresholdTurns', 'gradeSimilarityThreshold', 'topicSwitchEntry',
      'topicSplitStartChars', 'topicSplitPeakChars', 'jaccardPenaltyMax', 'topicSplitForceAtPeak',
      'summarizationProvider',
      'summarizationModel', 'thresholdRatio', 'retainRatio', 'maxTokens', 'injectionEnabled',
      'injectionTokenLimit', 'injectionK', 'auto', 'compactionRetries',
      'toolTraceEnabled', 'llmTraceEnabled', 'llmTraceMaxCalls',
      'toolRewriteEnabled', 'toolRewriteMinSavingChars', 'toolRewriteDryRun',
      'oodaRewriteEnabled', 'oodaRewriteDryRun', 'oodaMinSavingChars', 'oodaThinkBudget',
      'oodaBackfillUrl', 'oodaBackfillModel', 'oodaBackfillTimeoutMs',
      'oodaBackfillMaxConcurrent', 'oodaBackfillMaxQueue',
      'handoffEnabled', 'handoffPressureRatio', 'handoffMinTurns', 'handoffMaxDepth', 'handoffCooldownMs',
      'entityGraphEnabled', 'entityGraphDbPath',
      'toolBackfillEnabled', 'toolBackfillUrl', 'toolBackfillModel',
      'toolBackfillTimeoutMs', 'toolBackfillMaxConcurrent', 'toolBackfillMaxQueue',
      'realityRecallEnabled', 'realityDbPath', 'realityEmbedUrl', 'realityEmbedModel',
      'realityTopK', 'realityPoolSize', 'realityPickMode', 'realityPickUrl', 'realityPickModel',
      'realityMinScore', 'realityTokenLimit',
    ]) {
      expect(keys).toContain(k);
    }
  });

  it('读取断言 = 写入值（tailN=4/thresholdRatio=0.5/retainRatio=0.2/compactionRetries=2/injectionK=2/injectionEnabled=false）', () => {
    const cfg = Config({
      tailN: 4,
      thresholdRatio: 0.5,
      retainRatio: 0.2,
      compactionRetries: 2,
      injectionK: 2,
      injectionEnabled: false,
    });
    expect(cfg.tailN).toBe(4);
    expect(cfg.thresholdRatio).toBe(0.5);
    expect(cfg.retainRatio).toBe(0.2); // 继承兼容键读取一致（B66/F34）
    expect(cfg.compactionRetries).toBe(2);
    expect(cfg.injectionK).toBe(2);
    expect(cfg.injectionEnabled).toBe(false);
    expect(cfg.auto).toBe(true); // auto 保持默认 true（D38 拆分）
  });

  it('min=1 校验：tailN=0 / compactionRetries=0 非法（F57/F56）', () => {
    expect(() => Config({ tailN: 0 })).toThrow();
    expect(() => Config({ compactionRetries: 0 })).toThrow();
    expect(() => Config({ tailN: 1, compactionRetries: 1 })).not.toThrow();
  });
});

describe('T1 apply 装配', () => {
  it('注册投影（view + tool-trace）+ llm/stream 观测器 + 引擎服务 + pre-step listener + onChanged 驱动 debug 缓存', () => {
    const session = newSession('t1');
    appendTurn(session, 1, { userText: 'turn 1 用户', thought: 'turn 1 回复' });
    const view = foldView(session);
    const harness = makeEngineCtx(session, view);
    const registeredKeys: string[] = [];
    let changed = 0;
    harness.ctx.sessionProjections.register = (def: { key: string; init: () => unknown; apply: (s: unknown, e: unknown) => unknown; view: (s: unknown) => unknown }) => {
      registeredKeys.push(def.key);
      // 每个投影都可独立 fold（纯函数契约）；用各自会变化的事件验证状态前进
      const st = def.init();
      const probe = def.key === TOOL_TRACE_KEY
        ? { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c', name: 'tool_a', arguments: '{}' } }
        : { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } };
      const st2 = def.apply(st, probe);
      expect(st2).not.toBe(st);
      return () => {};
    };
    harness.ctx.sessionProjections.onChanged = (cb: (s: unknown, key: string, value: unknown, seq: number) => void) => {
      changed += 1;
      // 模拟投影 change feed（按注册顺序：先 view、后 tool-trace）
      if (changed === 1) cb(session, VIEW_KEY, foldView(session), 5);
      else cb(session, TOOL_TRACE_KEY, [], 5);
      return () => {};
    };
    apply(harness.ctx, Config({}));
    expect(registeredKeys).toEqual([VIEW_KEY, TOOL_TRACE_KEY]);
    expect(changed).toBe(2);
    expect(typeof harness.listeners['agent/pre-step']).toBe('function');
    expect(typeof harness.listeners['agent/request-error']).toBe('function'); // 引擎溢出恢复 listener
    expect(typeof harness.listeners['llm/stream']).toBe('function'); // 7.1 P1：云端调用观测器
    // ctx.compaction 已注册为 CACompactionEngine 实例（A16 单测级）
    expect(harness.ctx.compaction).toBeTruthy();
    expect(harness.ctx.compaction.constructor.name).toBe('CACompactionEngine');
    // debug 导出缓存被 change feed 填充
    expect(exportView('t1').length).toBeGreaterThan(0);
    expect(exportToolTrace('t1')).toEqual([]);
    // llm-trace 存储按 ctx 可取（debug/live 消费入口）
    expect(getLlmTraceStore(harness.ctx)).not.toBeNull();
    expect(getLlmTraceStore(harness.ctx)?.maxCalls).toBe(256);
  });

  it('7.1 P1 开关：toolTraceEnabled=false 只注册 view；llmTraceEnabled=false 不挂 llm/stream 观测器', () => {
    const session = newSession('p1-switch');
    appendTurn(session, 1, { userText: 'u', thought: 'r' });
    const harness = makeEngineCtx(session, foldView(session));
    const registeredKeys: string[] = [];
    harness.ctx.sessionProjections.register = (def: { key: string }) => {
      registeredKeys.push(def.key);
      return () => {};
    };
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({ toolTraceEnabled: false, llmTraceEnabled: false }));
    expect(registeredKeys).toEqual([VIEW_KEY]);
    expect(harness.listeners['llm/stream']).toBeUndefined();
    expect(getLlmTraceStore(harness.ctx)).not.toBeNull(); // 存储仍创建（fail-open 基础件），但不订阅
  });

  it('F51：apply 异常 catch + 日志不冒泡（不影响会话正常收发）', () => {
    const session = newSession('f51');
    const view = foldView(session);
    const harness = makeEngineCtx(session, view);
    harness.ctx.sessionProjections.register = () => {
      throw new Error('projection register boom');
    };
    let threw = false;
    try {
      apply(harness.ctx, Config({}));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // 不冒泡
    expect(harness.warnLog.some((l) => l.includes('apply 异常'))).toBe(true);
  });

  it('水位压力配置透传：apply 装配的引擎与 topic-state 投影收到 topicSplit*（2026-08-18 修复回归）', () => {
    const session = newSession('water-cfg');
    appendTurn(session, 1, { userText: 'u', thought: 'r' });
    const harness = makeEngineCtx(session, foldView(session));
    const registered: Array<{ key: string }> = [];
    harness.ctx.sessionProjections.register = (def: { key: string }) => {
      registered.push(def);
      return () => {};
    };
    harness.ctx.sessionProjections.onChanged = () => () => {};
    // 宿主 caHandoff 存在 → topic-state 投影注册（handoff 噪声信号输入）
    harness.ctx.caHandoff = { mode: 'suggest', async sessionState() { return {}; }, async execute() { return null; } };
    apply(harness.ctx, Config({
      topicSplitStartChars: 8000,
      topicSplitPeakChars: 30000,
      jaccardPenaltyMax: 0.2,
      topicSplitForceAtPeak: false,
    }));
    // 引擎（gradeView 水位口径）：自定义值生效（修复前恒为 undefined → 默认值）
    const engine = harness.ctx.compaction;
    expect(engine.config.topicSplitStartChars).toBe(8000);
    expect(engine.config.topicSplitPeakChars).toBe(30000);
    expect(engine.config.jaccardPenaltyMax).toBe(0.2);
    expect(engine.config.topicSplitForceAtPeak).toBe(false);
    // topic-state 投影已注册（handoff 开启 + caHandoff 存在）
    expect(registered.some((d) => d.key === TOPIC_STATE_KEY)).toBe(true);
  });

  it('F51b：可选宿主 caHandoff 必须经 ctx.get 探测（直接属性访问会中止 apply，回归 2026-08-16）', () => {
    const session = newSession('f51b');
    appendTurn(session, 1, { userText: 'u', thought: 'r' });
    const harness = makeEngineCtx(session, foldView(session));
    // 模拟 Cordis 严格上下文：未声明 inject 的 caHandoff 直接属性访问即抛错
    Object.defineProperty(harness.ctx, 'caHandoff', {
      get() {
        throw new Error('cannot get property "caHandoff" without inject');
      },
    });
    harness.ctx.get = () => undefined; // 真实 ctx.get 语义：可选服务缺失返回 undefined
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({}));
    expect(harness.ctx.compaction?.constructor.name).toBe('CACompactionEngine');
    expect(typeof harness.listeners['agent/pre-step']).toBe('function');
    expect(harness.warnLog.some((l) => l.includes('apply 异常'))).toBe(false);
  });

  it('realityRecallEnabled + 空索引：告警不再触发 log TDZ，apply 完整装配（回归 2026-08-16）', () => {
    const session = newSession('tdz-log');
    appendTurn(session, 1, { userText: 'u', thought: 'r' });
    const harness = makeEngineCtx(session, foldView(session));
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({
      realityRecallEnabled: true,
      entityGraphEnabled: false, // 隔离 entity-store 路径，只验证 reality 告警分支
      realityDbPath: '/tmp/ca-v7-definitely-missing-' + Date.now() + '.db',
    }));
    expect(harness.ctx.compaction?.constructor.name).toBe('CACompactionEngine');
    expect(typeof harness.listeners['agent/pre-step']).toBe('function');
    expect(harness.warnLog.some((l) => l.includes('召回注入停用'))).toBe(true);
    expect(harness.warnLog.some((l) => l.includes('apply 异常'))).toBe(false);
  });

  it('H13c：handoff 优先——plan 成立时本步跳过原位压缩，enter 后执行一次', async () => {
    const session = newSession('h13c');
    appendHeader(session); // routedTarget 数据源（engine.resolveContextWindow 依赖）
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 90000, contextWindow: 100000, summaries: [] });
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    const executeCalls: unknown[] = [];
    harness.ctx.caHandoff = {
      mode: 'suggest',
      async sessionState() {
        return { lastHandoffAt: null, existingBranchKeys: [], parentDepth: 0 };
      },
      async execute(...args: unknown[]) {
        executeCalls.push(args);
        return null;
      },
    };
    apply(harness.ctx, Config({}));
    // 分支划分已在 handoff-index/grade 单测覆盖；此处空 Map 兜底=全部 REL 单簇，聚焦验证顺序
    const engine = harness.ctx.compaction as { gradeView: () => Map<number, string>; compactIfNeeded: (...args: unknown[]) => unknown };
    engine.gradeView = () => new Map();
    let compactCalls = 0;
    const originalCompact = engine.compactIfNeeded.bind(engine);
    engine.compactIfNeeded = async (...args: unknown[]) => {
      compactCalls += 1;
      return originalCompact(...args);
    };
    const listener = harness.listeners['agent/pre-step'] as (
      payload: { agent: unknown; step: number; signal: AbortSignal },
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: unknown[] }>;
    await listener(
      { agent: makeAgent(session), step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    expect(executeCalls.length).toBe(1); // plan 在压缩前成立，enter 后 execute 一次
    expect(compactCalls).toBe(0); // 本步跳过原位压缩
  });

  it('H13d：handoff 无计划 → 回落原位压缩（压缩兜底）', async () => {
    const session = newSession('h13d');
    appendHeader(session); // routedTarget 数据源（engine.resolveContextWindow 依赖）
    for (let i = 1; i <= 8; i += 1) appendTurn(session, i, { userText: `u${i}`, thought: `r${i}` });
    const view = foldView(session);
    const harness = makeEngineCtx(session, view, { totalTokens: 90000, contextWindow: 100000 });
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    harness.ctx.caHandoff = {
      mode: 'off', // 规划直接返回 null → 压缩兜底
      async sessionState() {
        return { lastHandoffAt: null, existingBranchKeys: [], parentDepth: 0 };
      },
      async execute() {
        return null;
      },
    };
    apply(harness.ctx, Config({}));
    const engine = harness.ctx.compaction as { gradeView: () => Map<number, string>; compactIfNeeded: (...args: unknown[]) => unknown };
    engine.gradeView = () => new Map();
    let compactCalls = 0;
    const originalCompact = engine.compactIfNeeded.bind(engine);
    engine.compactIfNeeded = async (...args: unknown[]) => {
      compactCalls += 1;
      return originalCompact(...args);
    };
    const listener = harness.listeners['agent/pre-step'] as (
      payload: { agent: unknown; step: number; signal: AbortSignal },
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: unknown[] }>;
    await listener(
      { agent: makeAgent(session), step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    expect(compactCalls).toBe(1); // handoff 失败/不可用 → 压缩兜底
  });

  it('注入开关关闭（injectionEnabled=false）→ pre-step 不注入（T5 计数断言同族载体）', async () => {
    const session = newSession('off');
    appendTurn(session, 1, { userText: 'turn 1', thought: 'r1' });
    appendTurn(session, 2, { userText: 'turn 2', thought: 'r2' });
    const t1Seqs = [...session.surface.nodes].slice(0, 2);
    appendCompactionSummary(session, { shadowedSeqs: t1Seqs, summaryText: 'checkpoint summary text' });
    session.append('turn/start', { turn: 3 });
    const view = foldView(session);
    const harness = makeEngineCtx(session, view);
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({ injectionEnabled: false }));
    const listener = harness.listeners['agent/pre-step'] as (payload: { agent: unknown; step: number; signal: AbortSignal }, next: () => Promise<{ kind: string; messages: unknown[] }>) => Promise<{ kind: string; messages: unknown[] }>;
    const decision = await listener(
      { agent: makeAgent(session), step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    expect(decision.kind).toBe('enter');
    const caCount = decision.messages.filter((m) => (m as { source?: { plugin?: string } }).source?.plugin === 'ca-v7').length;
    expect(caCount).toBe(0); // 注入开关关闭后不产生
  });
});

describe('R8 K 变体（T-R8 A52：config injectionK → CaInjectConfig.k 映射链）', () => {
  it('K=2 + ≥2 FAR 候选事务 → 注入消息 sections 长度 = min(K=2, 候选数) = 2', async () => {
    // 直接构造 ≥2 个 FAR 遮蔽未承载候选事务的视图（F39 载体）
    const view = [
      ...richTxn(1, { userText: 'u1', finText: 'f1', visibility: 'shadowed', carrierState: 'unloaded' }),
      ...richTxn(2, { userText: 'u2', finText: 'f2', visibility: 'shadowed', carrierState: 'unloaded' }),
    ];
    const session = newSession('k2');
    const harness = makeEngineCtx(session, view as never);
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({ injectionK: 2 }));
    const listener = harness.listeners['agent/pre-step'] as (payload: { agent: unknown; step: number; signal: AbortSignal }, next: () => Promise<{ kind: string; messages: unknown[] }>) => Promise<{ kind: string; messages: unknown[] }>;
    const decision = await listener(
      { agent: makeAgent(session), step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    const injected = decision.messages.find((m) => (m as { source?: { plugin?: string } }).source?.plugin === 'ca-v7') as
      | { source: { sections: { name: string; text: string }[] } }
      | undefined;
    expect(injected).toBeTruthy();
    const sections = injected!.source.sections;
    expect(sections.filter((s) => s.name.startsWith('transaction-')).length).toBe(2); // min(K=2, 候选数=2) = 2
    const refs = sections.find((s) => s.name === 'transaction_refs');
    expect(refs?.text).toBe(JSON.stringify([1, 2]));
  });
});

describe('7.1 P4 工具结果改写（pre-step 集成）', () => {
  function foldTrace(session: import('@deepseek-ai/dsh-session').Session) {
    let state = initToolTraceState();
    for (const event of session.events) state = applyToolTraceState(state, event);
    return viewToolTraceState(state);
  }

  it('首轮/话题切换触发：单条 tool/result content-only replace；同块二次调用不再改写', async () => {
    const session = newSession('p4-int');
    const resultSeq = (() => {
      appendTurn(session, 1, { userText: '第一轮工具轮', tool: { callId: 'c-p4', name: 'bash', resultText: 'line\n'.repeat(400) + '[exit code: 0]' }, thought: 'done1' });
      appendTurn(session, 2, { userText: '第二轮普通轮', thought: 'done2' });
      appendTurn(session, 3, { userText: '第三轮普通轮', thought: 'done3' });
      appendTurn(session, 4, { userText: '第四轮普通轮', thought: 'done4' });
      return session.events.find((e) => e.type === 'tool/result' && (e.data as { message?: { source?: { callId?: string } } })?.message?.source?.callId === 'c-p4')!.seq;
    })();
    session.append('turn/start', { turn: 5 });
    appendUser(session, '第五轮触发改写');
    const view = foldView(session);
    const rows = foldTrace(session);
    const harness = makeEngineCtx(session, view);
    harness.ctx.sessionProjections.snapshot = (s: unknown) => ({
      asOfSeq: -1,
      values: { [VIEW_KEY]: foldView(s as never), [TOOL_TRACE_KEY]: rows },
    });
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({ auto: false, injectionEnabled: false, realityRecallEnabled: false, toolRewriteEnabled: true }));
    const listener = harness.listeners['agent/pre-step'] as (
      payload: { agent: unknown; step: number; signal: AbortSignal },
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: unknown[] }>;
    const run = () => listener({ agent: makeAgent(session), step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
    await run();
    const repl = session.events.filter((e) => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace');
    expect(repl).toHaveLength(1);
    const r = repl[0] as { seq: number; sourceEventSeqs?: number[]; data: any; surfaceOp?: { start: number; end: number } };
    expect(r.surfaceOp).toEqual({ op: 'replace', start: resultSeq, end: resultSeq });
    expect(r.sourceEventSeqs).toEqual([resultSeq]);
    const original = session.events.find((e) => e.type === 'tool/result' && e.seq === resultSeq) as { data: any };
    expect(r.data.message.id).toBe(original.data.message.id);
    expect(r.data.message.source).toEqual(original.data.message.source);
    expect(r.data.message.content[0].toolCallId).toBe(original.data.message.content[0].toolCallId);
    expect(r.data.message.content[0].content[0].text).not.toContain('line\n');
    expect(session.surface.nodes).not.toContain(resultSeq);
    await run(); // 同块再次触发：不产生第二条 replace（块内一次、不再微调）
    const repl2 = session.events.filter((e) => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace');
    expect(repl2).toHaveLength(1);
  });

  it('话题切换复位改写锁：新话题块允许再改写一次（P4 每话题块一次回归）', async () => {
    const session = newSession('p4-reset');
    // 尾部保护 tailN=1：txn4 的工具在 txn5 切换时非 tail，可被第一次改写
    appendTurn(session, 1, { userText: '普通轮一', thought: 'done1' });
    appendTurn(session, 2, { userText: '普通轮二', thought: 'done2' });
    appendTurn(session, 3, { userText: '普通轮三', thought: 'done3' });
    const firstSeq = (() => {
      appendTurn(session, 4, { userText: '工具轮一', tool: { callId: 'c-reset-a', name: 'bash', resultText: 'a'.repeat(800) + '[exit code: 0]' }, thought: 'done4' });
      return session.events.find((e) => e.type === 'tool/result' && (e.data as { message?: { source?: { callId?: string } } })?.message?.source?.callId === 'c-reset-a')!.seq;
    })();
    appendTurn(session, 5, { userText: '换个话题 触发第一次改写', thought: 'done5' });
    const harness = makeEngineCtx(session, foldView(session));
    harness.ctx.sessionProjections.snapshot = (s: unknown) => ({
      asOfSeq: -1,
      values: { [VIEW_KEY]: foldView(s as never), [TOOL_TRACE_KEY]: foldTrace(s as never) },
    });
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({ auto: false, injectionEnabled: false, realityRecallEnabled: false, toolRewriteEnabled: true, tailN: 1 }));
    const listener = harness.listeners['agent/pre-step'] as (
      payload: { agent: unknown; step: number; signal: AbortSignal },
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: unknown[] }>;
    const run = () => listener({ agent: makeAgent(session), step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
    await run(); // txn5 切换 → 改写 txn4 的工具结果
    let repls = session.events.filter((e) => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace');
    expect(repls).toHaveLength(1);
    expect((repls[0] as { surfaceOp?: { start: number } }).surfaceOp?.start).toBe(firstSeq);
    // 新话题块内的工具（txn6），随后 txn7 切换 → 锁被复位 → 允许第二次改写
    const secondSeq = (() => {
      appendTurn(session, 6, { userText: '工具轮二', tool: { callId: 'c-reset-b', name: 'bash', resultText: 'b'.repeat(800) + '[exit code: 0]' }, thought: 'done6' });
      return session.events.find((e) => e.type === 'tool/result' && (e.data as { message?: { source?: { callId?: string } } })?.message?.source?.callId === 'c-reset-b')!.seq;
    })();
    appendTurn(session, 7, { userText: '再问一个 触发第二次改写', thought: 'done7' });
    await run(); // txn7 切换 → 锁复位 → txn6（非 tail，tailN=1）再改写一次
    repls = session.events.filter((e) => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace');
    expect(repls).toHaveLength(2);
    expect((repls[1] as { surfaceOp?: { start: number } }).surfaceOp?.start).toBe(secondSeq);
    await run(); // 同块再次触发：仍不产生第三条
    expect(session.events.filter((e) => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace')).toHaveLength(2);
  });
});

describe('B1/B6 修复：reality 4B 空列表宁缺勿错 + 空截断不注入', () => {
  const pool = [
    { reality: { reality_id: 1, name: 'R1' }, score: 0.9 },
    { reality: { reality_id: 2, name: 'R2' }, score: 0.8 },
  ];

  it('resolveRealityPick：4B ok+空列表 → 空数组（合法空注入，禁止兜底）', () => {
    const r = resolveRealityPick({ status: 'ok', picked: [] }, pool);
    expect(r).toEqual([]);
  });

  it('resolveRealityPick：4B ok+合法 index → 映射候选；error/畸形 → null（调用方兜底）', () => {
    const ok = resolveRealityPick({ status: 'ok', picked: [{ index: 1, relevance: '承接' }] }, pool);
    expect(ok).toEqual([{ reality: { reality_id: 2, name: 'R2' }, relevance: '承接', score: 0.8 }]);
    expect(resolveRealityPick({ status: 'error', picked: [] }, pool)).toBeNull();
    expect(resolveRealityPick({ status: 'ok', picked: [{ index: 9 }] }, pool)).toEqual([]);
  });

  it('injectionTokenLimit 截断为空 → 不注入、无 ca-v7 消息（B6）', async () => {
    const view = [
      ...richTxn(1, { userText: 'a'.repeat(40), finText: 'f1', visibility: 'shadowed', carrierState: 'unloaded' }),
    ];
    const session = newSession('b6');
    const harness = makeEngineCtx(session, view as never);
    // 模拟「单字符 token 估算也超过 1」的截断到空场景（B6 构造载体）
    harness.ctx.tokenMeter.estimateMessage = () => 100;
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({ injectionTokenLimit: 1, realityRecallEnabled: false }));
    const listener = harness.listeners['agent/pre-step'] as (
      payload: { agent: unknown; step: number; signal: AbortSignal },
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: unknown[] }>;
    const decision = await listener(
      { agent: makeAgent(session), step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    expect(decision.messages.filter((m) => (m as { source?: { plugin?: string } }).source?.plugin === 'ca-v7')).toHaveLength(0);
  });
});

describe('7.1 P4→渐进：每轮评估改写（滑出保护区即被 Fct 取代，seq 级幂等，dry-run 不注入）', () => {
  function foldTrace(session: import('@deepseek-ai/dsh-session').Session) {
    let state = initToolTraceState();
    for (const event of session.events) state = applyToolTraceState(state, event);
    return viewToolTraceState(state);
  }

  function makeListener(session: import('@deepseek-ai/dsh-session').Session, cfg: Record<string, unknown>) {
    const view = foldView(session);
    const rows = foldTrace(session);
    const harness = makeEngineCtx(session, view);
    harness.ctx.sessionProjections.snapshot = (s: unknown) => ({
      asOfSeq: -1,
      values: { [VIEW_KEY]: foldView(s as never), [TOOL_TRACE_KEY]: foldTrace(s as never) },
    });
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({ auto: false, injectionEnabled: false, realityRecallEnabled: false, toolRewriteEnabled: true, ...cfg }));
    return harness.listeners['agent/pre-step'] as (
      payload: { agent: unknown; step: number; signal: AbortSignal },
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: unknown[] }>;
  }

  function replaceStarts(session: import('@deepseek-ai/dsh-session').Session): number[] {
    return session.events
      .filter((e) => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace')
      .map((e) => (e as { surfaceOp?: { start?: number } }).surfaceOp?.start ?? -1);
  }

  it('无压力也改写：每轮 step 1 评估，滑出保护区（tailN=2）的轮次被替换，同 seq 不重复', async () => {
    const session = newSession('p4-prog');
    // txn1/txn2/txn3 各有工具；tailN=2 保护最后 2 个真实 user 轮
    const seq1 = (() => {
      appendTurn(session, 1, { userText: '工具轮一', tool: { callId: 'c-p1', name: 'bash', resultText: 'a'.repeat(800) + '[exit code: 0]' }, thought: 'done1' });
      return session.events.find((e) => e.type === 'tool/result' && (e.data as { message?: { source?: { callId?: string } } })?.message?.source?.callId === 'c-p1')!.seq;
    })();
    const seq2 = (() => {
      appendTurn(session, 2, { userText: '工具轮二', tool: { callId: 'c-p2', name: 'bash', resultText: 'b'.repeat(800) + '[exit code: 0]' }, thought: 'done2' });
      return session.events.find((e) => e.type === 'tool/result' && (e.data as { message?: { source?: { callId?: string } } })?.message?.source?.callId === 'c-p2')!.seq;
    })();
    const seq3 = (() => {
      appendTurn(session, 3, { userText: '工具轮三', tool: { callId: 'c-p3', name: 'bash', resultText: 'c'.repeat(800) + '[exit code: 0]' }, thought: 'done3' });
      return session.events.find((e) => e.type === 'tool/result' && (e.data as { message?: { source?: { callId?: string } } })?.message?.source?.callId === 'c-p3')!.seq;
    })();
    // txn4（第 4 个真实 user 轮）进入 → 保护区 = txn3/txn4；txn1/txn2 滑出
    appendTurn(session, 4, { userText: '第四轮触发评估', thought: 'done4' });
    const listener = makeListener(session, { tailN: 2 });
    const agent = makeAgent(session);
    const run = () => listener({ agent, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
    await run();
    // 无压力触发 → 仍改写；txn1/txn2 滑出被替换（升序），txn3 仍在保护区
    let starts = replaceStarts(session);
    expect(starts).toEqual([seq1, seq2]);
    // 同 seq 不重复：再跑一轮（无新轮次滑出）→ 无新增
    await run();
    expect(replaceStarts(session)).toEqual([seq1, seq2]);
    // txn5 进入 → txn3 滑出 → 被替换；txn1/txn2 已被遮蔽不重复
    appendTurn(session, 5, { userText: '第五轮再评估', thought: 'done5' });
    await run();
    starts = replaceStarts(session);
    expect(starts).toEqual([seq1, seq2, seq3]);
    await run();
    expect(replaceStarts(session)).toEqual([seq1, seq2, seq3]);
  });

  it('dry-run：生成计划但不注入（无 replace 事件），日志含 dry-run 标记', async () => {
    const session = newSession('p4-dryrun');
    appendTurn(session, 1, { userText: '工具轮一', tool: { callId: 'c-dr', name: 'bash', resultText: 'd'.repeat(800) + '[exit code: 0]' }, thought: 'done1' });
    appendTurn(session, 2, { userText: '普通轮二', thought: 'done2' });
    appendTurn(session, 3, { userText: '普通轮三', thought: 'done3' });
    appendTurn(session, 4, { userText: '第四轮', thought: 'done4' });
    const view = foldView(session);
    const harness = makeEngineCtx(session, view);
    harness.ctx.sessionProjections.snapshot = (s: unknown) => ({
      asOfSeq: -1,
      values: { [VIEW_KEY]: foldView(s as never), [TOOL_TRACE_KEY]: foldTrace(s as never) },
    });
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    apply(harness.ctx, Config({ auto: false, injectionEnabled: false, realityRecallEnabled: false, toolRewriteEnabled: true, toolRewriteDryRun: true }));
    const listener = harness.listeners['agent/pre-step'] as (
      payload: { agent: unknown; step: number; signal: AbortSignal },
      next: () => Promise<{ kind: string; messages: unknown[] }>,
    ) => Promise<{ kind: string; messages: unknown[] }>;
    await listener({ agent: makeAgent(session), step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
    expect(replaceStarts(session)).toEqual([]); // 不注入
    expect(session.surface.nodes.some((n) => n === 0)).toBe(false); // 表层未被替换
  });

  it('backfill 观测：backfillCoverage 统计 overlay 后 outcome_l1 命中率', async () => {
    // 纯函数直接断言：观测统计正确性
    const rows = [
      { callId: 'c1', status: 'completed', outcome_l1: '退出码0，路径保留' },
      { callId: 'c2', status: 'completed', outcome_l1: '' }, // 4B 未就绪（fail-open 兜底）
      { callId: 'c3', status: 'completed' }, // 无 outcome_l1 字段
      { callId: 'c4', status: 'called' }, // 未完成行不计入
    ];
    const stats = backfillCoverage(rows);
    expect(stats).toEqual({ completed: 3, withOutcome: 1, pct: 33.3 });
    expect(backfillCoverage([])).toEqual({ completed: 0, withOutcome: 0, pct: 0 });
  });

  it('首轮 reality 注入：pre-step 时序（user/message 未写入会话）→ payload.messages 取当前提问并注入（B10）', async () => {
    const session = newSession('r-first-inject');
    // 真实时序：turn/start 已写，但 user/message 尚未 append（agent-loop 在 pre-step waterfall
    // 返回后才 session.append('user/message', decision.messages)）→ view 为空、事件日志无 user。
    session.append('turn/start', { turn: 1 });
    const harness = makeEngineCtx(session, []);
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    const captured = { embedBodies: [] as string[], generatePrompts: [] as string[] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const path = String(_url);
      if (path.includes('/api/embed')) {
        captured.embedBodies.push(String(init?.body ?? ''));
        return { ok: true, status: 200, async json() { return { embeddings: [[1, 0, 0]] }; } } as Response;
      }
      if (path.includes('/api/generate')) {
        captured.generatePrompts.push(String(init?.body ?? ''));
        return { ok: true, status: 200, async json() { return { response: JSON.stringify({ selected: [{ index: 0, relevance: '相关', priority: 1 }] }) }; } } as Response;
      }
      throw new Error('unexpected fetch ' + path);
    }) as typeof fetch;
    // 临时 CA 库：centroid=[1,0,0] 与模拟 embedding 精确匹配（真实库 centroid 多维，无法命中单热向量）
    const dir = mkdtempSync(join(tmpdir(), 'ca-reality-inject-'));
    const dbPath = join(dir, 'realities.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE realities (reality_id INTEGER, name TEXT, hdl TEXT, current_status TEXT, centroid_json TEXT, source_strands TEXT);
      INSERT INTO realities VALUES (1, '测试工作线', '进行中', '{"current_state":["测试现状"]}', '[1,0,0]', '{}');`);
    db.close();
    try {
      apply(harness.ctx, Config({
        realityRecallEnabled: true,
        entityGraphEnabled: false, // 隔离 entity-store 路径
        realityDbPath: dbPath,
        realityMinScore: 0.5,
        realityPickMode: '4b',
        auto: false,
        handoffEnabled: false, // 隔离 handoff 分支（无 caHandoff 时本项无效，显式关掉更稳）
      }));
      const listener = harness.listeners['agent/pre-step'] as (
        payload: { agent: unknown; step: number; signal: AbortSignal; messages: unknown[] },
        next: () => Promise<{ kind: string; messages: unknown[] }>,
      ) => Promise<{ kind: string; messages: unknown[] }>;
      // 当前轮提问只存在于 pre-step payload.messages（inbox claim），会话里没有 user/message 事件
      const result = await listener(
        {
          agent: makeAgent(session),
          step: 1,
          signal: new AbortController().signal,
          messages: [createUserMessage({ content: [{ type: 'text', text: '检查当前汇编插件工作状态' }], source: { kind: 'user' } })],
        },
        async () => ({ kind: 'enter', messages: [] }),
      );
      const texts = (result?.messages ?? []).map((m) => JSON.stringify(m)).join('\n');
      expect(texts).toContain('kind: reference');
      expect(texts).toContain('reality_refs');
      expect(texts).toContain('测试工作线');
      // B10：embedding 查询必须是当前轮提问（payload.messages），不是空文本/历史文本
      expect(captured.embedBodies[0]).toContain('检查当前汇编插件工作状态');
      expect(captured.generatePrompts[0]).toContain('检查当前汇编插件工作状态');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      globalThis.fetch = originalFetch;
    }
  });

  it('首轮 reality 注入：payload.messages 只有插件消息 → 不注入且零网络调用（宁缺勿错）', async () => {
    const session = newSession('r-first-noinject');
    session.append('turn/start', { turn: 1 });
    const harness = makeEngineCtx(session, []);
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('不应调用网络'); }) as typeof fetch;
    try {
      apply(harness.ctx, Config({
        realityRecallEnabled: true,
        entityGraphEnabled: false,
        realityDbPath: './ca_cache/ca_topics.db',
        realityMinScore: 0.5,
        auto: false,
        handoffEnabled: false,
      }));
      const listener = harness.listeners['agent/pre-step'] as (
        payload: { agent: unknown; step: number; signal: AbortSignal; messages: unknown[] },
        next: () => Promise<{ kind: string; messages: unknown[] }>,
      ) => Promise<{ kind: string; messages: unknown[] }>;
      const result = await listener(
        {
          agent: makeAgent(session),
          step: 1,
          signal: new AbortController().signal,
          messages: [createUserMessage({ content: [{ type: 'text', text: 'approval 提示' }], source: { kind: 'plugin', plugin: 'user-approval' } })],
        },
        async () => ({ kind: 'enter', messages: [] }),
      );
      const texts = (result?.messages ?? []).map((m) => JSON.stringify(m)).join('\n');
      expect(texts).not.toContain('kind: reference');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('turn2 强制短语切换：payload.messages 当前提问触发切换 → 注入且用当前提问做查询（B10）', async () => {
    const session = newSession('r-switch-inject');
    // turn1 完整闭合：其 user/message 已写入会话（pre-step 之后 append，符合真实时序）
    appendTurn(session, 1, { userText: '检查当前汇编插件工作状态', thought: '已检查完毕' });
    const harness = makeEngineCtx(session, []);
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    // 视角随轮次推进：turn1 pre-step → view 空；turn2 pre-step → view 含 turn1 历史
    let callNo = 0;
    harness.ctx.sessionProjections.snapshot = (s: unknown) => ({
      asOfSeq: -1,
      values: { [VIEW_KEY]: callNo === 0 ? [] : foldView(s as never) },
    });
    const captured = { embedBodies: [] as string[] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const path = String(_url);
      if (path.includes('/api/embed')) {
        captured.embedBodies.push(String(init?.body ?? ''));
        return { ok: true, status: 200, async json() { return { embeddings: [[1, 0, 0]] }; } } as Response;
      }
      if (path.includes('/api/generate')) {
        return { ok: true, status: 200, async json() { return { response: JSON.stringify({ selected: [{ index: 0, relevance: '相关', priority: 1 }] }) }; } } as Response;
      }
      throw new Error('unexpected fetch ' + path);
    }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), 'ca-reality-inject-'));
    const dbPath = join(dir, 'realities.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE realities (reality_id INTEGER, name TEXT, hdl TEXT, current_status TEXT, centroid_json TEXT, source_strands TEXT);
      INSERT INTO realities VALUES (1, '测试工作线', '进行中', '{"current_state":["测试现状"]}', '[1,0,0]', '{}');`);
    db.close();
    try {
      apply(harness.ctx, Config({
        realityRecallEnabled: true,
        entityGraphEnabled: false,
        realityDbPath: dbPath,
        realityMinScore: 0.5,
        realityPickMode: '4b',
        topicSwitchEntry: 0, // 生产同款：仅强制短语/首轮触发切换
        auto: false,
        handoffEnabled: false,
      }));
      const listener = harness.listeners['agent/pre-step'] as (
        payload: { agent: unknown; step: number; signal: AbortSignal; messages: unknown[] },
        next: () => Promise<{ kind: string; messages: unknown[] }>,
      ) => Promise<{ kind: string; messages: unknown[] }>;
      // turn1 pre-step（view 空）：首轮 → 切换 → 注入（B10 首轮注入现在生效）
      await listener(
        { agent: makeAgent(session), step: 1, signal: new AbortController().signal, messages: [] },
        async () => ({ kind: 'enter', messages: [] }),
      );
      callNo = 1;
      // turn2 pre-step：当前提问含强制短语「换话题」→ 切换 → reality 注入
      const result = await listener(
        {
          agent: makeAgent(session),
          step: 1,
          signal: new AbortController().signal,
          messages: [createUserMessage({ content: [{ type: 'text', text: '换话题，检查连接池状态' }], source: { kind: 'user' } })],
        },
        async () => ({ kind: 'enter', messages: [] }),
      );
      const texts = (result?.messages ?? []).map((m) => JSON.stringify(m)).join('\n');
      expect(texts).toContain('kind: reference');
      expect(texts).toContain('测试工作线');
      // B10：embedding 查询用的是 turn2 当前提问（换话题后的新问题），不是 turn1 的历史文本
      const lastEmbed = captured.embedBodies[captured.embedBodies.length - 1];
      expect(lastEmbed).toContain('换话题，检查连接池状态');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      globalThis.fetch = originalFetch;
    }
  });

  it('turn2 同话题延续：不注入（topicSwitchEntry=0 下 Jaccard≥0 恒延续，省 embedding/4B）', async () => {
    const session = newSession('r-continue-noinject');
    appendTurn(session, 1, { userText: '检查当前汇编插件工作状态', thought: '已检查完毕' });
    const harness = makeEngineCtx(session, []);
    harness.ctx.sessionProjections.register = () => () => {};
    harness.ctx.sessionProjections.onChanged = () => () => {};
    let callNo = 0;
    harness.ctx.sessionProjections.snapshot = (s: unknown) => ({
      asOfSeq: -1,
      values: { [VIEW_KEY]: callNo === 0 ? [] : foldView(s as never) },
    });
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      fetchCalls += 1;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const path = String(_url);
      if (path.includes('/api/embed')) {
        return { ok: true, status: 200, async json() { return { embeddings: [[1, 0, 0]] }; } } as Response;
      }
      if (path.includes('/api/generate')) {
        return { ok: true, status: 200, async json() { return { response: JSON.stringify({ selected: [{ index: 0, relevance: '相关', priority: 1 }] }) }; } } as Response;
      }
      throw new Error('unexpected fetch ' + path);
    }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), 'ca-reality-inject-'));
    const dbPath = join(dir, 'realities.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE realities (reality_id INTEGER, name TEXT, hdl TEXT, current_status TEXT, centroid_json TEXT, source_strands TEXT);
      INSERT INTO realities VALUES (1, '测试工作线', '进行中', '{"current_state":["测试现状"]}', '[1,0,0]', '{}');`);
    db.close();
    try {
      apply(harness.ctx, Config({
        realityRecallEnabled: true,
        entityGraphEnabled: false,
        realityDbPath: dbPath,
        realityMinScore: 0.5,
        realityPickMode: '4b',
        topicSwitchEntry: 0,
        auto: false,
        handoffEnabled: false,
      }));
      const listener = harness.listeners['agent/pre-step'] as (
        payload: { agent: unknown; step: number; signal: AbortSignal; messages: unknown[] },
        next: () => Promise<{ kind: string; messages: unknown[] }>,
      ) => Promise<{ kind: string; messages: unknown[] }>;
      // turn1 pre-step：首轮切换 → 注入（1 次 embedding+4B）
      await listener(
        { agent: makeAgent(session), step: 1, signal: new AbortController().signal, messages: [] },
        async () => ({ kind: 'enter', messages: [] }),
      );
      const callsAfterTurn1 = fetchCalls;
      callNo = 1;
      // turn2 pre-step：同话题延续（无强制短语）→ 不注入、零网络调用
      const result = await listener(
        {
          agent: makeAgent(session),
          step: 1,
          signal: new AbortController().signal,
          messages: [createUserMessage({ content: [{ type: 'text', text: '继续检查插件状态' }], source: { kind: 'user' } })],
        },
        async () => ({ kind: 'enter', messages: [] }),
      );
      const texts = (result?.messages ?? []).map((m) => JSON.stringify(m)).join('\n');
      expect(texts).not.toContain('kind: reference');
      expect(fetchCalls).toBe(callsAfterTurn1); // 延续轮零 embedding/4B 调用
    } finally {
      rmSync(dir, { recursive: true, force: true });
      globalThis.fetch = originalFetch;
    }
  });
});
