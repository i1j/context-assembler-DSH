/**
 * lib/wire-deepseek.js 单测——wire 序列化镜像的 fixture 快照 + 真实 adapter 保真比对 + 计价。
 * 保真比对：真实 DeepSeekAdapter.request + mock fetch 抓取真实 wire body.messages，
 *   与镜像 serializeMessages 逐字比对（toStrictEqual）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek';
import {
  estimateWireTokens,
  serializeMessages,
  toolResultWire,
} from '../lib/wire-deepseek.js';

type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content: Block[] };

const text = (t: string): Block => ({ type: 'text', text: t });

describe('wire-deepseek 序列化镜像（fixture 快照）', () => {
  it('user 文本消息', () => {
    expect(serializeMessages([{ role: 'user', content: [text('hi')] }])).toStrictEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('system 消息', () => {
    expect(serializeMessages([{ role: 'system', content: [text('sys')] }])).toStrictEqual([
      { role: 'system', content: 'sys' },
    ]);
  });

  it('assistant：tool-call + reasoning → reasoning_content 回传', () => {
    const msg: Message = { role: 'assistant', content: [
      { type: 'reasoning', text: 'think1' },
      text('do'),
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    ] };
    expect(serializeMessages([msg])).toStrictEqual([{
      role: 'assistant',
      content: 'do',
      reasoning_content: 'think1',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    }]);
  });

  it('assistant：reasoning 无 tool-call → 不回传 reasoning_content', () => {
    const msg: Message = { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, text('t')] };
    expect(serializeMessages([msg])).toStrictEqual([{ role: 'assistant', content: 't' }]);
  });

  it('tool-result：展开为独立 role:tool 消息；空输出 → (no output)', () => {
    const msg: Message = { role: 'user', content: [
      { type: 'tool-result', toolCallId: 'c2', content: [text('')] },
    ] };
    expect(serializeMessages([msg])).toStrictEqual([
      { role: 'tool', tool_call_id: 'c2', content: '(no output)' },
    ]);
  });

  it('混合 user 消息：先文本、后 tool 消息', () => {
    const msg: Message = { role: 'user', content: [
      text('question'),
      { type: 'tool-result', toolCallId: 'c3', content: [text('ans')] },
    ] };
    expect(serializeMessages([msg])).toStrictEqual([
      { role: 'user', content: 'question' },
      { role: 'tool', tool_call_id: 'c3', content: 'ans' },
    ]);
  });

  it('image 块 → 抛错（text-only wire）', () => {
    const msg: Message = { role: 'user', content: [{ type: 'image', url: 'x' }] };
    expect(() => serializeMessages([msg])).toThrow(/image content/);
  });

  it('tool-result 嵌套 image → 抛错（递归检测，与真实 adapter contentHasImage 对齐）', () => {
    const msg: Message = {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'image', url: 'x' }] }],
    };
    expect(() => serializeMessages([msg])).toThrow(/image content/);
  });
});

describe('wire-deepseek 真实 adapter 保真比对', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('镜像 serializeMessages 输出与真实 DeepSeekAdapter 请求体逐字一致', async () => {
    const input: Message[] = [
      { role: 'system', content: [text('you are t')] },
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'think' },
        text('ok'),
        { type: 'tool-call', id: 'call1', name: 'bash', arguments: '{"command":"pwd"}' },
      ] },
      { role: 'user', content: [
        text('q2'),
        { type: 'tool-result', toolCallId: 'call1', content: [text('/home')] },
        { type: 'tool-result', toolCallId: 'call1b', content: [text('')] },
      ] },
    ];
    let captured: { body: { messages: unknown } } | null = null;
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      captured = { body: JSON.parse(String(init.body)) };
      const stream = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); },
      });
      return new Response(stream, { status: 200 });
    }) as never;

    const adapter = new DeepSeekAdapter({});
    const it = adapter.request(
      { model: 'deepseek-v4-flash', messages: input, sessionId: 's1' },
      new AbortController().signal,
      { baseURL: 'https://api.deepseek.com', defaults: { thinking: 'enabled', reasoningEffort: 'max' } },
      'test-key', 'test-user', () => {},
    );
    await it.next(); // 首次推进即完成 fetch 与请求体构造
    await it.return();

    expect(captured).not.toBeNull();
    expect(captured!.body.messages).toStrictEqual(serializeMessages(input));
  });
});

describe('wire-deepseek 计价（DSH 固定密度口径）', () => {
  it('tool 消息：content ceil(len/4) + 块开销 4 + role 4', () => {
    expect(estimateWireTokens(toolResultWire('c', 'abc'))).toBe(1 + 4 + 4);
    expect(estimateWireTokens(toolResultWire('c', ''))).toBe(3 + 4 + 4); // '(no output)' = 11 字符
    expect(estimateWireTokens(toolResultWire('c', 'hello world'))).toBe(3 + 4 + 4);
  });

  it('空数组与多消息累加', () => {
    expect(estimateWireTokens([])).toBe(0);
    expect(estimateWireTokens([toolResultWire('a', 'x'), toolResultWire('b', 'y')][0] ? toolResultWire('a', 'x').concat(toolResultWire('b', 'y')) : [])).toBe(2 * (1 + 8));
  });
});
