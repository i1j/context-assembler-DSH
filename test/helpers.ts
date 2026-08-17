/**
 * CA 插件 V7.0 单测共享夹具（test/helpers.ts）
 *
 * 策略（testplan §3）：真实 DSH Session（Session.create + append 校验事件形状/表层契约）
 * + mock ctx（sessionProjections snapshot / llm.stream / tokenMeter(measure+estimateMessage) /
 * sessions.flush / on / logger / reflect.provide）+ 视图纯函数 fold 重建。
 * 计数观测点：llm 摘要调用次数（purpose 记录）/ tokenMeter measure（投影复测）次数 /
 * 落地（surfaceOp.replace）次数——按任务书 §6 与 design §3.4 定一执行。
 */
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import { CompactionId } from '@deepseek-ai/dsh-compaction';
import { VIEW_KEY, applyViewState, initViewState, viewViewState } from '../lib/view.js';
import type { CaRichViewElm, CompactionSummaryCarrier } from '../lib/types/index.js';

export type { SessionEvent };

// ---------- session 夹具 ----------

/** 新建空会话 */
export function newSession(id = 's1'): Session {
  return Session.create(SessionId(id));
}

/** 追加 request/header（routedTarget 数据源） */
export function appendHeader(session: Session, provider = 'p', model = 'm'): void {
  session.append('request/header', { header: { config: { provider, model } }, reason: 'initial' });
}

/** 真实 user/message（surfaceOp append） */
export function appendUser(session: Session, text: string, sourceKind: 'user' | 'plugin' = 'user'): number {
  const evt = session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text }],
      source:
        sourceKind === 'user'
          ? { kind: 'user' }
          : { kind: 'plugin', plugin: 'ca-v7', form: 'snapshot', sections: [] },
    }),
    { surfaceOp: 'append' },
  );
  return evt.seq;
}

/** 纯文本 assistant（thought/fin 候选） */
export function appendAssistant(session: Session, turnNo: number, step: number, text: string): number {
  const evt = session.append(
    'assistant/message',
    {
      turn: turnNo,
      step,
      message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'p', model: 'm' } }),
    },
    { surfaceOp: 'append' },
  );
  return evt.seq;
}

/** 带 tool-call 的 assistant + tool/call（+ 可选 tool/result） */
export function appendToolPair(
  session: Session,
  turnNo: number,
  step: number,
  opts: { callId?: string; name?: string; resultText?: string | null } = {},
): { callSeq: number; resultSeq: number | null } {
  const cid = CallId(opts.callId ?? 'call-' + turnNo + '-' + step);
  const asst = session.append(
    'assistant/message',
    {
      turn: turnNo,
      step,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: cid, name: opts.name ?? 'tool_a', arguments: '{}' }],
        source: { provider: 'p', model: 'm' },
      }),
    },
    { surfaceOp: 'append' },
  );
  session.append('tool/call', { turn: turnNo, step, callId: cid, name: opts.name ?? 'tool_a', arguments: '{}' });
  let resultSeq: number | null = null;
  if (opts.resultText !== undefined && opts.resultText !== null) {
    const res = session.append(
      'tool/result',
      {
        turn: turnNo,
        step,
        message: createToolResultMessage({
          callId: cid,
          content: [{ type: 'text', text: opts.resultText }],
          isError: false,
        }),
      },
      { surfaceOp: 'append' },
    );
    resultSeq = res.seq;
  }
  return { callSeq: asst.seq, resultSeq };
}

/** 一个完整 turn（1 事务）：真实 user + 可选工具对 + 可选 fin + 可选闭合 */
export interface TurnSpec {
  userText: string;
  thought?: string | null;
  tool?: { name?: string; callId?: string; resultText?: string | null };
  close?: boolean; // 默认 true（turn/end）
  step?: number; // 默认 1
}

