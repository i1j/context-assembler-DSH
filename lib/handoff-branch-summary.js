/**
 * 7.3 handoff 分支摘要（lib/handoff-branch-summary.js）——设计 §4，纯计算 + 摘要调用编排。
 *
 * - segmentMessagesFromEvents：R1-1 按 session.events[elm.elm_ref] 事件原文产出摘要输入
 *   （不按 surface 过滤——compaction replace 后遮蔽 seq 仍取原文），与 engine.segmentMessages
 *   同构但 surface 无关；tool/result 复用 view toolResult L1 摘要构造 tool message（同规则）。
 * - HANDOFF_BRANCH_INSTRUCTION：handoff 专用指令（要求输出 §4.4 JSON schema）。
 * - parseBranchSummary：剥 ```json 围栏 → 归一化九字段（缺失置空串/空数组，不编造）。
 * - summarizeBranch：segmentMessagesFromEvents → engine.summarizeContent(purpose:'handoff-branch')
 *   → parseBranchSummary → source_txn_ids 覆盖为 txnIds 实际值。
 * - renderBranchMarkdown：CA-HANDOFF-*.md 渲染（front matter + 正文各节）。
 *
 * 环依赖纪律：本模块不得 import engine.js（engine.js 单向导入本模块的指令常量）。
 */
import { createToolResultMessage } from '@deepseek-ai/dsh-llm';

/**
 * handoff 专用指令（中文）：要求输出 §4.4 JSON schema
 * （goal/current_state/key_facts/open_items/next_step/source_txn_ids/source_seq_ranges/strand_id/reality_ids）。
 */
export const HANDOFF_BRANCH_INSTRUCTION = [
  '你正在作为本 AI 编程助手的会话分支摘要引擎（handoff branch summarizer）。请把上方对话片段浓缩为一份分支摘要，使接手方可在不丢失关键上下文的情况下继续完成该分支的工作。',
  '',
  '严格只输出一个 JSON 对象（不要 Markdown 围栏、不要注释、不要任何额外文本），字段如下：',
  '{',
  '  "goal": "本分支要解决的问题/目标（字符串）",',
  '  "current_state": ["现状要点（字符串数组）"],',
  '  "key_facts": ["关键事实/文件路径/命令/错误串/标识符/数值/函数签名（字符串数组）"],',
  '  "open_items": ["未决问题（字符串数组）"],',
  '  "next_step": ["建议下一步（字符串数组）"],',
  '  "source_txn_ids": [源事务 ID（整数数组）],',
  '  "source_seq_ranges": [[起始事件 seq, 结束事件 seq], ...（整数二维数组）],',
  '  "strand_id": 所属话题块 ID（整数或 null）',
  '  "reality_ids": [关联工作线 ID（整数数组）]',
  '}',
  '',
  '要求：',
  '- 保留确切的文件路径、命令、错误串、标识符、数值与函数签名；',
  '- 忠实记录用户反馈与显式指令（尤其是修正）；',
  '- 字段缺失时置空字符串/空数组，不得编造不存在的事实；',
  '- 只输出 JSON 对象本身。',
].join('\n');

/** §4.4 分支摘要九字段契约清单（顺序固定） */
export const BRANCH_SUMMARY_KEYS = [
  'goal',
  'current_state',
  'key_facts',
  'open_items',
  'next_step',
  'source_txn_ids',
  'source_seq_ranges',
  'strand_id',
  'reality_ids',
];

/** 分支摘要解析失败（非法 JSON/非对象/空输入）——调用方按分支降级处理 */
export class BranchSummaryParseError extends Error {
  constructor(reason) {
    super(`分支摘要解析失败：${reason}`);
    this.name = 'BranchSummaryParseError';
    this.reason = reason;
  }
}

/**
 * R1-1：按事件原文产出摘要输入消息（signature 与 engine.segmentMessages 同构但 surface 无关）。
 * for id in txnIds: for elm in view where transaction_id===id:
 *   event = session.events[elm.elm_ref]（undefined → 跳过）
 *   event.type==='tool/result' 且 elm.type==='toolResult' 且 elm.text 且 callId 可得
 *     → createToolResultMessage({ callId, content:[{type:'text',text:elm.text}], isError })
 *   else → session.deriveEventMessage(event)（null 则跳过）
 * @returns {Array<import('@deepseek-ai/dsh-llm').Message>}
 */
export function segmentMessagesFromEvents(session, view, txnIds) {
  const messages = [];
  for (const id of txnIds ?? []) {
    for (const elm of view ?? []) {
      if (elm.transaction_id !== id) continue;
      const event = session.events[elm.elm_ref];
      if (!event) continue; // elm_ref 越界 → 跳过不抛错
      if (event.type === 'tool/result' && elm.type === 'toolResult' && elm.text) {
        const block = event.data?.message?.content?.[0];
        const callId = event.data?.message?.source?.callId ?? block?.toolCallId;
        if (callId) {
          messages.push(
            createToolResultMessage({
              callId,
              content: [{ type: 'text', text: elm.text }], // view toolResult L1 摘要替代原文（同 engine.segmentMessages 规则）
              isError: block?.isError === true,
            }),
          );
          continue;
        }
      }
      const message = session.deriveEventMessage(event);
      if (message !== null) messages.push(message);
    }
  }
  return messages;
}

