#!/usr/bin/env node
/**
 * summarize-history.mjs — DSH 历史会话 CA 摘要（离线）→ 构建 DSH 的 CA 库。
 *
 * 基于 ca-v7 插件（lib/view.js 事务视图 + ooda.js 确定性打标）实现，参考
 * Hermes CA（~/.hermes/profiles/tester/plugins/ca_assembler）reality-strand 做法：
 *   discover → 事件流 → 事务视图（OODA 打标）→ 话题分割（Jaccard）
 *   → strand 摘要（云端 DeepSeek flash）→ reality 归并（embedding + flash）
 *   → 写入 ca_cache/ca_topics.db（schema 对齐 Hermes ca_topics.db）
 *
 * 用法：
 *   node scripts/summarize-history.mjs --stage extract      # 1. 会话→事务视图
 *   node scripts/summarize-history.mjs --stage strand       # 2. 话题分割+strand 摘要（flash）
 *   node scripts/summarize-history.mjs --stage reality      # 3. reality 归并（embedding+flash）
 *   node scripts/summarize-history.mjs --stage all          # 1→2→3
 *   node scripts/summarize-history.mjs --stage report       # 4. 生成 Markdown 报告
 *   --limit N 只处理前 N 个会话；--root PATH 指定会话根；--db PATH 指定库路径
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { applyViewState, initViewState, viewViewState } from '../lib/view.js';
import { initToolTraceState, applyToolTraceState, viewToolTraceState } from '../lib/tool-trace.js';
import { valuableEntities, buildEntityGraph } from '../lib/entity-graph.js';
import { collectThinkRows, parseAssistantMessage } from '../lib/think-collect.js';
import * as thinkL1 from '../lib/think-l1.js';
import { openDb, clearStrandData, upsertSessionMeta, insertTurnRows, insertToolTraceRows, insertLlmCalls,
         insertThinkTraceRows, updateThinkL1Rows,
         upsertEntityNodes, upsertEntityEdges,
         insertReality, insertStrand, mapStrandToReality, countStats } from './ca-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_SESSION_ROOT = process.env.DSH_SESSIONS || path.join(homedir(), '.dsh', 'sessions');
const CACHE_DIR = path.join(ROOT, 'ca_cache');
const DEFAULT_DB = path.join(CACHE_DIR, 'ca_topics.db');
const DATA_JSON = path.join(CACHE_DIR, 'history-sessions.json');
const THINK_CARDS_JSON = path.join(CACHE_DIR, 'think-cards.json');
const STRANDS_JSON = path.join(CACHE_DIR, 'strands.json');
const STRAND_CP = path.join(CACHE_DIR, 'strands.checkpoint.jsonl');
const REALITY_CP = path.join(CACHE_DIR, 'realities.checkpoint.jsonl');
const REFINE_CP = path.join(CACHE_DIR, 'refine.checkpoint.jsonl');
const REALITIES_JSON = path.join(CACHE_DIR, 'realities.json');
const REPORT_MD = path.join(CACHE_DIR, 'CA摘要报告-DSH历史会话.md');

// ════════════════════════════════════════════ CLI ═══════════════════════════
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const STAGE = arg('stage', 'all');
const LIMIT = Number(arg('limit', '0'));
const SESSION_ROOT = arg('root', DEFAULT_SESSION_ROOT);
const DB_PATH = arg('db', DEFAULT_DB);
const WORKERS = Number(arg('workers', '8'));
const REALITY_THRESHOLD = Number(arg('threshold', '0.62'));
const THINK_OUT = arg('think-out', THINK_CARDS_JSON);
const THINK_LIMIT = Number(arg('think-limit', '0'));
const THINK_WORKERS = Number(arg('think-workers', '2'));
const THINK_URL = arg('think-url', thinkL1.THINK_L1_URL);
const THINK_MOCK_OK = args.includes('--think-mock-ok');
const THINK_FLASH = args.includes('--think-flash');
const THINK_KEYS = arg('think-keys', '');

mkdirSync(CACHE_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ════════════════════════════════════════════ LLM ═══════════════════════════
const API_URL = 'https://api.deepseek.com/chat/completions';
const LLM_MODEL = process.env.CA_LLM_MODEL || 'deepseek-v4-flash';
const EMBED_URL = process.env.CA_EMBED_URL || 'http://127.0.0.1:11435/api/embed';
const EMBED_MODEL = process.env.CA_EMBED_MODEL || 'qwen3-embedding:0.6b';

function apiKey() {
  const cred = path.join(process.env.HOME || homedir(), '.dsh', '.credentials.yaml');
  for (const line of readFileSync(cred, 'utf8').split('\n')) {
    const m = line.match(/^DEEPSEEK_API_KEY:\s*(\S+)/);
    if (m) return m[1];
  }
  throw new Error('DEEPSEEK_API_KEY not found in ' + cred);
}

let apiKeyCache = null;
const apiKeyCached = () => (apiKeyCache ??= apiKey());

async function llmJson(system, user, { maxTokens = 4096, temperature = 0.3, retries = 3 } = {}) {
  const body = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens,
    temperature,
  };
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        if (resp.status === 400 && body.response_format) {
          delete body.response_format; // json_object 不支持 → 去掉重试
          i = -1;
          lastErr = new Error('400 ' + txt.slice(0, 200));
          continue;
        }
        lastErr = new Error(resp.status + ' ' + txt.slice(0, 300));
      } else {
        const data = await resp.json();
        let content = data.choices?.[0]?.message?.content ?? '';
        if (!content) throw new Error('empty content');
        const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fenced) content = fenced[1];
        return JSON.parse(content);
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error('llmJson failed: ' + (lastErr?.message ?? 'unknown'));
}

async function embedTexts(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const chunk = texts.slice(i, i + 32);
    let lastErr;
    for (let a = 0; a < 4; a++) {
      try {
        const resp = await fetch(EMBED_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBED_MODEL, input: chunk }),
        });
        if (!resp.ok) throw new Error('embed ' + resp.status);
        const data = await resp.json();
        const embs = Array.isArray(data.embeddings) ? data.embeddings : null;
        // 2xx 空响应/数量不足视为失败：下游按数量对齐，缺 embedding 会静默丢 strand 甚至清空 realities
        if (!embs || embs.length !== chunk.length) {
          throw new Error(`embed 返回 ${embs ? embs.length : 0}/${chunk.length} 条（期望 ${chunk.length}）`);
        }
        out.push(...embs);
        lastErr = null;
        break;
      } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 2000 * (a + 1))); }
    }
    if (lastErr) throw lastErr;
  }
  return out;
}
const sanitize = (t) => (t ?? '')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD') // 孤立高代理
  .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD'); // 孤立低代理

const clipCp = (t, n) => { const arr = [...(t ?? '')]; return arr.length > n ? arr.slice(0, n).join('') + '…[截断]' : (t ?? ''); };

const cosine = (a, b) => {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return na && nb ? dot / (na * nb) : 0;
};

// ════════════════════════════════════════════ Stage 1: 提取 ═══════════════════════════
function discoverSessions() {
  return readdirSync(SESSION_ROOT)
    .filter((d) => statSync(path.join(SESSION_ROOT, d)).isDirectory())
    .map((d) => ({ id: d, file: path.join(SESSION_ROOT, d, 'session.jsonl.zstd') }))
    .filter((s) => existsSync(s.file));
}

function parseEvents(sessionFile) {
  const buf = execFileSync('zstd', ['-dc', sessionFile], { maxBuffer: 512 * 1024 * 1024 });
  const events = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return events;
}

/** assistant/message content 块字符计数（reasoning/text 分开） */
function messageBlockChars(blocks) {
  let reasoning = 0;
  let text = 0;
  const toolCalls = [];
  for (const b of blocks ?? []) {
    if (!b) continue;
    if (b.type === 'reasoning') reasoning += typeof b.text === 'string' ? b.text.length : 0;
    else if (b.type === 'text') text += typeof b.text === 'string' ? b.text.length : 0;
    else if (b.type === 'tool-call') toolCalls.push({ id: b.id, name: b.name ?? '', arguments: b.arguments ?? '{}' });
  }
  return { reasoning, text, toolCalls };
}

