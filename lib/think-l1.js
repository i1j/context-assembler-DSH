/**
 * lib/think-l1.js — 7.2 K1 思考卡 L1 提炼（纯函数 + 一次 Ollama 调用，零依赖）。
 *
 * 设计约束（需求规格 §2/§4）：
 * - 每张思考卡最多 1 次本地 4B 调用，失败不重试、fail-open；
 * - reasoning 原文不落库、不进 think-cards.json 正文（preview≤160 例外）；
 * - 本地模型 qwen3-4b-instruct:32k @ 127.0.0.1:11435（低优先级、num_predict=512）。
 */
export const THINK_L1_MAX_REASONING_CHARS = 6000;
export const THINK_L1_MAX_TOOLS = 8;
export const THINK_L1_MAX_QUESTION_CHARS = 2000; // 提问输入上限（与 reasoning 截断同理，防超长贴文撑爆本地 4B 输入）
export const THINK_L1_MODEL = 'qwen3-4b-instruct:32k';
export const THINK_L1_URL = 'http://127.0.0.1:11435';
export const THINK_L1_TIMEOUT_MS = 60000;
export const THINK_L1_NUM_PREDICT = 512;
export const MOCK_THINK_L1_TEXT = JSON.stringify({
  goal: 'mock：验证 think 阶段成功路径', decisions: ['mock 决策'],
  corrections: [], conclusion: 'mock 可复用结论', applies_when: '仅测试', confidence: 0.9,
});

/** 码点安全截断：n 为最大保留字符数；超长追加 '…[截断]'；非 string → '' */
export function clipThinkText(text, n) {
  if (typeof text !== 'string') return '';
  const arr = [...text];
  return arr.length > n ? arr.slice(0, n).join('') + '…[截断]' : text;
}

/**
 * 从 sessionReasoningMap（seq → reasoningText）中解析思考卡 reasoning。
 * 成功 → {status:'ok', reasoningText}
 * 失败 → {status:'error', error:{kind:'session_missing'|'reasoning_missing', message}}
 */
export function resolveThinkReasoning(sessionMap, { sessionId = '', seq = null } = {}) {
  if (!(sessionMap instanceof Map)) return { status:'error', error:{ kind:'session_missing', message:'会话目录缺失或 session.jsonl.zstd 解析失败: ' + sessionId } };
  const reasoningText = sessionMap.get(seq);
  if (typeof reasoningText !== 'string' || reasoningText.length === 0) {
    return { status:'error', error:{ kind:'reasoning_missing', message:'seq=' + seq + ' 无 reasoning' } };
  }
  return { status:'ok', reasoningText };
}

const NO_TOOL_VALUE = '(无)';

function toolField(v) {
  return v === null || v === undefined || v === '' ? NO_TOOL_VALUE : String(v);
}

/**
 * 构造 4B 输入（中文提示词 + question + reasoning 截断 6000 + 工具摘要）。
 * @param {{questionText?: string, reasoningText?: string, toolRows?: Array<{name?:string,argsSummary?:string,resultSummary?:string,hdl?:string,error?:any,exitCode?:any}>}} input
 * toolRows：只取前 8 条；每条至少含 name/argsSummary/resultSummary/hdl/error/exitCode 字段占位（空值显示 '(无)'）。
 * 输出包含提示词要求（严格 JSON + decisions 1-3 条 + confidence 0-1）与逐条工具行。
 */
