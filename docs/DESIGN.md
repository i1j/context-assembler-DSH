# Context Assembler DSH（V0.99，上下文汇编）设计意图与 Hermes ca_assembler 对照（意图可查文档）

> 状态：2026-08-15 查验后更新；2026-08-18 补 B7-B9 缺陷修复记录（文档核对确认）与 B10
> reality 注入运行时根因修复（payload.messages 权威来源）。
> 用途：本文件记录 Context Assembler DSH 的设计目标、与开源 Hermes `ca_assembler` 的权威对照、
> 已修复问题与未闭合差距，作为后续编码与评审的单一意图源。
> 版本口径（2026-08-15 裁定）：**不设 V8**；对外公开版本以 0.99.x 命名，内部迭代延续 7.x 语义。

## 1. 目标（不可漂移）

1. **总目标**：花尽可能少的钱，获得尽可能量大质优的云端 AI 服务。
2. **实现途径**：在 DSH 会话数据框架约束下，用本地 LLM 算力进行会话内容汇编，
   向云端 LLM 提供单位 token 互信息密度最大的 ctx。
3. **具体手段**：
   - 按与当前话题的关联度，用不同程度的摘要替代全量会话内容（含文字对话与工具调用轮次）；
   - 在话题块开头注入相关背景资料（reality）。
4. **缓存命中约束**：上下文头部（前缀）必须在话题块内保持稳定；任何"按预算动态扩展尾部/历史"的做法
   都会破坏云端 prompt 缓存命中，禁止（Hermes decision 13 的用户裁定）。

## 2. 三项折中设计（用户定稿）

| # | 设计 | 落地形态 |
|---|------|---------|
| 1 | 缓存命中 vs 排除噪声 | **话题块机制**：各轮经模型/规则实时分割为话题块；新话题块开始时计算各旧话题块的关联性，构建会话历史的"本话题块摘要版本"，并在整个话题块过程中保持稳定 |
| 2 | 时效性 vs 经济性 | 人机交流主流程不受大的影响：检测/装配走热路径，摘要生成/归并/精炼走异步 |
| 3 | 四级信息处理 | 信息获取 → 事实提炼 → 逻辑关系提炼 → 背后规律深挖，按时效性分阶段 |

## 3. Hermes ca_assembler 权威对照（决策/架构出处）

| 环节 | Hermes 实现 | 权威文档 |
|------|-------------|---------|
| 信息获取 | E-stage 5 hook 写即落盘 turn_stream | architecture/03-e-stage |
| 事实提炼 | F-stage daemon 线程本地 4B 生成 Fct(OODA 四段)+Hdl | architecture/04-f-stage |
| 话题分割 | 强制短语 → 确认轮 → Jaccard(ENTRY 0.04/CHAIN 0.08) + token 水位压力 | architecture/06-topic-management、topic_manager.py；**已移植（applyWaterPressure 5000/20000/0.30 + forceAtPeak，ctx 字符上涨切割越主动、满压必切）** |
| 话题定级与缓存冻结 | 切换时 `grade_on_switch` 用当前提问 embedding 对旧话题形心按半径定级 ACT/REL/FAR，**冻结到下次切换** | decisions/07-topic-grade-manager、topic_manager.py |
| 历史装配 | A-stage `_build_conv_history_v6`：尾部硬保护 2 个 user 轮全 Elm；ACT/REL/FAR 按行类型降级；FAR 的 thought/tool 删除 | architecture/05-a-stage、decisions/13-tail-protection |
| 话题块摘要 | 切换时仅标记 pending，post_llm_call 后台读该块 Fct（不含 Elm）→ 一次 4B 生成 2-6 个 strand | decisions/28-topic-summarization-v4、35-strand-multi-affair |
| reality 归并 | strand→reality 按工作关联（提问云/工作云 + 4B 承接判定） | decisions/37-reality-restructure、39-reality-member-clouds、41-reality-production-migration |
| reality 注入 | 提问云形心距离（θ≤0.5，top-15）→ 4B 拣选 top-3；**4B 合法空列表 = 空注入（宁缺勿错）**；只有 4B 失败才降级 | decisions/38-inject-prompt、41、ca/inject.py `pick_injection_realities` |
| 深挖/精炼 | L4 IdleRefinementDaemon：归并审查 → 详情重生成 → 交叉验证 → 健康评分 → 知识子图；L1 代码(0 token)→L2 本地 4B→L3 云端 | architecture/14-idle-refinement、decisions/34-idle-refinement |

