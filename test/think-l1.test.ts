/**
 * lib/think-l1.js 单测（7.2 K1：思考卡 L1 提炼）
 *
 * 覆盖需求规格 T1/T2/T3/T4/T9：
 * 输入构造（截断 6000/工具前 8 条/字段占位）；JSON 解析与 schema 负例/边界；
 * thinkL1Once 每卡一次调用、kind 映射（http/fetch/timeout/parse）、low 头与超时 signal；
 * selectUniqueThinkCards 按 session_id:seq 去重且仅 raw。
 */
import { describe, it, expect } from 'vitest';
import {
  THINK_L1_MAX_REASONING_CHARS,
  THINK_L1_MAX_QUESTION_CHARS,
  THINK_L1_MAX_TOOLS,
  MOCK_THINK_L1_TEXT,
  clipThinkText,
  buildThinkL1Input,
  parseThinkL1,
  thinkL1Once,
  selectUniqueThinkCards,
  resolveThinkReasoning,
} from '../lib/think-l1.js';

function toolRow(over: Record<string, unknown> = {}) {
  return {
    name: 'read',
    argsSummary: 'read /tmp/a.md',
    resultSummary: 'file content summary',
    hdl: 'read /tmp/a.md',
    error: null,
    exitCode: null,
    ...over,
  };
}

function l1(over: Record<string, unknown> = {}) {
  return {
    goal: 'g',
    decisions: ['d'],
    corrections: [],
    conclusion: 'c',
    applies_when: 'w',
    confidence: 0.7,
    ...over,
  };
}