/** 用 ca-v7 view + tool-trace 折叠派生事务视图与工具/LLM 痕迹；返回 {meta, txns, tool_rows, llm_calls, think_rows} */
function deriveView(events, fallbackSessionId = '') {
  let state = initViewState();
  let traceState = initToolTraceState();
  const toolNameBySeq = new Map();
  const turnBySeq = new Map();
  const timeBySeq = new Map();
  const llmCalls = [];
  let llmSeq = 0;
  let curTurn = null;
  const meta = {};
  for (const ev of events) {
    if (ev.type === 'session') {
      meta.session_id = ev.id ?? '';
      meta.cwd = ev.cwd ?? '';
      meta.agentPreset = ev.agentPreset ?? '';
      meta.createdAt = ev.createdAt ?? null;
      meta.delegationDepth = ev.delegationDepth ?? 0;
    } else if (ev.type === 'turn/start') {
      curTurn = ev.data?.turn ?? null;
    } else if (ev.type === 'tool/call' && ev.seq !== undefined) {
      toolNameBySeq.set(ev.seq, ev.data?.name ?? '');
    } else if (ev.type === 'assistant/message') {
      // 7.1 P1：离线 llm_calls 从 assistant/message 事件源级提取云端调用元数据
      // （运行时同源信息来自 llm/stream 观测器；离线回放无 purpose/reasoningEffort，置 null）
      const msg = ev.data?.message ?? {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const chars = messageBlockChars(blocks);
      llmSeq += 1;
      llmCalls.push({
        request_seq: llmSeq,
        turn: ev.data?.turn ?? null,
        step: ev.data?.step ?? null,
        seq: ev.seq ?? null,
        provider: msg.source?.provider ?? null,
        model: msg.source?.model ?? null,
        purpose: null,
        reasoning_effort: null,
        messages_count: 0,
        input_chars: 0,
        reasoning_chars: chars.reasoning,
        text_chars: chars.text,
        tool_calls: chars.toolCalls,
        usage: ev.data?.usage ?? null,
        finish_kind: chars.toolCalls.length > 0 ? 'tool-calls' : 'stop',
        duration_ms: null,
        has_replay_state: 0,
        status: 'completed',
      });
    }
    if (ev.seq !== undefined) {
      turnBySeq.set(ev.seq, curTurn);
      timeBySeq.set(ev.seq, ev.time ?? null);
    }
    state = applyViewState(state, ev);
    traceState = applyToolTraceState(traceState, ev);
  }
  const elms = viewViewState(state);
  const byTxn = new Map();
  for (const e of elms) {
    const list = byTxn.get(e.transaction_id) ?? [];
    list.push(e);
    byTxn.set(e.transaction_id, list);
  }
  const txns = [];
  for (const [tid, list] of byTxn) {
    const userElm = list.find((e) => e.type === 'user');
    const finElm = [...list].reverse().find((e) => e.type === 'fin' && e.text);
    const thoughtElm = [...list].reverse().find((e) => e.type === 'thought' && e.text);
    const toolNames = [];
    for (const e of list) {
      if (e.type === 'toolCall') {
        const n = toolNameBySeq.get(e.elm_ref);
        if (n && !toolNames.includes(n)) toolNames.push(n);
      }
    }
    const firstSeq = list[0]?.elm_ref;
    txns.push({
      txn_id: tid,
      turn: turnBySeq.get(firstSeq) ?? null,
      start_seq: firstSeq,
      start_time: timeBySeq.get(firstSeq) ?? null,
      user_text: userElm?.text ?? '',
      fin_text: finElm?.text ?? thoughtElm?.text ?? '',
      tool_names: toolNames,
    });
  }
  // 7.1 P1：工具痕迹（投影已算 duration_ms；旧数据/缺时间时用事件时间兜底）
  const toolRows = viewToolTraceState(traceState).map((row) => {
    const start = row.callSeq !== null ? timeBySeq.get(row.callSeq) : null;
    const end = row.resultSeq !== null ? timeBySeq.get(row.resultSeq) : null;
    const manual = typeof start === 'number' && typeof end === 'number' ? Math.max(0, end - start) : null;
    return {
      ...row,
      duration_ms: row.durationMs ?? manual,
    };
  });
  // 7.2 K0：离线回放时把 assistant/message reasoning 按确定性规则提炼成 think_rows
  const thinkRows = collectThinkRows(events, elms, toolRows, meta.session_id || fallbackSessionId);
  return { meta, txns, tool_rows: toolRows, llm_calls: llmCalls, think_rows: thinkRows };
}

function extractStage() {
  log('extract: 扫描会话…');
  const sessions = discoverSessions();
  const out = [];
  let nTxn = 0;
  for (let i = 0; i < sessions.length; i++) {
    if (LIMIT > 0 && i >= LIMIT) break;
    const s = sessions[i];
    let events;
    try { events = parseEvents(s.file); } catch (e) { log('  skip', s.id, e.message); continue; }
    const { meta, txns, tool_rows, llm_calls, think_rows } = deriveView(events, s.id);
    if (!txns.length) continue;
    meta.session_id = meta.session_id || s.id;
    out.push({ meta, txns, tool_rows, llm_calls, think_rows });
    nTxn += txns.length;
    if ((i + 1) % 100 === 0) log('  parsed', i + 1);
  }
  writeFileSync(DATA_JSON, JSON.stringify(out, null, 1));
  log('extract 完成:', out.length, '会话,', nTxn, '事务 →', DATA_JSON);
}

// ════════════════════════════════════════════ Stage 2.5: think L1 ═══════════════════════════
/** 读 DATA_JSON 缓存里的 think_rows preview（仅报告/JSON 展示，不落库） */
function readThinkPreviewByKey() {
  const previewByKey = new Map();
  if (existsSync(DATA_JSON)) {
    try {
      for (const sess of JSON.parse(readFileSync(DATA_JSON, 'utf8'))) {
        const sid = sess.meta?.session_id ?? '';
        for (const tr of sess.think_rows ?? []) {
          if (tr.seq !== undefined && tr.seq !== null && tr.preview != null) {
            previewByKey.set(sid + ':' + tr.seq, tr.preview);
          }
        }
      }
    } catch { /* DATA_JSON 损坏时预览降级为空串 */ }
  }
  return previewByKey;
}

/** 一个会话解析一次 session.jsonl.zstd，返回 seq → reasoningText；失败抛给调用方 */
function sessionReasoningMap(sid) {
  const map = new Map();
  const file = path.join(SESSION_ROOT, sid, 'session.jsonl.zstd');
  for (const ev of parseEvents(file)) {
    if (!ev || ev.type !== 'assistant/message') continue;
    if (ev.seq === undefined || ev.seq === null) continue;
    map.set(ev.seq, parseAssistantMessage(ev.data?.message ?? {}).reasoningText);
  }
  return map;
}

/** 工具摘要 join（DB snake_case → buildThinkL1Input 入参 camelCase 显式映射） */
export function toolRowsForThinkCard(db, card) {
  const turnSql = 'SELECT name,args_summary,result_summary,hdl,error,exit_code,is_error FROM tool_trace WHERE session_id=? AND turn=? ORDER BY call_seq LIMIT ' + thinkL1.THINK_L1_MAX_TOOLS;
  const callSql = 'SELECT name,args_summary,result_summary,hdl,error,exit_code,is_error FROM tool_trace WHERE session_id=? AND call_id=? ORDER BY call_seq LIMIT ' + thinkL1.THINK_L1_MAX_TOOLS;
  let rows = [];
  if (card.turn !== null && card.turn !== undefined) {
    rows = db.prepare(turnSql).all(card.session_id, card.turn);
  }
  if (rows.length === 0 && card.call_id) {
    rows = db.prepare(callSql).all(card.session_id, card.call_id);
  }
  return rows.map((r) => ({
    name: r.name,
    argsSummary: r.args_summary,
    resultSummary: r.result_summary,
    hdl: r.hdl,
    error: r.error,
    exitCode: r.exit_code,
  }));
}

/** 7.2 K1：think_trace L1 提炼（每卡 1 次本地 4B 调用，失败不重试、fail-open） */
async function thinkStage() {
  if (THINK_KEYS && !existsSync(THINK_KEYS)) {
    console.error('think-keys 文件不存在: ' + THINK_KEYS);
    process.exit(1);
  }
  const db = openDb(DB_PATH);
  const rawRows = db.prepare("SELECT * FROM think_trace WHERE status='raw' ORDER BY session_id, seq").all();
  let cards;
  if (THINK_KEYS) {
    const keysText = readFileSync(THINK_KEYS, 'utf8');
    const parsed = thinkL1.parseThinkKeysFile(keysText);
    cards = thinkL1.selectThinkCardsByKeys(rawRows, parsed.keys, THINK_LIMIT);
    log('think: keys 清单=' + parsed.keys.length + ' 命中=' + cards.length + ' 跳过=' + JSON.stringify(parsed.skipped));
  } else {
    cards = thinkL1.selectUniqueThinkCards(rawRows);
    if (THINK_LIMIT > 0) cards = cards.slice(0, THINK_LIMIT);
  }
  const reasoningBySession = new Map();
  if (!THINK_MOCK_OK) {
    for (const sid of [...new Set(cards.map((c) => c.session_id))]) {
      try {
        reasoningBySession.set(sid, sessionReasoningMap(sid));
      } catch {
        reasoningBySession.set(sid, null);
      }
    }
  }
  const flashTokens = { input: 0, output: 0 };
  const errorsByKey = new Map();
  const okUpdates = [];
  const lastRun = { processed: 0, ok: 0, failed: 0, processed_keys: [], ok_keys: [] };
  const keyOf = (c) => c.session_id + ':' + c.seq;

  const processCard = async (card) => {
    const key = keyOf(card);
    lastRun.processed += 1;
    lastRun.processed_keys.push(key);
    try {
      let parsed = null;
      if (THINK_MOCK_OK) {
        parsed = thinkL1.parseThinkL1(thinkL1.MOCK_THINK_L1_TEXT);
      } else {
        const sessionMap = reasoningBySession.get(card.session_id);
        const evidence = thinkL1.resolveThinkReasoning(sessionMap, { sessionId: card.session_id, seq: card.seq });
        if (evidence.status !== 'ok') {
          errorsByKey.set(key, { kind: evidence.error.kind, message: evidence.error.message });
        } else {
          const toolRows = toolRowsForThinkCard(db, card);
          const row = { questionText: card.question_text, reasoningText: evidence.reasoningText, toolRows };
          const once = THINK_FLASH
            ? await thinkL1.thinkL1OnceFlash(row, { url: thinkL1.THINK_L1_FLASH_URL, model: LLM_MODEL, apiKey: apiKeyCached() })
            : await thinkL1.thinkL1Once(row, { url: THINK_URL });
          if (once.status === 'ok' && THINK_FLASH) {
            flashTokens.input += once.usage.inputTokens;
            flashTokens.output += once.usage.outputTokens;
          }
          if (once.status !== 'ok') {
            errorsByKey.set(key, { kind: once.error.kind, message: once.error.message });
          } else {
            parsed = thinkL1.parseThinkL1(once.text);
            if (parsed.status !== 'ok') {
              errorsByKey.set(key, { kind: parsed.error.kind, message: parsed.error.message });
            }
          }
        }
      }
      if (parsed?.status === 'ok') {
        okUpdates.push({
          session_id: card.session_id,
          seq: card.seq,
          l0_abstract: parsed.l0Abstract,
          l1_json: JSON.stringify(parsed.l1Json),
          status: 'l1',
        });
        lastRun.ok += 1;
        lastRun.ok_keys.push(key);
      } else {
        lastRun.failed += 1;
      }
    } catch (e) {
      errorsByKey.set(key, { kind: 'parse', message: 'unexpected: ' + (e?.message ?? String(e)) });
      lastRun.failed += 1;
    }
  };

  const queue = cards.slice();
  const workers = Math.min(THINK_WORKERS, queue.length);
  const worker = async () => {
    while (queue.length) {
      const card = queue.shift();
      await processCard(card);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));

  if (THINK_FLASH) log('think flash tokens: input=' + flashTokens.input + ' output=' + flashTokens.output);
  updateThinkL1Rows(db, okUpdates);
  const allRows = db.prepare('SELECT * FROM think_trace ORDER BY session_id, seq').all();
  const previewByKey = readThinkPreviewByKey();
  const outCards = allRows.map((r) => {
    let l1Json = null;
    if (typeof r.l1_json === 'string' && r.l1_json.length > 0) {
      try { l1Json = JSON.parse(r.l1_json); } catch { l1Json = r.l1_json; }
    }
    return {
      session_id: r.session_id,
      seq: r.seq,
      turn: r.turn,
      card_kind: r.card_kind,
      tool_name: r.tool_name,
      question_text: r.question_text,
      l0_abstract: r.l0_abstract,
      l1_json: l1Json,
      status: r.status,
      preview: previewByKey.get(r.session_id + ':' + r.seq) ?? '',
      raw_len: r.raw_len,
      error: errorsByKey.get(r.session_id + ':' + r.seq) ?? null,
    };
  });
  writeFileSync(THINK_OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    last_run: lastRun,
    cards: outCards,
  }, null, 1));
  log('think: processed=' + lastRun.processed + ' ok=' + lastRun.ok + ' failed=' + lastRun.failed);
  db.close();
}

