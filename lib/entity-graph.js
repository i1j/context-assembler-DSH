/**
 * 实体工作对象图（lib/entity-graph.js）——7.1 P3：实体定级 = reality 图边扩充。
 *
 * 设计意图（docs/CA-V7-7.1-tool信息搜集与处理设计.md §4.4）：
 *   - 不再另起"实体 Jaccard 相似度"炉灶，而是把 tool_trace 的 entities
 *     （path:/ident:/bin:/uri:/tool:/exit:）构建为图：
 *       path→child_of/parent_of（目录层级即关系，不手写部分匹配系数）、
 *       同事务实体对 cooccurs_with（权重重合度即边权重）；
 *   - 定级消费图：当前提问实体 → 图 BFS 到旧话题块实体的距离
 *     d=0（直接命中）或 d≤1 → ACT；d=2 → REL；不可达 → FAR；
 *   - 图在话题切换时随冻结定级一起重算（见 lib/topic-grade.js），块内稳定；
 *   - embedding 只作实体缺失时的兜底（本模块不涉及）。
 *
 * 边界：本模块是运行时确定性图（tool_trace 内存态）；跨会话累积与
 * reality→references_path / strand→touches_path 的持久化落库接在
 * ca_topics.db/graphify 同步链上（后续 P3b）。
 */
import path from 'node:path';
import { extractEntities } from './tool-summarizer.js';

/** 图节点上限（防实体提取过宽导致 O(n²) 膨胀） */
export const ENTITY_GRAPH_MAX_NODES = 512;
/** 每事务参与共现的实体上限 */
export const ENTITY_COOCCUR_CAP = 8;

/** 实体归一化：去掉前缀、路径统一 posix、去尾斜杠；非路径实体原样（小写 ident） */
export function normalizeEntity(entity) {
  const raw = String(entity ?? '');
  const idx = raw.indexOf(':');
  if (idx <= 0) return raw.trim() || null;
  const kind = raw.slice(0, idx);
  const value = raw.slice(idx + 1);
  if (kind === 'path') {
    const p = path.posix.normalize(value || '/').replace(/\/+$/, '') || '/';
    return 'path:' + p;
  }
  if (kind === 'ident') return 'ident:' + value.toLowerCase();
  return kind + ':' + value;
}

