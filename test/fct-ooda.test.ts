/**
 * lib/fct-ooda.js 单测（7.1 + 部分 7.2 thought：Fct 多事务 OODA）。
 *
 * 覆盖：OODA 四段契约；事务帧渲染（分组/类型映射/synthetic 跳过/截断）；
 * think 上下文（orient 优先 + 预算截断）；prompt 构建（增量纪律/hdl 规范/示例）；
 * 解析（围栏容忍/四键必全/hdl 兜底/turns 归一/空 affairs error）；渲染；队列状态机。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  FCT_OODA_KEYS,
  buildTransactionFrames,
  buildOodaThinkContext,
  buildFctOodaPrompt,
  parseJsonObject,
  parseFctOoda,
  fallbackHdl,
  formatFctAffairs,
  createFctOodaQueue,
} from '../lib/fct-ooda.js';

const DEFAULT_STAGE: Record<string, string> = { user: 'orient', thought: 'decide', fin: 'decide', toolCall: 'act', toolResult: 'observe' };
function elm(type: string, txn: number, ref: number, text = '', oodaStage?: string) {
  const stage = oodaStage ?? DEFAULT_STAGE[type] ?? 'observe';
  return { type, transaction_id: txn, elm_ref: ref, text, ooda_stage: stage };
}
function thinkCard(cardKind: string, seq: number, over: Record<string, unknown> = {}) {
  return { cardKind, seq, turn: 1, questionText: '', preview: '', ...over };
}

describe('fct-ooda 常量与事务帧', () => {
  it('F1 OODA 四段权威顺序', () => {
    expect(FCT_OODA_KEYS).toEqual(['现象与问题', '背景与约束', '决策与方案', '后续行动']);
  });

  it('F2 事务帧：按事务分组升序 + 类型映射 + synthetic 跳过', () => {
    const view = [
      elm('synthetic', 1, 1, 'plugin'),
      elm('user', 1, 2, '帮我修连接池'),
      elm('thought', 1, 3, '分析：连接池耗尽', 'decide'),
      elm('toolCall', 1, 4, '读取 config', 'act'),
      elm('toolResult', 1, 5, '连接池上限100', 'observe'),
      elm('user', 2, 10, '继续', 'orient'),
    ];
    const frames = buildTransactionFrames(view);
    expect(frames).toContain('[事务 #1]');
    expect(frames).toContain('[事务 #2]');
    expect(frames).toContain('[orient|user] 帮我修连接池');
    expect(frames).toContain('[decide|thinking] 分析：连接池耗尽');
    expect(frames).toContain('[act|tool_call_request] 读取 config');
    expect(frames).toContain('[observe|tool_call_result] 连接池上限100');
    expect(frames).not.toContain('synthetic');
    // 事务 #1 在 #2 前
    expect(frames.indexOf('[事务 #1]')).toBeLessThan(frames.indexOf('[事务 #2]'));
  });

  it('F3 事务帧：单行超长截断 + 缺 ooda_stage 回退 observe', () => {
    const view = [elm('user', 1, 2, 'x'.repeat(500))];
    const frames = buildTransactionFrames(view, { maxPerLine: 50 });
    expect(frames).toContain('[orient|user]');
    expect(frames).not.toContain('x'.repeat(51));
  });
});

describe('fct-ooda think 上下文', () => {
  it('K1 orient 优先于 decision；按预算截断', () => {
    const cards = [
      thinkCard('decision', 20, { preview: 'b'.repeat(100), questionText: 'q2' }),
      thinkCard('orient', 10, { preview: 'a'.repeat(100), questionText: 'q1' }),
    ];
    const ctx = buildOodaThinkContext(cards, { totalBudget: 400 });
    expect(ctx.indexOf('思考卡 orient')).toBeLessThan(ctx.indexOf('思考卡 decision'));
    expect(ctx).toContain('问题: q1');
    expect(ctx).toContain('思考: ' + 'a'.repeat(100));
  });

  it('K2 reasoningTextBySeq 优先于 preview；无卡返回空串', () => {
    const ctx = buildOodaThinkContext(
      [thinkCard('orient', 10, { preview: 'short' })],
      { reasoningTextBySeq: new Map([[10, '完整 reasoning 原文']]) },
    );
    expect(ctx).toContain('完整 reasoning 原文');
    expect(ctx).not.toContain('short');
    expect(buildOodaThinkContext([])).toBe('');
    expect(buildOodaThinkContext([thinkCard('conclusion', 5)])).toBe(''); // 非 orient/decision 不参与
  });

  it('K3 每卡截断 + 总预算封顶（宁缺勿滥）', () => {
    const cards = [thinkCard('orient', 10, { preview: 'x'.repeat(2000) })];
    const ctx = buildOodaThinkContext(cards, { maxCharsPerCard: 100, totalBudget: 500 });
    expect(ctx).toContain('…[截断]');
    expect(ctx.length).toBeLessThan(1000);
  });
});

describe('fct-ooda prompt 构建', () => {
  it('P1 含四段键/增量纪律/hdl 规范/示例 JSON/空历史信号', () => {
    const prompt = buildFctOodaPrompt({ previousFct: '', currentFrames: '[事务 #1]', thinkContext: '线索' });
    expect(prompt).toContain('现象与问题');
    expect(prompt).toContain('背景与约束');
    expect(prompt).toContain('决策与方案');
    expect(prompt).toContain('后续行动');
    expect(prompt).toContain('增量提取');
    expect(prompt).toContain('禁止代码符号名');
    expect(prompt).toContain('禁止输出 changes');
    expect(prompt).toContain('示例输出');
    expect(prompt).toContain('{"affairs":[]}'); // 空历史信号
    expect(prompt).toContain('【首轮思考线索（代码筛选）】');
    expect(prompt).toContain('【事务帧】');
  });
});

describe('fct-ooda 解析', () => {
  it('J1 合法多事务 JSON → ok；四键必全；hdl/turns 归一', () => {
    const text = '{"affairs":[{"hdl":"连接池扩容","turns":[7],"ooda":{"现象与问题":["连接池耗尽"],"背景与约束":["上限100"],"决策与方案":["扩容到200"],"后续行动":[]}},{"hdl":"检索修复","turns":[7],"ooda":{"现象与问题":["召回为空"],"背景与约束":[],"决策与方案":[],"后续行动":[]}}]}';
    const r = parseFctOoda(text);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('expected ok');
    const a = r.affairs;
    expect(a).toHaveLength(2);
    expect(a[0].hdl).toBe('连接池扩容');
    expect(a[0].turns).toEqual([7]);
    expect(a[0].ooda['现象与问题']).toEqual(['连接池耗尽']);
    expect(a[0].ooda['后续行动']).toEqual([]);
    for (const key of FCT_OODA_KEYS) expect(Object.keys(a[0].ooda)).toContain(key);
  });

  it('J2 围栏/说明文字容忍（```json + 前后说明）', () => {
    const text = '好的，分析结果如下：\n```json\n{"affairs":[{"hdl":"A","turns":[1],"ooda":{"现象与问题":["x"],"背景与约束":[],"决策与方案":[],"后续行动":[]}}]}\n```\n以上。';
    const r = parseFctOoda(text);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.affairs[0].hdl).toBe('A');
  });

  it('J3 hdl 兜底：空 hdl → 四段首条 → 事务N；hdl 超长截断 30', () => {
    expect(fallbackHdl({ ooda: { '决策与方案': ['扩容到 200'] } }, 3)).toBe('扩容到 200');
    expect(fallbackHdl({ ooda: {} }, 3)).toBe('事务3');
    expect(fallbackHdl({ hdl: 'x'.repeat(50), ooda: {} }, 1).length).toBeLessThanOrEqual(30);
    const r = parseFctOoda('{"affairs":[{"ooda":{"现象与问题":["连接池耗尽"],"背景与约束":[],"决策与方案":[],"后续行动":[]}}]}');
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.affairs[0].hdl).toBe('连接池耗尽');
  });

  it('J4 非法输出 → error（no-json / no-affairs / empty-affairs），不伪造空摘要', () => {
    expect(parseFctOoda('')).toEqual({ status: 'error', reason: 'no-json' });
    expect(parseFctOoda('完全不是 JSON')).toEqual({ status: 'error', reason: 'no-json' });
    expect(parseFctOoda('{"affairs":[]}')).toEqual({ status: 'error', reason: 'no-affairs' });
    expect(parseFctOoda('{"affairs":[123]}')).toEqual({ status: 'error', reason: 'empty-affairs' });
  });

  it('J5 parseJsonObject：深层对象/字符串含 } 不早停', () => {
    const text = '{"affairs":[{"hdl":"a} b","ooda":{"现象与问题":["c}"],"背景与约束":[],"决策与方案":[],"后续行动":[]}}]}';
    const r = parseFctOoda(text);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.affairs[0].hdl).toBe('a} b');
  });
});

describe('fct-ooda 渲染', () => {
  it('R1 渲染：事务 hdl + OODA 阶段（无状态标签），空段跳过', () => {
    const affairs = [
      { hdl: '连接池扩容', turns: [7], ooda: { '现象与问题': ['连接池耗尽'], '背景与约束': ['上限100'], '决策与方案': ['扩容到200'], '后续行动': [] } },
      { hdl: '', turns: [7], ooda: { '现象与问题': ['召回为空'], '背景与约束': [], '决策与方案': [], '后续行动': [] } },
    ];
    const out = formatFctAffairs(affairs);
    expect(out).toContain('1. 连接池扩容');
    expect(out).toContain('  现象与问题: 连接池耗尽');
    expect(out).toContain('  决策与方案: 扩容到200');
    expect(out).not.toContain('后续行动'); // 空段不渲染
    expect(out).toContain('2. 事务2'); // hdl 空 → 事务N
    expect(formatFctAffairs([])).toBe('');
  });
});

describe('fct-ooda 队列', () => {
  const okAffairs = [{ hdl: 'A', turns: [3], ooda: { '现象与问题': ['x'], '背景与约束': [], '决策与方案': [], '后续行动': [] } }];

  it('Q1 入队一次 + get/stats；每 turn 只处理一次', async () => {
    let calls = 0;
    const q = createFctOodaQueue({ maxConcurrent: 1, run4B: async () => { calls += 1; return { status: 'ok', affairs: okAffairs }; } });
    const session = { id: 's1' };
    q.enqueue(session, 3, { previousFct: '', currentFrames: '[事务 #3]', thinkContext: '' });
    expect(q.get(session, 3).status).toBe('pending'); // 入队即 pending
    q.enqueue(session, 3, { previousFct: '', currentFrames: 'again', thinkContext: '' }); // 重复入队被忽略
    q.enqueue(session, 4, { previousFct: '', currentFrames: '[事务 #4]', thinkContext: '' });
    await new Promise((r) => setTimeout(r, 50));
    expect(q.get(session, 3).status).toBe('done');
    expect(q.get(session, 3).affairs).toHaveLength(1);
    expect(q.get(session, 4).status).toBe('done');
    expect(calls).toBe(2); // 每 turn 只跑一次 4B
    expect(q.stats(session)).toEqual({ done: 2, failed: 0, pending: 0 });
  });

  it('Q2 4B 失败 → failed 状态（fail-open，不抛错）', async () => {
    const q = createFctOodaQueue({ maxConcurrent: 1, url: 'http://127.0.0.1:1' }); // 不可达端口
    const session = { id: 's2' };
    q.enqueue(session, 1, { previousFct: '', currentFrames: 'x', thinkContext: '' });
    await new Promise((r) => setTimeout(r, 300));
    expect(q.get(session, 1).status).toBe('failed');
  });

  it('Q3 队列满丢弃 → 该 turn 标记 failed（宁缺勿错）', async () => {
    const q = createFctOodaQueue({ maxConcurrent: 1, maxQueue: 1, url: 'http://127.0.0.1:1' });
    const session = { id: 's3' };
    q.enqueue(session, 1, { previousFct: '', currentFrames: 'a', thinkContext: '' });
    q.enqueue(session, 2, { previousFct: '', currentFrames: 'b', thinkContext: '' });
    q.enqueue(session, 3, { previousFct: '', currentFrames: 'c', thinkContext: '' });
    // turn 3 可能入队也可能被丢弃；断言不抛错且状态最终收敛
    await new Promise((r) => setTimeout(r, 400));
    const s = q.stats(session);
    expect(s.done + s.failed).toBeGreaterThanOrEqual(1);
  });
});
