/**
 * ca-v7 7.3 E1-E5 — edge-strength 单测（任务书 B §3.1，红线基线，主笔/测试线）。
 * 覆盖：赫布式饱和/衰减半衰期/确认三条件/可逆降级/成本排序淘汰。
 */
import { describe, it, expect } from 'vitest';
import {
  emptyEdge,
  hebbianUpdate,
  dwellDelta,
  applySignal,
  decayWeight,
  decayEdge,
  evaluateStatus,
  edgeCost,
  rankEdges,
  evictWeakEdges,
  EDGE_DEFAULTS,
  EDGE_KIND,
} from '../lib/edge-strength.js';

describe('E1 赫布式饱和更新', () => {
  it('w ← w + δ(1−w)；首次 w=δ', () => {
    expect(hebbianUpdate(0, 0.15)).toBeCloseTo(0.15, 5);
    expect(hebbianUpdate(0.15, 0.15)).toBeCloseTo(0.2775, 5);
  });
  it('dwellDelta：dwellMs 基准 0.01，同停留按时长累加、上限 0.03', () => {
    expect(dwellDelta(1200)).toBeCloseTo(0.01, 5);
    expect(dwellDelta(2400)).toBeCloseTo(0.02, 5);
    expect(dwellDelta(3600)).toBeCloseTo(0.03, 5);
    expect(dwellDelta(100000)).toBeCloseTo(0.03, 5); // 上限饱和
    expect(dwellDelta(100)).toBeCloseTo(0.01, 5);    // 不足 1 单位按 1 计
  });
  it('click δ=0 只埋点；anchor δ=0.15', () => {
    const e = emptyEdge('a', 'b');
    const clicked = applySignal(e, { signal: 'click', durationMs: 0, nowSec: 100 });
    expect(clicked.weight).toBe(0);
    expect(clicked.n_click).toBe(1);
    expect(clicked.last_seen_at).toBe(100);
    expect(e.n_click).toBe(0); // 不改入参
    const anchored = applySignal(e, { signal: 'anchor', durationMs: 0, nowSec: 100 });
    expect(anchored.weight).toBeCloseTo(0.15, 5);
    expect(anchored.n_anchor).toBe(1);
  });
  it('dwell：weight 累加 + n_dwell+1；未知信号返回副本', () => {
    const e = applySignal(emptyEdge('a', 'b'), { signal: 'dwell', durationMs: 2400, nowSec: 100 });
    expect(e.weight).toBeCloseTo(0.02, 5);
    expect(e.n_dwell).toBe(1);
    const e2 = applySignal(e, { signal: 'dwell', durationMs: 1200, nowSec: 101 });
    expect(e2.weight).toBeCloseTo(hebbianUpdate(0.02, 0.01), 5);
    expect(e2.n_dwell).toBe(2);
    const same = applySignal(e2, { signal: 'unknown', durationMs: 0, nowSec: 102 });
    expect(same).toEqual(e2);
    expect(same).not.toBe(e2);
  });
});

describe('E2 指数衰减（λ=0.05/day → 14 天半衰期）', () => {
  it('14 天衰减到 ~0.5；0 天不变', () => {
    expect(decayWeight(1, 14)).toBeCloseTo(Math.exp(-0.7), 5);
    expect(decayWeight(1, 0)).toBeCloseTo(1, 5);
  });
  it('decayEdge：last_seen_at null → 原样副本（惰性语义）', () => {
    const e = emptyEdge('a', 'b');
    const d = decayEdge(e, 200);
    expect(d).toEqual(e);
    expect(d).not.toBe(e);
  });
  it('decayEdge：按 last_seen_at 距今惰性衰减', () => {
    const e = applySignal(emptyEdge('a', 'b'), { signal: 'dwell', durationMs: 2400, nowSec: 100 });
    const d = decayEdge(e, 100 + 14 * 86400);
    expect(d.weight).toBeCloseTo(e.weight * Math.exp(-0.7), 5);
  });
  it('decayEdge：时钟回拨按 0 天处理，不反向增权', () => {
    const e = applySignal(emptyEdge('a', 'b'), { signal: 'dwell', durationMs: 2400, nowSec: 100 });
    const d = decayEdge(e, 99);
    expect(d.weight).toBe(e.weight);
  });
});

