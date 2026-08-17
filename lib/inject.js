/**
 * Phase 1 recall 注入（lib/inject.js）——决策表 + 确定性拼装（无 LLM）。
 *
 * 决策表（design §3.2 C22/B4，实现为 decideInjection）：
 *   | 可见性   | 承载状态 | 注入历史 | 动作 |
 *   | shadowed | unloaded | 未注入   | 注入（候选） |
 *   | shadowed | carried  | —        | 跳过（检查点已承载） |
 *   | visible  | —        | —        | 跳过（tail 内可见） |
 *   | shadowed | unloaded | 已注入   | 跳过（增量去重 + 记忆语义） |
 *   | —        | —        | 已注入（消息被遮蔽） | 跳过（A33 衰减，不重注入） |
 *
 * 候选 = FAR 遮蔽事务（原文遮蔽且信息未承载于摘要——B17 保证 FAR 内容不进摘要）；
 * txn 级可见性聚合（B38）：事务任一核心 Elm（user/assistant fin）被压缩遮蔽即事务不可见，
 * 仅 tool-result 被 prune 不改变可见性（prune 不进入视图遮蔽集合）。
 *
 * 内容拼装（D26/D29）：user Elm 在前 + ooda_stage 标注；sections = 每候选命名 section
 * + transaction_refs 命名 section（B27：ContextSnapshotSection={name,text}，text=JSON 编码 txnId 数组，
 * 不得加结构化字段）——注入历史据此自 source.plugin='ca-v7' 消息重建（B29）。
 *
 * 重叠判定（D45）：注入文本与检查点摘要文本无 ≥20 字符重叠片段（overlap.js 单一基元）；
 * 拒绝时日志记录（transaction_id + 重叠片段），该事务按 A33 衰减语义处理（A35）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { groupByTxn } from './grade.js';
import { maxCommonSubstring } from './overlap.js';

/** 重叠拒绝阈值（≥20 字符，D45/C24 需求线） */
export const OVERLAP_MIN_LEN = 20;

/**
 * 注入决策表。
 * @param {any[]} view 视图 rich Elm 列表
 * @param {{ enabled: boolean; tokenLimit: number; k: number }} config 注入配置（CaInjectConfig）
 * @param {Set<number>} injectHistory 已注入/已衰减事务 ID 集合（注入历史重建 + A33）
 * @returns {{ action: 'inject'|'skip'; reason: string; candidateTxnIds?: number[] }}
 */
export function decideInjection(view, config, injectHistory) {
  if (!config.enabled) return { action: 'skip', reason: 'injection disabled by config' };
  const txns = groupByTxn(view);
  /** @type {number[]} */
  const candidates = [];
  for (const [txnId, elms] of txns) {
    if (injectHistory.has(txnId)) continue; // 行 4/5：已注入 → 跳过（含 A33 衰减）
    const core = elms.filter((e) => e.type === 'user' || e.type === 'fin');
    const shadowed = core.length > 0 && core.some((e) => e.visibility === 'shadowed');
    const carried = elms.some((e) => e.carrierState === 'carried');
    if (shadowed && !carried) candidates.push(txnId); // 行 1：注入（FAR 遮蔽未承载）
    // 行 2（carried）/ 行 3（visible）：跳过
  }
  if (candidates.length === 0) {
    return { action: 'skip', reason: 'no FAR shadowed uncarried transactions' };
  }
  return {
    action: 'inject',
    reason: `${candidates.length} FAR shadowed transaction(s) without carried content`,
    candidateTxnIds: candidates,
  };
}

/** 单事务的确定性拼装段（user Elm 在前 + ooda_stage 标注 + fin 文本） */
function buildTxnSection(view, txnId) {
  const txns = groupByTxn(view);
  const elms = txns.get(txnId) ?? [];
  const userElm = elms.find((e) => e.type === 'user');
  const finElm = [...elms].reverse().find((e) => e.type === 'fin');
  const stage = userElm?.ooda_stage ?? 'observe';
  const userText = userElm?.text ?? '';
  const finText = finElm?.text ?? '';
  const note = `[transaction: ${txnId}] [ooda_stage: ${stage}]`;
  return userText.length > 0 ? `${userText}\n${note}${finText ? '\n' + finText : ''}` : `${note}${finText ? '\n' + finText : ''}`;
}

/**
 * 确定性拼装注入内容（多候选 K 聚合，无 LLM）。
 * 拼装顺序：user Elm 在前 + ooda_stage 标注（D26/D29——内容以首个候选 user 原文开头）。
 * @param {any[]} view 视图 rich Elm 列表
 * @param {number[]} candidateTxnIds 候选事务 ID（升序）
 * @param {number} [k=1] 注入已闭合事务数（sections 长度 = min(k, 候选数)）
 * @returns {string} 拼装文本
 */
