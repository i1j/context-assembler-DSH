/**
 * lib/think-collect.js 单测（7.2 K0）
 *
 * 覆盖（需求规格 T1-T8 + R2/R4 信号规则）：
 * 多 reasoning 块拼接；decision/conclusion 分类；入卡门槛；错误/修正信号；
 * 多 tool-call 单卡规则；无 reasoning 跳过；无 user Elm 兜底；纯函数幂等。
 */
import { describe, it, expect } from 'vitest';
import {
  THINK_MIN_REASONING_CHARS,
  THINK_PREVIEW_CHARS,
  parseAssistantMessage,
  hasToolErrorSignal,
  hasCorrectionSignal,
  buildThinkCtx,
  thinkCardFromEvent,
  collectThinkRows,
} from '../lib/think-collect.js';

function asst(seq: number, turn: number, step: number, blocks: unknown[]) {
  return { type: 'assistant/message', seq, time: seq, data: { turn, step, message: { role: 'assistant', content: blocks } } };
}
function reason(text: string) {
  return { type: 'reasoning', text };
}
function toolCall(id: string, name: string) {
  return { type: 'tool-call', id, name, arguments: '{}' };
}
function elm(type: string, txn: number, ref: number, text = '') {
  return { type, transaction_id: txn, elm_ref: ref, text };
}
function toolRow(turn: number | null, over: Partial<{ error: string | null; isError: boolean; exitCode: number | null }> = {}) {
  return { turn, error: null, isError: false, exitCode: 0, ...over };
}

