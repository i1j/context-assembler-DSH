/**
 * 7.1 P2：post-tool-call 后台本地 4B 异步回填（lib/tool-backfill.js）。
 *
 * 设计意图（docs/CA-V7-7.1-tool信息搜集与处理设计.md §4.2/§6 P2）：
 *   tool_trace 的确定性摘要（argsSummary/resultSummary/hdl）先服务 P4 热路径；
 *   工具完成后由本地 4B（qwen3-4b-instruct，ollama-priority-proxy）后台生成
 *   intent_l1（一句话意图）与 outcome_l1（一句话结果/可复用结论），
 *   回填进会话内存态（Map），P4 选档优先使用 outcome_l1。
 *
 * fail-open 纪律：
 *   - 永不阻塞主流程：onChanged 触发入队，drain 后台 fire-and-forget；
 *   - 4B 不可用/超时/解析失败 → 记录 failed，不回退为伪造摘要；
 *   - 每 callId 每会话只尝试一次；队列有上限，超出丢弃（宁缺勿错）；
 *   - 确定性摘要永远在：overlay 只在 status=done 时替换。
 */
import { randomUUID } from 'node:crypto';

/**
 * 4B 回填提示词（改进方案 §3.3：高价值事实清单约束）。
 * 契约不变：严格 JSON {intent_l1, outcome_l1}（解析器兼容）；新增 4 条要求，
 * 并把 tool_trace 的 highValueFacts（URI/绝对路径/错误串/退出码）传入，
 * 要求 outcome_l1 优先保留——摘要从"结论式"转向"事实覆盖式"（真实报告 §3.2）。
 */
export function buildToolBackfillPrompt(row) {
  const highValue = Array.isArray(row?.highValueFacts) && row.highValueFacts.length > 0
    ? row.highValueFacts.join(', ')
    : '（无）';
  return [
    '你负责为一次已完成的工具调用生成一句话工程摘要，供上下文压缩使用。严格输出 JSON：',
    '{"intent_l1":"本次工具调用想达成什么（≤40字）","outcome_l1":"本次工具调用的关键结果与可复用结论（≤100字）"}',
    '',
    '要求：',
    '1. 只写云端模型后续最可能需要知道的信息；',
    '2. 必须保留以下高价值事实（若存在）：URI、绝对路径、精确错误串、退出码、数值结论；',
    '3. 检索/列表类结果输出 top N 条关键命中的 URI/标题；',
    '4. 丢弃过程日志、重复回显、与任务无关的中间输出。',
    '',
    '输入：',
    '工具=' + (row?.name ?? 'unknown_tool'),
    '意图描述=' + (row?.description ?? ''),
    '参数摘要=' + (row?.argsSummary ?? ''),
    '结果摘要=' + (row?.resultSummary ?? ''),
    '高价值事实=' + highValue,
    '错误=' + (row?.error ?? ''),
    '退出码=' + String(row?.exitCode ?? ''),
  ].join('\n');
}

/** 解析 4B 响应（json 块外可能带说明文字；从首个 '{' 起尝试每个 '}' 闭包，取第一个合法对象） */
export function parseToolBackfill(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return { status: 'error' };
  let obj;
  for (let end = start + 1; end < s.length; end += 1) {
    if (s[end] !== '}') continue;
    try {
      obj = JSON.parse(s.slice(start, end + 1));
      break;
    } catch {
      // 尝试下一个 '}'（嵌套对象/字符串含 } 的情况）
    }
  }
  if (!obj || typeof obj !== 'object') return { status: 'error' };
  const intent = typeof obj?.intent_l1 === 'string' ? obj.intent_l1.trim() : '';
  const outcome = typeof obj?.outcome_l1 === 'string' ? obj.outcome_l1.trim() : '';
  if (!intent && !outcome) return { status: 'error' };
  return { status: 'ok', intent_l1: intent, outcome_l1: outcome };
}

