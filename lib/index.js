/**
 * CA 插件 V7.0（DSH 迁移版）Cordis 插件入口（lib/index.js）。
 *
 * 装配：config schema（CaPluginConfig 全集 + 默认值 + min=1 校验）→ 服务注册
 * （ctx.compaction = CACompactionEngine；sessionProjections register：view + tool-trace；
 * llm/stream 观测器 tee；pre-step listener 挂载）；apply 异常 catch + 日志不冒泡（F51，故障底线）。
 *
 * pre-step 执行顺序（2026-08-16 用户裁定：handoff 优先、压缩兜底）：
 * step 1 先做 handoff 只读规划（有 plan 则本步跳过原位压缩）→ 无 plan 才执行压缩压力检查
 * → await next() 委托下游 → 仅下游 {kind:'enter'} 时执行 handoff plan（落库/spawn/seal）并追加
 * 注入/reality receipt（带 source 的 durable 消息，追加在批次尾部——缓存命中约束）；
 * 仅 turn 内首个 step 决策（A19）。
 */
import z from '@deepseek-ai/schemastery';
import { CACompactionEngine } from './engine.js';
import { VIEW_KEY, createViewProjection, setSessionView } from './view.js';
import { TOOL_TRACE_KEY, createToolTraceProjection, setToolTrace } from './tool-trace.js';
import { initLlmTraceStore, installLlmTrace } from './llm-trace.js';
import { planToolRewrites, executeToolRewrites, snapshotToolTrace, assembleRewrittenCtx } from './tool-rewrite.js';
import { maybeRewriteThoughts } from './ooda-rewrite.js';
import { createFctOodaQueue } from './fct-ooda.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadColdEntityGraph } from './entity-store.js';
import { createToolBackfillQueue } from './tool-backfill.js';
import { buildInjectionContent, buildInjectionMessage, decideInjection, findCheckpointOverlap } from './inject.js';
import { loadRealityIndex, embedText, findRealityCandidates, buildRealityInjectionMessage, pickRealities4B, extractInjectionUserText } from './reality-inject.js';
import { detectTopicSwitch } from './topic-switch.js';
import { TOPIC_STATE_KEY, createTopicStateProjection, setTopicState } from './topic-state.js';
import { collectPressureSignals, pressureTriggered, collectNoiseSignals, noiseTriggered, signalRecords, PRESSURE_DEFAULTS, NOISE_DEFAULTS } from './handoff-metrics.js';
import { evaluateHandoff, partitionBranches } from './handoff-plan.js';

export const name = 'ca-v7';
export const inject = ['sessionProjections', 'llm', 'tokenMeter', 'sessions'];

