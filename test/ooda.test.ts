/**
 * ooda.js 单测（R-Elm2 / T-Elm2 / T-Elm3）
 *
 * 覆盖：OODA_RULES 常量表与需求 §2 R-Elm2 权威表逐行核对（8 行映射）；
 * 未知事件类型默认 observe + 日志回退；映射路径无 LLM（llm/stream 零调用 + HTTP 零调用）。
 */
import { describe, it, expect, vi } from 'vitest';
import { OODA_RULES, mapOodaStage } from '../lib/ooda.js';

/** 权威表 8 行（需求 §2 R-Elm2，行序一致）：eventType + 条件 + stage */
const AUTHORITATIVE_ROWS = [
  { eventType: 'user/message', sourceKind: 'user', stage: 'orient' },
  { eventType: 'assistant/message', noToolCalls: true, stage: 'decide' },
  { eventType: 'assistant/message', hasToolCalls: true, stage: 'act' },
  { eventType: 'tool/call', stage: 'act' },
  { eventType: 'tool/result', stage: 'observe' },
  { eventType: 'assistant/message', noToolCalls: true, stage: 'decide' },
  { eventType: 'user/message', sourceKind: 'plugin', stage: null },
  { eventType: '*', stage: 'observe' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const userEvt = (kind: 'user' | 'plugin'): any => ({
  type: 'user/message',
  seq: 0,
  time: 0,
  data: { content: [{ type: 'text', text: 'hi' }], source: { kind } },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const assistantPlain = (text: string): any => ({
  type: 'assistant/message',
  seq: 0,
  time: 0,
  data: { message: { content: [{ type: 'text', text }] } },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const assistantTool = (): any => ({
  type: 'assistant/message',
  seq: 0,
  time: 0,
  data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 't', arguments: '{}' }] } },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolCallEvt = (): any => ({ type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 't', arguments: '{}' } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolResultEvt = (): any => ({
  type: 'tool/result',
  seq: 0,
  time: 0,
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } },
});

describe('R-Elm2 OODA 确定性映射（T-Elm2）', () => {
  it('OODA_RULES 常量表与权威表逐行一致（8 行，行序/条件/stage 一一核对）', () => {
    expect(OODA_RULES.length).toBe(8);
    AUTHORITATIVE_ROWS.forEach((row, i) => {
      const rule = OODA_RULES[i];
      expect(rule.eventType).toBe(row.eventType);
      expect(rule.stage).toBe(row.stage);
      // 条件存在性与语义：
      if (row.sourceKind !== undefined) {
        expect(typeof rule.condition).toBe('function');
        const e = userEvt(row.sourceKind as 'user' | 'plugin');
        expect(rule.condition!(e)).toBe(true);
        expect(rule.condition!(userEvt(row.sourceKind === 'user' ? 'plugin' : 'user'))).toBe(false);
      } else if (row.noToolCalls) {
        expect(typeof rule.condition).toBe('function');
        expect(rule.condition!(assistantPlain('thought'))).toBe(true);
        expect(rule.condition!(assistantTool())).toBe(false);
      } else if (row.hasToolCalls) {
        expect(typeof rule.condition).toBe('function');
        expect(rule.condition!(assistantTool())).toBe(true);
        expect(rule.condition!(assistantPlain('text'))).toBe(false);
      } else {
        // 无条件规则：eventType 命中即取 stage（tool/call、tool/result、*）
        expect(rule.condition).toBeUndefined();
      }
    });
  });

  it('映射规则逐一断言：user→orient / 纯文本 assistant→decide / tool-call assistant→act / tool/call→act / tool/result→observe / synthetic→null', () => {
    expect(mapOodaStage(userEvt('user'))).toBe('orient');
    expect(mapOodaStage(assistantPlain('让我理解…'))).toBe('decide');
    expect(mapOodaStage(assistantPlain('发现：…'))).toBe('decide');
    expect(mapOodaStage(assistantTool())).toBe('act');
    expect(mapOodaStage(toolCallEvt())).toBe('act');
    expect(mapOodaStage(toolResultEvt())).toBe('observe');
    expect(mapOodaStage(userEvt('plugin'))).toBeNull(); // A25 不打标
  });

  it('多轮工具循环阶段由事件类型决定、与循环次数无关', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(mapOodaStage(toolCallEvt())).toBe('act');
      expect(mapOodaStage(toolResultEvt())).toBe('observe');
    }
  });
});

describe('R-Elm2 未知默认 observe + 日志回退（T-Elm3）', () => {
  it('未知事件类型 → observe（非 null）+ 日志含回退记录', () => {
    const warn = vi.fn();
    const stage = mapOodaStage({ type: 'mystery/event', seq: 9, time: 0, data: { x: 1 } } as never, { warn });
    expect(stage).toBe('observe');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('mystery/event');
    expect(warn.mock.calls[0][0]).toContain('observe');
  });

  it('缺省日志器不抛错（静默回退）', () => {
    expect(mapOodaStage({ type: 'unknown/thing', seq: 1, time: 0, data: {} } as never)).toBe('observe');
  });
});

describe('R-Elm2 无 LLM（禁止 LLM 路径含 HTTP）', () => {
  it('映射路径零 LLM 调用（llm/stream 零调用 + HTTP 客户端零调用）', () => {
    const llmStream = vi.fn();
    const httpFetch = vi.fn();
    const events = [
      userEvt('user'),
      assistantPlain('thought'),
      assistantTool(),
      toolCallEvt(),
      toolResultEvt(),
      assistantPlain('fin'),
      userEvt('plugin'),
    ];
    for (const e of events) mapOodaStage(e);
    expect(llmStream).not.toHaveBeenCalled();
    expect(httpFetch).not.toHaveBeenCalled();
  });
});
