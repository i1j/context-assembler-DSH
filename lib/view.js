/**
 * 会话事务视图（lib/view.js）——sessionProjections 纯函数 fold（C3 定稿主路径）。
 *
 * 视图派生 = 纯同步 fold（init/apply/view，state 为 plain JSON，持久化缓存前置条件）；
 * 无自建事件订阅（B25：订阅归 ctx.sessionProjections 框架）。
 *
 * 事务规则（R-Elm1）：
 *   - 真实 user/message（source.kind='user'）→ 开新事务（transaction_id 会话内 +1，隐式闭合上一开放事务）
 *   - 注入消息/压缩检查点（source.kind='plugin'）→ 归当前事务；无当前事务（turn 间空闲期压缩）→ 归最近已闭合事务；
 *     会话起始 → 归首个后续事务（pendingPlugins 挂起）
 *   - 无 user/message 的 turn（拒绝/空输入/synthetic）不开启事务
 *   - turn/end 闭合；step/start/step/end 维护 turn 内 step 序号
 *   - assistant/chunk 不派生 Elm（时序参考）
 *   - 遮蔽范围（B38）：仅压缩替换事件（compaction/summary shadowedSeqs + 检查点 replace 区间）计入；
 *     显式排除 toolResultPruner 的 compaction/prune
 *   - 承载状态（B3/F18）：compaction/summary caCarrierDetail.carriedTxnIds → carried；缺省 unloaded（保守）
 *
 * 导出：projection view(state) 返回 rich Elm 列表（8 契约字段 + text 内部扩展，供 grade/inject 纯函数
 * 确定性拼装）；exportView(sessionId) debug 导出剥离 text，恰为 8 字段（R2/R-Elm3 字段全集）。
 */
import { z } from 'zod';
import { mapOodaStage } from './ooda.js';
import { gradeTransactions } from './grade.js';
import { summarizeToolCall, summarizeToolPair } from './tool-summarizer.js';

/** 投影键 */
export const VIEW_KEY = 'ca-v7/view';
/** 投影 stateVersion（序列化字段/语义变化时 bump） */
export const VIEW_STATE_VERSION = 2; // v2：toolCall/toolResult Elm 承载结构化摘要文本（Hermes per-tool Fct/Hdl 移植）

/** debug 导出缓存：sessionId → rich Elm 列表（index.js 经 sessionProjections.onChanged 填充）；FIFO 上限防长跑进程无界增长 */
const sessionViews = new Map();
const SESSION_VIEW_CACHE_MAX = 256;

/**
 * 写入某会话的 rich 视图缓存（debug 导出数据源；由 index.js 的投影 change feed 驱动）。
 * @param {string} sessionId
 * @param {any[]} elms
 */
export function setSessionView(sessionId, elms) {
  sessionViews.set(sessionId, elms);
  if (sessionViews.size > SESSION_VIEW_CACHE_MAX) {
    sessionViews.delete(sessionViews.keys().next().value);
  }
}

/** 清空缓存（测试隔离辅助） */
export function clearSessionViews() {
  sessionViews.clear();
}

/**
 * debug 导出：返回 8 字段 CaViewElm（type/transaction_id/elm_ref/ooda_stage/text_ref/grade/carrierState/visibility）。
 * @param {string} sessionId
 * @returns {any[]}
 */
export function exportView(sessionId) {
  const elms = sessionViews.get(sessionId) ?? [];
  return elms.map((e) => ({
    type: e.type,
    transaction_id: e.transaction_id,
    elm_ref: e.elm_ref,
    ooda_stage: e.ooda_stage,
    text_ref: e.text_ref,
    grade: e.grade,
    carrierState: e.carrierState,
    visibility: e.visibility,
  }));
}

