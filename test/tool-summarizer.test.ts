/**
 * lib/tool-summarizer.js 单测——Hermes per-tool Fct/Hdl 的 DSH 移植。
 * 覆盖：参数摘要过滤 bulk 字段、bash 退出码/stderr、read 路径+行数、edit/write、
 * MCP JSON 关键字段、实体提取、view 投影工具 Elm 承载摘要文本。
 */
import { homedir } from 'node:os';
const HOME = homedir();

import { describe, expect, it } from 'vitest';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import {
  summarizeToolCall,
  summarizeToolPair,
  parseToolArguments,
  extractEntities,
  headTailTruncate,
} from '../lib/tool-summarizer.js';
import { initViewState, applyViewState, viewViewState } from '../lib/view.js';

describe('tool-summarizer 参数与实体', () => {
  it('summarizeToolCall：bash 保留命令摘要、read/edit 保留路径、过滤 bulk 字段', () => {
    const bash = summarizeToolCall({ name: 'bash', arguments: JSON.stringify({ command: 'grep -R foo .', description: '搜索 foo' }) });
    expect(bash.name).toBe('bash');
    expect(bash.text).toContain('bash:');
    expect(bash.text).toContain('grep -R foo .');
    expect(bash.args).toHaveProperty('command'); // 内部完整参数保留
    expect(bash.toolArgs).toHaveProperty('description'); // 自然语言意图描述是价值锚点，保留
    expect(bash.toolArgs).not.toHaveProperty('command'); // bulk 字段不进入输出参数

    const read = summarizeToolCall({ name: 'read', arguments: JSON.stringify({ file_path: `${HOME}/a/b.ts`, offset: 1, limit: 100 }) });
    expect(read.text).toBe('read: ~/a/b.ts');
  });

  it('parseToolArguments 解析 JSON 字符串，畸形输入回退空对象', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments('不是 json')).toEqual({});
  });

  it('headTailTruncate：小 maxLen（tail≤0）时返回值不超过上限（slice(-0) 回归）', () => {
    expect(headTailTruncate('abcdef', 2)).toBe('ab');
    expect(headTailTruncate('abcdef', 1)).toBe('a');
    expect(headTailTruncate('abcdef', 3)).toBe('a…f');
    expect(headTailTruncate('abcdef', 10)).toBe('abcdef');
  });

  it('summarizeToolCall：空/纯空白工具名回退 unknown_tool', () => {
    expect(summarizeToolCall({ name: '', arguments: '{"query":"x"}' }).name).toBe('unknown_tool');
    expect(summarizeToolCall({ name: '   ', arguments: '{}' }).name).toBe('unknown_tool');
    expect(summarizeToolCall({ name: 'bash', arguments: '{}' }).name).toBe('bash');
  });

  it('extractEntities：路径/命令/URI/工具名/退出码', () => {
    const entities = extractEntities(
      { command: `pnpm vitest run ${HOME}/dsh-workspace/ca-v7/test/a.ts` },
      'viking://user/tester/resources/x\n[exit code: 1]',
      'bash',
    );
    expect(entities.some((e) => e === 'tool:bash')).toBe(true);
    expect(entities.some((e) => e.startsWith('path:'))).toBe(true);
    expect(entities.some((e) => e.startsWith('bin:pnpm'))).toBe(true);
    expect(entities.some((e) => e.startsWith('uri:viking://'))).toBe(true);
    expect(entities.some((e) => e === 'exit:1')).toBe(true);
  });
});

