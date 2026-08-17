/**
 * 类型桥：@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.6 发布包缺失 lib/types/index.d.ts
 * （package.json "types" 指向不存在的文件），此处提供最小环境声明供
 * test/wire-deepseek.test.ts 的真实 adapter 保真比对使用。
 * 仅测试基建；不影响运行时（lib 不 import 该包）。
 */
declare module '@deepseek-ai/dsh-llm-deepseek' {
  export class DeepSeekAdapter {
    constructor(config: unknown);
    request(
      options: {
        model?: string;
        system?: string;
        messages?: unknown[];
        sessionId?: string;
        [key: string]: unknown;
      },
      signal?: AbortSignal,
      connection?: { baseURL?: string; defaults?: { thinking?: string; reasoningEffort?: string }; [key: string]: unknown },
      apiKey?: string,
      userId?: string,
      onComment?: () => void,
    ): AsyncGenerator<unknown, void, unknown>;
  }
}
