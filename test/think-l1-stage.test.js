/**
 * scripts/summarize-history.mjs thinkStage 辅助分支单测（7.2 K1，T7/R5）
 *
 * 覆盖：toolRowsForThinkCard 的 turn 优先 / call_id 回退 / snake→camel 映射。
 * 说明：summarize-history.mjs 已加 isMain 守卫，vitest import 不会执行 CLI 主流程。
 */
import { describe, it, expect } from 'vitest';
import { openDb, insertToolTraceRows } from '../scripts/ca-db.mjs';
import { toolRowsForThinkCard } from '../scripts/summarize-history.mjs';

function traceRow(sessionId, callId, turn, name = 'bash') {
  return {
    session_id: sessionId,
    call_id: callId,
    turn,
    step: 1,
    call_seq: 1,
    result_seq: 2,
    name,
    description: 'd',
    args_json: '{}',
    args_summary: 'args-' + name,
    result_summary: 'result-' + name,
    hdl: 'hdl-' + name,
    error: null,
    exit_code: 0,
    is_error: false,
    result_chars: 10,
    entities: ['path:/tmp/x'],
    status: 'completed',
    duration_ms: 10,
  };
}

describe('7.2 K1 toolRowsForThinkCard', () => {
  it('turn 非 null 且命中：按 turn 返回并映射 camelCase', () => {
    const db = openDb(':memory:');
    insertToolTraceRows(db, [traceRow('s1', 'c1', 3, 'read')]);
    const rows = toolRowsForThinkCard(db, { session_id: 's1', turn: 3, call_id: 'c1' });
    expect(rows).toEqual([{
      name: 'read', argsSummary: 'args-read', resultSummary: 'result-read',
      hdl: 'hdl-read', error: null, exitCode: 0,
    }]);
    db.close();
  });

  it('turn 为 null：回退 call_id', () => {
    const db = openDb(':memory:');
    insertToolTraceRows(db, [traceRow('s1', 'c2', 5, 'grep')]);
    const rows = toolRowsForThinkCard(db, { session_id: 's1', turn: null, call_id: 'c2' });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('grep');
    db.close();
  });

  it('turn 非 null 但无结果：回退 call_id', () => {
    const db = openDb(':memory:');
    insertToolTraceRows(db, [traceRow('s1', 'c3', 7, 'edit')]);
    const rows = toolRowsForThinkCard(db, { session_id: 's1', turn: 99, call_id: 'c3' });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('edit');
    db.close();
  });

  it('均无结果 → 空数组', () => {
    const db = openDb(':memory:');
    expect(toolRowsForThinkCard(db, { session_id: 's1', turn: null, call_id: null })).toEqual([]);
    db.close();
  });
});
