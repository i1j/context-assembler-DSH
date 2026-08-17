/**
 * ca-v7 7.3 H2/H3 — handoff-metrics 单测（任务书 A §3.2，红线基线，主笔/测试线）。
 * 覆盖：压力三信号（ratio/b55/overflow）、噪声 AND/OR 组合、signalRecords 契约枚举（R2-4）。
 */
import { describe, it, expect } from 'vitest';
import {
  collectPressureSignals,
  pressureTriggered,
  collectNoiseSignals,
  noiseTriggered,
  signalRecords,
  PRESSURE_DEFAULTS,
  NOISE_DEFAULTS,
} from '../lib/handoff-metrics.js';

describe('handoff-metrics 压力信号（H2）', () => {
  it('ratio：totalTokens/contextWindow；contextWindow=0 → null', () => {
    expect(collectPressureSignals({ measure: { totalTokens: 8000 }, contextWindow: 10000, lastPressureAttempt: null, overflowLatch: null }).ratio).toBeCloseTo(0.8, 5);
    expect(collectPressureSignals({ measure: { totalTokens: 8000 }, contextWindow: 0, lastPressureAttempt: null, overflowLatch: null }).ratio).toBeNull();
  });

  it('b55NonConvergent：ratio≥阈 && lastPressureAttempt.gaveUp===true 才命中', () => {
    const gaveUp = { projected: 9000, thresholdTokens: 8000, gaveUp: true };
    const ok = { projected: 9000, thresholdTokens: 8000, gaveUp: false };
    expect(collectPressureSignals({ measure: { totalTokens: 9000 }, contextWindow: 10000, lastPressureAttempt: gaveUp, overflowLatch: null }).b55NonConvergent).toBe(true);
    expect(collectPressureSignals({ measure: { totalTokens: 9000 }, contextWindow: 10000, lastPressureAttempt: ok, overflowLatch: null }).b55NonConvergent).toBe(false);
    expect(collectPressureSignals({ measure: { totalTokens: 7000 }, contextWindow: 10000, lastPressureAttempt: gaveUp, overflowLatch: null }).b55NonConvergent).toBe(false); // 低于阈
    expect(collectPressureSignals({ measure: { totalTokens: 9000 }, contextWindow: 10000, lastPressureAttempt: null, overflowLatch: null }).b55NonConvergent).toBe(false);
  });

  it('overflow：overflowLatch!=null 且 recovered===false', () => {
    expect(collectPressureSignals({ measure: { totalTokens: 0 }, contextWindow: 10000, lastPressureAttempt: null, overflowLatch: { recovered: false } }).overflow).toBe(true);
    expect(collectPressureSignals({ measure: { totalTokens: 0 }, contextWindow: 10000, lastPressureAttempt: null, overflowLatch: { recovered: true } }).overflow).toBe(false);
    expect(collectPressureSignals({ measure: { totalTokens: 0 }, contextWindow: 10000, lastPressureAttempt: null, overflowLatch: null }).overflow).toBe(false);
  });

  it('pressureTriggered：hits 只含命中项（ratio/b55/overflow）', () => {
    const p = { ratio: 0.85, b55NonConvergent: true, overflow: false };
    const r = pressureTriggered(p);
    expect(r.triggered).toBe(true);
    expect(r.hits.sort()).toEqual(['b55', 'ratio']);
    expect(pressureTriggered({ ratio: null, b55NonConvergent: false, overflow: false }).triggered).toBe(false);
  });

  it('pressureTriggered：支持 config.handoffPressureRatio 覆写（0.79 不触发 / 0.81 触发）', () => {
    const thresholds = { ratioThreshold: 0.80 };
    expect(pressureTriggered({ ratio: 0.79, b55NonConvergent: false, overflow: false }, thresholds).triggered).toBe(false);
    expect(pressureTriggered({ ratio: 0.81, b55NonConvergent: false, overflow: false }, thresholds).triggered).toBe(true);
    // 边界：恰好等于阈值 → 触发（≥）
    expect(pressureTriggered({ ratio: 0.80, b55NonConvergent: false, overflow: false }, thresholds).hits).toContain('ratio');
  });

  it('collectPressureSignals：b55 判定跟随覆写阈值（低于覆写线不命中）', () => {
    const gaveUp = { projected: 9000, thresholdTokens: 8000, gaveUp: true };
    const thresholds = { ratioThreshold: 0.90 };
    expect(collectPressureSignals(
      { measure: { totalTokens: 8500 }, contextWindow: 10000, lastPressureAttempt: gaveUp, overflowLatch: null },
      thresholds,
    ).b55NonConvergent).toBe(false);
    expect(collectPressureSignals(
      { measure: { totalTokens: 9500 }, contextWindow: 10000, lastPressureAttempt: gaveUp, overflowLatch: null },
      thresholds,
    ).b55NonConvergent).toBe(true);
  });
});

