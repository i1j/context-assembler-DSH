/**
 * lib/topic-grade.js 单测——P1 第一步：话题块内定级冻结。
 * 对照 Hermes TopicGradeManager「switch → grade_on_switch 定级 → 冻结直到下次 switch」。
 */
import { describe, expect, it } from 'vitest';
import { gradeTransactionsStable, initTopicGradeState } from '../lib/topic-grade.js';
import { richTxn } from './helpers.js';
import type { CaRichViewElm } from '../lib/types/index.js';

const config = { tailN: 1, ageThresholdTurns: 1, similarityThreshold: 0.5, topicSwitchEntry: 0 };

function viewOf(...txns: Array<{ id: number; user: string }>): CaRichViewElm[] {
  return txns.flatMap((t) => richTxn(t.id, { userText: t.user, baseRef: t.id * 10 }));
}

describe('P1 topic-grade 冻结语义', () => {
  it('首次定级生成快照；同话题新增轮不改旧事务等级，新事务恒为 ACT', () => {
    const state = initTopicGradeState();
    const v1 = viewOf(
      { id: 1, user: 'alpha completely different text one' },
      { id: 2, user: 'shared common prefix beta' },
      { id: 3, user: 'shared common prefix gamma' },
    );
    const g1 = gradeTransactionsStable(v1, config, state);
    expect(g1.get(1)).toBe('FAR');
    expect(g1.get(2)).toBe('REL');
    expect(g1.get(3)).toBe('ACT');

    // 同话题延续轮（Jaccard ≥ ENTRY）→ 冻结旧等级；新轮 ACT
    const v2 = [...v1, ...richTxn(4, { userText: 'shared common prefix epsilon', baseRef: 40 })];
    const g2 = gradeTransactionsStable(v2, config, state);
    expect(g2.get(1)).toBe('FAR'); // 冻结：不随 current 前移而重算
    expect(g2.get(2)).toBe('REL');
    expect(g2.get(3)).toBe('ACT'); // 冻结：fresh gradeTransactions 会将其变为 REL
    expect(g2.get(4)).toBe('ACT'); // 本话题块新增轮 = ACT

    // fresh 对照：证明冻结确实改变了重算结果
    const freshState = initTopicGradeState();
    const fresh = gradeTransactionsStable(v2, config, freshState);
    expect(fresh.get(3)).toBe('REL');
  });

  it('7.1 P3：实体图定级覆盖文本定级并随话题冻结', () => {
    const state = initTopicGradeState();
    const v1: CaRichViewElm[] = [
      ...richTxn(1, { userText: 'alpha completely different text one', baseRef: 10 }),
      { type: 'toolResult', transaction_id: 1, elm_ref: 101 } as unknown as CaRichViewElm,
      ...richTxn(2, { userText: 'shared common prefix beta', baseRef: 20 }),
      { type: 'toolResult', transaction_id: 2, elm_ref: 201 } as unknown as CaRichViewElm,
    ];
    const rows = [
      { resultSeq: 101, entities: ['path:/a/b', 'tool:bash'] },
      { resultSeq: 201, entities: ['path:/a/c', 'tool:read'] },
    ];
    const g1 = gradeTransactionsStable(v1, config, state, { rows, questionText: '请处理 /a/b 的问题' });
    expect(g1.get(1)).toBe('ACT'); // 图 d=0，覆盖文本 FAR/REL
    expect(g1.get(2)).toBe('REL'); // 图 d=2（共享父目录）
    // 同块冻结：换提问实体也不重算（缓存稳定）
    const g2 = gradeTransactionsStable(v1, config, state, { rows, questionText: '换成 /x/y 的新话题' });
    expect(g2.get(1)).toBe('ACT');
    expect(g2.get(2)).toBe('REL');
  });

  it('话题切换触发重新定级（旧快照失效）——显式 entry 触发切换', () => {
    const state = initTopicGradeState();
    const v1 = viewOf(
      { id: 1, user: 'alpha completely different text one' },
      { id: 2, user: 'shared common prefix beta' },
      { id: 3, user: 'shared common prefix gamma' },
    );
    // 显式低 entry 保留『相似度低即切换』语义（供切换→重算机制验证）
    gradeTransactionsStable(v1, { ...config, topicSwitchEntry: 0.5 }, state);

    const v2 = [...v1, ...richTxn(4, { userText: 'completely unrelated zeta topic', baseRef: 40 })];
    const g2 = gradeTransactionsStable(v2, { ...config, topicSwitchEntry: 0.5 }, state);
    // 切换后重算：新轮成为 tail ACT；原 tail txn3 重新定级（此处相似度低 → FAR/REL 边界不固定，仅断言非冻结快照值即可）
    expect(g2.get(4)).toBe('ACT');
    expect(g2.get(3)).not.toBe('ACT'); // 原冻结快照中 txn3=ACT；切换重算后不再是 tail
  });

  it('entry=0 最保守：低相似度轮次不切换（冻结快照保持，缓存友好）', () => {
    const state = initTopicGradeState();
    const v1 = viewOf(
      { id: 1, user: 'alpha completely different text one' },
      { id: 2, user: 'shared common prefix beta' },
      { id: 3, user: 'shared common prefix gamma' },
    );
    gradeTransactionsStable(v1, config, state); // config 默认 topicSwitchEntry=0

    const v2 = [...v1, ...richTxn(4, { userText: 'completely unrelated zeta topic', baseRef: 40 })];
    const g2 = gradeTransactionsStable(v2, config, state);
    // entry=0 → 永不因相似度切换：冻结快照保持（txn3 仍 ACT），仅新轮补 ACT
    expect(g2.get(4)).toBe('ACT');
    expect(g2.get(3)).toBe('ACT'); // 冻结：不重算
    expect(g2.get(2)).toBe('REL'); // 冻结：不重算
  });
});
