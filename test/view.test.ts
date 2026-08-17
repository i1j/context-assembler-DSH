/**
 * view.js 单测（R2 / R-Elm1 / R-Elm3）
 *
 * 覆盖：T2 视图派生（事务数/Elm 类型枚举/chunk 不产生额外 Elm/tool 配对闭合）；
 * T3 双会话隔离；T-Elm1 事务边界（会话起始/空闲期检查点/隐式闭合/plugin 归属/
 * synthetic turn 事务数不变/多轮工具循环共享事务 ID）；T-Elm4 导出四字段 +
 * synthetic 豁免 + 可回溯。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import {
  exportView,
  setSessionView,
  clearSessionViews,
  initViewState,
  applyViewState,
} from '../lib/view.js';
import {
  newSession,
  appendUser,
  appendAssistant,
  appendToolPair,
  appendTurn,
  appendSyntheticTurn,
  appendPluginInjection,
  appendCompactionSummary,
  appendCompactionPrune,
  foldView,
} from './helpers.js';

beforeEach(() => {
  clearSessionViews();
});

describe('R2 会话视图派生（T2）', () => {
  it('2 事务会话：事务数=2、tool 配对闭合=1、每事务含 user+fin、Elm 类型枚举完整、chunk 不产生额外 Elm', () => {
    const session = newSession('t2');
    // 事务 1：1 对 tool call/result + assistant/chunk 流式事件
    session.append('turn/start', { turn: 1 });
    appendUser(session, 'turn 1 用户消息');
    session.append('step/start', { turn: 1, step: 1 });
    appendToolPair(session, 1, 1, { name: 'tool_a', resultText: '工具结果 1' });
    appendAssistant(session, 1, 1, 'turn 1 中间推理'); // thought
    appendAssistant(session, 1, 1, 'turn 1 最终回复'); // fin
    // assistant/chunk（流式增量事件——不派生 Elm，D43）
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '流式' } });
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '增量' } });
    session.append('step/end', { turn: 1, step: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    // 事务 2：纯文本
    appendTurn(session, 2, { userText: 'turn 2 用户消息', thought: 'turn 2 回复' });

    const view = foldView(session);
    const txns = new Set(view.map((e) => e.transaction_id));
    expect(txns.size).toBe(2); // 事务数 = 2

    const t1 = view.filter((e) => e.transaction_id === 1);
    const t2 = view.filter((e) => e.transaction_id === 2);
    expect(t1.some((e) => e.type === 'user')).toBe(true);
    expect(t1.some((e) => e.type === 'fin')).toBe(true);
    expect(t2.some((e) => e.type === 'user')).toBe(true);
    expect(t2.some((e) => e.type === 'fin')).toBe(true);
    // Elm 类型枚举完整
    const types = new Set(view.map((e) => e.type));
    for (const t of ['user', 'thought', 'fin', 'toolCall', 'toolResult'] as const) {
      expect(types.has(t)).toBe(true);
    }
    // tool 配对闭合 = 1（tool/result elm 数）
    expect(view.filter((e) => e.type === 'toolResult').length).toBe(1);
    // 视图 Elm 数 = 消息类非 chunk 事件数（user/assistant/tool call/tool result 派生 Elm；chunk 不产生额外 Elm，D43）
    const elmProducing = session.events.filter((e) =>
      ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(e.type),
    ).length;
    expect(view.length).toBe(elmProducing);
    // OODA 标注
    expect(t1.find((e) => e.type === 'user')?.ooda_stage).toBe('orient');
    expect(t1.find((e) => e.type === 'fin')?.ooda_stage).toBe('decide');
    expect(t1.some((e) => e.type === 'toolCall' && e.ooda_stage === 'act')).toBe(true);
    expect(t1.some((e) => e.type === 'toolResult' && e.ooda_stage === 'observe')).toBe(true);
  });
});

describe('R2 双会话隔离（T3）', () => {
  it('会话 A 视图不含 B 的 Elm、B 视图不含 A 的 Elm', () => {
    const a = newSession('iso-a');
    appendTurn(a, 1, { userText: 'A 专属用户消息文本 alpha', thought: 'A 专属回复文本' });
    const b = newSession('iso-b');
    appendTurn(b, 1, { userText: 'B 专属用户消息文本 beta', thought: 'B 专属回复文本' });
    const va = foldView(a);
    const vb = foldView(b);
    // 会话 A 视图不含 B 的 Elm（文本/事件互不串扰）
    const aTexts = va.map((e) => e.text).join('|');
    const bTexts = vb.map((e) => e.text).join('|');
    expect(aTexts).not.toContain('B 专属');
    expect(bTexts).not.toContain('A 专属');
    // debug 导出隔离：各自视图仅含本会话事件
    setSessionView('iso-a', va);
    setSessionView('iso-b', vb);
    const ea = exportView('iso-a');
    const eb = exportView('iso-b');
    expect(ea.every((e) => e.transaction_id === 1)).toBe(true);
    expect(eb.every((e) => e.transaction_id === 1)).toBe(true);
    // 导出对象互不共享（各自独立数组）
    const eaRefs = new Set(ea.map((e) => e.elm_ref));
    expect(eaRefs.size).toBe(ea.length);
    expect(ea).not.toBe(eb);
  });

  it('debug 导出缓存 FIFO 上限：写入超过 256 个会话时最旧被淘汰', () => {
    clearSessionViews();
    for (let i = 0; i < 257; i += 1) setSessionView('v' + i, [{ type: 'user', transaction_id: 1, elm_ref: i, ooda_stage: 'orient', text_ref: i, text: 'v' + i }] as never);
    expect(exportView('v0')).toEqual([]); // 最旧已淘汰（exportView 剥离 text，用 elm_ref 区分）
    expect(exportView('v1')[0]).toMatchObject({ elm_ref: 1 });
    expect(exportView('v256')[0]).toMatchObject({ elm_ref: 256 });
    clearSessionViews();
  });
});

describe('R-Elm1 事务边界（T-Elm1）', () => {
  it('会话起始 plugin 消息归首个后续事务；注入消息归当前事务；多轮工具循环共享事务 ID；事务 ID 会话内递增；隐式闭合；synthetic turn 不产生事务', () => {
    const session = newSession('txn1');
    // 会话起始 plugin 消息（种子/inject，首个事务之前，B25）
    session.append(
      'user/message',
      {
        id: 'seed1',
        role: 'user',
        content: [{ type: 'text', text: '会话种子' }],
        source: { kind: 'plugin', plugin: 'ca-v7', form: 'snapshot', sections: [] },
      } as never,
      { surfaceOp: 'append' },
    );
    // 事务 1：注入消息 + 多轮工具循环
    session.append('turn/start', { turn: 1 });
    appendUser(session, 'turn 1 用户');
    appendPluginInjection(session, '注入消息', [1]);
    appendToolPair(session, 1, 1, { callId: 'c1', resultText: 'r1' });
    appendToolPair(session, 1, 2, { callId: 'c2', resultText: 'r2' });
    appendAssistant(session, 1, 2, 'turn 1 最终回复');
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    // 事务 2：无 turn/end（隐式闭合——直接被事务 3 的真实 user 隐式闭合）
    appendTurn(session, 2, { userText: 'turn 2 用户', thought: 'turn 2 回复', close: false });
    // 事务 3
    appendTurn(session, 3, { userText: 'turn 3 用户', thought: 'turn 3 回复' });
    // 空闲期检查点（turn 3 闭合后、turn 4 之前，无当前事务 → 归最近已闭合事务 3，B14'）
    session.append(
      'user/message',
      {
        id: 'cp-idle',
        role: 'user',
        content: [{ type: 'text', text: '空闲期检查点内容' }],
        source: compactCheckpointSource(CompactionId('idle-cp')),
      } as never,
      { surfaceOp: 'append' },
    );
    // synthetic turn（turn/start + assistant/message + turn/end，无真实 user，F40）
    appendSyntheticTurn(session, 4);

    const view = foldView(session);
    const txns = [...new Set(view.map((e) => e.transaction_id))].sort((x, y) => x - y);
    expect(txns).toEqual([1, 2, 3]); // 事务数 = 3（注入/检查点不 +1；synthetic turn 不产生事务）

    // 会话起始 plugin 消息归入事务 1
    const seedElm = view.find((e) => e.text === '会话种子');
    expect(seedElm?.transaction_id).toBe(1);
    expect(seedElm?.ooda_stage).toBeNull();
    // 事务 1 全部 Elm（含注入/thought/result/fin）transaction_id 相同
    const t1 = view.filter((e) => e.transaction_id === 1);
    expect(t1.length).toBeGreaterThan(3);
    expect(t1.every((e) => e.transaction_id === 1)).toBe(true);
    expect(t1.find((e) => e.text === '注入消息')?.transaction_id).toBe(1);
    // 事务 2 的 ID = 事务 1 + 1
    expect(txns[1]).toBe(2);
    // 事务 2 隐式闭合：其 fin 归属 2、无游离 Elm（隐式闭合与 turn/end 同样标记 fin）
    expect(view.filter((e) => e.transaction_id === 2).every((e) => e.transaction_id === 2)).toBe(true);
    expect(view.some((e) => e.transaction_id === 2 && e.type === 'fin')).toBe(true);
    // 空闲期检查点归入最近已闭合事务（事务 3，D41 公式化：transaction_id == 事务 3 的 ID）
    const idleCp = view.find((e) => e.text === '空闲期检查点内容');
    expect(idleCp?.transaction_id).toBe(3);
    expect(idleCp?.ooda_stage).toBeNull();
    // synthetic turn 不产生事务（无游离事务 4）
    expect(view.some((e) => e.transaction_id === 4)).toBe(false);
  });

  it('空 content 的 assistant/message 不派生 thought/fin Elm（与 deriveEventMessage null 语义一致）', () => {
    const session = newSession('empty-assistant');
    appendTurn(session, 1, { userText: 'u', thought: 'r1' });
    session.append('turn/start', { turn: 2 });
    appendUser(session, 'u2');
    // 仅承载 usage 的空 assistant：真实 DSH deriveEventMessage 返回 null
    session.append('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [] } } as never, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    const view = foldView(session);
    expect(view.filter((e) => e.type === 'fin').map((e) => e.text).filter((t) => t === '').length).toBe(0);
    expect(view.filter((e) => e.type === 'thought').map((e) => e.text).filter((t) => t === '').length).toBe(0);
  });

  it('压缩检查点消息（isCompactCheckpointSource 为真）不开启新事务 + replace 区间计入遮蔽范围（B38）', () => {
    const session = newSession('txn1b');
    appendTurn(session, 1, { userText: 'turn 1 用户', thought: '回复' });
    // 检查点消息（source = compact checkpoint，surfaceOp replace）
    const cpSource = compactCheckpointSource(CompactionId('cc1'));
    const surfaceNodes = [...session.surface.nodes]; // [user, fin]
    session.append(
      'user/message',
      { id: 'cp1', role: 'user', content: [{ type: 'text', text: '检查点内容' }], source: cpSource } as never,
      { surfaceOp: { op: 'replace', start: surfaceNodes[0], end: surfaceNodes[surfaceNodes.length - 1] }, sourceEventSeqs: [...surfaceNodes] },
    );
    const view = foldView(session);
    const txns = [...new Set(view.map((e) => e.transaction_id))];
    expect(txns).toEqual([1]); // 检查点不开启新事务
    const cp = view.find((e) => e.text === '检查点内容');
    expect(cp?.transaction_id).toBe(1);
    expect(cp?.ooda_stage).toBeNull();
    // 检查点 replace 区间计入遮蔽范围（B38）
    for (const seq of surfaceNodes) {
      expect(view.find((e) => e.elm_ref === seq)?.visibility).toBe('shadowed');
    }
  });
});

describe('R-Elm3 导出衔接（T-Elm4）', () => {
  it('导出每条含四字段 + transaction_id 全部非空 + synthetic ooda_stage 为 null（豁免）+ elm_ref 可回溯 + text_ref 指向事件存在', () => {
    const session = newSession('elm4');
    appendPluginInjection(session, '会话种子注入', [1]);
    appendTurn(session, 1, { userText: '真实用户消息', thought: '最终回复' });
    appendTurn(session, 2, { userText: '第二条用户消息', thought: '第二条回复' });
    const view = foldView(session);
    setSessionView('elm4', view);
    const exported = exportView('elm4');
    expect(exported.length).toBeGreaterThan(0);
    const seqs = new Set(session.events.map((e) => e.seq));
    for (const e of exported) {
      expect(e).toHaveProperty('transaction_id');
      expect(e).toHaveProperty('elm_ref');
      expect(e).toHaveProperty('ooda_stage');
      expect(e).toHaveProperty('text_ref');
      expect(typeof e.transaction_id).toBe('number'); // 全部非空（synthetic 豁免仅限 ooda_stage，B14'）
      expect(seqs.has(e.elm_ref)).toBe(true); // elm_ref 可回溯
      expect(seqs.has(e.text_ref)).toBe(true); // text_ref 指向的事件存在
    }
    const synthetic = exported.filter((e) => e.type === 'synthetic');
    expect(synthetic.length).toBeGreaterThan(0);
    for (const e of synthetic) expect(e.ooda_stage).toBeNull(); // 豁免
    const real = exported.filter((e) => e.type !== 'synthetic');
    expect(real.length).toBeGreaterThan(0);
    for (const e of real) expect(e.ooda_stage).not.toBeNull();
    // 按 transaction_id 分组后组内按事件 seq 可排序
    const byTxn = new Map<number, typeof exported>();
    for (const e of exported) {
      const list = byTxn.get(e.transaction_id) ?? [];
      list.push(e);
      byTxn.set(e.transaction_id, list);
    }
    for (const [, elms] of byTxn) {
      const refs = elms.map((e) => e.elm_ref);
      expect([...refs].sort((a, b) => a - b)).toEqual(refs);
    }
  });

  it('debug 导出 8 字段全集（type/transaction_id/elm_ref/ooda_stage/text_ref/grade/carrierState/visibility）', () => {
    const session = newSession('fields8');
    appendTurn(session, 1, { userText: '用户', thought: '回复' });
    const view = foldView(session);
    setSessionView('fields8', view);
    const exported = exportView('fields8');
    for (const e of exported) {
      expect(Object.keys(e).sort()).toEqual(
        ['carrierState', 'elm_ref', 'grade', 'ooda_stage', 'text_ref', 'transaction_id', 'type', 'visibility'].sort(),
      );
    }
  });
});

describe('R-Elm1/3 视图派生纯函数（无自建事件订阅）', () => {
  it('fold 无关事件返回同一引用（零下游工作契约）；prune 不进入遮蔽集合（B38）', () => {
    const st = initViewState();
    const next = applyViewState(st, {
      type: 'assistant/chunk',
      seq: 0,
      time: 0,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } },
    });
    expect(next).toBe(st);
    const next2 = applyViewState(st, {
      type: 'compaction/prune',
      seq: 0,
      time: 0,
      data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 5 },
    });
    expect(next2).toBe(st);
  });

  it('遮蔽范围来源限定（B38）：compaction/summary shadowedSeqs 计入、compaction/prune 排除', () => {
    const session = newSession('b38');
    appendTurn(session, 1, { userText: 'turn 1', thought: 'r1' });
    const surfaceSeqs = [...session.surface.nodes]; // [user, fin]
    // prune 仅 tool-result 单节点（事务可见性不变、不产生候选）
    appendCompactionPrune(session, [surfaceSeqs[surfaceSeqs.length - 1]]);
    let view = foldView(session);
    expect(view.every((e) => e.visibility === 'visible')).toBe(true);
    // compaction/summary 遮蔽核心 Elm → 事务不可见（txn 级可见性聚合，B38）
    appendCompactionSummary(session, { shadowedSeqs: surfaceSeqs, carriedTxnIds: [] });
    view = foldView(session);
    expect(view.filter((e) => e.transaction_id === 1).some((e) => e.visibility === 'shadowed')).toBe(true);
    expect(view.filter((e) => e.transaction_id === 1).every((e) => e.carrierState === 'unloaded')).toBe(true);
  });
});

describe('thought/fin 分离（2026-08-18：思考栏不混入最终回复）', () => {
  it('thought 只取 reasoning 块；fin 取回合最终回复（含 text）', () => {
    const session = newSession('s-thought-pure');
    session.append('turn/start', { turn: 1 });
    appendUser(session, '问题');
    // 中间 assistant（reasoning + text）→ 保持 thought（非回合末）；末条 → closeTxn 标 fin
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: '中间思考' },
          { type: 'text', text: '中间回答' },
        ],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' });
    session.append('assistant/message', {
      turn: 1, step: 2,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: '最终思考' },
          { type: 'text', text: '### 行为\n最终回复内容' },
        ],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const view = foldView(session);
    const t1 = view.filter((e) => e.transaction_id === 1);
    const thoughts = t1.filter((e) => e.type === 'thought');
    const fin = t1.find((e) => e.type === 'fin');
    // 中间 thought：纯 reasoning，不含 text（最终回复不混入思考栏）
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]!.text).toBe('中间思考');
    expect(thoughts[0]!.text).not.toContain('中间回答');
    // 末条 → fin：含最终回复 text（回合标题/总结可用）
    expect(fin?.text).toContain('### 行为');
    expect(fin?.text).toContain('最终回复内容');
  });

  it('无 text 块（纯思考回合）→ fin 回落 thought（reasoning），不崩', () => {
    const session = newSession('s-thought-only');
    session.append('turn/start', { turn: 1 });
    appendUser(session, '问题');
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: '只有思考' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const view = foldView(session);
    const t1 = view.filter((e) => e.transaction_id === 1);
    const fin = t1.find((e) => e.type === 'fin');
    expect(fin?.text).toBe('只有思考');
  });

  it('文本块消息（text-only，无 reasoning）→ thought 为空、不建卡片；fin 取 finalText', () => {
    const session = newSession('s-text-only');
    session.append('turn/start', { turn: 1 });
    appendUser(session, '问题');
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '纯回答' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const view = foldView(session);
    const t1 = view.filter((e) => e.transaction_id === 1);
    const thought = t1.find((e) => e.type === 'thought');
    expect(thought?.text ?? '').toBe(''); // 无 reasoning → thought 空
    const fin = t1.find((e) => e.type === 'fin');
    expect(fin?.text).toBe('纯回答'); // fin 仍含回答
  });
});
