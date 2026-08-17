/**
 * ca-v7 7.3 H1 — topic-state 会话投影单测（任务书 A §3.1，红线基线，主笔/测试线）。
 * 覆盖：topicClusters 累计、冻结定级快照（切换时重算 / 块内新 txn 补 ACT）、farRatio 数值、
 * 事务编号与 view.js 同口径（plugin 消息不开事务、synthetic turn 不占名额）。
 */
import { describe, it, expect } from 'vitest';
import { applyTopicState, initTopicState, viewTopicState, createTopicStateProjection, topicStateViewSchema, TOPIC_STATE_KEY, TOPIC_STATE_VERSION } from '../lib/topic-state.js';
import { newSession, appendTurn, appendUser, appendSyntheticTurn } from './helpers.js';

/** fold 会话全部事件 */
function fold(session: any) {
  let s: any = initTopicState();
  for (const e of session.events) s = applyTopicState(s, e, {});
  return s;
}

/** fold 会话全部事件（自定义 config，水位测试用） */
function foldCfg(session: any, cfg: any) {
  let s: any = initTopicState();
  for (const e of session.events) s = applyTopicState(s, e, cfg);
  return s;
}

describe('topic-state 投影', () => {
  it('导出面完整（6 导出 + 投影定义字段齐全）', () => {
    const proj = createTopicStateProjection();
    expect(proj.key).toBe(TOPIC_STATE_KEY);
    expect(proj.stateVersion).toBe(TOPIC_STATE_VERSION);
    expect(typeof proj.init).toBe('function');
    expect(typeof proj.apply).toBe('function');
    expect(typeof proj.view).toBe('function');
    expect(proj.schema).toBeTruthy();
  });

  it('投影 schema 校验 view 输出而非内部 state（真实 DSH snapshot ZodError 回归）', () => {
    const proj = createTopicStateProjection();
    expect(proj.schema).toBe(topicStateViewSchema);
    const v = viewTopicState(initTopicState());
    expect(topicStateViewSchema.safeParse(v).success).toBe(true);
    // 有 grades 的 view 也必须通过（字段全集）
    const s: any = fold(newSession('ts-schema'));
    expect(topicStateViewSchema.safeParse(viewTopicState(s)).success).toBe(true);
  });

  it('空会话：topicClusters=0、totalGraded=0、farRatio=0', () => {
    const v = viewTopicState(initTopicState());
    expect(v.topicClusters).toBe(0);
    expect(v.totalGraded).toBe(0);
    expect(v.farRatio).toBe(0);
  });

  it('H1：强制分割短语累计 topicClusters；首轮 recall 计 1 簇', () => {
    const session = newSession('ts1');
    appendTurn(session, 1, { userText: '讨论数据库迁移方案', thought: '讨论数据库迁移方案' });
    appendTurn(session, 2, { userText: '继续完善数据库迁移方案', thought: '继续完善数据库迁移方案' });
    appendTurn(session, 3, { userText: '换个话题，聊聊前端组件库', thought: '换个话题，聊聊前端组件库' });
    const v = viewTopicState(fold(session));
    expect(v.topicClusters).toBe(2); // 首轮 recall=1 + 强制分割=1
  });

  it('H1：切换时冻结定级（FAR/REL/ACT 语义与 gradeTransactions 一致）+ 块内新 txn 补 ACT', () => {
    const session = newSession('ts2');
    // t1 与 t2 用户文本无公共词 → 定级 FAR；t2..t7 同文本 → t2 对 t3 REL；t3..t6 年龄不足 ACT；t7/t8 tail ACT
    appendTurn(session, 1, { userText: '关于量子计算的入门介绍', thought: '苹果手机电池更换' });
    for (let i = 2; i <= 7; i += 1) {
      appendTurn(session, i, { userText: '苹果手机电池更换', thought: '苹果手机电池更换' });
    }
    appendTurn(session, 8, { userText: '换个话题，讨论编译器优化', thought: '换个话题，讨论编译器优化' });
    const state: any = fold(session);
    const v: any = viewTopicState(state);
    expect(v.topicClusters).toBe(2);
    // 冻结快照：切换（t8）时重算 t1..t8
    expect(state.grades[1]).toBe('FAR');   // 年龄达标且与 t2 文本不相似
    expect(state.grades[2]).toBe('REL');   // 与 t3 同文本
    expect(state.grades[8]).toBe('ACT');   // tail 保护
    expect(v.grades[1]).toBe('FAR');
    expect(v.totalGraded).toBe(8);
    expect(v.farRatio).toBeCloseTo(1 / 8, 5);
    // 块内新 txn（切换后，无再次切换）→ 视图补 ACT，farRatio 分母+1
    appendTurn(session, 9, { userText: '编译器优化具体怎么做', thought: '编译器优化具体怎么做' });
    const v2: any = viewTopicState(fold(session));
    expect(v2.grades[9]).toBe('ACT');
    expect(v2.totalGraded).toBe(9);
    expect(v2.farRatio).toBeCloseTo(1 / 9, 5);
  });

  it('H1：plugin user/message 与 synthetic turn 不开事务、不占名额（txn 编号同 view.js 口径）', () => {
    const session = newSession('ts3');
    appendTurn(session, 1, { userText: '真实用户轮一', thought: 'r1' });
    appendUser(session, '插件注入消息', 'plugin'); // source.kind='plugin' → 不开事务
    appendSyntheticTurn(session, 2);               // 无真实 user/message → 不占名额
    appendTurn(session, 3, { userText: '真实用户轮二', thought: 'r2' });
    const s: any = fold(session);
    // 事务只有 2 个（id 1、2，连续）
    expect(s.userTurns.map((t: any) => t.transaction_id)).toEqual([1, 2]);
    expect(s.maxTxnId).toBeLessThanOrEqual(2);
    const v = viewTopicState(s);
    expect(v.totalGraded).toBeGreaterThanOrEqual(2);
    expect(Object.keys(v.grades).map(Number).sort()).toEqual([1, 2]);
  });

  it('H1：assistant/message 更新 lastFinText（话题检测输入）', () => {
    let s: any = initTopicState();
    s = applyTopicState(s, { type: 'assistant/message', data: { content: [{ type: 'text', text: '完成。迁移方案已落地' }] } }, {});
    expect(s.lastFinText).toBe('完成。迁移方案已落地');
    // 空内容 assistant 不改变 lastFinText
    const before = s.lastFinText;
    s = applyTopicState(s, { type: 'assistant/message', data: { content: [] } }, {});
    expect(s.lastFinText).toBe(before);
  });
  it('H1w：totalChars 累计 user+fin 文本（水位输入，跨话题不清零）', () => {
    const s = newSession('ts-totalchars');
    appendTurn(s, 1, { userText: 'alpha completely different text one' });
    appendTurn(s, 2, { userText: 'alpha completely different text two', thought: 'reply content here' });
    const st = fold(s);
    // user1(36) + user2(35) + thought(19) 的文本长度累计（extractText 口径）
    expect(st.totalChars).toBeGreaterThan(0);
    expect(st.totalChars).toBeGreaterThanOrEqual(60);
  });
  it('H1w：水位满压 forceAtPeak 触发话题切换（entry=0 也切，topicClusters 增长）', () => {
    const s = newSession('ts-water-force');
    appendTurn(s, 1, { userText: 'alpha completely different text one' }); // 首轮切 → 1 簇
    // 低水位参数：start=100 / peak=800，多轮累积字符快速满压
    for (let i = 2; i <= 6; i++) {
      appendTurn(s, i, { userText: 'beta continuation words ' + 'x'.repeat(150) + ' ' + i, thought: 'y'.repeat(120) });
    }
    const st = foldCfg(s, { topicSwitchEntry: 0, topicSplitStartChars: 100, topicSplitPeakChars: 800, topicSplitForceAtPeak: true });
    // 满压轮 forceAtPeak 必切 → 至少 2 簇（首轮 + 满压轮）
    expect(st.topicClusters).toBeGreaterThan(1);
  });
  it('H1w：无水位（totalChars 低）时 entry=0 同话题延续，不额外切簇', () => {
    const s = newSession('ts-water-none');
    appendTurn(s, 1, { userText: 'alpha completely different text one' });
    for (let i = 2; i <= 4; i++) {
      appendTurn(s, i, { userText: 'alpha continuation ' + i, thought: 'same topic' });
    }
    const st = foldCfg(s, { topicSwitchEntry: 0, topicSplitStartChars: 5000, topicSplitPeakChars: 20000 });
    // 首轮 1 簇；延续轮因 entry=0 + 水位未到 start → 不切
    expect(st.topicClusters).toBe(1);
  });
  it('H1w：view 输出携带 totalChars（投影 snapshot 水位输入，2026-08-18 修复回归）', () => {
    const s = newSession('ts-water-view');
    appendTurn(s, 1, { userText: 'alpha completely different text one' }); // user1
    appendTurn(s, 2, { userText: 'alpha completely different text two', thought: 'reply content here' }); // user2 + thought
    const st = fold(s);
    const v = viewTopicState(st);
    // sessionProjections.snapshot 返回 schema.parse(view(state))——view 必须带 totalChars，
    // 否则 pre-step / engine.gradeView 读 values[TOPIC_STATE_KEY].totalChars 恒为 0，水位永不生效
    expect(v.totalChars).toBe(st.totalChars);
    expect(v.totalChars).toBeGreaterThan(0);
    expect(topicStateViewSchema.safeParse(v).success).toBe(true);
    // schema 缺 totalChars 的旧形态必须判失败（字段契约回归守卫）
    const { totalChars: _drop, ...legacy } = v;
    void _drop;
    expect(topicStateViewSchema.safeParse(legacy).success).toBe(false);
  });

});