/** 视图 Elm zod schema（投影 wire payload 校验；rich 形态 = 8 契约字段 + text） */
const oodaStageSchema = z.union([
  z.literal('orient'),
  z.literal('decide'),
  z.literal('act'),
  z.literal('observe'),
  z.null(),
]);
const elmSchema = z.object({
  type: z.enum(['user', 'thought', 'fin', 'toolCall', 'toolResult', 'synthetic']),
  transaction_id: z.number().int(),
  elm_ref: z.number().int(),
  ooda_stage: oodaStageSchema,
  text_ref: z.number().int(),
  text: z.string(),
  grade: z.enum(['ACT', 'REL', 'FAR']).optional(),
  carrierState: z.enum(['unloaded', 'carried']).optional(),
  visibility: z.enum(['visible', 'shadowed']).optional(),
});
export const viewSchema = z.array(elmSchema);

/** fold 初始状态（空日志） */
export function initViewState() {
  return {
    nextTxnId: 1,
    openTurn: null,
    openTurnStep: 0,
    openTxn: null, // { id, turn, elms }
    txns: [], // 已闭合事务（保序）
    lastClosedTxnId: null,
    pendingPlugins: [], // 会话起始 plugin 消息（等待首个后续事务）
    shadowedSeqs: [], // 累计遮蔽表层 seq（B38 限定来源）
    carriedTxnIds: [], // 累计摘要承载事务 ID（caCarrierDetail）
    toolCalls: {}, // callId → { name, args }（tool/result 摘要配对用；JSON 可序列化）
  };
}

/** 提取消息文本（text/reasoning 块拼接；user 用 data.content，assistant/tool 用 data.message.content） */
function extractText(data) {
  const msg = data?.message ?? data;
  const blocks = msg?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && (b.type === 'text' || b.type === 'reasoning'))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('');
}

