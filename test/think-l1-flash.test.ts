/**
 * lib/think-l1.js thinkL1OnceFlash 单测（7.2 K1 flash 全量重跑）
 *
 * 覆盖需求规格 T1-T5：成功路径请求结构与 usage；http/fetch/timeout/parse kind 映射；
 * 本地 thinkL1Once 回归不破坏（既有测试文件覆盖）。
 */
import { describe, it, expect } from 'vitest';
import { thinkL1OnceFlash, buildThinkL1Input, THINK_L1_FLASH_URL, THINK_L1_FLASH_MODEL } from '../lib/think-l1.js';

function okBody(content: string, usage?: { prompt_tokens?: number; completion_tokens?: number }) {
  return JSON.stringify({ choices: [{ message: { content } }], usage: usage ?? null });
}

describe('7.2 K1 thinkL1OnceFlash（T1-T5）', () => {
  it('T1 成功：请求结构 + content + usage 映射', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fetchFn = (url: string, init: RequestInit) => {
      captured = { url, init };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => okBody('{"goal":"g","decisions":["d"],"corrections":[],"conclusion":"c","applies_when":"w","confidence":0.8}'),
        json: async () => JSON.parse(okBody('{"goal":"g","decisions":["d"],"corrections":[],"conclusion":"c","applies_when":"w","confidence":0.8}', { prompt_tokens: 101, completion_tokens: 42 })),
      } as unknown as Response);
    };
    const r = await thinkL1OnceFlash(
      { questionText: 'q', reasoningText: 'r', toolRows: [] },
      { url: 'https://api.deepseek.com', apiKey: 'k', fetchFn },
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.text).toContain('"goal"');
      expect(r.usage).toEqual({ inputTokens: 101, outputTokens: 42 });
    }
    expect(captured.url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe(THINK_L1_FLASH_MODEL);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toBe(buildThinkL1Input({ questionText: 'q', reasoningText: 'r', toolRows: [] }));
    expect((captured.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
  });

  it('T1b usage 缺失 → 0/0 且不抛错', async () => {
    const fetchFn = () => Promise.resolve({
      ok: true, status: 200,
      text: async () => okBody('{"goal":"g","decisions":["d"],"corrections":[],"conclusion":"c","applies_when":"w","confidence":0.8}'),
      json: async () => JSON.parse(okBody('{"goal":"g","decisions":["d"],"corrections":[],"conclusion":"c","applies_when":"w","confidence":0.8}')),
    } as unknown as Response);
    const r = await thinkL1OnceFlash({ questionText: 'q', reasoningText: 'r', toolRows: [] }, { apiKey: 'k', fetchFn });
    expect(r).toMatchObject({ status: 'ok', usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('T2 http 错误 → kind=http 且含状态码', async () => {
    const fetchFn = () => Promise.resolve({
      ok: false, status: 429,
      text: async () => 'rate limited',
    } as unknown as Response);
    const r = await thinkL1OnceFlash({ questionText: 'q', reasoningText: 'r', toolRows: [] }, { apiKey: 'k', fetchFn });
    expect(r).toMatchObject({ status: 'error' });
    if (r.status === 'error') expect(r.error.kind).toBe('http');
    if (r.status === 'error') expect(r.error.message).toContain('429');
  });

  it('T3 超时 → kind=timeout', async () => {
    const fetchFn = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('timeout', 'TimeoutError')));
    });
    const r = await thinkL1OnceFlash({ questionText: 'q', reasoningText: 'r', toolRows: [] }, { apiKey: 'k', fetchFn, timeoutMs: 5 });
    expect(r).toMatchObject({ status: 'error', error: { kind: 'timeout' } });
  });

  it('T4 坏 JSON / 空 content → kind=parse', async () => {
    const bad = () => Promise.resolve({
      ok: true, status: 200, text: async () => 'not json',
      json: async () => { throw new Error('bad json'); },
    } as unknown as Response);
    const r1 = await thinkL1OnceFlash({ questionText: 'q', reasoningText: 'r', toolRows: [] }, { apiKey: 'k', fetchFn: bad });
    expect(r1).toMatchObject({ status: 'error', error: { kind: 'parse' } });

    const empty = () => Promise.resolve({
      ok: true, status: 200, text: async () => '{"choices":[]}',
      json: async () => ({ choices: [] }),
    } as unknown as Response);
    const r2 = await thinkL1OnceFlash({ questionText: 'q', reasoningText: 'r', toolRows: [] }, { apiKey: 'k', fetchFn: empty });
    expect(r2).toMatchObject({ status: 'error', error: { kind: 'parse' } });
  });

  it('T1c fetch 抛错（非 abort）→ kind=fetch', async () => {
    const fetchFn = () => Promise.reject(new Error('network down'));
    const r = await thinkL1OnceFlash({ questionText: 'q', reasoningText: 'r', toolRows: [] }, { apiKey: 'k', fetchFn });
    expect(r).toMatchObject({ status: 'error', error: { kind: 'fetch' } });
  });
});
