/**
 * 云端 LLM 调用观测器（lib/llm-trace.js）——7.1 P1：采集点取 DSH 开放的
 * `llm/stream` waterfall 事件（@deepseek-ai/dsh-llm），即最接近云端 LLM 响应源头的接口。
 *
 * 设计意图（docs/CA-V7-7.1-tool信息搜集与处理设计.md §3/§4.2）：
 *   - GenerateOptions 携带 provider/model/reasoningEffort/purpose/tools/sessionId 等
 *     工程类元数据（purpose 可区分 conversation/compaction/session-title 辅助调用）；
 *   - StreamChunk 是 token 级原始流：reasoning/text/tool-call 增量 → usage
 *     （含 cacheRead/cacheWrite/reasoningTokens）→ finish（LlmFailure 的
 *     code/status/providerRequestId）+ replayState；
 *   - tool-call block 的 id 与 DSH tool/call、tool/result 的 callId 同源，
 *     由此把"云端这次调用"与"工具这次执行"关联起来（enrichToolTrace）。
 *
 * 观测纪律（fail-open）：
 *   - 观测器是纯旁路 tee：逐 chunk 透传、永不修改、永不吞流；记录函数抛错不影响调用；
 *   - next() 抛错时原样向上抛（不 veto、不改变链行为）；
 *   - 不复制 options.messages / chunk 正文，只累计计数与提取块级元数据；
 *   - 环形上限 maxCalls：只保留最近 N 次调用，旧记录连同其 callId 映射一并淘汰。
 */

/** 新建观测存储（内存态、非投影；云端调用是 live-only 信息，会话事件日志自有持久权威） */
export function initLlmTraceStore(opts = {}) {
  const maxCalls = Math.max(1, Math.min(4096, Number(opts?.maxCalls) || 256));
  return { maxCalls, seq: 0, calls: new Map(), order: [], byToolCallId: new Map() };
}

/** 消息内容统计（不复制正文）：字符分解 + 工具结果 callId（细颗粒度先后关系的源头证据） */
function messageContentStats(msg) {
  let inputTextChars = 0;
  let inputReasoningChars = 0;
  let inputToolResultChars = 0;
  let inputToolCallChars = 0;
  const inputToolCallIds = [];
  for (const block of msg?.content ?? []) {
    if (!block) continue;
    if (block.type === 'text') {
      inputTextChars += typeof block.text === 'string' ? block.text.length : 0;
    } else if (block.type === 'reasoning') {
      inputReasoningChars += typeof block.text === 'string' ? block.text.length : 0;
    } else if (block.type === 'tool-call') {
      // assistant 的 tool-call 块同样进入下一轮输入（name/arguments 参与 wire）
      inputToolCallChars += (typeof block.name === 'string' ? block.name.length : 0)
        + (typeof block.arguments === 'string' ? block.arguments.length : 0);
    } else if (block.type === 'tool-result') {
      if (typeof block.toolCallId === 'string' && block.toolCallId) inputToolCallIds.push(block.toolCallId);
      for (const c of block.content ?? []) {
        if (c?.type === 'text' && typeof c.text === 'string') inputToolResultChars += c.text.length;
      }
    }
  }
  return { inputTextChars, inputReasoningChars, inputToolResultChars, inputToolCallChars, inputToolCallIds };
}

/** 淘汰最旧调用记录（含其 tool-call id 映射，latest-wins） */
function pruneLlmCalls(store) {
  while (store.order.length >= store.maxCalls) {
    const requestSeq = store.order.shift();
    const rec = store.calls.get(requestSeq);
    if (rec) {
      for (const tc of rec.toolCalls ?? []) {
        if (store.byToolCallId.get(tc.id) === rec) store.byToolCallId.delete(tc.id);
      }
      store.calls.delete(requestSeq);
    }
  }
}