/** 仅提取 reasoning 块（thought 用——思考栏应只显示思考，不混入最终回复 text；2026-08-18） */
function extractReasoning(data) {
  const msg = data?.message ?? data;
  const blocks = msg?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/** 数组并集（保序去重） */
function union(a, b) {
  const set = new Set(a);
  const out = [...a];
  for (const x of b) {
    if (!set.has(x)) {
      set.add(x);
      out.push(x);
    }
  }
  return out;
}

/** 闭合事务：末条 thought 标记为 fin（事务尾最终回复），与 turn/end 的闭合语义共用。
 *  fin 文本取回合最终回复（finalText，含回答 text）；无则回退末条 thought（纯 reasoning）。 */
function closeTxn(openTxn) {
  const elms = [...openTxn.elms];
  const finalText = typeof openTxn.finalText === 'string' && openTxn.finalText.trim() !== ''
    ? openTxn.finalText
    : null;
  for (let i = elms.length - 1; i >= 0; i -= 1) {
    if (elms[i].type === 'thought') {
      elms[i] = finalText !== null
        ? { ...elms[i], type: 'fin', text: finalText }
        : { ...elms[i], type: 'fin' };
      break;
    }
  }
  return { ...openTxn, elms };
}

/** 真实 user/message：开新事务（隐式闭合上一开放事务），挂起 plugin 消息归首个后续事务 */
function applyRealUser(state, event) {
  let txns = state.txns;
  let lastClosedTxnId = state.lastClosedTxnId;
  let openTxn = state.openTxn;
  if (openTxn) {
    txns = [...txns, closeTxn(openTxn)]; // 隐式闭合同样标记 fin：注入侧依赖末轮最终回复
    lastClosedTxnId = openTxn.id;
    openTxn = null;
  }
  const id = state.nextTxnId;
  const attached = state.pendingPlugins.map((e) => ({ ...e, transaction_id: id }));
  const elm = {
    type: 'user',
    transaction_id: id,
    elm_ref: event.seq,
    ooda_stage: mapOodaStage(event),
    text_ref: event.seq,
    text: extractText(event.data),
  };
  return {
    ...state,
    nextTxnId: id + 1,
    txns,
    lastClosedTxnId,
    openTxn: { id, turn: state.openTurn, elms: [...attached, elm], finalText: '' },
    pendingPlugins: [],
  };
}

/** plugin user/message（注入/检查点）：归当前事务 / 最近已闭合 / 首个后续事务（挂起） */
function applyPluginUser(state, event) {
  const elm = {
    type: 'synthetic',
    transaction_id: null,
    elm_ref: event.seq,
    ooda_stage: mapOodaStage(event), // null（A25 不打标）
    text_ref: event.seq,
    text: extractText(event.data),
  };
  // B38：检查点 replace 区间计入遮蔽范围
  const replaceSeqs = event.surfaceOp?.op === 'replace' ? event.sourceEventSeqs ?? [] : [];
  const base = {
    ...state,
    shadowedSeqs: replaceSeqs.length > 0 ? union(state.shadowedSeqs, replaceSeqs) : state.shadowedSeqs,
  };
  if (base.openTxn) {
    return {
      ...base,
      openTxn: { ...base.openTxn, elms: [...base.openTxn.elms, { ...elm, transaction_id: base.openTxn.id }] },
    };
  }
  if (base.lastClosedTxnId !== null) {
    const txns = base.txns.map((t) =>
      t.id === base.lastClosedTxnId ? { ...t, elms: [...t.elms, { ...elm, transaction_id: t.id }] } : t,
    );
    return { ...base, txns };
  }
  return { ...base, pendingPlugins: [...base.pendingPlugins, elm] };
}

/** assistant/message：decide（无 tool_calls）或 act（含 tool_calls）；synthetic turn 无事务则丢弃；
 *  空 content（仅承载 usage 等元数据）不派生 Elm——与 DSH deriveEventMessage 返回 null 的契约一致 */
function applyAssistant(state, event) {
  if (!state.openTxn) return state;
  const blocks = event.data?.message?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return state;
  const elm = {
    type: blocks.some((b) => b?.type === 'tool-call') ? 'toolCall' : 'thought',
    transaction_id: state.openTxn.id,
    elm_ref: event.seq,
    ooda_stage: mapOodaStage(event),
    text_ref: event.seq,
    // thought 只取 reasoning（思考栏纯思考，不混入最终回复 text）；finalText 保留完整
    // 消息文本（含回答）供回合 fin/标题用（2026-08-18）
    text: extractReasoning(event.data),
  };
  const finalText = extractText(event.data);
  return {
    ...state,
    openTxn: {
      ...state.openTxn,
      finalText: finalText.trim() !== '' ? finalText : state.openTxn.finalText ?? '',
      elms: [...state.openTxn.elms, elm],
    },
  };
}

/** tool/call：act；同时把 callId→{name,arguments} 存入投影状态供 tool/result 配对 */
function applyToolCall(state, event) {
  if (!state.openTxn) return state;
  const summary = summarizeToolCall(event.data ?? {});
  const elm = {
    type: 'toolCall',
    transaction_id: state.openTxn.id,
    elm_ref: event.seq,
    ooda_stage: 'act',
    text_ref: event.seq,
    text: summary.text, // 工具意图/关键参数摘要（Hermes per-tool Fct/Hdl 的 DSH 移植）
  };
  const callId = event.data?.callId;
  const toolCalls = callId
    ? { ...state.toolCalls, [callId]: { name: summary.name, arguments: event.data?.arguments ?? '{}' } }
    : state.toolCalls;
  return { ...state, toolCalls, openTxn: { ...state.openTxn, elms: [...state.openTxn.elms, elm] } };
}

/** tool/result：observe；用配对 tool/call 元数据生成结构化结果摘要 */
function applyToolResult(state, event) {
  if (!state.openTxn) return state;
  const callId = event.data?.message?.source?.callId;
  const meta = (callId && state.toolCalls[callId]) || { name: 'unknown_tool', arguments: '{}' };
  const pair = summarizeToolPair(
    { ...meta, callId, turn: event.data?.turn, step: event.data?.step },
    event.data ?? {},
  );
  const elm = {
    type: 'toolResult',
    transaction_id: state.openTxn.id,
    elm_ref: event.seq,
    ooda_stage: 'observe',
    text_ref: event.seq,
    text: pair.resultSummary, // L1 结构化结果摘要，原始全文仍留在事件日志可回查
  };
  return { ...state, openTxn: { ...state.openTxn, elms: [...state.openTxn.elms, elm] } };
}

/** compaction/summary：累计遮蔽 seq + 承载事务（B3/B38；compaction/prune 显式排除——default 分支不处理） */
function applySummary(state, event) {
  const shadowed = event.data?.shadowedSeqs ?? [];
  const carried = event.data?.caCarrierDetail?.carriedTxnIds ?? [];
  if (shadowed.length === 0 && carried.length === 0) return state;
  return {
    ...state,
    shadowedSeqs: shadowed.length > 0 ? union(state.shadowedSeqs, shadowed) : state.shadowedSeqs,
    carriedTxnIds: carried.length > 0 ? union(state.carriedTxnIds, carried) : state.carriedTxnIds,
  };
}

/** turn/end：末位 thought 标记 fin（事务尾最终回复），闭合事务 */
function applyTurnEnd(state, event) {
  const s = { ...state };
  if (s.openTxn) {
    const closed = closeTxn(s.openTxn);
    s.txns = [...s.txns, closed];
    s.lastClosedTxnId = closed.id;
    s.openTxn = null;
  }
  s.openTurn = null;
  s.openTurnStep = 0;
  return s;
}

/**
 * fold 纯函数 apply：前态 + 一个已提交事件 → 后态。
 * 无关事件返回同一引用（零下游工作契约）。
 */
export function applyViewState(state, event) {
  switch (event?.type) {
    case 'turn/start':
      return { ...state, openTurn: event.data.turn, openTurnStep: 0 };
    case 'step/start':
      if (state.openTurn !== event.data.turn) return state;
      return { ...state, openTurnStep: event.data.step };
    case 'user/message': {
      const source = event.data?.source;
      return source?.kind === 'user' ? applyRealUser(state, event) : applyPluginUser(state, event);
    }
    case 'assistant/message':
      return applyAssistant(state, event);
    case 'tool/call':
      return applyToolCall(state, event);
    case 'tool/result':
      return applyToolResult(state, event);
    case 'compaction/summary':
      return applySummary(state, event);
    case 'turn/end':
      return applyTurnEnd(state, event);
    default:
      return state; // step/end、assistant/chunk、compaction/prune、request/*、todo/* 等不派生/不计入
  }
}

/** 由 fold 状态构建 rich Elm 列表（含派生态 grade/carrierState/visibility 与内部 text） */
export function viewViewState(state) {
  const all = [
    ...state.txns.flatMap((t) => t.elms),
    ...(state.openTxn ? state.openTxn.elms : []),
  ];
  const grades = gradeTransactions(all);
  const shadowed = new Set(state.shadowedSeqs);
  const carried = new Set(state.carriedTxnIds);
  return all.map((e) => ({
    type: e.type,
    transaction_id: e.transaction_id,
    elm_ref: e.elm_ref,
    ooda_stage: e.ooda_stage,
    text_ref: e.text_ref,
    text: e.text,
    grade: grades.get(e.transaction_id),
    carrierState: carried.has(e.transaction_id) ? 'carried' : 'unloaded',
    visibility: shadowed.has(e.elm_ref) ? 'shadowed' : 'visible',
  }));
}

/** 注册用 ProjectionDefinition（key/schema/init/apply/view/stateVersion） */
export function createViewProjection() {
  return {
    key: VIEW_KEY,
    schema: viewSchema,
    init: initViewState,
    apply: applyViewState,
    view: viewViewState,
    stateVersion: VIEW_STATE_VERSION,
  };
}
