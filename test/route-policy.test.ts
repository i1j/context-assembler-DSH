/**
 * ca-v7 7.3 E9 — route-policy 单测（任务书 B §3.3，红线基线，主笔/测试线）。
 * 覆盖：purpose 派生（R1-5）、RouteDecision.strategy 三值预留 + v1 只收 single（D-14）、
 * policyTable 匹配/目录校验/透传、humanOverride 优先。
 */
import { describe, it, expect } from 'vitest';
import {
  derivePurpose,
  assertRouteDecision,
  decideRoute,
  ROUTE_STRATEGIES,
} from '../lib/route-policy.js';

describe('E9 route-policy', () => {
  it('derivePurpose：step1=main，step>1=tool-continuation（R1-5）', () => {
    expect(derivePurpose(1)).toBe('main');
    expect(derivePurpose(2)).toBe('tool-continuation');
    expect(derivePurpose(5)).toBe('tool-continuation');
  });

  it('ROUTE_STRATEGIES 三值预留（single/fanout/ensemble）', () => {
    expect(ROUTE_STRATEGIES).toEqual(['single', 'fanout', 'ensemble']);
  });

  it('assertRouteDecision：v1 只收 single；fanout/ensemble 显式拒绝（D-14）', () => {
    expect(assertRouteDecision({ strategy: 'single', targets: [{ provider: 'p', model: 'm' }] }).ok).toBe(true);
    const r = assertRouteDecision({ strategy: 'fanout', targets: [{ provider: 'p', model: 'm' }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unsupported strategy: fanout');
    expect(r.reason).toContain('single');
    expect(assertRouteDecision({ strategy: 'ensemble', targets: [] }).ok).toBe(false);
    // 结构校验
    expect(assertRouteDecision({ targets: [{ provider: 'p' }] }).ok).toBe(false);      // strategy missing
    expect(assertRouteDecision({ strategy: 'single', targets: [] }).ok).toBe(false);   // single 需恰 1 target
    expect(assertRouteDecision({ strategy: 'single', targets: [{ model: 'm' }] }).ok).toBe(false); // target 需 provider/model
    expect(assertRouteDecision({ strategy: 'single', targets: [{ provider: 'p', model: 'm' }, { provider: 'p2', model: 'm2' }] }).ok).toBe(false);
  });

  const catalog = [
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    { provider: 'ollama', model: 'qwen3-4b-instruct:32k' },
  ];
  const base = {
    turn: 1, step: 1, purpose: 'main',
    humanOverride: null,
    policyTable: [{ when: { stepMin: 1 }, route: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }],
    catalog,
    currentTarget: { provider: 'ollama', model: 'qwen3-4b-instruct:32k' },
    pressure: null, noise: null,
  };

  it('humanOverride 优先（catalog 内）→ reason human-override，expiresAtStep=step+1', () => {
    const d = decideRoute({ ...base, humanOverride: { provider: 'ollama', model: 'qwen3-4b-instruct:32k' } })!;
    expect(d.strategy).toBe('single');
    expect(d.targets).toEqual([{ provider: 'ollama', model: 'qwen3-4b-instruct:32k' }]);
    expect(d.reason).toBe('human-override');
    expect(d.expiresAtStep).toBe(2);
  });

  it('humanOverride 不在 catalog（catalog 非空）→ 跳过，回落 policyTable', () => {
    const d = decideRoute({ ...base, humanOverride: { provider: 'x', model: 'y' } })!;
    expect(d.reason.startsWith('policy#')).toBe(true);
  });

  it('policyTable 首行命中；目标不在 catalog → 跳过该行继续（全无效 → null）', () => {
    const d = decideRoute(base)!;
    expect(d.reason).toContain('policy#0');
    expect(d.targets).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }]);
    // 目标不在 catalog：首行无效 → null
    const bad = decideRoute({
      ...base,
      policyTable: [{ when: { stepMin: 1 }, route: { provider: 'ghost', model: 'nope' } }],
    });
    expect(bad).toBeNull();
  });

  it('命中且 ≠ currentTarget → (switch, penalty) + meta.switchCost=true；相同 → (stable)', () => {
    const d = decideRoute(base)!;
    expect(d.reason).toContain('switch');
    expect(d.meta?.switchCost).toBe(true);
    const stable = decideRoute({
      ...base,
      currentTarget: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })!;
    expect(stable.reason).toContain('stable');
    expect(stable.meta?.switchCost).toBeFalsy();
  });

  it('when 全匹配语义：turn/step/stepMin/purpose；purpose 缺省=通配', () => {
    const pt = [{ when: { turn: 2, step: 1, purpose: 'tool-continuation' }, route: { provider: 'ollama', model: 'qwen3-4b-instruct:32k' } }];
    const hit = decideRoute({ ...base, turn: 2, step: 1, purpose: 'tool-continuation', policyTable: pt })!;
    expect(hit.targets[0].provider).toBe('ollama');
    const miss = decideRoute({ ...base, turn: 2, step: 2, purpose: 'tool-continuation', policyTable: pt });
    expect(miss).toBeNull();
    const wildcard = decideRoute({ ...base, turn: 2, step: 1, purpose: 'main', policyTable: pt, humanOverride: null });
    // purpose 缺省（未写在 when 内才通配）；此处 when 显式 purpose → 不命中
    expect(wildcard).toBeNull();
    const noPurposeRow = [{ when: { stepMin: 1 }, route: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }];
    const hit2 = decideRoute({ ...base, turn: 3, step: 2, purpose: 'tool-continuation', policyTable: noPurposeRow })!;
    expect(hit2.targets[0].provider).toBe('deepseek-official');
  });

  it('未命中 → null（透传，不覆写）', () => {
    expect(decideRoute({ ...base, policyTable: [] })).toBeNull();
  });

  it('catalog 空数组 = 不校验（humanOverride 直接生效）', () => {
    const d = decideRoute({ ...base, catalog: [], humanOverride: { provider: 'x', model: 'y' } })!;
    expect(d.reason).toBe('human-override');
  });
});