/** 开一条调用记录（同步、不抛错；畸形 options 兜底为缺省字段） */
export function beginLlmCall(store, options) {
  if (!store || typeof store.calls?.set !== 'function') return null;
  pruneLlmCalls(store);
  const requestSeq = ++store.seq;
  const tools = Array.isArray(options?.tools) ? options.tools : [];
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  let inputChars = 0;
  let inputTextChars = 0;
  let inputReasoningChars = 0;
  let inputToolResultChars = 0;
  let inputToolCallChars = 0;
  const inputToolCallIds = [];
  for (const m of messages) {
    const stats = messageContentStats(m);
    inputChars += stats.inputTextChars + stats.inputReasoningChars + stats.inputToolResultChars + stats.inputToolCallChars;
    inputTextChars += stats.inputTextChars;
    inputReasoningChars += stats.inputReasoningChars;
    inputToolResultChars += stats.inputToolResultChars;
    inputToolCallChars += stats.inputToolCallChars;
    for (const id of stats.inputToolCallIds) inputToolCallIds.push(id);
  }
  /** @type {any} */
  const rec = {
    requestSeq,
    sessionId: typeof options?.sessionId === 'string' ? options.sessionId : null,
    provider: typeof options?.provider === 'string' ? options.provider : '',
    model: typeof options?.model === 'string' ? options.model : '',
    purpose: typeof options?.purpose === 'string' ? options.purpose : null,
    reasoningEffort: typeof options?.reasoningEffort === 'string' ? options.reasoningEffort : null,
    temperature: typeof options?.temperature === 'number' ? options.temperature : null,
    maxTokens: typeof options?.maxTokens === 'number' ? options.maxTokens : null,
    messagesCount: messages.length,
    inputChars,
    inputTextChars,
    inputReasoningChars,
    inputToolResultChars,
    inputToolCallChars,
    inputToolCallIds,
    toolSchemaNames: tools.map((t) => (typeof t?.name === 'string' ? t.name : '')).filter(Boolean),
    startMs: Date.now(),
    durationMs: null,
    chunkCount: 0,
    reasoningChars: 0,
    textChars: 0,
    toolCalls: [],
    blockOrder: [], // 块结构顺序（start/end × blockType），无正文，上限 256
    usage: null,
    finish: null,
    hasReplayState: false,
    status: 'streaming',
  };
  // store 非枚举挂载：tee/finalize 需要，快照导出不泄露
  Object.defineProperty(rec, 'store', { value: store, enumerable: false, writable: false, configurable: false });
  store.calls.set(requestSeq, rec);
  store.order.push(requestSeq);
  return rec;
}

/** 逐 chunk 记账（纯记录；未知 chunk 忽略；调用方捕获异常保证不破坏流） */
export function recordChunk(rec, chunk) {
  if (!rec || !chunk) return;
  rec.chunkCount += 1;
  switch (chunk.type) {
    case 'text-delta':
      rec.textChars += typeof chunk.text === 'string' ? chunk.text.length : 0;
      break;
    case 'reasoning-delta':
      rec.reasoningChars += typeof chunk.text === 'string' ? chunk.text.length : 0;
      break;
    case 'block-start':
      if (rec.blockOrder.length < 256) {
        rec.blockOrder.push({ t: 'start', i: chunk.index, b: typeof chunk.blockType === 'string' ? chunk.blockType : '' });
      }
      break;
    case 'block-end': {
      const block = chunk.block;
      if (rec.blockOrder.length < 256) {
        rec.blockOrder.push({ t: 'end', i: chunk.index, b: typeof block?.type === 'string' ? block.type : '' });
      }
      if (block?.type === 'tool-call' && typeof block.id === 'string') {
        rec.toolCalls.push({ id: block.id, name: typeof block.name === 'string' ? block.name : '', arguments: typeof block.arguments === 'string' ? block.arguments : '{}' });
      }
      break;
    }
    case 'usage':
      rec.usage = chunk.usage ? { ...chunk.usage } : null;
      break;
    case 'finish': {
      const reason = chunk.reason;
      rec.finish = {
        kind: reason?.kind ?? 'stop',
        failure: reason?.failure ? { ...reason.failure } : null,
      };
      rec.hasReplayState = chunk.replayState !== undefined;
      break;
    }
    default:
      break;
  }
}

/** 流结束/中断时定型记录并登记 callId → 调用映射（不抛错） */
export function finalizeLlmCall(store, rec) {
  if (!store || !rec) return rec;
  const now = Date.now();
  rec.durationMs = typeof rec.startMs === 'number' ? now - rec.startMs : null;
  if (rec.status === 'streaming') {
    if (rec.finish?.kind === 'error' || rec.finish?.kind === 'aborted') rec.status = 'failed';
    else if (rec.finish) rec.status = 'completed';
    else rec.status = 'unfinished'; // 适配器未发 finish（理论上不应出现）
  }
  for (const tc of rec.toolCalls ?? []) {
    // rec 已被环形淘汰（calls 中不再持有）时不得回写映射：否则 byToolCallId 永久指向已淘汰记录
    if (tc?.id && store.calls.get(rec.requestSeq) === rec) store.byToolCallId.set(tc.id, rec); // latest-wins
  }
  return rec;
}

