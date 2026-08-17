/**
 * 7.1 P4：wire 级工具结果改写（lib/tool-rewrite.js）。
 *
 * 目标（docs/CA-V7-7.1-tool信息搜集与处理设计.md §4.5）：
 *   历史 tool result 在云端 ctx 里仍是原文（占本会话 82%）。本模块用 tool_trace
 *   的预生成摘要把单个 tool/result 表层节点替换为 L1/L2 文本，保留工具消息配对，
 *   从而在云端 wire 上直接减少历史工具输出。
 *
 * DSH 改写契约（已实测，node_modules/@deepseek-ai/dsh-session/lib/index.js）：
 *   - tool/result 允许 surfaceOp.replace，但 assertToolResultRewrite 只允许改
 *     嵌套 tool-result.content；message.id/role/source/turn/step/toolCallId/isError
 *     必须逐字段保持；
 *   - shadowedSeqs.length===1 且指向当前 tool/result；
 *   - replace 事件必须携带 sourceEventSeqs 覆盖被遮蔽 seq（assertProvenance）。
 *
 * 纪律：
 *   - 纯函数计划生成（无 LLM、无 IO）；执行器只 append replace、不读摘要外内容；
 *   - tail 硬保护最后 N 个 user 轮（Hermes decision 13），预算扫描禁止；
 *   - 经济门槛：替换文本必须显著短于原文（minSavingChars），否则宁留原文；
 *   - 每话题块只执行一次（块内不再微调，缓存稳定；触发方在 index.js）。
 */
import { TOOL_TRACE_KEY } from './tool-trace.js';

/** 计划条目：单条 tool/result 的 content-only replace */
export const TOOL_REWRITE_PLAN_VERSION = 1;

/**
 * 从视图建立 resultSeq → transaction_id 映射（工具结果 Elm 的 elm_ref 即 result 事件 seq）。
 * @param {any[]} view rich Elm 列表（lib/view.js）
 */
function resultSeqToTxn(view) {
  const map = new Map();
  for (const elm of view ?? []) {
    if (elm?.type === 'toolResult' && typeof elm.elm_ref === 'number') {
      map.set(elm.elm_ref, elm.transaction_id);
    }
  }
  return map;
}

/** 视图尾部的最后 N 个"user 轮"事务 ID（硬保护，禁止替换） */
export function tailTxnIds(view, tailTurns) {
  const ids = [];
  for (const elm of view ?? []) {
    if (elm?.type === 'user' && elm.transaction_id !== undefined && !ids.includes(elm.transaction_id)) {
      ids.push(elm.transaction_id);
    }
  }
  const n = Math.max(0, Number(tailTurns) || 0);
  return new Set(n === 0 ? [] : ids.slice(-n));
}

/**
 * 分级保护区（改进方案 §4.5 近保护区渐进档）：
 * - hard：最后 tailTurns 个 user 轮事务（禁止替换，硬保护 decision 13）；
 * - near：紧邻 hard 之前的 nearTurns 个 user 轮事务——允许替换但优先 L1，
 *   避免"刚滑出保护区就立即被压成 L2，导致最近相关信息丢失"。
 * @param {any[]} view rich Elm 列表
 * @param {number} tailTurns 硬保护区轮数
 * @param {number} [nearTurns] 近保护区轮数（默认 2）
 * @returns {{ hard: Set<number>, near: Set<number> }}
 */
export function tailTxnIdsGraded(view, tailTurns, nearTurns = 2) {
  const ids = [];
  for (const elm of view ?? []) {
    if (elm?.type === 'user' && elm.transaction_id !== undefined && !ids.includes(elm.transaction_id)) {
      ids.push(elm.transaction_id);
    }
  }
  const h = Math.max(0, Number(tailTurns) || 0);
  const n = Math.max(0, Number(nearTurns) || 0);
  const hard = new Set(h === 0 ? [] : ids.slice(-h));
  const nearStart = h + n;
  const near = new Set(n === 0 ? [] : ids.slice(-nearStart, -h || undefined));
  return { hard, near };
}

/**
 * 事实附录（改进方案 §3.4 分层摘要 + §4.2 动态预算的运行时代理）：
 * L1 主体之后追加 highValueFacts 中尚未出现的 URI/路径/错误/退出码，让摘要从
 * "结论式"转向"事实覆盖式"（真实报告 §3.2：改写区事实保留率 9.8% 是最大问题）。
 * 预算随高价值事实数量动态分配：缺失事实越多，附录越长（maxFacts/budgetChars 兜底）；
 * 主体已含的事实不重复追加。纯函数、确定性、无 LLM。
 * @param {string|null|undefined} text L1 主体摘要
 * @param {any} row tool_trace 痕迹行（含 highValueFacts）
 * @param {{maxFacts?: number, budgetChars?: number}} [opts]
 * @returns {string} 追加附录后的摘要；无缺失/无清单时原样返回
 */
