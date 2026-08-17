/**
 * 话题参考 reality 召回注入（lib/reality-inject.js）——Hermes 方向② recall 注入的 DSH 版。
 *
 * 参考 Hermes ca/inject.py（决策 41 §2.4b 提问云形心散度预筛 + 自注入排除）：
 *   - 预筛（确定性）：当前轮 user 消息 embedding → 与 CA 库 realities.centroid 余弦比较，
 *     阈值内候选；剔除 source_strands 含当前会话的 reality（防自注入，CR-13 对齐）。
 *   - 拣选：Hermes 用 4B LLM 拣选 top-3；DSH 版保持确定性优先（对齐插件「注入路径无 LLM」
 *     约束），直接取余弦最高的 top-k（k 默认 1）——空注入合法（无候选超过阈值即不注入）。
 *   - 注入：reality 参考消息（name + hdl + current_status 摘要）尾部追加（缓存命中约束）。
 *
 * 数据源：DSH CA 库（ca_cache/ca_topics.db realities 表 + centroid_json），
 * 由 summarize-history.mjs 构建；路径可配置（realityDbPath），文件缺失则功能停用。
 * Embedding：本地 ollama-priority-proxy（Hermes 同端点，默认 http://127.0.0.1:11435）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 读取 CA 库 realities 索引（id/name/hdl/current_status/centroid/source_strands） */
export function loadRealityIndex(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  const rows = [];
  try {
    const stmt = db.prepare(
      'SELECT reality_id, name, hdl, current_status, centroid_json, source_strands FROM realities',
    );
    for (const r of stmt.all()) {
      let centroid = null;
      try { centroid = JSON.parse(r.centroid_json ?? 'null'); } catch { centroid = null; }
      if (!Array.isArray(centroid) || centroid.length === 0) continue;
      const sourceStrands = safeJson(r.source_strands, {});
      rows.push({
        reality_id: r.reality_id,
        name: r.name ?? '',
        hdl: r.hdl ?? '',
        current_status: safeJson(r.current_status, {}),
        centroid,
        // 旧库/手写数据可能出现 JSON null 或数组：统一归一为对象，防自注入过滤 hasOwnProperty 抛 TypeError
        source_strands: sourceStrands && typeof sourceStrands === 'object' && !Array.isArray(sourceStrands) ? sourceStrands : {},
      });
    }
  } catch {
    // fail-open：schema 缺列/表损坏等查询错误一律返回空索引（召回停用），不得击穿插件 apply
    rows.length = 0;
  } finally {
    db.close();
  }
  return rows;
}

function safeJson(text, fallback) {
  try { return JSON.parse(text ?? ''); } catch { return fallback; }
}

/** 注入文本格式修剪（2026-08-15：去掉冗余信息）——markdown 残留/空白压缩/行长上限/纯标点剔除 */
const MARKDOWN_ARTIFACTS = /[*_~#]|>+\s?/g;

/**
 * 清洗单行注入文本：去 markdown 残留 → 压缩空白 → 截断到 maxLen → 丢弃空行/纯标点行。
 * @param {string} raw 原始行文本
 * @param {number} [maxLen=80] 行长上限（超出省略号截断）
 * @returns {string} 清洗后的行；空/纯标点返回 ''
 */
export function cleanInjectionLine(raw, maxLen = 80) {
  let t = String(raw ?? '')
    .replace(MARKDOWN_ARTIFACTS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(t)) return '';
  return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
}

/**
 * 组装注入文本：逐行清洗 + 空行剔除 + 归一化去重 + 行数上限。
 * 去重键 = 清洗后整行（>60 字符取前 60 前缀），近重复行合并。
 * @param {string|string[]} text 原始文本或行数组
 * @param {{maxLine?: number; maxLines?: number}} [opts]
 * @returns {string} 修剪后文本（\n 连接）
 */
export function trimInjectionText(text, opts = {}) {
  const maxLine = opts.maxLine ?? 80;
  const maxLines = opts.maxLines ?? 16;
  const lines = Array.isArray(text) ? text : String(text ?? '').split('\n');
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const cleaned = cleanInjectionLine(raw, maxLine);
    if (!cleaned) continue;
    const key = cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxLines) break;
  }
  return out.join('\n');
}

