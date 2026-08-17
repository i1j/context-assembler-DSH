/**
 * lib/think-l1.js --think-keys 纯函数单测（7.2 K1 质量抽检）
 *
 * 覆盖（需求规格 T1-T4）：清单解析（空行/注释/非法/重复）、keys+limit 正交、
 * 缺失键/非 raw 键安全跳过、无 keys 时与既有 selectUniqueThinkCards 行为一致。
 */
import { describe, it, expect } from 'vitest';
import { parseThinkKeysFile, selectThinkCardsByKeys, selectUniqueThinkCards } from '../lib/think-l1.js';

function row(sid: string, seq: number, status = 'raw') {
  return { session_id: sid, seq, status, card_kind: 'decision' };
}

describe('7.2 K1 --think-keys 纯函数', () => {
  it('T1 parseThinkKeysFile：空行/注释/非法/重复计数与去重保序', () => {
    const p = parseThinkKeysFile('s1:1\ns2:2\ns1:1\n# 注释\n\nbad\ns3:x\ns4:4\n');
    expect(p.keys).toEqual(['s1:1', 's2:2', 's4:4']);
    expect(p.skipped).toEqual({ empty: 1, comment: 1, invalid: 2, duplicate: 1 });
  });

  it('T1b parseThinkKeysFile：空输入/非字符串安全', () => {
    expect(parseThinkKeysFile('')).toEqual({ keys: [], skipped: { empty: 0, comment: 0, invalid: 0, duplicate: 0 } });
    expect(parseThinkKeysFile(null).keys).toEqual([]);
  });

  it('T2 keys+limit 正交：清单 5 条取前 2 且保持文件顺序', () => {
    const rows = [
      row('s5', 5), row('s1', 1), row('s2', 2), row('s3', 3), row('s4', 4),
    ];
    const picked = selectThinkCardsByKeys(rows, ['s5:5', 's4:4', 's1:1', 's3:3', 's2:2'], 2);
    expect(picked.map((r) => r.session_id + ':' + r.seq)).toEqual(['s5:5', 's4:4']);
  });

  it('T3 缺失键/非 raw 键安全跳过', () => {
    const rows = [row('s1', 1), row('s2', 2, 'l1')];
    const picked = selectThinkCardsByKeys(rows, ['s1:1', 's2:2', 'missing:9', 's1:99']);
    expect(picked.map((r) => r.session_id + ':' + r.seq)).toEqual(['s1:1']);
  });

  it('T4 无 keys 时与 selectUniqueThinkCards 行为一致（含 limit）', () => {
    const rows = [
      row('s1', 1), row('s1', 1, 'raw'), row('s2', 2, 'l1'), row('s3', 3),
    ];
    expect(selectThinkCardsByKeys(rows, [], 0)).toEqual(selectUniqueThinkCards(rows));
    expect(selectThinkCardsByKeys(rows, [], 2)).toEqual(selectUniqueThinkCards(rows).slice(0, 2));
  });
});
