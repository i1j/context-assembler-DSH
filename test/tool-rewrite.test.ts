/**
 * lib/tool-rewrite.js 单测（7.1 P4）
 *
 * 覆盖：纯函数计划生成（ACT→L1 / REL/FAR→L2 / tail 硬保护 / 表层可见性 /
 * 经济门槛 / 升序）；真实 Session 执行器（content-only replace 契约：
 * message.id/source/toolCallId/isError 保持，surfaceOp/sourceEventSeqs 形状，
 * 表层节点替换生效）。
 */
import { describe, it, expect } from 'vitest';
import { newSession, appendUser, appendToolPair } from './helpers.js';
import { planToolRewrites, executeToolRewrites, assembleRewrittenCtx } from '../lib/tool-rewrite.js';

/** 工具痕迹行夹具 */
function traceRow(over = {}) {
  return {
    rowId: 1,
    callId: 'c1',
    turn: 1,
    step: 1,
    callSeq: 10,
    resultSeq: 101,
    callTime: null,
    resultTime: null,
    durationMs: null,
    name: 'bash',
    description: '',
    argsJson: '{}',
    argsSummary: 'bash: pwd',
    resultSummary: 'bash: pwd → exit=0, ok | 关键输出'.padEnd(200, 'x'),
    hdl: 'bash: pwd → exit=0',
    error: null,
    exitCode: 0,
    isError: false,
    resultChars: 800,
    entities: ['tool:bash'],
    highValueFacts: [],
    status: 'completed',
    ...over,
  };
}

/** 视图夹具：4 个 user 事务，事务 1/2/3 各带一个 toolResult Elm（尾部 = 事务 3/4） */
function traceView() {
  return [
    { type: 'user', transaction_id: 1, elm_ref: 1 },
    { type: 'toolResult', transaction_id: 1, elm_ref: 101 },
    { type: 'user', transaction_id: 2, elm_ref: 2 },
    { type: 'toolResult', transaction_id: 2, elm_ref: 201 },
    { type: 'user', transaction_id: 3, elm_ref: 3 },
    { type: 'toolResult', transaction_id: 3, elm_ref: 301 },
    { type: 'user', transaction_id: 4, elm_ref: 4 },
  ];
}

