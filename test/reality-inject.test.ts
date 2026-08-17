/**
 * 话题参考 reality 召回注入（lib/reality-inject.js）单测。
 * 覆盖：候选预筛（阈值 + 自注入排除）、内容压缩、注入消息构建（sections）、
 *       4B 拣选（prompt 构建 / 响应解析 / 空注入合法）。
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findRealityCandidates,
  condenseReality,
  buildRealityInjectionMessage,
  cosine,
  buildRealityPickPrompt,
  parseRealityPickResponse,
  loadRealityIndex,
  extractInjectionUserText,
} from '../lib/reality-inject.js';

const FENCE = String.fromCharCode(96, 96, 96);

interface RealityFixture {
  reality_id: number;
  name: string;
  hdl: string;
  current_status: Record<string, string[]>;
  centroid: number[];
  source_strands: Record<string, number[]>;
}
type RealityCandidate = { reality: RealityFixture; score: number };

/** 构造带 centroid 的 reality 索引 */
function mkIndex(): RealityFixture[] {
  return [
    { reality_id: 1, name: '深海主题插件开发', hdl: '已完成', current_status: { current_state: ['v1.0.0 已发布'] }, centroid: [1, 0, 0], source_strands: {} },
    { reality_id: 2, name: '评审引擎迭代', hdl: '进行中', current_status: { goals: ['修复缺陷'] }, centroid: [0, 1, 0], source_strands: { 'sess-A': [3] } },
    { reality_id: 3, name: '话题 C', hdl: '无关', current_status: {}, centroid: [0, 0, 1], source_strands: {} },
  ];
}