function resp(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

describe('7.2 K1 think-l1 输入构造（T1）', () => {
  it('reasoning 7000 字符截断到 6000+标记', () => {
    const reasoning = 'r'.repeat(7000);
    const out = buildThinkL1Input({ questionText: 'Q?', reasoningText: reasoning, toolRows: [] });
    expect(out).toContain('Q?');
    expect(out).toContain('r'.repeat(THINK_L1_MAX_REASONING_CHARS));
    expect(out).toContain('…[截断]');
    expect(out).not.toContain('r'.repeat(7000));
  });

  it('超长 questionText 截断到上限 + 标记（防撑爆本地 4B 输入）', () => {
    const q = 'q'.repeat(100000);
    const out = buildThinkL1Input({ questionText: q, reasoningText: 'r', toolRows: [] });
    expect(out).toContain('q'.repeat(THINK_L1_MAX_QUESTION_CHARS));
    expect(out).toContain('…[截断]');
    expect(out).not.toContain(q);
  });

  it('9 条工具只取前 8 条且逐字段占位（T1/B13）', () => {
    const rows = Array.from({ length: 9 }, (_, i) => toolRow({ name: 't' + i, exitCode: i }));
    const out = buildThinkL1Input({ questionText: 'Q', reasoningText: 'R', toolRows: rows });
    for (let i = 0; i < THINK_L1_MAX_TOOLS; i++) expect(out).toContain('t' + i);
    expect(out).not.toContain('t8');
    for (const field of ['read /tmp/a.md', 'file content summary', 'exitCode']) {
      expect(out).toContain(field);
    }
  });

  it('clipThinkText 非 string 返回空串', () => {
    expect(clipThinkText(undefined as unknown as string, 10)).toBe('');
  });

  it('toolField 空值占位：null/undefined/空串 → (无)', () => {
    const out = buildThinkL1Input({
      questionText: 'Q',
      reasoningText: 'R',
      toolRows: [{ name: '', argsSummary: null, resultSummary: undefined, hdl: '', error: null, exitCode: undefined }] as never,
    });
    expect(out.match(/\(无\)/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe('7.2 K1 parseThinkL1（T2/T3）', () => {
  it('剥围栏/说明文字后解析合法并生成 l0Abstract', () => {
    const raw = '说明\n```json\n' + JSON.stringify(l1()) + '\n```\n尾巴';
    const r = parseThinkL1(raw);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.l0Abstract).toBe('g → c');
      expect(r.l1Json.confidence).toBe(0.7);
      expect(typeof r.l1Json.goal).toBe('string');
      expect(Array.isArray(r.l1Json.decisions)).toBe(true);
      expect(Array.isArray(r.l1Json.corrections)).toBe(true);
      expect(typeof r.l1Json.conclusion).toBe('string');
      expect(typeof r.l1Json.applies_when).toBe('string');
      expect(typeof r.l1Json.confidence).toBe('number');
    }
  });

  it('边界正例：decisions 1/3、corrections 空/含空串元素、confidence 0/1', () => {
    for (const d of [['d1'], ['d1', 'd2', 'd3']]) {
      for (const c of [0, 1]) {
        const r = parseThinkL1(JSON.stringify(l1({ decisions: d, corrections: [], confidence: c })));
        expect(r.status).toBe('ok');
      }
    }
    for (const corrections of [[''], ['a', '']]) {
      expect(parseThinkL1(JSON.stringify(l1({ corrections }))).status).toBe('ok');
    }
  });

  it('R2 逐字段负例全部 error.kind=parse', () => {
    const negatives: Array<Record<string, unknown>> = [
      {},
      { ...l1(), goal: '' },
      { ...l1(), goal: 3 },
      { ...l1(), decisions: undefined },
      { ...l1(), decisions: 'd' },
      { ...l1(), decisions: [] },
      { ...l1(), decisions: ['a', 'b', 'c', 'd'] },
      { ...l1(), decisions: ['a', 2] },
      { ...l1(), corrections: undefined },
      { ...l1(), corrections: 'x' },
      { ...l1(), corrections: ['ok', 3] },
      { ...l1(), conclusion: undefined },
      { ...l1(), conclusion: '' },
      { ...l1(), conclusion: 5 },
      { ...l1(), applies_when: undefined },
      { ...l1(), applies_when: '' },
      { ...l1(), applies_when: 5 },
      { ...l1(), confidence: undefined },
      { ...l1(), confidence: null },
      { ...l1(), confidence: '0.7' },
      { ...l1(), confidence: true },
      { ...l1(), confidence: [0.7] },
      { ...l1(), confidence: { v: 0.7 } },
      { ...l1(), confidence: 1.5 },
      { ...l1(), confidence: -0.1 },
    ];
    for (const neg of negatives) {
      const r = parseThinkL1(JSON.stringify(neg));
      expect(r.status, JSON.stringify(neg)).toBe('error');
      if (r.status === 'error') expect(r.error.kind).toBe('parse');
    }
  });

  it('非 JSON / 空 JSON 块 → error.kind=parse', () => {
    for (const raw of ['not json at all', '', '{"goal": "g"', '[]']) {
      const r = parseThinkL1(raw);
      expect(r.status, raw).toBe('error');
    }
  });

  it('parseThinkL1 非 string 入参 → error.kind=parse', () => {
    for (const raw of [undefined, null, 42, {}, []]) {
      const r = parseThinkL1(raw as unknown as string);
      expect(r.status).toBe('error');
      if (r.status === 'error') expect(r.error.kind).toBe('parse');
    }
  });

  it('mock 固定文本可解析且合法', () => {
    const r = parseThinkL1(MOCK_THINK_L1_TEXT);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.l1Json.conclusion).toBeTruthy();
  });
});

describe('7.2 K1 thinkL1Once 一次调用（T4）', () => {
  const row = { questionText: 'q', reasoningText: 'r', toolRows: [toolRow()] };

  it('成功：fetch 1 次、ok text、low 头与 signal', async () => {
    let calls = 0;
    const fetchFn = async (_url: string, init: RequestInit) => {
      calls += 1;
      expect(String((init.headers as Record<string, string>)['X-Queue-Priority'])).toBe('low');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return resp(200, JSON.stringify({ response: '{"goal":"g","decisions":["d"],"corrections":[],"conclusion":"c","applies_when":"w","confidence":0.5}' }));
    };
    const r = await thinkL1Once(row, { fetchFn, timeoutMs: 60000 });
    expect(r.status).toBe('ok');
    expect(calls).toBe(1);
  });

  it('非 200：1 次、kind=http', async () => {
    let calls = 0;
    const fetchFn = async () => { calls += 1; return resp(500, 'boom'); };
    const r = await thinkL1Once(row, { fetchFn });
    expect(r).toMatchObject({ status: 'error', error: { kind: 'http' } });
    expect(calls).toBe(1);
  });

  it('fetch 抛普通错误：1 次、kind=fetch', async () => {
    let calls = 0;
    const fetchFn = async () => { calls += 1; throw new Error('net down'); };
    const r = await thinkL1Once(row, { fetchFn });
    expect(r).toMatchObject({ status: 'error', error: { kind: 'fetch' } });
    expect(calls).toBe(1);
  });

  it('AbortError 与 TimeoutError：各 1 次、kind=timeout', async () => {
    for (const err of [{ name: 'AbortError', message: 'aborted' }, new DOMException('timeout', 'TimeoutError')]) {
      let calls = 0;
      const fetchFn = async () => { calls += 1; throw err; };
      const r = await thinkL1Once(row, { fetchFn });
      expect(r).toMatchObject({ status: 'error', error: { kind: 'timeout' } });
      expect(calls).toBe(1);
    }
  });

  it('2xx 但 resp.json 抛错：1 次、kind=parse', async () => {
    let calls = 0;
    const bad = { ok: true, status: 200, text: async () => 'x', json: async () => { throw new Error('bad json'); } };
    const fetchFn = async () => { calls += 1; return bad as unknown as Response; };
    const r = await thinkL1Once(row, { fetchFn });
    expect(r).toMatchObject({ status: 'error', error: { kind: 'parse' } });
    expect(calls).toBe(1);
  });

  it('fetch 成功但 parseThinkL1 报错时 fetch 计数仍为 1', async () => {
    let calls = 0;
    const fetchFn = async () => { calls += 1; return resp(200, JSON.stringify({ response: 'not json' })); };
    const once = await thinkL1Once(row, { fetchFn });
    expect(once.status).toBe('ok');
    if (once.status === 'ok') {
      const parsed = parseThinkL1(once.text);
      expect(parsed.status).toBe('error');
      if (parsed.status === 'error') expect(parsed.error.kind).toBe('parse');
    }
    expect(calls).toBe(1);
  });

  it('真实 AbortSignal.timeout(5)：5ms 后 abort，fetch 1 次且 kind=timeout', async () => {
    let calls = 0;
    const fetchFn = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      calls += 1;
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('timeout', 'TimeoutError')));
    });
    const r = await thinkL1Once(row, { fetchFn, timeoutMs: 5 });
    expect(r).toMatchObject({ status: 'error', error: { kind: 'timeout' } });
    expect(calls).toBe(1);
  });
});

