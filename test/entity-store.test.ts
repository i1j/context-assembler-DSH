/**
 * lib/entity-store.js 单测（7.1 P3b：跨会话实体图冷启动加载）
 *
 * 覆盖：ca_topics.db entity_nodes/entity_edges 落库 → loadColdEntityGraph 读取为
 * 与会话内图同构的 graph（无向邻接对称、边元数据保留）；文件缺失 fail-open 返回 null。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, upsertEntityNodes, upsertEntityEdges } from '../scripts/ca-db.mjs';
import { loadColdEntityGraph } from '../lib/entity-store.js';

describe('7.1 P3b entity-store 冷启动加载', () => {
  it('落库 → 读取：节点/无向邻接/边元数据完整往返', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ca-entity-'));
    const dbPath = path.join(dir, 'ca_topics.db');
    try {
      const db = openDb(dbPath);
      upsertEntityNodes(db, ['path:/a/b', 'path:/a', 'tool:bash', 'strand:1']);
      upsertEntityEdges(db, [
        { from_key: 'path:/a/b', to_key: 'path:/a', kind: 'child_of', anchor: 'global', weight: 1 },
        { from_key: 'strand:1', to_key: 'path:/a/b', kind: 'touches_path', anchor: 'strand:1', weight: 1, strand_id: 1 },
      ]);
      db.close();
      const g = loadColdEntityGraph(dbPath);
      expect(g).not.toBeNull();
      expect(g!.nodes.has('path:/a/b')).toBe(true);
      expect(g!.adjacency.get('path:/a/b')?.get('path:/a')).toBe(1);
      expect(g!.adjacency.get('path:/a')?.get('path:/a/b')).toBe(1); // 无向
      expect(g!.edges.some((e) => e.kind === 'touches_path' && (e as { strandId?: number | null }).strandId === 1)).toBe(true);
      const missing = '/no/such/ca_topics.db';
      expect(loadColdEntityGraph(missing)).toBeNull(); // fail-open
      expect(existsSync(missing)).toBe(false); // 缺失文件不得被 DatabaseSync 创建为空库（无副作用回归）
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