export function buildThinkL1Input({ questionText = '', reasoningText = '', toolRows = [] } = {}) {
  const rows = (Array.isArray(toolRows) ? toolRows : []).slice(0, THINK_L1_MAX_TOOLS).map((row) => ({
    name: toolField(row?.name),
    argsSummary: toolField(row?.argsSummary),
    resultSummary: toolField(row?.resultSummary),
    hdl: toolField(row?.hdl),
    error: toolField(row?.error),
    exitCode: toolField(row?.exitCode),
  }));
  const lines = [];
  lines.push('你是 DSH 思考卡 L1 提炼器。请把下面这张思考卡提炼成一条可复用的 L1 经验。');
  lines.push('');
  lines.push('要求：');
  lines.push('1. 输出严格 JSON（不要 Markdown 围栏或任何多余文字）；');
  lines.push('2. 字段：goal（目标，非空字符串）、decisions（决策，string 数组，1-3 条）、corrections（修正，string 数组，可空数组）、conclusion（结论，非空字符串）、applies_when（适用条件，非空字符串）、confidence（置信度，0-1 数字）；');
  lines.push('3. decisions 必须恰好输出 1-3 条：先把重复/次要决策点合并，再只保留最重要的 3 条，禁止超过 3 条；confidence 必须是 0 到 1 之间的数字。');
  lines.push('');
  lines.push('【问题】');
  lines.push(clipThinkText(questionText, THINK_L1_MAX_QUESTION_CHARS));
  lines.push('');
  lines.push('【reasoning 原文（截断）】');
  lines.push(clipThinkText(reasoningText, THINK_L1_MAX_REASONING_CHARS));
  lines.push('');
  lines.push('【同轮工具摘要】');
  if (rows.length === 0) {
    lines.push('(无)');
  } else {
    rows.forEach((t, i) => {
      lines.push('工具 ' + (i + 1) + '：');
      lines.push('- name: ' + t.name);
      lines.push('- argsSummary: ' + t.argsSummary);
      lines.push('- resultSummary: ' + t.resultSummary);
      lines.push('- hdl: ' + t.hdl);
      lines.push('- error: ' + t.error);
      lines.push('- exitCode: ' + t.exitCode);
    });
  }
  return lines.join('\n');
}

/**
 * 解析 4B 响应并校验 schema。
 * 成功 → {status:'ok', l0Abstract: '<goal> → <conclusion>', l1Json:{goal,decisions,corrections,conclusion,applies_when,confidence}}
 * 失败 → {status:'error', error:{kind:'parse', message:string}}
 * 校验：goal/conclusion/applies_when 非空 string（trim 后）；decisions string[] 1-3 条且每元素为 string；
 *       corrections string[]（不限条数）每元素为 string（元素可空串，不额外过滤——对齐需求 R2）；
 *       confidence 为 finite number ∈[0,1]。
 * 解析策略：先剥 ```json/``` 围栏，再截取首个 '{' 到最后一个 '}'。
 * @returns {{status: 'ok', l0Abstract: string, l1Json: {goal: string, decisions: string[], corrections: string[], conclusion: string, applies_when: string, confidence: number}} | {status: 'error', error: {kind: string, message: string}}}
 */
export function parseThinkL1(text) {
  const fail = (message) => ({ status: 'error', error: { kind: 'parse', message } });
  if (typeof text !== 'string') return fail('response 不是 string');
  let s = text;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return fail('未找到 JSON 对象');
  let obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return fail('JSON 解析失败: ' + (e?.message ?? String(e)));
  }
  const goal = typeof obj?.goal === 'string' ? obj.goal.trim() : '';
  const conclusion = typeof obj?.conclusion === 'string' ? obj.conclusion.trim() : '';
  const appliesWhen = typeof obj?.applies_when === 'string' ? obj.applies_when.trim() : '';
  const decisions = obj?.decisions;
  const corrections = obj?.corrections;
  const confidence = obj?.confidence;
  if (!goal) return fail('goal 非空 string 校验失败');
  if (!conclusion) return fail('conclusion 非空 string 校验失败');
  if (!appliesWhen) return fail('applies_when 非空 string 校验失败');
  if (!Array.isArray(decisions) || decisions.length < 1 || decisions.length > 3 || !decisions.every((d) => typeof d === 'string')) {
    return fail('decisions 校验失败');
  }
  if (!Array.isArray(corrections) || !corrections.every((c) => typeof c === 'string')) {
    return fail('corrections 校验失败');
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return fail('confidence 校验失败');
  }
  return {
    status: 'ok',
    l0Abstract: goal + ' → ' + conclusion,
    l1Json: { goal, decisions, corrections, conclusion, applies_when: appliesWhen, confidence },
  };
}

