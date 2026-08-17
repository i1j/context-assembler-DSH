/**
 * lib/fct-ooda.js — Fct 多事务 OODA 生成器（7.1 + 部分 7.2 thought，对齐 Hermes 决策 44/45）。
 *
 * 权威锚点：
 *   - OODA 四段（FCT_OODA_KEYS）：现象与问题 / 背景与约束 / 决策与方案 / 后续行动
 *     （Hermes ca/fct_multi_affair.py:25，Observe/Orient/Decide/Act）。
 *   - 生成 prompt：Hermes ca/prompts.py FCT_GENERATION_PROMPT_MULTI_AFFAIR（增量提取 + 多事务纪律
 *     + hdl 中文短名规范 ≤30 字禁代码符号名）。
 *   - 事务帧渲染：Hermes ca/blocks.py format_transaction_frames（[事务 #N] + [ooda_stage|block_type]）。
 *   - 替换文本渲染：Hermes ca/f_stage.py _format_fct_for_display 决策 45（事务 hdl + OODA 阶段，无状态标签）。
 *
 * 职责边界：本模块为纯函数 + 4B 调用/队列（零业务耦合）。事务帧/思考线索的原始数据由调用方
 * （运行时 index.js / 离线回放）从 view / tool-trace / think-trace 快照构建后传入。
 *
 * fail-open 纪律（对齐 tool-backfill）：
 *   - 4B 不可用/超时/解析失败 → {status:'error'}，调用方保留原文（宁缺勿错）；
 *   - parse 只收合法 affairs（四键必全、hdl 兜底）；无事务 → error（不伪造空摘要）。
 */
import { randomUUID } from 'node:crypto';

/** OODA 四段键（权威顺序，值均为 string 数组，可空数组） */
export const FCT_OODA_KEYS = ['现象与问题', '背景与约束', '决策与方案', '后续行动'];
/** v3 多事务 OODA 契约标记（对齐 Hermes FCT_FORMAT_V3） */
export const FCT_FORMAT_V3 = 'v3-multi-affair-ooda';
/** think 卡种类优先级：orient（事务划分线索）> decision */
export const THINK_CARD_PRIORITY = { orient: 0, decision: 1 };
/** hdl 短名上限（对齐 Hermes ≤30 字，禁代码符号名） */
export const FCT_HDL_MAX = 30;

/** 事务帧默认截断：单行文本上限（对齐 Hermes _legacy_line 的 200 字符 tool 截断） */
const DEFAULT_MAX_PER_LINE = 200;
/** think 上下文默认预算：卡数/每卡字符/总预算（对齐 Hermes build_fct_think_context 默认） */
const DEFAULT_MAX_THINK_CARDS = 8;
const DEFAULT_MAX_CHARS_PER_CARD = 500;
const DEFAULT_TOTAL_THINK_BUDGET = 2000;

/* ────────────────────────── 事务帧渲染 ────────────────────────── */

/** elm.type → block_type（对齐 Hermes blocks.py BlockType 语义） */
const BLOCK_TYPE_BY_ELM = {
  user: 'user',
  thought: 'thinking',
  fin: 'agent_reply',
  toolCall: 'tool_call_request',
  toolResult: 'tool_call_result',
};

/**
 * view Elm 列表 → 事务帧文本（[事务 #N] + [ooda_stage|block_type]）。
 * @param {Array<any>} viewElms lib/view.js 输出（type/transaction_id/elm_ref/ooda_stage/text）
 * @param {object} opts {maxPerLine?}
 * @returns {string} 多行事务帧文本；无 elm → ''。
 * 对齐 Hermes format_transaction_frames：按事务分组（升序）、synthetic 跳过（A25 不打标）、
 * 单行文本截断 maxPerLine。ooda_stage 缺失回退 'observe'。
 */