describe('reality-inject 召回', () => {
  it('cosine 基本正确', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it('按余弦阈值预筛 + topK 截断', () => {
    const cands = findRealityCandidates([0.99, 0.1, 0], mkIndex(), '', { minScore: 0.5, topK: 2 }) as RealityCandidate[];
    expect(cands).toHaveLength(1);
    expect(cands[0].reality.reality_id).toBe(1);
  });

  it('低于阈值不注入（宁缺勿错）', () => {
    const cands = findRealityCandidates([1, 1, 1], mkIndex(), '', { minScore: 0.65, topK: 2 });
    expect(cands).toHaveLength(0);
  });

  it('剔除 source_strands 含当前会话的 reality（防自注入）', () => {
    const cands = findRealityCandidates([0, 1, 0], mkIndex(), 'sess-A', { minScore: 0.5, topK: 2 }) as RealityCandidate[];
    expect(cands.some((c) => c.reality.reality_id === 2)).toBe(false);
    expect(cands).toHaveLength(0);
  });

  it('condenseReality 用英文短键，多值内联为全角分号，不重复 kind', () => {
    const text = condenseReality({
      name: 'R',
      hdl: 'H',
      current_status: { current_state: ['S1', 'S2'], goals: ['G1'], key_facts: ['F1'] },
    });
    expect(text).toContain('name: R');
    expect(text).toContain('status: H');
    expect(text).toContain('state: S1；S2');
    expect(text).toContain('goals: G1');
    expect(text).toContain('facts: F1');
    expect(text).not.toContain('kind');
  });

  it('buildRealityInjectionMessage：整段首行 kind: reference，多条用空行分隔且不重复 kind', () => {
    const candidates: RealityCandidate[] = [
      { reality: mkIndex()[0], score: 0.9 },
      { reality: mkIndex()[1], score: 0.8 },
    ];
    const { message } = buildRealityInjectionMessage(candidates, {}) as unknown as {
      message: { content?: Array<{ type?: string; text?: string }> };
    };
    const text = message.content?.[0]?.text ?? '';
    expect(text).toMatch(/^kind: reference\nname: 深海主题插件开发/);
    expect(text).toContain('\n\nname: 评审引擎迭代');
    expect((text.match(/kind: reference/g) ?? []).length).toBe(1);
  });

  it('buildRealityInjectionMessage：sections 含 reality_refs + 每候选 section，token 超限截断', () => {
    const candidates: RealityCandidate[] = [{ reality: mkIndex()[0], score: 0.9 }];
    type EstimateMessage = { content?: Array<{ type?: string; text?: string }> };
    const estimate = (m: EstimateMessage) => m.content?.[0]?.text?.length ?? 0;
    const { message, realityIds } = buildRealityInjectionMessage(candidates, { tokenLimit: 10 }, estimate) as unknown as {
      realityIds: number[];
      message: {
        content?: Array<{ type?: string; text?: string }>;
        source: { sections: Array<{ name: string; text: string }> };
      };
    };
    expect(realityIds).toEqual([1]);
    expect(message.source.sections.some((s) => s.name === 'reality_refs')).toBe(true);
    expect(message.source.sections.some((s) => s.name === 'reality-1')).toBe(true);
    expect((message.content?.[0]?.text ?? '').length).toBeLessThanOrEqual(10);
  });
});

describe('reality-inject 4B 拣选', () => {
  const pool = [
    { reality: mkIndex()[0], score: 0.8 },
    { reality: mkIndex()[1], score: 0.7 },
  ];

  it('buildRealityPickPrompt 含提问/候选/规则/输出格式', () => {
    const prompt = buildRealityPickPrompt('评审引擎进展', pool, 1);
    expect(prompt).toContain('评审引擎进展');
    expect(prompt).toContain('[0]');
    expect(prompt).toContain('深海主题插件开发');
    expect(prompt).toContain('宁缺勿错');
    expect(prompt).toContain('"selected"');
    expect(prompt).toContain('全新话题');
    expect(prompt).toContain('客观事实（reality）');
    expect(prompt).toContain('strand 才是工作线');
    expect(prompt).not.toContain('现实工作对象');
  });

  it('parseRealityPickResponse：正常解析 + 校验 index 越界', () => {
    const r = parseRealityPickResponse('{"selected": [{"index": 1, "relevance": "相关", "priority": 1}]}', 2);
    expect(r.status).toBe('ok');
    expect(r.picked).toHaveLength(1);
    expect(r.picked[0].index).toBe(1);
    const r2 = parseRealityPickResponse('{"selected": [{"index": 5, "relevance": "越界"}]}', 2);
    expect(r2.picked).toHaveLength(0);
  });

  it('parseRealityPickResponse：围栏包裹 / 空列表（宁缺勿错）均合法', () => {
    const fenced = parseRealityPickResponse(FENCE + 'json\n{"selected": [{"index": 0}]}\n' + FENCE, 2);
    expect(fenced.status).toBe('ok');
    expect(fenced.picked).toHaveLength(1);
    const empty = parseRealityPickResponse('{"selected": []}', 2);
    expect(empty.status).toBe('ok');
    expect(empty.picked).toHaveLength(0);
  });

  it('parseRealityPickResponse：非 JSON / 畸形 → error', () => {
    expect(parseRealityPickResponse('', 2).status).toBe('error');
    expect(parseRealityPickResponse('不是 JSON', 2).status).toBe('error');
  });

  it('parseRealityPickResponse：前导说明文字 + JSON 可解析；重复 index 去重', () => {
    const r = parseRealityPickResponse('候选如下\n{"selected": [{"index": 0}, {"index": 0}, {"index": 1}]}', 2);
    expect(r.status).toBe('ok');
    expect(r.picked).toHaveLength(2);
    expect(r.picked.map((p: { index: number }) => p.index)).toEqual([0, 1]);
  });

  it('source_strands 为 JSON null → 防自注入过滤不抛 TypeError（归一为 {}）', () => {
    const index = [{ reality_id: 1, centroid: [1, 0], source_strands: null }] as never;
    expect(findRealityCandidates([1, 0], index, 'sess-A', { minScore: 0.5, topK: 1 })).toHaveLength(1);
  });

  it('loadRealityIndex：realities 表缺列/schema 错误 → 返回 []（fail-open，不向外抛）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-reality-'));
    const path = join(dir, 'bad.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE realities (reality_id INTEGER)'); // 缺 hdl/centroid_json 等列
    db.close();
    try {
      expect(loadRealityIndex(path)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractInjectionUserText（首轮 view 空时序回退）', () => {
  function userMsg(text: string, sourceKind: string): { type: string; data: unknown } {
    return {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text }],
        source: sourceKind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: sourceKind },
      },
    };
  }

  function claimedMsg(text: string, sourceKind: string): unknown {
    return {
      content: [{ type: 'text', text }],
      source: sourceKind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: sourceKind },
    };
  }

  it('claimed 消息（pre-step payload.messages）优先于 view/事件（B10 权威来源）', () => {
    const claimed = [
      claimedMsg('approval', 'user-approval'),
      claimedMsg('本轮真实提问', 'user'),
    ];
    // view 有历史 user、事件也有历史 user——claimed 仍应胜出（pre-step 时刻唯一当前轮来源）
    const view = [{ type: 'user', text: '上一轮提问', transaction_id: 1 }];
    expect(extractInjectionUserText(view, { events: [userMsg('更早提问', 'user')] }, claimed)).toBe('本轮真实提问');
  });

  it('claimed 只有插件/系统消息 → 跳过（排除非用户输入），回落 view', () => {
    const claimed = [
      claimedMsg('system reminder', 'skill-catalog'),
      claimedMsg('ca-v7 reality', 'ca-v7'),
    ];
    const view = [{ type: 'user', text: '上一轮提问', transaction_id: 1 }];
    expect(extractInjectionUserText(view, undefined, claimed)).toBe('上一轮提问');
  });

  it('claimed 只有插件消息且 view 空 → 回落事件；事件也无真实 user → 空', () => {
    const claimed = [claimedMsg('approval', 'user-approval')];
    expect(extractInjectionUserText([], { events: [] }, claimed)).toBe('');
    const events = [userMsg('事件里的真实提问', 'user')];
    expect(extractInjectionUserText([], { events }, claimed)).toBe('事件里的真实提问');
  });

  it('view 有最近 user elm → 优先用 view 文本', () => {
    const view = [{ type: 'user', text: '当前提问', transaction_id: 1 }];
    expect(extractInjectionUserText(view, { events: [userMsg('历史提问', 'user')] })).toBe('当前提问');
  });

  it('view 空数组 → 回退会话事件取最近真实 user 消息（首轮时序修复主路径）', () => {
    const events = [
      userMsg('plugin-reminder', 'skill-catalog'),
      userMsg('首轮真实提问', 'user'),
    ];
    expect(extractInjectionUserText([], { events })).toBe('首轮真实提问');
  });

  it('view 为空且事件只有插件注入/系统消息 → 返回空（宁缺勿错）', () => {
    const events = [
      userMsg('ca-v7 reality', 'ca-v7'),
      userMsg('approval', 'user-approval'),
    ];
    expect(extractInjectionUserText([], { events })).toBe('');
  });

  it('view 非数组 + 无事件 → 空；事件为空数组 → 空', () => {
    expect(extractInjectionUserText(undefined, { events: [] })).toBe('');
    expect(extractInjectionUserText([], undefined)).toBe('');
  });
});
