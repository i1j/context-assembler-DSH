/**
 * DeepSeek chat-completions wire 序列化镜像 + DSH 原生固定密度计价。
 *
 * 镜像源：@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.6 lib/index.js
 *   - flattenText / serializeAssistant / serializeMessages（上游未导出，此处忠实镜像；
 *     serializeMessages 位于该文件「Serialize the conversation」注释段）
 *   - 关键 wire 语义：tool-result 块展开为独立 {role:'tool'} 消息；空输出必须给 "(no output)"；
 *     reasoning_content 仅在 assistant 携带 tool_calls 时回传；user 消息先出文本、后跟 tool 消息。
 * 计价源：@deepseek-ai/dsh-token-meter lib/index.js estimate（CHARS_PER_TOKEN=4、
 *   BLOCK_OVERHEAD=4、消息 role framing +4）——DSH 自身的 token 计价口径。
 * 保真验证：test/wire-deepseek.test.ts 用真实 DeepSeekAdapter.request + mock fetch
 *   抓取真实 wire body.messages 与 serializeMessages 逐字比对（toStrictEqual）。
 * 范围：reasoning_content/tool_calls 字段字节不参与计价（计价对象为 tool 消息内容，
 *   工具结果改写前后 reasoning/tool_calls 不变、相互抵消）。
 */

export const CHARS_PER_TOKEN = 4;
export const BLOCK_OVERHEAD = 4;
export const ROLE_FRAMING = 4;

/** 拼接 text 块文本（镜像上游 flattenText）。 */
export function flattenText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** 序列化一条 assistant 消息（镜像上游 serializeAssistant）。 */
export function serializeAssistant(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = flattenText(blocks);
  const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('');
  const toolCalls = blocks.filter((b) => b.type === 'tool-call').map((b) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: b.arguments },
  }));
  return {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/** 递归检测 image 块（与真实 adapter contentHasImage 同语义：tool-result 嵌套 content 也检查） */
function contentHasImage(blocks) {
  return (Array.isArray(blocks) ? blocks : []).some((block) =>
    block?.type === 'image'
    || (block?.type === 'tool-result' && contentHasImage(block.content)),
  );
}

/**
 * 把 harness 会话消息序列化为 DeepSeek wire 消息（镜像上游 serializeMessages）。
 * @param {Array<{role: string, content: any[]}>} messages harness 消息列表
 * @returns {Array<Record<string, unknown>>} wire 消息（顺序保持，每条 tool result 展开为独立消息）
 */
export function serializeMessages(messages) {
  const wire = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    if (contentHasImage(blocks)) {
      throw new Error('The DeepSeek chat-completions adapter does not support image content.');
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(blocks) });
      continue;
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = blocks.filter((block) => block?.type === 'tool-result');
    const text = flattenText(blocks);
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text });
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content ?? []) || '(no output)',
      });
    }
  }
  return wire;
}

/** 单条 tool result 的 wire 形态（bench --exact-tokens 用）。 */
export function toolResultWire(callId, text) {
  return [{ role: 'tool', tool_call_id: callId, content: String(text ?? '') || '(no output)' }];
}

/**
 * DSH 原生固定密度计价（estimate.ts 语义，作用在 wire 消息 content 上）。
 * @param {Array<Record<string, unknown>>} wire serializeMessages/toolResultWire 的输出
 * @returns {number} 启发式 token 数
 */
export function estimateWireTokens(wire) {
  let tokens = 0;
  for (const message of Array.isArray(wire) ? wire : []) {
    const content = typeof message?.content === 'string' ? message.content : '';
    tokens += Math.ceil(content.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD + ROLE_FRAMING;
  }
  return tokens;
}