export function appendFactAppendix(text, row, opts = {}) {
  const maxFacts = Number(opts.maxFacts ?? 5);
  const budget = Number(opts.budgetChars ?? 200);
  const base = String(text ?? '');
  if (!Array.isArray(row?.highValueFacts) || row.highValueFacts.length === 0) return text;
  const missing = [];
  for (const f of row.highValueFacts) {
    if (typeof f !== 'string' || !f) continue;
    const value = f.includes(':') ? f.slice(f.indexOf(':') + 1) : f;
    const v2 = value.replace(/^~\//, '');
    // 已含判定：完整事实串最可靠；裸值仅在足够长（≥8）时做子串匹配，
    // 避免 exit:1/ident:x 等短值被主体里的普通字符误报为"已含"（真实报告 §7.2-7）。
    if (base.includes(f)) continue;
    if (value.length >= 8 && (base.includes(value) || base.includes(v2))) continue;
    missing.push(f);
  }
  if (missing.length === 0) return text;
  let suffix = '';
  let count = 0;
  for (const f of missing) {
    if (count >= maxFacts) break;
    const candidate = (suffix ? ' | ' : '') + f;
    if ((suffix + candidate).length > budget) break;
    suffix += candidate;
    count += 1;
  }
  return suffix ? base + suffix : base;
}

/**
 * 生成单条 tool/result 改写计划（纯函数）。
 *
 * @param {any[]} view rich Elm 列表（含 transaction_id / elm_ref；供 txn 定位与 tail 保护）
 * @param {any[]} rows lib/tool-trace.js 的痕迹行（callId/resultSeq/resultChars/resultSummary/hdl/status）
 * @param {Map<number,'ACT'|'REL'|'FAR'>} grades 冻结定级 Map（lib/topic-grade.js 输出）
 * @param {object} opts
 * @param {number} [opts.tailTurns] tail 硬保护 user 轮数（默认 2）
 * @param {number} [opts.nearTurns] 近保护区轮数（默认 2；§4.5 渐进档：近区优先 L1）
 * @param {number} [opts.minSavingChars] 最小节省字符门槛（默认 400；不足宁留原文）
 * @param {Set<number>} [opts.surfaceSeqs] 当前表层 seq 集合（默认空集 = 只计划仍可见节点）
 * @param {number} [opts.factAppendixMaxFacts] L1 事实附录最多条数（默认 5；0 = 禁用）
 * @param {number} [opts.factAppendixBudgetChars] L1 事实附录总字符预算（默认 200）
 * @returns {Array<{ seq: number; callId: string; turn: number|null; step: number|null; level: 'l1'|'l2'; rawChars: number; text: string; savingChars: number }>}
 *   按 resultSeq 升序；不含 tail/不可见/无摘要/节省不足的行
 */
export function planToolRewrites(view, rows, grades, opts = {}) {
  const tailTurns = Number(opts.tailTurns ?? 2);
  const nearTurns = Number(opts.nearTurns ?? 2);
  const minSavingChars = Number(opts.minSavingChars ?? 400);
  const surfaceSeqs = opts.surfaceSeqs instanceof Set ? opts.surfaceSeqs : new Set();
  const txnByResultSeq = resultSeqToTxn(view);
  const { hard, near } = tailTxnIdsGraded(view, tailTurns, nearTurns);
  const gradeOf = grades instanceof Map ? grades : new Map();
  const out = [];
  for (const row of rows ?? []) {
    if (!row || row.status !== 'completed') continue;
    if (!Number.isInteger(row.resultSeq)) continue;
    if (!surfaceSeqs.has(row.resultSeq)) continue; // 已遮蔽/已替换的不再计划
    const txnId = txnByResultSeq.get(row.resultSeq);
    if (txnId === undefined || hard.has(txnId)) continue; // tail 硬保护（decision 13）
    const grade = gradeOf.get(txnId) ?? 'ACT';
    // ACT → L1（4B 回填 outcome_l1 优先，确定性 resultSummary 兜底）；REL/FAR → L2（hdl）。
    // P0 改进：REL/FAR 行若含高价值事实（URI/错误/退出码/关键路径），升级为 L1，避免损失高互信息事实。
    // P1 §4.5：近保护区（刚滑出硬保护区的 nearTurns 轮）优先 L1，避免边界信息立即下沉为 L2。
    // FAR 的"整区间下沉"由压缩后端处理，单条替换保 pairing 仍是更省且更稳的选择。
    const hasHighValueFacts = Array.isArray(row.highValueFacts) && row.highValueFacts.length > 0;
    const inNearZone = txnId !== undefined && near.has(txnId);
    const level = grade === 'ACT' || hasHighValueFacts || inNearZone ? 'l1' : 'l2';
    const l1 = typeof row.outcome_l1 === 'string' && row.outcome_l1.trim() ? row.outcome_l1 : row.resultSummary;
    let text = (level === 'l1' ? l1 : row.hdl) ?? '';
    if (typeof text !== 'string' || !text.trim()) continue;
    // P1 改进（§3.4/§4.2）：L1 行追加事实附录（缺失的高价值事实；预算随事实数动态）。
    if (level === 'l1' && Number(opts.factAppendixMaxFacts ?? 5) > 0) {
      text = appendFactAppendix(text, row, {
        maxFacts: opts.factAppendixMaxFacts,
        budgetChars: opts.factAppendixBudgetChars,
      });
    }
    const rawChars = Number(row.resultChars) || 0;
    const savingChars = rawChars - text.length;
    if (savingChars < minSavingChars) continue; // 经济门槛：替换成本不划算则保留原文
    out.push({
      seq: row.resultSeq,
      callId: row.callId,
      turn: row.turn ?? null,
      step: row.step ?? null,
      level,
      rawChars,
      text,
      savingChars,
    });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/**
 * 执行改写计划：对每个目标 seq 生成合法的单条 tool/result replace 事件。
 * 只改嵌套 tool-result.content（structuredClone 原 data 后替换 content[0].content），
 * 其余字段（message.id/role/source/turn/step/toolCallId/isError）保持不变。
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {ReturnType<typeof planToolRewrites>} plan
 * @returns {Array<{ seq: number; appendedSeq: number }>} 实际落地项
 */
export function executeToolRewrites(session, plan) {
  const results = [];
  const events = Array.isArray(session?.events) ? session.events : [];
  for (const item of plan ?? []) {
    if (!item || !Number.isInteger(item.seq) || typeof item.text !== 'string') continue;
    const original = events.find((e) => e?.type === 'tool/result' && e.seq === item.seq);
    if (!original) continue;
    const data = structuredClone(original.data);
    const resultBlock = data?.message?.content?.[0];
    if (!resultBlock || resultBlock.type !== 'tool-result' || !Array.isArray(resultBlock.content)) continue;
    resultBlock.content = [{ type: 'text', text: item.text }];
    const appended = session.append('tool/result', data, {
      surfaceOp: { op: 'replace', start: item.seq, end: item.seq },
      sourceEventSeqs: [item.seq],
    });
    results.push({ seq: item.seq, appendedSeq: appended.seq });
  }
  return results;
}

/**
 * 读取会话的工具痕迹视图（sessionProjections 快照；缺省空数组）。
 * @param {{ sessionProjections?: any }} ctx
 * @param {import('@deepseek-ai/dsh-session').Session} session
 */
export function snapshotToolTrace(ctx, session) {
  try {
    const snapshot = ctx?.sessionProjections?.snapshot?.(session);
    const value = snapshot?.values?.[TOOL_TRACE_KEY];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * 汇编改写后的 ctx（dry-run 留档；不注入、不 append 任何事件）。
 *
 * 渐进取代的验证载体：给定与运行时同一套输入（view/rows/grades/opts），
 * 输出「若执行改写，工具结果文本会变成什么」的完整映射 + 统计，不改 session。
 * 纯函数、零 IO、零 LLM——dry-run 模式下由 maybeRewriteToolResults 调用留档。
 *
 * opts.rawTextBySeq（可选）：resultSeq → 工具结果原文（来自事件日志）。提供时
 * replacements[].before 存原文而非 resultSummary——归档可自证「原文→L1」的质量，
 * 不依赖调用方回查事件日志。缺省回退 resultSummary / 占位符。
 *
 * @returns {{ plan: any[], replacements: any[], stats: { planned: number; rawChars: number; afterChars: number; savedChars: number; savePct: number; l1: number; l2: number } }}
 */
export function assembleRewrittenCtx(view, rows, grades, opts = {}) {
  const plan = planToolRewrites(view, rows, grades, opts);
  const rowBySeq = new Map((rows ?? []).filter((r) => Number.isInteger(r.resultSeq)).map((r) => [r.resultSeq, r]));
  const rawTextBySeq = opts.rawTextBySeq instanceof Map ? opts.rawTextBySeq : new Map();
  const replacements = [];
  let rawChars = 0;
  let afterChars = 0;
  let l1 = 0;
  let l2 = 0;
  for (const p of plan) {
    const row = rowBySeq.get(p.seq);
    const rawText = rawTextBySeq.get(p.seq);
    const before =
      typeof rawText === 'string' && rawText
        ? rawText
        : typeof row?.resultSummary === 'string' && row.resultSummary
          ? row.resultSummary
          : `[原文 ${p.rawChars} 字符]`;
    replacements.push({
      seq: p.seq,
      callId: p.callId,
      level: p.level,
      before,
      after: p.text,
      rawChars: p.rawChars,
      savingChars: p.savingChars,
    });
    rawChars += p.rawChars;
    afterChars += p.text.length;
    if (p.level === 'l1') l1 += 1;
    else l2 += 1;
  }
  return {
    plan,
    replacements,
    stats: {
      planned: plan.length,
      rawChars,
      afterChars,
      savedChars: rawChars - afterChars,
      savePct: rawChars > 0 ? +(((rawChars - afterChars) / rawChars) * 100).toFixed(1) : 0,
      l1,
      l2,
    },
  };
}
