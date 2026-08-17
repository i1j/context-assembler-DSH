/**
 * 工具痕迹投影（lib/tool-trace.js）——7.1 P1：tool 信息搜集的第一落点。
 *
 * 设计意图（docs/CA-V7-7.1-tool信息搜集与处理设计.md §4.2）：
 *   DSH 的 tool/call 与 tool/result 是两个独立事件：tool/call 不进 surface，
 *   tool/result 进 surface；两者靠 callId 配对。本模块把每事务/每工具的轻量痕迹
 *   折叠为确定性投影（纯函数、可回放、JSON 可序列化），供：
 *     - 运行时 4B 回填 intent/outcome（7.1 P2）挂载；
 *     - wire 级工具结果替换（7.1 P4）读取 grade/keep 前的原始痕迹；
 *     - 离线 summarize-history 落库 ca_topics.db.turn_stream；
 *     - llm/stream 观测器（lib/llm-trace.js）按 callId 关联云端调用元数据。
 *
 * 边界与纪律：
 *   - 不回存 tool result 全文与原始 arguments（原文留在事件日志，零冗余）；
 *     只存摘要（argsSummary/resultSummary/hdl）、实体与错误元数据。
 *   - 行数硬上限 TOOL_TRACE_MAX_ROWS，超限淘汰最旧（投影状态持久化有界）。
 *   - 与 view.js 的投影正交：view 管"上下文长什么样"，tool-trace 管"工具发生了什么"。
 *   - 投影 fold 保持纯函数：同一事件流重放得到同一 state（DSH sessionProjections 契约）。
 */
import { z } from 'zod';
import { summarizeToolCall, summarizeToolPair } from './tool-summarizer.js';

/** 投影键 */
export const TOOL_TRACE_KEY = 'ca-v7/tool-trace';
/** 投影 stateVersion（字段/语义变化时 bump） */
export const TOOL_TRACE_STATE_VERSION = 2;
/** 单会话最大痕迹行数（超出淘汰最旧已完成行，先按 called 时间序） */
export const TOOL_TRACE_MAX_ROWS = 1024;

/** 痕迹行 zod schema（投影 view payload 校验；与 createToolTraceProjection 配套） */
const toolTraceRowSchema = z.object({
  rowId: z.number().int().positive(),
  callId: z.string(),
  turn: z.number().int().positive().nullable(),
  step: z.number().int().positive().nullable(),
  callSeq: z.number().int().nullable(),
  resultSeq: z.number().int().nullable(),
  callTime: z.number().nullable(),
  resultTime: z.number().nullable(),
  durationMs: z.number().nullable(),
  name: z.string(),
  description: z.string(),
  argsJson: z.string(),
  argsSummary: z.string(),
  resultSummary: z.string(),
  hdl: z.string(),
  error: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  isError: z.boolean(),
  resultChars: z.number().int(),
  entities: z.array(z.string()),
  highValueFacts: z.array(z.string()),
  status: z.enum(['called', 'completed']),
});
export const toolTraceSchema = z.array(toolTraceRowSchema);

/** 新建空痕迹行（tool/result 先于 tool/call 出现时的兜底，名称 unknown_tool） */
function newRow(state, callId, data) {
  return {
    rowId: state.nextRow,
    callId,
    turn: data?.turn ?? null,
    step: data?.step ?? null,
    callSeq: null,
    resultSeq: null,
    callTime: null,
    resultTime: null,
    durationMs: null,
    name: 'unknown_tool',
    description: '',
    argsJson: '{}',
    argsSummary: '',
    resultSummary: '',
    hdl: '',
    error: null,
    exitCode: null,
    isError: false,
    resultChars: 0,
    entities: [],
    highValueFacts: [],
    status: 'called',
  };
}

/** 实体并集（保序去重） */
function unionEntities(a, b) {
  const set = new Set(a ?? []);
  const out = [...(a ?? [])];
  for (const x of b ?? []) {
    if (!set.has(x)) {
      set.add(x);
      out.push(x);
    }
  }
  return out;
}

