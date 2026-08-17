/**
 * ca-v7 7.3 E6-E8 — viewpoint 单测（任务书 B §3.2，红线基线，主笔/测试线）。
 * 覆盖：buildSessionTree shape、buildCaGraph 节点 id 规则/弱边过滤/fail-open、shortestPath 高成本弱边绕行。
 */
import { describe, it, expect } from 'vitest';
import { buildSessionTree, buildCaGraph, shortestPath, keyToNodeId } from '../lib/viewpoint.js';
import { edgeCost } from '../lib/edge-strength.js';

describe('E6 buildSessionTree', () => {
  const sessions = [
    { id: 's1', header: { agentPreset: 'chancellor', cwd: '/w' }, events: [{ type: 'user/message', data: { source: { kind: 'user' } } }] },
    { id: 's2', header: { parentSession: 's1', agentPreset: 'chancellor', cwd: '/w' }, events: [] },
  ];
  const handoffBranches = [
    { parent_session_id: 's1', branch_no: 1 },
    { parent_session_id: 's1', branch_no: 2 },
  ];

  it('nodes/edges shape 契约：parentSession 派生树边；blank 判定', () => {
    const tree = buildSessionTree(sessions, handoffBranches);
    expect(tree.nodes.length).toBe(2);
    const n1 = tree.nodes.find((n) => n.sessionId === 's1')!;
    const n2 = tree.nodes.find((n) => n.sessionId === 's2')!;
    expect(n1.parentSessionId).toBeNull();
    expect(n1.blank).toBe(false);
    expect(n1.branchCount).toBe(2);
    expect(n1.handoffBranchNos).toEqual([1, 2]);
    expect(n2.parentSessionId).toBe('s1');
    expect(n2.blank).toBe(true);
    expect(tree.edges).toEqual([{ source: 's2', target: 's1', kind: 'parentSession' }]);
  });

  it('handoffBranches 只聚合不产第二条树边', () => {
    const tree = buildSessionTree(sessions, handoffBranches);
    expect(tree.edges.length).toBe(1);
  });

  it('空输入 → {nodes:[],edges:[]}', () => {
    expect(buildSessionTree([], [])).toEqual({ nodes: [], edges: [] });
  });
});

describe('E7 buildCaGraph', () => {
  const baseInput = {
    strands: [{ session_id: 's1', topic_id: 7, title: '迁移' }],
    realities: [{ reality_id: 3, ci: 'ci-3', title: 'R3' }],
    strandToReality: [{ session_id: 's1', topic_id: 7, reality_id: 3 }],
    entityNodes: [{ key: 'session:s1' }],
    entityEdges: [{ from_key: 'session:s1', to_key: 'reality:3', kind: 'references_path' }],
    handoffBranches: [],
    confirmedEdges: [{ from_key: 'session:s1', to_key: 'strand:7', weight: 0.2, status: 'confirmed' }],
    workspaces: [{ path: '/w', title: 'Workspace' }],
    cwdBySessionId: { s1: '/w' },
  };

  it('节点 id 规则对齐 inject-workspace-edges（ca_strand_/ca_reality_/ws_/session_）', () => {
    const g = buildCaGraph(baseInput);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('ca_strand_s1_7');
    expect(ids).toContain('ca_reality_ci-3');
    expect(ids).toContain('ws_workspace');
    expect(ids).toContain('session_s1');
    for (const n of g.nodes) {
      expect(n.file_type).toBe('concept');
      expect(n._origin).toBe('ca-index');
      expect(n.community_name).toBe('ca-index');
    }
  });

  it('只有 confirmed co_attends 进图（_origin:ca-index）；弱边绝不出现', () => {
    const withWeak = {
      ...baseInput,
      confirmedEdges: [
        { from_key: 'session:s1', to_key: 'strand:7', weight: 0.2, status: 'confirmed' },
        { from_key: 'session:s1', to_key: 'strand:9', weight: 0.02, status: 'weak' }, // 调用方已过滤，仍防御断言
      ],
    };
    // 调用方过滤语义：只传 confirmed
    const g = buildCaGraph({ ...withWeak, confirmedEdges: withWeak.confirmedEdges.filter((e) => e.status === 'confirmed') });
    const links = g.links.filter((l) => l.relation === 'co_attends');
    expect(links.length).toBe(1);
    expect(links[0].confidence).toBe('CONFIRMED');
    expect(links[0].confidence_score).toBeCloseTo(0.2, 5);
    expect(links[0]._origin).toBe('ca-index');
  });

  it('无输入/fail-open → {nodes:[],links:[]}', () => {
    expect(buildCaGraph({})).toEqual({ nodes: [], links: [] });
    expect(buildCaGraph(null)).toEqual({ nodes: [], links: [] });
  });

  it('keyToNodeId 映射规则', () => {
    expect(keyToNodeId('session:s1')).toBe('session_s1');
    expect(keyToNodeId('reality:3')).toBe('ca_reality_3');
    expect(keyToNodeId('strand:7', { strandKeyMap: new Map([['strand:7', 'ca_strand_s1_7']]) })).toBe('ca_strand_s1_7');
    expect(keyToNodeId('other:9')).toBe('other:9');
  });
});

describe('E8 shortestPath（Dijkstra 边权 cost）', () => {
  // 图：A→B 弱边成本高；A→C→B 两跳弱边/常数边更便宜
  const graph = {
    nodes: [
      { id: 'A', label: 'A' }, { id: 'B', label: 'B' }, { id: 'C', label: 'C' },
    ],
    links: [
      { source: 'A', target: 'B', relation: 'co_attends', confidence: 'CONFIRMED', confidence_score: 0.02, weight: 1, _origin: 'ca-index' },
      { source: 'A', target: 'C', relation: 'references_path', confidence: 'INFERRED', confidence_score: 1, weight: 1, _origin: 'ca-index' },
      { source: 'C', target: 'B', relation: 'references_path', confidence: 'INFERRED', confidence_score: 1, weight: 1, _origin: 'ca-index' },
    ],
  };

  it('高成本弱边绕行：A→C→B（成本 2）优于 A→B 直接（1/(0.02+0.01)≈33）', () => {
    const r = shortestPath(graph, 'A', 'B');
    expect(r.path).toEqual(['A', 'C', 'B']);
    expect(r.cost).toBeCloseTo(2, 5);
  });

  it('直达弱边成本 = edgeCost(confidence_score)', () => {
    const g2 = { nodes: graph.nodes, links: [graph.links[0]] };
    const r = shortestPath(g2, 'A', 'B');
    expect(r.cost).toBeCloseTo(edgeCost(0.02), 5);
  });

  it('不可达 → {path:null,cost:null}', () => {
    expect(shortestPath(graph, 'A', 'X')).toEqual({ path: null, cost: null });
  });

  it('孤立节点自身到自身 → 零成本路径（不因无邻接表误报不可达）', () => {
    expect(shortestPath({ nodes: [{ id: 'A' }], links: [] }, 'A', 'A')).toEqual({ path: ['A'], cost: 0 });
    expect(shortestPath({ nodes: [], links: [] }, 'A', 'A')).toEqual({ path: null, cost: null });
  });
});