/** 配置 schema（cordis.patch.yml 插件行 config 段；CaPluginConfig 全集 + 默认值 + min=1 校验） */
export const Config = z.object({
  tailN: z.number().step(1).min(1).default(2), // R6：默认 2，min=1（0 非法，F57）
  gradeAgeThresholdTurns: z.number().step(1).min(0).default(6), // 最小定级轮次年龄（暂定，A12/D17/D49 回填）
  gradeSimilarityThreshold: z.number().min(0).max(1).default(0.5), // 文本相似度阈值（LCS 归一化，C32）
  topicSwitchEntry: z.number().min(0).max(1).default(0), // 话题切换 Jaccard 延续阈值（0.04=Hermes 原值；0=最保守，除强制短语/首轮外永不切换，缓存最友好）
  // ---- 水位压力话题切割（Hermes _apply_water_pressure 移植，2026-08-17 用户裁定）----
  topicSplitStartChars: z.number().step(1).min(0).default(5000), // 水位起始：ctx 累计字符达此值开始扣减 Jaccard（Hermes ACCUMULATED_SPLIT_START=5000）
  topicSplitPeakChars: z.number().step(1).min(1).default(20000), // 水位满压：达此值 forceAtPeak=true 时无条件切割（Hermes TOPIC_PEAK_TOKEN=20000）
  jaccardPenaltyMax: z.number().min(0).max(1).default(0.30), // 线性区最大 Jaccard 扣减量（Hermes JACCARD_PENALTY_MAX=0.30）
  topicSplitForceAtPeak: z.boolean().default(true), // peak 及以上无条件切割（用户裁定：压力到就切新会话，不管前后轮多接近）
  summarizationProvider: z.string().default(''), // 默认 ''（路由最新请求目标）
  summarizationModel: z.string().default(''),
  thresholdRatio: z.number().min(0.01).max(1).default(0.8), // basic 对齐
  retainRatio: z.number().min(0.01).max(1).default(0.16), // 继承兼容键（B66）——不消费但读取一致
  maxTokens: z.number().step(1).min(1).default(8192),
  injectionEnabled: z.boolean().default(true),
  injectionTokenLimit: z.number().step(1).min(1).default(500), // 需求 §3
  injectionK: z.number().step(1).min(1).default(1), // A52：config injectionK → CaInjectConfig.k 映射链
  auto: z.boolean().default(true), // backend 自动压力触发开关（A60）
  toolTraceEnabled: z.boolean().default(true), // 7.1 P1：tool_trace 确定性投影开关
  llmTraceEnabled: z.boolean().default(true), // 7.1 P1：llm/stream 观测器开关（旁路 tee，fail-open）
  llmTraceMaxCalls: z.number().step(1).min(1).max(4096).default(256), // llm 调用记录环形上限
  toolRewriteEnabled: z.boolean().default(true), // 7.1 P4→渐进：wire 级工具结果改写开关（每轮 step1 评估，滑出保护区即替换）
  toolRewriteMinSavingChars: z.number().step(1).min(1).default(400), // 单条改写最小节省字符门槛（宁留原文）
  toolRewriteDryRun: z.boolean().default(false), // 7.1 P4→渐进验证：true = 只汇编留档不注入（executeToolRewrites 跳过），false = 正常注入
  // ---- 7.2 thought 部分（决策 44）：Fct 多事务 OODA 装配（thought+tool 合流，8-17 用户裁定）----
  oodaRewriteEnabled: z.boolean().default(false), // Fct OODA 装配开关（默认关：未实装验证前不影响现有行为）
  oodaRewriteDryRun: z.boolean().default(true), // true = 只汇编留档不注入（executeThoughtRewrites 跳过）
  oodaMinSavingChars: z.number().step(1).min(1).default(400), // 单条 thought 替换最小节省字符门槛（宁留原文）
  oodaThinkBudget: z.number().step(1).min(100).default(2000), // think 上下文总预算（buildOodaThinkContext）
  oodaBackfillUrl: z.string().default('http://127.0.0.1:11435'), // 本地 4B 端点（ollama-priority-proxy，Fct 生成）
  oodaBackfillModel: z.string().default('qwen3-4b-instruct:32k'),
  oodaBackfillTimeoutMs: z.number().step(1).min(1000).default(60000),
  oodaBackfillMaxConcurrent: z.number().step(1).min(1).max(8).default(2),
  oodaBackfillMaxQueue: z.number().step(1).min(1).max(128).default(16),
  entityGraphEnabled: z.boolean().default(true), // 7.1 P3b：跨会话实体图冷启动加载开关（fail-open）
  entityGraphDbPath: z.string().default(''), // 实体图库路径；空串 = 复用 realityDbPath
  toolBackfillEnabled: z.boolean().default(true), // 7.1 P2：后台 4B intent/outcome 回填开关（fail-open）
  toolBackfillUrl: z.string().default('http://127.0.0.1:11435'), // 本地 4B 端点（ollama-priority-proxy）
  toolBackfillModel: z.string().default('qwen3-4b-instruct:32k'),
  toolBackfillTimeoutMs: z.number().step(1).min(1000).default(30000),
  toolBackfillMaxConcurrent: z.number().step(1).min(1).max(8).default(2),
  toolBackfillMaxQueue: z.number().step(1).min(1).max(128).default(16),
  realityRecallEnabled: z.boolean().default(false), // 话题参考 reality 召回注入开关（Hermes 方向②）
  realityDbPath: z.string().default('./ca_cache/ca_topics.db'), // DSH CA 库路径（summarize-history 产物；文件缺失则功能 fail-open 停用）
  realityEmbedUrl: z.string().default('http://127.0.0.1:11435/api/embed'), // 本地 embedding 端点（Hermes 同端点）
  realityEmbedModel: z.string().default('qwen3-embedding:0.6b'),
  realityTopK: z.number().step(1).min(1).default(1), // 注入 reality 数（最终拣选数）
  realityPoolSize: z.number().step(1).min(1).default(15), // 4B 拣选候选池大小（Hermes QUERY_CLOUD_TOP_K=15）
  realityPickMode: z.union([z.const('4b'), z.const('cosine')]).default('4b'), // 拣选方式：本地 4B（Hermes 同款）或纯余弦
  realityPickUrl: z.string().default('http://127.0.0.1:11435'), // 本地 4B 端点（ollama-priority-proxy，Hermes LLM_ENDPOINT）
  realityPickModel: z.string().default('qwen3-4b-instruct:32k'), // 拣选模型
  realityMinScore: z.number().min(0).max(1).default(0.5), // 预筛余弦阈值（Hermes THETA_MAX=0.5 对齐；无候选即不注入）
  realityTokenLimit: z.number().step(1).min(1).default(500), // 注入 token 上限（同注入默认）
  compactionRetries: z.number().step(1).min(1).default(1), // 收敛重试，min=1（0 非法，F56）
  // ---- 7.3 handoff（全部初值待 P1-P5 实测标定，设计 §2.3）----
  handoffEnabled: z.boolean().default(true), // 7.3 总开关（off 时压缩/注入等 7.0-7.2 行为不变）
  handoffPressureRatio: z.number().min(0.01).max(1).default(0.8), // 7.3 handoff 压力触发线（与压缩 thresholdRatio 独立；待 P1-P5 实测标定）
  handoffMinTurns: z.number().step(1).min(1).default(6), // 首 N 轮禁用门禁（待 P1-P5 实测标定）
  handoffMaxDepth: z.number().step(1).min(1).default(1), // 深度上限：parentDepth+1 ≤ 此值（待 P1-P5 实测标定）
  handoffCooldownMs: z.number().step(1).min(0).default(300000), // 冷却窗 5 分钟（待 P1-P5 实测标定）
});

/** 命名日志器（mock ctx 缺省静默） */
function namedLogger(ctx) {
  try {
    const log = ctx?.logger?.('ca-v7');
    if (log && typeof log.info === 'function') return log;
  } catch {
    /* 忽略 */
  }
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** 自事件日志重建注入历史（B29）：source.plugin='ca-v7' 消息的 transaction_refs 命名 section */
export function rebuildInjectHistory(session) {
  /** @type {Set<number>} */
  const history = new Set();
  for (const event of session.events ?? []) {
    if (event.type !== 'user/message') continue;
    const source = event.data?.source;
    if (source?.kind !== 'plugin' || source?.plugin !== 'ca-v7') continue;
    const sections = source?.sections;
    if (!Array.isArray(sections)) continue;
    for (const section of sections) {
      if (section?.name !== 'transaction_refs') continue;
      try {
        const ids = JSON.parse(section.text);
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === 'number') history.add(id);
        }
      } catch {
        /* 畸形 section 忽略 */
      }
    }
  }
  return history;
}

/** A33 衰减记忆（内存态，非 durable）：重叠拒绝事务不再作为候选注入 */
const decayedBySession = new WeakMap();

/** 7.3 H14：注入重叠拒绝 per-session 连续计数（R1-6）；注入成功/话题切换清零 */
const rejectStreakBySession = new WeakMap();

/** 读取会话的注入重叠拒绝连续计数（陌生会话默认 0） */
export function getInjectionRejectStreak(session) {
  return rejectStreakBySession.get(session) ?? 0;
}

/** ctx → llm-trace 存储（debug/live 消费者经 getLlmTraceStore 读取；单插件实例每 ctx 一份） */
const llmTraceStores = new WeakMap();