/** 旁路 tee：透传 + 记账；记录异常被吞（fail-open），下游消费中断也照常 finalize */
export async function* teeLlmStream(rec, chunks) {
  const store = rec?.store;
  try {
    for await (const chunk of chunks) {
      try {
        recordChunk(rec, chunk);
      } catch {
        /* 观测失败不影响 LLM 调用 */
      }
      yield chunk;
    }
  } finally {
    try {
      if (rec && store) finalizeLlmCall(store, rec);
    } catch {
      /* 观测失败不影响 LLM 调用 */
    }
  }
}

/**
 * 安装 llm/stream 观测器。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof initLlmTraceStore>} store
 * @param {{ warn?: (msg: string) => void }} [logger]
 * @returns {() => boolean} disposer
 */
export function installLlmTrace(ctx, store, logger) {
  if (!ctx || typeof ctx.on !== 'function') return () => false;
  const log = logger ?? { warn: () => {} };
  let disposed = false;
  const dispose = ctx.on(
    'llm/stream',
    function llmTraceObserver(options, next) {
      let rec = null;
      try {
        rec = beginLlmCall(store, options);
      } catch (error) {
        log.warn('ca-v7 llm-trace 开始记账失败：' + (error instanceof Error ? error.message : String(error)));
      }
      let stream;
      try {
        stream = next();
      } catch (error) {
        // next() 失败属于调用链失败：观测器只定型已开记录，原样上抛，不改变行为
        if (rec) {
          rec.finish = { kind: 'error', failure: { code: 'LLM_STREAM_CHAIN', message: error instanceof Error ? error.message : String(error) } };
          try {
            finalizeLlmCall(store, rec);
          } catch {
            /* 观测失败不影响 LLM 调用 */
          }
        }
        throw error;
      }
      if (!rec) return stream;
      return teeLlmStream(rec, stream);
    },
    { global: true, prepend: true },
  );
  return () => {
    if (disposed) return false;
    disposed = true;
    return dispose();
  };
}

/** 快照一条调用记录（剥离 store、深拷贝可变字段，供 debug 导出/断言） */
export function snapshotLlmCall(rec) {
  if (!rec) return null;
  const failure = rec.finish?.failure;
  return {
    requestSeq: rec.requestSeq,
    sessionId: rec.sessionId ?? null,
    provider: rec.provider,
    model: rec.model,
    purpose: rec.purpose ?? null,
    reasoningEffort: rec.reasoningEffort ?? null,
    temperature: rec.temperature ?? null,
    maxTokens: rec.maxTokens ?? null,
    messagesCount: rec.messagesCount,
    inputChars: rec.inputChars,
    inputTextChars: rec.inputTextChars,
    inputReasoningChars: rec.inputReasoningChars,
    inputToolResultChars: rec.inputToolResultChars,
    inputToolCallChars: rec.inputToolCallChars ?? 0,
    inputToolCallIds: [...(rec.inputToolCallIds ?? [])],
    toolSchemaNames: [...(rec.toolSchemaNames ?? [])],
    startMs: rec.startMs,
    durationMs: rec.durationMs ?? null,
    chunkCount: rec.chunkCount,
    reasoningChars: rec.reasoningChars,
    textChars: rec.textChars,
    toolCalls: (rec.toolCalls ?? []).map((tc) => ({ ...tc })),
    blockOrder: (rec.blockOrder ?? []).map((b) => ({ ...b })),
    usage: rec.usage ? { ...rec.usage } : null,
    finishKind: rec.finish?.kind ?? null,
    failure: failure
      ? {
          code: failure.code ?? '',
          message: failure.message ?? '',
          status: failure.status ?? null,
          requestId: failure.requestId ?? null,
          providerRetryAfterMs: failure.providerRetryAfterMs ?? null,
        }
      : null,
    hasReplayState: Boolean(rec.hasReplayState),
    status: rec.status,
  };
}

/** debug 导出：最近 N 条调用（requestSeq 升序） */
export function exportLlmTrace(store) {
  if (!store) return [];
  return [...store.order].map((seq) => snapshotLlmCall(store.calls.get(seq))).filter(Boolean);
}

/**
 * 把工具痕迹行与云端调用元数据按 callId 关联（live-only 增强；会话事件重放无此层）。
 * 除调用侧 usage/reasoning 等字段外，额外给出细颗粒度先后关系：
 *   - consumedByRequestSeqs：哪些后续云端调用的输入里携带了该工具结果（因果边）；
 *   - previous/nextRequestSeq：按调用开始时间的相邻云端调用。
 * @param {any[]} rows lib/tool-trace.js 的痕迹行
 * @param {ReturnType<typeof initLlmTraceStore>} store
 */