// ════════════════════════════════════════════ Stage 2: 话题分割 + strand ═══════════════════════════
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/g;
const WORD_RE = /[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+/g;
const FORCED_SPLIT = ['换话题','聊点别的','另一个','说回','下一个问题','还有一个问题','再问一个','别提','不管','换个话题','不说这个','回到正题','说重点','topic switch','switching gears','shift topics','moving on','change of subject'];

function jaccard(a, b) {
  const mk = (t) => {
    const s = new Set();
    for (const m of (t.match(CJK_RE) ?? [])) s.add('c:' + m);
    const chars = t.match(CJK_RE) ?? [];
    for (let i = 0; i < chars.length - 1; i++) s.add('b:' + chars[i] + chars[i + 1]);
    for (const m of (t.toLowerCase().match(WORD_RE) ?? [])) s.add('w:' + m);
    return s;
  };
  const sa = mk(a), sb = mk(b);
  if (!sa.size && !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

function isConfirmatory(text) {
  const t = (text ?? '').trim().toLowerCase();
  return !t || t.length <= 5;
}

/** 话题分割（Hermes TopicGradeManager 移植：强制短语/确认轮/Jaccard ENTRY 0.04 CHAIN 0.08） */
function chunkTopics(session) {
  const txns = session.txns;
  const topics = [];
  let cur = null;
  let profile = '';
  let topicSeq = 0;
  for (const t of txns) {
    const text = (t.user_text || '').slice(0, 1200) + ' ' + (t.fin_text || '').slice(0, 1200);
    const lowUser = (t.user_text || '').toLowerCase();
    let newTopic = false;
    if (!cur) {
      newTopic = true;
    } else if (FORCED_SPLIT.some((p) => lowUser.includes(p))) {
      newTopic = true;
    } else if (!isConfirmatory(t.user_text)) {
      const j = jaccard(text, profile);
      if (j < 0.04) newTopic = true;
      else profile = (profile + ' ' + text).slice(-12000); // 滚动窗口：单话题长会话 Jaccard 有界（防 O(n²)）
    } else {
      profile = (profile + ' ' + text).slice(-12000);
    }
    if (newTopic) {
      topicSeq += 1;
      cur = { topic_id: topicSeq, turns: [], txns: [] };
      topics.push(cur);
      profile = text;
    }
    cur.turns.push(t.turn ?? t.txn_id);
    cur.txns.push(t);
  }
  return topics;
}

const STRAND_SYSTEM = `你是一个研发对话分析器。给定一个话题块内的多轮对话（DSH 历史会话事务），产出结构化 CA 摘要。
输出严格 JSON（不要任何多余文字）：
{
  "hdl": "话题一句话名称（≤24 字，概括该话题块内容）",
  "ooda": {"现象与问题": ["..."], "背景与约束": ["..."], "决策与方案": ["..."], "后续行动": ["..."]},
  "changes": ["核心变更/决策/事实，扁平列表，每条一句话"],
  "key_facts": ["关键事实（含量化结果、已实施事项、文件名等）"],
  "status": "completed"
}
要求：仅提取该话题块首次出现的新信息；四个 ooda 节必须全部出现（无内容则空数组）；status 恒为 "completed"（除非话题块仅寒暄/确认无实质内容，则 "skip" 且其余字段从简）。`;

function buildTopicInput(topic) {
  const parts = [];
  for (const t of topic.txns) {
    const u = sanitize(clipCp(t.user_text, 600));
    const f = sanitize(clipCp(t.fin_text, 900));
    const tools = sanitize((t.tool_names || []).slice(0, 12).join(','));
    let block = '【轮 ' + (t.turn ?? t.txn_id) + '】用户: ' + u;
    if (tools) block += '\n工具: ' + tools;
    if (f) block += '\n助手结论: ' + f;
    parts.push(block);
  }
  return '话题块 #' + topic.topic_id + ' 对话记录（' + topic.turns.length + ' 轮）：\n\n' + parts.join('\n\n');
}

async function summarizeStrand(topic, sessionId, createdTs) {
  const input = buildTopicInput(topic);
  const substantive = input.replace(/【[^】]*】/g, '').trim().length;
  if (substantive < 60) {
    return { session_id: sessionId, topic_id: topic.topic_id, hdl: 'skip: 无新内容',
             turns: topic.turns, ooda: {}, changes: [], key_facts: [], status: 'skip', created_at: createdTs };
  }
  let user = input;
  if (input.length > 38000) {
    const sub = [];
    let buf = '';
    for (const t of topic.txns) {
      const b = buildTopicInput({ topic_id: topic.topic_id, turns: topic.turns, txns: [t] });
      if ((buf + b).length > 20000 && buf) { sub.push(buf); buf = b; } else buf += (buf ? '\n' : '') + b;
    }
    if (buf) sub.push(buf);
    const partials = [];
    for (const s of sub) {
      const p = await llmJson(STRAND_SYSTEM, '【部分对话记录】\n' + s, { maxTokens: 3000 });
      partials.push(p);
    }
    user = '【子块摘要】\n' + partials.map((p, i) => '子块' + (i + 1) + ': ' + JSON.stringify(p)).join('\n') +
           '\n\n【要求】综合以上子块摘要，产出该话题块的完整 strand 摘要（hdl/ooda/changes/key_facts）。';
  }
  const res = await llmJson(STRAND_SYSTEM, user, { maxTokens: 4096 });
  return {
    session_id: sessionId, topic_id: topic.topic_id, hdl: res.hdl ?? '',
    turns: topic.turns, ooda: res.ooda ?? {}, changes: res.changes ?? [],
    key_facts: res.key_facts ?? [], status: res.status === 'skip' ? 'skip' : 'completed',
    created_at: createdTs,
  };
}

async function strandStage() {
  const sessions = JSON.parse(readFileSync(DATA_JSON, 'utf8'));
  const db = openDb(DB_PATH);
  const tasks = [];
  const turnRows = [];
  const toolRows = [];
  const llmCallRows = [];
  const thinkRows = [];
  const topicCountBySession = {};
  for (const sess of sessions) {
    const sid = sess.meta.session_id;
    const topics = chunkTopics(sess);
    topicCountBySession[sid] = topics.length;
    for (const topic of topics) tasks.push({ session: sess, topic });
    // 7.2 K0：turn → topic_id 映射，回填 think_rows 的 topic_id
    const turnTopic = new Map();
    for (const topic of topics) {
      for (const t of topic.txns) {
        if (t.turn != null) turnTopic.set(t.turn, topic.topic_id);
      }
    }
    for (const tr of sess.think_rows ?? []) {
      thinkRows.push({
        session_id: sid,
        turn: tr.turn ?? null,
        step: tr.step ?? null,
        seq: tr.seq ?? null,
        txn_id: tr.txnId ?? null,
        topic_id: tr.turn != null ? (turnTopic.get(tr.turn) ?? null) : null,
        source_kind: tr.sourceKind ?? 'cloud_think',
        card_kind: tr.cardKind ?? null,
        call_id: tr.callId ?? null,
        tool_name: tr.toolName ?? null,
        question_text: tr.questionText ?? '',
        l0_abstract: tr.l0Abstract ?? null,
        l1_json: tr.l1Json ?? null,
        entities_json: tr.entitiesJson ?? null,
        embedding_json: tr.embeddingJson ?? null,
        raw_len: tr.rawLen ?? 0,
        status: tr.status ?? 'raw',
      });
    }
    let seqBase = 1;
    const ts = (sess.txns[0]?.start_time ?? Date.now()) / 1000;
    // 7.1 P1：tool_trace 行按 turn 归组（旧缓存无 tool_rows 时回退 tool_names 摘要行）
    const traceByTurn = new Map();
    for (const tr of sess.tool_rows ?? []) {
      const turnNo = tr.turn ?? null;
      if (turnNo === null) continue;
      const list = traceByTurn.get(turnNo) ?? [];
      list.push(tr);
      traceByTurn.set(turnNo, list);
    }
    const emitted = new Set();
    for (const t of sess.txns) {
      const turnNo = t.turn ?? t.txn_id;
      turnRows.push({ session_id: sid, turn: turnNo, seq: seqBase++, role: 'user', Elm: 'user', written_at: ts });
      const traces = traceByTurn.get(turnNo) ?? [];
      if (traces.length > 0) {
        for (const tr of traces) {
          // 视图行是 camelCase（callId/argsJson/argsSummary/durationMs）；兼容旧缓存 snake_case
          const callId = tr.callId ?? tr.call_id;
          if (emitted.has(callId)) continue;
          emitted.add(callId);
          turnRows.push({
            session_id: sid, turn: turnNo, seq: seqBase++, role: 'tool', Elm: 'toolCall',
            tool_name: tr.name, args_json: tr.argsJson ?? tr.args_json ?? null, status: tr.status ?? 'called',
            duration_ms: tr.durationMs ?? tr.duration_ms ?? null, biz_category: null,
            Fct: tr.argsSummary ?? tr.args_summary ?? '', Hdl: tr.hdl ?? '', written_at: ts,
          });
        }
      } else {
        for (const n of t.tool_names) {
          turnRows.push({ session_id: sid, turn: turnNo, seq: seqBase++, role: 'tool', Elm: 'toolCall', tool_name: n, status: 'completed', written_at: ts });
        }
      }
      if (t.fin_text) {
        turnRows.push({ session_id: sid, turn: turnNo, seq: seqBase++, role: 'assistant', Elm: 'fin', finish_reason: 'stop', written_at: ts });
      }
    }
    for (const tr of sess.tool_rows ?? []) {
      toolRows.push({
        session_id: sid,
        call_id: tr.callId ?? tr.call_id,
        turn: tr.turn ?? null,
        step: tr.step ?? null,
        call_seq: tr.callSeq ?? tr.call_seq ?? null,
        result_seq: tr.resultSeq ?? tr.result_seq ?? null,
        name: tr.name ?? 'unknown_tool',
        description: tr.description ?? '',
        args_json: tr.argsJson ?? tr.args_json ?? null,
        args_summary: tr.argsSummary ?? tr.args_summary ?? '',
        result_summary: tr.resultSummary ?? tr.result_summary ?? '',
        hdl: tr.hdl ?? '',
        error: tr.error ?? null,
        exit_code: tr.exitCode ?? tr.exit_code ?? null,
        is_error: tr.isError ?? tr.is_error ?? false,
        result_chars: tr.resultChars ?? tr.result_chars ?? 0,
        entities: tr.entities ?? [],
        status: tr.status ?? 'called',
        duration_ms: tr.durationMs ?? tr.duration_ms ?? null,
      });
    }
    for (const c of sess.llm_calls ?? []) llmCallRows.push({ session_id: sid, ...c });
  }
  clearStrandData(db);
  insertThinkTraceRows(db, thinkRows);
  insertTurnRows(db, turnRows);
  insertToolTraceRows(db, toolRows);
  insertLlmCalls(db, llmCallRows);
  // 7.1 P3b：会话实体图全局边（path child_of / 同事务 cooccurs_with）落库
  {
    const txnEntities = new Map();
    const keyById = new Map();
    let nextId = 1;
    for (const tr of toolRows) {
      const groupKey = tr.session_id + ':' + (tr.turn ?? '?');
      let id = keyById.get(groupKey);
      if (id === undefined) {
        id = nextId++;
        keyById.set(groupKey, id);
      }
      const ents = valuableEntities(tr.entities);
      if (ents.length === 0) continue;
      const list = txnEntities.get(id) ?? [];
      for (const e of ents) if (!list.includes(e)) list.push(e);
      txnEntities.set(id, list);
    }
    const g = buildEntityGraph(txnEntities);
    upsertEntityNodes(db, [...g.nodes]);
    upsertEntityEdges(db, g.edges.map((e) => ({
      from_key: e.from, to_key: e.to, kind: e.kind, anchor: 'global', weight: e.weight, source: 'tool_trace',
    })));
  }
  // session/turn → path 实体（供 strand→touches_path 边）
  const pathByGroup = new Map();
  for (const tr of toolRows) {
    const groupKey = tr.session_id + ':' + (tr.turn ?? '?');
    const list = pathByGroup.get(groupKey) ?? [];
    for (const e of tr.entities ?? []) {
      if (typeof e === 'string' && e.startsWith('path:') && !list.includes(e)) list.push(e);
    }
    pathByGroup.set(groupKey, list);
  }
  for (const sess of sessions) {
    const m = sess.meta;
    upsertSessionMeta(db, {
      session_id: m.session_id, profile: m.agentPreset || 'dsh',
      last_turn: sess.txns.length, last_topic_id: topicCountBySession[m.session_id] ?? 0,
      created_at: m.createdAt ? m.createdAt / 1000 : null, updated_at: Date.now() / 1000,
    });
  }
  log('strand: 话题块数 =', tasks.length, '（turn_stream', turnRows.length, '行 / tool_trace',
      toolRows.length, '行 / llm_calls', llmCallRows.length, '行 / think_trace', thinkRows.length, '行已入库）');
  const cpDone = new Map();
  if (existsSync(STRAND_CP)) {
    for (const line of readFileSync(STRAND_CP, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); cpDone.set(o.session_id + ':' + o.topic_id, o); } catch { /* ignore */ }
    }
    log('  checkpoint 已存在:', cpDone.size, '条，跳过');
  }
  const strands = [...cpDone.values()];
  let done = 0;
  const queue = tasks.filter((task) => !cpDone.has(task.session.meta.session_id + ':' + task.topic.topic_id));
  let cpFd = null;
  const appendCp = (o) => {
    if (cpFd === null) cpFd = openSync(STRAND_CP, 'a');
    writeSync(cpFd, JSON.stringify(o) + '\n');
  };
  const worker = async () => {
    while (queue.length) {
      const task = queue.shift();
      const sid = task.session.meta.session_id;
      const ts = (task.topic.txns[0]?.start_time ?? Date.now()) / 1000;
      try {
        const s = await summarizeStrand(task.topic, sid, ts);
        strands.push(s);
        appendCp(s);
        done++;
        if (done % 25 === 0) log('  strands done:', done, '(+cp)');
      } catch (e) {
        log('  strand 失败', sid, 'topic', task.topic.topic_id, e.message);
        const er = { session_id: sid, topic_id: task.topic.topic_id, hdl: 'ERROR: ' + e.message.slice(0, 80),
                     turns: task.topic.turns, ooda: {}, changes: [], key_facts: [], status: 'error', created_at: ts };
        strands.push(er);
        appendCp(er);
        done++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, Math.max(queue.length, 1)) }, worker));
  if (cpFd !== null) closeSync(cpFd);
  writeFileSync(STRANDS_JSON, JSON.stringify(strands, null, 1));
  const sid2profile = Object.fromEntries(sessions.map((s) => [s.meta.session_id, s.meta.agentPreset || 'dsh']));
  const strandIdByKey = new Map();
  for (const s of strands) {
    const strandId = insertStrand(db, {
      session_id: s.session_id,
      topic_id: s.topic_id,
      profile: sid2profile[s.session_id] ?? 'dsh',
      hdl: s.hdl ?? '',
      turns: s.turns ?? [],
      ooda: s.ooda ?? {},
      changes: s.changes ?? [],
      key_facts: s.key_facts ?? [],
      status: s.status ?? 'completed',
      created_at: s.created_at ?? Date.now() / 1000,
    });
    strandIdByKey.set(s.session_id + ':' + s.topic_id, { strandId, sid: s.session_id, topicId: Number(s.topic_id) });
  }
  // 7.1 P3b：strand→touches_path 边（strand 节点 + path 边）
  {
    const nodes = [];
    const edges = [];
    for (const [key, info] of strandIdByKey) {
      const { strandId, sid, topicId } = info;
      nodes.push('strand:' + strandId);
      const turns = strands.find((s) => s.session_id === sid && s.topic_id === topicId)?.turns ?? [];
      const pathSet = new Set();
      for (const t of turns) {
        for (const p of pathByGroup.get(sid + ':' + t) ?? []) pathSet.add(p);
      }
      for (const p of pathSet) {
        edges.push({ from_key: 'strand:' + strandId, to_key: p, kind: 'touches_path', anchor: 'strand:' + strandId, weight: 1, strand_id: strandId, source: 'tool_trace' });
      }
    }
    upsertEntityNodes(db, nodes);
    upsertEntityEdges(db, edges);
  }
  log('strand 完成:', strands.length, '条入库 →', DB_PATH);
  db.close();
}

// ════════════════════════════════════════════ Stage 3: reality ═══════════════════════════
const REALITY_SYSTEM = `你是研发工作线归纳器。给定一组相关 strand（话题摘要，可能跨会话），归纳为一条 reality（工作线）。
输出严格 JSON：
{
  "name": "工作线名称（≤16 字）",
  "hdl": "工作线当前状态一句话描述",
  "current_status": {
    "current_state": ["当前状态要点"],
    "key_facts": ["关键事实"],
    "goals": ["未完成目标/后续方向"],
    "context": ["相关上下文（文件/路径/项目）"]
  }
}`;

async function realityStage() {
  const strands = JSON.parse(readFileSync(STRANDS_JSON, 'utf8')).filter((s) => s.status === 'completed');
  if (!strands.length) { log('reality: 无 completed strand'); return; }
  log('reality: 对', strands.length, '条 strand 做 embedding 聚类（阈值', REALITY_THRESHOLD, ')');
  const texts = strands.map((s) => [s.hdl, ...Object.values(s.ooda ?? {}).flat(), ...(s.changes ?? [])].filter(Boolean).join(' '));
  let embs;
  try { embs = await embedTexts(texts); }
  catch (e) { log('reality: embedding 失败（将重试）：', e.message); await new Promise((r) => setTimeout(r, 10000)); embs = await embedTexts(texts); }
  if (!Array.isArray(embs) || embs.length !== strands.length) {
    throw new Error(`reality: embedding 数量 ${Array.isArray(embs) ? embs.length : 0}/${strands.length} 不一致，终止（防止清空 realities 库）`);
  }
  const clusters = [];
  for (let i = 0; i < strands.length; i++) {
    const e = embs[i];
    if (!e) continue;
    let best = -1, bestSim = -1;
    for (let c = 0; c < clusters.length; c++) {
      const sim = cosine(e, clusters[c].centroid);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best >= 0 && bestSim >= REALITY_THRESHOLD) {
      const c = clusters[best];
      c.strands.push(i);
      const n = c.strands.length;
      c.centroid = c.centroid.map((x, k) => x + (e[k] - x) / n);
    } else {
      clusters.push({ strands: [i], centroid: e.slice() });
    }
  }
  log('reality: 聚类得到', clusters.length, '条工作线');
  const realities = new Array(clusters.length);
  const cpDone = new Set();
  // checkpoint 恢复校验：ci 必须在界内且成员签名与本次聚类一致（输入变化后拒绝错配旧结果）
  const clusterSig = (c) => c.strands.map((i) => strands[i].session_id + ':' + strands[i].topic_id).sort().join('|');
  if (existsSync(REALITY_CP)) {
    for (const line of readFileSync(REALITY_CP, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && Number.isInteger(o.ci) && o.ci >= 0 && o.ci < clusters.length && o.sig === clusterSig(clusters[o.ci])) {
          realities[o.ci] = o;
          cpDone.add(o.ci);
        }
      } catch { /* ignore */ }
    }
    log('  reality checkpoint:', cpDone.size, '条已存在，跳过');
  }
  let cpFd = null;
  const appendCp = (o) => {
    if (cpFd === null) cpFd = openSync(REALITY_CP, 'a');
    writeSync(cpFd, JSON.stringify(o) + '\n');
  };
  let cidx = 0;
  const worker = async () => {
    while (true) {
      const ci = cidx++;
      if (ci >= clusters.length) return;
      if (cpDone.has(ci)) continue;
      const c = clusters[ci];
      const members = c.strands.map((i) => strands[i]);
      const input = members.map((s, k) =>
        '【strand ' + (k + 1) + '】会话=' + s.session_id + ' 话题#' + s.topic_id + ' hdl=' + (s.hdl ?? '') +
        '\nooda=' + sanitize(JSON.stringify(s.ooda ?? {})) +
        '\nchanges=' + sanitize(JSON.stringify(s.changes ?? [])) +
        '\nkey_facts=' + sanitize(JSON.stringify(s.key_facts ?? []))
      ).join('\n\n');
      let synth = {};
      try {
        synth = await llmJson(REALITY_SYSTEM, '以下 strand 属于同一条工作线：\n\n' + input.slice(0, 30000), { maxTokens: 3000 });
      } catch (e) {
        log('  reality 综合失败 #' + (ci + 1), e.message);
        synth = { name: members[0]?.hdl ?? '未命名工作线', hdl: '', current_status: {} };
      }
      const timeline = members.map((s) => ({
        topic_id: s.topic_id, turns: s.turns ?? [], session_id: s.session_id,
        overview: '', ts: s.created_at ?? null, seq: 0, changes: s.changes ?? [],
      }));
      const source = {};
      for (const s of members) { (source[s.session_id] ??= []).push(s.topic_id); }
      realities[ci] = {
        ci,
        name: synth.name ?? members[0]?.hdl ?? '',
        hdl: synth.hdl ?? '',
        current_status: synth.current_status ?? {},
        timeline, source_strands: source,
        centroid: c.centroid, profile: 'dsh',
        topic_count: members.length, created_at: Date.now() / 1000, updated_at: Date.now() / 1000,
      };
      appendCp({ ...realities[ci], sig: clusterSig(c) });
      if ((ci + 1) % 25 === 0) log('  realities done:', cpDone.size + ci + 1 - cpDone.size, '/', clusters.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, clusters.length) }, worker));
  writeFileSync(REALITIES_JSON, JSON.stringify(realities, null, 1));
  const db = openDb(DB_PATH);
  db.exec('DELETE FROM realities; DELETE FROM strand_to_reality;');
  const strandIdByKey = new Map();
  for (const row of db.prepare('SELECT strand_id, session_id, topic_id FROM strand_summaries').all()) {
    strandIdByKey.set(row.session_id + ':' + row.topic_id, row.strand_id);
  }
  for (const r of realities) {
    if (!r) continue; // checkpoint 空洞/未综合簇防御
    const rid = insertReality(db, r);
    const members = strands.filter((x) => r.timeline.some((t) => t.session_id === x.session_id && t.topic_id === x.topic_id));
    const refPaths = new Set();
    for (const s of members) {
      const sid = strandIdByKey.get(s.session_id + ':' + s.topic_id);
      if (sid) mapStrandToReality(db, sid, rid);
      // 7.1 P3b：reality→references_path = 成员 strand→touches_path 的 path 并集
      for (const row of db.prepare('SELECT to_key FROM entity_edges WHERE kind=? AND anchor=?').all('touches_path', 'strand:' + sid)) {
        if (String(row.to_key).startsWith('path:')) refPaths.add(String(row.to_key));
      }
    }
    if (refPaths.size > 0) {
      upsertEntityNodes(db, ['reality:' + rid, ...refPaths]);
      upsertEntityEdges(db, [...refPaths].map((p) => ({
        from_key: 'reality:' + rid, to_key: p, kind: 'references_path',
        anchor: 'reality:' + rid, weight: 1, reality_id: rid, source: 'reality',
      })));
    }
  }
  log('reality 完成:', realities.length, '条入库 →', DB_PATH);
  db.close();
}


