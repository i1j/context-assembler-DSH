/**
 * ca-v7 7.3 edge-strength —— 弱边强度纯计算模块（任务书 B §3.1，设计 §6）。
 *
 * - 赫布式饱和更新：w ← w + δ(1−w)（首次 w=δ；click δ=0 只埋点）
 * - 指数衰减：w ← w·exp(−λ·Δt)，λ=0.05/day，读取时惰性（14 天半衰期）
 * - 确认三条件：n_anchor≥1 && w≥θ(0.10) && last_seen 新鲜(≤14d)；纯 dwell 永不确认
 * - 可逆降级：confirmed 且 w < θ(1−hysteresis)（hysteresis=0.10）→ weak + degraded_at
 * - 成本/排序/淘汰：cost = 1/(w+ε)，ε=0.01；confirmed 优先；弱边出度上限 64 淘汰最低 w
 *
 * 纯函数模块：无 host 单例、无 IO、不 import 其他 lib（环依赖约束 §6）。
 */

export const EDGE_KIND = 'co_attends';

/**
 * 全部初值待 P1-P5 实测标定（设计 §6）——不得改设计数值。
 *   clickDelta=0：click 只埋点不计权（§6.1）
 *   dwellDelta=0.01 / dwellMs=1200 / dwellMaxDelta=0.03：同一停留按时长累加、单次上限（§6.2）
 *   anchorDelta=0.15：锚点（明确共现证据）权重增量（§6.1）
 *   lambdaPerDay=0.05：指数衰减率（14 天半衰期，§6.3）
 *   confirmTheta=0.10 / freshDays=14：确认阈值与新鲜窗口（§6.4）
 *   hysteresis=0.10：降级回差（§6.4）
 *   epsilon=0.01：成本分母平滑（§6.5）
 *   maxWeakEdgesPerNode=64：弱边出度上限（§6.7）
 */
export const EDGE_DEFAULTS = {
  clickDelta: 0, dwellDelta: 0.01, dwellMs: 1200, dwellMaxDelta: 0.03,
  anchorDelta: 0.15, lambdaPerDay: 0.05, confirmTheta: 0.10, freshDays: 14,
  hysteresis: 0.10, epsilon: 0.01, maxWeakEdgesPerNode: 64,
};

/** 新建空边（§6.4 status 初始 weak） */
export function emptyEdge(fromKey, toKey) {
  return {
    from_key: fromKey, to_key: toKey, kind: EDGE_KIND,
    weight: 0, n_click: 0, n_dwell: 0, n_anchor: 0,
    last_seen_at: null, status: 'weak', confirmed_at: null, degraded_at: null,
  };
}

/** 赫布式饱和更新：w + δ(1−w)（首次 w=δ） */
export function hebbianUpdate(w, delta) {
  return w + delta * (1 - w);
}

/** dwell 信号强度：按 dwellMs 取整计次、dwellDelta 累加、上限 dwellMaxDelta */
export function dwellDelta(durationMs, cfg = EDGE_DEFAULTS) {
  return Math.min(cfg.dwellDelta * Math.max(1, Math.round(durationMs / cfg.dwellMs)), cfg.dwellMaxDelta);
}

/**
 * 应用一个信号，返回新对象（不改入参）。
 *   click:  仅 n_click+1、last_seen_at=nowSec（weight 不变，δ=0 只埋点）
 *   dwell:  weight=hebbianUpdate(weight, dwellDelta(durationMs))、n_dwell+1
 *   anchor: weight=hebbianUpdate(weight, anchorDelta)、n_anchor+1
 *   未知信号：原样返回副本
 */
