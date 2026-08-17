/**
 * 7.3 handoff 规划纯计算（lib/handoff-plan.js）——设计 §2.3/§4.1/§3.2，纯函数、无存储。
 *
 * - partitionBranches：按 txn 簇过滤（tailN 硬保护排除 / FAR 作边界切断 / 簇含 ≥1 REL 才候选）；
 * - branchKey / buildPackageKey：幂等键（node:crypto sha1，确定性）；
 * - evaluateHandoff：五门禁（mode/首 N 轮/深度/冷却/幂等）→ 触发（压力或噪声）→ 0 分支 DEGRADE / N≥1 PLAN。
 *
 * 阈值全部为初值（待 P1-P5 实测标定），不得改设计数值。
 */
import { createHash } from 'node:crypto';
import { groupByTxn } from './grade.js';

/** 门禁与划分初值（待 P1-P5 实测标定，设计 §2.3） */
export const HANDOFF_DEFAULTS = {
  minTurns: 6, // 首 N 轮禁用（待 P1-P5 实测标定；与 gradeAgeThresholdTurns 默认一致）
  maxDepth: 1, // 深度上限（待 P1-P5 实测标定；只允许一层 handoff 子会话）
  cooldownMs: 300000, // 冷却窗 5 分钟（待 P1-P5 实测标定）
  tailN: 2, // 分支划分 tail 硬保护（与 grade.js 同源）
};

/** 排序后 seq 列表 → 连续段分组 [[s,e],...]（事件 seq，非 surface 位置） */
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
 * §4.1 按 txn 簇过滤（纯函数）。
 * 规则：txnIds = 排序后的真实 user 事务 id（groupByTxn(view) 的 keys）剔除 tail 保护（末 tailN 个）；
 * 剩余序列按 FAR 切断成连续簇（FAR 自身单独成簇）；簇内含 ≥1 REL → 候选（纯 ACT/FAR 簇丢弃）；
 * seqRanges = 簇内全部 Elm 的 elm_ref 排序后连续段分组 [[s,e],...]（事件 seq，非 surface 位置）。
 * @param {any[]} view 视图 rich Elm 列表
 * @param {Map<number,'ACT'|'REL'|'FAR'>} grades engine.gradeView 冻结定级
 * @returns {Array<{ sourceTxnStart:number, sourceTxnEnd:number, txnIds:number[], seqRanges:number[][] }>}
 */
export function partitionBranches(view, grades, { tailN } = {}) {
  const tail = tailN ?? HANDOFF_DEFAULTS.tailN;
  const txns = groupByTxn(view);
  const allIds = [...txns.keys()].sort((a, b) => a - b);
  // 冻结定级 Map 是划分权威：
  // - 整图为空（无任何定级信息）→ 全部 txn 保守视为同话题延续（REL）成单簇（mock/退化兜底）；
  // - 部分覆盖 → 未定级 txn 不进 handoff 考量（无法定级不交接），参与集合 = ids ∩ grades.keys()。
  const gradeOf = (id) => grades.get(id) ?? 'REL';
  const gradedIds = grades.size > 0 ? allIds.filter((id) => grades.has(id)) : allIds;
  const kept = gradedIds.slice(0, Math.max(0, gradedIds.length - tail));
  const rawClusters = [];
  let run = [];
  for (const id of kept) {
    // 部分覆盖时未定级 txn 被过滤后可能留下 id 间隙：间隙必须切断，
    // 否则 sourceTxnStart/End 会跨过不参与交接的 txn，branchKey 与全量覆盖簇碰撞。
    if (run.length > 0 && id !== run[run.length - 1] + 1) {
      rawClusters.push(run);
      run = [];
    }
    if (gradeOf(id) === 'FAR') {
      if (run.length > 0) rawClusters.push(run);
      rawClusters.push([id]); // FAR 作边界并单独成簇（无 REL → 候选时丢弃）
      run = [];
    } else {
      run.push(id);
    }
  }
  if (run.length > 0) rawClusters.push(run);
  const candidates = [];
  for (const cluster of rawClusters) {
    if (!cluster.some((id) => gradeOf(id) === 'REL')) continue; // 纯 ACT/FAR 簇不进 handoff
    const seqs = cluster
      .flatMap((id) => (txns.get(id) ?? []).map((elm) => elm.elm_ref))
      .filter((seq) => Number.isInteger(seq))
      .sort((a, b) => a - b);
    candidates.push({
      sourceTxnStart: cluster[0],
      sourceTxnEnd: cluster[cluster.length - 1],
      txnIds: cluster,
      seqRanges: contiguousRanges(seqs),
    });
  }
  return candidates;
}