/**
 * Ollama 一次调用，无重试。
 * @param {{questionText:string, reasoningText:string, toolRows:Array}} row
 * @param {{url?:string, model?:string, timeoutMs?:number, fetchFn?:Function}} opts
 * 成功 → {status:'ok', text: data.response ?? ''}
 * fetch 抛错（非 AbortError/TimeoutError）→ {status:'error', error:{kind:'fetch', message}}
 * AbortError 或 name==='TimeoutError'（DOMException）→ {status:'error', error:{kind:'timeout', message}}
 * 非 2xx → {status:'error', error:{kind:'http', message:'HTTP <status> <body 前 300>'}}
 * 2xx 但 resp.json() 抛错 → {status:'error', error:{kind:'parse', message:'response json 解析失败: <err>'}}
 * 请求体：POST <url>/api/generate，headers 含 X-Queue-Priority: low，body {model,prompt:buildThinkL1Input(row),stream:false,
 *         options:{num_predict:THINK_L1_NUM_PREDICT,temperature:0.1,format:'json'},keep_alive:-1,think:false}，
 *         signal: AbortSignal.timeout(timeoutMs)。
 */
export async function thinkL1Once(row, opts = {}) {
  const url = (opts.url ?? THINK_L1_URL).replace(/\/$/, '') + '/api/generate';
  const model = opts.model ?? THINK_L1_MODEL;
  const timeoutMs = opts.timeoutMs ?? THINK_L1_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;
  const body = {
    model,
    prompt: buildThinkL1Input(row ?? {}),
    stream: false,
    options: { num_predict: THINK_L1_NUM_PREDICT, temperature: 0.1, format: 'json' },
    keep_alive: -1,
    think: false,
  };
  let resp;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Queue-Priority': 'low' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      return { status: 'error', error: { kind: 'timeout', message: e?.message ?? String(e) } };
    }
    return { status: 'error', error: { kind: 'fetch', message: e?.message ?? String(e) } };
  }
  if (!resp.ok) {
    let bodyText = '';
    try { bodyText = await resp.text(); } catch { bodyText = ''; }
    return { status: 'error', error: { kind: 'http', message: 'HTTP ' + resp.status + ' ' + bodyText.slice(0, 300) } };
  }
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { status: 'error', error: { kind: 'parse', message: 'response json 解析失败: ' + (e?.message ?? String(e)) } };
  }
  return { status: 'ok', text: data?.response ?? '' };
}

/**
 * 输入 think_trace DB 行（snake_case），输出按 session_id:seq 去重后的 status==='raw' 行（保序、首个优先）。
 * 用途：stage 派发前规划，防止同批内重复领取。
 */
export function selectUniqueThinkCards(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows ?? []) {
    if (!r || r.status !== 'raw') continue;
    const key = String(r.session_id ?? '') + ':' + String(r.seq ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * 解析 think-keys 清单文本。
 * @param {string|null|undefined} text
 * @returns {{keys: string[], skipped: {empty: number, comment: number, invalid: number, duplicate: number}}}
 * - 逐行 trim；空行 → empty+1；以 '#' 开头 → comment+1；
 * - 合法格式 /^[^:]+:\d+$/（session_id 可含 '-'、'.' 等非冒号字符，seq 必须非负整数）→ key；
 * - 其余非空行 → invalid+1；重复 key（首次保留）→ duplicate+1；
 * - 非 string → 同空输入。
 */
export function parseThinkKeysFile(text) {
  const skipped = { empty: 0, comment: 0, invalid: 0, duplicate: 0 };
  if (typeof text !== 'string' || text.length === 0) {
    return { keys: [], skipped };
  }
  const keys = [];
  const seen = new Set();
  // 文件末尾单个换行是行结束符，不额外计为一个空行
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      skipped.empty += 1;
      continue;
    }
    if (line.startsWith('#')) {
      skipped.comment += 1;
      continue;
    }
    if (!/^[^:]+:\d+$/.test(line)) {
      skipped.invalid += 1;
      continue;
    }
    if (seen.has(line)) {
      skipped.duplicate += 1;
    } else {
      seen.add(line);
      keys.push(line);
    }
  }
  return { keys, skipped };
}

/**
 * 按清单选取 raw 卡。
 * @param {Array<any>} rows   // think_trace DB 行（snake_case：session_id/seq/status）
 * @param {Array<string>|null|undefined} keys
 * @param {number} limit      // 0 = 不限
 * @returns {Array<any>}
 * - keys 为 null/undefined/空数组 → 等价 selectUniqueThinkCards(rows) 后再 slice(0, limit || all)；
 * - 否则：先把 rows 中 status==='raw' 的行按 'session_id:seq' 建索引（同键取首个），
 *   再按 keys 文件顺序取行；缺失/非 raw 键跳过；满 limit 停止；返回卡片数组。
 */
