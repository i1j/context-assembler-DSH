/**
 * lib/ooda-rewrite.js — Fct 多事务 OODA 装配（7.1 + 部分 7.2 thought：thought+tool 合流）。
 *
 * 职责：把「云端 LLM 第一轮分解的事务」的 Fct（lib/fct-ooda.js 生成）装配进会话——
 *   1) collectOrientCards：运行时事务首段 think → orient 卡（决策 44 运行时版）；
 *   2) planOodaRewrites：决定哪些 thought/fin 行该替换（tail 硬保护 / surface 可见性 / 幂等 /
 *      fct 就绪 / 经济门槛 / 升序），纯函数；
 *   3) executeThoughtRewrites：assistant/message content-only replace（保留 tool-call block，
 *      8-15 P0 契约），真实 Session；
 *   4) assembleOodaCtx：dry-run 留档（before=原文可自证）；
 *   5) maybeRewriteThoughts：每轮 step 1 集成——tail 外事务入队（idempotent）→ queue.get 就绪 →
 *      plan → dry-run 留档或 execute。
 *
 * 纪律（对齐 tool-rewrite / tool-backfill）：
 *   - tail 硬保护：保护区事务的 thought 永不替换（首轮 orient 卡本身就是事务线索，不消费）；
 *   - 前缀冻结：只替换滑出保护区的旧行，前缀不动（缓存命中）；
 *   - fail-open：fct 未就绪 / 4B 失败 / 异常 → 保留原文，不中断会话；
 *   - 幂等：doneSeqs + surfaceSeqs 双保险，已替换行永不二次计划。
 */
import { THINK_PREVIEW_CHARS } from './think-collect.js';
import { buildTransactionFrames, buildOodaThinkContext, formatFctAffairs } from './fct-ooda.js';
import { tailTxnIds } from './tool-rewrite.js';

/** 运行时 orient 卡（事务首段 think/fin）的 preview 截断字符数 */
const ORIENT_PREVIEW_CHARS = 160;

/**
 * view Elm → 每事务首段 thought/fin 的 orient 卡（决策 44 运行时版）。
 * 卡字段对齐 think-collect 输出（cardKind/seq/turn?/txnId/questionText/preview/reasoningText?），
 * 供 buildOodaThinkContext 直接消费；preview 截断 ORIENT_PREVIEW_CHARS。
 * @param {Array<any>} view rich Elm 列表
 * @returns {Array<{cardKind:'orient', seq:number, txnId:number, questionText:string, preview:string, reasoningText:string}>}
 */
export function collectOrientCards(view) {
  const firstByTxn = new Map();
  for (const elm of view ?? []) {
    if (!elm || (elm.type !== 'thought' && elm.type !== 'fin')) continue;
    if (!Number.isInteger(elm.elm_ref)) continue;
    const txnId = elm.transaction_id;
    if (txnId === undefined || txnId === null) continue;
    if (!firstByTxn.has(txnId)) firstByTxn.set(txnId, elm);
  }
  // 事务的 user 文本（问题）
  const userTextByTxn = new Map();
  for (const elm of view ?? []) {
    if (elm?.type === 'user' && elm.transaction_id !== undefined) {
      if (!userTextByTxn.has(elm.transaction_id) && typeof elm.text === 'string') {
        userTextByTxn.set(elm.transaction_id, elm.text);
      }
    }
  }
  const cards = [];
  for (const [txnId, elm] of [...firstByTxn.entries()].sort((a, b) => a[0] - b[0])) {
    const reasoningText = typeof elm.text === 'string' ? elm.text : '';
    cards.push({
      cardKind: 'orient',
      seq: elm.elm_ref,
      txnId,
      questionText: userTextByTxn.get(txnId) ?? '',
      preview: reasoningText.slice(0, ORIENT_PREVIEW_CHARS),
      reasoningText,
    });
  }
  return cards;
}