/** 调用本地 embedding 代理（Ollama API /api/embed，Hermes 同端点） */
/** 从一条 user 消息（消息对象或会话事件 data）提取文本块拼接；source.kind==='user' 才认可 */
function userMessageText(msg) {
  if (!msg) return '';
  const src = msg.source;
  if (src && src.kind !== undefined && src.kind !== 'user') return ''; // 插件注入/系统消息排除
  const content = Array.isArray(msg.content) ? msg.content : [];
  return content
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim();
}

/**
 * 提取注入用的当前轮 user 文本（Hermes 决策 38/41「首轮 + 话题切换」注入的运行时适配）。
 *
 * 根因（2026-08-18 复核定位，B10）：`agent/pre-step` 在 `step/start` 之前触发，当前轮
 * user/message 事件由 agent-loop 在 pre-step waterfall **返回之后**才写入会话
 * （dsh-agent-loop/lib/index.js：`session.append('user/message', decision.messages)`），
 * 因此 pre-step 时刻：
 *   - ca-v7/view 投影只有历史轮 user elm（首轮为空），**永不包含当前轮提问**；
 *   - session.events 也**没有**当前轮 user/message（首轮完全没有 user/message）。
 * 旧版（61b68ab）用「view 空回退 session.events」取到的只是**上一轮**的 user 文本，
 * 首轮仍取空 → 首轮注入依旧静默失效；且把上一轮文本当提问做 embedding/话题判定。
 *
 * 修复：agent/pre-step waterfall payload 的 `messages`（本轮从 inbox claim 的输入消息）
 * 是 pre-step 时刻当前轮 user 文本的**唯一权威来源**——最高优先级使用；
 * view / session.events 仅作直接调用（测试/调试）场景的兜底。
 *  - claimed 只认 source.kind==='user'（排除插件注入 / system-reminder 等非用户输入）；
 *  - 纯函数零 IO，调用方（maybeInjectReality）在 embed 前使用，不影响后续链路。
 *
 * @param {Array<any>|undefined} view ca-v7/view 投影（可能为空/undefined）
 * @param {{events?: Array<{type:string,data?:any}>}|undefined} session 会话事件源
 * @param {Array<any>|undefined} [claimedMessages] agent/pre-step payload.messages（本轮 claim 输入）
 * @returns {string} user 文本（无可用 → ''）
 */
export function extractInjectionUserText(view, session, claimedMessages) {
  // 0) 本轮 claimed 输入消息（pre-step payload.messages）——当前轮提问的权威来源
  if (Array.isArray(claimedMessages)) {
    for (let i = claimedMessages.length - 1; i >= 0; i -= 1) {
      const text = userMessageText(claimedMessages[i]);
      if (text) return text;
    }
  }
  // 1) view 内最近的 user elm（历史轮兜底：切换轮 view 已有历史）
  if (Array.isArray(view)) {
    const openUser = [...view].reverse().find((e) => e?.type === 'user');
    const text = typeof openUser?.text === 'string' ? openUser.text.trim() : '';
    if (text) return text;
  }
  // 2) 会话事件日志取最近真实 user 消息（直接调用/无 payload 场景兜底）
  const events = Array.isArray(session?.events) ? session.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (!evt || evt.type !== 'user/message') continue;
    const text = userMessageText(evt.data);
    if (text) return text;
  }
  return '';
}

export async function embedText(text, embedUrl, embedModel) {
  if (!text || !text.trim()) return null;
  const resp = await fetch(embedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embedModel, input: [text.slice(0, 3000)] }),
  });
  if (!resp.ok) throw new Error('embed ' + resp.status);
  const data = await resp.json();
  return data.embeddings?.[0] ?? null;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return na && nb ? dot / (na * nb) : 0;
}

/**
 * 候选预筛：embedding 余弦 ≥ minScore 且不来自当前会话（防自注入）。
 * @param {number[]} queryEmbedding
 * @param {Array} index loadRealityIndex 结果
 * @param {string} sessionId 当前会话 id（剔除其 source_strands 含该会话的 reality）
 * @param {{ minScore: number; topK: number }} config
 * @returns {Array<{reality: object; score: number}>}
 */
