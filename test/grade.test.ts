/**
 * grade.js 单测（R6 / T7 + R5 定级构造参数）
 *
 * 覆盖：tail 保护（N=2/改值 N=4/≤N 全量 ACT/synthetic 不挤占名额）、轮次年龄（≥6 候选）、
 * 文本相似度（LCS 归一化 = LCS/较短文本长度，C32）→ REL/FAR、其余 ACT。
 */
import { describe, it, expect } from 'vitest';
import { gradeTurn, gradeTransactions, groupByTxn, DEFAULT_GRADE_CONFIG } from '../lib/grade.js';
import { richTxn } from './helpers.js';
import type { CaRichViewElm } from '../lib/types/index.js';

/** 构造 N 个纯文本事务的 rich 视图 */
function multiTxnView(count: number, texts: string[]): CaRichViewElm[] {
  const view: CaRichViewElm[] = [];
  for (let i = 0; i < count; i += 1) {
    view.push(...richTxn(i + 1, { userText: texts[i] ?? 'text-' + (i + 1), finText: 'reply-' + (i + 1) }));
  }
  return view;
}

const cfg = { tailN: 2, ageThresholdTurns: 1, similarityThreshold: 0.5 };

describe('R6 tail 保护（T7）', () => {
  it('tail N=2：最后 2 个真实 user turn 恒 ACT（其余按年龄/相似度定级）', () => {
    // 5 turn，各文本互不相同（相似度 < 0.5 → 非 tail 且年龄达标 → FAR）
    const view = multiTxnView(5, ['aaa111', 'bbb222', 'ccc333', 'ddd444', 'eee555']);
    const grades = gradeTransactions(view, cfg);
    expect(grades.get(5)).toBe('ACT');
    expect(grades.get(4)).toBe('ACT'); // tail N=2
    expect(grades.get(1)).toBe('FAR'); // 年龄达标 + 低相似度
    expect(grades.get(2)).toBe('FAR');
    expect(grades.get(3)).toBe('FAR');
  });

  it('改值 N=4：最后 4 个真实 user turn 恒 ACT（阈值随配置移动，F47 ①）', () => {
    const view = multiTxnView(6, ['aaa1', 'bbb2', 'ccc3', 'ddd4', 'eee5', 'fff6']);
    const grades = gradeTransactions(view, { ...cfg, tailN: 4 });
    expect(grades.get(6)).toBe('ACT');
    expect(grades.get(5)).toBe('ACT');
    expect(grades.get(4)).toBe('ACT');
    expect(grades.get(3)).toBe('ACT');
    expect(grades.get(1)).toBe('FAR');
    expect(grades.get(2)).toBe('FAR');
  });

  it('user turn 数 ≤ N 时全量 ACT（A8）', () => {
    const view = multiTxnView(2, ['only1', 'only2']);
    const grades = gradeTransactions(view, { ...cfg, ageThresholdTurns: 0 });
    expect(grades.get(1)).toBe('ACT');
    expect(grades.get(2)).toBe('ACT');
  });

  it('含 synthetic 消息的会话：真实 user turn 保护数量 ≥ N（synthetic 不挤占名额，A24）', () => {
    // 6 个真实事务 + 挂在各事务的 synthetic 消息（不产生新事务）
    const view = multiTxnView(6, ['a1', 'b2', 'c3', 'd4', 'e5', 'f6']);
    // 附加 synthetic elm（transaction_id 归属既有事务）
    const withSynthetic = [
      ...view,
      ...richTxn(1, { userText: undefined, finText: undefined, thoughtText: 'synthetic thought' }).map((e) => ({ ...e, type: 'synthetic', ooda_stage: null }) as CaRichViewElm),
      ...richTxn(6, { userText: undefined, finText: undefined, thoughtText: 'synthetic thought 2' }).map((e) => ({ ...e, type: 'synthetic', ooda_stage: null }) as CaRichViewElm),
    ];
    const grades = gradeTransactions(withSynthetic, cfg);
    const actCount = [...grades.values()].filter((g) => g === 'ACT').length;
    expect(actCount).toBeGreaterThanOrEqual(2); // ≥ N
    expect(grades.get(6)).toBe('ACT');
    expect(grades.get(5)).toBe('ACT');
  });

  it('tailN min=1（0 非法由 config schema 拦截——grade 层防御为 1）', () => {
    const view = multiTxnView(3, ['x1', 'y2', 'z3']);
    const g = gradeTurn(view, 3, { ...cfg, tailN: 0 });
    // 防御：0 退化为 1 → 仅最后 1 个受保护
    expect(g).toBe('ACT');
    expect(gradeTurn(view, 2, { ...cfg, tailN: 0 })).toBe('FAR');
    // 年龄规则也关闭时，tail 钳制仍保护最后一轮（不依赖 age<0 恰好通过）
    expect(gradeTurn(view, 3, { ...cfg, tailN: 0, ageThresholdTurns: 0 })).toBe('ACT');
  });
});

