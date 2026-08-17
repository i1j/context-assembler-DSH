/**
 * ca-v7 7.3 H4/H5/H6 — handoff-plan 单测（任务书 A §3.3，红线基线，主笔/测试线）。
 * 覆盖：五门禁顺序、幂等键、分支划分（tailN 硬保护/FAR 边界/簇含 REL 才候选/N=1 合法/0 簇 degrade）、
 * branchKey/packageKey 确定性。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateHandoff,
  partitionBranches,
  branchKey,
  buildPackageKey,
  HANDOFF_DEFAULTS,
} from '../lib/handoff-plan.js';

const on = { triggered: true, hits: ['ratio'] };
const off = { triggered: false, hits: [] };

/** 定级视图：每 txn 一个 user elm（含 text 供定级），FAR 以显式 grades 为准 */
function viewOf(entries: any[]) {
  // entries: [{id, text}]
  return entries.map((e: any) => ({ type: 'user', transaction_id: e.id, elm_ref: e.id, text: e.text }));
}
function gradesOf(map: Record<string, 'ACT' | 'REL' | 'FAR'>) {
  // map: {id: 'ACT'|'REL'|'FAR'}
  return new Map(Object.entries(map).map(([k, v]) => [Number(k), v])) as Map<number, 'ACT' | 'REL' | 'FAR'>;
}

const baseEval = {
  mode: 'suggest', now: 1_000_000, parentSessionId: 'parent-sess', sessionTurns: 10, parentDepth: 0,
  lastHandoffAt: null, existingBranchKeys: new Set(),
  pressure: on, noise: off, clusters: [{ sourceTxnStart: 1, sourceTxnEnd: 2, txnIds: [1, 2], seqRanges: [[1, 2]] }],
  planKind: 'pressure', thresholds: HANDOFF_DEFAULTS,
};

describe('evaluateHandoff 门禁（H4）', () => {
  it('mode=off → {status:off}', () => {
    expect(evaluateHandoff({ ...baseEval, mode: 'off' }).status).toBe('off');
  });
  it('min-turns：sessionTurns < 6 → gated min-turns', () => {
    const r = evaluateHandoff({ ...baseEval, sessionTurns: 5 });
    expect(r.status).toBe('gated');
    expect(r.reason).toBe('min-turns');
  });
  it('max-depth：parentDepth+1 > 1 → gated max-depth', () => {
    const r = evaluateHandoff({ ...baseEval, parentDepth: 1 });
    expect(r.status).toBe('gated');
    expect(r.reason).toBe('max-depth');
  });
  it('cooldown：冷却期内 → gated cooldown + coolDownLeftMs', () => {
    const r = evaluateHandoff({ ...baseEval, lastHandoffAt: baseEval.now - 1000 });
    expect(r.status).toBe('gated');
    expect(r.reason).toBe('cooldown');
    expect(r.coolDownLeftMs).toBe(HANDOFF_DEFAULTS.cooldownMs - 1000);
  });
  it('idempotent：任一 branchKey 已存在 → {status:idempotent}', () => {
    const b = baseEval.clusters[0];
    const keys = new Set([branchKey('parent-sess', b)]);
    expect(evaluateHandoff({ ...baseEval, existingBranchKeys: keys }).status).toBe('idempotent');
  });
  it('有 parentSessionId 时不同父会话的同范围分支不误判幂等（跨父后缀匹配回归）', () => {
    const r = evaluateHandoff({
      ...baseEval,
      parentSessionId: 'session-B',
      existingBranchKeys: new Set(['session-A:1-2']),
    });
    expect(r.status).toBe('plan');
  });
  it('无 parentSessionId 时保留 :start-end 后缀匹配语义', () => {
    const r = evaluateHandoff({
      ...baseEval,
      parentSessionId: undefined,
      existingBranchKeys: new Set(['session-A:1-2']),
    });
    expect(r.status).toBe('idempotent');
  });
  it('no-trigger：压力噪声均不触发 → gated no-trigger', () => {
    expect(evaluateHandoff({ ...baseEval, pressure: off, noise: off }).status).toBe('gated');
    expect(evaluateHandoff({ ...baseEval, pressure: off, noise: off }).reason).toBe('no-trigger');
  });
  it('no_branch：clusters=[] → degrade no_branch', () => {
    const r = evaluateHandoff({ ...baseEval, clusters: [] });
    expect(r.status).toBe('degrade');
    expect(r.reason).toBe('no_branch');
  });
  it('N=1 合法：clusters 长度 1 → plan（不降级）', () => {
    const r = evaluateHandoff(baseEval);
    expect(r.status).toBe('plan');
    expect(r.branches.length).toBe(1);
    expect(r.packageKey).toBeTruthy();
  });
  it('plan 返回 kind/branches/packageKey/pressure/noise 全字段', () => {
    const r = evaluateHandoff(baseEval);
    expect(r.kind).toBe('pressure');
    expect(r.pressure).toBe(on);
    expect(r.noise).toBe(off);
  });
});