describe('7.2 K1 selectUniqueThinkCards（T9）', () => {
  it('重复 key 折叠 + 仅保留 raw', () => {
    const rows = [
      { session_id: 's1', seq: 1, status: 'raw' },
      { session_id: 's1', seq: 1, status: 'raw' },
      { session_id: 's1', seq: 2, status: 'l1' },
      { session_id: 's2', seq: 1, status: 'raw' },
    ];
    const out = selectUniqueThinkCards(rows);
    expect(out).toEqual([
      { session_id: 's1', seq: 1, status: 'raw' },
      { session_id: 's2', seq: 1, status: 'raw' },
    ]);
  });

  it('空/null 输入与缺失 key 不抛错且过滤', () => {
    expect(selectUniqueThinkCards(undefined as unknown as unknown[])).toEqual([]);
    expect(selectUniqueThinkCards(null as unknown as unknown[])).toEqual([]);
    expect(selectUniqueThinkCards([null, {}, { session_id: undefined, seq: undefined, status: 'raw' }] as unknown[]))
      .toEqual([{ session_id: undefined, seq: undefined, status: 'raw' }]);
  });

  it('按唯一卡数逐卡调用 fetch 计数===唯一卡数', async () => {
    const rows = [
      { session_id: 's1', seq: 1, status: 'raw', question_text: 'q', turn: 1 },
      { session_id: 's1', seq: 1, status: 'raw', question_text: 'q', turn: 1 },
      { session_id: 's1', seq: 2, status: 'l1', question_text: 'q', turn: 1 },
      { session_id: 's2', seq: 1, status: 'raw', question_text: 'q', turn: 2 },
    ];
    let calls = 0;
    const fetchFn = async () => { calls += 1; return resp(200, JSON.stringify({ response: MOCK_THINK_L1_TEXT })); };
    for (const card of selectUniqueThinkCards(rows)) {
      await thinkL1Once({ questionText: card.question_text, reasoningText: 'r', toolRows: [] }, { fetchFn });
    }
    expect(calls).toBe(2);
  });
});

describe('7.2 K1 resolveThinkReasoning（T7/R9）', () => {
  it('sessionMap 非 Map → session_missing（带 sessionId）', () => {
    const r = resolveThinkReasoning(null as unknown as Map<number, string>, { sessionId: 'sid-1', seq: 1 } as never);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect((r.error as { kind: string; message: string }).kind).toBe('session_missing');
      expect((r.error as { kind: string; message: string }).message).toContain('sid-1');
    }
  });

  it('seq 缺失/空 reasoning → reasoning_missing', () => {
    const map = new Map<number, string>([[1, 'r']]);
    for (const seq of [2, 1]) {
      const m = seq === 1 ? new Map<number, string>([[1, '']]) : map;
      const r = resolveThinkReasoning(m, { sessionId: 'sid', seq } as never);
      expect(r.status).toBe('error');
      if (r.status === 'error') expect((r.error as { kind: string }).kind).toBe('reasoning_missing');
    }
  });

  it('命中 → ok + reasoningText', () => {
    const r = resolveThinkReasoning(new Map([[5, 'hello']]), { sessionId: 'sid', seq: 5 } as never);
    expect(r).toEqual({ status: 'ok', reasoningText: 'hello' });
  });
});

describe('7.2 K1 质量抽检 prompt 修复（decisions 约束）', () => {
  it('prompt 强化：decisions 必须恰好 1-3 条且合并次要决策点', () => {
    const text = buildThinkL1Input({ questionText: 'q', reasoningText: 'r' });
    expect(text).toContain('必须恰好输出 1-3 条');
    expect(text).toContain('先把重复/次要决策点合并');
    expect(text).not.toContain('decisions 只保留 1-3 条；confidence');
  });
});
