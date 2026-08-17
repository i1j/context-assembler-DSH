/**
 * 会话话题状态投影（lib/topic-state.js）——7.3 handoff 噪声信号输入（R2-6）。
 *
 * 纯 fold 投影（与 view.js 同族 init/apply/view 契约，state 为 plain JSON）：
 *   - detectTopicSwitch 的累计状态（profile/seen/topicClusters：话题切换累计簇数）；
 *   - gradeTransactions 的冻结定级快照（切换时重算、块内新 txn 补 ACT——与
 *     lib/topic-grade.js gradeTransactionsStable 冻结语义一致）。
 *
 * 事务编号规则与 view.js 完全同口径：
 *   - 真实 user/message（source.kind==='user'）开新事务（transaction_id = nextTxnId++）；
 *   - plugin 注入/压缩检查点、synthetic turn 一律忽略（不开事务、不占名额）；
 *   - turn/end 闭合 openTxn；assistant/message 文本更新 lastFinText（话题检测 fin 输入）。
 *
 * 切换检测时机（对齐 topic-grade.updateTopicProfile 的视图级口径）：
 *   detectTopicSwitch 的 text = 本轮 user 文本 + 本轮 fin 文本同时可得时才检测——即
 *   turn/end（fin 已知）执行。若在 user/message 时用上一轮 fin 检测，本轮 fin 尚未并入
 *   profile，会把「user 文本无公共词、但 fin 延续上一话题」的延续轮误判为切换（H1 夹具）。
 *
 * 供 index.js 注册 ca-v7/topic-state 投影 + handoff-metrics 读 {topicClusters, farRatio}。
 */
import { z } from 'zod';
import { detectTopicSwitch } from './topic-switch.js';
import { gradeTransactions } from './grade.js';

/** 投影键 */
export const TOPIC_STATE_KEY = 'ca-v7/topic-state';
/** 投影 stateVersion（序列化字段/语义变化时 bump）——v2：+ 话题块边界输出（blocks，供前端话题块层级） */
export const TOPIC_STATE_VERSION = 2;

/** 冻结定级配置默认（与 grade.js DEFAULT_GRADE_CONFIG 一致）；topicSwitchEntry=0 最保守（除强制短语/首轮外永不切换） */
export const DEFAULT_TOPIC_STATE_CONFIG = {
  tailN: 2,
  ageThresholdTurns: 6,
  similarityThreshold: 0.5,
  topicSwitchEntry: 0,
  // 水位压力（Hermes _apply_water_pressure 移植，2026-08-17 用户裁定）：
  // ctx 字符越多话题切割越主动；peak 及以上 forceAtPeak 无条件切割。
  topicSplitStartChars: 5000,
  topicSplitPeakChars: 20000,
  jaccardPenaltyMax: 0.30,
  topicSplitForceAtPeak: true,
};

/** debug 导出缓存：sessionId → viewTopicState 产物（index.js 经 sessionProjections.onChanged 填充） */
const sessionTopicStates = new Map();
/** debug 缓存 FIFO 上限（长跑进程多会话下有界，超出淘汰最旧） */
const TOPIC_STATE_CACHE_MAX = 128;

/** 写入某会话的话题状态缓存（debug 导出数据源；由 index.js 的投影 change feed 驱动） */
export function setTopicState(sessionId, value) {
  sessionTopicStates.set(sessionId, value);
  if (sessionTopicStates.size > TOPIC_STATE_CACHE_MAX) {
    sessionTopicStates.delete(sessionTopicStates.keys().next().value);
  }
}

/** 清空缓存（测试隔离辅助） */
export function clearTopicStates() {
  sessionTopicStates.clear();
}

/** fold 初始状态（JSON 可序列化） */
export function initTopicState() {
  return {
    seen: false,
    profile: '',
    totalChars: 0, // 累计 ctx 字符（user+fin 文本，跨话题不清零；水位压力输入）
    lastFinText: '',
    nextTxnId: 1, // 与 view.js 相同事务编号规则（真实 user 开新事务）
    openTxn: null, // { transaction_id, text }（当前开放的真实 user 事务）
    userTurns: [], // [{ transaction_id, text }] 已闭合事务，供冻结定级
    topicClusters: 0, // 话题切换累计簇数
    grades: {}, // 冻结定级快照 { txnId: 'ACT'|'REL'|'FAR' }（plain object，JSON 可序列化）
    maxTxnId: 0,
    // v2 话题块边界：openBlock = 当前开放块（首个事务时开）；blocks = 已闭合块。
    // 切换轮（turn/end 判定 switched）立即闭合 openBlock 并以本轮事务开新块——
    // 块 startTxnId 序列即前端「话题块层级」的切分点（首块 startTxnId=1）。
    openBlock: null, // { index, startTxnId, label } | null
    blocks: [], // [{ index, startTxnId, label }]（闭合块，按 index 升序）
  };
}