export function buildInjectionContent(view, candidateTxnIds, k = 1) {
  const chosen = candidateTxnIds.slice(0, Math.max(1, Math.floor(k)));
  return chosen.map((id) => buildTxnSection(view, id)).join('\n\n');
}

/** 单事务命名 section（ContextSnapshotSection={name,text}） */
function txnSection(view, txnId) {
  return { name: `transaction-${txnId}`, text: buildTxnSection(view, txnId) };
}

/**
 * 构建注入 user/message（durable 尾部追加用）：
 *   source = {kind:'plugin', plugin:'ca-v7', form:'snapshot', sections}；
 *   sections = 每候选命名 section（min(k, 候选数) 个）+ transaction_refs 命名 section；
 *   内容 token ≤ config.tokenLimit（estimateMessage 复检，超限从尾部截断、保持 user 原文前缀）。
 * @param {any[]} view 视图 rich Elm 列表
 * @param {number[]} candidateTxnIds 候选事务 ID
 * @param {{ enabled: boolean; tokenLimit: number; k: number }} config 注入配置
 * @param {(message: unknown) => number} estimateMessage token 估算函数（ctx.tokenMeter.estimateMessage）
 * @returns {{ message: import('@deepseek-ai/dsh-llm').UserMessage; txnIds: number[] }}
 */
export function buildInjectionMessage(view, candidateTxnIds, config, estimateMessage) {
  const chosen = candidateTxnIds.slice(0, Math.max(1, Math.floor(config.k)));
  const make = (text, srcSections) =>
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'ca-v7', form: 'snapshot', sections: srcSections },
    });
  const refSection = { name: 'transaction_refs', text: JSON.stringify(chosen) };
  const fullSections = [...chosen.map((id) => txnSection(view, id)), refSection];
  let content = buildInjectionContent(view, chosen, config.k);
  let sections = fullSections;
  let message = make(content, sections);
  if (typeof estimateMessage === 'function' && estimateMessage(message) > config.tokenLimit) {
    // 保持 user 原文前缀：二分最长前缀使 token ≤ 上限
    let lo = 0;
    let hi = content.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateMessage(make(content.slice(0, mid), fullSections)) <= config.tokenLimit) lo = mid;
      else hi = mid - 1;
    }
    content = content.slice(0, lo);
    // 截断后重建 transaction-* sections：契约要求 sections[*].text 是「实际组装进模型的文本」，
    // 不得保留未进入 content 的完整段落（durable 记录与模型实际输入一致）。
    const keptSections = [];
    let rest = content;
    for (const id of chosen) {
      if (rest.length === 0) break;
      const section = txnSection(view, id);
      const sep = keptSections.length === 0 ? '' : '\n\n';
      if (rest.startsWith(sep + section.text)) {
        keptSections.push(section);
        rest = rest.slice((sep + section.text).length);
      } else {
        keptSections.push({ name: section.name, text: rest.replace(/^\n\n/, '') });
        rest = '';
      }
    }
    sections = [...keptSections, refSection];
    message = make(content, sections);
  }
  return { message, txnIds: chosen };
}

/**
 * 重叠判定：注入内容与检查点摘要文本的最长公共子串 ≥ 20 → 重复。
 * @param {string} content 注入内容
 * @param {readonly import('@deepseek-ai/dsh-session').SessionEvent[]} events 会话事件日志
 * @returns {{ overlap: number; fragment: string; summaryText: string } | null}
 */
export function findCheckpointOverlap(content, events) {
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue;
    const blocks = event.data?.summary;
    if (!Array.isArray(blocks)) continue;
    const summaryText = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');
    if (summaryText.length === 0) continue;
    const overlap = maxCommonSubstring(content, summaryText);
    if (overlap >= OVERLAP_MIN_LEN) {
      // 提取重叠片段（取内容侧最长公共子串窗口）
      const fragment = longestCommonSubstring(content, summaryText);
      return { overlap, fragment, summaryText };
    }
  }
  return null;
}

/** 最长公共子串原文（overlap 判定日志用） */
function longestCommonSubstring(a, b) {
  if (!a || !b) return '';
  const n = a.length;
  let best = 0;
  let endA = 0;
  const prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= b.length; i += 1) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j += 1) {
      if (b.charCodeAt(i - 1) === a.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) {
          best = v;
          endA = j;
        }
      }
    }
    for (let j = 0; j <= n; j += 1) prev[j] = cur[j];
  }
  return a.slice(endA - best, endA);
}
