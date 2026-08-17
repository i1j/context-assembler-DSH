/**
 * lib/entity-graph.js 单测（7.1 P3：实体工作对象定级 = reality 图边扩充）
 *
 * 覆盖：实体归一化与优先级截断；txn 实体映射；path child_of / 同事务 cooccurs_with
 * 边与权重；无向 BFS 图距离定级（d≤1 ACT / d=2 REL / 不可达 FAR）；无实体回落空 Map。
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeEntity,
  valuableEntities,
  extractQuestionEntities,
  mapTxnEntities,
  buildEntityGraph,
  gradeByEntityGraph,
  entityGradeView,
  mergeEntityGraphs,
} from '../lib/entity-graph.js';

describe('7.1 P3 entity-graph', () => {
  it('normalizeEntity：path 归一化 / ident 小写 / 非路径原样', () => {
    expect(normalizeEntity('path:/a/b/')).toBe('path:/a/b');
    expect(normalizeEntity('path:./x/../y')).toBe('path:y');
    expect(normalizeEntity('ident:Foo.Bar')).toBe('ident:foo.bar');
    expect(normalizeEntity('tool:Bash')).toBe('tool:Bash');
    expect(normalizeEntity('')).toBeNull();
  });

  it('valuableEntities：优先 path/tool 且去重截断', () => {
    const out = valuableEntities(['ident:z', 'path:/a', 'tool:bash', 'path:/a', 'path:/b', 'uri:viking://x'], 3);
    expect(out).toEqual(['path:/a', 'path:/b', 'tool:bash']);
  });

  it('extractQuestionEntities：从提问文本确定性提取（无实体 → 空）', () => {
    expect(extractQuestionEntities('请查看 /tmp/a.md 并运行 pnpm test').some((e) => e.startsWith('path:'))).toBe(true);
    expect(extractQuestionEntities('你好')).toEqual([]);
  });

  it('mapTxnEntities：toolTrace 行经视图 toolResult elm 归事务', () => {
    const view = [
      { type: 'toolResult', transaction_id: 1, elm_ref: 101 },
      { type: 'toolResult', transaction_id: 2, elm_ref: 201 },
    ];
    const rows = [
      { resultSeq: 101, entities: ['path:/a/b', 'tool:bash'] },
      { resultSeq: 201, entities: ['path:/a/c'] },
      { resultSeq: 999, entities: ['path:/orphan'] }, // 无对应 Elm → 不归入
    ];
    const m = mapTxnEntities(view, rows);
    expect([...m.keys()]).toEqual([1, 2]);
    expect(m.get(1)).toEqual(['path:/a/b', 'tool:bash']);
  });

  it('buildEntityGraph：child_of 层级边 + cooccurs_with 同事务边与权重', () => {
    const txnEntities = new Map([
      [1, ['path:/a/b', 'tool:bash']],
      [2, ['path:/a/c', 'tool:bash']],
    ]);
    const g = buildEntityGraph(txnEntities);
    expect(g.nodes.has('path:/a')).toBe(true); // 父目录节点自动注册
    const child = g.edges.find((e) => e.kind === 'child_of');
    expect(child).toBeTruthy();
    expect([child!.from, child!.to]).toContain('path:/a/b');
    expect([child!.from, child!.to]).toContain('path:/a');
    const co = g.edges.find((e) => e.kind === 'cooccurs_with' && e.from === 'path:/a/b' && e.to === 'tool:bash');
    expect(co).toBeTruthy();
    const co2 = g.edges.find((e) => e.kind === 'cooccurs_with' && e.from === 'path:/a/c' && e.to === 'tool:bash');
    expect(co2).toBeTruthy();
    expect(g.adjacency.get('path:/a')?.get('path:/a/b')).toBe(1);
  });

  it('gradeByEntityGraph：d=0 ACT / 经共享父目录 d=2 REL / 不可达 FAR', () => {
    const txnEntities = new Map([
      [1, ['path:/a/b', 'tool:bash']],
      [2, ['path:/a/c', 'tool:read']],
      [3, ['path:/x/y', 'tool:write']],
    ]);
    const g = buildEntityGraph(txnEntities);
    const grades = gradeByEntityGraph(txnEntities, valuableEntities(['path:/a/b']), g);
    expect(grades.get(1)).toBe('ACT'); // 直接命中
    expect(grades.get(2)).toBe('REL'); // /a/b → /a → /a/c 两步
    expect(grades.get(3)).toBe('FAR'); // 不可达
    expect(gradeByEntityGraph(txnEntities, [], g).size).toBe(0); // 无提问实体 → 回落
  });

  it('mergeEntityGraphs：会话内图 ⊕ 冷启动图，邻接并集（BFS 可跨会话连通）', () => {
    const base = buildEntityGraph(new Map([[1, ['path:/now/p', 'tool:bash']]]));
    const cold = buildEntityGraph(new Map([[99, ['path:/old/q', 'path:/now/p']]]));
    const merged = mergeEntityGraphs(base, cold);
    expect(merged.adjacency.get('path:/now/p')?.has('path:/old/q')).toBe(true);
    expect(merged.adjacency.get('path:/old/q')?.has('path:/now/p')).toBe(true);
    expect(merged.nodes.has('path:/now/p')).toBe(true);
  });

  it('entityGradeView：一栈式映射；无实体/无行 → 空 grades（调用方回落文本定级）', () => {
    const view = [{ type: 'toolResult', transaction_id: 1, elm_ref: 101 }];
    const rows = [{ resultSeq: 101, entities: ['path:/a/b', 'tool:bash'] }];
    const r = entityGradeView(view, rows, '请处理 /a/b', undefined);
    expect(r.grades.get(1)).toBe('ACT');
    expect(r.graph).not.toBeNull();
    expect(entityGradeView([], [], 'x', undefined).grades.size).toBe(0);
    expect(entityGradeView(view, rows, '', undefined).grades.size).toBe(0);
  });
});
