/**
 * lib/tool-trace.js 单测（7.1 P1）
 *
 * 覆盖：tool/call+tool/result 按 callId 配对折叠；bash/read 结构化摘要与实体提取；
 * result 先于 call 的兜底；argsJson 压缩；行数上限淘汰；投影定义字段；
 * 无关事件返回同一引用（零下游工作契约）。
 */
import { describe, it, expect } from 'vitest';
import { CallId } from '@deepseek-ai/dsh-llm';
import { newSession, appendUser } from './helpers.js';
import {
  TOOL_TRACE_KEY,
  TOOL_TRACE_STATE_VERSION,
  TOOL_TRACE_MAX_ROWS,
  initToolTraceState,
  applyToolTraceState,
  viewToolTraceState,
  createToolTraceProjection,
  setToolTrace,
  exportToolTrace,
  clearToolTraceCache,
} from '../lib/tool-trace.js';

/** 会话事件流直接 fold 为痕迹视图 */
function foldTrace(session: import('@deepseek-ai/dsh-session').Session) {
  let state = initToolTraceState();
  for (const event of session.events) state = applyToolTraceState(state, event as never);
  return viewToolTraceState(state);
}

describe('7.1 P1 tool-trace 投影', () => {
  it('tool/call + tool/result 按 callId 配对：bash 摘要、错误码、实体、状态 completed', () => {
    const session = newSession('trace-bash');
    appendUser(session, 'run a command');
    session.append('turn/start', { turn: 1 });
    const cid = CallId('call-bash-1');
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: cid,
      name: 'bash',
      arguments: '{"command": "pnpm test", "description": "run tests"}',
      description: 'run tests',
    } as never);
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        source: { kind: 'tool', callId: cid },
        content: [
          {
            type: 'tool-result',
            toolCallId: cid,
            content: [{ type: 'text', text: 'ok\n[exit code: 1]\n[stderr] fail here' }],
            isError: true,
          },
        ],
      },
    } as never, { surfaceOp: 'append' } as never);
    const rows = foldTrace(session);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.callId).toBe(String(cid));
    expect(row.name).toBe('bash');
    expect(row.turn).toBe(1);
    expect(row.step).toBe(1);
    expect(row.status).toBe('completed');
    expect(row.exitCode).toBe(1);
    expect(row.isError).toBe(true);
    expect(row.error).toContain('exit_code=1');
    expect(row.resultSummary).toContain('exit=1');
    expect(row.resultSummary).toContain('fail here');
    expect(row.description).toBe('run tests');
    expect(row.argsJson).toContain('pnpm test');
    expect(row.argsSummary).toContain('bash');
    expect(row.entities).toContain('tool:bash');
    expect(row.resultChars).toBeGreaterThan(0);
    expect(typeof row.callSeq).toBe('number');
    expect(typeof row.resultSeq).toBe('number');
  });

  it('read 工具：路径/行数摘要与 path 实体（arguments 携带 file_path）', () => {
    const session = newSession('trace-read');
    session.append('turn/start', { turn: 1 });
    const cid = CallId('call-read');
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: cid,
      name: 'read',
      arguments: '{"file_path": "/tmp/a.md"}',
    } as never);
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        source: { kind: 'tool', callId: cid },
        content: [{
          type: 'tool-result',
          toolCallId: cid,
          content: [{ type: 'text', text: '<path>/tmp/a.md</path>\n<type>file</type>\n<content>\na\nb\nc\n</content>' }],
        }],
      },
    } as never, { surfaceOp: 'append' } as never);
    const rows = foldTrace(session);
    expect(rows).toHaveLength(1);
    expect(rows[0].hdl).toContain('read');
    expect(rows[0].resultSummary).toContain('/tmp/a.md');
    expect(rows[0].resultSummary).toContain('3行');
    expect(rows[0].entities.some((e: string) => e.startsWith('path:'))).toBe(true);
  });

  it('tool/result 先于 tool/call（重放从中间开始）：unknown_tool 兜底，随后 call 补名不重复计数', () => {
    const session = newSession('trace-partial');
    const cid = CallId('call-orphan');
    session.append('tool/result', {
      turn: 2,
      step: 1,
      message: {
        role: 'user',
        source: { kind: 'tool', callId: cid },
        content: [{ type: 'tool-result', toolCallId: cid, content: [{ type: 'text', text: 'x' }] }],
      },
    } as never, { surfaceOp: 'append' } as never);
    let rows = foldTrace(session);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('unknown_tool');
    expect(rows[0].status).toBe('completed');
    session.append('tool/call', { turn: 2, step: 1, callId: cid, name: 'glob', arguments: '{"pattern":"*.md"}' } as never);
    rows = foldTrace(session);
    expect(rows).toHaveLength(1); // 不重复计数
    expect(rows[0].name).toBe('glob'); // 后续 tool/call 补名
    expect(rows[0].resultSeq).not.toBeNull(); // 先到的 result 痕迹不丢
    expect(rows[0].resultSummary).toContain('unknown_tool'); // result 摘要按当时可见信息生成（可回放确定性）
  });

  it('argsJson 压缩：超大字符串截断、非对象解析失败兜底 {}', () => {
    const session = newSession('trace-args');
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('call-big'),
      name: 'write',
      arguments: JSON.stringify({ file_path: '/tmp/a.md', content: 'x'.repeat(5000) }),
    } as never);
    const row = foldTrace(session)[0];
    const args = JSON.parse(row.argsJson);
    expect(args.file_path).toBe('/tmp/a.md');
    expect(args.content.length).toBeLessThanOrEqual(1024);
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-bad'), name: 'x', arguments: 'not-json' } as never);
    const bad = foldTrace(session).find((r) => r.callId === 'call-bad');
    expect(bad).toBeTruthy();
    expect(JSON.parse(bad!.argsJson)).toEqual({});
  });

  it('argsJson 压缩：数组元素递归截断（长字符串不泄漏进有界投影）', () => {
    const session = newSession('trace-args-array');
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('call-arr'),
      name: 'bash',
      arguments: JSON.stringify({ arr: ['x'.repeat(5000), 'ok'] }),
    } as never);
    const args = JSON.parse(foldTrace(session)[0].argsJson);
    expect(args.arr).toHaveLength(2);
    expect(args.arr[0].length).toBeLessThanOrEqual(1024);
    expect(args.arr[1]).toBe('ok');
  });

  it('callId 为原型属性名（__proto__）也能正常入行（Object.hasOwn 回归）', () => {
    let state = initToolTraceState();
    state = applyToolTraceState(state, {
      type: 'tool/call',
      seq: 1,
      time: 0,
      data: { turn: 1, step: 1, callId: '__proto__', name: 'bash', arguments: '{}' },
    } as never);
    const rows = viewToolTraceState(state);
    expect(rows).toHaveLength(1);
    expect(rows[0].callId).toBe('__proto__');
  });

  it('行数上限淘汰：超出 TOOL_TRACE_MAX_ROWS 只保留最新，rowId 仍唯一', () => {
    let state = initToolTraceState();
    for (let i = 0; i < TOOL_TRACE_MAX_ROWS + 5; i += 1) {
      state = applyToolTraceState(state, {
        type: 'tool/call',
        seq: i,
        time: 0,
        data: { turn: 1, step: 1, callId: CallId('call-' + i), name: 'tool_a', arguments: '{}' },
      } as never);
    }
    const rows = viewToolTraceState(state);
    expect(rows).toHaveLength(TOOL_TRACE_MAX_ROWS);
    expect(rows[0].callId).toBe('call-5');
    expect(rows[rows.length - 1].callId).toBe('call-' + (TOOL_TRACE_MAX_ROWS + 4));
    expect(new Set(rows.map((r) => r.rowId)).size).toBe(rows.length);
  });

  it('满员后已被淘汰 callId 的迟到 result 不复活（不挤掉新行）', () => {
    let state = initToolTraceState();
    // 填满后再加 1 行：call-0 被淘汰，order = call-1..call-1024
    for (let i = 0; i < TOOL_TRACE_MAX_ROWS + 1; i += 1) {
      state = applyToolTraceState(state, {
        type: 'tool/call',
        seq: i,
        time: 0,
        data: { turn: 1, step: 1, callId: CallId('call-' + i), name: 'tool_a', arguments: '{}' },
      } as never);
    }
    // 已淘汰 callId 的 result 迟到 → 不创建 unknown_tool 新行
    state = applyToolTraceState(state, {
      type: 'tool/result',
      seq: TOOL_TRACE_MAX_ROWS + 2,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: CallId('call-0'), isError: false, content: [{ type: 'text', text: 'late' }] }],
        },
      },
    } as never);
    const rows = viewToolTraceState(state);
    expect(rows).toHaveLength(TOOL_TRACE_MAX_ROWS);
    expect(rows.every((r) => r.callId !== 'call-0')).toBe(true);
    expect(rows[0].callId).toBe('call-1'); // 没被 unknown_tool 复活挤掉
  });

  it('debug 缓存 FIFO 上限：写入超过 256 个会话时最旧被淘汰', () => {
    clearToolTraceCache();
    for (let i = 0; i < 257; i += 1) setToolTrace('s' + i, [{ mark: 's' + i }] as never);
    expect(exportToolTrace('s0')).toEqual([]); // 最旧已淘汰
    expect(exportToolTrace('s1')).toEqual([{ mark: 's1' }]);
    expect(exportToolTrace('s256')).toEqual([{ mark: 's256' }]);
    clearToolTraceCache();
  });

  it('细颗粒度时间关联：callTime/resultTime/durationMs 由事件时间戳确定性计算', () => {
    let state = initToolTraceState();
    state = applyToolTraceState(state, {
      type: 'tool/call', seq: 1, time: 100,
      data: { turn: 1, step: 1, callId: CallId('c-time'), name: 'bash', arguments: '{"command":"pwd"}' },
    } as never);
    const before = viewToolTraceState(state)[0];
    expect(before.callTime).toBe(100);
    expect(before.resultTime).toBeNull();
    expect(before.durationMs).toBeNull();
    state = applyToolTraceState(state, {
      type: 'tool/result', seq: 2, time: 140,
      data: {
        turn: 1, step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: CallId('c-time') },
          content: [{ type: 'tool-result', toolCallId: CallId('c-time'), content: [{ type: 'text', text: 'ok' }] }],
        },
      },
    } as never);
    const row = viewToolTraceState(state)[0];
    expect(row.resultTime).toBe(140);
    expect(row.durationMs).toBe(40);
  });

  it('无关事件返回同一引用（零下游工作契约）', () => {
    const state = initToolTraceState();
    const same = applyToolTraceState(state, { type: 'user/message', seq: 1, time: 0, data: {} } as never);
    expect(same).toBe(state);
  });

  it('投影定义：key/schema/init/apply/view/stateVersion 契约字段', () => {
    const def = createToolTraceProjection();
    expect(def.key).toBe(TOOL_TRACE_KEY);
    expect(def.stateVersion).toBe(TOOL_TRACE_STATE_VERSION);
    expect(typeof def.init).toBe('function');
    expect(typeof def.apply).toBe('function');
    expect(typeof def.view).toBe('function');
    expect(def.schema).toBeTruthy();
    const rows = def.view(def.init());
    expect(rows).toEqual([]);
  });
});
