/**
 * lib/llm-trace.js 单测（7.1 P1）
 *
 * 覆盖：llm/stream waterfall 旁路 tee（透传/不吞流/fail-open）；GenerateOptions 工程元数据
 * （provider/model/purpose/reasoningEffort/tools/messages 计数）；StreamChunk 记账
 * （reasoning/text 字符、tool-call block、usage、finish/failure/replayState）；环形淘汰；
 * callId → 调用映射与 enrichToolTrace 关联；next() 抛错原样上抛。
 */
import { describe, it, expect } from 'vitest';
import {
  initLlmTraceStore,
  beginLlmCall,
  recordChunk,
  finalizeLlmCall,
  teeLlmStream,
  installLlmTrace,
  snapshotLlmCall,
  exportLlmTrace,
  enrichToolTrace,
  exportLlmToolTimeline,
} from '../lib/llm-trace.js';

/** 收集异步迭代器并断言顺序透传 */
async function collect(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('7.1 P1 llm-trace 观测器', () => {
  it('begin/record/finalize：工程元数据 + usage/finish/replayState + callId 映射', () => {
    const store = initLlmTraceStore({ maxCalls: 8 });
    const rec = beginLlmCall(store, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      purpose: 'compaction',
      reasoningEffort: 'high',
      temperature: 0.3,
      maxTokens: 4000,
      sessionId: 's1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'think think' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-in', content: [{ type: 'text', text: 'r1' }] }] },
      ],
      tools: [{ name: 'bash', description: 'run', parameters: {} }, { name: 'read', description: 'read file', parameters: {} }],
    });
    expect(rec).not.toBeNull();
    expect(rec!.provider).toBe('deepseek-official');
    expect(rec!.purpose).toBe('compaction');
    expect(rec!.reasoningEffort).toBe('high');
    expect(rec!.messagesCount).toBe(3);
    expect(rec!.inputChars).toBe(5 + 11 + 2);
    expect(rec!.inputTextChars).toBe(5);
    expect(rec!.inputReasoningChars).toBe(11);
    expect(rec!.inputToolResultChars).toBe(2);
    expect(rec!.inputToolCallIds).toEqual(['call-in']); // 细颗粒度先后关系：这次调用的输入携带了哪个工具结果
    expect(rec!.toolSchemaNames).toEqual(['bash', 'read']);
    expect(rec!.status).toBe('streaming');
    recordChunk(rec!, { type: 'block-start', index: 0, blockType: 'reasoning' });
    recordChunk(rec!, { type: 'reasoning-delta', index: 0, text: '考虑' });
    recordChunk(rec!, { type: 'block-end', index: 0, block: { type: 'reasoning', text: '考虑' } });
    recordChunk(rec!, { type: 'block-start', index: 1, blockType: 'tool-call' });
    recordChunk(rec!, { type: 'text-delta', index: 1, text: 'ab' });
    recordChunk(rec!, {
      type: 'block-end',
      index: 2,
      block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    });
    recordChunk(rec!, {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 1, reasoningTokens: 5 },
    });
    recordChunk(rec!, {
      type: 'finish',
      reason: { kind: 'tool-calls', failure: { code: 'E1', message: 'm', status: 429, requestId: 'req-1' } },
      replayState: { cursor: 1 },
    });
    finalizeLlmCall(store, rec!);
    expect(rec!.reasoningChars).toBe(2);
    expect(rec!.textChars).toBe(2);
    expect(rec!.toolCalls).toHaveLength(1);
    expect(rec!.blockOrder).toEqual([
      { t: 'start', i: 0, b: 'reasoning' },
      { t: 'end', i: 0, b: 'reasoning' },
      { t: 'start', i: 1, b: 'tool-call' },
      { t: 'end', i: 2, b: 'tool-call' },
    ]); // 块结构顺序：reasoning 先于 tool-call（无正文，零冗余）
    expect(rec!.usage?.cacheReadTokens).toBe(100);
    expect(rec!.finish?.kind).toBe('tool-calls');
    expect(rec!.hasReplayState).toBe(true);
    expect(rec!.status).toBe('completed');
    expect(store.byToolCallId.get('call-1')).toBe(rec);
    expect(store.calls.get(1)).toBe(rec);
    const snap = snapshotLlmCall(rec!);
    expect(snap).not.toBeNull();
    expect(snap).not.toHaveProperty('store');
    expect((snap as Record<string, unknown>).failure).toMatchObject({ code: 'E1', status: 429, requestId: 'req-1' });
  });

  it('inputChars 统计 assistant tool-call 块（name/arguments 也进下一轮输入）', () => {
    const store = initLlmTraceStore();
    const args = '{"command":"pwd"}';
    const rec = beginLlmCall(store, {
      provider: 'p',
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: args }] },
      ],
    });
    expect(rec!.inputToolCallChars).toBe(4 + args.length);
    expect(rec!.inputChars).toBe(4 + args.length);
    expect(snapshotLlmCall(rec!)).toMatchObject({ inputToolCallChars: 4 + args.length });
  });

  it('tee：完整消费透传并 finalize；下游中断也 finalize', async () => {
    const store = initLlmTraceStore();
    const rec = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] });
    const chunks = (async function* () {
      yield { type: 'text-delta', index: 0, text: 'x' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
    const out = await collect(teeLlmStream(rec!, chunks));
    expect(out).toEqual([
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    expect(rec!.status).toBe('completed');
    expect(rec!.durationMs).not.toBeNull();

    const rec2 = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] });
    const infinite = (async function* () {
      yield { type: 'text-delta', index: 0, text: 'a' };
      yield { type: 'text-delta', index: 0, text: 'b' };
      yield { type: 'text-delta', index: 0, text: 'c' };
    })();
    let got = 0;
    for await (const _chunk of teeLlmStream(rec2!, infinite)) {
      got += 1;
      if (got === 2) break; // 下游中断
    }
    expect(rec2!.status).toBe('unfinished'); // 下游中断、未收到 finish → 如实记录
  });

  it('fail-open：观测记账抛错不影响透传；next() 抛错原样上抛', async () => {
    const store = initLlmTraceStore();
    const frozen = Object.freeze({
      requestSeq: 1,
      provider: 'p',
      model: 'm',
      status: 'streaming',
      startMs: Date.now(),
      finish: null,
      toolCalls: [],
      chunkCount: 0,
    });
    const chunks = (async function* () {
      yield { type: 'text-delta', index: 0, text: 'x' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
    // recordChunk 在冻结对象上会抛（严格模式），tee 捕获并继续透传
    const out = await collect(teeLlmStream(frozen as never, chunks));
    expect(out).toHaveLength(2);

    const listeners: Record<string, (...args: unknown[]) => unknown> = {};
    const ctx = { on: (name: string, fn: (...args: unknown[]) => unknown) => { listeners[name] = fn; return () => true; } };
    installLlmTrace(ctx as never, store);
    const observer = listeners['llm/stream'] as (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/require-await
      const iter = observer({ provider: 'p', model: 'm', messages: [] }, () => {
        throw new Error('chain boom');
      });
      await collect(iter);
    }).rejects.toThrow('chain boom');
  });

  it('install：llm/stream 旁路记录完整调用（begin→tee→finalize）', async () => {
    const store = initLlmTraceStore();
    const listeners: Record<string, (...args: unknown[]) => unknown> = {};
    const ctx = { on: (name: string, fn: (...args: unknown[]) => unknown) => { listeners[name] = fn; return () => true; } };
    const dispose = installLlmTrace(ctx as never, store);
    const observer = listeners['llm/stream'] as (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;
    const inner = (async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'th' };
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-x', name: 'read', arguments: '{}' } };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 9 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    })();
    const out = await collect(observer({ provider: 'deepseek-official', model: 'deepseek-v4-pro', messages: [], tools: [{ name: 'read', description: '', parameters: {} }] }, () => inner));
    expect(out).toHaveLength(4);
    expect(store.calls.size).toBe(1);
    expect(store.byToolCallId.get('call-x')).toBeTruthy();
    expect(store.byToolCallId.get('call-x')?.usage?.cacheReadTokens).toBe(9);
    expect(exportLlmTrace(store)).toHaveLength(1);
    expect(dispose()).toBe(true);
    expect(dispose()).toBe(false);
  });

  it('环形淘汰：超出 maxCalls 后旧记录与其 callId 映射一并清除', () => {
    const store = initLlmTraceStore({ maxCalls: 2 });
    const r1 = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] });
    recordChunk(r1!, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'a', arguments: '{}' } });
    finalizeLlmCall(store, r1!);
    const r2 = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] });
    recordChunk(r2!, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c2', name: 'b', arguments: '{}' } });
    finalizeLlmCall(store, r2!);
    expect(store.byToolCallId.get('c1')).toBe(r1);
    const r3 = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] }); // 触发淘汰 r1
    expect(store.calls.size).toBe(2);
    expect(store.calls.has(r1!.requestSeq)).toBe(false);
    expect(store.byToolCallId.has('c1')).toBe(false);
    expect(store.calls.has(r2!.requestSeq)).toBe(true);
    expect(store.byToolCallId.get('c2')).toBe(r2);
    expect(r3).not.toBeNull();
  });

  it('环形淘汰后迟到 tool-call 不重新挂入 byToolCallId（late finalize 回归）', () => {
    const store = initLlmTraceStore({ maxCalls: 2 });
    const r1 = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] });
    const r2 = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] });
    const r3 = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] }); // r1 被淘汰
    expect(store.calls.has(r1!.requestSeq)).toBe(false);
    recordChunk(r1!, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'late-call', name: 'a', arguments: '{}' } });
    finalizeLlmCall(store, r1!);
    expect(store.byToolCallId.has('late-call')).toBe(false);
    expect(store.calls.has(r2!.requestSeq)).toBe(true);
    expect(r3).not.toBeNull();
  });

  it('enrichToolTrace：按 callId 挂接调用侧元数据；无关联行 llm=null', () => {
    const store = initLlmTraceStore();
    const rec = beginLlmCall(store, { provider: 'deepseek-official', model: 'deepseek-v4-pro', purpose: 'compaction', messages: [] });
    recordChunk(rec!, { type: 'reasoning-delta', index: 0, text: 'abc' });
    recordChunk(rec!, { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c9', name: 'bash', arguments: '{}' } });
    recordChunk(rec!, { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } });
    recordChunk(rec!, { type: 'finish', reason: { kind: 'tool-calls' } });
    finalizeLlmCall(store, rec!);
    const rows = [
      { callId: 'c9', entities: ['tool:bash'], rowId: 1 },
      { callId: 'nope', entities: [], rowId: 2 },
    ] as never;
    const out = enrichToolTrace(rows, store);
    expect(out[0].llm).toMatchObject({ provider: 'deepseek-official', purpose: 'compaction', reasoningChars: 3 });
    expect(out[0].llm.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
    expect(out[1].llm).toBeNull();
  });

  it('细颗粒度关联：consumedBy/相邻调用 + 统一时间线先后顺序', () => {
    const store = initLlmTraceStore();
    // 调用 1：输出工具请求 c1
    const r1 = beginLlmCall(store, { provider: 'p', model: 'm', messages: [] });
    r1!.startMs = 100;
    recordChunk(r1!, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' } });
    recordChunk(r1!, { type: 'finish', reason: { kind: 'tool-calls' } });
    finalizeLlmCall(store, r1!);
    r1!.durationMs = 50;
    // 调用 2：输入里携带了 c1 的工具结果（源头证据：工具结果喂给了下一次云端调用）
    const r2 = beginLlmCall(store, {
      provider: 'p', model: 'm',
      messages: [{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] }],
    });
    r2!.startMs = 300;
    recordChunk(r2!, { type: 'finish', reason: { kind: 'stop' } });
    finalizeLlmCall(store, r2!);
    r2!.durationMs = 50;

    const rows = [{
      callId: 'c1', name: 'bash', turn: 1, step: 1, callTime: 150, resultTime: 200, durationMs: 50,
      isError: false, exitCode: 0, entities: ['tool:bash'],
    }] as never;
    const enriched = enrichToolTrace(rows, store);
    expect(enriched[0].llm).toMatchObject({
      requestSeq: 1,
      previousRequestSeq: null,
      nextRequestSeq: 2,
      consumedByRequestSeqs: [2], // c1 的结果被调用 2 消费
      inputToolCallIds: [], // 调用 1 的输入为空；c1 是它的输出
      toolCallIds: ['c1'],
    });
    // 调用 2 的源头证据：输入携带 c1 工具结果
    expect((exportLlmTrace(store)[1] as Record<string, unknown>).inputToolCallIds).toEqual(['c1']);

    const tl = exportLlmToolTimeline(rows, store);
    const entry = (kind: string, requestSeq: number) => tl.find((e) => e.kind === kind && e.requestSeq === requestSeq) as
      | { timeMs: number; kind: string; requestSeq: number }
      | undefined;
    const toolCallEntry = tl.find((e) => e.kind === 'tool-call') as { timeMs: number } | undefined;
    const toolResultEntry = tl.find((e) => e.kind === 'tool-result') as { timeMs: number } | undefined;
    expect(entry('llm-start', 1)?.timeMs).toBe(100);
    expect(toolCallEntry?.timeMs).toBe(150);
    expect(toolResultEntry?.timeMs).toBe(200);
    expect(entry('llm-start', 2)!.timeMs).toBeGreaterThan(toolResultEntry!.timeMs); // 先后顺序
    const kindIdx = (k: string) => tl.findIndex((e) => e.kind === k);
    expect(kindIdx('tool-call')).toBeLessThan(kindIdx('tool-result'));
  });
});