/** 消息文本首行（话题块 label；与 view.js 事务标签同口径：首行 48 字符） */
function firstLine(text, max = 48) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '');
  return line === undefined ? '' : line.slice(0, max);
}

/** 提取消息文本（text/reasoning 块拼接；user 用 data.content，assistant 用 data.message.content） */
function extractText(data) {
  const msg = data?.message ?? data;
  const blocks = msg?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && (b.type === 'text' || b.type === 'reasoning'))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('');
}

/**
 * fold 纯函数 apply：前态 + 一个已提交事件 → 后态。
 * 处理 user/message(source.kind==='user')、assistant/message、turn/end；其余返回同引用。
 * @param {ReturnType<initTopicState>} state
 * @param {{ type: string; data?: any }} event
 * @param {{ tailN?: number; ageThresholdTurns?: number; similarityThreshold?: number }} [config]
 */
export function applyTopicState(state, event, config = {}) {
  const cfg = { ...DEFAULT_TOPIC_STATE_CONFIG, ...(config ?? {}) };
  switch (event?.type) {
    case 'user/message': {
      const source = event.data?.source;
      if (source?.kind !== 'user') return state; // plugin 注入/检查点不开事务（view.js 同口径）
      const text = extractText(event.data);
      const txnId = state.nextTxnId;
      // 闭合上一开放事务 → userTurns；本轮作为 openTxn 跟踪直至 turn/end
      const userTurns = state.openTxn ? [...state.userTurns, state.openTxn] : state.userTurns;
      // v2 话题块：首个事务开首块（openBlock 为 null 时；切换后由 turn/end 置新块）
      const openBlock = state.openBlock
        ? state.openBlock
        : { index: state.blocks.length + 1, startTxnId: txnId, label: firstLine(text) };
      return {
        ...state,
        nextTxnId: txnId + 1,
        openTxn: { transaction_id: txnId, text },
        userTurns,
        totalChars: state.totalChars + text.length,
        openBlock,
      };
    }
    case 'assistant/message': {
      const text = extractText(event.data);
      if (!text) return state; // 空内容不改 lastFinText
      return text === state.lastFinText ? state : { ...state, lastFinText: text, totalChars: state.totalChars + text.length };
    }
    case 'turn/end': {
      // 闭合 openTxn（synthetic turn 无 openTxn → 不占名额、不检测）
      const current = state.openTxn;
      if (!current) return state;
      let next = { ...state, userTurns: [...state.userTurns, current], openTxn: null };
      // 切换检测在 turn/end（本轮 user + fin 均已知）执行
      const sw = detectTopicSwitch(current.text, next.lastFinText, { profile: next.profile, seen: next.seen }, cfg.topicSwitchEntry ?? 0, {
        totalChars: next.totalChars,
        splitStartChars: cfg.topicSplitStartChars,
        splitPeakChars: cfg.topicSplitPeakChars,
        jaccardPenaltyMax: cfg.jaccardPenaltyMax,
        forceAtPeak: cfg.topicSplitForceAtPeak,
      });
      if (sw.switched) {
        // 切换：累计簇数 + 用当前 userTurns（含本轮，刚闭合）构造最小 view Elms 重算冻结定级
        const elms = next.userTurns.map((t) => ({ type: 'user', transaction_id: t.transaction_id, text: t.text }));
        const graded = gradeTransactions(elms, cfg);
        const grades = {};
        for (const [id, g] of graded) grades[id] = g;
        // v2 话题块：仅真实切换（state.seen 已 true；首轮初始化切换只计簇不开块）闭合当前块、
        // 以本轮事务开新块——切换轮立即归属新话题；块 startTxnId 序列即前端话题块层级切分点。
        let blocks = next.blocks;
        let openBlock = next.openBlock;
        if (state.seen && next.openBlock) {
          blocks = [...next.blocks, { ...next.openBlock }];
          openBlock = { index: blocks.length + 1, startTxnId: current.transaction_id, label: firstLine(current.text) };
        }
        next = {
          ...next,
          topicClusters: next.topicClusters + 1,
          grades,
          maxTxnId: next.userTurns.reduce((max, t) => Math.max(max, t.transaction_id), 0),
          blocks,
          openBlock,
        };
      }
      return { ...next, profile: sw.state.profile, seen: sw.state.seen };
    }
    default:
      return state; // turn/start、step/*、tool/*、compaction/* 等忽略（零下游工作契约）
  }
}

