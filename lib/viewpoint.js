/**
 * ca-v7 7.3 viewpoint —— 双透镜投影纯计算模块（任务书 B §3.2，设计 §7）。
 *
 * - buildSessionTree：会话树（parentSession 派生 + handoff 分支聚合，§7.1）
 * - buildCaGraph：CA 索引图（节点 id 规则对齐 inject-workspace-edges.mjs；只有
 *   confirmed co_attends 进图，弱边绝不进图；无输入 fail-open 空图，§7.2）
 * - shortestPath：Dijkstra，co_attends 边权 = edgeCost(confidence_score)，其余边常数成本 1
 * - keyToNodeId：实体键 → 图节点 id 映射
 *
 * 纯函数模块：无 host 单例、无 IO；只 import edge-strength（edgeCost），环依赖约束 §6。
 */
import { edgeCost } from './edge-strength.js';

/** workspace slug：与 scripts/inject-workspace-edges.mjs 同一规则 */
function wsSlug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * buildSessionTree(sessions, handoffBranches)
 *   sessions: [{ id, header?: { parentSession?, agentPreset?, cwd?, title? }, events?: any[] }]
 *   blank = 无 type==='user/message' 且 source.kind==='user' 的事件
 *   nodes: [{ sessionId, parentSessionId, agentPreset, cwd, blank, branchCount, handoffBranchNos }]
 *   edges: [{ source: child, target: parent, kind: 'parentSession' }]（仅 header.parentSession 派生）
 *   handoffBranches: [{ parent_session_id, branch_no }] → 聚合 branchCount/handoffBranchNos（不产第二条树边）
 */
export function buildSessionTree(sessions, handoffBranches) {
  const list = Array.isArray(sessions) ? sessions : [];
  const branchNosByParent = new Map();
  for (const b of Array.isArray(handoffBranches) ? handoffBranches : []) {
    if (!b?.parent_session_id || b.branch_no == null) continue;
    const arr = branchNosByParent.get(b.parent_session_id) ?? [];
    arr.push(b.branch_no);
    branchNosByParent.set(b.parent_session_id, arr);
  }
  const nodes = list.map((s) => {
    const nos = [...(branchNosByParent.get(s.id) ?? [])].sort((a, b) => a - b);
    const events = Array.isArray(s.events) ? s.events : [];
    const hasUserMessage = events.some(
      (e) => e?.type === 'user/message' && e?.data?.source?.kind === 'user',
    );
    return {
      sessionId: s.id,
      parentSessionId: s.header?.parentSession ?? null,
      agentPreset: s.header?.agentPreset ?? null,
      cwd: s.header?.cwd ?? null,
      blank: !hasUserMessage,
      branchCount: nos.length,
      handoffBranchNos: nos,
    };
  });
  const edges = list
    .filter((s) => s.header?.parentSession)
    .map((s) => ({ source: s.id, target: s.header.parentSession, kind: 'parentSession' }));
  return { nodes, edges };
}

/** 实体键 → 图节点 id（§3.2 契约） */
export function keyToNodeId(key, ctx) {
  if (typeof key !== 'string') return key;
  if (key.startsWith('session:')) return 'session_' + key.slice('session:'.length);
  if (key.startsWith('strand:')) return ctx?.strandKeyMap?.get(key) ?? key;
  if (key.startsWith('reality:')) return 'ca_reality_' + key.slice('reality:'.length);
  return key; // 其余原样（path:/ident:/uri: 等实体键）
}

/** 节点骨架：所有节点共用的 graphify 字段（对齐 inject-workspace-edges.mjs） */
function caNode(id, label, sourceFile) {
  return {
    id,
    label,
    file_type: 'concept',
    source_file: sourceFile,
    source_location: '',
    community: 99999,
    community_name: 'ca-index',
    norm_label: label,
    _origin: 'ca-index',
  };
}

/** 常规边骨架 */
function caLink(source, target, relation, confidence, score, sourceFile = '') {
  return {
    source, target, relation, confidence, confidence_score: score, weight: 1,
    _origin: 'ca-index', source_file: sourceFile, source_location: '',
  };
}