/** tool/result 嵌套文本总字符数（不含工具协议包装） */
function resultTextChars(data) {
  let n = 0;
  for (const block of data?.message?.content ?? []) {
    if (block?.type !== 'tool-result') continue;
    for (const c of block.content ?? []) {
      if (c?.type === 'text' && typeof c.text === 'string') n += c.text.length;
    }
  }
  return n;
}

/**
 * 工具参数压缩 JSON：保留摘要规则所需字段（command/file_path/path/pattern/query/uri…），
 * 单字符串值截断到 1024 字符、数组元素递归压缩（元素级截断）、数组上限 8；原文仍在事件日志。解析失败/非对象 → '{}'。
 */
function compactArgsValue(value) {
  if (typeof value === 'string') return value.length > 1024 ? value.slice(0, 1021) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(compactArgsValue);
  if (typeof value === 'object') return { truncated: true };
  return value;
}

function compactArgsJson(raw) {
  if (typeof raw !== 'string') return '{}';
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return '{}';
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '{}';
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = compactArgsValue(v);
  try {
    return JSON.stringify(out);
  } catch {
    return '{}';
  }
}

/** 从 tool/result 事件提取 callId（source.callId 优先，兜底 tool-result.toolCallId） */
function callIdFromResult(data) {
  const src = data?.message?.source;
  if (typeof src?.callId === 'string' && src.callId) return src.callId;
  const block = (data?.message?.content ?? []).find((b) => b?.type === 'tool-result');
  return typeof block?.toolCallId === 'string' && block.toolCallId ? block.toolCallId : null;
}

/** 克隆痕迹行（旧 state 不被后续写入污染——纯 fold 不共享可变行） */
function cloneRow(row) {
  return { ...row, entities: [...(row.entities ?? [])], highValueFacts: [...(row.highValueFacts ?? [])] };
}

/** tool/call：创建或补齐痕迹行（同一 callId 多次调用以首次为准，不重复计数） */
function applyToolCall(state, event) {
  const data = event?.data ?? {};
  const callId = typeof data.callId === 'string' && data.callId ? data.callId : null;
  if (!callId) return state;
  const existing = Object.hasOwn(state.byCallId, callId) ? state.byCallId[callId] : undefined;
  const summary = summarizeToolCall(data);
  const row = existing ? cloneRow(existing) : newRow(state, callId, data);
  row.name = data.name ?? row.name;
  row.turn = data.turn ?? row.turn;
  row.step = data.step ?? row.step;
  row.callSeq = event.seq ?? row.callSeq;
  row.callTime = event.time ?? row.callTime;
  row.description = typeof data.description === 'string' ? data.description : row.description;
  row.argsJson = compactArgsJson(data.arguments);
  row.argsSummary = summary.text ?? row.argsSummary;
  row.entities = unionEntities(row.entities, summary.entities);
  if (existing) {
    return { ...state, byCallId: { ...state.byCallId, [callId]: row } };
  }
  const byCallId = { ...state.byCallId, [callId]: row };
  return prune({ ...state, nextRow: state.nextRow + 1, byCallId, order: [...state.order, callId] });
}

/** tool/result：配对完成结构化摘要（复用 7.0 已移植的 Hermes per-tool Fct/Hdl 规则） */
function applyToolResult(state, event) {
  const callId = callIdFromResult(event.data);
  if (!callId) return state;
  const existing = Object.hasOwn(state.byCallId, callId) ? state.byCallId[callId] : undefined;
  // 满员时不再复活已淘汰 callId：否则会以 unknown_tool 新行挤掉更近期的行（有界投影失效）
  if (!existing && state.order.length >= TOOL_TRACE_MAX_ROWS) return state;
  const meta = {
    name: existing?.name ?? 'unknown_tool',
    arguments: existing?.argsJson ?? '{}',
    callId,
    turn: existing?.turn ?? event.data?.turn ?? null,
    step: existing?.step ?? event.data?.step ?? null,
  };
  const pair = summarizeToolPair(meta, event.data ?? {});
  const row = existing ? cloneRow(existing) : newRow(state, callId, event.data);
  row.turn = meta.turn ?? row.turn;
  row.step = meta.step ?? row.step;
  row.resultSeq = event.seq ?? row.resultSeq;
  row.resultTime = event.time ?? row.resultTime;
  row.durationMs =
    row.callTime !== null && row.resultTime !== null ? Math.max(0, row.resultTime - row.callTime) : null;
  row.name = pair.name;
  row.resultSummary = pair.resultSummary;
  row.hdl = pair.hdl;
  row.error = pair.error;
  row.exitCode = pair.exitCode;
  row.isError = pair.isError;
  row.resultChars = resultTextChars(event.data);
  row.entities = unionEntities(row.entities, pair.entities);
  row.highValueFacts = [...(pair.highValueFacts ?? [])];
  row.status = 'completed';
  if (existing) {
    return { ...state, byCallId: { ...state.byCallId, [callId]: row } };
  }
  const byCallId = { ...state.byCallId, [callId]: row };
  return prune({ ...state, nextRow: state.nextRow + 1, byCallId, order: [...state.order, callId] });
}

