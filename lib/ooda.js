/**
 * OODA 确定性映射常量表（lib/ooda.js）
 *
 * 权威锚点：需求规格 §2 R-Elm2「OODA 映射规则表」8 行映射（逐行核对实现，变更走评审）。
 * 实现注记：本表为指针引用 + 实现注记，不物理复制需求正文；行序与权威表一致。
 * 确定性规则（禁止 LLM 路径含 HTTP）；未知事件类型显式默认 observe + 日志回退。
 *
 * 8 行映射（与权威表逐行一致）：
 *   1. user/message（source.kind='user'）            → orient
 *   2. assistant/message（含 reasoning、无 tool_calls）→ decide
 *   3. assistant/message（含 tool_calls）            → act
 *   4. tool/call                                    → act
 *   5. tool/result                                  → observe
 *   6. assistant/message（fin、无 tool_calls）        → decide
 *   7. synthetic user/message（source.kind='plugin'） → null（不打标，A25）
 *   8. 未知/未覆盖事件类型                            → observe（默认）+ 日志回退
 */

/** 事件是否携带 tool_calls（assistant/message 内容块含 tool-call） */
function hasToolCalls(event) {
  const blocks = event?.data?.message?.content;
  return Array.isArray(blocks) && blocks.some((block) => block?.type === 'tool-call');
}

/** assistant/message 且无 tool_calls（含 reasoning / fin 两类，均 decide；fin 由视图在事务尾标记） */
function isPlainAssistant(event) {
  return event?.type === 'assistant/message' && !hasToolCalls(event);
}

/**
 * OODA_RULES 常量表——与需求 §2 R-Elm2 权威表逐行核对（8 行）。
 * 规则按序匹配：eventType 命中且 condition（若有）通过即取该 stage。
 * 行 2 与行 6 同为「无 tool_calls → decide」，行 6 为权威表 fin 行的忠实占位
 * （阶段由事件类型决定、与事务内位置无关——design §3.2「阶段由事件类型决定，与循环次数无关」）。
 */
export const OODA_RULES = [
  { eventType: 'user/message', condition: (e) => e?.data?.source?.kind === 'user', stage: 'orient' },
  { eventType: 'assistant/message', condition: (e) => isPlainAssistant(e), stage: 'decide' },
  { eventType: 'assistant/message', condition: (e) => hasToolCalls(e), stage: 'act' },
  { eventType: 'tool/call', stage: 'act' },
  { eventType: 'tool/result', stage: 'observe' },
  { eventType: 'assistant/message', condition: (e) => isPlainAssistant(e), stage: 'decide' },
  { eventType: 'user/message', condition: (e) => e?.data?.source?.kind === 'plugin', stage: null },
  { eventType: '*', stage: 'observe' },
];

/**
 * 按 OODA_RULES 将单个事件映射为 ooda_stage；未知/未覆盖事件类型
 * 显式默认 observe（非 null）+ 日志回退记录（不静默缺失）。
 * @param {import('@deepseek-ai/dsh-session').SessionEvent} event 会话事件
 * @param {{ warn?: (msg: string) => void }} [logger] 可选日志器（缺省静默）
 * @returns {'orient'|'decide'|'act'|'observe'|null}
 */
export function mapOodaStage(event, logger) {
  for (const rule of OODA_RULES) {
    if (rule.eventType !== '*' && rule.eventType !== event?.type) continue;
    if (typeof rule.condition === 'function' && !rule.condition(event)) continue;
    // '*' 兜底即未知事件类型处理器：显式默认 observe + 日志回退记录（R-Elm2：不静默缺失）
    if (rule.eventType === '*') {
      if (typeof logger?.warn === 'function') {
        logger.warn(`ca-v7/ooda: 未知事件类型 "${event?.type ?? '(missing)'}" 映射回退为 observe（默认阶段）`);
      }
    }
    return rule.stage;
  }
  // 理论不可达（* 兜底），防御保留
  const stage = 'observe';
  if (typeof logger?.warn === 'function') {
    logger.warn(`ca-v7/ooda: 未知事件类型 "${event?.type ?? '(missing)'}" 映射回退为 observe（默认阶段）`);
  }
  return stage;
}