export function applySignal(edge, { signal, durationMs, nowSec, cfg = EDGE_DEFAULTS }) {
  const next = { ...edge };
  switch (signal) {
    case 'click':
      next.n_click = edge.n_click + 1;
      next.last_seen_at = nowSec;
      break;
    case 'dwell':
      next.weight = hebbianUpdate(edge.weight, dwellDelta(durationMs, cfg));
      next.n_dwell = edge.n_dwell + 1;
      next.last_seen_at = nowSec;
      break;
    case 'anchor':
      next.weight = hebbianUpdate(edge.weight, cfg.anchorDelta);
      next.n_anchor = edge.n_anchor + 1;
      next.last_seen_at = nowSec;
      break;
    default:
      break;
  }
  return next;
}

/** 指数衰减：w · exp(−λ·daysElapsed)，读取时惰性调用 */
export function decayWeight(w, daysElapsed, cfg = EDGE_DEFAULTS) {
  return w * Math.exp(-cfg.lambdaPerDay * daysElapsed);
}

/** 按 last_seen_at 距今惰性衰减；last_seen_at null → 原样副本。时钟回拨（nowSec < last_seen_at）按 0 天处理，禁止负天数反向增权。 */
export function decayEdge(edge, nowSec, cfg = EDGE_DEFAULTS) {
  const next = { ...edge };
  if (edge.last_seen_at == null) return next;
  const daysElapsed = Math.max(0, (nowSec - edge.last_seen_at) / 86400);
  next.weight = decayWeight(edge.weight, daysElapsed, cfg);
  return next;
}

/**
 * 状态评估（§6.4）→ { status, confirmed_at, degraded_at }
 *   确认：n_anchor≥1 && w≥θ && last_seen 新鲜(≤freshDays) → confirmed（confirmed_at 首次评估时刻）
 *   降级：n_anchor≥1 且 w < θ(1−hysteresis) → weak + degraded_at（含输入 status 已 confirmed 的衰减可逆降级）
 *   其余：保持 edge.status
 *   纯 dwell（n_anchor=0）永不确认。
 */
export function evaluateStatus(edge, nowSec, cfg = EDGE_DEFAULTS) {
  const fresh = edge.last_seen_at != null && (nowSec - edge.last_seen_at) <= cfg.freshDays * 86400;
  if (edge.n_anchor >= 1 && edge.weight >= cfg.confirmTheta && fresh) {
    return { status: 'confirmed', confirmed_at: edge.confirmed_at ?? nowSec, degraded_at: edge.degraded_at ?? null };
  }
  if (edge.n_anchor >= 1 && edge.weight < cfg.confirmTheta * (1 - cfg.hysteresis)) {
    return { status: 'weak', confirmed_at: edge.confirmed_at ?? null, degraded_at: edge.degraded_at ?? nowSec };
  }
  return { status: edge.status, confirmed_at: edge.confirmed_at ?? null, degraded_at: edge.degraded_at ?? null };
}

/** 边成本 = 1/(w+ε)（§6.5） */
export function edgeCost(w, cfg = EDGE_DEFAULTS) {
  return 1 / (w + cfg.epsilon);
}

/** w 降序、confirmed 优先的副本排序（不改入参） */
export function rankEdges(edges) {
  return [...edges].sort((a, b) => {
    if ((a.status === 'confirmed') !== (b.status === 'confirmed')) return a.status === 'confirmed' ? -1 : 1;
    return b.weight - a.weight;
  });
}

/**
 * 弱边淘汰（§6.7）：只淘汰 status==='weak' 中 w 最低者使 kept.length ≤ max；
 * confirmed 永不淘汰。返回 { kept, evicted }（副本，不改入参）。
 */
export function evictWeakEdges(edges, max = EDGE_DEFAULTS.maxWeakEdgesPerNode) {
  const confirmed = edges.filter((e) => e.status === 'confirmed');
  const weak = rankEdges(edges.filter((e) => e.status !== 'confirmed'));
  const keptWeak = weak.slice(0, max);
  // 淘汰者按 w 升序返回（最低者在前，便于审计/持久化删除序）
  return { kept: [...confirmed, ...keptWeak], evicted: weak.slice(max).reverse() };
}