// ════════════════════════════════════════════ Stage 5: 精炼（参考 Hermes L4 refinement）═══════════════════════════
const REFINE_SYSTEM = `你是一个知识库精炼助手。你会收到一个现有知识条目（reality 工作线），请执行以下操作：
1. **去冗余**：移除重复、模糊或低价值的信息
2. **纠错**：修正逻辑矛盾、过期信息
3. **合并**：将相似的 changes 或 key_facts 合并为更精炼的表达
4. **简化**：在不丢失核心信息的前提下让 overview 更简洁

**规则**：
- 保留条目原有的 title（不要改）
- changes = 过去发生了哪些实质性变更（每个是一个字符串）
- key_facts = 当前已确认的核心结论（每个是一个字符串）
- open_items = 仍待解决的问题（每个是一个字符串）
- 每条信息应该独立、具体、可验证
- 如果原内容已经很好，只做最小改动
`;

function refineEntryInput(entry) {
  const capped = {
    ...entry,
    changes: (entry.changes || []).slice(0, 120),
    key_facts: (entry.key_facts || []).slice(0, 40),
    open_items: (entry.open_items || []).slice(0, 40),
  };
  let out = '=== 现有条目 ===\n\n' +
    'title: ' + JSON.stringify(capped.title) + '\n' +
    'overview: ' + JSON.stringify(capped.overview) + '\n' +
    'changes: ' + JSON.stringify(capped.changes) + '\n' +
    'key_facts: ' + JSON.stringify(capped.key_facts) + '\n' +
    'open_items: ' + JSON.stringify(capped.open_items) + '\n\n' +
    '=== 输出格式（JSON，不要有其他文字） ===\n\n' +
    '{"overview":"精炼后的 overview","changes":["change1","change2"],"key_facts":["fact1"],"open_items":["item1"]}';
  return out.length > 26000 ? out.slice(0, 26000) + '…[输入截断]' : out;
}

