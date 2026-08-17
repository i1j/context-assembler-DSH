/**
 * 7.3 公开子路径 exports 的类型解析回归（package.json exports["<subpath>"].types）。
 * 编译期由 tsc 校验：任一行解析不到声明文件会 TS7016/2307 失败；
 * 运行期校验默认入口可用（pnpm vitest 经 exports 解析）。
 */
import { describe, expect, it } from 'vitest';
import { CA_DB_VERSION, openCaDb } from 'ca-dsh/ca-db';
import { TOPIC_STATE_KEY, createTopicStateProjection } from 'ca-dsh/topic-state';
import { collectPressureSignals, PRESSURE_DEFAULTS } from 'ca-dsh/handoff-metrics';
import { evaluateHandoff, HANDOFF_DEFAULTS, partitionBranches } from 'ca-dsh/handoff-plan';
import { BranchSummaryParseError, HANDOFF_BRANCH_INSTRUCTION } from 'ca-dsh/handoff-branch-summary';
import { EDGE_DEFAULTS, EDGE_KIND, emptyEdge, hebbianUpdate } from 'ca-dsh/edge-strength';
import { buildCaGraph, shortestPath } from 'ca-dsh/viewpoint';
import { ROUTE_STRATEGIES, assertRouteDecision, decideRoute } from 'ca-dsh/route-policy';

describe('7.3 公开子路径 exports（types + default 同源）', () => {
  it('ca-db / topic-state / handoff-* / edge-strength / viewpoint / route-policy 均可解析', () => {
    expect(CA_DB_VERSION).toBe(3);
    expect(typeof openCaDb).toBe('function');
    expect(TOPIC_STATE_KEY).toBe('ca-v7/topic-state');
    expect(typeof createTopicStateProjection).toBe('function');
    expect(PRESSURE_DEFAULTS.ratioThreshold).toBeGreaterThan(0);
    expect(typeof collectPressureSignals).toBe('function');
    expect(HANDOFF_DEFAULTS.minTurns).toBeGreaterThan(0);
    expect(typeof evaluateHandoff).toBe('function');
    expect(typeof partitionBranches).toBe('function');
    expect(HANDOFF_BRANCH_INSTRUCTION.length).toBeGreaterThan(0);
    expect(BranchSummaryParseError).toBeDefined();
    expect(EDGE_KIND).toBe('co_attends');
    expect(EDGE_DEFAULTS.lambdaPerDay).toBeGreaterThan(0);
    expect(hebbianUpdate(0, 0.1)).toBeCloseTo(0.1, 5);
    expect(emptyEdge('a', 'b').status).toBe('weak');
    expect(buildCaGraph({})).toEqual({ nodes: [], links: [] });
    expect(shortestPath({ nodes: [], links: [] }, 'a', 'b')).toEqual({ path: null, cost: null });
    expect(ROUTE_STRATEGIES).toContain('single');
    expect(assertRouteDecision({ strategy: 'single', targets: [{ provider: 'p', model: 'm' }] })).toEqual({ ok: true });
    expect(decideRoute({ step: 1, switchPenalty: false })).toBeNull();
  });
});