export function findRealityCandidates(queryEmbedding, index, sessionId, config) {
  const scored = [];
  for (const r of index) {
    const ss = r?.source_strands;
    // source_strands 缺失/null/数组等畸形值视为无来源信息（不排除）；对象才做自注入排除
    if (sessionId && ss && typeof ss === 'object' && !Array.isArray(ss)
      && Object.prototype.hasOwnProperty.call(ss, sessionId)) continue;
    const s = cosine(queryEmbedding, r.centroid);
    if (s >= (config.minScore ?? 0.55)) scored.push({ reality: r, score: s });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(1, config.topK ?? 1));
}

/**
 * current_status 摘要（current_state/goals/key_facts，各取前 N 条）。
 * 注入格式按「单位 token 互信息密度」修订（2026-08-18）：
 *   - 英文短键作为纯结构信号，避免中文标签与正文内容混淆；
 *   - name=本条 reality 名称 / status=当前状态 / state=现状 / goals=目标 / facts=关键事实；
 *   - 去掉项目符号/分组标题/缩进，多值用全角分号内联。
 * 注意：`kind: reference` 由 buildRealityInjectionMessage 在整段首条前加一次，
 * 不在单条 condenseReality 里重复。
 */
export function condenseReality(reality, maxItems = 3) {
  const cs = reality.current_status ?? {};
  const state = Array.isArray(cs.current_state) ? cs.current_state.slice(0, maxItems) : [];
  const goals = Array.isArray(cs.goals) ? cs.goals.slice(0, maxItems) : [];
  const facts = Array.isArray(cs.key_facts) ? cs.key_facts.slice(0, maxItems) : [];
  const clean = (s) => cleanInjectionLine(s, 80);
  const joinItems = (items) => items.map(clean).filter(Boolean).join('；');
  const lines = [];
  if (reality.name) lines.push('name: ' + clean(reality.name));
  if (reality.hdl) lines.push('status: ' + clean(reality.hdl));
  const stateText = joinItems(state);
  if (stateText) lines.push('state: ' + stateText);
  const goalsText = joinItems(goals);
  if (goalsText) lines.push('goals: ' + goalsText);
  const factsText = joinItems(facts);
  if (factsText) lines.push('facts: ' + factsText);
  return trimInjectionText(lines, { maxLine: 600, maxLines: 8 });
}

/**
 * 构建 reality 参考注入消息（尾部追加用）。
 * source = {kind:'plugin', plugin:'ca-v7', form:'reality-recall', sections}；
 * sections = reality_refs 命名 section（JSON 编码 reality_id 数组）+ 每候选 reality 命名 section。
 */
export function buildRealityInjectionMessage(candidates, config, estimateMessage) {
  const sections = [
    { name: 'reality_refs', text: JSON.stringify(candidates.map((c) => c.reality.reality_id)) },
    ...candidates.map((c) => ({ name: 'reality-' + c.reality.reality_id, text: condenseReality(c.reality) })),
  ];
  const make = (text) =>
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'ca-v7', form: 'reality-recall', sections },
    });
  const blocks = candidates.map((c) => condenseReality(c.reality));
  // 整段只声明一次「这是参考信息」；多条 reality 之间用空行分隔，不重复 kind。
  let content = blocks.map((text, i) => (i === 0 ? 'kind: reference\n' + text : text)).join('\n\n');
  let message = make(content);
  const limit = config.tokenLimit ?? 500;
  if (typeof estimateMessage === 'function' && estimateMessage(message) > limit) {
    let lo = 0;
    let hi = content.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateMessage(make(content.slice(0, mid))) <= limit) lo = mid;
      else hi = mid - 1;
    }
    content = content.slice(0, lo);
    message = make(content);
  }
  return { message, realityIds: candidates.map((c) => c.reality.reality_id) };
}


/** ── 4B 拣选（Hermes INJECT_PROMPT_REALITY 移植，决策 41 §2.4b）── */
/**
 * 构建拣选 prompt（对齐 Hermes build_inject_prompt_reality）。
 * @param {string} query 当前轮 user 消息
 * @param {Array} candidates 预筛候选（含 reality 对象）
 * @param {number} topK 最多拣选数（0~topK）
 * @returns {string}
 */
