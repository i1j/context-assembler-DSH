/**
 * DSH 工具轮摘要规则引擎（lib/tool-summarizer.js）——Hermes ca/tool_summarizer.py 的 DSH 移植。
 *
 * 移植意图（docs/CA-V7-设计意图与Hermes对照.md §4）：Hermes 在 E-stage 对每条工具轮生成
 * per-tool Fct/Hdl，A-stage 按 ACT/REL/FAR 降级注入；ca-v7 初版 view.js 对 toolCall/toolResult
 * 的 text 直接置空，等于把 Hermes 已实现的"工具轮压缩"在 DSH 中丢失。本模块恢复该能力：
 *   - tool/call：保留工具名 + 关键参数（过滤命令体/文件体等 bulk 字段）；
 *   - tool/result：按工具名结构化摘要（bash 退出码/stderr/关键行、read 路径+行数+首尾、
 *     edit/write 路径+结果、MCP/OpenViking JSON 关键字段、通用字段优先级）；
 *   - 同时抽取出"实体工作对象"（路径/命令/标识符/URI/错误码），供 7.1 实体定级与
 *     reality 图边扩充使用（当前仅随摘要输出，图边消费方后置）。
 *
 * 确定性、无 LLM；只消费事件日志中已有的 JSON 数据，不发起网络调用。
 */

import { homedir } from 'node:os';

/** 安全 JSON 解析（对象优先） */
export function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || (!t.startsWith('{') && !t.startsWith('['))) return null;
  try {
    const value = JSON.parse(t);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** 在文本中查找标记后的 JSON 对象（marker 之后第一个合法 {...}；失败返回 null） */
function extractJsonAfterMarker(text, marker) {
  const idx = String(text ?? '').indexOf(marker);
  if (idx < 0) return null;
  const start = String(text).indexOf('{', idx + marker.length);
  if (start < 0) return null;
  for (let end = start + 1; end < String(text).length; end += 1) {
    if (String(text)[end] !== '}') continue;
    try {
      return JSON.parse(String(text).slice(start, end + 1));
    } catch {
      // 继续尝试下一个 '}'（嵌套对象/字符串含 } 的情况）
    }
  }
  return null;
}

/** 递归展开 DSH tool/result message 的嵌套 content blocks，拼出文本 */
export function flattenToolResultText(message) {
  const out = [];
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text);
      else if (block.type === 'tool-result') walk(block.content);
    }
  };
  walk(message?.content);
  return out.join('\n');
}

/** 取 tool-result 块（含 isError/callId） */
export function toolResultBlock(message) {
  const first = message?.content?.[0];
  return first?.type === 'tool-result' ? first : null;
}

/** 路径脱敏/截断（Hermes _sanitize_path 对齐） */
export function sanitizePath(path, maxLen = 120) {
  const s = String(path ?? '').replaceAll(homedir(), '~').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** 首尾截断（Hermes _head_tail_truncate 对齐） */
export function headTailTruncate(text, maxLen = 160, headRatio = 0.6) {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  const head = Math.floor(maxLen * headRatio);
  const tail = maxLen - head - 1;
  // tail ≤ 0 时省略号没有落点：slice(-0) 会返回整个字符串（JS 语义），
  // 直接按 maxLen 硬截断，保证返回值长度不超上限。
  if (tail <= 0) return s.slice(0, maxLen);
  return s.slice(0, head) + '…' + s.slice(-tail);
}

/** 清理行：去分隔符/注释/JSON 外壳碎片，去重，截取前 N 条 */
export function keyLines(text, limit = 5, maxLine = 200) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '---' || line === '===' || line === '```') continue;
    if (line.startsWith('{"output') || line.startsWith('{"error') || line.startsWith('[Subdirectory context discovered')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line.length > maxLine ? line.slice(0, maxLine - 1) + '…' : line);
    if (out.length >= limit) break;
  }
  return out;
}

/** DSH 参数是 JSON 字符串；解析失败时返回空对象 */
export function parseToolArguments(argumentsRaw) {
  if (typeof argumentsRaw === 'string') return parseJsonObject(argumentsRaw) ?? {};
  return argumentsRaw && typeof argumentsRaw === 'object' ? argumentsRaw : {};
}