/**
 * debug/live 读取入口：返回该 ctx 上 apply 时创建的 llm 调用观测存储。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function getLlmTraceStore(ctx) {
  return llmTraceStores.get(ctx) ?? null;
}

/**
 * 将 4B 拣选响应解析为注入候选（B1 修复，对齐 Hermes ca/inject.py `_pick_by_4b`）。
 * 返回 null 仅表示「4B 调用/解析失败，调用方应降级兜底」；
 * 返回空数组表示「4B 判定全新话题：宁缺勿错，禁止兜底注入」。
 * @param {{ status: string; picked: Array<{ index: number; relevance?: string }> }} res
 * @param {Array<{ reality: object; score: number }>} pool 预筛候选池（index 对应 4B 输入序）
 * @returns {Array<{ reality: object; relevance: string; score: number }> | null}
 */
export function resolveRealityPick(res, pool) {
  if (!res || res.status !== 'ok' || !Array.isArray(res.picked)) return null;
  const out = [];
  for (const x of res.picked) {
    if (!x || !Number.isInteger(x.index) || x.index < 0 || x.index >= pool.length) continue;
    out.push({ reality: pool[x.index].reality, relevance: x.relevance ?? '', score: pool[x.index].score });
  }
  return out;
}

/** 消息文本是否为空（token 截断到空后不得再注入，B6） */
function messageText(msg) {
  const blocks = msg?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && (b.type === 'text' || b.type === 'reasoning'))
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * 从 agent/pre-step payload.messages（本轮 inbox claim 输入）取最近一条真实 user 文本。
 * 只认 source.kind==='user'（排除 user-approval / runtime-context / skill-catalog 等
 * 插件注入消息——它们也在 claimed 列表里，但都不是用户输入）。
 * 复用 extractInjectionUserText 的 priority-0 claimed 路径（同一过滤口径，单一实现）。
 * @param {Array<{content?: Array<{type?: string; text?: string}>; source?: {kind?: string}}>|undefined} messages
 * @returns {string}
 */
function claimedUserTextOf(messages) {
  return extractInjectionUserText(undefined, undefined, messages);
}

/** 派生消息字符数：顶层 text/reasoning + tool-result 嵌套文本（与 tool-trace resultChars 同口径，避免 toolResultCharRatio 分母漏计） */
function derivedCharsOfMessage(msg) {
  let total = messageText(msg).length;
  for (const block of msg?.content ?? []) {
    if (block?.type !== 'tool-result') continue;
    for (const c of block.content ?? []) {
      if (c?.type === 'text' && typeof c.text === 'string') total += c.text.length;
    }
  }
  return total;
}

/** 话题参考 reality 召回注入（Hermes 方向②；确定性检索，无 LLM） */
async function maybeInjectReality(ctx, agent, view, config, log, claimedMessages) {
  if (!config.realityRecallEnabled) return null;
  // 当前轮 user 消息：pre-step payload.messages（本轮 inbox claim 输入，B10 权威来源）
  // 优先；view / session.events 仅作直接调用兜底——pre-step 时刻 user/message 事件尚未
  // 写入会话，view 与事件日志都取不到当前轮提问（旧版 B8 只修了事件回退，取到的是上一轮文本）。
  const userText = extractInjectionUserText(view, agent?.session, claimedMessages);
  if (!userText.trim()) return null;
  let qemb;
  try { qemb = await embedText(userText, config.realityEmbedUrl, config.realityEmbedModel); }
  catch (e) { log.warn('ca-v7 reality embed 失败：' + (e instanceof Error ? e.message : String(e))); return null; }
  if (!qemb) return null;
  const sessionId = String(agent.session?.id ?? '');
  const pool = findRealityCandidates(qemb, config.realityIndex, sessionId, {
    minScore: config.realityMinScore, topK: config.realityPoolSize ?? 15,
  });
  if (pool.length === 0) return null; // 宁缺勿错：预筛无候选即不注入
  // 拣选：4B（Hermes 同款，high 优先级）仅「调用/解析失败」时余弦兜底；
  // 4B 合法空列表（selected: []）= 宁缺勿错不注入（B1，对齐 Hermes decision 38/41）
  let picked = [];
  const mode = config.realityPickMode ?? '4b';
  if (mode === '4b') {
    let resolved = null;
    try {
      const res = await pickRealities4B(userText, pool, {
        url: config.realityPickUrl, model: config.realityPickModel, topK: config.realityTopK,
      });
      resolved = resolveRealityPick(res, pool);
    } catch (e) {
      log.warn('ca-v7 reality 4B 拣选失败：' + (e instanceof Error ? e.message : String(e)));
    }
    if (resolved === null) {
      // 4B 不可用/解析失败 → 余弦兜底 top-k（Hermes：余弦/jaccard 兜底）
      picked = pool.slice(0, config.realityTopK).map((c) => ({ reality: c.reality, relevance: '', score: c.score }));
    } else {
      picked = resolved; // 含合法空数组
    }
  } else {
    picked = pool.slice(0, config.realityTopK).map((c) => ({ reality: c.reality, relevance: '', score: c.score }));
  }
  if (picked.length === 0) return null; // 4B 判定全新话题 → 不注入（宁缺勿错）
  try {
    const { message } = buildRealityInjectionMessage(picked, { tokenLimit: config.realityTokenLimit }, (m) => ctx.tokenMeter?.estimateMessage?.(m) ?? 0);
    if (!messageText(message)) {
      log.warn('ca-v7 reality 注入在 token 上限内截断为空：跳过注入');
      return null;
    }
    log.info('ca-v7 reality 注入：' + picked.map((c) => 'R' + c.reality.reality_id + ':' + c.reality.name + (c.relevance ? '（' + c.relevance.slice(0, 30) + '…）' : '')).join(', '));
    return message;
  } catch (e) {
    log.warn('ca-v7 reality 注入构建失败：' + (e instanceof Error ? e.message : String(e)));
    return null;
  }
}

