/**
 * DSH CA 公开库（lib/ca-db.js）——SQLite 存储层，schema 对齐 Hermes ca_topics.db
 * （~/.hermes/profiles/sysadmin/ca_cache/ca_topics.db）。
 *
 * 7.3 公开化（任务书 B §3.4，评审修正 R1-2）：schema/openDb 自 scripts/ca-db.mjs
 * 抽成公开模块（package.json exports["./ca-db"]），scripts/ca-db.mjs 薄壳 re-export
 * 本模块（禁止双份 schema）。零依赖（node:sqlite）。
 *
 * 表：11 旧表（session_meta / turn_stream / tool_trace / llm_calls / strand_summaries /
 *     strand_to_reality / entity_nodes / entity_edges / refinement_meta / realities /
 *     think_trace）+ 7.3 四表（handoff_packages / handoff_branches / ca_signals /
 *     ca_edge_strength，设计 §3.2-3.4）。
 *
 * 迁移：PRAGMA user_version 增量迁移（CA_DB_VERSION=3）；
 *     11 旧表 SQL 不得改（迁移只增不改）；dsh-chancellor v0 旧 shape 两表
 *     （ca_signals / ca_edge_strength）检测缺列后整表重命名为 *_v0，旧数据保留可读。
 *     v3（2026-08-18 人机交流层路由设计 DESIGN-CHANCELLOR-ROUTER §9.2）：
 *     话题层五表（reality_sessions/router_dispatch/reality_extractions/
 *     reality_merges/router_pool_suggestions）+ realities.status 条件列（ADD-only）。
 */
import { DatabaseSync } from 'node:sqlite';

/** user_version 里程碑：0=无版本（历史库）→1=11 旧表 →2=+7.3 四表 →3=+router 五表+realities.status */
export const CA_DB_VERSION = 3;