describe('7.1 P4 工具结果改写', () => {
  it('计划生成：ACT→L1、REL→L2、FAR→L2、tail 硬保护、升序', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'ACT'], [2, 'REL'], [3, 'FAR']]);
    const rows = [
      traceRow({ rowId: 1, callId: 'c1', resultSeq: 101, resultSummary: 'L1-summary', hdl: 'L2-h1', resultChars: 900 }),
      traceRow({ rowId: 2, callId: 'c2', resultSeq: 201, resultSummary: 'L1-summary2', hdl: 'L2-h2', resultChars: 900 }),
      traceRow({ rowId: 3, callId: 'c3', resultSeq: 301, resultSummary: 'tail-summary', hdl: 'tail-hdl', resultChars: 900 }),
    ];
    const surfaceSeqs = new Set([101, 201, 301]);
    const plan = planToolRewrites(view, rows, grades, { tailTurns: 2, nearTurns: 0, minSavingChars: 400, surfaceSeqs });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ seq: 101, callId: 'c1', level: 'l1', text: 'L1-summary' });
    expect(plan[1]).toMatchObject({ seq: 201, callId: 'c2', level: 'l2', text: 'L2-h2' });
    expect(plan[0].seq).toBeLessThan(plan[1].seq);
  });

  it('P0 高价值事实升级：REL/FAR 含 highValueFacts 时改走 L1，否则仍 L2', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'REL'], [2, 'FAR'], [3, 'FAR']]);
    const rows = [
      traceRow({ rowId: 1, callId: 'c1', resultSeq: 101, resultSummary: 'L1-uri', hdl: 'L2-uri', resultChars: 900, highValueFacts: ['uri:viking://a'] }),
      traceRow({ rowId: 2, callId: 'c2', resultSeq: 201, resultSummary: 'L1-plain', hdl: 'L2-plain', resultChars: 900 }),
      traceRow({ rowId: 3, callId: 'c3', resultSeq: 301, resultSummary: 'tail', hdl: 'tail', resultChars: 900, highValueFacts: ['uri:viking://tail'] }),
    ];
    const surfaceSeqs = new Set([101, 201, 301]);
    const plan = planToolRewrites(view, rows, grades, { tailTurns: 2, nearTurns: 0, minSavingChars: 400, surfaceSeqs });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ seq: 101, callId: 'c1', level: 'l1' });
    expect(plan[0].text).toContain('L1-uri'); // P1-2 起 L1 带事实附录：uri:viking://a
    expect(plan[0].text).toContain('uri:viking://a');
    expect(plan[1]).toMatchObject({ seq: 201, callId: 'c2', level: 'l2', text: 'L2-plain' });
  });

  it('P1 §4.2/§3.4：L1 行追加事实附录——主体已含不重复，缺失补齐', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'ACT']]);
    const rows = [
      traceRow({
        rowId: 1, callId: 'c1', resultSeq: 101, resultChars: 2000,
        resultSummary: 'L1 has uri:viking://a', hdl: 'L2',
        highValueFacts: ['uri:viking://a', 'path:/src/x.ts', 'exit:1'],
      }),
    ];
    const surfaceSeqs = new Set([101]);
    const plan = planToolRewrites(view, rows, grades, { tailTurns: 0, minSavingChars: 1, surfaceSeqs });
    expect(plan).toHaveLength(1);
    expect(plan[0].level).toBe('l1');
    expect(plan[0].text).toContain('path:/src/x.ts');
    expect(plan[0].text).toContain('exit:1');
    expect((plan[0].text.match(/viking:\/\/a/g) ?? []).length).toBe(1); // 主体已含 → 不重复
  });

  it('P1 §4.2：附录预算截断——maxFacts/budgetChars 生效；无 highValueFacts 不追加', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'ACT'], [2, 'REL']]);
    const rows = [
      traceRow({
        rowId: 1, callId: 'c1', resultSeq: 101, resultChars: 2000, resultSummary: 'L1', hdl: 'L2',
        highValueFacts: ['exit:1', 'exit:2', 'exit:3', 'exit:4', 'exit:5', 'exit:6'],
      }),
      traceRow({ rowId: 2, callId: 'c2', resultSeq: 201, resultChars: 2000, resultSummary: 'L1', hdl: 'L2', highValueFacts: [] }),
    ];
    const surfaceSeqs = new Set([101, 201]);
    const plan = planToolRewrites(view, rows, grades, {
      tailTurns: 0, minSavingChars: 1, surfaceSeqs,
      factAppendixMaxFacts: 3, factAppendixBudgetChars: 1000,
    });
    expect(plan[0]).toMatchObject({ seq: 101, level: 'l1' });
    expect((plan[0].text.match(/exit:/g) ?? []).length).toBe(3); // 只补 3 条
    expect(plan[1]).toMatchObject({ seq: 201, level: 'l2', text: 'L2' }); // 无高价值事实 → 纯 hdl
  });

  it('P1 §4.5：近保护区渐进档——刚滑出硬保护区的轮次优先 L1，更旧轮次仍 L2', () => {
    const view = traceView(); // user 事务 1/2/3/4
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'FAR'], [2, 'FAR'], [3, 'FAR']]);
    const rows = [
      traceRow({ rowId: 1, callId: 'c1', resultSeq: 101, resultSummary: 'L1-old', hdl: 'L2-old', resultChars: 900 }),
      traceRow({ rowId: 2, callId: 'c2', resultSeq: 201, resultSummary: 'L1-near', hdl: 'L2-near', resultChars: 900 }),
      traceRow({ rowId: 3, callId: 'c3', resultSeq: 301, resultSummary: 'tail', hdl: 'tail', resultChars: 900 }),
    ];
    const surfaceSeqs = new Set([101, 201, 301]);
    // tailTurns=2 → 硬保护 事务 3/4；nearTurns=1 → 近保护区 事务 2；事务 1 更旧
    const plan = planToolRewrites(view, rows, grades, { tailTurns: 2, nearTurns: 1, minSavingChars: 400, surfaceSeqs });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ seq: 101, callId: 'c1', level: 'l2', text: 'L2-old' });
    expect(plan[1]).toMatchObject({ seq: 201, callId: 'c2', level: 'l1', text: 'L1-near' });
  });

  it('P1 §4.5：近保护区不改变硬保护——硬保护区仍永不替换', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[3, 'ACT']]);
    const rows = [traceRow({ rowId: 3, callId: 'c3', resultSeq: 301, resultSummary: 'L1', hdl: 'L2', resultChars: 900 })];
    const surfaceSeqs = new Set([301]);
    const plan = planToolRewrites(view, rows, grades, { tailTurns: 2, nearTurns: 1, minSavingChars: 1, surfaceSeqs });
    expect(plan).toEqual([]);
  });

  it('宁留原文：不可见 / 未完成 / 节省不足 / 无摘要 均不产生计划', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'ACT'], [2, 'REL']]);
    const rows = [
      traceRow({ callId: 'invisible', resultSeq: 101, resultChars: 900 }), // 不在 surfaceSeqs
      traceRow({ callId: 'called', resultSeq: 201, status: 'called', resultChars: 900 }),
      traceRow({ callId: 'small', resultSeq: 301, resultChars: 100, resultSummary: 'x'.repeat(80) }),
      traceRow({ callId: 'empty', resultSeq: 401, resultChars: 900, resultSummary: '', hdl: '' }),
    ];
    const surfaceSeqs = new Set([201, 301, 401]); // 101 不在表层（不可见）
    const plan = planToolRewrites(view, rows, grades, { tailTurns: 2, minSavingChars: 400, surfaceSeqs });
    expect(plan).toEqual([]);
  });

  it('tail=0 / 更高门槛的显式行为（不依赖默认值）', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[3, 'FAR']]);
    const rows = [traceRow({ callId: 'tail3', resultSeq: 301, resultSummary: 'L1', hdl: 'L2', resultChars: 900 })];
    const surfaceSeqs = new Set([301]);
    expect(planToolRewrites(view, rows, grades, { tailTurns: 2, minSavingChars: 400, surfaceSeqs })).toEqual([]);
    expect(planToolRewrites(view, rows, grades, { tailTurns: 0, minSavingChars: 400, surfaceSeqs })).toHaveLength(1);
    expect(planToolRewrites(view, rows, grades, { tailTurns: 0, minSavingChars: 1000, surfaceSeqs })).toEqual([]);
  });

  it('执行器：content-only replace 契约逐字段保持 + 表层节点替换生效', () => {
    const session = newSession('rewrite-exec');
    appendUser(session, 'run a command');
    session.append('turn/start', { turn: 1 });
    const { resultSeq } = appendToolPair(session, 1, 1, {
      callId: 'call-rw',
      name: 'bash',
      resultText: 'ok line\n'.repeat(100) + '[exit code: 0]',
    });
    const original = session.events.find((e) => e.type === 'tool/result' && e.seq === resultSeq) as
      | { type: 'tool/result'; seq: number; data: any }
      | undefined;
    expect(original).toBeTruthy();
    const originalMessage = original!.data.message;
    const applied = executeToolRewrites(session, [{ seq: resultSeq!, callId: 'call-rw', turn: 1, step: 1, level: 'l1', rawChars: 900, text: 'bash: pwd → exit=0', savingChars: 800 }]);
    expect(applied).toHaveLength(1);
    expect(applied[0].seq).toBe(resultSeq);
    expect(session.surface.nodes).not.toContain(resultSeq); // 原节点被遮蔽
    const repl = session.events.find((e) => e.seq === applied[0].appendedSeq) as
      | { type: 'tool/result'; seq: number; surfaceOp?: unknown; sourceEventSeqs?: unknown; data: any }
      | undefined;
    expect(repl?.type).toBe('tool/result');
    expect(repl?.surfaceOp).toEqual({ op: 'replace', start: resultSeq, end: resultSeq });
    expect(repl?.sourceEventSeqs).toEqual([resultSeq]);
    expect(repl!.data.message.id).toBe(originalMessage.id);
    expect(repl!.data.message.role).toBe(originalMessage.role);
    expect(repl!.data.message.source).toEqual(originalMessage.source);
    expect(repl!.data.turn).toBe(original!.data.turn);
    expect(repl!.data.step).toBe(original!.data.step);
    const block = repl!.data.message.content[0];
    const originalBlock = originalMessage.content[0];
    expect(block.type).toBe('tool-result');
    expect(block.toolCallId).toBe(originalBlock.toolCallId);
    expect(block.isError).toBe(originalBlock.isError);
    expect(block.content).toEqual([{ type: 'text', text: 'bash: pwd → exit=0' }]);
    expect(session.surface.nodes).toContain(repl!.seq); // 替换节点进入表层
  });
});