/** 数值 → 截断整数（字符串数字/浮点允许，其余 NaN） */
function toTruncInt(value) {
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

/** 整数数组归一化（≥1 才保留；'2'/3.7 → 2/3；'x' 丢弃） */
function intList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(toTruncInt).filter((n) => Number.isInteger(n) && n >= 1);
}

/**
 * 解析分支摘要：拼 text 块 → 剥 ```json 围栏 → JSON.parse → 校验对象 → 归一化。
 * 字符串字段缺失置 ''；数组字段缺失置 []；source_txn_ids 过滤为 int；seq_ranges 过滤 [[s,e]]；
 * strand_id int|null；reality_ids int[]。非法 JSON/非对象 → 抛 BranchSummaryParseError。
 */
export function parseBranchSummary(blocks) {
  const text = (blocks ?? [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  let jsonText = text;
  const fenceMatch = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(jsonText);
  if (fenceMatch) jsonText = fenceMatch[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new BranchSummaryParseError(`非法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BranchSummaryParseError('摘要内容不是 JSON 对象');
  }
  const stringList = (value) => (Array.isArray(value) ? value : []).filter((x) => typeof x === 'string');
  return {
    goal: typeof parsed.goal === 'string' ? parsed.goal : '',
    current_state: stringList(parsed.current_state),
    key_facts: stringList(parsed.key_facts),
    open_items: stringList(parsed.open_items),
    next_step: stringList(parsed.next_step),
    source_txn_ids: intList(parsed.source_txn_ids),
    source_seq_ranges: (Array.isArray(parsed.source_seq_ranges) ? parsed.source_seq_ranges : [])
      .map((range) => (Array.isArray(range) ? range.slice(0, 2).map(toTruncInt) : []))
      .filter((range) =>
        range.length === 2
        && Number.isInteger(range[0]) && Number.isInteger(range[1])
        && range[0] >= 1 && range[1] >= 1 && range[0] <= range[1]) // 事件 seq ≥1 且 start≤end；倒置/零/负区间不合法
      .map((range) => [range[0], range[1]]),
    strand_id: Number.isInteger(parsed.strand_id) ? parsed.strand_id : null,
    reality_ids: intList(parsed.reality_ids),
  };
}

/** 排序后 seq 列表 → 连续段分组 [[s,e],...]（与 partitionBranches 同口径：事件 seq，非 surface 位置） */
function contiguousRanges(seqs) {
  const ranges = [];
  for (const seq of seqs) {
    const last = ranges[ranges.length - 1];
    if (last && seq === last[1] + 1) last[1] = seq;
    else ranges.push([seq, seq]);
  }
  return ranges;
}

/**
 * 分支摘要编排：view = engine.getView(session)（不存在 → []）→ segmentMessagesFromEvents
 * → 空消息 → BranchSummaryParseError('empty（无可摘要事件）') → engine.summarizeContent
 * （purpose:'handoff-branch'）→ parseBranchSummary → source_txn_ids 覆盖为 txnIds 实际值。
 * @returns {Promise<{ summary: object, txnIds: number[], seqRanges: number[][] }>}
 */
export async function summarizeBranch(engine, session, txnIds, agent, signal) {
  const view = engine.getView(session) ?? [];
  const messages = segmentMessagesFromEvents(session, view, txnIds);
  if (messages.length === 0) {
    throw new BranchSummaryParseError('empty（无可摘要事件）');
  }
  const result = await engine.summarizeContent(session, messages, agent, signal, { purpose: 'handoff-branch' });
  const summary = parseBranchSummary(result.blocks);
  summary.source_txn_ids = [...txnIds]; // 契约：source_txn_ids 必须与分支 source_txn_start/end 一致
  const seqs = (view ?? [])
    .filter((elm) => txnIds.includes(elm.transaction_id))
    .map((elm) => elm.elm_ref)
    .filter((seq) => Number.isInteger(seq))
    .sort((a, b) => a - b);
  return { summary, txnIds: [...txnIds], seqRanges: contiguousRanges(seqs) };
}

/**
 * CA-HANDOFF-*.md 渲染（设计 §3.5）：front matter 含 package_id/branch_id/parent_session_id/
 * spawn_session_id/source_txn_ids/reality_ids/status/created_at；正文为 §4.4 各节。
 */
export function renderBranchMarkdown(summary, meta) {
  const frontMatter = [
    '---',
    `package_id: ${meta?.package_id ?? ''}`,
    `branch_id: ${meta?.branch_id ?? ''}`,
    `parent_session_id: ${meta?.parent_session_id ?? ''}`,
    `spawn_session_id: ${meta?.spawn_session_id ?? ''}`,
    `source_txn_ids: ${JSON.stringify(summary?.source_txn_ids ?? [])}`,
    `reality_ids: ${JSON.stringify(summary?.reality_ids ?? [])}`,
    `status: ${meta?.status ?? 'planned'}`,
    `created_at: ${meta?.created_at ?? ''}`,
    '---',
  ].join('\n');
  const list = (title, items) =>
    `## ${title}\n${(items ?? []).map((item) => `- ${item}`).join('\n') || '（无）'}`;
  const body = [
    '# 分支摘要',
    `## goal\n${summary?.goal ?? ''}`,
    list('current_state', summary?.current_state),
    list('key_facts', summary?.key_facts),
    list('open_items', summary?.open_items),
    list('next_step', summary?.next_step),
  ].join('\n\n');
  return `${frontMatter}\n${body}`;
}
