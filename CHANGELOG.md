# Changelog

## 0.99.0 (2026-08-18) — Context Assembler DSH V0.99 首次公开发布（中文全称：上下文汇编）

Context Assembler（上下文汇编）的 DeepSeek Harness 插件版公开首发，承接 Hermes
`ca_assembler` 的设计意图（见 [docs/DESIGN.md](docs/DESIGN.md)），在 DSH 插件框架下实现。

### 核心能力

- **话题块上下文汇编**：按话题块构建「本块视角」的会话摘要版本，块内前缀稳定、云端缓存友好；
- **水位压力话题切割**：ctx 字符上涨线性扣减 Jaccard，满压必切（`forceAtPeak`），单话题长会话不再锁死；
- **话题定级与冻结**：切换时快照 ACT/REL/FAR 定级、块内复用、新轮 ACT（确定性、无 LLM）；
- **工具轮压缩**：`toolCall`/`toolResult` 结构化摘要（确定性）+ wire 级工具结果改写（可 dry-run）；
- **reality 召回注入**：本地 4B embedding + 拣选，话题块开头注入背景资料（fail-open）；
- **思考卡（OODA）装配**：thought+tool 合流 + L1 事实附录（本地 4B，默认关、渐进验证）；
- **handoff 规划**：压力触发会话交接（分支摘要 / 边强度 / 视角 / 路由策略）；
- **`ca-db` 公开库**：话题 / realities 持久化 DDL 与辅助导出。

### 工程

- 测试 38 文件 429 用例全绿；`tsc --noEmit` 干净；
- 修复发布前隐私问题：默认路径改为中立相对路径、路径脱敏改用 `os.homedir()`；
- MIT 许可开源（GitHub 主仓 + Gitee 镜像）。