describe('tool-summarizer 结果摘要', () => {
  it('bash：解析 [exit code] 与 [stderr]，非零退出标记 error', () => {
    const out = summarizeToolPair(
      { name: 'bash', arguments: JSON.stringify({ command: 'pytest' }) },
      { message: createToolResultMessage({ callId: CallId('c1'), content: [{ type: 'text', text: 'collecting...\n1 passed, 0 failed\n[stderr]\nboom\n[exit code: 1]' }], isError: false }) },
    );
    expect(out.resultSummary).toContain('exit=1');
    expect(out.resultSummary).toContain('stderr:');
    expect(out.error).toBe('exit_code=1');
    expect(out.exitCode).toBe(1);
  });

  it('read：解析 DSH <path>/<type>/<content> 包装，给出行数与首尾预览', () => {
    const out = summarizeToolPair(
      { name: 'read', arguments: JSON.stringify({ file_path: `${HOME}/x.md` }) },
      { message: createToolResultMessage({ callId: CallId('c2'), content: [{ type: 'text', text: `<path>${HOME}/x.md</path>\n<type>file</type>\n<content>\n` + 'a\n'.repeat(30) + 'z\n</content>' }], isError: false }) },
    );
    expect(out.resultSummary).toContain('read ~/x.md');
    expect(out.resultSummary).toContain('31行');
  });

  it('edit：成功/失败摘要只保留路径与状态，不保留 old_string/new_string', () => {
    const ok = summarizeToolPair(
      { name: 'edit', arguments: JSON.stringify({ file_path: `${HOME}/x.ts`, old_string: 'A'.repeat(500), new_string: 'B'.repeat(500) }) },
      { message: createToolResultMessage({ callId: CallId('c3'), content: [{ type: 'text', text: `The file ${HOME}/x.ts has been updated successfully.` }], isError: false }) },
    );
    expect(ok.resultSummary).toContain('edit ~/x.ts: ok');
    expect(ok.resultSummary).not.toContain('AAAA');
    const fail = summarizeToolPair(
      { name: 'write', arguments: JSON.stringify({ file_path: `${HOME}/x.ts`, content: 'A'.repeat(500) }) },
      { message: createToolResultMessage({ callId: CallId('c4'), content: [{ type: 'text', text: 'denied' }], isError: true }) },
    );
    expect(fail.resultSummary).toContain('write ~/x.ts: error');
  });

  it('mcp__openviking__find：JSON 提取 items 数量与标题', () => {
    const out = summarizeToolPair(
      { name: 'mcp__openviking__find', arguments: JSON.stringify({ query: 'CA assembler' }) },
      { message: createToolResultMessage({ callId: CallId('c5'), content: [{ type: 'text', text: JSON.stringify({ title: '检索结果', items: [1, 2, 3], abstract: '找到三条记忆' }) }], isError: false }) },
    );
    expect(out.resultSummary).toContain('检索结果');
    expect(out.resultSummary).toContain('3 items');
  });
});

