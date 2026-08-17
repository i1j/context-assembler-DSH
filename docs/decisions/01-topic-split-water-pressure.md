---
title: 话题水位压力切割
slug: topic-split-water-pressure
category: decision
date: "2026-08-17"
updated: 2026-08-18
version_introduced: v7
status: 已实装
affects: [topic-management]
source_files:
  - lib/topic-switch.js
  - lib/topic-grade.js
  - lib/topic-state.js
  - lib/engine.js
  - lib/index.js
test_files:
  - test/topic-switch.test.ts
  - test/topic-state.test.ts
  - test/engine.test.ts
  - test/index.test.ts
---

> 权威记录：`docs/DESIGN.md` §3/§4。
> 本页只记录本决策的增量信息：备选方案、用户裁定、影响与可验证锚点。

## 触发条件

单话题长会话下，Jaccard 相似度可能长期高于切换阈值，导致话题块永不分割、
ctx 不断膨胀，缓存收益被增长抵消。Hermes 已有 `_apply_water_pressure`：
ctx 字符越多，话题切割越主动。

## 备选方案

| 方案 | 说明 | 取舍 |
|------|------|------|
| A：纯 Jaccard 阈值 | 维持 Hermes 原值 0.04，不做压力 | 简单，但单话题长会话锁死 `no_branch` |
| B：固定字符阈值硬切 | 到固定长度强制切 | 无梯度，接近阈值处行为突变 |
| C：线性水位压力（选定） | start 以下不扣、start→peak 线性扣 Jaccard、peak 满压必切 | 有梯度、缓存友好、兑现“压力到就切” |

## 选定

采用 Hermes 水位压力移植 + 用户裁定增强：

- `splitStartChars=5000`、`splitPeakChars=20000`、`jaccardPenaltyMax=0.30`；
- `forceAtPeak=true`：peak 及以上无条件切割（Hermes 原版是“扣减后比较”，
  本裁定更彻底：压力到就切新话题，不管前后轮多接近）。

实现后由 `bb3e163` 补全 `topicSplit*` 配置到 `engine.gradeView` / `topic-state` 投影 /
pre-step 的透传，保证三处水位口径一致。

## 影响

- 话题切换在长会话中不再被 Jaccard 锁死；
- 缓存语义：仅在水位满压/切换时重构前部，其余轮次保持前缀稳定；
- `totalChars` 成为运行时投影字段，必须随 `ca-v7/topic-state` view 输出；
- **已知耦合**：该投影当前随 `handoffEnabled && ctx.caHandoff` 条件注册；未注册部署中
  `totalChars=0`，水位压力不生效。若需独立于 handoff 使用，应先解耦投影注册。

## 验证

```bash
pnpm test                          # 全量测试（当前 435 全绿基线）
pnpm build                         # tsc --noEmit
```

按实际断言：

- `test/topic-switch.test.ts`：线性扣减、peak 必切、start 以下不扣；
- `test/topic-state.test.ts`：H1 满压必切在 **fold 层**验证；view 回归单独验证
  `totalChars` 字段与 schema（修复前 view 缺 `totalChars` 恒 0）；
- `test/index.test.ts`：`apply()` 后引擎配置收到自定义 `topicSplit*`，且
  `ca-v7/topic-state` 投影被注册（未断言投影内部使用自定义值）；
- 真实会话观察：通过宿主投影快照（`sessionProjections.snapshot(...).values['ca-v7/topic-state']`）
  看 `totalChars` 随轮次上涨、`topicClusters` 在满压轮增长。

## 约束

- 水位参数默认值来自 Hermes，尚未经真实会话标定；
- `totalChars` 是字符口径，不是 token 口径；若将来接 token 口径需同步更新投影与默认值；
- 当前实现依赖 `topic-state` 投影注册条件，不是无条件“已实装”。