export function appendTurn(session: Session, turnNo: number, spec: TurnSpec): { userSeq: number; finSeq: number } {
  const close = spec.close ?? true;
  const step = spec.step ?? 1;
  session.append('turn/start', { turn: turnNo });
  const userSeq = appendUser(session, spec.userText);
  session.append('step/start', { turn: turnNo, step });
  let finSeq = userSeq;
  if (spec.tool) {
    const { resultSeq } = appendToolPair(session, turnNo, step, {
      callId: spec.tool.callId,
      name: spec.tool.name,
      resultText: spec.tool.resultText,
    });
    if (resultSeq !== null) finSeq = resultSeq;
  }
  if (spec.thought !== undefined && spec.thought !== null) {
    finSeq = appendAssistant(session, turnNo, step, spec.thought);
  }
  session.append('step/end', { turn: turnNo, step });
  if (close) session.append('turn/end', { turn: turnNo, reason: { kind: 'completed' } });
  return { userSeq, finSeq };
}

/** synthetic turn（无真实 user/message，F40 构造） */
export function appendSyntheticTurn(session: Session, turnNo: number, assistantText = 'synthetic reply'): void {
  session.append('turn/start', { turn: turnNo });
  appendAssistant(session, turnNo, 1, assistantText);
  session.append('turn/end', { turn: turnNo, reason: { kind: 'completed' } });
}

/** 插件注入消息（source.plugin='ca-v7'，含 transaction_refs 命名 section，B27/B29 载体）；返回事件 seq */
export function appendPluginInjection(session: Session, text: string, txnIds: number[]): number {
  const sections = [
    { name: 'transaction-1', text },
    { name: 'transaction_refs', text: JSON.stringify(txnIds) },
  ];
  const evt = session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'ca-v7', form: 'snapshot', sections },
    }),
    { surfaceOp: 'append' },
  );
  return evt.seq;
}

/** compaction/summary 事件（CompactionSummaryCarrier 类型化 mock 构造；invariant 必填字段完整，E19） */
export function appendCompactionSummary(
  session: Session,
  opts: {
    shadowedSeqs: number[];
    carriedTxnIds?: number[];
    summaryText?: string;
    provider?: string;
    model?: string;
    start?: number;
    end?: number;
  },
): void {
  const shadowed = opts.shadowedSeqs;
  const summary = [{ type: 'text' as const, text: opts.summaryText ?? 'checkpoint summary' }];
  const event: CompactionSummaryCarrier = {
    compactionId: CompactionId('comp-' + shadowed.join('-')),
    summary,
    rawOutput: summary,
    llmStreamCall: true,
    shadowedRange: { start: opts.start ?? shadowed[0], end: opts.end ?? shadowed[shadowed.length - 1] },
    shadowedSeqs: shadowed,
    shadowedTokenCount: 100,
    provider: opts.provider ?? 'p',
    model: opts.model ?? 'm',
    ...(opts.carriedTxnIds ? { caCarrierDetail: { carriedTxnIds: opts.carriedTxnIds } } : {}),
  };
  session.append('compaction/summary', event as never);
}

/** toolResultPruner 的 compaction/prune 事件（B38 排除性载体——无 caCarrierDetail、仅 tool-result 单节点） */
export function appendCompactionPrune(session: Session, shadowedSeqs: number[]): void {
  session.append('compaction/prune', {
    shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] },
    shadowedSeqs,
    shadowedTokenCount: 10,
  } as never);
}

// ---------- 视图 fold ----------

/** 纯函数 fold 会话事件 → rich 视图（与 index.js 投影同一套 init/apply/view） */
export function foldView(session: Session): CaRichViewElm[] {
  let st = initViewState();
  for (const evt of session.events) st = applyViewState(st, evt);
  return viewViewState(st) as CaRichViewElm[];
}

// ---------- rich 视图直接构造（inject 单测） ----------

export interface RichTxnOpts {
  userText?: string;
  finText?: string;
  thoughtText?: string;
  visibility?: 'visible' | 'shadowed';
  carrierState?: 'unloaded' | 'carried';
  baseRef?: number;
}

