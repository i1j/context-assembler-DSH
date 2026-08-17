/**
 * overlap.js 单测（D45/C24：重叠判定单一基元；C8 阈值参数化）
 *
 * 覆盖：最长公共子串长度计算、≥20 判定、边界（空串/非字符串/不同顺序）。
 */
import { describe, it, expect } from 'vitest';
import { maxCommonSubstring } from '../lib/overlap.js';

describe('maxCommonSubstring 单一基元', () => {
  it('完全相同 → 全长', () => {
    const s = '这是一段完全相同的检查点文本，用于重叠判定测试';
    expect(maxCommonSubstring(s, s)).toBe(s.length);
  });

  it('≥20 字符重叠 → 判定重复（D45 阈值）', () => {
    const shared = 'shared checkpoint fragment text 1234567890';
    const a = '前缀' + shared + '后缀A';
    const b = '前缀' + shared + '后缀B';
    const overlap = maxCommonSubstring(a, b);
    expect(overlap).toBeGreaterThanOrEqual(20);
  });

  it('<20 字符重叠 → 不判定重复', () => {
    const a = 'abcde fghij klmno';
    const b = 'xyzabcde wqert';
    expect(maxCommonSubstring(a, b)).toBeLessThan(20);
  });

  it('空串 / 非字符串 → 0（防御）', () => {
    expect(maxCommonSubstring('', 'abc')).toBe(0);
    expect(maxCommonSubstring('abc', '')).toBe(0);
    expect(maxCommonSubstring('', '')).toBe(0);
    // 非字符串防御（JS 运行期防御，类型层以 never 绕过）
    expect(maxCommonSubstring(123 as never, 'abc')).toBe(0);
    expect(maxCommonSubstring('abc', null as never)).toBe(0);
  });

  it('minLen 阈值参数化（C8）——返回值始终为原始 LCS 长度', () => {
    const a = 'same prefix and more text here';
    const b = 'same prefix and different tail';
    const lcs = maxCommonSubstring(a, b, 5);
    expect(lcs).toBeGreaterThanOrEqual(5);
    // 阈值仅影响消费者判定，不影响返回值
    const lcs2 = maxCommonSubstring(a, b, 999);
    expect(lcs2).toBe(lcs);
  });

  it('子串在较前/较后位置均可检出', () => {
    expect(maxCommonSubstring('开头重叠的文本X', '开头重叠的文本Y')).toBeGreaterThanOrEqual(6);
    expect(maxCommonSubstring('X文本尾部重叠', 'Y文本尾部重叠')).toBeGreaterThanOrEqual(6);
  });
});