## 4. 当前实现与差距（查验结论）

| 设计要素 | 现状 | 差距级别 |
|----------|-----------|---------|
| 话题块实时分割并冻结定级 | `lib/topic-grade.js` 已实现**确定性冻结**：切换时快照定级、块内复用、新轮 ACT；引擎 `compactIfNeeded/compactNow` 已接入。已补 Hermes 水位压力：ctx 字符上涨线性扣减 Jaccard、满压 forceAtPeak 必切。尚未升级为 embedding 形心半径定级 | **部分落地（P1 第一步 + 水位压力已实装；已修复运行时断链——投影 view 补 totalChars + 配置全链路透传）** |
| 本话题块视角的历史摘要版本 | `lib/engine.js` 是压力阈值触发三区降级；有块内定级冻结，但尚无"本话题块视角的整段摘要版本" | **未落地** |
| 本地 LLM 做汇编 | `summarizeContent` 默认路由云端最新请求目标；本地 4B 仅做 reality 拣选 | **部分落地** |
| 按关联度分级 | ACT/REL/FAR 三区存在，但 FAR 靠尾部注入回填且按最旧 FIFO，未按相关性排序 | 部分 |
| 工具调用轮压缩（Hermes ToolSummarizer） | 已移植 `lib/tool-summarizer.js`：视图 toolCall/toolResult Elm 承载结构化摘要；`segmentMessages` 摘要输入用工具摘要替代原文。尚未做单条 surface replace 与 ACT/REL 分级落地 | **部分落地（P0 子集）** |
| reality 话题开头注入 | `lib/reality-inject.js` + pre-step 已实现；但候选预筛用摘要 centroid 跨域匹配，无提问云 | 部分 |
| 主流程时延 | pre-step 同步 await 压力压缩（多段×重试云端摘要） | **未落地** |
| 四级信息处理 | 仅离线 `scripts/summarize-history.mjs`（extract→strand→reality→refine）；运行时无 | 部分 |

## 5. 已修复问题（提交可查）