async function refineStage() {
  const t0 = Date.now();
  const db = openDb(DB_PATH);
  const rows = db.prepare('SELECT reality_id, name, hdl, current_status, timeline, source_strands, centroid_json, created_at, updated_at FROM realities ORDER BY updated_at ASC').all();
  log('refine: 候选 reality', rows.length, '条（参考 Hermes L4 internal_refine）');

  // Step A: zombie_cleanup —— 移除指向不存在 strand/session 的 source
  let zombies = 0;
  const liveSessions = new Set(db.prepare('SELECT session_id FROM session_meta').all().map((r) => r.session_id));
  for (const r of rows) {
    const src = JSON.parse(r.source_strands || '{}');
    let changed = false;
    for (const [sid, topics] of Object.entries(src)) {
      if (!liveSessions.has(sid)) { delete src[sid]; changed = true; zombies++; continue; }
      const live = new Set(db.prepare('SELECT topic_id FROM strand_summaries WHERE session_id=?').all(sid).map((x) => x.topic_id));
      const kept = topics.filter((t) => live.has(t));
      if (kept.length !== topics.length) { src[sid] = kept; changed = true; zombies++; }
    }
    if (changed) {
      if (Object.keys(src).length === 0) { db.prepare('DELETE FROM realities WHERE reality_id=?').run(r.reality_id); zombies++; }
      else db.prepare('UPDATE realities SET source_strands=? WHERE reality_id=?').run(JSON.stringify(src), r.reality_id);
    }
  }
  log('refine: zombie_cleanup 清理', zombies, '处无效引用');

  // Step B: internal_refine —— 每 reality LLM 精炼（去冗余/纠错/合并/简化）
  const fresh = db.prepare('SELECT reality_id, name, hdl, current_status, timeline, source_strands, centroid_json, created_at, updated_at FROM realities ORDER BY updated_at ASC').all();
  const cpDone = new Set();
  if (existsSync(REFINE_CP)) {
    for (const line of readFileSync(REFINE_CP, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); cpDone.add(o.reality_id); } catch { /* ignore */ }
    }
    log('  refine checkpoint:', cpDone.size, '条已精炼');
  }
  let cpFd = null;
  const appendCp = (o) => { if (cpFd === null) cpFd = openSync(REFINE_CP, 'a'); writeSync(cpFd, JSON.stringify(o) + '\n'); };
  const queue = fresh.filter((r) => !cpDone.has(r.reality_id));
  let modified = 0, reviewed = 0;
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      const cs = JSON.parse(r.current_status || '{}');
      const tl = JSON.parse(r.timeline || '[]');
      const changes = [];
      for (const e of tl) if (e && Array.isArray(e.changes)) for (const c of e.changes) if (c && String(c).trim()) changes.push(String(c));
      const entry = {
        entry_id: r.reality_id, title: r.name || '', hdl: r.hdl || '',
        overview: [r.name || '', r.hdl || ''].filter(Boolean).join(' '),
        changes, key_facts: Array.isArray(cs.key_facts) ? cs.key_facts : [],
        open_items: Array.isArray(cs.goals) ? cs.goals : [],
        current_status: cs, centroid_json: r.centroid_json,
      };
      reviewed++;
      let out = null;
      try {
        out = await llmJson(REFINE_SYSTEM, refineEntryInput(entry), { maxTokens: 8000, temperature: 0.3 });
      } catch (e) { log('  refine 失败 R' + r.reality_id + ':', e.message); }
      const rec = { reality_id: r.reality_id, modified: false };
      if (out) {
        const nOver = String(out.overview ?? entry.overview);
        const nChanges = Array.isArray(out.changes) ? out.changes.map(String).filter(Boolean) : entry.changes;
        const nFacts = Array.isArray(out.key_facts) ? out.key_facts.map(String).filter(Boolean) : entry.key_facts;
        const nOpen = Array.isArray(out.open_items) ? out.open_items.map(String).filter(Boolean) : entry.open_items;
        const same = nOver === entry.overview && JSON.stringify(nChanges) === JSON.stringify(entry.changes)
          && JSON.stringify(nFacts) === JSON.stringify(entry.key_facts) && JSON.stringify(nOpen) === JSON.stringify(entry.open_items);
        if (!same) {
          const newCs = { ...cs, key_facts: nFacts, goals: nOpen };
          const newTl = [...tl, { topic_id: null, turns: [], session_id: 'refine', overview: nOver, ts: Date.now() / 1000, seq: tl.length + 1, changes: nChanges }];
          let cent = r.centroid_json;
          try {
            const [v] = await embedTexts([(nOver + ' ' + nFacts.join(' ')).slice(0, 1500)]);
            cent = JSON.stringify(v);
          } catch { /* keep old centroid */ }
          db.prepare('UPDATE realities SET hdl=?, current_status=?, timeline=?, centroid_json=?, updated_at=? WHERE reality_id=?')
            .run(nOver, JSON.stringify(newCs), JSON.stringify(newTl), cent, Date.now() / 1000, r.reality_id);
          rec.modified = true;
          modified++;
        }
      }
      appendCp(rec);
      if (reviewed % 15 === 0) log('  refine 进度:', reviewed, '/', fresh.length, '| modified:', modified);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, Math.max(queue.length, 1)) }, worker));
  if (cpFd !== null) closeSync(cpFd);
  log('refine: internal_refine 完成', reviewed, '条复查，', modified, '条已修改');

  // Step C: health_score（Hermes 公式）
  // 必须在 Step B 精炼完成之后重新读取：fresh 数组中的 updated_at/timeline/current_status 已陈旧，
  // 直接使用会把精炼前的新鲜度/内容得分写入 DB
  const freshAfter = db.prepare('SELECT reality_id, name, hdl, current_status, timeline, source_strands, centroid_json, created_at, updated_at FROM realities ORDER BY updated_at ASC').all();
  let scored = 0;
  for (const r of freshAfter) {
    const src = JSON.parse(r.source_strands || '{}');
    const n = Object.values(src).flat().length;
    const tl = JSON.parse(r.timeline || '[]');
    const changes = tl.flatMap((e) => (Array.isArray(e.changes) ? e.changes : []));
    const cs = JSON.parse(r.current_status || '{}');
    let score = 1.0;
    if (n >= 3) score *= 1.0; else if (n === 2) score *= 0.9; else if (n === 1) score *= 0.7; else score *= 0.3;
    const upd = r.updated_at || r.created_at || 0;
    if (upd > 0) { const days = (Date.now() / 1000 - upd) / 86400; if (days > 90) score *= 0.6; else if (days > 30) score *= 0.8; }
    if (!r.centroid_json || r.centroid_json === 'null' || r.centroid_json === '[]') score *= 0.5;
    if (!changes.length && !(Array.isArray(cs.key_facts) && cs.key_facts.length)) score *= 0.3;
    score = Math.round(Math.min(Math.max(score, 0), 1) * 1000) / 1000;
    db.prepare('UPDATE realities SET health_score=? WHERE reality_id=?').run(score, r.reality_id);
    scored++;
  }
  log('refine: health_score 更新', scored, '条');

  // Step D: refinement_meta 记录
  const dur = (Date.now() - t0) / 1000;
  db.prepare('INSERT INTO refinement_meta (tasks_run, entries_reviewed, entries_modified, fcts_cross_checked, inconsistencies, duration_sec, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(JSON.stringify(['zombie_cleanup', 'internal_refine', 'health_score']), reviewed, modified, 0, 0, Math.round(dur * 1000) / 1000, 'completed', Date.now() / 1000);
  log('refine 完成：', reviewed, '复查 /', modified, '修改 /', scored, '评分（耗时', Math.round(dur), 's）→', DB_PATH);
  db.close();
}


