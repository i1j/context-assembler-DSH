/**
 * ca-v7 7.3 E10/E11 — ca-db 公开库单测（任务书 B §3.4，红线基线，主笔/测试线）。
 * 覆盖：openCaDb 迁移（user_version 0→2）、遗留 v0 表重命名、幂等、公开子路径 exports、
 * scripts/ca-db.mjs 薄壳 re-export、HANDOFF_SCHEMA 与设计 SQL 关键子句逐字对齐。
 * 注意：全部使用 /tmp 临时库，禁止碰真实 ca_cache/ca_topics.db。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as caDb from '../lib/ca-db.js';
import * as thin from '../scripts/ca-db.mjs';

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-db7-'));
  return { dir, path: join(dir, 'test.db') };
};

describe('E10 ca-db 公开库与迁移', () => {
  it('全新库 openCaDb：user_version=3 + 7.3 四表 + router 五表 + 11 旧表', () => {
    const { dir, path } = tmp();
    try {
      const db = caDb.openCaDb(path);
      const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      expect(v).toBe(3);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      for (const t of ['handoff_packages', 'handoff_branches', 'ca_signals', 'ca_edge_strength']) {
        expect(tables).toContain(t);
      }
      for (const t of ['session_meta', 'turn_stream', 'tool_trace', 'llm_calls', 'strand_summaries', 'strand_to_reality', 'entity_nodes', 'entity_edges', 'refinement_meta', 'realities', 'think_trace']) {
        expect(tables).toContain(t);
      }
      // v3 router 五表（DESIGN-CHANCELLOR-ROUTER §9.2）
      for (const t of ['reality_sessions', 'router_dispatch', 'reality_extractions', 'reality_merges', 'router_pool_suggestions']) {
        expect(tables).toContain(t);
      }
      // realities 条件列（A8/H10）
      const rcols = db.prepare('PRAGMA table_info(realities)').all().map((c) => c.name);
      expect(rcols).toContain('status');
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
      for (const i of ['idx_handoff_packages_parent', 'idx_handoff_branches_package', 'idx_handoff_branches_parent', 'idx_ca_signals_session', 'idx_ca_edge_strength_from', 'idx_ca_edge_strength_to', 'idx_reality_sessions_reality', 'idx_reality_sessions_active', 'idx_router_dispatch_dialogue', 'idx_router_dispatch_idem', 'idx_reality_extractions_idem', 'idx_reality_merges_reality']) {
        expect(idx).toContain(i);
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重复迁移幂等（同 user_version 直接返回）', () => {
    const { dir, path } = tmp();
    try {
      const db = caDb.openCaDb(path);
      const r1 = caDb.migrateCaDb(db);
      const r2 = caDb.migrateCaDb(db);
      expect(r1.from).toBe(r2.from);
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v2 旧库增量迁移到 v3：既有数据保留 + realities.status 条件 ADD + router 五表', () => {
    const { dir, path } = tmp();
    try {
      // 构造 v2 库（11 旧表 + handoff 四表 + 已有 realities 行）
      const db = new DatabaseSync(path);
      db.exec(caDb.SCHEMA);
      db.exec(caDb.HANDOFF_SCHEMA);
      db.exec('PRAGMA user_version = 2');
      db.prepare("INSERT INTO realities (reality_id, name, created_at, updated_at) VALUES (1, 'R1', 1, 1)").run();
      db.close();
      // v2 → v3
      const db2 = caDb.openCaDb(path);
      expect((db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
      const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      for (const t of ['reality_sessions', 'router_dispatch', 'reality_extractions', 'reality_merges', 'router_pool_suggestions']) {
        expect(tables).toContain(t);
      }
      const r = db2.prepare('SELECT status FROM realities WHERE reality_id=1').get() as { status: string };
      expect(r.status).toBe('active'); // 默认值
      // FK 有效：reality_sessions 可引用既有 realities 行
      db2.prepare("INSERT INTO reality_sessions (dialogue_session_id,reality_id,role,session_id,status,created_at,last_active_at,updated_at) VALUES ('d1',1,'topic','topic-1','active',1,1,1)").run();
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v3 约束：部分唯一索引 / 幂等唯一键 / 角色 CHECK 生效', () => {
    const { dir, path } = tmp();
    try {
      const db = caDb.openCaDb(path);
      db.prepare("INSERT INTO realities (reality_id, name, created_at, updated_at) VALUES (1, 'R1', 1, 1)").run();
      const ins = db.prepare('INSERT INTO reality_sessions (dialogue_session_id,reality_id,role,session_id,status,created_at,last_active_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
      ins.run('d1', 1, 'topic', 'topic-1', 'active', 1, 1, 1);
      // 部分唯一索引：同 reality 第二个 active 会话被拒
      expect(() => ins.run('d1', 1, 'topic', 'topic-1b', 'active', 1, 1, 1)).toThrow();
      // 非 active 可并存
      ins.run('d1', 1, 'topic', 'topic-1-old', 'draining', 1, 1, 1);
      // CHECK：topic 必须带 reality 或 topic_role
      expect(() => ins.run('d1', null, 'topic', 'topic-bad', 'active', 1, 1, 1)).toThrow();
      // inbox 合法（reality NULL + topic_role NULL）
      ins.run('d1', null, 'inbox', 'inbox-d1', 'active', 1, 1, 1);
      // router_dispatch 幂等唯一键（dialogue_session_id, dialogue_seq, targets_json）
      const rd = db.prepare("INSERT INTO router_dispatch (dialogue_session_id,dialogue_seq,target_reality_id,target_session_id,task_text,targets_json,created_at) VALUES (?,?,?,?,?,?,?)");
      rd.run('d1', 1, 1, 'topic-1', 't', '{"a":1}', 1);
      expect(() => rd.run('d1', 1, 1, 'topic-1', 't', '{"a":1}', 1)).toThrow();
      // reality_extractions 部分幂等索引：applied 拦同源区间，skipped 不拦
      const re = db.prepare('INSERT INTO reality_extractions (dialogue_session_id,inbox_session_id,reality_id,source_seq_ranges,status,created_at) VALUES (?,?,?,?,?,?)');
      re.run('d1', 'inbox-d1', 1, '[[3,8]]', 'applied', 1);
      expect(() => re.run('d1', 'inbox-d1', 1, '[[3,8]]', 'applied', 1)).toThrow();
      re.run('d1', 'inbox-d1', null, '[[3,8]]', 'skipped', 1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('遗留 v0 表检测重命名（dsh-chancellor v0 shape）且旧数据可读', () => {
    const { dir, path } = tmp();
    try {
      // 构造旧库：11 表 + v0 shape 两表 + user_version=0
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec(caDb.SCHEMA);
      raw.exec(`CREATE TABLE ca_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at REAL NOT NULL
      )`);
      raw.exec(`CREATE TABLE ca_edge_strength (
        edge_key TEXT PRIMARY KEY,
        node_kind TEXT NOT NULL,
        node_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        day TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'candidate',
        n_dwell INTEGER NOT NULL DEFAULT 0,
        n_anchor INTEGER NOT NULL DEFAULT 0,
        last_co_attend_at REAL,
        updated_at REAL NOT NULL
      )`);
      raw.prepare('INSERT INTO ca_signals (kind, payload_json, created_at) VALUES (?, ?, ?)').run('edge_signal', '{"op":"dwell"}', 123);
      raw.prepare('INSERT INTO ca_edge_strength (edge_key, node_kind, node_id, session_id, day, weight, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('k', 'strand', '9', 's1', '2026-08-01', 0.05, 'candidate', 123);
      raw.close();

      const db = caDb.openCaDb(path);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      expect(tables).toContain('ca_signals_v0');
      expect(tables).toContain('ca_edge_strength_v0');
      // 新表已换 7.3 shape
      const sigCols = db.prepare('PRAGMA table_info(ca_signals)').all().map((c) => c.name);
      expect(sigCols).toContain('signal_id');
      expect(sigCols).toContain('value_json');
      const edgeCols = db.prepare('PRAGMA table_info(ca_edge_strength)').all().map((c) => c.name);
      expect(edgeCols).toContain('edge_id');
      expect(edgeCols).toContain('from_key');
      // 旧数据可读
      const oldSig = db.prepare('SELECT kind FROM ca_signals_v0').all();
      expect(oldSig.length).toBe(1);
      expect(oldSig[0].kind).toBe('edge_signal');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('v0 目标表已存在 → 迁移显式阻断（不残留半迁移状态、user_version 不变）', () => {
    const { dir, path } = tmp();
    try {
      const raw = new DatabaseSync(path);
      raw.exec(caDb.SCHEMA);
      raw.exec(`CREATE TABLE ca_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at REAL NOT NULL
      )`);
      raw.exec('CREATE TABLE ca_signals_v0 (id INTEGER PRIMARY KEY, kind TEXT)');
      raw.exec('PRAGMA user_version = 1');
      raw.close();

      const db = new DatabaseSync(path);
      expect(() => caDb.migrateCaDb(db)).toThrow(/legacy shape/);
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
      // 原表未被动过：仍是旧 shape（无 signal_id 列），也没有被改名为其它表
      const cols = db.prepare('PRAGMA table_info(ca_signals)').all().map((c) => c.name);
      expect(cols).not.toContain('signal_id');
      expect(cols).toContain('payload_json');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HANDOFF_SCHEMA 与设计 §3.2-3.4 关键子句逐字对齐', () => {
    const s = caDb.HANDOFF_SCHEMA;
    expect(s).toContain('handoff_packages');
    expect(s).toContain('package_key TEXT NOT NULL UNIQUE');
    expect(s).toContain('handoff_branches');
    expect(s).toContain('UNIQUE(parent_session_id, source_txn_start, source_txn_end)');
    expect(s).toContain('STRICT');
    expect(s).toContain('ca_signals');
    expect(s).toContain('signal_id INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(s).toContain('ca_edge_strength');
    expect(s).toContain('UNIQUE(from_key, to_key, kind)');
    expect(s).toContain('status TEXT NOT NULL DEFAULT \'weak\'');
  });

  it('CA_DB_VERSION = 3（user_version 里程碑：v3=+router 五表+realities.status）', () => {
    expect(caDb.CA_DB_VERSION).toBe(3);
  });

  it('ROUTER_SCHEMA 与设计 §9.2 关键子句对齐（幂等键/部分唯一索引/四值 CHECK/角色组合 CHECK）', () => {
    const s = caDb.ROUTER_SCHEMA;
    expect(s).toContain('reality_sessions');
    expect(s).toContain("CHECK(status IN ('active','draining','archived','abandoned'))");
    expect(s).toMatch(/role\s+TEXT NOT NULL CHECK\(role IN \('inbox','topic'\)\)/);
    expect(s).toContain("ON reality_sessions(reality_id) WHERE reality_id IS NOT NULL AND status='active'");
    expect(s).toContain('router_dispatch');
    expect(s).toContain('ON router_dispatch(dialogue_session_id, dialogue_seq, targets_json)');
    expect(s).toContain('reality_extractions');
    expect(s).toContain("WHERE status NOT IN ('rolled_back','skipped','failed')");
    expect(s).toContain('reality_merges');
    expect(s).toContain('router_pool_suggestions');
    expect(s).toContain("CHECK(status IN ('pending','consumed','expired'))");
  });
});

describe('E11 薄壳 re-export 与公开函数', () => {
  it('scripts/ca-db.mjs 全部既有导出经薄壳可用（summarize-history 消费名不破坏）', () => {
    const names = [
      'SCHEMA', 'openDb', 'upsertSessionMeta', 'insertTurnRows', 'insertToolTraceRows',
      'insertLlmCalls', 'insertThinkTraceRows', 'clearThinkTrace', 'updateThinkL1Rows',
      'upsertEntityNodes', 'upsertEntityEdges', 'loadEntityGraph', 'insertStrand',
      'insertReality', 'mapStrandToReality', 'clearStrandData', 'countStats',
    ];
    for (const n of names) {
      expect(typeof (thin as any)[n], `薄壳缺少导出 ${n}`).toBe(typeof (caDb as any)[n]);
      expect((thin as any)[n]).toBe((caDb as any)[n]); // 薄壳 = re-export 同一引用，无双份
    }
  });

  it('薄壳不重复定义 schema（CREATE TABLE 只应在 lib/ca-db.js）', () => {
    expect(thin.HANDOFF_SCHEMA).toBe(caDb.HANDOFF_SCHEMA);
    expect(thin.openCaDb).toBe(caDb.openCaDb);
  });
});