/**
 * buildCaGraph(input)
 *   input = { strands, realities, strandToReality, entityNodes, entityEdges,
 *             handoffBranches, confirmedEdges, workspaces, cwdBySessionId }
 *   节点 id 规则（对齐 inject-workspace-edges.mjs）：
 *     strand → ca_strand_<session_id>_<topic_id>；reality → ca_reality_<ci 或 reality_id>
 *     workspace → ws_<slug>（[{path,title,id}] 或 [{path,title}] 由 slug(title||basename(path)) 生成）
 *     session → session_<id>；entity_nodes.key 原样（经 keyToNodeId 归一 session:/reality: 前缀）
 *   无输入/fail-open → { nodes: [], links: [] }
 */
export function buildCaGraph(input) {
  const src = input ?? {};
  const strands = Array.isArray(src.strands) ? src.strands : [];
  const realities = Array.isArray(src.realities) ? src.realities : [];
  const strandToReality = Array.isArray(src.strandToReality) ? src.strandToReality : [];
  const entityNodes = Array.isArray(src.entityNodes) ? src.entityNodes : [];
  const entityEdges = Array.isArray(src.entityEdges) ? src.entityEdges : [];
  const confirmedEdges = Array.isArray(src.confirmedEdges) ? src.confirmedEdges : [];
  const workspaces = Array.isArray(src.workspaces) ? src.workspaces : [];
  const cwdBySessionId = src.cwdBySessionId ?? {};

  const nodes = new Map();   // id → node（去重）
  const links = [];
  const addNode = (n) => { if (n && n.id) nodes.set(n.id, n); };

  // ── 节点 id 映射表 ──────────────────────────────────────────
  const strandKeyMap = new Map();   // 'strand:<topic_id>' / 'strand:<strand_id>' → node id
  const realityKeyMap = new Map();  // 'reality:<reality_id>' → node id（ci 优先）
  const wsByPath = new Map();       // workspace path → node id

  // workspace 节点
  for (const w of workspaces) {
    const id = w.id ?? 'ws_' + wsSlug(w.title || (typeof w.path === 'string' ? w.path.split('/').pop() : ''));
    addNode(caNode(id, 'workspace:' + (w.title ?? id.slice(3)), w.path ?? ''));
    if (w.path) wsByPath.set(w.path, id);
  }
  // strand 节点
  for (const st of strands) {
    if (st?.session_id == null || st?.topic_id == null) continue;
    const id = 'ca_strand_' + st.session_id + '_' + st.topic_id;
    addNode(caNode(id, 'strand:' + String(st.title ?? st.hdl ?? ''), 'ca_cache/strands.json'));
    strandKeyMap.set('strand:' + st.topic_id, id);
    if (st.strand_id != null) strandKeyMap.set('strand:' + st.strand_id, id);
  }
  // reality 节点：ca_reality_<ci>；DB 行无 ci 时回退 reality_id（注释：对齐 inject 脚本 r.ci ?? i 规则）
  for (const r of realities) {
    if (r == null) continue;
    const rid = r.ci ?? r.reality_id;
    if (rid == null) continue;
    const id = 'ca_reality_' + rid;
    addNode(caNode(id, 'reality:' + String(r.title ?? r.name ?? ''), 'ca_cache/realities.json'));
    if (r.reality_id != null) realityKeyMap.set('reality:' + r.reality_id, id);
  }
  // session 节点（cwdBySessionId 键 + entityNodes 中 session: 键）
  const sessionIds = new Set([...Object.keys(cwdBySessionId)]);
  for (const n of entityNodes) {
    const k = n?.key;
    if (typeof k === 'string' && k.startsWith('session:')) sessionIds.add(k.slice('session:'.length));
  }
  for (const sid of sessionIds) addNode(caNode('session_' + sid, 'session:' + sid, ''));
  // entity_nodes 节点（key 原样；session:/reality:/strand: 前缀经映射表归一）
  const resolveKey = (key) => {
    const mapped = strandKeyMap.get(key) ?? realityKeyMap.get(key);
    if (mapped) return mapped;
    return keyToNodeId(key, { strandKeyMap });
  };
  for (const n of entityNodes) {
    if (typeof n?.key !== 'string' || !n.key) continue;
    const id = resolveKey(n.key);
    addNode(caNode(id, n.key, n.source_file ?? ''));
  }

  // ── confirmed co_attends（弱边绝不进图：status 非 confirmed 防御性过滤）──
  for (const e of confirmedEdges) {
    if (!e?.from_key || !e?.to_key) continue;
    if (e.status !== 'confirmed') continue;                 // 调用方过滤语义 + 防御
    if (e.kind != null && e.kind !== 'co_attends') continue; // kind 契约 = co_attends
    links.push(caLink(resolveKey(e.from_key), resolveKey(e.to_key), 'co_attends', 'CONFIRMED', e.weight ?? 0));
  }
  // entity_edges → relation=kind（INFERRED/1）
  for (const e of entityEdges) {
    if (!e?.from_key || !e?.to_key || !e?.kind) continue;
    links.push(caLink(resolveKey(e.from_key), resolveKey(e.to_key), e.kind, 'INFERRED', 1, e.source_file ?? ''));
  }
  // strand_to_reality → strand --member_of--> reality（INFERRED/1）
  for (const row of strandToReality) {
    const sid = 'ca_strand_' + row.session_id + '_' + row.topic_id;
    const target = row.reality_id != null ? realityKeyMap.get('reality:' + row.reality_id) : null;
    if (!target) continue;
    links.push(caLink(sid, target, 'member_of', 'INFERRED', 1));
  }
  // workspace_of：strand 按 cwd 归属；reality 按 source_strands 成员 cwd 多数决
  // （简化：caller 提供 workspaces + cwdBySessionId，即 workspaceOf(cwd) 的输入；无归属不产边）
  const wsOf = (cwd) => (cwd ? wsByPath.get(cwd) : null);
  for (const st of strands) {
    if (st?.session_id == null || st?.topic_id == null) continue;
    const wid = wsOf(cwdBySessionId[st.session_id]);
    if (wid) links.push(caLink('ca_strand_' + st.session_id + '_' + st.topic_id, wid, 'workspace_of', 'INFERRED', 1));
  }
  for (const r of realities) {
    const rid = r.ci ?? r.reality_id;
    if (rid == null) continue;
    const members = Object.keys(r.source_strands ?? {});
    const votes = new Map();
    for (const sid of members) {
      const wid = wsOf(cwdBySessionId[sid]);
      if (wid) votes.set(wid, (votes.get(wid) ?? 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [wid, n] of votes) if (n > bestN) { best = wid; bestN = n; }
    if (best) links.push(caLink('ca_reality_' + rid, best, 'workspace_of', 'INFERRED', 1));
  }

  return { nodes: [...nodes.values()], links };
}

/**
 * shortestPath(graph, fromId, toId) → { path: string[]|null, cost: number|null }
 * Dijkstra；co_attends 边权 = edgeCost(confidence_score)，非 co_attends 边常数成本 1；无向。
 */
export function shortestPath(graph, fromId, toId) {
  const g = graph ?? {};
  const links = Array.isArray(g.links) ? g.links : [];
  const adj = new Map();
  const linkCost = (l) => (l.relation === 'co_attends' ? edgeCost(l.confidence_score ?? 0) : 1);
  for (const l of links) {
    if (!l?.source || !l?.target) continue;
    const c = linkCost(l);
    if (!adj.has(l.source)) adj.set(l.source, []);
    adj.get(l.source).push({ to: l.target, cost: c });
    if (!adj.has(l.target)) adj.set(l.target, []);
    adj.get(l.target).push({ to: l.source, cost: c });
  }
  if (fromId === toId) {
    // 自身到自身：只要节点存在于图（有邻接边或出现在 nodes 中）就是零成本路径；
    // 孤立节点也有 nodes 记录，不能因无邻接表而误报不可达。
    const nodeExists = adj.has(fromId)
      || (Array.isArray(g.nodes) && g.nodes.some((n) => n?.id === fromId));
    return nodeExists ? { path: [fromId], cost: 0 } : { path: null, cost: null };
  }
  if (!adj.has(fromId)) return { path: null, cost: null };
  const dist = new Map([[fromId, 0]]);
  const prev = new Map();
  const done = new Set();
  while (true) {
    let u = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!done.has(id) && d < best) { best = d; u = id; }
    }
    if (u == null) break;
    if (u === toId) break;
    done.add(u);
    for (const { to, cost } of adj.get(u) ?? []) {
      const nd = dist.get(u) + cost;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
      }
    }
  }
  if (!dist.has(toId)) return { path: null, cost: null };
  const path = [];
  let cur = toId;
  while (cur != null) { path.push(cur); cur = prev.get(cur); }
  path.reverse();
  return { path, cost: dist.get(toId) };
}
