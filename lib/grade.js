/**
 * 最小定级（lib/grade.js）——结构化启发式，不依赖 embedding（A2 定稿）。
 *
 * 规则组合结构（design §3.3 判定流程）：
 *   1. tail 保护：真实 user turn 序号 ∈ [总真实 user turn - N+1, 总真实 user turn]（N=2，仅计 source.kind='user'）→ ACT
 *   2. 轮次年龄：turn 与当前 turn 差距 ≥ ageThresholdTurns（暂定 6）→ 候选 FAR
 *   3. 文本相似度：与相邻后续 turn 的 user 文本相似度 ≥ similarityThreshold（暂定 0.5，
 *      LCS 归一化（C32 定一）：相似度 = LCS(相邻 user 文本)/较短文本长度——复用 overlap.js
 *      maxCommonSubstring 单一基元语义（B5/C7））→ REL（同话题延续）；低于阈值且年龄达标 → FAR
 *   4. 其余 → ACT
 * 阈值随真实数据回填（A12/D17/D49）。
 *
 * 说明：视图事务模型「1 事务 = 1 turn」（design §3.1），真实 user 事务 ID 会话内 1..M 连续，
 * 故 gradeTurn(view, turnNo) 的 turnNo 以视图事务 ID 为轮次身份（synthetic turn 不产生事务、
 * 不占名额，R6 A24）。
 */
import { maxCommonSubstring } from './overlap.js';

/** 最小定级默认配置（与 §4.1 CaPluginConfig 默认一致） */
export const DEFAULT_GRADE_CONFIG = {
  tailN: 2,
  ageThresholdTurns: 6,
  similarityThreshold: 0.5,
};

/** 按 transaction_id 分组视图 Elm（保序） */
export function groupByTxn(view) {
  /** @type {Map<number, any[]>} */
  const map = new Map();
  for (const elm of view ?? []) {
    const list = map.get(elm.transaction_id) ?? [];
    list.push(elm);
    map.set(elm.transaction_id, list);
  }
  return map;
}

/**
 * 对单个事务/轮次定级。
 * @param {any[]} view 视图 Elm 列表（rich 形态，含 text 字段）
 * @param {number} turnNo 事务 ID（轮次身份）
 * @param {{ tailN?: number; ageThresholdTurns?: number; similarityThreshold?: number }} [config]
 * @returns {'ACT'|'REL'|'FAR'}
 */
export function gradeTurn(view, turnNo, config = DEFAULT_GRADE_CONFIG) {
  // tail 保护不可完全关闭（F57 语义）：0/负数钳制为 1
  const tailN = Math.max(1, config.tailN ?? DEFAULT_GRADE_CONFIG.tailN);
  const ageThresholdTurns = config.ageThresholdTurns ?? DEFAULT_GRADE_CONFIG.ageThresholdTurns;
  const similarityThreshold = config.similarityThreshold ?? DEFAULT_GRADE_CONFIG.similarityThreshold;
  const txns = groupByTxn(view);
  const txnIds = [...txns.keys()].sort((x, y) => x - y);
  const total = txnIds.length;
  const index = txnIds.indexOf(turnNo);
  if (index === -1 || total === 0) return 'ACT'; // 不存在的事务防御为 ACT
  const ordinal = index + 1; // 真实 user 轮次序号（1 起）
  // 1. tail 保护：真实 user turn 序号 ∈ [total-N+1, total] → ACT（含 total <= N 全量 ACT）
  if (total - ordinal + 1 <= tailN) return 'ACT';
  // 2. 轮次年龄：与当前 turn 差距 < ageThresholdTurns → ACT
  const current = txnIds[txnIds.length - 1];
  const age = current - turnNo;
  if (age < ageThresholdTurns) return 'ACT';
  // 3. 文本相似度：与相邻后续 turn 的 user 文本 LCS 归一化
  const nextId = txnIds[index + 1];
  const userText = (id) => (txns.get(id) ?? []).find((e) => e.type === 'user')?.text ?? '';
  const a = userText(turnNo);
  const b = nextId === undefined ? '' : userText(nextId);
  const shorter = Math.min(a.length, b.length);
  if (shorter <= 0) return 'FAR';
  const similarity = maxCommonSubstring(a, b) / shorter;
  return similarity >= similarityThreshold ? 'REL' : 'FAR';
}

/**
 * 对视图全部事务定级（engine/视图导出复用）。
 * @param {any[]} view 视图 Elm 列表（rich 形态）
 * @param {{ tailN?: number; ageThresholdTurns?: number; similarityThreshold?: number }} [config]
 * @returns {Map<number, 'ACT'|'REL'|'FAR'>}
 */
export function gradeTransactions(view, config = DEFAULT_GRADE_CONFIG) {
  /** @type {Map<number, 'ACT'|'REL'|'FAR'>} */
  const grades = new Map();
  const txns = groupByTxn(view);
  for (const id of [...txns.keys()].sort((x, y) => x - y)) {
    grades.set(id, gradeTurn(view, id, config));
  }
  return grades;
}