/** 从工具参数提取关键参数摘要（过滤 bulk 字段，Hermes _clean_tool_args 对齐） */
export function summarizeToolCall(callData) {
  const rawName = typeof callData?.name === 'string' ? callData.name.trim() : '';
  const name = rawName || 'unknown_tool';
  const args = parseToolArguments(callData?.arguments);
  const heavy = new Set(['code', 'command', 'old_string', 'new_string', 'content', 'file_content', 'old_text']);
  const keep = { ...args };
  for (const key of heavy) delete keep[key];
  const pick = (keys) => {
    for (const key of keys) {
      if (keep[key] !== undefined && String(keep[key]).trim() !== '') return String(keep[key]);
    }
    return '';
  };
  let text;
  switch (name) {
    case 'bash':
      text = `bash: ${headTailTruncate(String(args.command ?? '').replaceAll('\n', ' \\n '), 120)}`;
      break;
    case 'read':
      text = `read: ${sanitizePath(args.file_path ?? args.path)}`;
      break;
    case 'edit':
    case 'write':
      text = `${name}: ${sanitizePath(args.file_path ?? args.path)}`;
      break;
    case 'glob':
      text = `glob: ${pick(['pattern', 'path'])}`;
      break;
    case 'grep':
      text = `grep: ${pick(['pattern', 'path'])}`;
      break;
    case 'ask_user_question': {
      // 所见即所记（2026-08-18）：完整可读提问列表（question + header + options），
      // 不丢信息——通用规则只取第一个 question 字段，options/header 全丢。
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const lines = [];
      for (const q of questions) {
        if (typeof q !== 'object' || q === null) continue;
        const question = typeof q.question === 'string' ? q.question.trim() : '';
        if (question === '') continue;
        const header = typeof q.header === 'string' && q.header.trim() !== '' ? ` — ${q.header.trim()}` : '';
        lines.push(`${question}${header}`);
        if (Array.isArray(q.options)) {
          for (const opt of q.options) {
            if (typeof opt === 'object' && opt !== null && typeof opt.label === 'string' && opt.label.trim() !== '') {
              lines.push(`- ${opt.label.trim()}`);
            }
          }
        }
      }
      text = lines.length > 0 ? `ask_user_question: ${lines.join('\n  ')}` : name;
      break;
    }
    default:
      if (name.startsWith('mcp__')) {
        text = `${name}: ${pick(['query', 'uri', 'pattern', 'question'])}`;
      } else {
        const key = pick(['query', 'question', 'file_path', 'path', 'pattern', 'uri', 'id']);
        text = key ? `${name}: ${headTailTruncate(key, 100)}` : name;
      }
      break;
  }
  return {
    name,
    args, // 原始解析参数：结果摘要/实体提取需要完整信息
    toolArgs: keep, // 输出用关键参数：已过滤 command/content/old_string/new_string 等 bulk 字段
    text: text || name,
    entities: extractEntitiesFromArgs(args, name),
  };
}