describe('view 投影工具摘要（DSH 移植落点）', () => {
  function appendToolTurn(session: Session, turn: number, step: number, name: string, args: string, resultText: string) {
    session.append('turn/start', { turn });
    session.append('user/message', {
      role: 'user', id: 'u' + turn, content: [{ type: 'text', text: 'u' + turn }], source: { kind: 'user' },
    } as never, { surfaceOp: 'append' });
    session.append('step/start', { turn, step });
    const cid = CallId('call-' + turn + '-' + step);
    session.append('assistant/message', {
      turn, step,
      message: { role: 'assistant', id: 'a' + turn, content: [{ type: 'tool-call', id: cid, name, arguments: args }], source: { kind: 'model', provider: 'p', model: 'm' } },
    } as never, { surfaceOp: 'append' });
    session.append('tool/call', { turn, step, callId: cid, name, arguments: args });
    session.append('tool/result', {
      turn, step,
      message: createToolResultMessage({ callId: cid, content: [{ type: 'text', text: resultText }], isError: false }),
    }, { surfaceOp: 'append' });
    session.append('assistant/message', {
      turn, step,
      message: { role: 'assistant', id: 'f' + turn, content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    } as never, { surfaceOp: 'append' });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }

  it('toolCall/toolResult Elm text 承载结构化摘要而非空串', () => {
    const session = Session.create(SessionId('tool-view'));
    appendToolTurn(session, 1, 1, 'bash', JSON.stringify({ command: 'grep foo .', description: '找 foo' }), 'a.py:1: foo\n[stderr]\nnone\n[exit code: 1]');
    let state = initViewState();
    for (const evt of session.events) state = applyViewState(state, evt);
    const view = viewViewState(state);
    // 视图既有 assistant 携带 tool-call 的 Elm，也有独立 tool/call Elm；后者承载结构化意图摘要
    const call = view.filter((e) => e.type === 'toolCall').find((e) => e.text.includes('bash:'));
    const result = view.find((e) => e.type === 'toolResult');
    expect(call?.text).toContain('bash:');
    expect(result?.text).toContain('exit=1');
    expect(result?.text).toContain('a.py:1: foo');
  });
});

describe('7.1 稳定化：结果摘要关键事实实体后缀（R1-R3）', () => {
  const pair = (name: string, args: Record<string, unknown>, resultText: string, isError = false) => summarizeToolPair(
    { name, arguments: JSON.stringify(args) },
    { message: createToolResultMessage({ callId: CallId('r-' + name), content: [{ type: 'text', text: resultText }], isError }) },
  );

  it('R1 bash：命令中的路径实体进入 L1 摘要文本（结果文本不含路径）', () => {
    const out = pair(
      'bash',
      { command: `cd ${HOME}/dsh-workspace/ca-v7 && pnpm test ${HOME}/dsh-workspace/ca-v7/test/a.test.ts` },
      'collecting...\n1 passed\n[exit code: 0]',
    );
    expect(out.resultSummary).toContain('~/dsh-workspace/ca-v7');
    expect(out.resultSummary).toContain('~/dsh-workspace/ca-v7/test/a.test.ts');
    expect(out.resultSummary).toContain('exit=0');
  });

  it('R2 bash：hdl 未含路径（命令前缀截断后）时追加缺失路径', () => {
    // 路径位于命令 48 字符之后：hdl 的命令前缀截断不含它 → 后缀应补入
    const out = pair('bash', { command: `printf "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" > ${HOME}/repo/notes/x.md` }, '[exit code: 0]');
    expect(out.hdl).toContain('~/repo/notes/x.md');
  });

  it('R1 mcp（OpenViking list 类）：结果侧 viking:// URI 进入摘要（修复前只有 args 侧/数量）', () => {
    const items = Array.from({ length: 12 }, (_, i) => '{"uri":"viking://resources/ca/think/s' + i + '.md","title":"S' + i + '"}').join(',');
    const out = pair('mcp__openviking__list', { uri: 'viking://resources/ca/think/' }, '{"items":[' + items + ']}');
    expect(out.resultSummary).toContain('viking://resources/ca/think/s0.md');
  });

  it('R1 generic（run_code 类）：结果文本后段路径进入摘要', () => {
    const out = pair(
      'run_code',
      { code: 'x', description: 'demo' },
      `line1\nline2\nline3\nresult saved to ${HOME}/dsh-workspace/ca-v7/out/data.json\nline5`,
    );
    expect(out.resultSummary).toContain('~/dsh-workspace/ca-v7/out/data.json');
  });

  it('R3 幂等：文本已含路径不重复追加', () => {
    const out = pair(
      'bash',
      { command: `ls ${HOME}/repo/x` },
      `file at ${HOME}/repo/x listed\n[exit code: 0]`,
    );
    const occurrences = (out.resultSummary.match(/repo\/x/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('R3 预算：多实体只追加 ≤max 条（text≤4，hdl≤2）', () => {
    const cmd = Array.from({ length: 30 }, (_, i) => `echo ${HOME}/big/path/` + i).join(' && ');
    const out = pair('bash', { command: cmd }, '[exit code: 0]');
    expect((out.resultSummary.match(/path:/g) ?? []).length).toBeLessThanOrEqual(4);
    expect((out.hdl.match(/path:/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it('R1 generic（run_code 类）：多 URI 超预算时按 uri>path>bin 优先级保留（budget 内 uri 优先）', () => {
    const resultText = [
      '{',
      '  "name": "dsh-profile-web",',
      '  "dependencies": {',
      '    "@dsh-external/a": "git+https://github.com/org-a/dsh-a.git",',
      '    "@dsh-external/b": "git+https://github.com/org-b/dsh-b.git",',
      '    "@dsh-external/c": "git+https://github.com/org-c/dsh-c.git",',
      '    "@dsh-external/d": "git+https://github.com/org-d/dsh-d.git"',
      '  }',
      '}',
    ].join('\n');
    const out = pair('run_code', { code: 'x', description: 'demo' }, resultText);
    // 4 个 URI 均缺失且总长超 budget：text max=4/budget=280 应全量保留 uri（不被 bin/path 挤占）
    expect((out.resultSummary.match(/uri:https:\/\/github\.com\//g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(out.resultSummary).toContain('uri:https://github.com/org-a/dsh-a.git');
    expect(out.resultSummary).toContain('uri:https://github.com/org-d/dsh-d.git');
  });

  it('R3 无缺失实体：不追加任何后缀（无 path/uri/bin 前缀）', () => {
    const out = pair('bash', { command: 'echo hi' }, '[exit code: 0]');
    expect(out.resultSummary).toContain('exit=0');
    expect(out.resultSummary).not.toContain('path:');
    expect(out.resultSummary).not.toContain('bin:');
    expect(out.resultSummary).not.toContain('uri:');
    expect(out.hdl).not.toContain('path:');
  });
});

describe('高损失工具专用摘要规则（改进方案 §3.1）', () => {
  const pair = (name: string, args: Record<string, unknown>, resultText: string, isError = false) => summarizeToolPair(
    { name, arguments: JSON.stringify(args) },
    { message: createToolResultMessage({ callId: CallId('hl-' + name), content: [{ type: 'text', text: resultText }], isError }) },
  );

  it('web_search：保留来源 title + url（top N），不丢来源标识', () => {
    const out = pair('web_search', { query: 'DSH plugins' }, [
      'Sources:',
      '- [Oh-DSH-Desktop](https://raw.githubusercontent.com/hust-open-atom-club/oh-dsh/main/README.md)',
      '- [awesome-DSH-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)',
      '- [DSH-better-sidebar](https://github.com/x/dsh-better-sidebar)',
      '- [dsh-theme-pack](https://github.com/y/dsh-theme-pack)',
    ].join('\n'));
    expect(out.resultSummary).toContain('Oh-DSH-Desktop');
    expect(out.resultSummary).toContain('https://raw.githubusercontent.com/hust-open-atom-club/oh-dsh/main/README.md');
    expect(out.resultSummary).toContain('awesome-DSH-plugin');
    expect(out.resultSummary).toContain('https://github.com/x/dsh-better-sidebar');
  });

  it('web_search：无结构化来源时回退关键行（不崩、含查询）', () => {
    const out = pair('web_search', { query: 'x' }, 'no results found for x');
    expect(out.resultSummary).toContain('web_search x');
  });

  it('workflow：保留执行标题与 Return value 关键字段，丢弃逐 agent 日志', () => {
    const out = pair('workflow', { description: 'rereview' }, [
      'workflow "ca-v7-v1.18-rereview" completed (6 agents).',
      'Return value:',
      '{"conclusion":"三文档通读完成","status":"ok","logs":["agent1...","agent2..."]}',
    ].join('\n'));
    expect(out.resultSummary).toContain('workflow "ca-v7-v1.18-rereview" completed (6 agents)');
    expect(out.resultSummary).toContain('conclusion=三文档通读完成');
    expect(out.resultSummary).toContain('status=ok');
    expect(out.resultSummary).not.toContain('agent1');
  });

  it('mcp__openviking__search：文本列表保留命中数与 top N URI（真实格式 Found N item(s)）', () => {
    const out = pair('mcp__openviking__search', { query: 'ultrawide' }, [
      'Found 10 item(s):',
      '',
      '- [resource 55%] viking://resources/projects/dsh-ultrawide-ui/README.md/README.md',
      '    超宽屏适配方案摘要……',
      '- [resource 52%] viking://resources/projects/dsh-ultrawide-ui/.abstract.md',
      '    目录名称与简要描述……',
    ].join('\n'));
    expect(out.resultSummary).toContain('10 items');
    expect(out.resultSummary).toContain('viking://resources/projects/dsh-ultrawide-ui/README.md/README.md');
    expect(out.resultSummary).toContain('viking://resources/projects/dsh-ultrawide-ui/.abstract.md');
  });

  it('mcp__openviking__read：markdown 正文保留来源标题行（首行）', () => {
    const out = pair('mcp__openviking__read', { uri: 'viking://resources/ca/think/x.md' }, [
      '> 来源：devtest-workflow references/review-experience/completeness.md（2026-08-13 迁移）',
      '',
      '# 评审经验：完整性视角',
      '正文……',
    ].join('\n'));
    expect(out.resultSummary).toContain('devtest-workflow references/review-experience/completeness.md');
  });

  it('highValueFacts：uri/error/exit 进入清单，普通路径不滥进', () => {
    const out = pair(
      'bash',
      { command: `cat ${HOME}/x.ts` },
      'boom\n[exit code: 2]',
      true,
    );
    expect(out.highValueFacts.some((f) => f.startsWith('exit:2'))).toBe(true);
    expect(out.highValueFacts.some((f) => f.startsWith('error:'))).toBe(true);

    const mcp = pair('mcp__openviking__search', { query: 'a' }, 'Found 1 item(s):\n- [x 10%] viking://resources/a/b.md\n    摘要');
    expect(mcp.highValueFacts.some((f) => f.startsWith('uri:viking://resources/a/b.md'))).toBe(true);
  });

  it('openviking 文本列表 hdl：含 URI 时不含 undefined items（?? 与三元优先级修复）', () => {
    // 真实场景：URI 存在但无 "Found N item" 前缀 → hdl 不得出现 "undefined items"
    const out = pair('mcp__openviking__glob', { pattern: '**/*.md' }, '- viking://resources/ca/a.md\n- viking://resources/ca/b.md');
    expect(out.hdl).toContain('viking://resources/ca/a.md');
    expect(out.hdl).not.toContain('undefined');
  });
});

describe('tool-summarizer ask_user_question 特化（所见即所记，2026-08-18）', () => {
  it('summarizeToolCall：完整可读提问列表（question + header + options），不丢信息', () => {
    const call = summarizeToolCall({
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [
          { id: 'a', question: '摘要数据源用哪层？', header: 'Choose Mode', options: [{ label: 'A. 投影（推荐）' }, { label: 'B. 数据库' }] },
          { id: 'b', question: '确认重启？', options: [{ label: '重启' }] },
        ],
      }),
    });
    expect(call.name).toBe('ask_user_question');
    expect(call.text).toContain('摘要数据源用哪层？ — Choose Mode');
    expect(call.text).toContain('- A. 投影（推荐）');
    expect(call.text).toContain('- B. 数据库');
    expect(call.text).toContain('确认重启？');
    expect(call.text).toContain('- 重启');
    // 通用规则只取第一个 question 字段——特化必须保留全部
    expect(call.text.split('\n').length).toBeGreaterThanOrEqual(5);
  });

  it('summarizeToolPair：用户回答转成可读文本（selected + 自定义），非原始 JSON 代码段', () => {
    const pair = summarizeToolPair(
      { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'a', question: '继续？' }] }) },
      { message: { content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'a', selected: ['A. 投影（推荐）'], custom: '' }] }) }] } },
    );
    expect(pair.name).toBe('ask_user_question');
    expect(pair.resultSummary).toBe('A. 投影（推荐）');
    expect(pair.resultSummary).not.toContain('"answers"'); // 不再是 JSON 代码
    expect(pair.resultSummary).not.toContain('{');
    expect(pair.hdl).toContain('A. 投影（推荐）');
    expect(pair.isError).toBe(false);
  });

  it('summarizeToolPair：多问题回答 + 自定义输入（custom）合并', () => {
    const pair = summarizeToolPair(
      { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'a', question: 'q1' }, { id: 'b', question: 'q2' }] }) },
      { message: { content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'a', selected: ['X'] }, { id: 'b', selected: [], custom: '其他方案' }] }) }] } },
    );
    expect(pair.resultSummary).toContain('X');
    expect(pair.resultSummary).toContain('自定义: 其他方案');
    // 两回答分行
    expect(pair.resultSummary.split('\n').length).toBe(2);
  });

  it('summarizeToolPair：无回答/畸形载荷 → 不崩，hdl 回退 ask_user_question', () => {
    const empty = summarizeToolPair(
      { name: 'ask_user_question', arguments: JSON.stringify({ questions: [] }) },
      { message: { content: [] } },
    );
    expect(empty.hdl).toBe('ask_user_question');
    const broken = summarizeToolPair(
      { name: 'ask_user_question', arguments: JSON.stringify({ questions: [] }) },
      { message: { content: [{ type: 'text', text: 'not json' }] } },
    );
    expect(broken.hdl).toContain('ask_user_question');
    expect(broken.isError).toBe(false);
  });
});
