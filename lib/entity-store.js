/**
 * 实体图冷启动加载（lib/entity-store.js）——7.1 P3b。
 *
 * 从 ca_topics.db 读取离线管线（summarize-history）落库的跨会话实体图：
 *   - 全局边：path→child_of、同事务 cooccurs_with（anchor='global'）；
 *   - strand→touches_path（anchor='strand:<id>'）；
 *   - reality→references_path（anchor='reality:<id>'）。
 * 输出与 lib/entity-graph.js buildEntityGraph 同构的 graph 对象，供
 * entityGradeView 与会话内图 merge 后做图距离定级（新会话冷启动复用历史工作线）。
 *
 * fail-open：文件缺失/SQLite 不可用 → 返回 null，调用方回落会话内图/文本定级。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

/**
 * @param {string} dbPath ca_topics.db 路径
 * @param {{ warn?: (msg: string) => void }} [logger]
 * @returns {ReturnType<import('./entity-graph.js').buildEntityGraph> | null}
 */
export function loadColdEntityGraph(dbPath, logger) {
  // 文件缺失直接返回 null：DatabaseSync 缺省会在目标路径创建空 DB 文件（fail-open 不应有副作用）
  if (typeof dbPath !== 'string' || !dbPath || !existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const nodes = new Set(db.prepare('SELECT key FROM entity_nodes').all().map((r) => r.key));
    const adjacency = new Map();
    const edges = [];
    for (const e of db.prepare('SELECT from_key, to_key, kind, anchor, weight, strand_id, reality_id FROM entity_edges').all()) {
      edges.push({
        from: String(e.from_key),
        to: String(e.to_key),
        kind: String(e.kind),
        weight: Number(e.weight) || 1,
        anchor: String(e.anchor),
        strandId: e.strand_id ?? null,
        realityId: e.reality_id ?? null,
      });
      for (const [x, y] of [[e.from_key, e.to_key], [e.to_key, e.from_key]]) {
        const adj = adjacency.get(x) ?? new Map();
        adj.set(y, (adj.get(y) ?? 0) + (Number(e.weight) || 1));
        adjacency.set(x, adj);
      }
    }
    db.close();
    return { nodes, adjacency, edges, txnEntities: new Map() };
  } catch (error) {
    try { db?.close(); } catch { /* ignore */ }
    logger?.warn?.('ca-v7 实体图冷启动加载失败（' + dbPath + '）：' + (error instanceof Error ? error.message : String(error)) + '；回落会话内图');
    return null;
  }
}