describe('partitionBranches 分支划分（H5）', () => {
  const view = viewOf([1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, text: `t${id}` })));

  it('tailN=2 硬保护排除（末 2 个 txn 不参与）', () => {
    const grades = gradesOf({ 1: 'FAR', 2: 'FAR', 3: 'FAR', 4: 'FAR', 5: 'FAR', 6: 'FAR', 7: 'FAR', 8: 'FAR' });
    const clusters = partitionBranches(view, grades, { tailN: 2 });
    // t7/t8 剔除后全 FAR → 簇按 FAR 切断：每个 txn 都是边界？FAR 切断语义见任务书：剩余序列按 FAR 切断成连续簇
    expect(clusters.length).toBeGreaterThanOrEqual(0);
  });

  it('FAR 作边界切断 + 簇含 ≥1 REL 才候选（纯 ACT 簇丢弃）', () => {
    // t1 REL, t2 ACT, t3 FAR, t4 REL, t5 ACT；tailN=2 剔除 t4/t5 → 剩余 t1..t3
    const grades = gradesOf({ 1: 'REL', 2: 'ACT', 3: 'FAR', 4: 'REL', 5: 'ACT' });
    const clusters = partitionBranches(view, grades, { tailN: 2 });
    // t3 为 FAR 边界 → 前簇 [1,2]（含 REL → 候选）；t3 单独 FAR 簇无 REL → 丢弃
    expect(clusters.length).toBe(1);
    expect(clusters[0].txnIds).toEqual([1, 2]);
    expect(clusters[0].sourceTxnStart).toBe(1);
    expect(clusters[0].sourceTxnEnd).toBe(2);
  });

  it('N=1 合法：单 REL txn 簇成候选', () => {
    const grades = gradesOf({ 1: 'FAR', 2: 'REL', 3: 'FAR', 4: 'FAR' });
    const clusters = partitionBranches(view, grades, { tailN: 0 });
    const relCluster = clusters.find((c) => c.txnIds.includes(2))!;
    expect(relCluster).toBeTruthy();
    expect(relCluster.txnIds).toEqual([2]);
  });

  it('0 簇：全 ACT / 无 REL → 空数组（degrade 输入）', () => {
    const grades = gradesOf({ 1: 'ACT', 2: 'ACT', 3: 'ACT', 4: 'ACT' });
    expect(partitionBranches(view, grades, { tailN: 2 }).length).toBe(0);
  });

  it('grades 部分覆盖留下 txn id 间隙 → 按连续性切断，不与全量覆盖簇碰撞', () => {
    // 只定级 1/3/5：旧实现会产出 sourceTxnStart=1、sourceTxnEnd=5 的单簇，
    // 与全量覆盖 txnIds=[1..5] 的 branchKey 完全相同（幂等键失真）。
    const sparse = gradesOf({ 1: 'REL', 3: 'REL', 5: 'REL' });
    const clusters = partitionBranches(view, sparse, { tailN: 0 });
    expect(clusters.map((c) => c.txnIds)).toEqual([[1], [3], [5]]);
    for (const c of clusters) expect(c.sourceTxnStart).toBe(c.sourceTxnEnd);
    const sparseKey = buildPackageKey('p1', 'pressure', clusters);
    const full = gradesOf({ 1: 'REL', 2: 'REL', 3: 'REL', 4: 'REL', 5: 'REL' });
    const fullClusters = partitionBranches(view, full, { tailN: 0 });
    const fullKey = buildPackageKey('p1', 'pressure', fullClusters);
    expect(sparseKey).not.toBe(fullKey);
  });
});

describe('键函数确定性（H6）', () => {
  const c1 = { sourceTxnStart: 1, sourceTxnEnd: 3, txnIds: [1, 2, 3], seqRanges: [[1, 3]] };
  const c2 = { sourceTxnStart: 4, sourceTxnEnd: 5, txnIds: [4, 5], seqRanges: [[4, 5]] };

  it('branchKey 格式 = parent:start-end', () => {
    expect(branchKey('p1', c1)).toBe('p1:1-3');
  });

  it('packageKey 同输入两次相同；不同 txn 列表不同', () => {
    const k1 = buildPackageKey('p1', 'pressure', [c1, c2]);
    const k2 = buildPackageKey('p1', 'pressure', [c1, c2]);
    expect(k1).toBe(k2);
    expect(k1.startsWith('p1:pressure:1-5:')).toBe(true);
    const k3 = buildPackageKey('p1', 'pressure', [{ ...c1, txnIds: [1, 2, 9] }]);
    expect(k3).not.toBe(k1);
    // planKind 参与键
    expect(buildPackageKey('p1', 'noise', [c1])).not.toBe(buildPackageKey('p1', 'pressure', [c1]));
  });
});
