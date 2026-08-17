/**
 * scripts/ca-db.mjs updateThinkL1Rows 单测（7.2 K1）
 *
 * 覆盖需求规格 T5/T6：按 (session_id,seq) 精确更新、其余行不变、
 * status='l1'、updated_at 非空、schema 前后一致、DB 零冗余。
 */
import { describe, it, expect } from 'vitest';
import { openDb, insertThinkTraceRows, updateThinkL1Rows } from '../scripts/ca-db.mjs';

function rawRow(sessionId, seq) {
  return {
    session_id: sessionId, turn: 1, step: 2, seq, txn_id: 1, topic_id: 3,
    source_kind: 'cloud_think', card_kind: 'decision', call_id: 'c' + seq,
    tool_name: 'bash', question_text: 'q', raw_len: 100, status: 'raw',
  };
}

describe('7.2 K1 updateThinkL1Rows', () => {
  it('T5 仅更新目标 (session_id,seq)，其余行不变，schema 前后一致', () => {
    const db = openDb(':memory:');
    const before = db.prepare('PRAGMA table_info(think_trace)').all();
    insertThinkTraceRows(db, [rawRow('s1', 1), rawRow('s2', 2)]);
    db.prepare('UPDATE think_trace SET updated_at=NULL').run();
    updateThinkL1Rows(db, [{
      session_id: 's1', seq: 1,
      l0_abstract: 'g → c',
      l1_json: JSON.stringify({ goal: 'g', decisions: ['d'], corrections: [], conclusion: 'c', applies_when: 'w', confidence: 0.8 }),
      status: 'l1',
    }]);
    const a = db.prepare('SELECT l0_abstract, l1_json, status, updated_at FROM think_trace WHERE session_id=? AND seq=?').get('s1', 1);
    expect(a.l0_abstract).toBe('g → c');
    expect(JSON.parse(a.l1_json).goal).toBe('g');
    expect(a.status).toBe('l1');
    expect(a.updated_at).not.toBeNull();
    const b = db.prepare('SELECT l0_abstract, l1_json, status, updated_at FROM think_trace WHERE session_id=? AND seq=?').get('s2', 2);
    expect(b.l0_abstract).toBeNull();
    expect(b.l1_json).toBeNull();
    expect(b.status).toBe('raw');
    expect(b.updated_at).toBeNull();
    const after = db.prepare('PRAGMA table_info(think_trace)').all();
    expect(after).toEqual(before);
    db.close();
  });

  it('T5b status 缺省 → l1', () => {
    const db = openDb(':memory:');
    insertThinkTraceRows(db, [rawRow('s1', 1)]);
    updateThinkL1Rows(db, [{ session_id: 's1', seq: 1, l0_abstract: 'a', l1_json: '{}' }]);
    const row = db.prepare('SELECT status FROM think_trace').get();
    expect(row.status).toBe('l1');
    db.close();
  });

  it('T6 零冗余：插入/更新携带额外 reasoning 字段不落库，所有列拼接不含长唯一子串', () => {
    const db = openDb(':memory:');
    const needle = 'UNIQUE-REASONING-NEEDLE-7.2-K1-'.repeat(8);
    insertThinkTraceRows(db, [{ ...rawRow('s1', 1), reasoning: needle }]);
    updateThinkL1Rows(db, [{
      session_id: 's1', seq: 1,
      l0_abstract: 'g → c',
      l1_json: JSON.stringify({ goal: 'g', decisions: ['d'], corrections: [], conclusion: 'c', applies_when: 'w', confidence: 0.8 }),
      reasoning: needle,
    }]);
    const joined = db.prepare('SELECT * FROM think_trace').all()
      .map((r) => Object.values(r).map((v) => (v === null || v === undefined ? '' : String(v))).join('|'))
      .join('\n');
    expect(joined).not.toContain(needle);
    db.close();
  });
});