export function buildTransactionFrames(viewElms, opts = {}) {
  const maxPerLine = Number(opts.maxPerLine ?? DEFAULT_MAX_PER_LINE);
  const byTxn = new Map();
  for (const elm of viewElms ?? []) {
    if (!elm || elm.type === 'synthetic') continue;
    if (elm.transaction_id === undefined || elm.transaction_id === null) continue;
    const list = byTxn.get(elm.transaction_id) ?? [];
    list.push(elm);
    byTxn.set(elm.transaction_id, list);
  }
  const lines = [];
  for (const [txnId, elms] of [...byTxn.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`[事务 #${txnId}]`);
    for (const elm of elms) {
      const stage = typeof elm.ooda_stage === 'string' ? elm.ooda_stage : 'observe';
      const blockType = BLOCK_TYPE_BY_ELM[elm.type] ?? 'unknown';
      const text = String(elm.text ?? '').trim();
      const shown = text.length > maxPerLine ? text.slice(0, maxPerLine) + '…' : text;
      lines.push(`[${stage}|${blockType}] ${shown}`);
    }
  }
  return lines.join('\n');
}

/* ────────────────────────── think 上下文 ────────────────────────── */

/**
 * orient/decision 思考卡 → Fct 生成用思考线索文本（对齐 Hermes build_fct_think_context）。
 * @param {Array<any>} cards think 卡行（think-collect 输出：cardKind/seq/turn/questionText/preview）
 * @param {object} opts {maxCards?, maxCharsPerCard?, totalBudget?, reasoningTextBySeq?: Map<number,string>}
 * @returns {string} 多行思考线索；无卡 → ''。
 * orient（事务划分线索）优先于 decision；每卡截断、总预算封顶，宁缺勿滥。
 */
export function buildOodaThinkContext(cards, opts = {}) {
  const maxCards = Number(opts.maxCards ?? DEFAULT_MAX_THINK_CARDS);
  const maxCharsPerCard = Number(opts.maxCharsPerCard ?? DEFAULT_MAX_CHARS_PER_CARD);
  const totalBudget = Number(opts.totalBudget ?? DEFAULT_TOTAL_THINK_BUDGET);
  const reasoningTextBySeq = opts.reasoningTextBySeq instanceof Map ? opts.reasoningTextBySeq : new Map();
  const picked = (cards ?? [])
    .filter((c) => c && THINK_CARD_PRIORITY[c.cardKind] !== undefined)
    .sort((a, b) => (THINK_CARD_PRIORITY[a.cardKind] - THINK_CARD_PRIORITY[b.cardKind]) || ((a.seq ?? 0) - (b.seq ?? 0)))
    .slice(0, maxCards);
  if (picked.length === 0) return '';
  const lines = [];
  let used = 0;
  for (const card of picked) {
    const raw =
      typeof card.reasoningText === 'string' && card.reasoningText
        ? card.reasoningText
        : typeof card.seq === 'number'
          ? reasoningTextBySeq.get(card.seq) ?? ''
          : '';
    const fallback = typeof card.preview === 'string' ? card.preview : '';
    const base = raw || fallback;
    if (!base) continue;
    const chunk = base.length > maxCharsPerCard ? base.slice(0, maxCharsPerCard) + '…[截断]' : base;
    if (used + chunk.length > totalBudget && lines.length > 0) break;
    lines.push(`[思考卡 ${card.cardKind}|seq=${card.seq ?? '?'}]`);
    if (typeof card.questionText === 'string' && card.questionText.trim()) {
      lines.push(`问题: ${card.questionText.trim()}`);
    }
    lines.push(`思考: ${chunk}`);
    lines.push('');
    used += chunk.length;
    if (used >= totalBudget) break;
  }
  return lines.join('\n').trimEnd();
}

/* ────────────────────────── prompt 构建 ────────────────────────── */

/**
 * 构建多事务 OODA 生成 prompt（对齐 Hermes FCT_GENERATION_PROMPT_MULTI_AFFAIR）。
 * @param {object} input
 * @param {string} [input.previousFct] 前轮 Fct（JSON 或渲染文本；空 → 用空 Fct 信号）
 * @param {string} [input.currentFrames] 本轮事务帧文本（buildTransactionFrames 输出）
 * @param {string} [input.thinkContext] 首轮思考线索（buildOodaThinkContext 输出；可空）
 * @returns {string} 完整 prompt
 */