export function selectThinkCardsByKeys(rows, keys, limit = 0) {
  const uniqueRows = selectUniqueThinkCards(rows);
  if (keys == null || keys.length === 0) {
    return limit > 0 ? uniqueRows.slice(0, limit) : uniqueRows;
  }
  const byKey = new Map();
  for (const r of uniqueRows) {
    const key = String(r.session_id ?? '') + ':' + String(r.seq ?? '');
    if (!byKey.has(key)) byKey.set(key, r);
  }
  const out = [];
  for (const key of keys) {
    if (limit > 0 && out.length >= limit) break;
    const r = byKey.get(key);
    if (r) out.push(r);
  }
  return out;
}

// ════════════════════════════════════════════ 7.2 K1 flash ═══════════════════════════════════════════
export const THINK_L1_FLASH_URL = 'https://api.deepseek.com';
export const THINK_L1_FLASH_MODEL = 'deepseek-v4-flash';
export const THINK_L1_FLASH_MAX_TOKENS = 512;
export const THINK_L1_FLASH_TEMPERATURE = 0.1;
export const THINK_L1_FLASH_SYSTEM = '你是 DSH 思考卡 L1 提炼器。只输出严格 JSON，遵守用户消息中的字段要求。';

/**
 * DeepSeek chat/completions 一次调用（无重试），与 thinkL1Once 同 fail-open 语义。
 * @param {{questionText:string, reasoningText:string, toolRows:Array}} row
 * @param {{url?:string, model?:string, apiKey?:string, timeoutMs?:number, fetchFn?:Function}} opts
 * @returns {{status:'ok', text:string, usage:{inputTokens:number, outputTokens:number}}
 *          | {status:'error', error:{kind:'fetch'|'http'|'timeout'|'parse', message:string}}}
 * 请求：POST <url>/chat/completions；headers Content-Type + Authorization: Bearer <apiKey>；
 *  body {model, messages:[{role:'system',content:THINK_L1_FLASH_SYSTEM},
 *        {role:'user',content:buildThinkL1Input(row)}],
 *        response_format:{type:'json_object'}, max_tokens:THINK_L1_FLASH_MAX_TOKENS,
 *        temperature:THINK_L1_FLASH_TEMPERATURE}；
 *  signal: AbortSignal.timeout(timeoutMs ?? THINK_L1_TIMEOUT_MS)。
 * 错误映射：fetch 抛错（非 Abort/Timeout）→ fetch；Abort/TimeoutError → timeout；
 *  非 2xx → http（message='HTTP <status> ' + body 前 300）；resp.json 抛错 → parse；
 *  2xx 但 content 非 string/空 → parse('empty content')。
 * 成功：text = choices[0].message.content；usage = {inputTokens: data.usage?.prompt_tokens ?? 0,
 *        outputTokens: data.usage?.completion_tokens ?? 0}（usage 缺失 → 0/0）。
 */
export async function thinkL1OnceFlash(row, opts = {}) {
  const url = (opts.url ?? THINK_L1_FLASH_URL).replace(/\/$/, '') + '/chat/completions';
  const model = opts.model ?? THINK_L1_FLASH_MODEL;
  const apiKey = opts.apiKey ?? '';
  const timeoutMs = opts.timeoutMs ?? THINK_L1_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;
  const body = {
    model,
    messages: [
      { role: 'system', content: THINK_L1_FLASH_SYSTEM },
      { role: 'user', content: buildThinkL1Input(row ?? {}) },
    ],
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    max_tokens: THINK_L1_FLASH_MAX_TOKENS,
    temperature: THINK_L1_FLASH_TEMPERATURE,
  };
  let resp;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      return { status: 'error', error: { kind: 'timeout', message: e?.message ?? String(e) } };
    }
    return { status: 'error', error: { kind: 'fetch', message: e?.message ?? String(e) } };
  }
  if (!resp.ok) {
    let bodyText = '';
    try { bodyText = await resp.text(); } catch { bodyText = ''; }
    return { status: 'error', error: { kind: 'http', message: 'HTTP ' + resp.status + ' ' + bodyText.slice(0, 300) } };
  }
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { status: 'error', error: { kind: 'parse', message: 'response json 解析失败: ' + (e?.message ?? String(e)) } };
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    return { status: 'error', error: { kind: 'parse', message: 'empty content' } };
  }
  return {
    status: 'ok',
    text: content,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}
