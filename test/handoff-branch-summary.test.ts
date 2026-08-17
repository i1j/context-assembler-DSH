/**
 * ca-v7 7.3 H7/H8/H10 — handoff-branch-summary 单测（任务书 A §3.4，红线基线，主笔/测试线）。
 * 覆盖：segmentMessagesFromEvents 按事件原文（被遮蔽 seq 仍取原文，R1-1）、tool/result L1 摘要
 * 构造 tool message（H8）、parseBranchSummary 三类输入、renderBranchMarkdown/指令常量导出面。
 */
import { describe, it, expect } from 'vitest';
import {
  segmentMessagesFromEvents,
  parseBranchSummary,
  renderBranchMarkdown,
  HANDOFF_BRANCH_INSTRUCTION,
  BRANCH_SUMMARY_KEYS,
  BranchSummaryParseError,
} from '../lib/handoff-branch-summary.js';
import { newSession, appendTurn, appendToolPair, appendCompactionSummary, foldView } from './helpers.js';

describe('H7/H8 segmentMessagesFromEvents', () => {
  it('H7：按 session.events[elm_ref] 原文产出（compaction 遮蔽区间内 txn 消息仍产出原文，R1-1）', () => {
    const session = newSession('hbs1');
    const t1 = appendTurn(session, 1, { userText: '最早的讨论：数据库迁移方案', thought: 'r1' });
    appendTurn(session, 2, { userText: '继续：迁移的索引策略', thought: 'r2' });
    // compaction summary：遮蔽 t1 的 user/fin（事件日志保留原文；surface 无关）
    appendCompactionSummary(session, {
      shadowedSeqs: [t1.userSeq, t1.finSeq],
      summaryText: '已压缩：数据库迁移方案（摘要）',
      carriedTxnIds: [1],
    });
    const view = foldView(session); // elm_ref 仍指向原事件
    const msgs = segmentMessagesFromEvents(session, view, [1, 2]) as any[];
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const texts = JSON.stringify(msgs);
    expect(texts).toContain('最早的讨论：数据库迁移方案'); // 原文，非摘要
    expect(texts).toContain('继续：迁移的索引策略');
    expect(texts).not.toContain('已压缩：数据库迁移方案（摘要）');
  });

  it('H7：elm_ref 越界（undefined 事件）→ 跳过不抛错', () => {
    const session = newSession('hbs2');
    appendTurn(session, 1, { userText: '仅有的一轮', thought: 'r1' });
    const view = foldView(session).concat([{ type: 'user', transaction_id: 2, elm_ref: 9999, text: 'x', ooda_stage: 'plan', text_ref: 9999 } as any]);
    const msgs = segmentMessagesFromEvents(session, view, [1, 2]) as any[];
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.some((m) => m.content?.[0]?.text === '仅有的一轮')).toBe(true);
  });

  it('H8：tool/result 用 view elm.text（L1 摘要）构造 tool 消息，callId 正确', () => {
    const session = newSession('hbs3');
    const callId = 'call-abc-1';
    appendTurn(session, 1, {
      userText: '查一下库存',
      tool: { callId, name: 'inventory_query', resultText: '原始结果全文很长……' },
    });
    const view = foldView(session).map((e) =>
      e.type === 'toolResult' ? { ...e, text: 'L1 摘要：库存 12 件' } : e,
    );
    const msgs = segmentMessagesFromEvents(session, view, [1]);
    // createToolResultMessage（dsh-llm 实测）：role=user + source.kind='tool' + content[type:'tool-result']{toolCallId, content[text], isError}
    const toolMsg = (msgs as any[]).find((m) => m.source?.kind === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.source.callId ?? toolMsg.content?.[0]?.toolCallId).toBe(callId);
    const block = toolMsg.content?.[0];
    expect(block.type).toBe('tool-result');
    expect(block.content?.[0]?.text).toBe('L1 摘要：库存 12 件');
    expect(block.isError).toBe(false);
  });
});

describe('H10 parseBranchSummary', () => {
  const fence = (obj: any) => '```json\n' + JSON.stringify(obj) + '\n```';

  it('围栏 JSON：九字段归一化；缺失字符串→空串、缺失数组→空数组、不编造', () => {
    const blocks = [{ type: 'text', text: fence({ goal: 'G', source_txn_ids: [1, '2', 3.7, 'x'], source_seq_ranges: [[10, 18], [99, 99], ['bad']], strand_id: 12, reality_ids: [3] }) }];
    const s = parseBranchSummary(blocks);
    expect(s.goal).toBe('G');
    expect(s.current_state).toEqual([]);
    expect(s.open_items).toEqual([]);
    expect(s.next_step).toEqual([]);
    expect(s.key_facts).toEqual([]);
    expect(s.source_txn_ids).toEqual([1, 2, 3]);
    expect(s.source_seq_ranges).toEqual([[10, 18], [99, 99]]);
    expect(s.strand_id).toBe(12);
    expect(s.reality_ids).toEqual([3]);
  });

  it('无围栏裸 JSON 亦可解析', () => {
    const s = parseBranchSummary([{ type: 'text', text: JSON.stringify({ goal: '裸 JSON' }) }]);
    expect(s.goal).toBe('裸 JSON');
  });

  it('source_seq_ranges 过滤倒置/零/负区间，只保留 1≤start≤end 的合法区间', () => {
    const s = parseBranchSummary([{ type: 'text', text: JSON.stringify({
      goal: 'G',
      source_seq_ranges: [[18, 10], [0, 0], [-1, 5], [5, 3], [10, 18]],
    }) }]);
    expect(s.source_seq_ranges).toEqual([[10, 18]]);
  });

  it('非法 JSON / 非对象 → 抛 BranchSummaryParseError', () => {
    expect(() => parseBranchSummary([{ type: 'text', text: 'not json {' }])).toThrow(BranchSummaryParseError);
    expect(() => parseBranchSummary([{ type: 'text', text: JSON.stringify([1, 2]) }])).toThrow(BranchSummaryParseError);
    expect(() => parseBranchSummary([{ type: 'text', text: '{}' + 'x'.repeat(0) }])).not.toThrow();
  });

  it('导出面：指令常量/字段清单/渲染函数', () => {
    expect(typeof HANDOFF_BRANCH_INSTRUCTION).toBe('string');
    expect(HANDOFF_BRANCH_INSTRUCTION).toContain('source_txn_ids');
    expect(BRANCH_SUMMARY_KEYS).toEqual(['goal', 'current_state', 'key_facts', 'open_items', 'next_step', 'source_txn_ids', 'source_seq_ranges', 'strand_id', 'reality_ids']);
    const md = renderBranchMarkdown(
      { goal: 'G', current_state: ['A'], key_facts: [], open_items: [], next_step: [], source_txn_ids: [1], source_seq_ranges: [], strand_id: null, reality_ids: [] },
      { package_id: 1, branch_id: 2, parent_session_id: 'p', spawn_session_id: null, status: 'planned', created_at: '2026-08-16' },
    );
    expect(md).toContain('package_id: 1');
    expect(md).toContain('branch_id: 2');
    expect(md).toContain('# 分支摘要');
  });
});