/** 分支幂等键：`${parentSessionId}:${sourceTxnStart}-${sourceTxnEnd}` */
export function branchKey(parentSessionId, cluster) {
  return `${parentSessionId}:${cluster.sourceTxnStart}-${cluster.sourceTxnEnd}`;
}

/**
 * §3.2 包幂等键（node:crypto sha1，确定性）：
 * `${parent}:${planKind}:${minStart}-${maxEnd}:${sha1(候选txnIds逗号串).slice(0,8)}`
 * 候选 txnIds = 全部 branch.txnIds 展平排序；minStart/maxEnd 取分支范围并集。
 */
export function buildPackageKey(parentSessionId, planKind, branches) {
  const txnIds = branches.flatMap((b) => b.txnIds).sort((a, b) => a - b);
  const minStart = Math.min(...branches.map((b) => b.sourceTxnStart));
  const maxEnd = Math.max(...branches.map((b) => b.sourceTxnEnd));
  const digest = createHash('sha1').update(txnIds.join(',')).digest('hex').slice(0, 8);
  return `${parentSessionId}:${planKind}:${minStart}-${maxEnd}:${digest}`;
}

/**
 * 触发 FSM 门禁与计划（纯函数，门禁顺序 = §2.3 全满足才 plan）。
 * parentSessionId 为可选扩展（plan.packageKey 的 parent 段；任务书 §3.3 直调签名未含，
 * 调用方（runHandoffCheck）传入实际会话 id；缺省为空串，幂等门禁按键后缀匹配）。
 * @returns
 *   { status:'off' } | { status:'gated', reason }（min-turns|max-depth|cooldown|no-trigger）|
 *   { status:'idempotent' } | { status:'degrade', reason:'no_branch' } |
 *   { status:'plan', kind, branches, packageKey, pressure, noise }
 */
export function evaluateHandoff({
  mode,
  now,
  sessionTurns,
  parentDepth,
  lastHandoffAt,
  existingBranchKeys,
  pressure,
  noise,
  clusters,
  planKind,
  thresholds,
  parentSessionId,
}) {
  const t = { ...HANDOFF_DEFAULTS, ...(thresholds ?? {}) };
  if (mode === 'off') return { status: 'off' };
  if (sessionTurns < t.minTurns) return { status: 'gated', reason: 'min-turns' };
  if ((parentDepth ?? 0) + 1 > t.maxDepth) return { status: 'gated', reason: 'max-depth' };
  if (lastHandoffAt != null && now - lastHandoffAt < t.cooldownMs) {
    return { status: 'gated', reason: 'cooldown', coolDownLeftMs: t.cooldownMs - (now - lastHandoffAt) };
  }
  const branches = clusters ?? [];
  const existing = existingBranchKeys ?? new Set();
  // 幂等（R2-1）：任一 branchKey ∈ existingBranchKeys → 不进入 EVALUATE。
  // 有 parentSessionId 时只接受本父会话的落库键（`parent:start-end` 全形）精确匹配，
  // 避免 host 传全量键时其他父会话的同范围分支被误吞；无 parent 才按 `:start-end` 后缀匹配。
  const idempotent = branches.some((cluster) => {
    const range = `${cluster.sourceTxnStart}-${cluster.sourceTxnEnd}`;
    if (parentSessionId) {
      const full = branchKey(parentSessionId, cluster);
      return [...existing].some((key) => typeof key === 'string' && key === full);
    }
    return [...existing].some(
      (key) => typeof key === 'string' && (key === range || key.endsWith(`:${range}`)),
    );
  });
  if (idempotent) return { status: 'idempotent' };
  if (!pressure?.triggered && !noise?.triggered) return { status: 'gated', reason: 'no-trigger' };
  if (branches.length === 0) return { status: 'degrade', reason: 'no_branch' };
  return {
    status: 'plan',
    kind: planKind,
    branches,
    packageKey: buildPackageKey(parentSessionId ?? '', planKind, branches),
    pressure,
    noise,
  };
}
