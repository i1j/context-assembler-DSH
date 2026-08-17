/**
 * lib/think-collect.js — 7.2 K0 思考卡离线采集（纯函数、零依赖、零 IO、零 LLM）。
 *
 * 离线回放时把 assistant/message 里的 reasoning 块按确定性规则提炼成
 * raw 级思考卡：DB 不存 reasoning 原文，只存 raw_len 指针；preview 仅存在于
 * DATA_JSON 缓存供报告展示，不入库。
 */
export const THINK_MIN_REASONING_CHARS = 800;
export const THINK_PREVIEW_CHARS = 160;
export const THINK_TOOL_NAME_MAX = 5;
export const THINK_CORRECTION_RE = /(修正|纠正|更正|推翻|误解|误判|不对|错误诊断|失败原因|根因|修复|fixed|incorrect|wrong|root cause|fix)/i;
export const THINK_SOURCE_KIND = 'cloud_think';
export const THINK_STATUS_RAW = 'raw';
/** 决策 44 增补：事务（turn）内首段 think 且无 tool_calls → 零门槛 orient 卡（事务划分线索）。 */
export const THINK_CARD_KIND_ORIENT = 'orient';

/**
 * 解析 assistant/message 的 data.message（或 {content:[...]} 形态对象）。
 * @param {any} message
 * @returns {{reasoningText: string, rawLen: number, toolCalls: Array<{id: string, name: string, arguments: string}>}}
 * - content 非数组 → 全空返回；
 * - reasoning 块：b.text 为 string 时追加；多块顺序拼接；
 * - tool-call 块：{id: b.id ?? '', name: b.name ?? '', arguments: b.arguments ?? '{}'}；
 * - rawLen = reasoningText.length（JS 字符长度）。
 */
export function parseAssistantMessage(message) {
  if (!message || !Array.isArray(message.content)) {
    return { reasoningText: '', rawLen: 0, toolCalls: [] };
  }
  let reasoningText = '';
  const toolCalls = [];
  for (const b of message.content) {
    if (!b) continue;
    if (b.type === 'reasoning' && typeof b.text === 'string') {
      reasoningText += b.text;
    } else if (b.type === 'tool-call') {
      toolCalls.push({
        id: b.id ?? '',
        name: b.name ?? '',
        arguments: b.arguments ?? '{}',
      });
    }
  }
  return { reasoningText, rawLen: reasoningText.length, toolCalls };
}

/**
 * 同 turn 工具错误信号：toolRows 中任一 turn 严格相等（null 不匹配）且
 * (error 非空字符串 || isError === true || (exitCode !== null && exitCode !== undefined && exitCode !== 0))。
 * @param {Array<any>} toolRows   // viewToolTraceState 行（camelCase：turn/error/isError/exitCode）
 * @param {number|null} turn
 * @returns {boolean}
 */
export function hasToolErrorSignal(toolRows, turn) {
  if (turn === null || turn === undefined) return false;
  for (const row of toolRows ?? []) {
    if (!row || row.turn !== turn) continue;
    if (typeof row.error === 'string' && row.error.length > 0) return true;
    if (row.isError === true) return true;
    if (row.exitCode !== null && row.exitCode !== undefined && row.exitCode !== 0) return true;
  }
  return false;
}

/** reasoning 修正信号（词表见 THINK_CORRECTION_RE）。入参非 string → false。 */
export function hasCorrectionSignal(text) {
  if (typeof text !== 'string') return false;
  return THINK_CORRECTION_RE.test(text);
}

/**
 * 由 rich view elms + toolRows 构建 think 上下文。
 * @param {Array<any>} viewElms   // viewViewState 输出（type/transaction_id/elm_ref/text）
 * @param {Array<any>} toolRows   // viewToolTraceState 输出
 * @returns {{
 *   seqToTxn: Map<number, number>,            // elm_ref → transaction_id（首个优先）
 *   finSeqByTxn: Map<number, number>,         // transaction_id → fin elm_ref（末个优先）
 *   userTextByTxn: Map<number, string>,       // transaction_id → user Elm text（首个优先）
 *   toolRowsByTurn: Map<number, Array<any>>,  // turn → 工具行组（turn 为 null 跳过）
 * }}
 */
export function buildThinkCtx(viewElms, toolRows) {
  const seqToTxn = new Map();
  const finSeqByTxn = new Map();
  const userTextByTxn = new Map();
  const toolRowsByTurn = new Map();
  for (const e of viewElms ?? []) {
    if (!e) continue;
    const tid = e.transaction_id;
    const ref = e.elm_ref;
    if (tid === undefined || ref === undefined) continue;
    if (!seqToTxn.has(ref)) seqToTxn.set(ref, tid);
    if (e.type === 'user' && !userTextByTxn.has(tid)) userTextByTxn.set(tid, e.text ?? '');
    if (e.type === 'fin') finSeqByTxn.set(tid, ref);
  }
  for (const row of toolRows ?? []) {
    if (!row || row.turn === null || row.turn === undefined) continue;
    const list = toolRowsByTurn.get(row.turn) ?? [];
    list.push(row);
    toolRowsByTurn.set(row.turn, list);
  }
  return { seqToTxn, finSeqByTxn, userTextByTxn, toolRowsByTurn };
}