export function buildFctOodaPrompt({ previousFct = '', currentFrames = '', thinkContext = '' } = {}) {
  const prev = String(previousFct ?? '').trim() || '{"affairs":[]}';
  const frames = [thinkContext.trim() ? `【首轮思考线索（代码筛选）】\n${thinkContext.trim()}` : '', `【事务帧】\n${currentFrames.trim() || '（本轮无事务帧）'}`]
    .filter(Boolean)
    .join('\n\n');
  return [
    '你是一个研发对话意图分析器。请对比【历史摘要】与【本轮对话】，提取本轮新增的业务意图与技术决策，并按**事务（affair）**组织成多事务 OODA 记录。',
    '',
    '【历史摘要】',
    prev,
    '',
    '【本轮对话】',
    frames,
    '',
    '【输出规则 - 必须严格遵守】',
    '1. 只输出一个严格 JSON 对象（不要 Markdown 围栏、不要任何解释文字）。',
    '2. 顶层字段：',
    '   - affairs: array，每个独立事务一个对象。一个用户提问可能包含多个独立事务，必须拆分（宁多勿少）；若只有一个，输出单元素数组。',
    '   - 每个 affair 字段：',
    '     * hdl: string，事务短名（先组织 ooda 再总结，≤30 字，禁止代码符号名/英文标识符/文件名/函数名）',
    '     * turns: array<int>，该事务出现的轮次',
    '     * ooda: object，四个键必须全部出现，值为 string 数组（无内容给空数组）：',
    '       - "现象与问题"：该事务本轮新出现的现象、问题或状态变化',
    '       - "背景与约束"：本轮补充的背景与约束事实',
    '       - "决策与方案"：本轮做出或正在评估的决策与方案',
    '       - "后续行动"：后续要执行的行动',
    '3. OODA 阶段键就是变更记录本身（事务总是处于 OODA 的某一环节）：',
    '   - 把每条变更写进它所属阶段的数组里；同一阶段多个变更拆成多条数组项；',
    '   - 禁止输出 changes 字段，禁止使用【已实施】【计划】【探讨】【已取消】等状态标签；',
    '   - 时态与阶段语义一致：现象/背景用陈述句；已执行的决策用完成时；未执行的方案与后续行动用将来时；被取消的事项用完成时否定（如"已取消…"）。',
    '4. 多事务纪律：',
    '   - 每个 affair 的 ooda 必须自洽，禁止把一个事务的决策写进另一个事务；',
    '   - 每个独立事务必须单独成 affair，禁止合并；同一事务的多条变更分别放入对应阶段。',
    '5. 增量提取：仅提取本轮首次出现且历史摘要未记录的内容；历史已有不再重复。若无任何新事务，输出 affairs 为空数组。',
    '',
    '示例输出：',
    '{"affairs":[{"hdl":"连接池扩容","turns":[7],"ooda":{"现象与问题":["连接池耗尽"],"背景与约束":["连接池上限100"],"决策与方案":["连接池扩容到200"],"后续行动":["观察慢查询"]}}]}',
    '',
    '请直接输出 JSON：',
  ].join('\n');
}

/* ────────────────────────── 解析 ────────────────────────── */

/** 值归一为 string 数组（对齐 Hermes _normalize_str_list） */
function normalizeStrList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x : String(x ?? '')));
}