describe('7.2 K0 think-collect 采集纯函数', () => {
  it('T1 单 reasoning + 单 tool-call → decision 卡（短 reasoning 也入卡）', () => {
    const events = [asst(10, 1, 2, [reason('x'.repeat(100)), toolCall('c1', 'bash')])];
    const viewElms = [elm('user', 1, 1, '运行测试'), elm('thought', 1, 10, '思考文本')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect(c.cardKind).toBe('decision');
    expect(c.callId).toBe('c1');
    expect(c.toolName).toBe('bash');
    expect(c.rawLen).toBe(100);
    expect(c.questionText).toBe('运行测试');
    expect(c.txnId).toBe(1);
    expect(c.turn).toBe(1);
    expect(c.step).toBe(2);
    expect(c.seq).toBe(10);
    expect(c.sourceKind).toBe('cloud_think');
    expect(c.status).toBe('raw');
    expect(c.topicId).toBeNull();
    expect(c.l0Abstract).toBeNull();
    expect(c.l1Json).toBeNull();
    expect(c.embeddingJson).toBeNull();
  });

  it('T2 事务尾 fin 长 reasoning → conclusion 卡', () => {
    const events = [asst(20, 1, 3, [reason('x'.repeat(THINK_MIN_REASONING_CHARS))])];
    const viewElms = [elm('user', 1, 1, '问题'), elm('fin', 1, 20, '结论')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cardKind).toBe('conclusion');
    expect(rows[0]!.callId).toBeNull();
    expect(rows[0]!.toolName).toBe('');
  });

  it('T3 fin 短 reasoning + 同 turn 工具 error 信号 → conclusion 卡', () => {
    const events = [asst(20, 2, 3, [reason('x'.repeat(50))])];
    const viewElms = [elm('user', 1, 1, 'q'), elm('fin', 1, 20, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(2, { error: 'exit_code=1', isError: true, exitCode: 1 })], 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cardKind).toBe('conclusion');
    expect(rows[0]!.rawLen).toBe(50);
  });

  it('T3b fin 短 reasoning + 修正词信号 → conclusion 卡', () => {
    const events = [asst(20, 3, 3, [reason('这里定位到了根因：路径拼写错误')])];
    const viewElms = [elm('user', 1, 1, 'q'), elm('fin', 1, 20, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(3)], 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cardKind).toBe('conclusion');
  });

  it('T4 短 reasoning 无信号：首段无工具 think → orient 卡（决策 44 零门槛）；非首段 → 跳过', () => {
    const shortFin = [asst(20, 1, 3, [reason('x'.repeat(50))])];
    const finElms = [elm('user', 1, 1, 'q'), elm('fin', 1, 20, '')];
    const rows1 = collectThinkRows(shortFin, finElms, [toolRow(1)], 's1');
    expect(rows1).toHaveLength(1);
    expect(rows1[0]!.cardKind).toBe('orient'); // 首段无工具 think 零门槛入卡

    // 非首段（turn 内已有更早 think seq 10）：seq 20 非首段且非 fin 无信号 → 跳过
    const events = [asst(10, 1, 2, [reason('a')]), asst(20, 1, 3, [reason('b')])];
    const thoughtElms = [elm('user', 1, 1, 'q'), elm('thought', 1, 10, ''), elm('thought', 1, 20, '')];
    const rows2 = collectThinkRows(events, thoughtElms, [toolRow(1)], 's1');
    expect(rows2).toHaveLength(1); // 仅 seq 10 的 orient
    expect(rows2[0]!.seq).toBe(10);
  });

  it('T5 多 reasoning 块拼接 + 多 tool-call 单卡（首 call_id + 唯一工具名连接）', () => {
    const events = [asst(30, 1, 2, [
      reason('x'.repeat(30)),
      reason('y'.repeat(40)),
      toolCall('c1', 'bash'),
      toolCall('c2', 'read'),
      toolCall('c3', 'bash'),
    ])];
    const viewElms = [elm('user', 1, 1, 'q'), elm('thought', 1, 30, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rawLen).toBe(70);
    expect(rows[0]!.callId).toBe('c1');
    expect(rows[0]!.toolName).toBe('bash,read');
  });

  it('T6 有 tool-call 但无 reasoning → 不建卡', () => {
    const events = [asst(40, 1, 2, [toolCall('c1', 'bash')])];
    const viewElms = [elm('user', 1, 1, 'q'), elm('thought', 1, 40, '')];
    expect(collectThinkRows(events, viewElms, [toolRow(1)], 's1')).toHaveLength(0);
  });

  it('T7 无 user Elm → questionText 为空串且不抛错', () => {
    const events = [asst(10, 1, 2, [reason('x'.repeat(100)), toolCall('c1', 'bash')])];
    const viewElms = [elm('thought', 1, 10, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.questionText).toBe('');
  });

  it('T8 幂等：同输入两次调用 deep-equal（纯函数）', () => {
    const events = [asst(10, 1, 2, [reason('x'.repeat(100)), toolCall('c1', 'bash')])];
    const viewElms = [elm('user', 1, 1, 'q'), elm('thought', 1, 10, '')];
    const a = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    const b = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(a).toEqual(b);
  });

  it('R2 parseAssistantMessage：空对象/多块/rawLen 与 preview 截断', () => {
    expect(parseAssistantMessage(undefined)).toEqual({ reasoningText: '', rawLen: 0, toolCalls: [] });
    const p = parseAssistantMessage({
      content: [
        { type: 'reasoning', text: 'ab' },
        { type: 'reasoning', text: 'cd' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        { type: 'text', text: '忽略正文' },
      ],
    });
    expect(p.rawLen).toBe(4);
    expect(p.reasoningText).toBe('abcd');
    expect(p.toolCalls).toEqual([{ id: 'c1', name: 'bash', arguments: '{}' }]);
  });

  it('R4 信号辅助函数：error/isError/exitCode 与修正词表', () => {
    expect(hasToolErrorSignal([toolRow(1, { exitCode: 1 })], 1)).toBe(true);
    expect(hasToolErrorSignal([toolRow(1, { isError: true, exitCode: 0 })], 1)).toBe(true);
    expect(hasToolErrorSignal([toolRow(1, { error: 'boom' })], 1)).toBe(true);
    expect(hasToolErrorSignal([toolRow(1)], 1)).toBe(false);
    expect(hasToolErrorSignal([toolRow(1, { exitCode: 1 })], 2)).toBe(false);
    expect(hasToolErrorSignal([toolRow(null, { exitCode: 1 })], null)).toBe(false);
    expect(hasCorrectionSignal('这里找到了根因')).toBe(true);
    expect(hasCorrectionSignal('fixed the bug')).toBe(true);
    expect(hasCorrectionSignal('普通闲聊')).toBe(false);
    expect(hasCorrectionSignal(123 as unknown as string)).toBe(false);
  });

  it('R5 边界：preview ≤160 字符；tool 名上限 5', () => {
    const longReasoning = 'x'.repeat(1000);
    const events = [asst(10, 1, 2, [reason(longReasoning), toolCall('c1', 'bash')])];
    const viewElms = [elm('user', 1, 1, 'q'), elm('thought', 1, 10, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows[0]!.preview.length).toBeLessThanOrEqual(THINK_PREVIEW_CHARS);
    expect(rows[0]!.preview).toBe(longReasoning.slice(0, THINK_PREVIEW_CHARS));

    const many = [1, 2, 3, 4, 5, 6].map((i) => toolCall('c' + i, 't' + i));
    const rows2 = collectThinkRows([asst(11, 1, 3, [reason('x'), ...many])], viewElms, [toolRow(1)], 's1');
    expect(rows2[0]!.toolName).toBe('t1,t2,t3,t4,t5');
  });

  it('R3 边界：无 seq / 无 content / 非 assistant 事件不抛错不入卡', () => {
    const viewElms = [elm('user', 1, 1, 'q'), elm('thought', 1, 10, '')];
    const rows = collectThinkRows([
      { type: 'tool/call', seq: 1, data: {} },
      { type: 'assistant/message', data: { turn: 1, step: 2, message: null } },
    ], viewElms, [toolRow(1)], 's1');
    expect(rows).toHaveLength(0);
  });

  it('buildThinkCtx：fin/user/tool 分组映射', () => {
    const ctx = buildThinkCtx(
      [elm('user', 1, 1, 'q1'), elm('user', 2, 5, 'q2'), elm('fin', 1, 10, ''), elm('fin', 2, 12, '')],
      [toolRow(1, { error: 'e' }), toolRow(1), toolRow(2)],
    );
    expect(ctx.seqToTxn.get(1)).toBe(1);
    expect(ctx.seqToTxn.get(5)).toBe(2);
    expect(ctx.finSeqByTxn.get(1)).toBe(10);
    expect(ctx.finSeqByTxn.get(2)).toBe(12);
    expect(ctx.userTextByTxn.get(1)).toBe('q1');
    expect(ctx.userTextByTxn.get(2)).toBe('q2');
    expect(ctx.toolRowsByTurn.get(1)).toHaveLength(2);
    expect(ctx.toolRowsByTurn.get(2)).toHaveLength(1);
  });

  it('thinkCardFromEvent 对非 assistant 事件返回 null', () => {
    const ctx = { sessionId: 's1', ...buildThinkCtx([], []) };
    expect(thinkCardFromEvent({ type: 'tool/call', seq: 1, data: {} }, ctx)).toBeNull();
  });
});

describe('决策 44 orient 卡（事务内首段 think 零门槛）', () => {
  it('O1 turn 内首段无工具 think（短 reasoning）→ orient 卡（零门槛，不套 800 门槛）', () => {
    const events = [asst(10, 1, 2, [reason('请先分解任务：1. 读文件 2. 改配置')])];
    const viewElms = [elm('user', 1, 1, '帮我完成重构'), elm('thought', 1, 10, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cardKind).toBe('orient');
    expect(rows[0]!.callId).toBeNull();
    expect(rows[0]!.toolName).toBe('');
    expect(rows[0]!.questionText).toBe('帮我完成重构');
  });

  it('O2 首段 think 带工具 → decision 卡优先，后续无工具 think 不再是首段 → 不入卡', () => {
    const events = [
      asst(10, 1, 2, [reason('x'), toolCall('c1', 'bash')]),
      asst(20, 1, 3, [reason('y')]),
    ];
    const viewElms = [elm('user', 1, 1, 'q'), elm('thought', 1, 10, ''), elm('thought', 1, 20, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cardKind).toBe('decision');
  });

  it('O3 首段 think 同时满足 conclusion 条件 → 归 conclusion（门槛序 decision > conclusion > orient）', () => {
    const events = [asst(20, 1, 3, [reason('x'.repeat(THINK_MIN_REASONING_CHARS))])];
    const viewElms = [elm('user', 1, 1, 'q'), elm('fin', 1, 20, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows[0]!.cardKind).toBe('conclusion');
  });

  it('O4 每个 turn 独立记首段：turn2 首段无工具 think → orient 卡', () => {
    const events = [
      asst(10, 1, 2, [reason('a')]),
      asst(20, 2, 2, [reason('b')]),
    ];
    const viewElms = [elm('user', 1, 1, 'q1'), elm('thought', 1, 10, ''), elm('user', 2, 15, 'q2'), elm('thought', 2, 20, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1), toolRow(2)], 's1');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cardKind).toBe('orient');
    expect(rows[1]!.cardKind).toBe('orient');
    expect(rows[1]!.turn).toBe(2);
  });

  it('O5 非首段无工具 think（turn 内第二个）→ 不入卡（捡选纪律）', () => {
    const events = [
      asst(10, 1, 2, [reason('a')]),
      asst(20, 1, 3, [reason('b')]),
    ];
    const viewElms = [elm('user', 1, 1, 'q'), elm('thought', 1, 10, ''), elm('thought', 1, 20, '')];
    const rows = collectThinkRows(events, viewElms, [toolRow(1)], 's1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cardKind).toBe('orient');
    expect(rows[0]!.seq).toBe(10);
  });
});
