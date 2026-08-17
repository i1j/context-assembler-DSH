/**
 * 重叠判定单一基元（lib/overlap.js）——最长公共子串（LCS substring）。
 *
 * 用途（D45/C24 需求线 + C8 阈值参数化）：
 *   - 注入内容与检查点摘要去重：maxCommonSubstring(注入文本, 摘要文本) >= 20 → 拒绝注入；
 *   - grade.js 文本相似度归一化基元：相似度 = maxCommonSubstring(a, b) / min(len(a), len(b))。
 * 单一语义、单一实现，防双份实现漂移。
 */

/**
 * 计算两个字符串的最长公共子串长度（DP，O(len(a)*len(b)) 空间优化为 O(len(short))）。
 * @param {string} a 文本 A
 * @param {string} b 文本 B
 * @param {number} [minLen=20] 消费者判定阈值（≥ minLen 视为重复）；本函数返回原始最长公共子串长度
 * @returns {number} 最长公共子串字符数（UTF-16 码元口径，与 DSH estimate 口径一致）
 */
export function maxCommonSubstring(a, b, minLen = 20) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  if (a.length === 0 || b.length === 0) return 0;
  const safeMin = Number.isFinite(minLen) && minLen > 0 ? minLen : 20;
  // 以较短串为内层，降低空间
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  const n = short.length;
  let best = 0;
  const prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    const cur = new Array(n + 1).fill(0);
    const ci = long.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      if (ci === short.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) best = v;
      }
    }
    // 滚动数组
    for (let j = 0; j <= n; j += 1) prev[j] = cur[j];
  }
  // minLen 为判定阈值参数（调用方据此判 ≥ 重复）；返回值始终为原始最长公共子串长度
  void safeMin;
  return best;
}