/**
 * 单个 assistant/message 事件 → 思考卡行（camelCase）或 null。
 * @param {any} event
 * @param {{sessionId: string, seqToTxn: Map, finSeqByTxn: Map, userTextByTxn: Map, toolRowsByTurn: Map, firstThinkSeqByTurn?: Map}} ctx
 * @returns {object|null}
 * 规则（顺序判定，对齐 Hermes 决策 44 门槛序 decision > conclusion > orient）：
 *  1) event.type !== 'assistant/message' → null；
 *  2) rawLen === 0 → null（无 reasoning 不入卡）；
 *  3) toolCalls.length > 0 → cardKind='decision'；
 *  4) 否则 txnId !== null 且 finSeqByTxn.get(txnId) === event.seq 且
 *     (rawLen >= 800 || hasToolErrorSignal(toolRowsByTurn.get(turn)) || hasCorrectionSignal(reasoningText))
 *     → cardKind='conclusion'；
 *  5) 否则该事件是 turn 内首段 think（firstThinkSeqByTurn.get(turn) === event.seq）→ cardKind='orient'（零门槛）；
 *  6) 其余 → null（非首段 thought / 短 fin 无信号）。
 * 行字段：
 *  { sessionId: ctx.sessionId, turn, step, seq: event.seq, txnId,
 *    topicId: null, sourceKind: 'cloud_think', cardKind,
 *    callId: toolCalls[0]?.id ?? null,
 *    toolName: 唯一工具名（保序、过滤空、截断前 5）逗号连接（无工具 → ''）,
 *    questionText: txnId 非 null ? (userTextByTxn.get(txnId) ?? '') : '',
 *    l0Abstract: null, l1Json: null, entitiesJson: null, embeddingJson: null,
 *    rawLen, status: 'raw',
 *    preview: reasoningText.slice(0, THINK_PREVIEW_CHARS) }
 */
export function thinkCardFromEvent(event, ctx) {
  if (!event || event.type !== 'assistant/message') return null;
  if (event.seq === undefined || event.seq === null) return null;
  const msg = event.data?.message ?? {};
  const { reasoningText, rawLen, toolCalls } = parseAssistantMessage(msg);
  if (rawLen === 0) return null;
  const turn = event.data?.turn ?? null;
  const step = event.data?.step ?? null;
  const txnId = ctx.seqToTxn?.get(event.seq) ?? null;
  let cardKind = null;
  if (toolCalls.length > 0) {
    cardKind = 'decision';
  } else if (txnId !== null && ctx.finSeqByTxn?.get(txnId) === event.seq) {
    const toolRows = ctx.toolRowsByTurn?.get(turn) ?? [];
    const isConclusion =
      rawLen >= THINK_MIN_REASONING_CHARS ||
      hasToolErrorSignal(toolRows, turn) ||
      hasCorrectionSignal(reasoningText);
    if (isConclusion) cardKind = 'conclusion';
  }
  if (cardKind === null && ctx.firstThinkSeqByTurn?.get(turn) === event.seq) {
    // 决策 44：事务（turn）内首段 think 且无 tool_calls → orient 卡（零门槛，宁多勿少）。
    cardKind = THINK_CARD_KIND_ORIENT;
  }
  if (cardKind === null) return null;
  const names = [];
  for (const tc of toolCalls) {
    if (tc.name) names.push(tc.name);
  }
  const toolName = [...new Set(names)].slice(0, THINK_TOOL_NAME_MAX).join(',');
  return {
    sessionId: ctx.sessionId,
    turn,
    step,
    seq: event.seq,
    txnId,
    topicId: null,
    sourceKind: THINK_SOURCE_KIND,
    cardKind,
    callId: toolCalls[0]?.id ?? null,
    toolName,
    questionText: txnId !== null ? (ctx.userTextByTxn?.get(txnId) ?? '') : '',
    l0Abstract: null,
    l1Json: null,
    entitiesJson: null,
    embeddingJson: null,
    rawLen,
    status: THINK_STATUS_RAW,
    preview: reasoningText.slice(0, THINK_PREVIEW_CHARS),
  };
}

/**
 * 事件流 + 视图/工具痕迹 → 思考卡行数组（保事件顺序，过滤 null）。
 * ctx = { ...buildThinkCtx(viewElms, toolRows), sessionId }。
 * 预计算 firstThinkSeqByTurn（turn → 首个有 reasoning 的 assistant/message seq），
 * 供 orient 卡判定（决策 44：事务内首段 think 且无 tool_calls → 零门槛入卡）。
 */
export function collectThinkRows(events, viewElms, toolRows, sessionId) {
  const ctx = {
    sessionId,
    ...buildThinkCtx(viewElms ?? [], toolRows ?? []),
  };
  const firstThinkSeqByTurn = new Map();
  for (const ev of events ?? []) {
    if (!ev || ev.type !== 'assistant/message') continue;
    const turn = ev.data?.turn;
    if (turn === null || turn === undefined) continue;
    const { rawLen } = parseAssistantMessage(ev.data?.message ?? {});
    if (rawLen === 0) continue;
    if (!firstThinkSeqByTurn.has(turn)) firstThinkSeqByTurn.set(turn, ev.seq);
  }
  ctx.firstThinkSeqByTurn = firstThinkSeqByTurn;
  return (events ?? [])
    .map((ev) => thinkCardFromEvent(ev, ctx))
    .filter(Boolean);
}