describe('topic-state 话题块边界（v2 blocks，2026-08-18）', () => {
  it('单话题会话：blocks = 首块（startTxnId=1，label=首轮首行），length === topicClusters', () => {
    const session = newSession('ts-block-1');
    appendTurn(session, 1, { userText: '讨论数据库迁移方案', thought: '讨论数据库迁移方案' });
    appendTurn(session, 2, { userText: '继续完善数据库迁移方案', thought: '继续完善数据库迁移方案' });
    const v: any = viewTopicState(fold(session));
    expect(v.topicClusters).toBe(1); // 首轮 recall 计 1 簇
    expect(v.blocks).toHaveLength(1);
    expect(v.blocks[0]).toEqual({ index: 1, startTxnId: 1, label: '讨论数据库迁移方案' });
    // schema 校验 blocks 字段（新字段契约）
    expect(topicStateViewSchema.safeParse(v).success).toBe(true);
  });

  it('一次真实切换：闭合首块、切换轮开新块（startTxnId=切换轮）；首轮初始化不重复开块', () => {
    const session = newSession('ts-block-2');
    appendTurn(session, 1, { userText: '讨论数据库迁移方案', thought: '讨论数据库迁移方案' });
    appendTurn(session, 2, { userText: '继续完善数据库迁移方案', thought: '继续完善数据库迁移方案' });
    // 强制分割短语 → 真实切换（切换轮 turn 3 归属新块）
    appendTurn(session, 3, { userText: '换个话题，聊聊前端组件库', thought: '换个话题，聊聊前端组件库' });
    const st: any = fold(session);
    const v: any = viewTopicState(st);
    expect(v.topicClusters).toBe(2); // 首轮 1 + 真实切换 1
    expect(v.blocks).toHaveLength(2);
    expect(v.blocks[0]).toEqual({ index: 1, startTxnId: 1, label: '讨论数据库迁移方案' });
    expect(v.blocks[1]).toEqual({ index: 2, startTxnId: 3, label: '换个话题，聊聊前端组件库' });
    // 内部 state 也记录闭合块 + 开放块（前端读 view 产物，此处守卫 fold 完整性）
    expect(st.blocks).toHaveLength(1); // 闭合块（块1）
    expect(st.openBlock).toEqual({ index: 2, startTxnId: 3, label: '换个话题，聊聊前端组件库' });
  });

  it('空会话与 synthetic-only：blocks 为空', () => {
    const v: any = viewTopicState(initTopicState());
    expect(v.blocks).toEqual([]);
    const s = newSession('ts-block-empty');
    appendSyntheticTurn(s, 1, 'synthetic');
    const v2: any = viewTopicState(fold(s));
    expect(v2.blocks).toEqual([]);
    expect(topicStateViewSchema.safeParse(v2).success).toBe(true);
  });
});