describe('R5 轮次年龄 + 文本相似度（最小定级规则，design §3.3）', () => {
  it('轮次年龄：与当前 turn 差距 ≥ ageThresholdTurns → 候选 FAR/REL；不足 → ACT', () => {
    const view = multiTxnView(8, ['alpha1', 'beta2', 'gamma3', 'delta4', 'eps5', 'zeta6', 'eta7', 'theta8']);
    const grades = gradeTransactions(view, { tailN: 2, ageThresholdTurns: 6, similarityThreshold: 0.5 });
    // age = current - turnNo ≥ 6 → turn 1（7）、turn 2（6）候选；turn 3-6 年龄不足 ACT；turn 7-8 tail ACT
    expect(grades.get(1)).toBe('FAR');
    expect(grades.get(2)).toBe('FAR');
    expect(grades.get(3)).toBe('ACT');
    expect(grades.get(6)).toBe('ACT');
    expect(grades.get(7)).toBe('ACT');
    expect(grades.get(8)).toBe('ACT');
  });

  it('文本相似度（LCS 归一化）：与相邻后续 turn 相似度 ≥ 0.5 → REL（同话题延续）', () => {
    const view = multiTxnView(4, [
      'alpha completely different text one',
      'shared common prefix beta',
      'shared common prefix gamma',
      'tail tail tail tail',
    ]);
    const grades = gradeTransactions(view, { tailN: 2, ageThresholdTurns: 0, similarityThreshold: 0.5 });
    // turn 1 与 turn 2 低相似度 → FAR；turn 2 与 turn 3 高相似度（LCS 21/26 ≈ 0.81）→ REL
    expect(grades.get(1)).toBe('FAR');
    expect(grades.get(2)).toBe('REL');
  });

  it('低于阈值且年龄达标 → FAR；其余 → ACT（含 tail 保护）', () => {
    const view = multiTxnView(5, ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    const grades = gradeTransactions(view, cfg); // tailN=2, ageThresholdTurns=1
    expect(grades.get(1)).toBe('FAR'); // 年龄达标 + 低相似度
    expect(grades.get(2)).toBe('FAR');
    expect(grades.get(3)).toBe('FAR');
    expect(grades.get(4)).toBe('ACT'); // tail N=2
    expect(grades.get(5)).toBe('ACT');
  });

  it('不存在的事务防御为 ACT', () => {
    const view = multiTxnView(1, ['only']);
    expect(gradeTurn(view, 99, cfg)).toBe('ACT');
  });

  it('groupByTxn 保序分组', () => {
    const view = multiTxnView(2, ['a', 'b']);
    const groups = groupByTxn(view);
    expect([...groups.keys()].sort()).toEqual([1, 2]);
    expect(groups.get(1)?.length).toBe(2);
  });
});

describe('DEFAULT_GRADE_CONFIG 与 §4.1 默认一致', () => {
  it('默认 tailN=2 / ageThresholdTurns=6 / similarityThreshold=0.5', () => {
    expect(DEFAULT_GRADE_CONFIG).toEqual({ tailN: 2, ageThresholdTurns: 6, similarityThreshold: 0.5 });
  });
});