describe('7.1 P4→渐进：assembleRewrittenCtx（dry-run 留档，不注入）', () => {
  it('纯函数：生成改写映射 + 统计，不 append 任何事件', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'ACT'], [2, 'REL'], [3, 'FAR']]);
    const rows = [
      traceRow({ rowId: 1, callId: 'c1', resultSeq: 101, resultSummary: 'L1-summary', hdl: 'L2-h1', resultChars: 900 }),
      traceRow({ rowId: 2, callId: 'c2', resultSeq: 201, resultSummary: 'L1-summary2', hdl: 'L2-h2', resultChars: 900 }),
      traceRow({ rowId: 3, callId: 'c3', resultSeq: 301, resultSummary: 'tail-summary', hdl: 'tail-hdl', resultChars: 900 }),
    ];
    const surfaceSeqs = new Set([101, 201, 301]);
    const a = assembleRewrittenCtx(view, rows, grades, { tailTurns: 2, nearTurns: 0, minSavingChars: 400, surfaceSeqs });
    expect(a.plan).toHaveLength(2);
    expect(a.replacements).toHaveLength(2);
    expect(a.replacements[0]).toMatchObject({ seq: 101, level: 'l1', after: 'L1-summary' });
    expect(a.replacements[1]).toMatchObject({ seq: 201, level: 'l2', after: 'L2-h2' });
    expect(a.stats).toMatchObject({ planned: 2, l1: 1, l2: 1 });
    expect(a.stats.savedChars).toBeGreaterThan(0);
    expect(a.stats.savePct).toBeGreaterThan(0);
  });

  it('before 缺省回退占位（无痕迹行时仍可汇编）', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'ACT']]);
    const rows = [traceRow({ callId: 'c1', resultSeq: 101, resultSummary: '', hdl: '', resultChars: 900 })];
    const surfaceSeqs = new Set([101]);
    // 无摘要 → 不产生计划；统计全 0
    const a = assembleRewrittenCtx(view, rows, grades, { tailTurns: 0, minSavingChars: 1, surfaceSeqs });
    expect(a.plan).toEqual([]);
    expect(a.stats).toMatchObject({ planned: 0, rawChars: 0, savePct: 0 });
  });

  it('rawTextBySeq：提供原文时 before 存原文（归档可自证），缺省回退 resultSummary', () => {
    const view = traceView();
    const grades = new Map<number, 'ACT' | 'REL' | 'FAR'>([[1, 'ACT']]);
    const rows = [traceRow({ callId: 'c1', resultSeq: 101, resultSummary: 'L1-summary', hdl: '', resultChars: 900 })];
    const surfaceSeqs = new Set([101]);
    const withRaw = assembleRewrittenCtx(view, rows, grades, {
      tailTurns: 0, minSavingChars: 1, surfaceSeqs,
      rawTextBySeq: new Map([[101, '原始工具输出全文 900 字符']]),
    });
    expect(withRaw.replacements[0].before).toBe('原始工具输出全文 900 字符');
    // 未提供原文：before 回退 resultSummary
    const withoutRaw = assembleRewrittenCtx(view, rows, grades, { tailTurns: 0, minSavingChars: 1, surfaceSeqs });
    expect(withoutRaw.replacements[0].before).toBe('L1-summary');
  });
});