/**
 * 生成 thought/fin 行装配计划（纯函数）。
 * 候选 = thought / fin / toolCall 派生自 assistant/message（含 text+tool-call 的消息，其 elm type
 * 为 'toolCall'，reasoning 也应被 Fct 替换而保留 tool-call block——8-15 P0）；execute 侧按
 * assistant/message 事件过滤，tool/call 派生的 elm 即便被计划也会在执行时跳过（无副作用）。
 * @param {Array<any>} view rich Elm 列表（type/transaction_id/elm_ref/text/ooda_stage）
 * @param {Map<number,{status:'done',affairs:Array}|{status:string}>} fctByTxn 事务 → Fct 结果
 *   （lib/fct-ooda.js createFctOodaQueue.get 输出，按 transaction_id 组织）
 * @param {object} opts
 * @param {number} [opts.tailTurns] tail 硬保护 user 轮数（默认 2）
 * @param {number} [opts.minSavingChars] 最小节省字符门槛（默认 400；不足宁留原文）
 * @param {Set<number>} [opts.surfaceSeqs] 当前表层 seq 集合（默认空集 = 只计划仍可见节点）
 * @param {Set<number>} [opts.doneSeqs] 已替换 seq（幂等双保险；默认空集）
 * @returns {Array<{seq:number,txnId:number,before:string,after:string,rawChars:number,savingChars:number}>}
 *   按 seq 升序；只含：thought/fin/toolCall(assistant 派生) 行、tail 外、表层可见、未替换、
 *   fct 就绪、节省达标。
 */