/**
 * 视图产物：{ topicClusters, grades(冻结快照+块内新txn补ACT), farRatio, totalGraded, totalChars }。
 * 冻结期新 txn（id > maxTxnId 且已闭合，即 userTurns 内）补 'ACT' 后计算 farRatio = FAR/(FAR+REL+ACT)。
 * totalChars 必须随 view 输出（2026-08-18 修复：sessionProjections.snapshot 返回
 * schema.parse(view(state))——view 不暴露 totalChars 则 pre-step / engine.gradeView 读
 * values[TOPIC_STATE_KEY].totalChars 恒为 0，水位压力运行时永不生效）。
 * @param {ReturnType<initTopicState>} state
 */
export function viewTopicState(state) {
  const grades = { ...(state.grades ?? {}) };
  for (const t of state.userTurns ?? []) {
    if (t.transaction_id > state.maxTxnId && grades[t.transaction_id] === undefined) {
      grades[t.transaction_id] = 'ACT';
    }
  }
  const ids = Object.keys(grades).map(Number);
  const totalGraded = ids.length;
  const farCount = ids.filter((id) => grades[id] === 'FAR').length;
  return {
    topicClusters: state.topicClusters ?? 0,
    grades,
    farRatio: totalGraded > 0 ? farCount / totalGraded : 0,
    totalGraded,
    totalChars: state.totalChars ?? 0,
    // v2 话题块边界（前端话题块层级切分点）：闭合块 + 开放块（若有）
    blocks: [...(state.blocks ?? []), ...(state.openBlock ? [{ ...state.openBlock }] : [])],
  };
}

/** 投影内部 state zod schema（JSON 可序列化；grades 为 plain object，不用 Map；仅供调试/校验内部 fold） */
const turnSchema = z.object({
  transaction_id: z.number().int(),
  text: z.string(),
});
const topicBlockSchema = z.object({
  index: z.number().int().positive(),
  startTxnId: z.number().int().positive(),
  label: z.string(),
});
export const topicStateSchema = z.object({
  seen: z.boolean(),
  profile: z.string(),
  lastFinText: z.string(),
  nextTxnId: z.number().int(),
  openTxn: z.union([turnSchema, z.null()]),
  userTurns: z.array(turnSchema),
  topicClusters: z.number().int(),
  grades: z.record(z.string(), z.enum(['ACT', 'REL', 'FAR'])),
  maxTxnId: z.number().int(),
  openBlock: z.union([topicBlockSchema, z.null()]),
  blocks: z.array(topicBlockSchema),
});

/**
 * 投影 view 产物 zod schema（与 sessionProjections 契约一致：schema 校验的是 view 输出，
 * 不是内部 fold state）。viewTopicState 产出 {topicClusters, grades, farRatio, totalGraded,
 * totalChars, blocks}。
 * 回归（2026-08-16 压测）：错用 state schema 会使真实 DSH snapshot 抛 ZodError，handoff 永远规划失败。
 */
export const topicStateViewSchema = z.object({
  topicClusters: z.number().int(),
  grades: z.record(z.string(), z.enum(['ACT', 'REL', 'FAR'])),
  farRatio: z.number(),
  totalGraded: z.number().int(),
  totalChars: z.number().int(), // 2026-08-18：水位压力运行时输入（view 缺此字段则 pre-step/engine 恒读 0）
  blocks: z.array(topicBlockSchema), // v2：话题块边界（前端话题块层级切分点）
});

/** 注册用 ProjectionDefinition（key/schema/init/apply/view/stateVersion，与 view.js 同款） */
export function createTopicStateProjection(config = {}) {
  return {
    key: TOPIC_STATE_KEY,
    schema: topicStateViewSchema,
    init: initTopicState,
    apply: (state, event) => applyTopicState(state, event, config),
    view: viewTopicState,
    stateVersion: TOPIC_STATE_VERSION,
  };
}
