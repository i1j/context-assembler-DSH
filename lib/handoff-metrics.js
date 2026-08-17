/**
 * 7.3 handoff 信号纯计算（lib/handoff-metrics.js）——设计 §2.1/§2.2，纯函数、无存储。
 *
 * 压力信号（PressureSignals）：ratio / b55NonConvergent / overflow——
 *   ratio = tokenMeter.measure(session).totalTokens / contextWindow；
 *   b55NonConvergent = ratio ≥ 阈值 且 最近一次压力检查 B55 放弃（lastPressureAttempt.gaveUp）；
 *   overflow = 溢出恢复一次性 latch（engine.overflowLatch）recovered===false（pre-step 消费后复位）。
 *
 * 噪声信号（NoiseSignals）：topicClusters / farRatio（ca-v7/topic-state 投影）+ toolResultCharRatio
 * （tool-trace 投影）/ injectionOverlapRejects（rejectStreak）/ unreachableFarRatio（v1 未接线）；
 * 触发 = topicClusters ≥ 2 且其余 4 项至少命中 2 项（AND/OR，null 值不命中）。
 *
 * signalRecords 产出 ca_signals 记录（契约枚举 R2-4），只含命中项；valueJson 为信号明细。
 */

/** 压力信号阈值初值（待 P1-P5 实测标定，设计 §2.1） */
export const PRESSURE_DEFAULTS = {
  ratioThreshold: 0.80, // ratio = totalTokens/contextWindow（待 P1-P5 实测标定）
};

/** 噪声信号阈值初值（待 P1-P5 实测标定，设计 §2.2） */
export const NOISE_DEFAULTS = {
  topicClustersMin: 2, // 话题切换累计簇数下限（待 P1-P5 实测标定）
  farRatioThreshold: 0.60, // 冻结定级 FAR 占比（待 P1-P5 实测标定）
  toolResultCharRatioThreshold: 0.80, // 工具结果字符占比（历史实测 82%，待 P1-P5 实测标定）
  injectionOverlapRejectsMin: 3, // 重叠拒绝连续次数（待 P1-P5 实测标定）
  unreachableFarRatioThreshold: 0.50, // 实体图不可达 FAR 占比（待 P1-P5 实测标定）
  extraHitsRequired: 2, // 除 topicClusters 外需命中项数（待 P1-P5 实测标定）
};

/**
 * 压力信号收集（纯函数）。
 * @param {object} thresholds 可选阈值覆写（默认 PRESSURE_DEFAULTS）；调用方传 config.handoffPressureRatio。
 * @returns {{ ratio: number|null, b55NonConvergent: boolean, overflow: boolean }}
 *   ratio = contextWindow>0 ? measure.totalTokens/contextWindow : null
 */
export function collectPressureSignals(
  { measure, contextWindow, lastPressureAttempt, overflowLatch },
  thresholds = PRESSURE_DEFAULTS,
) {
  const ratio = contextWindow > 0 ? measure.totalTokens / contextWindow : null;
  const b55NonConvergent =
    ratio !== null && ratio >= thresholds.ratioThreshold && lastPressureAttempt?.gaveUp === true;
  const overflow = overflowLatch != null && overflowLatch.recovered === false;
  return { ratio, b55NonConvergent, overflow };
}

/**
 * 压力触发判定。
 * @returns {{ triggered: boolean, hits: string[] }} hits ∈ ratio|b55|overflow（只含命中项）
 */
export function pressureTriggered(p, thresholds = PRESSURE_DEFAULTS) {
  const hits = [];
  if (p.ratio !== null && p.ratio >= thresholds.ratioThreshold) hits.push('ratio');
  if (p.b55NonConvergent) hits.push('b55');
  if (p.overflow) hits.push('overflow');
  return { triggered: hits.length > 0, hits };
}

/**
 * 噪声信号收集（纯函数）。
 * @returns {{ topicClusters:number, farRatio:number, toolResultCharRatio:number|null,
 *             injectionOverlapRejects:number, unreachableFarRatio:number|null }}
 *   derivedChars<=0 → toolResultCharRatio=null
 */
export function collectNoiseSignals({ topicState, toolTraceRows, derivedChars, rejectStreak, unreachableFarRatio }) {
  const toolResultCharRatio =
    derivedChars > 0
      ? (toolTraceRows ?? []).reduce((sum, row) => sum + (row?.resultChars ?? 0), 0) / derivedChars
      : null;
  return {
    topicClusters: topicState?.topicClusters ?? 0,
    farRatio: topicState?.farRatio ?? 0,
    toolResultCharRatio,
    injectionOverlapRejects: rejectStreak ?? 0,
    unreachableFarRatio: unreachableFarRatio ?? null,
  };
}

/**
 * 噪声触发判定：topicClusters ≥ topicClustersMin 且其余 4 项 ≥ extraHitsRequired 项命中；null 值不命中。
 * @returns {{ triggered: boolean, hits: string[] }}
 *   hits ∈ farRatio|toolResultCharRatio|injectionOverlapRejects|unreachableFarRatio（只含命中项）
 */
export function noiseTriggered(n, thresholds = NOISE_DEFAULTS) {
  const hits = [];
  if (n.farRatio >= thresholds.farRatioThreshold) hits.push('farRatio');
  if (n.toolResultCharRatio !== null && n.toolResultCharRatio >= thresholds.toolResultCharRatioThreshold) {
    hits.push('toolResultCharRatio');
  }
  if (n.injectionOverlapRejects >= thresholds.injectionOverlapRejectsMin) hits.push('injectionOverlapRejects');
  if (n.unreachableFarRatio !== null && n.unreachableFarRatio >= thresholds.unreachableFarRatioThreshold) {
    hits.push('unreachableFarRatio');
  }
  const triggered = n.topicClusters >= thresholds.topicClustersMin && hits.length >= thresholds.extraHitsRequired;
  return { triggered, hits };
}

/** 压力命中 → ca_signals kind（契约枚举 R2-4） */
const PRESSURE_KINDS = {
  ratio: 'pressure_ratio',
  b55: 'pressure_b55',
  overflow: 'pressure_overflow',
};

/** 噪声命中 → ca_signals kind（契约枚举 R2-4；unreachableFarRatio 无契约枚举槽位，不产出） */
const NOISE_KINDS = {
  farRatio: 'noise_far_ratio',
  toolResultCharRatio: 'noise_tool_result_ratio',
  injectionOverlapRejects: 'noise_injection_overlap_reject',
};

/**
 * ca_signals 记录组装（契约枚举 R2-4）；只产出命中项。
 * valueJson 例 { ratio:0.83, threshold:0.80, totalTokens:12345 }（明细由调用方按 kind 组装）。
 * @returns {Array<{ kind: string, valueJson: string }>}
 */
export function signalRecords(sessionId, { pressure, noise, pressureData, noiseData }) {
  void sessionId; // 记录不带 sessionId（落库时由 host 补）
  const records = [];
  for (const hit of pressure?.hits ?? []) {
    const kind = PRESSURE_KINDS[hit];
    if (kind) records.push({ kind, valueJson: JSON.stringify(pressureData ?? {}) });
  }
  for (const hit of noise?.hits ?? []) {
    const kind = NOISE_KINDS[hit];
    if (kind) records.push({ kind, valueJson: JSON.stringify(noiseData ?? {}) });
  }
  if (noise?.triggered && Number.isFinite(noiseData?.topicClusters)) {
    records.push({
      kind: 'noise_topic_clusters',
      valueJson: JSON.stringify({ topicClusters: noiseData.topicClusters, threshold: NOISE_DEFAULTS.topicClustersMin }),
    });
  }
  return records;
}