// ════════════════════════════════════════════ Stage 4: 报告 ═══════════════════════════
function reportStage() {
  const db = openDb(DB_PATH);
  const stats = countStats(db);
  // 7.2 K0：DATA_JSON 缓存里的 preview 仅供报告展示，不落库
  const previewByKey = new Map();
  if (existsSync(DATA_JSON)) {
    try {
      for (const sess of JSON.parse(readFileSync(DATA_JSON, 'utf8'))) {
        const sid = sess.meta?.session_id ?? '';
        for (const tr of sess.think_rows ?? []) {
          if (tr.seq !== undefined && tr.seq !== null && tr.preview != null) {
            previewByKey.set(sid + ':' + tr.seq, tr.preview);
          }
        }
      }
    } catch { /* DATA_JSON 损坏时预览降级为无预览 */ }
  }
  const lines = [];
  lines.push('# DSH 历史会话 CA 摘要（DSH CA 库）');
  lines.push('');
  lines.push('> 生成方式：参考 Hermes CA（reality-strand 做法）+ DSH 版 CA 插件 ca-v7（lib/view.js 事务视图/OODA 打标），历史摘要用云端 DeepSeek flash。');
  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(stats)) lines.push('| ' + k + ' | ' + v + ' |');
  lines.push('');
  lines.push('## think_trace（7.2 K0 思考卡）');
  lines.push('');
  const thinkRows = db.prepare('SELECT * FROM think_trace').all();
  const thinkSummary = {
    total: thinkRows.length,
    decision: thinkRows.filter((r) => r.card_kind === 'decision').length,
    conclusion: thinkRows.filter((r) => r.card_kind === 'conclusion').length,
    sessions: new Set(thinkRows.map((r) => r.session_id)).size,
    rawLenSum: thinkRows.reduce((s, r) => s + (r.raw_len ?? 0), 0),
  };
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push('| 总数 | ' + thinkSummary.total + ' |');
  lines.push('| decision | ' + thinkSummary.decision + ' |');
  lines.push('| conclusion | ' + thinkSummary.conclusion + ' |');
  lines.push('| 覆盖会话数 | ' + thinkSummary.sessions + ' |');
  lines.push('| raw_len 合计 | ' + thinkSummary.rawLenSum + ' |');
  lines.push('');
  lines.push('### L1 提炼（7.2 K1）');
  lines.push('');
  if (!existsSync(THINK_OUT)) {
    lines.push('- 未运行（think-cards.json 不存在）');
  } else {
    try {
      const tj = JSON.parse(readFileSync(THINK_OUT, 'utf8'));
      const lr = tj.last_run ?? {};
      lines.push('- 最近运行：processed=' + (lr.processed ?? 0) + '，ok=' + (lr.ok ?? 0) + '，failed=' + (lr.failed ?? 0));
      const cards = Array.isArray(tj.cards) ? tj.cards : [];
      const cardByKey = new Map(cards.map((c) => [c.session_id + ':' + c.seq, c]));
      const okKeys = Array.isArray(lr.ok_keys) ? lr.ok_keys.slice(0, 5) : [];
      lines.push('- 成功样例（≤5）：');
      for (const key of okKeys) {
        const c = cardByKey.get(key);
        if (c) lines.push('  - ' + key + '：' + (c.l0_abstract ?? ''));
      }
      lines.push('- 失败样例（≤5）：');
      let failedShown = 0;
      for (const c of cards) {
        if (c && c.error && failedShown < 5) {
          lines.push('  - ' + c.session_id + ':' + c.seq + ' / ' + c.error.kind + ' / ' + c.error.message);
          failedShown += 1;
        }
      }
    } catch {
      lines.push('- 未运行（think-cards.json 不可解析）');
    }
  }
  lines.push('');
  lines.push('### 清单（top 200 by raw_len DESC）');
  lines.push('');
  lines.push('| seq | session | turn | card_kind | tool_name | raw_len | topic_id |');
  lines.push('|---|---|---|---|---|---|---|');
  const topThinkRows = db.prepare('SELECT * FROM think_trace ORDER BY raw_len DESC, seq ASC LIMIT 200').all();
  for (const r of topThinkRows) {
    lines.push('| ' + r.seq + ' | ' + r.session_id + ' | ' + (r.turn ?? '') + ' | ' +
               (r.card_kind ?? '') + ' | ' + String(r.tool_name ?? '').replace(/\|/g, '｜') + ' | ' +
               r.raw_len + ' | ' + (r.topic_id ?? '') + ' |');
  }
  lines.push('');
  lines.push('### 样例卡（≤10 张）');
  lines.push('');
  for (const r of topThinkRows.slice(0, 10)) {
    const key = r.session_id + ':' + r.seq;
    const preview = previewByKey.get(key) ?? '(无预览)';
    lines.push('- ' + (r.card_kind ?? '') + '（raw_len=' + r.raw_len + '，tool=' +
               (r.tool_name ?? '') + '，turn=' + (r.turn ?? '') + '）');
    lines.push('  - question: ' + String(r.question_text ?? '').replace(/\|/g, '｜'));
    lines.push('  - preview: ' + String(preview).replace(/\|/g, '｜'));
  }
  lines.push('');
  lines.push('## realities（工作线）');
  lines.push('');
  const realities = db.prepare('SELECT * FROM realities ORDER BY reality_id').all();
  const strandMap = new Map();
  for (const row of db.prepare('SELECT strand_id, session_id, topic_id, hdl, ooda_json, changes_json, status FROM strand_summaries').all()) {
    strandMap.set(row.session_id + ':' + row.topic_id, row);
  }
  for (const r of realities) {
    lines.push('### R' + r.reality_id + ' ' + (r.name || '(未命名)'));
    lines.push('');
    lines.push('- hdl: ' + (r.hdl || ''));
    const st = JSON.parse(r.current_status || '{}');
    for (const k of ['current_state', 'key_facts', 'goals', 'context']) {
      const v = st[k];
      if (Array.isArray(v) && v.length) {
        lines.push('- ' + k + ':');
        for (const x of v) lines.push('  - ' + x);
      }
    }
    const src = JSON.parse(r.source_strands || '{}');
    const memKeys = [];
    for (const [sid, topics] of Object.entries(src)) for (const t of topics) memKeys.push(sid + ':' + t);
    lines.push('- 成员 strand:');
    for (const k of memKeys) {
      const m = strandMap.get(k);
      if (!m) continue;
      lines.push('  - S' + m.strand_id + ' 「' + (m.hdl || '') + '」（会话 ' + m.session_id.slice(0, 16) + '…，' + m.status + '）');
      const o = JSON.parse(m.ooda_json || '{}');
      for (const sec of ['现象与问题', '背景与约束', '决策与方案', '后续行动']) {
        const arr = o[sec];
        if (Array.isArray(arr) && arr.length) {
          lines.push('    - ' + sec + ': ' + arr.join('；').slice(0, 220));
        }
      }
      const ch = JSON.parse(m.changes_json || '[]');
      if (ch.length) lines.push('    - changes: ' + ch.join('；').slice(0, 220));
    }
    lines.push('');
  }
  lines.push('## strands（话题摘要）');
  lines.push('');
  lines.push('| strand | 会话 | 话题 | hdl | 轮次 | 状态 |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of db.prepare('SELECT strand_id, session_id, topic_id, hdl, turns, status FROM strand_summaries ORDER BY strand_id').all()) {
    lines.push('| S' + s.strand_id + ' | ' + s.session_id + ' | ' + s.topic_id + ' | ' + (s.hdl || '').replace(/\|/g, '｜').slice(0, 60) + ' | ' + s.turns + ' | ' + s.status + ' |');
  }
  writeFileSync(REPORT_MD, lines.join('\n'));
  log('报告已生成 →', REPORT_MD);
  db.close();
}

// ════════════════════════════════════════════ main ═══════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const stages = STAGE === 'all' ? ['extract', 'strand', 'reality', 'refine'] : [STAGE];
  for (const st of stages) {
    log('== stage', st, '==');
    if (st === 'extract') extractStage();
    else if (st === 'strand') await strandStage();
    else if (st === 'reality') await realityStage();
    else if (st === 'refine') await refineStage();
    else if (st === 'think') await thinkStage();
    else if (st === 'report') reportStage();
    else { console.error('未知 stage:', st); process.exit(1); }
  }
  if (STAGE === 'all') reportStage();
  log('全部完成。库:', DB_PATH);
}
