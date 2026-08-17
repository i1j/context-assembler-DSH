/**
 * 话题切换检测（lib/topic-switch.js）——Hermes TopicGradeManager._assign_topic 移植。
 *
 * 用途：reality 召回注入的话题级门控——Hermes 在「首轮 + 话题切换」时注入（决策 38/41），
 * 同一话题内的延续轮不重复注入（省 embedding/4B 调用 + 稳定尾部，缓存友好）。
 *
 * 规则（对齐 Hermes _assign_topic 顺序）：
 *   1. 强制分割短语（换话题/说回/再问一个…）→ 切换
 *   2. 纯确认/简短消息（≤5 字符）→ 延续
 *   3. 首个用户轮 → 切换（首轮 recall）
 *   4. Jaccard(当前轮文本, 当前话题累积文本) + 水位压力扣减：
 *        effectiveJ = j - waterPenalty(累计 ctx 字符)   （Hermes _apply_water_pressure）
 *        ≥ ENTRY(0.04) → 延续（同话题）
 *        <  ENTRY       → 切换（新话题）
 *   文本 profile = user_text + fin_text（截断），与 Hermes 累积 Fct 文本同构。
 *   纯确定性，无 LLM。
 *
 * 水位压力（2026-08-17 用户裁定，Hermes 版移植）：ctx 字符总数逐渐上涨的压力区间中
 *   话题切割越来越主动——start 以下不扣减（保守，缓存友好）；start→peak 线性扣减
 *   Jaccard（越来越容易切）；peak 及以上 forceAtPeak=true 时无条件切割（不管前后轮
 *   多接近也切，兑现「压力到就切新会话」的无人值守 intent）。默认对齐 Hermes
 *   ACCUMULATED_SPLIT_START=5000 / TOPIC_PEAK_TOKEN=20000 / JACCARD_PENALTY_MAX=0.30。
 */

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/g;
const WORD_RE = /[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+/g;

export const FORCED_SPLIT_PHRASES = [
  '换话题', '聊点别的', '另一个', '说回', '下一个问题', '还有一个问题',
  '再问一个', '别提', '不管', '换个话题', '不说这个', '回到正题', '说重点',
  'topic switch', 'switching gears', 'shift topics', 'moving on', 'change of subject',
];

/** Hermes TOPIC_JACCARD_ENTRY=0.04（弱匹配即延续） */
export const TOPIC_JACCARD_ENTRY = 0.04;

/** 确认轮阈值（≤5 字符视为延续，Hermes _is_confirmatory_turn） */
export const CONFIRM_LEN = 5;

/** 水位压力默认参数（对齐 Hermes ca/config.py，单位字符；待 S6.1 实测标定） */
export const WATER_PRESSURE_DEFAULTS = {
  splitStartChars: 5000,    // ACCUMULATED_SPLIT_START：水位满前不扣减
  splitPeakChars: 20000,    // TOPIC_PEAK_TOKEN：满压（配合 forceAtPeak 或最大扣减）
  jaccardPenaltyMax: 0.30,  // JACCARD_PENALTY_MAX：线性区最大扣减量
  forceAtPeak: true,        // 用户裁定：peak 及以上无条件切割（Hermes 为扣减后比较，本裁定更彻底）
};

/**
 * 水位压力：累计 ctx 字符 → 柔性扣减 Jaccard（Hermes _apply_water_pressure 移植 + forceAtPeak）。
 * @param {number} rawJ 原始 Jaccard 匹配值
 * @param {number} [totalChars] 累计 ctx 字符（user+fin 文本，纯 fold 口径；缺省/0 → 不扣减）
 * @param {Partial<typeof WATER_PRESSURE_DEFAULTS>} [opts]
 * @returns {number} effectiveJ（低于任何 entry ∈ [0,1] 即切换；forceAtPeak 时返回 -1 保证必切）
 */
export function applyWaterPressure(rawJ, totalChars, opts = {}) {
  // undefined 字段不覆盖默认（调用方 config 未配置时透传 undefined 的场景）
  const o = opts ?? {};
  const splitStartChars = o.splitStartChars ?? WATER_PRESSURE_DEFAULTS.splitStartChars;
  const splitPeakChars = o.splitPeakChars ?? WATER_PRESSURE_DEFAULTS.splitPeakChars;
  const jaccardPenaltyMax = o.jaccardPenaltyMax ?? WATER_PRESSURE_DEFAULTS.jaccardPenaltyMax;
  const forceAtPeak = o.forceAtPeak ?? WATER_PRESSURE_DEFAULTS.forceAtPeak;
  const c = Number.isFinite(totalChars) ? totalChars : 0;
  if (c <= splitStartChars) return rawJ;
  if (forceAtPeak && c >= splitPeakChars) return -1; // 极限：无条件切割（< 任何 entry∈[0,1)）
  if (c >= splitPeakChars) return rawJ - jaccardPenaltyMax;
  const progress = (c - splitStartChars) / (splitPeakChars - splitStartChars);
  return rawJ - progress * jaccardPenaltyMax;
}

export function jaccard(a, b) {
  const mk = (t) => {
    const s = new Set();
    for (const m of (t.match(CJK_RE) ?? [])) s.add('c:' + m);
    const chars = t.match(CJK_RE) ?? [];
    for (let i = 0; i < chars.length - 1; i += 1) s.add('b:' + chars[i] + chars[i + 1]);
    for (const m of (t.toLowerCase().match(WORD_RE) ?? [])) s.add('w:' + m);
    return s;
  };
  const sa = mk(a);
  const sb = mk(b);
  if (!sa.size && !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

function isConfirmatory(text) {
  const t = (text ?? '').trim().toLowerCase();
  return !t || t.length <= CONFIRM_LEN;
}

/**
 * 话题切换检测（纯函数）。
 * @param {string} userText 当前轮 user 消息
 * @param {string} finText 当前轮 assistant 结论（可空）
 * @param {{ profile: string; seen: boolean }} state 会话级话题状态（首次传 {profile:'',seen:false}）
 * @param {number} [entry] Jaccard 延续阈值（默认 TOPIC_JACCARD_ENTRY=0.04）。
 *   注意方向：effectiveJ >= entry → 延续；effectiveJ < entry → 切换。entry 越小越难切换（缓存友好），
 *   entry=0 时除强制短语/首轮/水位满压外永不切换；entry 越大越容易切换（前部频繁重构、破坏缓存）。
 * @param {object} [water] 水位压力参数：{ totalChars, splitStartChars, splitPeakChars, jaccardPenaltyMax, forceAtPeak }
 *   （缺省 → 水位不生效，行为与旧版完全一致）
 * @returns {{ switched: boolean; state: {profile: string; seen: boolean} }}
 */
export function detectTopicSwitch(userText, finText, state, entry = TOPIC_JACCARD_ENTRY, water = {}) {
  const text = ((userText ?? '').slice(0, 1200) + ' ' + (finText ?? '').slice(0, 1200)).trim();
  const lowUser = (userText ?? '').toLowerCase();
  const s = state ?? { profile: '', seen: false };

  // 1. 强制分割短语 → 切换
  if (FORCED_SPLIT_PHRASES.some((p) => lowUser.includes(p))) {
    return { switched: true, state: { profile: text, seen: true } };
  }
  // 2. 确认/简短 → 延续（不切换）
  if (s.seen && isConfirmatory(userText)) {
    return { switched: false, state: { profile: (s.profile + ' ' + text).trim(), seen: true } };
  }
  // 3. 首个用户轮 → 切换（首轮 recall）
  if (!s.seen) {
    return { switched: true, state: { profile: text, seen: true } };
  }
  // 4. Jaccard + 水位压力 vs 当前话题累积文本（entry 越小越延续；0 = 永不因相似度切换，除非水位满压）
  const j = jaccard(text, s.profile);
  const effectiveJ = applyWaterPressure(j, water?.totalChars, water);
  if (effectiveJ >= entry) {
    return { switched: false, state: { profile: (s.profile + ' ' + text).trim(), seen: true } };
  }
  return { switched: true, state: { profile: text, seen: true } };
}
