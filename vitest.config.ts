import { defineConfig } from 'vitest/config';

/**
 * vitest 配置：只跑 test/ 目录的插件单测。
 * .research/（独立实验项目 acp-kernel/billion-context-dsh，缺仓库依赖）不被扫描；
 * 否则 vitest 默认 include 会扫到它们并因缺 acp-kernel 包而失败（噪音）。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,js}'],
  },
});