| 编号 | 问题 | 修复 | 提交 |
|------|------|------|------|
| B1 | 4B 返回合法空列表 `{"selected":[]}` 被误判为失败并余弦兜底注入，违背宁缺勿错 | `resolveRealityPick`：ok+空列表 = 空数组（不兜底）；仅 error/异常兜底 | c6e8338 |
| B2 | 溢出路径 FAR-only 会话对空输入生成空检查点并替换 FAR 原文 | `compactIfNeeded` 在 overflow 分支前加 `relTxnIds.length===0` 守卫，压力/溢出统一适用 | 181e9dd |
| B3 | `compactRegion` 先生成 LLM 摘要、后校验开放轮次/活动锁/工具对平衡，非法调用仍烧 token | 校验（开放轮次 + 活动锁 + `validateSurfaceRegion`）前移到摘要生成之前 | 181e9dd |
| B4 | `txnsInRange` 用数值 seq 比较，replace 后高 seq 检查点位于表层前部导致 carriedTxnIds 漏算 | 改为表层位置（`surfaceList.indexOf`）比较 | 181e9dd |
| B5 | `realityRecallEnabled` 被 `injectionEnabled` 意外耦合 | pre-step reality 块改用 `config.realityRecallEnabled` 独立门控 | c6e8338 |
| B6 | token 上限截断为空仍注入并在 `transaction_refs` 记录已注入 | `messageText` 空内容守卫：事务注入与 reality 注入均跳过，且不写注入历史 | c6e8338 |
| P1-1 | 压缩定级每次现算，话题块中段可能改变历史表面 | 新增 `lib/topic-grade.js`：话题切换时冻结定级快照、块内复用、块内新轮 ACT；`gradeView` 供 tool 回写/handoff 等缓存敏感路径 | 393c030 |
| P0-Tool | Hermes per-tool Fct/Hdl 未移植，toolCall/toolResult 视图 text 为空、摘要输入仍带工具全文 | 新增 `lib/tool-summarizer.js`；view 投影 state v2 工具 Elm 承载结构化摘要；`segmentMessages` 以工具摘要替代原文进入 REL/溢出摘要输入 | 6ac03fe |
| B7 | handoff 压力诊断按 session 隔离从未生效：engine 的 per-session WeakMap 为 `_` 前缀私有名，index.js `planHandoff` 读公开名 → 恒回落共享镜像，会话 B 消费会话 A 的 overflow latch | 三个字段改公开属性名 + 内部引用同步；`DEFAULT_ENGINE_CONFIG` 补水位默认值 | bb3e163 |
| B8 | **首轮 reality 注入静默失效**：pre-step 在 step/start 触发、当前轮 user/message 其后写入 → view 投影首轮为空 → 首轮从不注入 | `extractInjectionUserText`：view 内最近 user elm 优先，空时回退 `session.events` 取最近真实 `user/message` | 61b68ab |
| B8b | `topicSplit*` 水位配置只透传 pre-step：gradeView 与噪声信号投影恒用默认值，违反对照文档「多口径一致」纪律 | `apply()` 补全 4 键（`topicSplitStartChars`/`topicSplitPeakChars`/`jaccardPenaltyMax`/`topicSplitForceAtPeak`）透传 | bb3e163 |
| B9 | 水位压力运行时断链（功能整体失效）：`totalChars` 只在 topic-state fold 内部 state，view/schema 不暴露 → 框架 snapshot 下恒读 0，「满压必切」永不触发 | `viewTopicState` 输出与 `topicStateViewSchema` 增加 `totalChars` | bb3e163 |
| B10 | **reality 注入仍静默失效（B8 修复未达运行时）**：`agent/pre-step` payload 的 `messages` 即本轮输入，而 user/message 事件在 waterfall 返回后才 append → pre-step 时刻投影与会话事件都不含当前轮提问 | ① `extractInjectionUserText` 增加 claimed 优先级（payload.messages 是唯一权威来源）；② pre-step 话题判定与 reality 查询改用 `claimedUserText`；③ 首轮注入用例按真实时序重写 | 本提交对应修复 |

验证基线：`pnpm test` 38 文件 429 全绿；`pnpm build`（`tsc --noEmit`）无错误。

## 6. 未闭合改进路线（后续意图，勿在无设计文档时悄然实现）

> 存量 P1/P2/P3 重新编号为 R1/R2/R3，避免与 7.1/7.2 的 P/K 系列冲突。

**R1 话题块定级升级（已被 7.1 P3 实体图定级取代主方向）**
- embedding 形心半径定级（Hermes `topic_manager.py`）降级为**实体缺失时的兜底**，不再作主度量；
- `lib/topic-grade.js` 的冻结语义保留，定级主路径改为实体图距离（7.1 P3）；
- 尾部保护保持硬编码最后 2 个 user 轮，禁止预算扫描动态扩展。

**R2 本地 LLM 摘要 + 热路径异步化**
- post-tool-call 后台 4B 回填 tool intent/outcome（fail-open）；
- 离线/后台 4B 对 reasoning 做 L1 思考卡提炼（`lib/think-l1.js`，每卡最多 1 次调用、失败不重试、fail-open）；
- pre-step 只做毫秒级检测/注入，摘要与投影复测移出热路径。

**R3 reality 提问云改造（未排期）**
- `ca_topics.db` realities 表补 `query_text`/`query_centroid_json`/`query_count`；
- 注入预筛改用提问云形心距离（θ_max=0.5、QUERY_CLOUD_TOP_K=15、4B top-K）；
- 拒绝继续用摘要 centroid 做提问匹配（Hermes 决策 39：跨域匹配 0.008 vs 同域 0.815）。

## 7. 提交纪律（用户要求）

1. 每次改进前先 `git commit` 固化当前状态；
2. 每个改进点单独提交，message 写明语义编号（B1/B2…或 P1/P2…）与意图；
3. 任何行为变化同步本文件或对应模块文档，保证意图可查。