/** 11 旧表 SQL——逐字搬自 scripts/ca-db.mjs（不得改） */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_meta (
    session_id    TEXT PRIMARY KEY,
    profile       TEXT NOT NULL DEFAULT '',
    last_turn     INTEGER DEFAULT 0,
    last_topic_id INTEGER DEFAULT 0,
    created_at    REAL,
    updated_at    REAL
);
CREATE TABLE IF NOT EXISTS turn_stream (
    session_id   TEXT NOT NULL,
    turn         INTEGER NOT NULL,
    seq          INTEGER NOT NULL,
    role         TEXT NOT NULL,
    Elm          TEXT NOT NULL DEFAULT '',
    tool_name    TEXT,
    args_json    TEXT,
    status       TEXT,
    duration_ms  INTEGER,
    tool_calls_json TEXT,
    finish_reason  TEXT,
    usage_prompt_tokens     INTEGER,
    usage_completion_tokens INTEGER,
    biz_category TEXT,
    written_at   REAL,
    Fct          TEXT,
    Hdl          TEXT,
    PRIMARY KEY (session_id, turn, seq)
);
CREATE TABLE IF NOT EXISTS tool_trace (
    session_id     TEXT NOT NULL,
    call_id        TEXT NOT NULL,
    turn           INTEGER,
    step           INTEGER,
    call_seq       INTEGER,
    result_seq     INTEGER,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    args_json      TEXT,
    args_summary   TEXT,
    result_summary TEXT,
    hdl            TEXT,
    error          TEXT,
    exit_code      INTEGER,
    is_error       INTEGER DEFAULT 0,
    result_chars   INTEGER DEFAULT 0,
    entities_json  TEXT,
    status         TEXT NOT NULL DEFAULT 'called',
    duration_ms    INTEGER,
    created_at     REAL,
    PRIMARY KEY (session_id, call_id)
);
CREATE TABLE IF NOT EXISTS llm_calls (
    session_id      TEXT NOT NULL,
    request_seq     INTEGER NOT NULL,
    turn            INTEGER,
    step            INTEGER,
    seq             INTEGER,
    provider        TEXT,
    model           TEXT,
    purpose         TEXT,
    reasoning_effort TEXT,
    messages_count  INTEGER DEFAULT 0,
    input_chars     INTEGER DEFAULT 0,
    reasoning_chars INTEGER DEFAULT 0,
    text_chars      INTEGER DEFAULT 0,
    tool_calls_json TEXT,
    usage_json      TEXT,
    finish_kind     TEXT,
    duration_ms     INTEGER,
    has_replay_state INTEGER DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'completed',
    created_at      REAL,
    PRIMARY KEY (session_id, request_seq)
);
CREATE TABLE IF NOT EXISTS strand_summaries (
    strand_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL,
    topic_id      INTEGER NOT NULL,
    profile       TEXT    NOT NULL DEFAULT '',
    hdl           TEXT,
    turns         TEXT    NOT NULL DEFAULT '[]',
    ooda_json     TEXT    DEFAULT '{}',
    changes_json  TEXT    DEFAULT '[]',
    key_facts_json TEXT   DEFAULT '[]',
    centroid_json TEXT,
    status        TEXT    NOT NULL DEFAULT 'pending',
    created_at    REAL
);
CREATE TABLE IF NOT EXISTS strand_to_reality (
    strand_id  INTEGER NOT NULL,
    reality_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_nodes (
    key        TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    created_at REAL,
    updated_at REAL
);
CREATE TABLE IF NOT EXISTS entity_edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_key    TEXT NOT NULL,
    to_key      TEXT NOT NULL,
    kind        TEXT NOT NULL, -- child_of | cooccurs_with | touches_path | references_path
    anchor      TEXT NOT NULL, -- global | strand:<id> | reality:<id>
    weight      INTEGER NOT NULL DEFAULT 1,
    session_id  TEXT,
    strand_id   INTEGER,
    reality_id  INTEGER,
    source      TEXT NOT NULL DEFAULT 'tool_trace',
    created_at  REAL,
    updated_at  REAL,
    UNIQUE(from_key, to_key, kind, anchor)
);
CREATE TABLE IF NOT EXISTS refinement_meta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tasks_run TEXT NOT NULL DEFAULT '[]',
    entries_reviewed INTEGER DEFAULT 0,
    entries_modified INTEGER DEFAULT 0,
    fcts_cross_checked INTEGER DEFAULT 0,
    inconsistencies INTEGER DEFAULT 0,
    duration_sec REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at REAL
);
CREATE TABLE IF NOT EXISTS realities (
    reality_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,
    hdl             TEXT,
    current_status  TEXT    DEFAULT '{}',
    timeline        TEXT    DEFAULT '[]',
    source_strands  TEXT    DEFAULT '{}',
    profile         TEXT    NOT NULL DEFAULT '',
    centroid_json   TEXT,
    query_centroid_json TEXT,
    query_count     INTEGER DEFAULT 0,
    health_score    REAL DEFAULT 1.0,
    flagged_for_review INTEGER DEFAULT 0,
    topic_count     INTEGER DEFAULT 0,
    reviewed_at     REAL,
    last_reviewed_turn INTEGER DEFAULT 0,
    created_at      REAL,
    updated_at      REAL
);
CREATE TABLE IF NOT EXISTS think_trace (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    turn            INTEGER,
    step            INTEGER,
    seq             INTEGER,
    txn_id          INTEGER,
    topic_id        INTEGER,
    source_kind     TEXT NOT NULL DEFAULT 'cloud_think',
    card_kind       TEXT,
    call_id         TEXT,
    tool_name       TEXT,
    question_text   TEXT NOT NULL DEFAULT '',
    l0_abstract     TEXT,
    l1_json         TEXT,
    entities_json   TEXT,
    embedding_json  TEXT,
    raw_len         INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'raw',
    created_at      REAL,
    updated_at      REAL,
    UNIQUE(session_id, seq)
);
`;

/**
 * 7.3 四表 + 六索引——SQL 与设计 §3.2-3.4（CA-V7-7.3-session-handoff-lenses.md）逐字对齐
 * （列间对齐空白规范化为单空格，token/DEFAULT/UNIQUE/STRICT 逐字一致）。
 * 注意：STRICT 仅 handoff_branches；DEFAULT 值、UNIQUE 组合不得改。
 */
export const HANDOFF_SCHEMA = `
CREATE TABLE IF NOT EXISTS handoff_packages (
    package_id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_session_id TEXT NOT NULL,
    package_key TEXT NOT NULL UNIQUE,
    plan_kind TEXT NOT NULL DEFAULT 'pressure',
    status TEXT NOT NULL DEFAULT 'planned',
    summary_json TEXT NOT NULL DEFAULT '{}',
    source_txn_ids TEXT NOT NULL DEFAULT '[]',
    source_seq_ranges TEXT NOT NULL DEFAULT '[]',
    strand_id INTEGER,
    reality_ids TEXT NOT NULL DEFAULT '[]',
    spawn_session_id TEXT,
    sealed_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_packages_parent
    ON handoff_packages(parent_session_id, created_at);

CREATE TABLE IF NOT EXISTS handoff_branches (
    branch_id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES handoff_packages(package_id),
    parent_session_id TEXT NOT NULL,
    branch_no INTEGER NOT NULL,
    source_txn_start INTEGER NOT NULL,
    source_txn_end INTEGER NOT NULL,
    source_seq_ranges TEXT NOT NULL DEFAULT '[]',
    strand_id INTEGER,
    reality_ids TEXT NOT NULL DEFAULT '[]',
    summary_json TEXT NOT NULL DEFAULT '{}',
    spawn_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    sealed_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE(parent_session_id, source_txn_start, source_txn_end)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_handoff_branches_package
    ON handoff_branches(package_id, branch_no);
CREATE INDEX IF NOT EXISTS idx_handoff_branches_parent
    ON handoff_branches(parent_session_id, source_txn_start);

CREATE TABLE IF NOT EXISTS ca_signals (
    signal_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    value_json TEXT NOT NULL DEFAULT '{}',
    source_seq INTEGER,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ca_signals_session
    ON ca_signals(session_id, created_at);

CREATE TABLE IF NOT EXISTS ca_edge_strength (
    edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_key TEXT NOT NULL,
    to_key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'co_attends',
    weight REAL NOT NULL DEFAULT 0,
    n_click INTEGER NOT NULL DEFAULT 0,
    n_dwell INTEGER NOT NULL DEFAULT 0,
    n_anchor INTEGER NOT NULL DEFAULT 0,
    last_seen_at REAL,
    status TEXT NOT NULL DEFAULT 'weak',
    confirmed_at REAL,
    degraded_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE(from_key, to_key, kind)
);
CREATE INDEX IF NOT EXISTS idx_ca_edge_strength_from
    ON ca_edge_strength(from_key, kind, status);
CREATE INDEX IF NOT EXISTS idx_ca_edge_strength_to
    ON ca_edge_strength(to_key, kind, status);
`;

/**
 * 7.3 人机交流层路由五表（DESIGN-CHANCELLOR-ROUTER §9.2，CA_DB_VERSION=3）——
 * 话题层池/派发/抽取/merge 审计 + 池建议。DDL 逐字对齐设计 §9.2 SQL 块
 * （列间空白规范化为单空格；CHECK/部分唯一索引/幂等键逐字一致）。
 * 职责分工：ca-v7/ca-db 只持有 DDL；CRUD 归 dsh-chancellor/ca-store（K4/K8）。
 * realities.status 条件列（A8/H10）：由 migrateCaDb v3 判定后 ADD（本 schema 不含）。
 */
export const ROUTER_SCHEMA = `
CREATE TABLE IF NOT EXISTS reality_sessions (
    reality_session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    dialogue_session_id TEXT NOT NULL,
    reality_id          INTEGER REFERENCES realities(reality_id),
    topic_role          TEXT,
    session_id          TEXT NOT NULL UNIQUE,
    role                TEXT NOT NULL CHECK(role IN ('inbox','topic')),
    status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','draining','archived','abandoned')),
    created_at          REAL NOT NULL,
    last_active_at      REAL NOT NULL,
    updated_at          REAL NOT NULL,
    CHECK ( (role='inbox' AND reality_id IS NULL AND topic_role IS NULL)
         OR (role='topic' AND reality_id IS NOT NULL AND topic_role IS NULL)
         OR (role='topic' AND reality_id IS NULL AND topic_role IS NOT NULL) )
);
CREATE INDEX IF NOT EXISTS idx_reality_sessions_reality
    ON reality_sessions(reality_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reality_sessions_active
    ON reality_sessions(reality_id) WHERE reality_id IS NOT NULL AND status='active';

CREATE TABLE IF NOT EXISTS router_dispatch (
    dispatch_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    dialogue_session_id TEXT NOT NULL,
    dialogue_seq        INTEGER NOT NULL,
    target_reality_id   INTEGER REFERENCES realities(reality_id),
    target_role         TEXT,
    target_session_id   TEXT NOT NULL,
    task_text           TEXT NOT NULL,
    targets_json        TEXT NOT NULL,
    facts_json          TEXT NOT NULL DEFAULT '[]',
    confidence          REAL,
    topic_reply         TEXT,
    status              TEXT NOT NULL DEFAULT 'routed',
    timeout_ms          INTEGER,
    error_reason        TEXT,
    started_at          REAL,
    finished_at         REAL,
    created_at          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_dispatch_dialogue
    ON router_dispatch(dialogue_session_id, dialogue_seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_router_dispatch_idem
    ON router_dispatch(dialogue_session_id, dialogue_seq, targets_json);

CREATE TABLE IF NOT EXISTS reality_extractions (
    extraction_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    dialogue_session_id TEXT NOT NULL,
    inbox_session_id    TEXT NOT NULL,
    reality_id          INTEGER REFERENCES realities(reality_id),
    source_seq_ranges   TEXT,
    confidence          REAL,
    candidates_json     TEXT NOT NULL DEFAULT '[]',
    skipped_reason      TEXT,
    method              TEXT NOT NULL DEFAULT 'local-llm',
    status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','failed','rolled_back','skipped')),
    created_at          REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reality_extractions_idem
    ON reality_extractions(inbox_session_id, source_seq_ranges)
    WHERE status NOT IN ('rolled_back','skipped','failed');

CREATE TABLE IF NOT EXISTS reality_merges (
    merge_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_session_id    TEXT NOT NULL,
    reality_id          INTEGER NOT NULL REFERENCES realities(reality_id),
    source_seq_ranges   TEXT NOT NULL,
    strand_id           INTEGER REFERENCES strand_summaries(id),
    summary_json        TEXT NOT NULL DEFAULT '{}',
    facts_json          TEXT NOT NULL DEFAULT '[]',
    status              TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('applied','failed')),
    created_at          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reality_merges_reality
    ON reality_merges(reality_id, created_at);

CREATE TABLE IF NOT EXISTS router_pool_suggestions (
    suggestion_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    dialogue_session_id TEXT NOT NULL,
    signal              TEXT NOT NULL,
    suggested_reality_id INTEGER REFERENCES realities(reality_id),
    payload_json        TEXT NOT NULL DEFAULT '{}',
    status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','consumed','expired')),
    created_at          REAL NOT NULL,
    consumed_at         REAL
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // 2026-08-16 稳定化：批量重建管线（strand/reality）逐行自提交 + fsync 造成 ~5GB 写放大
  //（jbd2_log_wait_commit 阻塞 40+ 分钟）。CA 库是可重建缓存（checkpoints 权威），
  // WAL + synchronous=OFF 对批量导入安全：WAL 持久属性、synchronous 仅本连接。
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=OFF');
  return db;
}

function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function tableColumns(db, name) {
  // name 仅来自固定字面量（ca_signals/ca_edge_strength），无注入面
  return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
}

/**
 * 增量迁移（PRAGMA user_version）：
 *   v < 1 → db.exec(SCHEMA)（IF NOT EXISTS，容忍「表已存在但 version=0」旧库）；user_version = 1
 *   v < 2 → 遗留表检测（仅当同名表存在且缺新列时整表重命名，不猜版本）：
 *     ca_signals 缺 signal_id 列 → ALTER TABLE ca_signals RENAME TO ca_signals_v0
 *     ca_edge_strength 缺 edge_id 列 → ALTER TABLE ca_edge_strength RENAME TO ca_edge_strength_v0
 *     db.exec(HANDOFF_SCHEMA)；user_version = 2
 *   v < 3 → realities 缺 status 列 → 条件式 ADD（A8/H10，四值 CHECK，ADD-only）；
 *     db.exec(ROUTER_SCHEMA)；user_version = 3
 *   幂等：重复调用同 user_version 直接返回 { from: v, to: v, legacyRenamed: [] }
 * @returns {{ from: number, to: number, legacyRenamed: string[] }}
 */
export function migrateCaDb(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v >= CA_DB_VERSION) return { from: v, to: v, legacyRenamed: [] };
  const legacyRenamed = [];
  if (v < 1) {
    db.exec(SCHEMA);
    db.exec('PRAGMA user_version = 1');
  }
  // 遗留 v0 shape 检测：PRAGMA table_info 看列名（signal_id/edge_id）。
  // 重命名目标已存在时显式阻断：若跳过 RENAME 继续建 HANDOFF_SCHEMA，
  // 旧 shape 表缺列会让 CREATE INDEX 失败（如 no such column: session_id），
  // user_version 停留在 1，每次 openCaDb 都会重试失败（迁移卡死）。
  const renameLegacy = (name, v0Name, missingCol) => {
    if (!tableExists(db, name) || tableColumns(db, name).includes(missingCol)) return;
    if (tableExists(db, v0Name)) {
      throw new Error(
        `ca-db migration blocked: ${name} 为遗留 v0 shape（legacy shape）但目标表 ${v0Name} 已存在；` +
        `请手动删除/改名其中一个后重试（原表未改动）`,
      );
    }
    db.exec(`ALTER TABLE ${name} RENAME TO ${v0Name}`);
    legacyRenamed.push(name);
  };
  renameLegacy('ca_signals', 'ca_signals_v0', 'signal_id');
  renameLegacy('ca_edge_strength', 'ca_edge_strength_v0', 'edge_id');
  db.exec(HANDOFF_SCHEMA);
  if (v < 2) {
    db.exec('PRAGMA user_version = 2');
  }
  // v3：realities.status 条件列（A8/H10：无该列才 ADD，已有则不动；ADD-only）+ 路由五表
  if (tableExists(db, 'realities') && !tableColumns(db, 'realities').includes('status')) {
    db.exec(`ALTER TABLE realities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active','draining','archived','abandoned'))`);
  }
  db.exec(ROUTER_SCHEMA);
  db.exec('PRAGMA user_version = 3');
  return { from: v, to: CA_DB_VERSION, legacyRenamed };
}

/** openDb + migrateCaDb 组合（公开入口） */
export function openCaDb(path) {
  const db = openDb(path);
  migrateCaDb(db);
  return db;
}

/** 会话元数据 upsert */
export function upsertSessionMeta(db, { session_id, profile, last_turn, last_topic_id, created_at, updated_at }) {
  db.prepare(`
    INSERT INTO session_meta (session_id, profile, last_turn, last_topic_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      profile=excluded.profile, last_turn=excluded.last_turn,
      last_topic_id=excluded.last_topic_id, updated_at=excluded.updated_at
  `).run(session_id, profile ?? '', last_turn ?? 0, last_topic_id ?? 0, created_at ?? null, updated_at ?? null);
}

/** turn_stream 批量插入（事务级行；工具行补 args_json/duration_ms/Fct/Hdl——7.1 P1） */
export function insertTurnRows(db, rows) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO turn_stream
      (session_id, turn, seq, role, Elm, tool_name, args_json, status, duration_ms,
       biz_category, written_at, Fct, Hdl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(r.session_id, r.turn, r.seq, r.role, r.Elm ?? '', r.tool_name ?? null,
             r.args_json ?? null, r.status ?? null, r.duration_ms ?? null,
             r.biz_category ?? null, r.written_at ?? null, r.Fct ?? null, r.Hdl ?? null);
  }
}

/** tool_trace 批量写入（7.1 P1：lib/tool-trace.js 的历史会话落库） */
export function insertToolTraceRows(db, rows) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tool_trace
      (session_id, call_id, turn, step, call_seq, result_seq, name, description,
       args_json, args_summary, result_summary, hdl, error, exit_code, is_error,
       result_chars, entities_json, status, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now() / 1000;
  for (const r of rows) {
    stmt.run(
      r.session_id, r.call_id, r.turn ?? null, r.step ?? null, r.call_seq ?? null, r.result_seq ?? null,
      r.name ?? '', r.description ?? '', r.args_json ?? null, r.args_summary ?? '', r.result_summary ?? '',
      r.hdl ?? '', r.error ?? null, r.exit_code ?? null, r.is_error ? 1 : 0,
      r.result_chars ?? 0, JSON.stringify(r.entities ?? []), r.status ?? 'called',
      r.duration_ms ?? null, now,
    );
  }
}

/** llm_calls 批量写入（7.1 P1：assistant/message 源级云端调用元数据的离线落库） */
export function insertLlmCalls(db, rows) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO llm_calls
      (session_id, request_seq, turn, step, seq, provider, model, purpose, reasoning_effort,
       messages_count, input_chars, reasoning_chars, text_chars, tool_calls_json, usage_json,
       finish_kind, duration_ms, has_replay_state, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now() / 1000;
  for (const r of rows) {
    stmt.run(
      r.session_id, r.request_seq, r.turn ?? null, r.step ?? null, r.seq ?? null,
      r.provider ?? null, r.model ?? null, r.purpose ?? null, r.reasoning_effort ?? null,
      r.messages_count ?? 0, r.input_chars ?? 0, r.reasoning_chars ?? 0, r.text_chars ?? 0,
      JSON.stringify(r.tool_calls ?? []), r.usage ? JSON.stringify(r.usage) : null,
      r.finish_kind ?? null, r.duration_ms ?? null, r.has_replay_state ? 1 : 0,
      r.status ?? 'completed', now,
    );
  }
}

/** think_trace 批量写入（7.2 K0：思考卡，只存 raw_len 不存 reasoning 原文） */
export function insertThinkTraceRows(db, rows) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO think_trace
      (session_id, turn, step, seq, txn_id, topic_id, source_kind, card_kind,
       call_id, tool_name, question_text, l0_abstract, l1_json, entities_json,
       embedding_json, raw_len, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now() / 1000;
  for (const r of rows) {
    stmt.run(
      r.session_id, r.turn ?? null, r.step ?? null, r.seq ?? null, r.txn_id ?? null,
      r.topic_id ?? null, r.source_kind ?? 'cloud_think', r.card_kind ?? null,
      r.call_id ?? null, r.tool_name ?? null, r.question_text ?? '',
      r.l0_abstract ?? null, r.l1_json ?? null, r.entities_json ?? null,
      r.embedding_json ?? null, r.raw_len ?? 0, r.status ?? 'raw', now, now,
    );
  }
}

/** 清空 think_trace（7.2 K0 幂等：先清后插） */
export function clearThinkTrace(db) {
  db.exec('DELETE FROM think_trace;');
}

/** think_trace L1 回填（7.2 K1）：按 (session_id,seq) 更新；status 缺省 'l1' */
export function updateThinkL1Rows(db, rows) {
  const stmt = db.prepare(`
    UPDATE think_trace
       SET l0_abstract=?, l1_json=?, status=?, updated_at=?
     WHERE session_id=? AND seq=?
  `);
  const now = Date.now() / 1000;
  for (const r of rows) {
    stmt.run(r.l0_abstract ?? null, r.l1_json ?? null, r.status ?? 'l1', now, r.session_id, r.seq);
  }
}

/** 实体节点 upsert（key=归一化实体，kind=path/tool/uri/bin/exit/ident/strand/reality） */
export function upsertEntityNodes(db, keys) {
  const stmt = db.prepare(`
    INSERT INTO entity_nodes (key, kind, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at
  `);
  const now = Date.now() / 1000;
  for (const key of keys ?? []) {
    if (typeof key !== 'string' || !key) continue;
    const idx = key.indexOf(':');
    const kind = idx > 0 ? key.slice(0, idx) : 'node';
    stmt.run(key, kind, idx > 0 ? key.slice(idx + 1) : key, now, now);
  }
}

/** 实体边 upsert（anchor 区分 global/strand:<id>/reality:<id>；同边同锚点权重累加） */
export function upsertEntityEdges(db, edges) {
  const stmt = db.prepare(`
    INSERT INTO entity_edges
      (from_key, to_key, kind, anchor, weight, session_id, strand_id, reality_id, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(from_key, to_key, kind, anchor) DO UPDATE SET
      weight = weight + excluded.weight,
      updated_at = excluded.updated_at
  `);
  const now = Date.now() / 1000;
  for (const e of edges ?? []) {
    if (!e?.from_key || !e?.to_key || !e?.kind) continue;
    stmt.run(
      e.from_key, e.to_key, e.kind, e.anchor ?? 'global', e.weight ?? 1,
      e.session_id ?? null, e.strand_id ?? null, e.reality_id ?? null,
      e.source ?? 'tool_trace', now, now,
    );
  }
}

/** 读取跨会话冷启动实体图（与 lib/entity-graph.js 的 buildEntityGraph 输出同构） */
export function loadEntityGraph(db) {
  const nodes = new Set(db.prepare('SELECT key FROM entity_nodes').all().map((r) => r.key));
  const adjacency = new Map();
  const edges = db.prepare('SELECT from_key, to_key, kind, anchor, weight, strand_id, reality_id FROM entity_edges').all();
  for (const e of edges) {
    for (const [x, y] of [[e.from_key, e.to_key], [e.to_key, e.from_key]]) {
      const adj = adjacency.get(x) ?? new Map();
      adj.set(y, (adj.get(y) ?? 0) + e.weight);
      adjacency.set(x, adj);
    }
  }
  return {
    nodes,
    adjacency,
    edges: edges.map((e) => ({ from: e.from_key, to: e.to_key, kind: e.kind, weight: e.weight, anchor: e.anchor, strandId: e.strand_id ?? null, realityId: e.reality_id ?? null })),
    txnEntities: new Map(),
  };
}


export function insertStrand(db, s) {
  const info = db.prepare(`
    INSERT INTO strand_summaries
      (session_id, topic_id, profile, hdl, turns, ooda_json, changes_json, key_facts_json, centroid_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.session_id, s.topic_id, s.profile ?? '', s.hdl ?? '',
    JSON.stringify(s.turns ?? []), JSON.stringify(s.ooda ?? {}, {}) === '{}' ? '{}' : JSON.stringify(s.ooda),
    JSON.stringify(s.changes ?? []), JSON.stringify(s.key_facts ?? []),
    s.centroid_json ? JSON.stringify(s.centroid_json) : null,
    s.status ?? 'completed', s.created_at ?? Date.now() / 1000,
  );
  return Number(info.lastInsertRowid);
}

/** 写 reality，返回 reality_id */
export function insertReality(db, r) {
  const info = db.prepare(`
    INSERT INTO realities
      (name, hdl, current_status, timeline, source_strands, profile, centroid_json, topic_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.name ?? '', r.hdl ?? '', JSON.stringify(r.current_status ?? {}),
    JSON.stringify(r.timeline ?? []), JSON.stringify(r.source_strands ?? {}),
    r.profile ?? '', r.centroid_json ? JSON.stringify(r.centroid_json) : null,
    r.topic_count ?? 0, r.created_at ?? Date.now() / 1000, r.updated_at ?? Date.now() / 1000,
  );
  return Number(info.lastInsertRowid);
}

export function mapStrandToReality(db, strand_id, reality_id) {
  db.prepare('INSERT INTO strand_to_reality (strand_id, reality_id) VALUES (?, ?)').run(strand_id, reality_id);
}

export function clearStrandData(db) {
  db.exec(`
    DELETE FROM strand_summaries;
    DELETE FROM strand_to_reality;
    DELETE FROM realities;
    DELETE FROM turn_stream;
    DELETE FROM tool_trace;
    DELETE FROM llm_calls;
    DELETE FROM think_trace;
    DELETE FROM entity_nodes;
    DELETE FROM entity_edges;
    DELETE FROM session_meta;
  `);
}

export function countStats(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    sessions: one('SELECT COUNT(*) n FROM session_meta').n,
    turns: one('SELECT COUNT(*) n FROM turn_stream').n,
    toolRows: one('SELECT COUNT(*) n FROM tool_trace').n,
    llmCalls: one('SELECT COUNT(*) n FROM llm_calls').n,
    thinkCards: one('SELECT COUNT(*) n FROM think_trace').n,
    entityNodes: one('SELECT COUNT(*) n FROM entity_nodes').n,
    entityEdges: one('SELECT COUNT(*) n FROM entity_edges').n,
    strands: one('SELECT COUNT(*) n FROM strand_summaries').n,
    completed: one("SELECT COUNT(*) n FROM strand_summaries WHERE status='completed'").n,
    skipped: one("SELECT COUNT(*) n FROM strand_summaries WHERE status='skip'").n,
    realities: one('SELECT COUNT(*) n FROM realities').n,
  };
}