describe('E3 确认三条件', () => {
  it('n_anchor≥1 && w≥θ && last_seen 新鲜(≤14d) 才 confirmed', () => {
    const fresh = 1_000_000;
    const mk = (weight: number, anchor: number, lastSeen: number, status: string = 'weak') =>
      evaluateStatus({ ...emptyEdge('a', 'b'), weight, n_anchor: anchor, last_seen_at: lastSeen, status }, fresh);
    expect(mk(0.15, 1, fresh - 100).status).toBe('confirmed');
    expect(mk(0.09, 1, fresh - 100).status).toBe('weak');            // w<θ
    expect(mk(0.15, 0, fresh - 100).status).toBe('weak');            // 无 anchor
    expect(mk(0.15, 1, fresh - 15 * 86400).status).toBe('weak');     // 不新鲜
  });
  it('首次 anchor 直接 confirmed（w=δ=0.15 ≥ θ）', () => {
    const e = applySignal(emptyEdge('a', 'b'), { signal: 'anchor', durationMs: 0, nowSec: 1_000_000 });
    expect(e.weight).toBeCloseTo(0.15, 5);
    const s = evaluateStatus(e, 1_000_000);
    expect(s.status).toBe('confirmed');
    expect(s.confirmed_at).toBeTruthy();
  });
  it('纯 dwell 永不 confirmed', () => {
    let e = emptyEdge('a', 'b');
    for (let i = 0; i < 20; i += 1) e = applySignal(e, { signal: 'dwell', durationMs: 3600, nowSec: 1_000_000 + i });
    const s = evaluateStatus(e, 1_000_000 + 20);
    expect(s.status).toBe('weak');
  });
});

describe('E4 可逆降级（hysteresis=0.10）', () => {
  it('confirmed 且 w < θ(1−hysteresis)=0.09 → weak + degraded_at', () => {
    const e = applySignal(emptyEdge('a', 'b'), { signal: 'anchor', durationMs: 0, nowSec: 1_000_000 });
    const decayed = decayEdge(e, 1_000_000 + 400 * 86400); // 长时衰减 w→~0
    const s = evaluateStatus(decayed, 1_000_000 + 400 * 86400);
    expect(s.status).toBe('weak');
    expect(s.degraded_at).toBeTruthy();
  });
  it('confirmed 且 w ≥ θ(1−hysteresis) → 保持 confirmed', () => {
    const e = applySignal(emptyEdge('a', 'b'), { signal: 'anchor', durationMs: 0, nowSec: 1_000_000 });
    const s = evaluateStatus(e, 1_000_000);
    expect(s.status).toBe('confirmed');
    expect(s.degraded_at).toBeFalsy();
  });
});

describe('E5 成本/排序/淘汰', () => {
  it('edgeCost = 1/(w+ε)，ε=0.01', () => {
    expect(edgeCost(0.15)).toBeCloseTo(1 / 0.16, 5);
    expect(edgeCost(0)).toBeCloseTo(100, 5);
  });
  it('rankEdges：w 降序、confirmed 优先', () => {
    const edges = [
      { from_key: '1', to_key: 'a', weight: 0.5, status: 'weak' },
      { from_key: '2', to_key: 'b', weight: 0.2, status: 'confirmed' },
      { from_key: '3', to_key: 'c', weight: 0.9, status: 'weak' },
    ];
    const ranked = rankEdges(edges);
    expect(ranked[0].to_key).toBe('b'); // confirmed 优先
    expect(ranked[1].to_key).toBe('c');
    expect(ranked[2].to_key).toBe('a');
  });
  it('evictWeakEdges：只淘汰 weak 中 w 最低者使 ≤64；confirmed 不淘汰', () => {
    const weak = Array.from({ length: 70 }, (_, i) => ({ from_key: 'f', to_key: 'w' + i, weight: i / 100, status: 'weak' }));
    const confirmed = [{ from_key: 'f', to_key: 'c0', weight: 0.5, status: 'confirmed' }];
    const { kept, evicted } = evictWeakEdges([...weak, ...confirmed]);
    expect(kept.length).toBe(65); // 64 weak + 1 confirmed
    expect(kept).toContain(confirmed[0]);
    expect(evicted.length).toBe(6);
    expect(evicted.every((e) => e.status === 'weak')).toBe(true);
    // 被淘汰的是 w 最低的 6 个
    expect(evicted.map((e) => e.to_key)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
  });
});