/** 行数上限淘汰：按 order 最旧优先，直至回到上限内 */
function prune(state) {
  if (state.order.length <= TOOL_TRACE_MAX_ROWS) return state;
  const drop = state.order.slice(0, state.order.length - TOOL_TRACE_MAX_ROWS);
  const byCallId = { ...state.byCallId };
  for (const callId of drop) delete byCallId[callId];
  return { ...state, byCallId, order: state.order.slice(drop.length) };
}

/** fold 初始状态（空日志） */
export function initToolTraceState() {
  return { nextRow: 1, byCallId: {}, order: [] };
}

/**
 * fold 纯函数 apply：前态 + 一个已提交事件 → 后态。
 * 无关事件返回同一引用（零下游工作契约，对齐 view.js）。
 * @param {ReturnType<typeof initToolTraceState>} state
 * @param {import('@deepseek-ai/dsh-session').SessionEvent} event
 */
export function applyToolTraceState(state, event) {
  switch (event?.type) {
    case 'tool/call':
      return applyToolCall(state, event);
    case 'tool/result':
      return applyToolResult(state, event);
    default:
      return state;
  }
}

/** 由 fold 状态构建痕迹行列表（rowId 升序，即首次观察到 callId 的顺序） */
export function viewToolTraceState(state) {
  return [...(state?.order ?? [])]
    .map((callId) => {
      const row = Object.hasOwn(state.byCallId, callId) ? state.byCallId[callId] : undefined;
      return row ? { ...row, entities: [...row.entities], highValueFacts: [...(row.highValueFacts ?? [])] } : null;
    })
    .filter((row) => row !== null)
    .sort((a, b) => a.rowId - b.rowId);
}

/** 注册用 ProjectionDefinition（key/schema/init/apply/view/stateVersion） */
export function createToolTraceProjection() {
  return {
    key: TOOL_TRACE_KEY,
    schema: toolTraceSchema,
    init: initToolTraceState,
    apply: applyToolTraceState,
    view: viewToolTraceState,
    stateVersion: TOOL_TRACE_STATE_VERSION,
  };
}

/** 会话级 debug 导出缓存（index.js 经 sessionProjections.onChanged 填充）；FIFO 上限防长跑进程无界增长 */
const toolTraceBySession = new Map();
const TOOL_TRACE_CACHE_MAX = 256;

/**
 * 写入某会话的痕迹视图缓存。
 * @param {string} sessionId
 * @param {any[]} rows
 */
export function setToolTrace(sessionId, rows) {
  toolTraceBySession.set(sessionId, rows);
  if (toolTraceBySession.size > TOOL_TRACE_CACHE_MAX) {
    toolTraceBySession.delete(toolTraceBySession.keys().next().value);
  }
}

/** 清空缓存（测试隔离辅助） */
export function clearToolTraceCache() {
  toolTraceBySession.clear();
}

/**
 * debug 导出：返回该会话的工具痕迹行列表。
 * @param {string} sessionId
 */
export function exportToolTrace(sessionId) {
  return toolTraceBySession.get(sessionId) ?? [];
}