describe('handoff-metrics 噪声信号（H3）', () => {
  const base = { topicClusters: 2, farRatio: 0.65, toolResultCharRatio: 0.85, injectionOverlapRejects: 3, unreachableFarRatio: 0.6 };
  const baseData = { topicState: { topicClusters: 2, farRatio: 0.65 }, toolTraceRows: [], derivedChars: 1000, rejectStreak: 3, unreachableFarRatio: 0.6 };

  it('collectNoiseSignals：derivedChars<=0 → toolResultCharRatio=null', () => {
    const n = collectNoiseSignals({ topicState: { topicClusters: 2, farRatio: 0.65 }, toolTraceRows: [{ resultChars: 850 }], derivedChars: 0, rejectStreak: 3, unreachableFarRatio: 0.6 });
    expect(n.toolResultCharRatio).toBeNull();
    const n2 = collectNoiseSignals({ topicState: { topicClusters: 2, farRatio: 0.65 }, toolTraceRows: [{ resultChars: 850 }], derivedChars: 1000, rejectStreak: 3, unreachableFarRatio: 0.6 });
    expect(n2.toolResultCharRatio).toBeCloseTo(0.85, 5);
  });

  it('单信号命中不触发（topicClusters 达阈但 hits<2）', () => {
    const n = { topicClusters: 2, farRatio: 0.65, toolResultCharRatio: null, injectionOverlapRejects: 0, unreachableFarRatio: null };
    expect(noiseTriggered(n).triggered).toBe(false);
  });

  it('AND/OR 组合精确：topicClusters≥2 且其余 4 项 ≥2 命中才触发；null 值不命中', () => {
    // 2 项命中 → 触发
    expect(noiseTriggered(base).triggered).toBe(true);
    expect(noiseTriggered(base).hits.sort()).toEqual(['farRatio', 'injectionOverlapRejects', 'toolResultCharRatio', 'unreachableFarRatio']);
    // 仅 1 项命中 → 不触发
    expect(noiseTriggered({ ...base, toolResultCharRatio: null, injectionOverlapRejects: 0, unreachableFarRatio: null }).triggered).toBe(false);
    // topicClusters < 2 → 不触发（其余全命中也不行）
    expect(noiseTriggered({ ...base, topicClusters: 1 }).triggered).toBe(false);
    // 阈值边界：farRatio 恰好 0.60 → 命中（≥）
    expect(noiseTriggered({ ...base, farRatio: 0.60, toolResultCharRatio: null, injectionOverlapRejects: 0, unreachableFarRatio: null }).triggered).toBe(false); // 只有 1 项命中
  });

  it('signalRecords：只产出命中项，kind 枚举 ∈ R2-4 契约集合', () => {
    const pressure = { triggered: true, hits: ['ratio'] };
    const noise = { triggered: true, hits: ['farRatio'] };
    const pressureData = { ratio: 0.83, threshold: PRESSURE_DEFAULTS.ratioThreshold, totalTokens: 12345 };
    const noiseData = { farRatio: 0.61, threshold: NOISE_DEFAULTS.farRatioThreshold };
    const recs = signalRecords('s1', { pressure, noise, pressureData, noiseData });
    const kinds = recs.map((r) => r.kind);
    expect(kinds).toContain('pressure_ratio');
    expect(kinds).toContain('noise_far_ratio');
    expect(kinds).not.toContain('pressure_overflow'); // 未命中不产出
    const ratioRec = recs.find((r) => r.kind === 'pressure_ratio')!;
    expect(JSON.parse(ratioRec.valueJson).totalTokens).toBe(12345);
  });
});