/** 只保留图定级有价值、数量有界的实体（path/tool/uri/bin/exit/ident，优先 path/tool） */
export function valuableEntities(entities, cap = ENTITY_COOCCUR_CAP) {
  const seen = new Set();
  const out = [];
  const push = (e) => {
    const n = normalizeEntity(e);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  const priority = ['path:', 'tool:', 'uri:', 'bin:', 'exit:', 'ident:'];
  for (const prefix of priority) {
    for (const e of entities ?? []) {
      if (typeof e === 'string' && e.startsWith(prefix)) push(e);
      if (out.length >= cap) break;
    }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

/** 从当前提问文本提取实体（确定性规则；无实体时返回空数组 → 调用方回落文本定级） */
export function extractQuestionEntities(text) {
  const q = String(text ?? '').trim();
  if (!q) return [];
  return valuableEntities(extractEntities({ query: q }, ''));
}

/** 从 rich 视图把 toolTrace 行按 resultSeq 归到事务（strand 的运行时代理） */
export function mapTxnEntities(view, rows) {
  const txnByResultSeq = new Map();
  for (const elm of view ?? []) {
    if (elm?.type === 'toolResult' && typeof elm.elm_ref === 'number' && typeof elm.transaction_id === 'number') {
      txnByResultSeq.set(elm.elm_ref, elm.transaction_id);
    }
  }
  const byTxn = new Map();
  for (const row of rows ?? []) {
    if (!row || !Number.isInteger(row.resultSeq)) continue;
    const txnId = txnByResultSeq.get(row.resultSeq);
    if (txnId === undefined) continue;
    const ents = valuableEntities(row.entities);
    if (ents.length === 0) continue;
    const list = byTxn.get(txnId) ?? [];
    for (const e of ents) if (!list.includes(e)) list.push(e);
    byTxn.set(txnId, list);
  }
  return byTxn;
}

/**
 * 从 txn→entities 构建无向实体图。
 * 边：
 *   - child_of：path 节点 → 父目录（目录层级关系）；
 *   - cooccurs_with：同一事务内的实体对，权重 = 共现次数。
 * @param {Map<number, string[]>} txnEntities
 * @returns {{ nodes: Set<string>; adjacency: Map<string, Map<string, number>>; edges: Array<{from:string;to:string;kind:string;weight:number}>; txnEntities: Map<number, string[]> }}
 */
export function buildEntityGraph(txnEntities) {
  const nodes = new Set();
  const adjacency = new Map(); // node -> neighbor -> weight(边数)
  const edges = new Map(); // `${a}\u0000${b}` -> {from,to,kind,weight}
  const addNode = (n) => {
    if (!n || nodes.size >= ENTITY_GRAPH_MAX_NODES) return false;
    if (!nodes.has(n)) nodes.add(n);
    return true;
  };
  const addEdge = (a, b, kind) => {
    if (!a || !b || a === b) return;
    const key = a < b ? a + '\u0000' + b : b + '\u0000' + a;
    const prev = edges.get(key);
    if (prev) prev.weight += 1;
    else edges.set(key, { from: a < b ? a : b, to: a < b ? b : a, kind, weight: 1 });
    for (const [x, y] of [[a, b], [b, a]]) {
      const adj = adjacency.get(x) ?? new Map();
      adj.set(y, (adj.get(y) ?? 0) + 1);
      adjacency.set(x, adj);
    }
  };
  for (const ents of txnEntities.values()) {
    const list = ents.slice(0, ENTITY_COOCCUR_CAP);
    for (const e of list) {
      if (!addNode(e)) continue;
      if (e.startsWith('path:')) {
        const value = e.slice('path:'.length);
        const parent = path.posix.dirname(value);
        if (parent && parent !== value && parent !== '/') {
          const parentNode = 'path:' + parent;
          if (addNode(parentNode)) addEdge(e, parentNode, 'child_of');
        }
      }
    }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        addEdge(list[i], list[j], 'cooccurs_with');
      }
    }
  }
  return { nodes, adjacency, edges: [...edges.values()], txnEntities };
}

/**
 * 图距离定级：当前提问实体 → 各事务实体的无向 BFS 最短距离。
 * d=0（直接重叠）或 d≤1 → ACT；d=2 → REL；>2/不可达 → FAR。
 * 无提问实体 / 图为空 → 返回空 Map（调用方回落文本定级）。
 * @param {Map<number, string[]>} txnEntities
 * @param {string[]} questionEntities
 * @param {ReturnType<typeof buildEntityGraph>} graph
 * @returns {Map<number,'ACT'|'REL'|'FAR'>}
 */
export function gradeByEntityGraph(txnEntities, questionEntities, graph) {
  const q = valuableEntities(questionEntities, 16);
  if (q.length === 0 || !graph || !(graph.adjacency instanceof Map)) return new Map();
  const adjacency = graph.adjacency;
  const dist = new Map();
  const queue = [];
  for (const n of q) {
    if (!dist.has(n)) {
      dist.set(n, 0);
      queue.push(n);
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i];
    const d = dist.get(node);
    const neighbors = adjacency.get(node);
    if (!neighbors) continue;
    for (const [neighbor, weight] of neighbors) {
      if (dist.has(neighbor)) continue;
      dist.set(neighbor, d + 1);
      if (d + 1 < 4) queue.push(neighbor);
    }
  }
  const out = new Map();
  for (const [txnId, ents] of txnEntities) {
    let best = Infinity;
    for (const e of ents) {
      const d = dist.get(e);
      if (d !== undefined && d < best) best = d;
    }
    if (!Number.isFinite(best)) {
      out.set(txnId, 'FAR');
    } else if (best <= 1) {
      out.set(txnId, 'ACT');
    } else if (best === 2) {
      out.set(txnId, 'REL');
    } else {
      out.set(txnId, 'FAR');
    }
  }
  return out;
}

/**
 * 组合定级：图定级优先覆盖有实体的旧事务，其余沿用文本定级。
 * @param {Map<number,'ACT'|'REL'|'FAR'>} textGrades
 * @param {Map<number,'ACT'|'REL'|'FAR'>} entityGrades
 */
export function mergeGrades(textGrades, entityGrades) {
  const out = new Map(textGrades);
  for (const [txnId, grade] of entityGrades ?? []) out.set(txnId, grade);
  return out;
}

/**
 * 合并两张无向实体图（base 优先；cold 图补边/补节点，受 ENTITY_GRAPH_MAX_NODES 上限）。
 * 用途：会话内图（当前 tool_trace）⊕ 跨会话冷启动图（ca_topics.db）。
 * 注意：edges 合并用于调试导出，BFS 只依赖 adjacency。
 */
export function mergeEntityGraphs(base, cold) {
  const nodes = new Set(base?.nodes ?? []);
  const adjacency = new Map();
  for (const [n, neighbors] of base?.adjacency ?? []) adjacency.set(n, new Map(neighbors));
  const edges = [...(base?.edges ?? []), ...(cold?.edges ?? [])];
  for (const [n, neighbors] of cold?.adjacency ?? []) {
    if (nodes.size >= ENTITY_GRAPH_MAX_NODES && !nodes.has(n)) continue;
    nodes.add(n);
    const cur = adjacency.get(n) ?? new Map();
    for (const [neighbor, weight] of neighbors) {
      if (nodes.size >= ENTITY_GRAPH_MAX_NODES && !nodes.has(neighbor)) continue;
      nodes.add(neighbor);
      cur.set(neighbor, (cur.get(neighbor) ?? 0) + weight);
    }
    adjacency.set(n, cur);
  }
  return { nodes, adjacency, edges, txnEntities: base?.txnEntities ?? new Map() };
}

/**
 * 一栈式实体定级（供 topic-grade 冻结调用）：
 * view + toolTrace rows + 当前提问 → 图 → 定级 Map（无实体返回空 Map）。
 * @param {any[]} view
 * @param {any[]} rows
 * @param {string} questionText
 * @param {ReturnType<typeof buildEntityGraph>} [graph] 可复用已建图（同一次冻结重算）
 */
export function entityGradeView(view, rows, questionText, graph) {
  const txnEntities = mapTxnEntities(view, rows);
  if (txnEntities.size === 0) return { grades: new Map(), graph: graph ?? null, txnEntities };
  const q = extractQuestionEntities(questionText);
  if (q.length === 0) return { grades: new Map(), graph: graph ?? null, txnEntities };
  const base = buildEntityGraph(txnEntities);
  // 冷启动图（ca_topics.db 跨会话边）补入会话内图：BFS 可经历史 path 层级/工作线边连通
  const g = graph ? mergeEntityGraphs(base, graph) : base;
  return { grades: gradeByEntityGraph(txnEntities, q, g), graph: g, txnEntities };
}