export function planOodaRewrites(view, fctByTxn, opts = {}) {
  const tailTurns = Number(opts.tailTurns ?? 2);
  const minSavingChars = Number(opts.minSavingChars ?? 400);
  const surfaceSeqs = opts.surfaceSeqs instanceof Set ? opts.surfaceSeqs : new Set();
  const doneSeqs = opts.doneSeqs instanceof Set ? opts.doneSeqs : new Set();
  const tail = tailTxnIds(view, tailTurns);
  const fct = fctByTxn instanceof Map ? fctByTxn : new Map();
  const out = [];
  for (const elm of view ?? []) {
    const candidate = elm?.type === 'thought' || elm?.type === 'fin' || elm?.type === 'toolCall';
    if (!candidate) continue;
    if (!Number.isInteger(elm.elm_ref)) continue;
    const seq = elm.elm_ref;
    if (!surfaceSeqs.has(seq)) continue; // 已遮蔽/已替换的不再计划
    if (doneSeqs.has(seq)) continue; // 幂等双保险
    const txnId = elm.transaction_id;
    if (txnId === undefined || txnId === null || tail.has(txnId)) continue; // tail 硬保护
    const item = fct.get(txnId);
    if (!item || item.status !== 'done' || !Array.isArray(item.affairs) || item.affairs.length === 0) continue;
    const after = formatFctAffairs(item.affairs);
    if (!after) continue;
    const before = typeof elm.text === 'string' ? elm.text : '';
    const rawChars = before.length;
    const savingChars = rawChars - after.length;
    if (savingChars < minSavingChars) continue; // 经济门槛
    out.push({ seq, txnId, before, after, rawChars, savingChars });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/**
 * 执行 thought 装配：对每个计划项生成合法 assistant/message replace 事件。
 * content 的 text/reasoning 块替换为 Fct 文本；保留 tool-call block（保 pairing，8-15 P0）；
 * 其余字段（message.id/role/source/turn/step）保持不动。
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {ReturnType<typeof planOodaRewrites>} plan
 * @returns {Array<{seq:number,appendedSeq:number}>} 实际落地项
 */
export function executeThoughtRewrites(session, plan) {
  const results = [];
  const events = Array.isArray(session?.events) ? session.events : [];
  for (const item of plan ?? []) {
    if (!item || !Number.isInteger(item.seq) || typeof item.after !== 'string') continue;
    const original = events.find((e) => e?.type === 'assistant/message' && e.seq === item.seq);
    if (!original) continue;
    const data = structuredClone(original.data);
    const msg = data?.message;
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    const textBlocks = blocks.filter((b) => b?.type === 'text' || b?.type === 'reasoning');
    const toolCallBlocks = blocks.filter((b) => b?.type === 'tool-call');
    if (textBlocks.length === 0) continue; // 无文本块可替（纯 tool-call 消息不动）
    msg.content = toolCallBlocks.length > 0
      ? [{ type: 'text', text: item.after }, ...toolCallBlocks]
      : [{ type: 'text', text: item.after }];
    const appended = session.append('assistant/message', data, {
      surfaceOp: { op: 'replace', start: item.seq, end: item.seq },
      sourceEventSeqs: [item.seq],
    });
    results.push({ seq: item.seq, appendedSeq: appended.seq });
  }
  return results;
}

/**
 * 汇编 dry-run 留档视图（纯函数、零 IO——调用方负责 archive）。
 * @param {Array<any>} view
 * @param {Map<number,object>} fctByTxn
 * @param {object} opts 同 planOodaRewrites
 * @returns {{plan:any[], replacements:Array, stats:{planned:number,rawChars:number,afterChars:number,savedChars:number,savePct:number}}}
 */
export function assembleOodaCtx(view, fctByTxn, opts = {}) {
  const plan = planOodaRewrites(view, fctByTxn, opts);
  const replacements = plan.map((p) => ({
    seq: p.seq,
    txnId: p.txnId,
    before: p.before,
    after: p.after,
    rawChars: p.rawChars,
    savingChars: p.savingChars,
  }));
  const rawChars = plan.reduce((sum, p) => sum + p.rawChars, 0);
  const afterChars = plan.reduce((sum, p) => sum + p.after.length, 0);
  return {
    plan,
    replacements,
    stats: {
      planned: plan.length,
      rawChars,
      afterChars,
      savedChars: rawChars - afterChars,
      savePct: rawChars > 0 ? +(((rawChars - afterChars) / rawChars) * 100).toFixed(1) : 0,
    },
  };
}

/** 每会话已入队事务 / 已替换 seq（WeakMap 随会话释放；对齐 toolRewriteDoneSeqs 模式） */
const oodaEnqueuedTxns = new WeakMap();
const oodaDoneSeqs = new WeakMap();

/** dry-run 留档（fail-open：写文件失败仅告警）；目录 <ca-v7>/ca_cache/ctx-assembly-dryrun/ */
function archiveOodaDryRun(sessionId, assembly, log) {
  try {
    const { mkdirSync, writeFileSync } = require('node:fs');
    const { dirname, join } = require('node:path');
    const { fileURLToPath } = require('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, '..', 'ca_cache', 'ctx-assembly-dryrun');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(
      join(dir, `${sessionId}-ooda-${stamp}.json`),
      JSON.stringify({ sessionId, kind: 'fct-ooda', generatedAt: new Date().toISOString(), ...assembly }, null, 2),
      'utf8',
    );
  } catch (error) {
    log.warn(`ca-v7 Fct OODA dry-run 留档失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 最近一个已 done 事务的 Fct 渲染文本（作为下一事务的【历史摘要】，链式增量提取） */
function previousDoneFct(enqueued, txnId, queue, session) {
  const sorted = [...enqueued].filter((id) => id < txnId).sort((a, b) => b - a);
  for (const id of sorted) {
    const r = queue?.get?.(session, id);
    if (r && r.status === 'done' && Array.isArray(r.affairs) && r.affairs.length > 0) {
      return formatFctAffairs(r.affairs);
    }
  }
  return '';
}

/**
 * 每轮 step 1 评估：tail 外事务入队生成 Fct（idempotent）→ 就绪事务 plan → dry-run 留档或落地替换。
 * @param {object} ctx 兼容位（暂未使用；预留 sessionProjections 扩展）
 * @param {{session: import('@deepseek-ai/dsh-session').Session}} agent
 * @param {Array<any>} view 当前 rich Elm 视图（viewViewState(applyViewState(session))）
 * @param {object} config
 * @param {boolean} [config.oodaRewriteEnabled] 开关（默认 false）
 * @param {boolean} [config.oodaRewriteDryRun] dry-run 只留档（默认 true）
 * @param {number} [config.tailN] tail 硬保护 user 轮数（默认 2）
 * @param {number} [config.oodaMinSavingChars] 最小节省门槛（默认 400）
 * @param {number} [config.oodaThinkBudget] think 上下文总预算（默认 2000）
 * @param {object} log
 * @param {ReturnType<typeof createFctOodaQueue>} queue Fct OODA 队列（index.js 持有，跨轮存活）
 * @returns {{applied:number, plan:any[], dryRun:boolean, enqueued?:number}}
 */
export function maybeRewriteThoughts(ctx, agent, view, config, log, queue) {
  if (!config?.oodaRewriteEnabled) return { applied: 0, plan: [], dryRun: false };
  const session = agent?.session;
  if (!session) return { applied: 0, plan: [], dryRun: config.oodaRewriteDryRun === true };
  try {
    const tailTurns = Number(config.tailN ?? 2);
    const minSavingChars = Number(config.oodaMinSavingChars ?? 400);
    const thinkBudget = Number(config.oodaThinkBudget ?? 2000);
    const surfaceSeqs = new Set(Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []);
    const tail = tailTxnIds(view, tailTurns);

    // 1) tail 外事务入队（idempotent；每事务一次）
    const enqueued = oodaEnqueuedTxns.get(session) ?? new Set();
    for (const elm of view ?? []) {
      if (!elm || (elm.type !== 'thought' && elm.type !== 'fin')) continue;
      const txnId = elm.transaction_id;
      if (txnId === undefined || txnId === null || tail.has(txnId) || enqueued.has(txnId)) continue;
      enqueued.add(txnId);
      const txnElms = (view ?? []).filter((e) => e?.transaction_id === txnId);
      const frames = buildTransactionFrames(txnElms);
      const cards = collectOrientCards(txnElms);
      const reasoningTextBySeq = new Map(
        txnElms.filter((e) => e.type === 'thought' || e.type === 'fin').map((e) => [e.elm_ref, typeof e.text === 'string' ? e.text : '']),
      );
      const thinkContext = buildOodaThinkContext(cards, { reasoningTextBySeq, totalBudget: thinkBudget });
      const previousFct = previousDoneFct(enqueued, txnId, queue, session);
      queue?.enqueue?.(session, txnId, { previousFct, currentFrames: frames, thinkContext });
    }
    oodaEnqueuedTxns.set(session, enqueued);

    // 2) 就绪事务 → fctByTxn
    const fctByTxn = new Map();
    for (const txnId of enqueued) {
      const r = queue?.get?.(session, txnId);
      if (r && r.status === 'done') fctByTxn.set(txnId, r);
    }

    // 3) 计划
    const doneSeqs = oodaDoneSeqs.get(session) ?? new Set();
    const plan = planOodaRewrites(view, fctByTxn, { tailTurns, minSavingChars, surfaceSeqs, doneSeqs });
    if (plan.length === 0) return { applied: 0, plan: [], dryRun: config.oodaRewriteDryRun === true, enqueued: enqueued.size };

    // 4) dry-run / execute
    if (config.oodaRewriteDryRun) {
      const assembly = assembleOodaCtx(view, fctByTxn, { tailTurns, minSavingChars, surfaceSeqs, doneSeqs });
      archiveOodaDryRun(session.id, assembly, log);
      const saved = plan.reduce((sum, p) => sum + p.savingChars, 0);
      log.info(`ca-v7 Fct OODA 装配[dry-run]：计划 ${plan.length} 条（约省 ${saved} 字符），不注入`);
      return { applied: 0, plan, dryRun: true, enqueued: enqueued.size };
    }
    const applied = executeThoughtRewrites(session, plan);
    if (applied.length > 0) {
      for (const a of applied) doneSeqs.add(a.seq);
      oodaDoneSeqs.set(session, doneSeqs);
      const saved = plan.reduce((sum, p) => sum + p.savingChars, 0);
      log.info(`ca-v7 Fct OODA 装配：${applied.length} 条（约省 ${saved} 字符）`);
    }
    return { applied: applied.length, plan, dryRun: false, enqueued: enqueued.size };
  } catch (error) {
    log.warn(`ca-v7 Fct OODA 装配失败：${error instanceof Error ? error.message : String(error)}；保留原文`);
    return { applied: 0, plan: [], dryRun: config.oodaRewriteDryRun === true, enqueued: oodaEnqueuedTxns.get(session)?.size ?? 0 };
  }
}
