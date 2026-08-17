/**
 * lib/tool-backfill.js 单测（7.1 P2：后台本地 4B intent/outcome 异步回填）
 *
 * 覆盖：提示词与 JSON 解析（容错 json 块）；队列 fail-open（成功回填 overlay 生效、
 * 失败保持确定性摘要）；每 callId 每会话只尝试一次。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { newSession } from './helpers.js';
import {
  buildToolBackfillPrompt,
  parseToolBackfill,
  createToolBackfillQueue,
} from '../lib/tool-backfill.js';

const completedRow = (callId: string, resultSummary = 'deterministic-summary') => ({
  callId,
  status: 'completed',
  name: 'read',
  description: 'read a file',
  argsSummary: 'read: /tmp/a.md',
  resultSummary,
  hdl: 'read: /tmp/a.md',
  error: null,
  exitCode: null,
  resultChars: 800,
  entities: ['path:/tmp/a.md', 'tool:read'],
  highValueFacts: ['uri:viking://resources/ca/think/a.md', 'path:/tmp/a.md'],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('7.1 P2 tool-backfill', () => {
  it('提示词包含工具元数据；解析器截取 JSON 块并容错', () => {
    const prompt = buildToolBackfillPrompt(completedRow('c1'));
    expect(prompt).toContain('工具=read');
    expect(prompt).toContain('结果摘要=deterministic-summary');
    expect(parseToolBackfill('说明文字 {"intent_l1":"查看文件","outcome_l1":"读到 3 行，路径 /tmp/a.md"} 尾部')).toEqual({
      status: 'ok',
      intent_l1: '查看文件',
      outcome_l1: '读到 3 行，路径 /tmp/a.md',
    });
    expect(parseToolBackfill('{"intent_l1":"a","outcome_l1":"b"} } 尾部说明')).toEqual({
      status: 'ok',
      intent_l1: 'a',
      outcome_l1: 'b',
    });
    expect(parseToolBackfill('not json').status).toBe('error');
    expect(parseToolBackfill('{"x":1}').status).toBe('error');
  });

  it('P1 §3.3：提示词含高价值事实清单约束（4 条要求 + 输入高价值事实）', () => {
    const prompt = buildToolBackfillPrompt(completedRow('c-hv'));
    expect(prompt).toContain('必须保留以下高价值事实');
    expect(prompt).toContain('URI、绝对路径、精确错误串、退出码、数值结论');
    expect(prompt).toContain('检索/列表类结果输出 top N 条关键命中的 URI/标题');
    expect(prompt).toContain('丢弃过程日志、重复回显');
    expect(prompt).toContain('高价值事实=uri:viking://resources/ca/think/a.md, path:/tmp/a.md');

    const noHv = buildToolBackfillPrompt({ ...completedRow('c-nohv'), highValueFacts: [] });
    expect(noHv).toContain('高价值事实=（无）');
  });

  it('成功回填：overlay 用 outcome_l1 覆盖 L1；失败 fail-open 保持确定性摘要', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ response: '{"intent_l1":"查文件","outcome_l1":"读到 3 行 /tmp/a.md"}' }),
    }));
    const q = createToolBackfillQueue({ maxConcurrent: 1, maxQueue: 8 });
    const session = newSession('bf-ok');
    const rows = [completedRow('c-ok')];
    q.enqueue(session, rows);
    expect(q.overlay(rows, session)[0].outcome_l1).toBeUndefined(); // 未就绪：确定性摘要兜底
    await vi.waitFor(() => {
      expect(q.stats(session).done).toBe(1);
    });
    const overlayed = q.overlay(rows, session);
    expect(overlayed[0].outcome_l1).toBe('读到 3 行 /tmp/a.md');
    expect(overlayed[0].resultSummary).toBe('deterministic-summary'); // 原文摘要仍在
  });

  it('4B 失败：status=failed 且 overlay 不回填伪造摘要；同 callId 不重复尝试', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', async (input: unknown, init: unknown) => {
      calls.push({ input, init });
      throw new Error('4b down');
    });
    const q = createToolBackfillQueue({ maxConcurrent: 1, maxQueue: 8 });
    const session = newSession('bf-fail');
    const rows = [completedRow('c-fail')];
    q.enqueue(session, rows);
    await vi.waitFor(() => {
      expect(q.stats(session).failed).toBe(1);
    });
    expect(q.overlay(rows, session)[0].outcome_l1).toBeUndefined();
    q.enqueue(session, rows); // 再次 enqueue：不重复入队
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
  });
});