const PATH_RE = /(?:~\/|\.{0,2}\/|\/|[\w@+.,:%#-]+\/)(?:[\w@+.,:%#-]+\/)*[\w@+.,:%#-]+/g;
const IDENT_RE = /@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+|\b(?:[a-z][a-z0-9_]*\.){1,3}[a-z0-9_]+/g;
const URI_RE = /(?:viking|https?|git):\/\/[^\s"'<>]+/g;
const BIN_RE = /\b(?:git|node|pnpm|npm|npx|python3?|pytest|vitest|tsc|grep|find|sed|awk|cat|ls|mkdir|cp|mv|rm|zstd|curl|systemctl)\b/g;

/** 从参数与输出提取显式工作对象（供 7.1 实体定级/图边使用） */
export function extractEntities(args, resultText, toolName = '') {
  const hay = `${JSON.stringify(args ?? {})}\n${String(resultText ?? '')}`;
  const entities = new Set();
  for (const m of String(args?.file_path ?? args?.path ?? '').matchAll(PATH_RE)) entities.add('path:' + sanitizePath(m[0], 160));
  for (const key of ['file_path', 'path', 'pattern', 'command', 'query', 'uri']) {
    if (args?.[key] === undefined) continue;
    for (const m of String(args[key]).matchAll(PATH_RE)) entities.add('path:' + sanitizePath(m[0], 160));
  }
  for (const m of hay.matchAll(URI_RE)) entities.add('uri:' + m[0]);
  for (const m of hay.matchAll(BIN_RE)) entities.add('bin:' + m[0]);
  for (const m of hay.matchAll(IDENT_RE)) entities.add('ident:' + m[0].toLowerCase());
  for (const m of String(resultText ?? '').matchAll(PATH_RE)) entities.add('path:' + sanitizePath(m[0], 160));
  if (toolName) entities.add('tool:' + toolName);
  const err = hay.match(/\[exit code:\s*(-?\d+)\]/);
  if (err) entities.add('exit:' + err[1]);
  return [...entities].filter((s) => s.length <= 180);
}

/**
 * 把文本中缺失的关键事实实体（path/uri/bin）追加为紧凑后缀。
 * 优先级：uri > path > bin——URI（网络/依赖端点）是最高价值关键事实，预算有限时优先保留；
 * path 次之、bin 最低。budget 内按优先级取（先排序再填充，避免抽取顺序挤占 URI）。
 * @param {string} text 基础摘要文本
 * @param {string[]} entities extractEntities 的输出（顺序=抽取顺序）
 * @param {{max?: number, budget?: number}} [opts] max=最多追加条数，budget=后缀总字符预算
 * @returns {string} 追加后文本；无缺失实体时原样返回
 */
function appendMissingEntityFacts(text, entities, opts = {}) {
  const max = opts.max ?? 0;
  const budget = opts.budget ?? 0;
  const base = String(text ?? '');
  if (!Array.isArray(entities) || entities.length === 0) return base;
  const missing = [];
  for (const e of entities) {
    if (typeof e !== 'string' || !/^(path|uri|bin):/.test(e)) continue;
    const value = e.slice(e.indexOf(':') + 1);
    if (base.includes(value) || base.includes(value.replace(/^~\//, ''))) continue;
    missing.push(e);
  }
  if (missing.length === 0) return base;
  const rank = (e) => (e.startsWith('uri:') ? 0 : e.startsWith('path:') ? 1 : 2);
  missing.sort((a, b) => rank(a) - rank(b));
  let suffix = '';
  let count = 0;
  for (const e of missing) {
    if (count >= max) break;
    const candidate = (count === 0 ? ' | ' : ', ') + e;
    if ((suffix + candidate).length > budget) break;
    suffix += candidate;
    count += 1;
  }
  return count > 0 ? base + suffix : base;
}

function extractEntitiesFromArgs(args, toolName) {
  return extractEntities(args, '', toolName);
}

/** bash：退出码 + stderr 错误行 + 关键 stdout 行 */
function summarizeBash(args, text) {
  const cmd = String(args.command ?? '').trim();
  const exitMatch = text.match(/\[exit code:\s*(-?\d+)\]/);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  const stderrIdx = text.indexOf('[stderr]');
  const stdout = stderrIdx >= 0 ? text.slice(0, stderrIdx) : text;
  const stderr = stderrIdx >= 0 ? text.slice(stderrIdx + '[stderr]'.length) : '';
  const lines = keyLines(stdout, 4, 160);
  const errLines = keyLines(stderr, 2, 160);
  const parts = [];
  if (exitCode !== null) parts.push(`exit=${exitCode}`);
  if (lines.length) parts.push(lines.join(' | '));
  if (errLines.length) parts.push(`stderr: ${errLines.join(' | ')}`);
  if (!lines.length && !errLines.length && cmd) parts.push(`(${stdout.split('\n').filter((l) => l.trim()).length} lines)`);
  const body = parts.join(' | ') || '(no output)';
  const entities = extractEntities(args, text, 'bash');
  return {
    text: appendMissingEntityFacts(body.length > 300 ? body.slice(0, 297) + '…' : body, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(headTailTruncate(`bash: ${cmd.replaceAll('\n', ' ').slice(0, 48)} → ${exitCode !== null ? 'exit=' + exitCode : body}`, 120), entities, { max: 2, budget: 80 }),
    error: exitCode !== null && exitCode !== 0 ? `exit_code=${exitCode}` : null,
    exitCode,
  };
}

/** read：路径 + 行数 + 内容首尾（DSH read 输出 <path>/<type>/<content>） */
function summarizeRead(args, text) {
  const path = args.file_path ?? args.path ?? '';
  const typeMatch = text.match(/<type>([\s\S]*?)<\/type>/);
  const contentMatch = text.match(/<content>([\s\S]*?)<\/content>/);
  const content = contentMatch ? contentMatch[1] : text;
  const nonEmpty = content.split('\n').filter((l) => l.trim());
  const preview = headTailTruncate(content.trim(), 180, 0.55);
  const entities = extractEntities(args, text, 'read');
  return {
    text: appendMissingEntityFacts(`read ${sanitizePath(path)} (${nonEmpty.length}行${typeMatch ? ', ' + typeMatch[1].trim() : ''}): ${preview}`, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(headTailTruncate(`read: ${sanitizePath(path)} (${nonEmpty.length}行)`, 120), entities, { max: 2, budget: 80 }),
    error: null,
  };
}

/** edit/write：路径 + 成功/失败 */
function summarizeEditWrite(toolName, args, text, isError) {
  const path = args.file_path ?? args.path ?? '';
  const ok = !isError && /updated successfully|success|written/i.test(text);
  const entities = extractEntities(args, text, toolName);
  return {
    text: appendMissingEntityFacts(`${toolName} ${sanitizePath(path)}: ${ok ? 'ok' : isError ? 'error' : text.slice(0, 80).replaceAll('\n', ' ')}`, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(`${toolName}: ${sanitizePath(path)}`, entities, { max: 2, budget: 80 }),
    error: isError ? text.slice(0, 120) : null,
  };
}

/** glob：结果列表前若干项 */
function summarizeGlob(args, text) {
  const json = parseJsonObject(text);
  let items = [];
  if (Array.isArray(json)) items = json;
  else if (json && Array.isArray(json.matches)) items = json.matches;
  else items = keyLines(text, 8, 120);
  const entities = extractEntities(args, text, 'glob');
  return {
    text: appendMissingEntityFacts(`glob ${String(args.pattern ?? args.path ?? '')}: ${items.length} hits${items.length ? ' (' + items.slice(0, 5).map(String).join(', ') + ')' : ''}`, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(`glob: ${String(args.pattern ?? '').slice(0, 40)} → ${items.length} hits`, entities, { max: 2, budget: 80 }),
    error: null,
  };
}

/** grep：file:line 匹配行摘要 */
function summarizeGrep(args, text) {
  const json = parseJsonObject(text);
  let lines = [];
  if (json && Array.isArray(json.matches)) {
    lines = json.matches.slice(0, 5).map((m) => (typeof m === 'string' ? m : `${m.file ?? m.path ?? ''}:${m.line ?? ''} ${m.text ?? ''}`));
  } else {
    lines = keyLines(text, 5, 160);
  }
  const entities = extractEntities(args, text, 'grep');
  return {
    text: appendMissingEntityFacts(`grep ${String(args.pattern ?? '')}: ${lines.length} shown${lines.length ? ' | ' + lines.join(' | ') : ''}`, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(`grep: ${String(args.pattern ?? '').slice(0, 40)}`, entities, { max: 2, budget: 80 }),
    error: null,
  };
}

/** 从 OV JSON 结果中收集前 N 条 URI/标题（items/results/matches 数组） */
function collectOvUrisFromJson(json, limit = 4) {
  const out = [];
  const push = (item) => {
    if (!item || typeof item !== 'object') return;
    const uri = item.uri ?? item.url ?? item.path;
    const title = item.title ?? item.name ?? '';
    if (typeof uri === 'string' && uri) out.push({ uri, title: typeof title === 'string' ? title : '' });
  };
  for (const key of ['items', 'results', 'matches']) {
    if (Array.isArray(json?.[key])) {
      for (const item of json[key]) {
        push(item);
        if (out.length >= limit) break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** MCP/OpenViking：JSON/文本都提取标题、命中数、URI 列表 */
function summarizeMcp(name, args, text) {
  const json = parseJsonObject(text);
  const entities = extractEntities(args, text, name);
  const isOv = name.startsWith('mcp__openviking__');
  if (json && !Array.isArray(json)) {
    const title = json.title ?? json.name ?? json.hdl ?? '';
    const found = Array.isArray(json.items) || Array.isArray(json.results) || Array.isArray(json.matches)
      ? (json.items ?? json.results ?? json.matches).length
      : null;
    const abstract = typeof json.abstract === 'string' ? json.abstract : '';
    const uris = collectOvUrisFromJson(json, 4);
    const parts = [];
    if (title) parts.push(String(title).slice(0, 80));
    if (found !== null) parts.push(`${found} items`);
    if (abstract) parts.push(headTailTruncate(abstract, 100));
    for (const u of uris) parts.push(`${u.title || ''} ${u.uri}`.trim());
    const body = parts.join(' | ') || headTailTruncate(keyLines(text, 3).join(' | '), 160);
    return {
      text: appendMissingEntityFacts(`${name} ${String(args.query ?? args.uri ?? '').slice(0, 60)}: ${body}`, entities, { max: 4, budget: 280 }),
      hdl: appendMissingEntityFacts(headTailTruncate(`${name.split('__').pop()}: ${title || String(args.query ?? '').slice(0, 40)}`, 120), entities, { max: 2, budget: 80 }),
      error: json.error ? String(json.error).slice(0, 120) : null,
    };
  }
  if (isOv) return summarizeOpenVikingText(name, args, text);
  return {
    text: appendMissingEntityFacts(`${name}: ${headTailTruncate(keyLines(text, 3).join(' | '), 180) || '(no text)'}`, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(`${name}`, entities, { max: 2, budget: 80 }),
    error: jsonErrorFromText(text),
  };
}

/** 通用：字段优先级 vip→p0→p1（Hermes 通用逻辑对齐） */
function summarizeGeneric(name, args, text, isError) {
  const json = parseJsonObject(text);
  const entities = extractEntities(args, text, name);
  if (json && !Array.isArray(json)) {
    if (json.error) {
      return {
        text: appendMissingEntityFacts(`${name}: error ${String(json.error).slice(0, 120)}`, entities, { max: 4, budget: 280 }),
        hdl: appendMissingEntityFacts(`${name}: error`, entities, { max: 2, budget: 80 }),
        error: String(json.error).slice(0, 120),
      };
    }
    for (const key of ['result', 'output', 'summary', 'message', 'conclusion']) {
      if (typeof json[key] === 'string' && json[key].trim()) {
        return {
          text: appendMissingEntityFacts(`${name}: ${headTailTruncate(json[key], 180)}`, entities, { max: 4, budget: 280 }),
          hdl: appendMissingEntityFacts(headTailTruncate(`${name}: ${json[key]}`, 120), entities, { max: 2, budget: 80 }),
          error: null,
        };
      }
    }
    if (typeof json.status === 'string') {
      return {
        text: appendMissingEntityFacts(`${name}: ${json.status}`, entities, { max: 4, budget: 280 }),
        hdl: appendMissingEntityFacts(`${name}: ${json.status}`, entities, { max: 2, budget: 80 }),
        error: null,
      };
    }
    const first = Object.entries(json).slice(0, 3).map(([k, v]) => `${k}=${headTailTruncate(String(v), 60)}`).join(', ');
    return {
      text: appendMissingEntityFacts(`${name}: ${first}`, entities, { max: 4, budget: 280 }),
      hdl: appendMissingEntityFacts(`${name}`, entities, { max: 2, budget: 80 }),
      error: null,
    };
  }
  const body = headTailTruncate(keyLines(text, 3).join(' | '), 180);
  return {
    text: appendMissingEntityFacts(`${name}: ${body || (isError ? 'error' : '(no output)')}`, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(`${name}`, entities, { max: 2, budget: 80 }),
    error: isError ? text.slice(0, 120) : null,
  };
}

/**
 * ask_user_question：用户回答的可读转写（selected 选项 + custom 自定义输入），
 * 非原始 JSON 代码段。result 为 `{"answers":[{id, selected:[label...], custom?}]}`。
 * @param args - 提问参数（含 questions，供标题回显）。
 * @param text - 扁平化后的工具结果文本（JSON 字符串）。
 * @returns {{ text, hdl, error, exitCode }} 摘要与句柄。
 */
function summarizeAskUserQuestion(args, text) {
  let answers = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.answers)) answers = parsed.answers;
  } catch {
    answers = [];
  }
  const parts = [];
  for (const a of answers) {
    if (typeof a !== 'object' || a === null) continue;
    const selected = Array.isArray(a.selected)
      ? a.selected.filter((s) => typeof s === 'string' && s.trim() !== '')
      : [];
    const custom = typeof a.custom === 'string' && a.custom.trim() !== '' ? a.custom.trim() : null;
    const bits = [];
    if (selected.length > 0) bits.push(selected.join(' / '));
    if (custom !== null) bits.push(`自定义: ${custom}`);
    if (bits.length > 0) parts.push(bits.join('；'));
  }
  const summary = parts.length > 0
    ? parts.join('\n')
    : (text.trim() !== '' ? headTailTruncate(text, 160) : '');
  const first = summary.split('\n')[0].slice(0, 48);
  return {
    text: summary,
    hdl: summary !== '' ? `ask_user_question: ${first}` : 'ask_user_question',
    error: null,
    exitCode: null,
  };
}

/** web_search：保留来源标题 + URL + 关键片段（top N） */
function summarizeWebSearch(args, text) {
  const query = String(args.query ?? '').trim();
  const entities = extractEntities(args, text, 'web_search');
  const items = [];
  const re = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*$/gm;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null && items.length < 4) {
    items.push({ title: m[1].trim(), url: m[2].trim() });
  }
  const body = items.length > 0
    ? items.map((x) => `${x.title} | ${x.url}`).join(' | ')
    : headTailTruncate(keyLines(text, 3).join(' | '), 180) || '(no output)';
  return {
    text: appendMissingEntityFacts(`web_search ${query.slice(0, 60)}: ${body}`, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(headTailTruncate(`web_search: ${query.slice(0, 40)} → ${items.length || '?'} sources`, 120), entities, { max: 2, budget: 80 }),
    error: /error|failed/i.test(String(text ?? '')) ? headTailTruncate(text, 120) : null,
  };
}

/** workflow：保留执行标题/agent 数与 Return value 中的关键字符串字段/产物实体 */
function summarizeWorkflow(args, text) {
  const entities = extractEntities(args, text, 'workflow');
  const firstLine = keyLines(text, 1, 160)[0] || '';
  const json = extractJsonAfterMarker(text, 'Return value');
  const parts = [];
  if (firstLine) parts.push(firstLine);
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const values = [];
    for (const key of ['result', 'output', 'summary', 'conclusion', 'status', 'a', 'b']) {
      const v = json[key];
      if (typeof v === 'string' && v.trim()) {
        values.push(`${key}=${headTailTruncate(v, 80)}`);
        if (values.length >= 2) break;
      }
    }
    if (values.length === 0) {
      for (const [k, v] of Object.entries(json).slice(0, 3)) {
        values.push(`${k}=${headTailTruncate(String(v), 60)}`);
      }
    }
    if (values.length > 0) parts.push(values.join(' | '));
  }
  const body = parts.join(' | ') || '(no output)';
  return {
    text: appendMissingEntityFacts(headTailTruncate(body, 300), entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(headTailTruncate(`workflow: ${firstLine || ''}`, 120), entities, { max: 2, budget: 80 }),
    error: /error|failed/i.test(String(text ?? '')) ? headTailTruncate(text, 120) : null,
  };
}

/** OpenViking 非 JSON 文本列表：保留命中数 + top N 的 URI/标题/摘要 */
function summarizeOpenVikingText(name, args, text) {
  const entities = extractEntities(args, text, name);
  const uris = [];
  const uriRe = /(viking|https?|git):\/\/[^\s"'<>]+/g;
  let m;
  while ((m = uriRe.exec(String(text ?? ''))) !== null && uris.length < 5) {
    if (!uris.includes(m[0])) uris.push(m[0]);
  }
  const found = String(text ?? '').match(/Found\s+(\d+)\s+item/);
  const titleLines = keyLines(text, 3, 160);
  const parts = [];
  if (found) parts.push(`${found[1]} items`);
  for (const u of uris) parts.push(u);
  if (!found && titleLines.length > 0) parts.push(...titleLines);
  const body = parts.join(' | ') || '(no text)';
  // hdl 头：优先首个 URI；无 URI 时用命中数；两者皆无才为空（?? 与三元优先级：uris[0] 存在时
  // 不得再求值 found[1]，否则 found 为 null 时崩溃——2026-08-18 测试暴露修复）
  const hdlHead = `${name.split('__').pop()}: ${uris[0] ?? (found ? found[1] + ' items' : '')}`;
  return {
    text: appendMissingEntityFacts(`${name.split('__').pop()}: ${headTailTruncate(body, 300)}`, entities, { max: 4, budget: 280 }),
    hdl: appendMissingEntityFacts(headTailTruncate(hdlHead, 120), entities, { max: 2, budget: 80 }),
    error: jsonErrorFromText(text),
  };
}

/** 从文本中粗略提取错误串（JSON error 字段或 error/failed 行） */
function jsonErrorFromText(text) {
  const json = parseJsonObject(text);
  if (json && !Array.isArray(json) && typeof json.error === 'string' && json.error) return String(json.error).slice(0, 120);
  const line = String(text ?? '').split('\n').find((l) => /error|failed/i.test(l));
  return line ? line.slice(0, 120) : null;
}

/** 高价值事实：当前阶段最不能丢的 URI/错误/退出码/关键路径 */
function buildHighValueFacts(name, entities, error, exitCode) {
  const out = [];
  const add = (f) => {
    if (!f || out.includes(f) || out.length >= 5) return;
    out.push(f);
  };
  for (const e of entities ?? []) {
    if (e.startsWith('uri:') || e.startsWith('exit:') || e.startsWith('ident:')) add(e);
    else if (e.startsWith('path:') && ['read', 'edit', 'write', 'glob', 'grep', 'run_code', 'workflow', 'mcp__openviking__read', 'mcp__openviking__glob', 'mcp__openviking__list'].includes(name)) add(e);
  }
  if (error) add('error:' + String(error).slice(0, 120));
  if (exitCode !== null && exitCode !== undefined) add('exit:' + exitCode);
  return out;
}

/**
 * 对一次 DSH 工具调用生成结构化摘要。
 * @param {object} callData tool/call event data（{name, arguments, turn, step, callId}）
 * @param {object} resultData tool/result event data（{message, ...}）
 * @returns {{ name: string; args: object; resultSummary: string; hdl: string; error: string | null; exitCode: number | null; entities: string[]; highValueFacts: string[]; isError: boolean }}
 */
export function summarizeToolPair(callData, resultData) {
  const call = summarizeToolCall(callData);
  const message = resultData?.message;
  const block = toolResultBlock(message);
  const text = flattenToolResultText(message);
  const isError = block?.isError === true || Boolean(resultData?.error);
  let result;
  switch (call.name) {
    case 'bash':
      result = summarizeBash(call.args, text);
      break;
    case 'read':
      result = summarizeRead(call.args, text);
      break;
    case 'edit':
    case 'write':
      result = summarizeEditWrite(call.name, call.args, text, isError);
      break;
    case 'glob':
      result = summarizeGlob(call.args, text);
      break;
    case 'grep':
      result = summarizeGrep(call.args, text);
      break;
    case 'ask_user_question':
      // 所见即所记（2026-08-18）：用户回答的可读转写（selected 选项 + 自定义输入），
      // 而非原始 JSON 代码段。
      result = summarizeAskUserQuestion(call.args, text);
      break;
    case 'web_search':
      result = summarizeWebSearch(call.args, text);
      break;
    case 'workflow':
      result = summarizeWorkflow(call.args, text);
      break;
    default:
      if (call.name.startsWith('mcp__')) result = summarizeMcp(call.name, call.args, text);
      else result = summarizeGeneric(call.name, call.args, text, isError);
      break;
  }
  const entities = [...new Set([...call.entities, ...extractEntities(call.args, text, call.name)])];
  const highValueFacts = buildHighValueFacts(call.name, entities, result.error, result.exitCode ?? null);
  return {
    name: call.name,
    args: call.args,
    resultSummary: result.text,
    hdl: result.hdl,
    error: result.error,
    exitCode: result.exitCode ?? null,
    isError,
    entities,
    highValueFacts,
  };
}