/** 一次 4B 调用（Ollama /api/generate，format=json；失败返回 {status:'error'}） */
export async function backfillTool4B(row, { url = 'http://127.0.0.1:11435', model = 'qwen3-4b-instruct:32k', timeoutMs = 30000 } = {}) {
  const body = {
    model,
    prompt: buildToolBackfillPrompt(row),
    stream: false,
    options: { num_predict: 256, temperature: 0.1, format: 'json' },
    keep_alive: -1,
    think: false,
  };
  let resp;
  try {
    resp = await fetch((url || 'http://127.0.0.1:11435').replace(/\/$/, '') + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Queue-Priority': 'low' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'error' };
  }
  if (!resp.ok) return { status: 'error' };
  let data;
  try {
    data = await resp.json();
  } catch {
    return { status: 'error' };
  }
  return parseToolBackfill(data?.response ?? '');
}

/**
 * 创建回填队列（每会话独立状态，WeakMap 随会话释放）。
 * @param {object} opts {url, model, timeoutMs, maxConcurrent, maxQueue, warn?}
 */
export function createToolBackfillQueue(opts = {}) {
  const url = opts.url ?? 'http://127.0.0.1:11435';
  const model = opts.model ?? 'qwen3-4b-instruct:32k';
  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxConcurrent = Math.max(1, Number(opts.maxConcurrent) || 2);
  const maxQueue = Math.max(1, Number(opts.maxQueue) || 16);
  const bySession = new WeakMap(); // session -> Map<callId, {status,intent_l1,outcome_l1}>
  const pending = new WeakMap(); // session -> Set<callId>
  const queue = [];
  let active = 0;
  const log = opts.warn ? (msg) => opts.warn(msg) : () => {};

  const stateFor = (session) => {
    let map = bySession.get(session);
    if (!map) {
      map = new Map();
      bySession.set(session, map);
      pending.set(session, new Set());
    }
    return map;
  };

  const drain = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job) continue;
      active += 1;
      backfillTool4B(job.row, { url, model, timeoutMs })
        .then((res) => {
          const map = stateFor(job.session);
          map.set(job.row.callId, res.status === 'ok'
            ? { status: 'done', intent_l1: res.intent_l1, outcome_l1: res.outcome_l1 }
            : { status: 'failed', intent_l1: '', outcome_l1: '' });
        })
        .catch(() => {
          stateFor(job.session).set(job.row.callId, { status: 'failed', intent_l1: '', outcome_l1: '' });
        })
        .finally(() => {
          const set = pending.get(job.session);
          set?.delete(job.row.callId);
          active -= 1;
          drain();
        });
    }
  };

  /**
   * 入队会话中新完成的工具行（每 callId 一次；队列满丢弃）。
   * @param {import('@deepseek-ai/dsh-session').Session} session
   * @param {any[]} rows tool_trace 视图行
   */
  const enqueue = (session, rows) => {
    if (!session || !Array.isArray(rows)) return;
    const map = stateFor(session);
    const set = pending.get(session);
    for (const row of rows) {
      if (!row?.callId || row.status !== 'completed') continue;
      if (map.has(row.callId) || set.has(row.callId)) continue;
      if (queue.length >= maxQueue) {
        log('ca-v7 tool-backfill 队列已满（' + maxQueue + '），丢弃 ' + row.callId);
        continue;
      }
      set.add(row.callId);
      queue.push({ session, row });
    }
    drain();
  };

  /** 读取某 callId 回填结果（undefined=尚未回填） */
  const get = (session, callId) => bySession.get(session)?.get(callId);

  /** 用回填结果覆盖行：done 才替换（deterministic 摘要永远兜底） */
  const overlay = (rows, session) => {
    const map = bySession.get(session);
    if (!map) return rows ?? [];
    return (rows ?? []).map((row) => {
      const b = row?.callId ? map.get(row.callId) : undefined;
      if (!b || b.status !== 'done') return row;
      return { ...row, intent_l1: b.intent_l1, outcome_l1: b.outcome_l1 };
    });
  };

  /** debug：会话内已完成/失败计数 */
  const stats = (session) => {
    const map = bySession.get(session);
    if (!map) return { done: 0, failed: 0, pending: pending.get(session)?.size ?? 0 };
    let done = 0;
    let failed = 0;
    for (const v of map.values()) {
      if (v.status === 'done') done += 1;
      else failed += 1;
    }
    return { done, failed, pending: pending.get(session)?.size ?? 0 };
  };

  return { enqueue, get, overlay, stats };
}

/** 生成任务标识（调试用，测试可替换） */
export function newBackfillTaskId() {
  return randomUUID();
}