/** 单事务 rich 视图（elm_ref 以 baseRef 为基的连续 seq） */
export function richTxn(id: number, opts: RichTxnOpts = {}): CaRichViewElm[] {
  const base = opts.baseRef ?? id * 10;
  const vis = opts.visibility ?? 'visible';
  const carrier = opts.carrierState ?? 'unloaded';
  const elms: CaRichViewElm[] = [];
  if (opts.userText !== undefined) {
    elms.push({
      type: 'user',
      transaction_id: id,
      elm_ref: base,
      ooda_stage: 'orient',
      text_ref: base,
      text: opts.userText,
      grade: 'FAR',
      carrierState: carrier,
      visibility: vis,
    });
  }
  if (opts.thoughtText !== undefined) {
    elms.push({
      type: 'thought',
      transaction_id: id,
      elm_ref: base + 1,
      ooda_stage: 'decide',
      text_ref: base + 1,
      text: opts.thoughtText,
      grade: 'FAR',
      carrierState: carrier,
      visibility: vis,
    });
  }
  if (opts.finText !== undefined) {
    elms.push({
      type: 'fin',
      transaction_id: id,
      elm_ref: base + 2,
      ooda_stage: 'decide',
      text_ref: base + 2,
      text: opts.finText,
      grade: 'FAR',
      carrierState: carrier,
      visibility: vis,
    });
  }
  return elms;
}

// ---------- mock ctx（engine / index 单测） ----------

export interface ScriptedStream {
  text: string;
  finishKind?: 'stop' | 'max-tokens' | 'error';
  reject?: boolean;
}

export interface EngineCtxOpts {
  summaries?: (ScriptedStream | string | null)[]; // null → reject
  totalTokens?: number; // 入口压力读数
  nodeTokens?: number; // 每个表层节点 token 数
  contextWindow?: number;
  /** 每次 snapshot 重折会话事件（模拟投影 eager 驱动——T5 自动路径变体） */
  liveView?: boolean;
  /** resolveModelInfo 返回无 context 容量 */
  noContext?: boolean;
}

export interface EngineCtxHarness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
  purposes: string[]; // 每次 llm.stream 的 purpose（计数 = 摘要调用次数）
  streamInputs: string[][]; // 每次 llm.stream 的输入消息文本（摘要输入范围断言）
  measureCalls: number[]; // tokenMeter.measure 调用（入口压力 + 投影复测 + 落地 shadowedTokenCount）
  estimateCalls: number[]; // tokenMeter.estimateMessage 调用
  listeners: Record<string, (...args: unknown[]) => unknown>;
  warnLog: string[];
}

