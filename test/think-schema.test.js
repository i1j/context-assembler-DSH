/**
 * scripts/ca-db.mjs think_trace 表单测（7.2 K0）
 *
 * 覆盖（需求规格 R1/R6/R8）：schema 字段全集、UNIQUE(session_id,seq) 幂等、
 * 零冗余（preview/原文不落库）、clearThinkTrace、countStats.thinkCards。
 * 说明：TS 不能直接 import .mjs（TS2307 实证），本用例为纯 JS，vitest 直接运行。
 */
import { describe, it, expect } from 'vitest';
import { openDb, insertThinkTraceRows, clearThinkTrace, countStats } from '../scripts/ca-db.mjs';

const REQUIRED_COLUMNS = [
  'id', 'session_id', 'turn', 'step', 'seq', 'txn_id', 'topic_id',
  'source_kind', 'card_kind', 'call_id', 'tool_name', 'question_text',
  'l0_abstract', 'l1_json', 'entities_json', 'embedding_json',
  'raw_len', 'status', 'created_at', 'updated_at',
];

function baseRow(over = {}) {
  return {
    session_id: 's1', turn: 1, step: 2, seq: 10, txn_id: 1, topic_id: 3,
    source_kind: 'cloud_think', card_kind: 'decision', call_id: 'c1', tool_name: 'bash',
    question_text: 'q', raw_len: 100, status: 'raw',
    ...over,
  };
}

describe('7.2 K0 think_trace 表', () => {
  it('R1 openDb 后 think_trace 字段全集存在', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(think_trace)').all().map((r) => r.name);
    for (const c of REQUIRED_COLUMNS) expect(cols, '缺少字段 ' + c).toContain(c);
    db.close();
  });

  it('R8 UNIQUE(session_id, seq)：同键两次插入只保留 1 行', () => {
    const db = openDb(':memory:');
    insertThinkTraceRows(db, [baseRow(), baseRow({ raw_len: 200 })]);
    const n = db.prepare('SELECT COUNT(*) n FROM think_trace').get().n;
    expect(n).toBe(1);
    const row = db.prepare('SELECT raw_len FROM think_trace').get();
    expect(row.raw_len).toBe(200);
    db.close();
  });

  it('R6 零冗余：额外 preview/原文字段不落库，行内不出现 reasoning 原文', () => {
    const db = openDb(':memory:');
    const secret = '这段 reasoning 原文绝对不能进 DB';
    insertThinkTraceRows(db, [baseRow({ preview: secret, reasoning_text: secret, l0_abstract: null })]);
    const row = db.prepare('SELECT * FROM think_trace').get();
    expect('preview' in row).toBe(false);
    expect('reasoning_text' in row).toBe(false);
    for (const v of Object.values(row)) {
      expect(v).not.toBe(secret);
    }
    db.close();
  });

  it('clearThinkTrace 清空 + countStats.thinkCards 计数', () => {
    const db = openDb(':memory:');
    insertThinkTraceRows(db, [baseRow(), baseRow({ seq: 11, card_kind: 'conclusion' })]);
    expect(countStats(db).thinkCards).toBe(2);
    clearThinkTrace(db);
    expect(countStats(db).thinkCards).toBe(0);
    db.close();
  });
});