export function buildRealityPickPrompt(query, candidates, topK) {
  const lines = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i].reality ?? candidates[i];
    const cs = c.current_status ?? {};
    const parts = ['[' + i + '] ' + cleanInjectionLine(c.name, 60)];
    if (c.hdl) parts.push('    hdl: ' + cleanInjectionLine(c.hdl, 80));
    if (Array.isArray(cs.goals) && cs.goals.length) {
      parts.push('    goals: ' + cs.goals.slice(0, 3).map((g) => cleanInjectionLine(g, 60)).filter(Boolean).join(' | '));
    }
    if (Array.isArray(cs.current_state) && cs.current_state.length) {
      parts.push('    state: ' + cs.current_state.slice(0, 3).map((st) => cleanInjectionLine(st, 60)).filter(Boolean).join(' | '));
    }
    lines.push(parts.join('\n'));
  }
  return '你是上下文检索器。给定用户的当前提问和候选客观事实（reality）列表，拣选出与提问最相关的 top-' + topK + ' reality 作为注入上下文。\n\n' +
    '【reality 定义】客观事实（reality）；strand 才是工作线。其当前状态由 current_status 描述（goals=进行中的目标 / current_state=现状 / key_facts=持久事实）。\n\n' +
    '【用户提问】\n' + String(query).slice(0, 500) + '\n\n' +
    '【候选 reality】（已按提问云形心散度距离预筛，仅保留距离范围内的）\n' + lines.join('\n\n') + '\n\n' +
    '【拣选规则】\n' +
    '1. 相关性判定：该 reality 的 goals/current_state 是否与提问的工作对象承接/相关？用户问这个提问时，是否需要该 reality 的背景才能有效回答？\n' +
    '2. 宁缺勿错：若没有任何 reality 与提问相关（全新话题），必须输出空列表——空注入是合法且正确的结果，禁止硬选“最不无关”的 reality。\n' +
    '3. 数量：0~' + topK + ' 个，按相关度降序。\n' +
    '4. 只能引用候选列表中的 index，禁止编造列表外的 reality。\n\n' +
    '【输出格式】（严格 JSON，不要 markdown 围栏）\n' +
    '{"selected": [{"index": 0, "relevance": "承接理由（中文，说明与提问的工作关联）", "priority": 1}]}\n' +
    '全新话题 → {"selected": []}';
}

/** 宽松 JSON 解析（剥围栏/提取首个对象） */
export function parseRealityPickResponse(text, n) {
  if (!text || !text.trim()) return { status: 'error', picked: [] };
  let cleaned = text.trim();
  const fenced = cleaned.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/);
  if (fenced) cleaned = fenced[1].trim();
  let obj = null;
  try { obj = JSON.parse(cleaned); } catch {
    // 前导说明文字也可能存在：从首个 '{' 截到最后一个 '}'
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) { try { obj = JSON.parse(cleaned.slice(start, end + 1)); } catch { /* ignore */ } }
  }
  if (!obj || !Array.isArray(obj.selected)) return { status: 'error', picked: [] };
  const seenIdx = new Set();
  const picked = obj.selected.filter((x) => {
    if (!x || !Number.isInteger(x.index) || x.index < 0 || x.index >= n) return false;
    if (seenIdx.has(x.index)) return false; // 重复 index 去重，避免重复 reality section
    seenIdx.add(x.index);
    return true;
  });
  return { status: 'ok', picked };
}

/**
 * 4B 拣选（Ollama /api/generate，X-Queue-Priority: high，options.format=json，think=false）。
 * 返回 {status:'ok', picked:[{index,relevance,priority}]} 或 {status:'error', picked:[]}（调用失败）。
 * 空注入（selected:[]）是合法结果（status:'ok'，picked:[]）。
 */
export async function pickRealities4B(query, candidates, { url, model, topK = 1, timeoutMs = 30000 } = {}) {
  const prompt = buildRealityPickPrompt(query, candidates, topK);
  const body = {
    model,
    prompt,
    stream: false,
    options: { num_predict: 800, temperature: 0.1, format: 'json' },
    keep_alive: -1,
    think: false,
  };
  let resp;
  try {
    resp = await fetch((url || 'http://127.0.0.1:11435').replace(/\/$/, '') + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Queue-Priority': 'high' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'error', picked: [] };
  }
  if (!resp.ok) return { status: 'error', picked: [] };
  let data;
  try { data = await resp.json(); } catch { return { status: 'error', picked: [] }; }
  const parsed = parseRealityPickResponse(data.response ?? '', candidates.length);
  if (parsed.status !== 'ok') return parsed;
  return { status: 'ok', picked: parsed.picked.slice(0, Math.max(1, topK)) };
}