/** 构造 engine 测试 mock ctx（tokenMeter 读数按设计 §3.4/B56 口径注入） */
export function makeEngineCtx(session: Session, view: CaRichViewElm[], opts: EngineCtxOpts = {}): EngineCtxHarness {
  const summaries: (ScriptedStream | null)[] = (opts.summaries ?? [{ text: 'compact summary text' }]).map((s) =>
    typeof s === 'string' ? { text: s } : s,
  );
  const nodeTokens = opts.nodeTokens ?? 3000;
  const contextWindow = opts.contextWindow ?? 128000;
  const purposes: string[] = [];
  const streamInputs: string[][] = [];
  const measureCalls: number[] = [];
  const estimateCalls: number[] = [];
  const listeners: Record<string, (...args: unknown[]) => unknown> = {};
  const warnLog: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: Record<string, any> = {
    reflect: { provide: (name: string, svc: unknown) => { if (name === 'compaction') ctx.compaction = svc; } },
    get(name: string) { return ctx[name]; },
    llm: {
      async *stream(o: Record<string, unknown>): AsyncIterable<unknown> {
        purposes.push(String(o.purpose));
        // 捕获摘要输入消息文本（检查点再压缩「旧检查点作为新摘要输入一部分」断言载体）
        streamInputs.push(
          ((o.messages as Array<{ content?: { type?: string; text?: string }[] }>) ?? [])
            .map((m) => (m.content ?? []).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('')),
        );
        const next = summaries.shift();
        if (next === undefined || next === null) throw new Error('mock llm reject');
        if (next.reject) throw new Error('mock llm reject');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        if (next.text !== '') yield { type: 'text-delta', index: 0, text: next.text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: next.text } };
        const kind = next.finishKind ?? 'stop';
        if (kind === 'error') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'mock error' } } };
        } else {
          yield { type: 'finish', reason: { kind } };
        }
      },
      async resolveModelInfo() {
        if (opts.noContext) return { provider: 'p', id: 'm', name: 'm' };
        return { provider: 'p', id: 'm', name: 'm', context: { contextWindow } };
      },
    },
    tokenMeter: {
      measure(s: Session) {
        measureCalls.push(s.events.length);
        return {
          logRevision: s.events.length,
          baseline: { kind: 'none', tokens: 0 },
          surfaceDeltaTokens: 0,
          totalTokens: opts.totalTokens ?? 110000,
          surfaceTokens: opts.totalTokens ?? 110000,
          nodes: s.surface.nodes.map((seq) => ({ seq, tokens: nodeTokens })),
        };
      },
      estimateMessage(m: { content?: { type?: string; text?: string }[] }) {
        estimateCalls.push(1);
        const blocks = m?.content ?? [];
        return blocks.reduce((sum, b) => sum + (b?.text ? b.text.length : 0), 0);
      },
    },
    sessionProjections: {
      snapshot(s: Session) {
        return { asOfSeq: -1, values: { [VIEW_KEY]: opts.liveView ? foldView(s) : view } };
      },
    },
    sessions: { async flush() {} },
    on(name: string, fn: (...args: unknown[]) => unknown) {
      listeners[name] = fn;
    },
    logger() {
      return { info: () => {}, warn: (...a: unknown[]) => warnLog.push(a.map(String).join(' ')), error: () => {} };
    },
  };
  return { ctx, purposes, streamInputs, measureCalls, estimateCalls, listeners, warnLog };
}

/** 取会话全部 replace 落地事件 */
export function replaceEvents(session: Session): Array<{ seq: number; start: number; end: number }> {
  const out: Array<{ seq: number; start: number; end: number }> = [];
  for (const e of session.events) {
    if (e.type !== 'user/message') continue;
    const surfaceOp = (e as { surfaceOp?: unknown }).surfaceOp as { op?: string; start?: number; end?: number } | undefined;
    if (surfaceOp && surfaceOp.op === 'replace' && typeof surfaceOp.start === 'number' && typeof surfaceOp.end === 'number') {
      out.push({ seq: e.seq, start: surfaceOp.start, end: surfaceOp.end });
    }
  }
  return out;
}

/** 会话内 compaction 生命周期组（start→summary→end 按 compactionId 配对） */
export function compactionLifecycles(session: Session) {
  const starts = session.events.filter((e) => e.type === 'compaction/start');
  const summaries = session.events.filter((e) => e.type === 'compaction/summary');
  const ends = session.events.filter((e) => e.type === 'compaction/end');
  const groups = starts.map((s) => {
    const id = (s.data as { compactionId: string }).compactionId;
    const summary = summaries.find((x) => (x.data as { compactionId: string }).compactionId === id);
    const end = ends.find((x) => (x.data as { compactionId: string }).compactionId === id);
    return { start: s, summary: summary ?? null, end: end ?? null, compactionId: id };
  });
  return { starts, summaries, ends, groups };
}

/** 测试 agent（CompactionAgentContext 形状） */
export function makeAgent(session: Session, opts: { provider?: string; model?: string } = {}) {
  return { session, options: { provider: opts.provider ?? 'p', model: opts.model ?? 'm' } };
}

export { Session, SessionId, CompactionId };