/** 会话级话题状态（Hermes TopicGradeManager 对齐：首轮 + 话题切换才注入 reality） */
const topicStates = new WeakMap();

/**
 * 7.1 P4→渐进（2026-08-17 设计修正）：工具结果改写按 resultSeq 幂等，随保护区边界滑动渐进执行。
 * 每轮 step 1 评估一次：surfaceSeqs 只计划仍可见节点（已替换即遮蔽、永不二次计划），
 * tail 硬保护保证保护区内轮次保持原文；话题切换重算定级（gradeView 冻结快照）。
 * dry-run（toolRewriteDryRun=true）：只生成汇编后 ctx 并留档，不执行 executeToolRewrites（不注入）。
 */
const toolRewriteDoneSeqs = new WeakMap(); // session → Set<resultSeq>（防御性幂等记录；surfaceSeqs 已天然过滤）

/** 统计 tool-trace 行中 4B outcome_l1 命中率（overlay 后；观测回填链路是否在真实会话生效） */
export function backfillCoverage(rows) {
  const completed = (rows ?? []).filter((r) => r?.status === 'completed');
  const withOutcome = completed.filter((r) => typeof r?.outcome_l1 === 'string' && r.outcome_l1.trim());
  return {
    completed: completed.length,
    withOutcome: withOutcome.length,
    pct: completed.length > 0 ? +((withOutcome.length / completed.length) * 100).toFixed(1) : 0,
  };
}

/** 从会话事件日志提取计划 seq 的工具结果原文（供 dry-run 归档自证；缺省空 Map） */
function rawResultTextBySeq(session, plan) {
  const map = new Map();
  try {
    const events = Array.isArray(session?.events) ? session.events : [];
    for (const item of plan ?? []) {
      if (!item || !Number.isInteger(item.seq)) continue;
      const original = events.find((e) => e?.type === 'tool/result' && e.seq === item.seq);
      const resultBlock = original?.data?.message?.content?.[0];
      if (!resultBlock || resultBlock.type !== 'tool-result' || !Array.isArray(resultBlock.content)) continue;
      const text = resultBlock.content
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      if (text) map.set(item.seq, text);
    }
  } catch {
    /* fail-open：拿不到原文则归档回退 resultSummary */
  }
  return map;
}

/**
 * 7.1 P4→渐进：每轮 step 1 评估一次工具结果改写（滑出保护区的轮次被 Fct/hdl 取代）。
 * 幂等：surfaceSeqs 只计划仍可见节点 → 已替换（被遮蔽）的行永不二次计划；tail 硬保护
 * 保证保护区内轮次保持原文；toolRewriteDoneSeqs 为防御性双保险。
 * dry-run：只留档不注入（executeToolRewrites 跳过）。返回 { applied, plan, dryRun }。
 */
function maybeRewriteToolResults(ctx, agent, engine, view, config, log) {
  if (!config.toolRewriteEnabled) return { applied: 0, plan: [], dryRun: false };
  const session = agent.session;
  try {
    let rows = snapshotToolTrace(ctx, session);
    if (rows.length === 0) {
      return { applied: 0, plan: [], dryRun: config.toolRewriteDryRun === true, backfill: { completed: 0, withOutcome: 0, pct: 0 } };
    }
    // 7.1 P2：4B 回填就绪时覆盖 L1 摘要；未就绪保持确定性摘要（fail-open）
    rows = config.toolBackfillQueue?.overlay?.(rows, session) ?? rows;
    // 观测：4B outcome_l1 实际生效率（overlay 命中数 / 已完成行数）——验证回填链路在真实会话生效
    const backfillStats = backfillCoverage(rows);
    const surfaceSeqs = new Set(Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []);
    const userElm = [...(view ?? [])].reverse().find((e) => e?.type === 'user');
    const grades = engine.gradeView(view, {
      rows,
      questionText: userElm?.text ?? '',
      graph: config.entityGraph ?? undefined,
      session, // 冻结定级状态按 session 隔离
    });
    const plan = planToolRewrites(view, rows, grades, {
      tailTurns: config.tailN,
      minSavingChars: config.toolRewriteMinSavingChars,
      surfaceSeqs,
    });
    if (plan.length === 0) return { applied: 0, plan: [], dryRun: config.toolRewriteDryRun === true, backfill: backfillStats };
    // 防御性幂等：过滤已替换 seq（正常路径 surfaceSeqs 已排除，此处双保险）
    const done = toolRewriteDoneSeqs.get(session) ?? new Set();
    const pending = plan.filter((p) => !done.has(p.seq));
    if (pending.length === 0) return { applied: 0, plan, dryRun: config.toolRewriteDryRun === true, backfill: backfillStats };
    if (config.toolRewriteDryRun) {
      const saved = pending.reduce((sum, p) => sum + (p.savingChars ?? 0), 0);
      const assembly = assembleRewrittenCtx(view, rows, grades, {
        tailTurns: config.tailN,
        minSavingChars: config.toolRewriteMinSavingChars,
        surfaceSeqs,
        rawTextBySeq: rawResultTextBySeq(session, pending), // 归档 before 存原文，留档可自证
      });
      archiveDryRun(session.id, assembly, log); // fail-open 留档（写文件失败仅告警，不影响会话）
      log.info(`ca-v7 工具结果改写[dry-run]：计划 ${pending.length} 条（约省 ${saved} 字符），不注入`);
      return { applied: 0, plan: pending, dryRun: true, backfill: backfillStats };
    }
    const applied = executeToolRewrites(session, pending);
    if (applied.length > 0) {
      for (const a of applied) done.add(a.seq);
      toolRewriteDoneSeqs.set(session, done);
      const saved = pending.reduce((sum, p) => sum + (p.savingChars ?? 0), 0);
      log.info(`ca-v7 工具结果改写：${applied.length} 条（约省 ${saved} 字符）`);
    }
    return { applied: applied.length, plan: pending, dryRun: false, backfill: backfillStats };
  } catch (error) {
    log.warn(`ca-v7 工具结果改写失败：${error instanceof Error ? error.message : String(error)}；保留原文`);
    return { applied: 0, plan: [], dryRun: config.toolRewriteDryRun === true, backfill: backfillStats };
  }
}