/** 从 4B 输出文本中提取首个完整 JSON 对象（容忍围栏/说明文字） */
export function parseJsonObject(text) {
  const s = String(text ?? '');
  // 去 Markdown 围栏
  const stripped = s.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** hdl 兜底（对齐 Hermes _fallback_hdl）：hdl → 四段首条 → 事务N */
export function fallbackHdl(affair, idx) {
  const hdl = typeof affair?.hdl === 'string' ? affair.hdl.trim() : '';
  if (hdl) return hdl.slice(0, FCT_HDL_MAX);
  const ooda = affair?.ooda && typeof affair.ooda === 'object' ? affair.ooda : {};
  for (const key of ['现象与问题', '决策与方案', '后续行动', '背景与约束']) {
    const items = normalizeStrList(ooda[key]);
    if (items.length > 0 && items[0].trim()) return items[0].trim().slice(0, FCT_HDL_MAX);
  }
  return `事务${idx}`;
}

/**
 * 解析 4B 多事务 OODA 输出。
 * @param {string} text
 * @returns {{status:'ok', affairs:Array<{hdl:string,turns:number[],ooda:Record<string,string[]>,_idx:number}>} | {status:'error', reason:string}}
 * 合法要求：affairs 非空数组且每项为对象；四键必全（缺失补空数组）；hdl 兜底；turns 归一为 int[]。
 * 无合法事务 → error（调用方保留原文，fail-open）。
 */
export function parseFctOoda(text) {
  const obj = parseJsonObject(text);
  if (!obj || !Array.isArray(obj.affairs) || obj.affairs.length === 0) {
    return { status: 'error', reason: obj ? 'no-affairs' : 'no-json' };
  }
  const affairs = [];
  for (let idx = 0; idx < obj.affairs.length; idx += 1) {
    const item = obj.affairs[idx];
    if (!item || typeof item !== 'object') continue;
    const rawOoda = item.ooda && typeof item.ooda === 'object' ? item.ooda : {};
    const ooda = {};
    for (const key of FCT_OODA_KEYS) ooda[key] = normalizeStrList(rawOoda[key]);
    const turns = Array.isArray(item.turns)
      ? item.turns.map((t) => Number(t)).filter((t) => Number.isInteger(t))
      : [];
    const affair = {
      hdl: fallbackHdl(item, idx + 1),
      turns,
      ooda,
      _idx: idx + 1,
    };
    affairs.push(affair);
  }
  if (affairs.length === 0) return { status: 'error', reason: 'empty-affairs' };
  return { status: 'ok', affairs };
}

/* ────────────────────────── 渲染替换文本 ────────────────────────── */

/**
 * affairs → 可替换文本（对齐 Hermes _format_fct_for_display 决策 45：事务 hdl + OODA 阶段，无状态标签）。
 * @param {Array<any>} affairs parseFctOoda 输出
 * @returns {string} 多行文本；空输入 → ''。
 */
export function formatFctAffairs(affairs) {
  const lines = [];
  for (let idx = 0; idx < (affairs ?? []).length; idx += 1) {
    const a = affairs[idx];
    if (!a || typeof a !== 'object') continue;
    const hdl = typeof a.hdl === 'string' && a.hdl.trim() ? a.hdl.trim() : `事务${idx + 1}`;
    lines.push(`${idx + 1}. ${hdl}`);
    const ooda = a.ooda && typeof a.ooda === 'object' ? a.ooda : {};
    for (const label of FCT_OODA_KEYS) {
      const items = normalizeStrList(ooda[label]).map((s) => s.trim()).filter(Boolean);
      if (items.length > 0) lines.push(`  ${label}: ${items.join('; ')}`);
    }
  }
  return lines.join('\n');
}

/* ────────────────────────── 4B 调用与队列 ────────────────────────── */

/**
 * 本地 4B 生成多事务 OODA（Ollama /api/generate，format=json；失败返回 {status:'error'}）。
 * @param {string} prompt buildFctOodaPrompt 输出
 * @param {object} opts {url?, model?, timeoutMs?, priority?}
 * @returns {Promise<{status:'ok',affairs:Array}|{status:'error',reason:string}>}
 */
export async function fctOoda4B(prompt, opts = {}) {
  const url = (opts.url ?? 'http://127.0.0.1:11435').replace(/\/$/, '');
  const model = opts.model ?? 'qwen3-4b-instruct:32k';
  const timeoutMs = Number(opts.timeoutMs ?? 60000);
  const priority = opts.priority ?? 'normal';
  const body = {
    model,
    prompt,
    stream: false,
    options: { num_predict: 1500, temperature: 0.1, format: 'json' },
    keep_alive: -1,
    think: false,
  };
  let resp;
  try {
    resp = await fetch(url + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Queue-Priority': priority },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'error', reason: 'network' };
  }
  if (!resp.ok) return { status: 'error', reason: 'http-' + resp.status };
  let data;
  try {
    data = await resp.json();
  } catch {
    return { status: 'error', reason: 'bad-json' };
  }
  return parseFctOoda(data?.response ?? '');
}

/**
 * 创建 Fct OODA 生成队列（每会话独立状态，WeakMap 随会话释放）。
 * @param {object} opts {url?, model?, timeoutMs?, maxConcurrent?, maxQueue?, warn?}
 * @returns {{enqueue, get, stats}}
 * - enqueue(session, turn, input)：入队一次（每 turn 一次；队列满丢弃）；drain 时 buildFctOodaPrompt + fctOoda4B。
 *   input = {previousFct, currentFrames, thinkContext}
 * - get(session, turn)：{status:'done',affairs}|{status:'failed'}|{status:'pending'}|undefined
 * - stats(session)：{done,failed,pending}
 */
export function createFctOodaQueue(opts = {}) {
  const url = opts.url ?? 'http://127.0.0.1:11435';
  const model = opts.model ?? 'qwen3-4b-instruct:32k';
  const timeoutMs = Number(opts.timeoutMs ?? 60000);
  const maxConcurrent = Math.max(1, Number(opts.maxConcurrent) || 2);
  const maxQueue = Math.max(1, Number(opts.maxQueue) || 16);
  const priority = opts.priority ?? 'normal';
  const run4B = opts.run4B ?? ((prompt, o) => fctOoda4B(prompt, o));
  const bySession = new WeakMap();
  const queue = [];
  let active = 0;
  const log = opts.warn ? (msg) => opts.warn(msg) : () => {};

  const stateFor = (session) => {
    let map = bySession.get(session);
    if (!map) {
      map = new Map();
      bySession.set(session, map);
    }
    return map;
  };

  const drain = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job) continue;
      active += 1;
      const prompt = buildFctOodaPrompt(job.input ?? {});
      run4B(prompt, { url, model, timeoutMs, priority })
        .then((res) => {
          stateFor(job.session).set(job.turn, res.status === 'ok'
            ? { status: 'done', affairs: res.affairs }
            : { status: 'failed', affairs: null, reason: res.reason });
        })
        .catch(() => {
          stateFor(job.session).set(job.turn, { status: 'failed', affairs: null, reason: 'exception' });
        })
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  /** 入队某 turn 的 OODA 生成（每 turn 一次；pending/失败不重试，宁缺勿错） */
  const enqueue = (session, turn, input) => {
    if (!session || turn === null || turn === undefined || turn < 0) return;
    const map = stateFor(session);
    if (map.has(turn)) return;
    map.set(turn, { status: 'pending', affairs: null });
    if (queue.length >= maxQueue) {
      log(`ca-v7 fct-ooda 队列已满（${maxQueue}），丢弃 turn ${turn}`);
      map.set(turn, { status: 'failed', affairs: null, reason: 'queue-full' });
      return;
    }
    queue.push({ session, turn, input });
    drain();
  };

  /** 读取某 turn 的生成结果（undefined=尚未入队/处理中） */
  const get = (session, turn) => bySession.get(session)?.get(turn);

  /** debug：会话内已完成/失败/排队计数 */
  const stats = (session) => {
    const map = bySession.get(session);
    if (!map) return { done: 0, failed: 0, pending: 0 };
    let done = 0;
    let failed = 0;
    let pending = 0;
    for (const v of map.values()) {
      if (v.status === 'done') done += 1;
      else if (v.status === 'failed') failed += 1;
      else pending += 1;
    }
    return { done, failed, pending };
  };

  return { enqueue, get, stats };
}

/** 生成任务标识（调试用，测试可替换） */
export function newFctOodaTaskId() {
  return randomUUID();
}