export function enrichToolTrace(rows, store) {
  const byToolCallId = store?.byToolCallId ?? new Map();
  const ordered = [...(store?.order ?? [])].map((seq) => store?.calls?.get(seq)).filter(Boolean);
  const consumedBy = new Map();
  for (const rec of ordered) {
    for (const id of rec.inputToolCallIds ?? []) {
      if (!id) continue;
      const list = consumedBy.get(id) ?? [];
      list.push(rec.requestSeq);
      consumedBy.set(id, list);
    }
  }
  return (rows ?? []).map((row) => {
    const rec = row?.callId ? byToolCallId.get(row.callId) : undefined;
    if (!rec) return { ...row, llm: null };
    const idx = ordered.findIndex((r) => r.requestSeq === rec.requestSeq);
    return {
      ...row,
      entities: [...(row.entities ?? [])],
      llm: {
        requestSeq: rec.requestSeq,
        previousRequestSeq: idx > 0 ? ordered[idx - 1].requestSeq : null,
        nextRequestSeq: idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1].requestSeq : null,
        consumedByRequestSeqs: consumedBy.get(row.callId) ?? [],
        provider: rec.provider,
        model: rec.model,
        purpose: rec.purpose ?? null,
        reasoningEffort: rec.reasoningEffort ?? null,
        reasoningChars: rec.reasoningChars,
        textChars: rec.textChars,
        messagesCount: rec.messagesCount,
        inputChars: rec.inputChars,
        inputTextChars: rec.inputTextChars,
        inputReasoningChars: rec.inputReasoningChars,
        inputToolResultChars: rec.inputToolResultChars,
        inputToolCallChars: rec.inputToolCallChars ?? 0,
        inputToolCallIds: [...(rec.inputToolCallIds ?? [])],
        toolCallIds: (rec.toolCalls ?? []).map((tc) => tc.id),
        toolSchemaNames: [...(rec.toolSchemaNames ?? [])],
        blockOrder: (rec.blockOrder ?? []).map((b) => ({ ...b })),
        usage: rec.usage ? { ...rec.usage } : null,
        finishKind: rec.finish?.kind ?? null,
        failureCode: rec.finish?.failure?.code ?? null,
        failureRequestId: rec.finish?.failure?.requestId ?? null,
        startMs: rec.startMs,
        durationMs: rec.durationMs ?? null,
        status: rec.status,
      },
    };
  });
}

/**
 * 统一时间线（细颗粒度先后关系的调试视图）：把云端调用边界与工具事件按时间戳合并。
 * llm-tool-call 条目锚在响应结束时刻（模型作出工具决定、工具请求即将发生的先后点）。
 * @param {any[]} rows lib/tool-trace.js 的痕迹行（含 callTime/resultTime）
 * @param {ReturnType<typeof initLlmTraceStore>} store
 */
export function exportLlmToolTimeline(rows, store) {
  const entries = [];
  for (const seq of store?.order ?? []) {
    const rec = store?.calls?.get(seq);
    if (!rec) continue;
    const endMs = typeof rec.startMs === 'number' && typeof rec.durationMs === 'number' ? rec.startMs + rec.durationMs : rec.startMs;
    entries.push({
      timeMs: rec.startMs,
      kind: 'llm-start',
      requestSeq: rec.requestSeq,
      provider: rec.provider,
      model: rec.model,
      purpose: rec.purpose ?? null,
      finishKind: rec.finish?.kind ?? null,
      status: rec.status,
    });
    for (const tc of rec.toolCalls ?? []) {
      entries.push({ timeMs: endMs, kind: 'llm-tool-call', requestSeq: rec.requestSeq, callId: tc.id, name: tc.name });
    }
    entries.push({
      timeMs: endMs,
      kind: 'llm-end',
      requestSeq: rec.requestSeq,
      durationMs: rec.durationMs ?? null,
      finishKind: rec.finish?.kind ?? null,
      status: rec.status,
    });
  }
  for (const row of rows ?? []) {
    if (typeof row.callTime === 'number') {
      entries.push({ timeMs: row.callTime, kind: 'tool-call', callId: row.callId, name: row.name, turn: row.turn ?? null, step: row.step ?? null });
    }
    if (typeof row.resultTime === 'number') {
      entries.push({ timeMs: row.resultTime, kind: 'tool-result', callId: row.callId, name: row.name, turn: row.turn ?? null, step: row.step ?? null, durationMs: row.durationMs ?? null, isError: Boolean(row.isError), exitCode: row.exitCode ?? null });
    }
  }
  return entries.sort((a, b) => a.timeMs - b.timeMs);
}