/** dry-run 留档（fail-open：写文件失败仅告警，不中断会话）；目录 <ca-v7>/ca_cache/ctx-assembly-dryrun/ */
function archiveDryRun(sessionId, assembly, log) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = joinPath(here, '..', 'ca_cache', 'ctx-assembly-dryrun');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(
      joinPath(dir, `${sessionId}-${stamp}.json`),
      JSON.stringify({ sessionId, generatedAt: new Date().toISOString(), ...assembly }, null, 2),
      'utf8',
    );
  } catch (error) {
    log.warn(`ca-v7 dry-run 留档失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 单次注入决策 + 构建（返回注入消息或 null） */
function maybeInject(ctx, agent, injectConfig, log) {
  const session = agent.session;
  let view;
  try {
    const snapshot = ctx.sessionProjections?.snapshot?.(session);
    view = snapshot?.values?.[VIEW_KEY];
  } catch {
    view = undefined;
  }
  if (!Array.isArray(view) || view.length === 0) return null;
  const history = rebuildInjectHistory(session);
  const decayed = decayedBySession.get(session) ?? new Set();
  for (const id of decayed) history.add(id);
  const decision = decideInjection(view, injectConfig, history);
  if (decision.action !== 'inject') return null;
  const candidates = decision.candidateTxnIds ?? [];
  const chosen = candidates.slice(0, Math.max(1, Math.floor(injectConfig.k)));
  // 重叠判定（D45/A35）：注入内容与检查点摘要 ≥20 字符重叠 → 拒绝 + 日志 + A33 衰减
  const overlap = findCheckpointOverlap(buildInjectionContent(view, chosen, injectConfig.k), session.events);
  if (overlap) {
    // 7.3 H14：连续拒绝计数（R1-6，噪声信号输入）
    rejectStreakBySession.set(session, getInjectionRejectStreak(session) + 1);
    log.warn(
      `ca-v7 注入重叠拒绝：transaction_id=${JSON.stringify(chosen)} 重叠片段="${overlap.fragment}"（≥${overlap.overlap} 字符）`,
    );
    for (const id of chosen) decayed.add(id);
    decayedBySession.set(session, decayed);
    return null;
  }
  const { message } = buildInjectionMessage(view, chosen, injectConfig, (m) => ctx.tokenMeter?.estimateMessage?.(m) ?? 0);
  if (!messageText(message)) {
    // B6：token 上限过小截断为空 → 不注入，且不写 transaction_refs/不进入注入历史
    log.warn(`ca-v7 事务注入在 token 上限内截断为空：transaction_id=${JSON.stringify(chosen)}，跳过注入`);
    return null;
  }
  rejectStreakBySession.set(session, 0); // 7.3 H14：注入成功清零
  return message;
}

/**
 * 7.3 pre-step handoff 规划（独立函数，供 pre-step 两阶段使用与测试直调）——只读信号 → 计划。
 * 不落库、不 spawn、不写 ca_signals；execute 由调用方在确认本轮 enter 后执行。
 * host（dsh-chancellor）未挂载 ctx.caHandoff 或 config.handoffEnabled=false → null（7.3 不生效，零调用）。
 * @returns {Promise<{ caHandoff: any, plan: any, records: any[] } | null>}
 */
export async function planHandoff(ctx, agent, engine, config, log, signal) {
  if (!config?.handoffEnabled) return null;
  // H13：host 缺省 → 7.3 不生效。caHandoff 未列入本插件 inject（可选宿主服务），
  // 必须经 ctx.get() 读取；直接属性访问会抛 "cannot get property without inject"。
  const caHandoff = ctx?.get?.('caHandoff');
  if (!caHandoff || typeof caHandoff.execute !== 'function') return null;
  const session = agent.session;
  const snapshot = ctx.sessionProjections?.snapshot?.(session);
  const values = snapshot?.values ?? {};
  const view = Array.isArray(values[VIEW_KEY]) ? values[VIEW_KEY] : null;
  // sessionTurns = view 去重 transaction_id 数（真实 user txn 口径，grade.js 同源）
  const sessionTurns = view
    ? new Set(view.map((e) => e.transaction_id).filter((id) => typeof id === 'number')).size
    : 0;
  const hostState = (await caHandoff.sessionState?.(session.id)) ?? {}; // 契约见任务书 C：{lastHandoffAt, existingBranchKeys, parentDepth}
  // 压力信号（H2）：measure 读数 + engine 诊断（按 session 隔离；WeakMap 存在时绝不回落到其他会话的镜像字段）。
  // handoff 优先路径不能依赖上一次压缩写入 lastContext：未做过压缩的步骤也要独立解析窗口。
  let contextWindow = engine.lastContextBySession
    ? (engine.lastContextBySession.get(session) ?? null)
    : (engine.lastContext ?? null);
  if (!contextWindow && typeof engine.resolveContextWindow === 'function') {
    try {
      contextWindow = await engine.resolveContextWindow(agent, signal ?? new AbortController().signal);
    } catch {
      contextWindow = null;
    }
  }
  const measure = ctx.tokenMeter.measure(session);
  const lastPressureAttempt = engine.lastPressureAttemptBySession
    ? (engine.lastPressureAttemptBySession.get(session) ?? null)
    : (engine.lastPressureAttempt ?? null);
  const sessionOverflowLatch = engine.overflowLatchBySession
    ? (engine.overflowLatchBySession.get(session) ?? null)
    : (engine.overflowLatch ?? null);
  const pressureThresholds = {
    ...PRESSURE_DEFAULTS,
    ratioThreshold: config.handoffPressureRatio ?? PRESSURE_DEFAULTS.ratioThreshold,
  };
  const collected = collectPressureSignals({
    measure,
    contextWindow: contextWindow ?? 0,
    lastPressureAttempt,
    overflowLatch: sessionOverflowLatch,
  }, pressureThresholds);
  // 一次性 latch：本会话消费后复位（H12），不影响其他会话
  if (sessionOverflowLatch) {
    if (engine.overflowLatchBySession) {
      engine.overflowLatchBySession.delete(session);
      if (engine.overflowLatch === sessionOverflowLatch) engine.overflowLatch = null;
    } else {
      engine.overflowLatch = null;
    }
  }
  const pressure = pressureTriggered(collected, pressureThresholds);
  // 噪声信号（H3）：topic-state 投影 + tool-trace 投影 + rejectStreak + derivedChars
  const topicStateValue = values[TOPIC_STATE_KEY] ?? {};
  const toolTraceRows = values[TOOL_TRACE_KEY] ?? [];
  let derivedChars = 0;
  for (const event of session.events ?? []) {
    const message = session.deriveEventMessage(event);
    if (message !== null) derivedChars += derivedCharsOfMessage(message);
  }
  const collectedNoise = collectNoiseSignals({
    topicState: { topicClusters: topicStateValue.topicClusters ?? 0, farRatio: topicStateValue.farRatio ?? 0 },
    toolTraceRows,
    derivedChars,
    rejectStreak: getInjectionRejectStreak(session),
    unreachableFarRatio: null, // v1 可选补充未接线（实体图不可达 FAR 比例）
  });
  const noise = noiseTriggered(collectedNoise);
  if (!pressure.triggered && !noise.triggered) return null;
  // 分支划分（H5）+ 门禁/计划（H4）
  const grades = engine.gradeView(view ?? [], { session });
  const clusters = partitionBranches(view ?? [], grades, { tailN: config.tailN });
  const plan = evaluateHandoff({
    mode: caHandoff.mode ?? 'suggest',
    now: Date.now(),
    sessionTurns,
    parentDepth: hostState.parentDepth ?? (session.header?.delegationDepth ?? 0),
    lastHandoffAt: hostState.lastHandoffAt ?? null,
    existingBranchKeys: new Set(hostState.existingBranchKeys ?? []),
    pressure,
    noise,
    clusters,
    planKind: pressure.triggered ? 'pressure' : 'noise',
    thresholds: {
      minTurns: config.handoffMinTurns,
      maxDepth: config.handoffMaxDepth,
      cooldownMs: config.handoffCooldownMs,
      tailN: config.tailN,
    },
    parentSessionId: String(session.id),
  });
  if (plan.status !== 'plan') {
    if (plan.status === 'degrade') {
      log.info(`ca-v7 handoff 降级：${plan.reason ?? ''}（回退既有压缩路径，行为与 7.2 一致）`);
    } else if (plan.status === 'idempotent') {
      log.info('ca-v7 handoff 幂等：已有同范围分支计划，跳过');
    } else {
      log.info(`ca-v7 handoff 门禁：${plan.status}${plan.reason ? '/' + plan.reason : ''}`);
    }
    return null;
  }
  // ca_signals 记录（R2-4）：只产出命中项
  const records = signalRecords(String(session.id), {
    pressure,
    noise,
    pressureData: {
      ratio: collected.ratio,
      threshold: pressureThresholds.ratioThreshold,
      totalTokens: measure.totalTokens,
      projected: lastPressureAttempt?.projected ?? null,
      thresholdTokens: lastPressureAttempt?.thresholdTokens ?? null,
      gaveUp: lastPressureAttempt?.gaveUp ?? null,
    },
    noiseData: {
      topicClusters: collectedNoise.topicClusters,
      farRatio: collectedNoise.farRatio,
      threshold: NOISE_DEFAULTS.farRatioThreshold,
      toolResultCharRatio: collectedNoise.toolResultCharRatio,
      injectionOverlapRejects: collectedNoise.injectionOverlapRejects,
    },
  });
  return { caHandoff, plan, records };
}

/**
 * 7.3 pre-step handoff 检查（兼容直调口径）——规划成功后立即执行。
 * fail-open：execute 抛错 → 捕获记 warn 返回 null（继续轮次）。
 * @returns {Promise<unknown|null>} caHandoff.execute 返回的 seal receipt message 或 null
 */
export async function runHandoffCheck(ctx, agent, engine, config, log) {
  const prepared = await planHandoff(ctx, agent, engine, config, log);
  if (!prepared) return null;
  try {
    // host 返回 seal receipt message 或 null
    return await prepared.caHandoff.execute(prepared.plan, agent, { signalRecords: prepared.records, compactionEngine: engine });
  } catch (error) {
    log.warn(`ca-v7 handoff execute 失败：${error instanceof Error ? error.message : String(error)}；继续轮次`);
    return null;
  }
}

/**
 * 插件 apply。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config 经 Config schema 校验/默认化后的配置
 */
export function apply(ctx, config) {
  try {
    // min=1 校验（schema 已拦，防御性复核，F56/F57）
    if (typeof config.tailN !== 'number' || config.tailN < 1) {
      throw new Error('tailN 必须 ≥ 1（tail 保护不可完全关闭，F57）');
    }
    if (typeof config.compactionRetries !== 'number' || config.compactionRetries < 1) {
      throw new Error('compactionRetries 必须 ≥ 1（禁重试需显式声明，F56）');
    }
    // 1. 投影注册（sessionProjections fold，纯函数；无自建事件订阅）
    ctx.sessionProjections.register(createViewProjection());
    // debug 导出缓存（projection change feed 驱动）
    ctx.sessionProjections.onChanged((session, key, value) => {
      if (key === VIEW_KEY) setSessionView(String(session.id), value);
    });
    // 1b. 7.1 P1：tool_trace 确定性投影（会话事件日志侧，可回放）+ debug 缓存
    //     7.1 P2：投影 change feed 触发后台 4B intent/outcome 回填（fail-open，不阻塞）
    const toolBackfillQueue = config.toolBackfillEnabled
      ? createToolBackfillQueue({
          url: config.toolBackfillUrl,
          model: config.toolBackfillModel,
          timeoutMs: config.toolBackfillTimeoutMs,
          maxConcurrent: config.toolBackfillMaxConcurrent,
          maxQueue: config.toolBackfillMaxQueue,
          warn: (msg) => namedLogger(ctx).warn(msg),
        })
      : null;
    if (config.toolTraceEnabled) {
      ctx.sessionProjections.register(createToolTraceProjection());
      ctx.sessionProjections.onChanged((session, key, value) => {
        if (key === TOOL_TRACE_KEY) {
          setToolTrace(String(session.id), value);
          toolBackfillQueue?.enqueue(session, value);
        }
      });
    }
    // 1c. 7.2 thought 部分（决策 44）：Fct OODA 生成队列（跨轮存活，每会话按事务入队）。
    //     默认关闭（oodaRewriteEnabled=false），开启时配合 oodaRewriteDryRun 先留档自证。
    const fctOodaQueue = config.oodaRewriteEnabled
      ? createFctOodaQueue({
          url: config.oodaBackfillUrl,
          model: config.oodaBackfillModel,
          timeoutMs: config.oodaBackfillTimeoutMs,
          maxConcurrent: config.oodaBackfillMaxConcurrent,
          maxQueue: config.oodaBackfillMaxQueue,
          warn: (msg) => namedLogger(ctx).warn(msg),
        })
      : null;
    // 1d. 7.3 handoff：topic-state 投影（话题切换累计 + 冻结定级快照，H1 噪声信号输入）。
    //     仅当 handoff 开启且宿主已挂载 ctx.caHandoff 时注册（host 缺省时 7.3 整体不生效——
    //     与 runHandoffCheck 的零调用语义一致，避免无 host 部署产生冗余投影注册）。
    if (config.handoffEnabled && ctx.get('caHandoff')) { // 可选宿主服务：ctx.get() 不触发 inject 检查
      ctx.sessionProjections.register(
        createTopicStateProjection({
          tailN: config.tailN,
          ageThresholdTurns: config.gradeAgeThresholdTurns,
          similarityThreshold: config.gradeSimilarityThreshold,
          topicSwitchEntry: config.topicSwitchEntry,
          // 水位压力话题切割透传（2026-08-18 修复：此前缺省 → 用户自定义在噪声信号投影失效）
          topicSplitStartChars: config.topicSplitStartChars,
          topicSplitPeakChars: config.topicSplitPeakChars,
          jaccardPenaltyMax: config.jaccardPenaltyMax,
          topicSplitForceAtPeak: config.topicSplitForceAtPeak,
        }),
      );
      ctx.sessionProjections.onChanged((session, key, value) => {
        if (key === TOPIC_STATE_KEY) setTopicState(String(session.id), value);
      });
    }
    // 1c. 7.1 P1：llm/stream 观测器（最接近云端 LLM 响应源头的开放接口；
    //     旁路 tee、fail-open，仅观测不修改流）
    const llmTraceStore = initLlmTraceStore({ maxCalls: config.llmTraceMaxCalls });
    llmTraceStores.set(ctx, llmTraceStore);
    if (config.llmTraceEnabled) {
      installLlmTrace(ctx, llmTraceStore, namedLogger(ctx));
    }
    // 2. 服务注册：ctx.compaction = CACompactionEngine（Service 构造即注册）
    const engine = new CACompactionEngine(ctx, {
      tailN: config.tailN,
      gradeAgeThresholdTurns: config.gradeAgeThresholdTurns,
      gradeSimilarityThreshold: config.gradeSimilarityThreshold,
      topicSwitchEntry: config.topicSwitchEntry,
      // 水位压力话题切割（2026-08-18 修复：此前未透传 → engine.gradeView 恒用默认值，
      // 用户自定义 topicSplit* 在手写 pre-step 检测外全部失效，三处水位口径不一致）
      topicSplitStartChars: config.topicSplitStartChars,
      topicSplitPeakChars: config.topicSplitPeakChars,
      jaccardPenaltyMax: config.jaccardPenaltyMax,
      topicSplitForceAtPeak: config.topicSplitForceAtPeak,
      summarizationProvider: config.summarizationProvider,
      summarizationModel: config.summarizationModel,
      thresholdRatio: config.thresholdRatio,
      retainRatio: config.retainRatio,
      maxTokens: config.maxTokens,
      auto: config.auto,
      compactionRetries: config.compactionRetries,
    });
    // 3. pre-step listener 挂载（前置注册；先压缩压力检查、后注入检查，B30）
    const injectConfig = {
      enabled: config.injectionEnabled,
      tokenLimit: config.injectionTokenLimit,
      k: config.injectionK,
    };
    const log = namedLogger(ctx);
    // reality 召回索引（CA 库 realities + centroid；文件缺失则停用，Hermes 方向②）
    const realityIndex = loadRealityIndex(config.realityDbPath);
    if (config.realityRecallEnabled && realityIndex.length === 0) {
      log.warn('ca-v7 realityRecallEnabled 但 CA 库无可用 reality 索引（' + config.realityDbPath + '），召回注入停用');
    }
    // 7.1 P3b：跨会话实体图冷启动加载（fail-open：文件缺失/损坏 → null → 会话内图）
    let coldEntityGraph = null;
    if (config.entityGraphEnabled) {
      coldEntityGraph = loadColdEntityGraph(config.entityGraphDbPath || config.realityDbPath, log);
    }
    ctx.on(
      'agent/pre-step',
      async ({ agent, step, signal, messages }, next) => {
        // B10：当前轮 user 文本取 pre-step payload.messages（本轮 inbox claim 输入）——
        // pre-step 时刻 user/message 事件尚未写入会话，view 投影与 session.events 都拿不到
        // 当前提问（只含历史轮）；claimed 消息即「当前轮真实输入」的权威来源。
        const claimedUserText = claimedUserTextOf(messages);
        // 1) handoff 优先（用户裁定 2026-08-16：到触发点先切会话，压缩仅作兜底）。
        //    step 1 先做只读规划；execute（落库/spawn/seal）等 next() 确认 enter 后才执行。
        let preparedHandoff = null;
        if (step === 1 && config.handoffEnabled) {
          try {
            preparedHandoff = await planHandoff(ctx, agent, engine, config, log, signal);
          } catch (error) {
            log.warn(`ca-v7 handoff 规划失败：${error instanceof Error ? error.message : String(error)}；回落压缩路径`);
          }
        }
        // 2) 压缩兜底：handoff 无计划时执行原位压力压缩（auto 门控）。
        //    渐进改写不再依赖压力触发（每轮 step 1 独立评估），压缩保留为兜底路径。
        if (!preparedHandoff?.plan && engine.config.auto) {
          try {
            await engine.compactIfNeeded(agent, 'pressure', signal);
          } catch (error) {
            log.warn(`ca-v7 步骤压缩失败：${error instanceof Error ? error.message : String(error)}；继续轮次`);
          }
        }
        // 3) 先行委托下游（B30：先 await next()，仅 enter 追加）
        const decision = await next();
        // 3) 注入/改写检查：仅 turn 内首个 step + 下游进入步骤
        if (decision.kind !== 'enter') return decision;
        if (step !== 1) return decision; // 非首 step 不决策（A19/T5）
        const extra = [];
        // 话题状态统一在此计算（供 reality 注入门控与 7.1 P4 工具改写触发共用）
        let switched = false;
        try {
          let view;
          try { view = ctx.sessionProjections?.snapshot?.(agent.session)?.values?.[VIEW_KEY]; } catch { view = undefined; }
          if (Array.isArray(view)) {
            const uElm = [...view].reverse().find((e) => e.type === 'user');
            const fElm = [...view].reverse().find((e) => e.type === 'fin' && e.text);
            const prevState = topicStates.get(agent.session) ?? { profile: '', seen: false };
            // 水位压力：totalChars 取话题状态投影（与 topic-state fold / engine.gradeView 同口径）
            let topicStateValue = {};
            try { topicStateValue = ctx.sessionProjections?.snapshot?.(agent.session)?.values?.[TOPIC_STATE_KEY] ?? {}; } catch { /* 投影缺省 → 水位不生效 */ }
            // B10：话题判定用当前轮 claimed 文本（pre-step 时刻 view 只有历史 user，uElm 是上一轮
            // 提问——旧版拿它做 Jaccard 与自身 profile 比对恒为延续，话题切换永不触发、reality 永不注入）。
            const sw = detectTopicSwitch(claimedUserText || (uElm?.text ?? ''), fElm?.text ?? '', prevState, config.topicSwitchEntry, {
              totalChars: topicStateValue.totalChars ?? 0,
              splitStartChars: config.topicSplitStartChars,
              splitPeakChars: config.topicSplitPeakChars,
              jaccardPenaltyMax: config.jaccardPenaltyMax,
              forceAtPeak: config.topicSplitForceAtPeak,
            });
            topicStates.set(agent.session, sw.state);
            switched = sw.switched;
            if (switched) {
              rejectStreakBySession.set(agent.session, 0); // 7.3 H14：话题切换清零（R1-6）
              toolRewriteDoneSeqs.delete(agent.session); // 渐进：新话题块重算定级，允许重新评估（surfaceSeqs 天然防重）
            }
            // 7.1 P4→渐进：每轮 step 1 评估一次工具结果改写（滑出保护区即被 Fct/hdl 取代；先改写、后注入，均尾部安全）
            maybeRewriteToolResults(ctx, agent, engine, view, { ...config, entityGraph: coldEntityGraph, toolBackfillQueue }, log);
            // 7.2 thought 部分（决策 44）：Fct 多事务 OODA 装配——thought+tool 合流。
            //   每轮 step 1 评估：tail 外事务入队生成 Fct（idempotent）→ 就绪后替换 reasoning 行
            //   （保留 tool-call block）；默认 dry-run 只留档（ca_cache/ctx-assembly-dryrun/*-ooda-*.json）。
            if (fctOodaQueue) {
              maybeRewriteThoughts(ctx, agent, view, { ...config, tailN: config.tailN, fctOodaQueue }, log, fctOodaQueue);
            }
          }
        } catch (error) {
          log.warn(`ca-v7 话题检测失败：${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          const injected = maybeInject(ctx, agent, injectConfig, log);
          if (injected) extra.push(injected);
        } catch (error) {
          log.warn(`ca-v7 事务注入失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (config.realityRecallEnabled) { // B5：reality 召回与事务注入开关正交（injectionEnabled=false 不关闭 reality）
          try {
            if (switched) { // 同话题延续轮：不注入（省 embedding/4B + 稳定尾部）
              let view;
              try { view = ctx.sessionProjections?.snapshot?.(agent.session)?.values?.[VIEW_KEY]; } catch { view = undefined; }
              const realityMsg = await maybeInjectReality(ctx, agent, view, { ...config, realityIndex }, log, messages);
              if (realityMsg) extra.push(realityMsg);
            }
          } catch (error) {
            log.warn(`ca-v7 reality 注入失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // 4) 7.3 handoff 执行（规划在压缩前已完成；本轮 enter 才执行，host 缺省/无计划时零调用）
        if (preparedHandoff?.plan) {
          try {
            const receipt = await preparedHandoff.caHandoff.execute(preparedHandoff.plan, agent, { signalRecords: preparedHandoff.records, compactionEngine: engine });
            if (receipt) extra.push(receipt);
          } catch (error) {
            log.warn(`ca-v7 handoff 检查失败：${error instanceof Error ? error.message : String(error)}；继续轮次`);
          }
        }
        if (extra.length > 0) {
          // durable 尾部追加（缓存命中约束：不插入历史中间，不破坏前缀缓存）
          return { ...decision, messages: [...decision.messages, ...extra] };
        }
        return decision;
      },
      true, // 前置注册
    );
  } catch (error) {
    // apply 异常 catch + 日志不冒泡（F51：插件 apply 异常不影响会话正常收发）
    namedLogger(ctx).warn(`ca-v7 apply 异常（已捕获不冒泡）：${error instanceof Error ? error.message : String(error)}`);
  }
}
