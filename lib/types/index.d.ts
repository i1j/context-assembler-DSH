/**
 * CA 插件 V7.0（DSH 迁移版）导出类型（lib/types/index.d.ts）
 *
 * 权威源：design §4.1 导出类型（唯一权威，物理复制）+ lib/*.js 实际导出（类型名/字段名/可选性不可漂移）。
 * 本文件为 types-only 声明文件（.d.ts），供包消费者经 package.json exports.types 解析。
 * 类型级闭合（B16''）：承载状态元数据以插件本地类型 CompactionSummaryCarrier 闭合，不增广契约
 * （declare module 增广触发 TS 2717/2345 不可编译）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type {
  CompactionEngine,
  CompactionAgentContext,
  ManualCompactAgentContext,
  CompactionResult,
} from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session';

// ==================== ooda.js ====================
export type OodaStage = 'orient' | 'decide' | 'act' | 'observe' | null;
export interface OodaRule {
  eventType: string;
  condition?: (e: SessionEvent) => boolean;
  stage: OodaStage;
}
/** 常量表，随包交付（与需求 §2 R-Elm2 权威表逐行核对，8 行映射） */
export const OODA_RULES: OodaRule[];

// ==================== view.js ====================
/** 视图 Elm（debug 导出 8 契约字段；grade/carrierState/visibility 为派生态，观测用） */
export interface CaViewElm {
  /** A1：thought/fin 区分（均 decide 但类型不同） */
  type: 'user' | 'thought' | 'fin' | 'toolCall' | 'toolResult' | 'synthetic';
  /** 会话内单调递增，全部非空（synthetic 也归属） */
  transaction_id: number;
  /** 原始事件 seq，可回溯 */
  elm_ref: number;
  /** synthetic = null（豁免），其余非空 */
  ooda_stage: OodaStage;
  /** 承载文本的事件 seq/内容索引 */
  text_ref: number;
  /** 派生态，观测用 */
  grade?: 'ACT' | 'REL' | 'FAR';
  /** 未承载/已承载（compaction/summary caCarrierDetail 读取，B3 裁决） */
  carrierState?: 'unloaded' | 'carried';
  /** 遮蔽即不可见 */
  visibility?: 'visible' | 'shadowed';
}
/** 视图 Elm rich 形态（内部 text 字段，供 grade/inject 纯函数确定性拼装；非导出契约字段） */
export interface CaRichViewElm extends CaViewElm {
  text: string;
}
/** debug 导出（剥离内部 text，恰为 8 契约字段） */
export function exportView(sessionId: string): CaViewElm[];

// ==================== inject.js ====================
export interface CaInjectConfig {
  enabled: boolean;
  tokenLimit: number;
  k: number; // k 默认 1（映射链：config injectionK → CaInjectConfig.k）
}
/** 决策表（A5/A6/B4）：输入视图/配置/注入历史 → 动作映射 */
export function decideInjection(
  view: readonly CaRichViewElm[],
  config: CaInjectConfig,
  injectHistory: ReadonlySet<number>,
): { action: 'inject' | 'skip'; reason: string; candidateTxnIds?: number[] };
/**
 * 多候选确定性拼装（K 聚合，sections 长度 = min(k, 候选数)），无 LLM。
 * 拼装顺序：user Elm 在前 + ooda_stage 标注（D26/D29——内容以首个候选 user 原文开头）。
 */
export function buildInjectionContent(view: readonly CaRichViewElm[], candidateTxnIds: number[], k?: number): string;

// ==================== index.js reality 拣选（B1 修复导出） ====================
export interface RealityPickResponse {
  status: string;
  picked?: Array<{ index: number; relevance?: string; priority?: number }>;
}
export interface RealityPickCandidate<T = unknown> {
  reality: T;
  score: number;
}
/**
 * 将 4B 拣选响应解析为注入候选。null 仅表示调用/解析失败（调用方兜底）；
 * 空数组表示 4B 判定全新话题（宁缺勿错，禁止兜底注入）。
 */
export function resolveRealityPick<T = unknown>(
  res: RealityPickResponse | null | undefined,
  pool: Array<RealityPickCandidate<T>>,
): Array<{ reality: T; relevance: string; score: number }> | null;

/** debug/live 读取入口：返回该 ctx 上 apply 时创建的 llm 调用观测存储（未 apply 或已释放 → null） */
export function getLlmTraceStore(ctx: Context): LlmTraceStore | null;

// ==================== grade.js ====================
export interface GradeConfig {
  tailN: number;
  ageThresholdTurns: number;
  similarityThreshold: number;
  topicSwitchEntry: number; // 话题切换 Jaccard 延续阈值（0=最保守，除强制短语/首轮外永不切换）
}
/** 最小定级（design §3.3）：tail 保护 → 轮次年龄 → 文本相似度（LCS 归一化）→ 其余 ACT */
export function gradeTurn(
  view: readonly CaRichViewElm[],
  turnNo: number,
  config?: Partial<GradeConfig>,
): 'ACT' | 'REL' | 'FAR';

// ==================== engine.js ====================
/** CA 引擎配置（DEFAULT_ENGINE_CONFIG 可覆盖键，与 CaPluginConfig 同键子集） */
export interface CACompactionConfig {
  tailN?: number;
  gradeAgeThresholdTurns?: number;
  gradeSimilarityThreshold?: number;
  topicSwitchEntry?: number; // 话题切换 Jaccard 延续阈值，默认 0（最保守，缓存最友好）
  summarizationProvider?: string;
  summarizationModel?: string;
  thresholdRatio?: number;
  retainRatio?: number; // 继承兼容键（B66）——CA 不消费，仅读取一致
  maxTokens?: number;
  auto?: boolean;
  compactionRetries?: number;
}
/**
 * CACompactionEngine：注册为 ctx.compaction 的三区降级压缩后端。
 * compactRegion 落地复用已通过复测的摘要（B65），不在 compactRegion 内再生成。
 */
export class CACompactionEngine extends CompactionEngine {
  constructor(ctx: Context, config?: Partial<CACompactionConfig>);
  compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal,
  ): Promise<CompactionResult | null>;
  compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null>;
  compactRegion(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult>;
}

// ==================== overlap.js ====================
/** 最长公共子串长度；≥ minLen（默认 20）→ 判定重复（C8 阈值参数化） */
export function maxCommonSubstring(a: string, b: string, minLen?: number): number;

// ==================== 承载状态元数据（插件本地类型，B16'' 不增广契约） ====================
/** 遮蔽范围复用契约既有 shadowedRange/shadowedSeqs 字段；caCarrierDetail 为插件扩展（注入候选判定读取） */
export type CompactionSummaryCarrier = SessionEventMap['compaction/summary'] & {
  caCarrierDetail?: { carriedTxnIds: number[] };
};

// ==================== 配置 schema（cordis.patch.yml 插件行 config 段） ====================
export interface CaPluginConfig {
  tailN?: number; // 默认 2（R6）；min=1（0 非法，F57）
  gradeAgeThresholdTurns?: number; // 最小定级轮次年龄阈值（技术方案暂定，回填）
  gradeSimilarityThreshold?: number; // 文本相似度阈值（同上）
  topicSwitchEntry?: number; // 话题切换 Jaccard 延续阈值，默认 0（最保守，缓存最友好）
  summarizationProvider?: string; // 默认 ''（路由最新请求目标）
  summarizationModel?: string;
  thresholdRatio?: number; // 默认 0.8
  retainRatio?: number; // 默认 0.16（B66：继承兼容键——CA 不消费但读取一致）
  maxTokens?: number; // 默认 8192
  injectionEnabled?: boolean; // 默认 true
  injectionTokenLimit?: number; // 默认 500
  injectionK?: number; // 默认 1（A52：config injectionK → CaInjectConfig.k 映射链）
  auto?: boolean; // backend 自动压力触发开关，默认 true（A60）
  compactionRetries?: number; // 收敛重试次数，默认 1（B2/B13）；min=1（0 非法，F56）
  toolTraceEnabled?: boolean; // 7.1 P1：tool_trace 确定性投影开关，默认 true
  llmTraceEnabled?: boolean; // 7.1 P1：llm/stream 观测器开关，默认 true
  llmTraceMaxCalls?: number; // llm 调用记录环形上限，默认 256（1..4096）
  toolRewriteEnabled?: boolean; // 7.1 P4：wire 级工具结果改写开关，默认 true
  toolRewriteMinSavingChars?: number; // 单条改写最小节省字符门槛，默认 400（min=1）
  toolRewriteDryRun?: boolean; // 7.1 P4→渐进：true = 只汇编留档不注入，默认 false
  entityGraphEnabled?: boolean; // 7.1 P3b：跨会话实体图冷启动加载开关，默认 true
  entityGraphDbPath?: string; // 实体图库路径，默认 ''（复用 realityDbPath）
  toolBackfillEnabled?: boolean; // 7.1 P2：后台 4B intent/outcome 回填开关，默认 true
  toolBackfillUrl?: string; // 本地 4B 端点，默认 http://127.0.0.1:11435
  toolBackfillModel?: string; // 回填模型，默认 qwen3-4b-instruct:32k
  toolBackfillTimeoutMs?: number; // 单次回填超时 ms，默认 30000（min=1000）
  toolBackfillMaxConcurrent?: number; // 回填并发，默认 2（1..8）
  toolBackfillMaxQueue?: number; // 回填队列上限，默认 16（1..128）
}

// ==================== tool-trace.js（7.1 P1） ====================
export const TOOL_TRACE_KEY: 'ca-v7/tool-trace';
export const TOOL_TRACE_STATE_VERSION: 2;
export const TOOL_TRACE_MAX_ROWS: 1024;
/** 工具痕迹行：callId 配对 tool/call 与 tool/result 的轻量聚合（原文留在事件日志） */
export interface CaToolTraceRow {
  rowId: number;
  callId: string;
  turn: number | null;
  step: number | null;
  callSeq: number | null;
  resultSeq: number | null;
  callTime: number | null;
  resultTime: number | null;
  durationMs: number | null;
  name: string;
  description: string;
  argsJson: string; // 压缩参数 JSON（单字符串值截断 1024，原文留日志）
  argsSummary: string;
  resultSummary: string;
  hdl: string;
  error: string | null;
  exitCode: number | null;
  isError: boolean;
  resultChars: number;
  entities: string[];
  highValueFacts: string[]; // 高价值事实：uri/exit/error/关键路径（改进方案 §3.2）
  status: 'called' | 'completed';
}
export function initToolTraceState(): {
  nextRow: number;
  byCallId: Record<string, CaToolTraceRow>;
  order: string[];
};
export function applyToolTraceState(state: unknown, event: SessionEvent): unknown;
export function viewToolTraceState(state: unknown): CaToolTraceRow[];
export function createToolTraceProjection(): {
  key: typeof TOOL_TRACE_KEY;
  schema: unknown;
  init: typeof initToolTraceState;
  apply: typeof applyToolTraceState;
  view: typeof viewToolTraceState;
  stateVersion: typeof TOOL_TRACE_STATE_VERSION;
};
export function setToolTrace(sessionId: string, rows: CaToolTraceRow[]): void;
export function clearToolTraceCache(): void;
export function exportToolTrace(sessionId: string): CaToolTraceRow[];

// ==================== llm-trace.js（7.1 P1） ====================
export interface LlmTraceStore {
  maxCalls: number;
  seq: number;
  calls: Map<number, LlmCallRecord>;
  order: number[];
  byToolCallId: Map<string, LlmCallRecord>;
}
export interface LlmCallRecord {
  requestSeq: number;
  sessionId: string | null;
  provider: string;
  model: string;
  purpose: string | null;
  reasoningEffort: string | null;
  temperature: number | null;
  maxTokens: number | null;
  messagesCount: number;
  inputChars: number;
  inputTextChars: number;
  inputReasoningChars: number;
  inputToolResultChars: number;
  inputToolCallIds: string[];
  toolSchemaNames: string[];
  startMs: number;
  durationMs: number | null;
  chunkCount: number;
  reasoningChars: number;
  textChars: number;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  blockOrder: Array<{ t: 'start' | 'end'; i: number; b: string }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  } | null;
  finish: { kind: string; failure: unknown } | null;
  hasReplayState: boolean;
  status: 'streaming' | 'completed' | 'failed' | 'unfinished';
}
export function initLlmTraceStore(opts?: { maxCalls?: number }): LlmTraceStore;
export function beginLlmCall(store: LlmTraceStore, options: unknown): LlmCallRecord | null;
export function recordChunk(rec: LlmCallRecord, chunk: unknown): void;
export function finalizeLlmCall(store: LlmTraceStore, rec: LlmCallRecord): LlmCallRecord;
export function teeLlmStream(rec: LlmCallRecord, chunks: AsyncIterable<unknown>): AsyncGenerator<unknown, void, unknown>;
export function installLlmTrace(
  ctx: Context,
  store: LlmTraceStore,
  logger?: { warn?: (msg: string) => void },
): () => boolean;
export function snapshotLlmCall(rec: LlmCallRecord): Record<string, unknown> | null;
export function exportLlmTrace(store: LlmTraceStore): Array<Record<string, unknown>>;
export function enrichToolTrace(rows: CaToolTraceRow[], store: LlmTraceStore): Array<CaToolTraceRow & { llm: Record<string, unknown> | null }>;
export function exportLlmToolTimeline(rows: CaToolTraceRow[], store: LlmTraceStore): Array<Record<string, unknown>>;

// ==================== entity-graph.js（7.1 P3） ====================
export const ENTITY_GRAPH_MAX_NODES: 512;
export const ENTITY_COOCCUR_CAP: 8;
export function normalizeEntity(entity: string): string | null;
export function valuableEntities(entities: string[], cap?: number): string[];
export function extractQuestionEntities(text: string): string[];
export function mapTxnEntities(view: CaRichViewElm[], rows: CaToolTraceRow[]): Map<number, string[]>;
export function buildEntityGraph(txnEntities: Map<number, string[]>): {
  nodes: Set<string>;
  adjacency: Map<string, Map<string, number>>;
  edges: Array<{ from: string; to: string; kind: string; weight: number }>;
  txnEntities: Map<number, string[]>;
};
export function gradeByEntityGraph(
  txnEntities: Map<number, string[]>,
  questionEntities: string[],
  graph: ReturnType<typeof buildEntityGraph>,
): Map<number, 'ACT' | 'REL' | 'FAR'>;
export function mergeGrades(
  textGrades: Map<number, 'ACT' | 'REL' | 'FAR'>,
  entityGrades: Map<number, 'ACT' | 'REL' | 'FAR'>,
): Map<number, 'ACT' | 'REL' | 'FAR'>;
export function entityGradeView(view: CaRichViewElm[], rows: CaToolTraceRow[], questionText: string, graph?: ReturnType<typeof buildEntityGraph>): {
  grades: Map<number, 'ACT' | 'REL' | 'FAR'>;
  graph: ReturnType<typeof buildEntityGraph> | null;
  txnEntities: Map<number, string[]>;
};
export function mergeEntityGraphs(
  base: ReturnType<typeof buildEntityGraph>,
  cold: ReturnType<typeof buildEntityGraph> | null | undefined,
): ReturnType<typeof buildEntityGraph>;

// ==================== entity-store.js（7.1 P3b） ====================
export function loadColdEntityGraph(
  dbPath: string,
  logger?: { warn?: (msg: string) => void },
): ReturnType<typeof buildEntityGraph> | null;

// ==================== topic-grade.js（P1 冻结 + 7.1 P3 实体图输入） ====================
export function initTopicGradeState(): {
  profile: string;
  seen: boolean;
  grades: Map<number, 'ACT' | 'REL' | 'FAR'>;
  maxTxnId: number;
};
export function gradeTransactionsStable(
  view: CaRichViewElm[],
  config: Partial<GradeConfig>,
  state: ReturnType<typeof initTopicGradeState>,
  entityCtx?: { rows?: CaToolTraceRow[]; questionText?: string; graph?: ReturnType<typeof buildEntityGraph> },
): Map<number, 'ACT' | 'REL' | 'FAR'>;

// ==================== tool-backfill.js（7.1 P2） ====================
export function buildToolBackfillPrompt(row: Partial<CaToolTraceRow>): string;
export function parseToolBackfill(text: string): {
  status: 'ok';
  intent_l1: string;
  outcome_l1: string;
} | {
  status: 'error';
};
export function backfillTool4B(
  row: Partial<CaToolTraceRow>,
  opts?: { url?: string; model?: string; timeoutMs?: number },
): Promise<ReturnType<typeof parseToolBackfill>>;
export interface ToolBackfillQueue {
  enqueue(session: import('@deepseek-ai/dsh-session').Session, rows: CaToolTraceRow[]): void;
  get(session: import('@deepseek-ai/dsh-session').Session, callId: string): {
    status: 'done' | 'failed';
    intent_l1: string;
    outcome_l1: string;
  } | undefined;
  overlay(rows: CaToolTraceRow[], session: import('@deepseek-ai/dsh-session').Session): Array<CaToolTraceRow & { intent_l1?: string; outcome_l1?: string }>;
  stats(session: import('@deepseek-ai/dsh-session').Session): { done: number; failed: number; pending: number };
}
export function createToolBackfillQueue(opts?: {
  url?: string;
  model?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxQueue?: number;
  warn?: (msg: string) => void;
}): ToolBackfillQueue;
export function newBackfillTaskId(): string;

// ==================== tool-rewrite.js（7.1 P4） ====================export const TOOL_REWRITE_PLAN_VERSION: 1;
export interface CaToolRewritePlanItem {
  seq: number;
  callId: string;
  turn: number | null;
  step: number | null;
  level: 'l1' | 'l2';
  rawChars: number;
  text: string;
  savingChars: number;
}
export function planToolRewrites(
  view: CaRichViewElm[],
  rows: CaToolTraceRow[],
  grades: Map<number, 'ACT' | 'REL' | 'FAR'>,
  opts?: {
    tailTurns?: number;
    nearTurns?: number; // §4.5 近保护区轮数（默认 2；近区优先 L1）
    minSavingChars?: number;
    surfaceSeqs?: Set<number>;
    factAppendixMaxFacts?: number; // §3.4/§4.2 L1 事实附录条数（默认 5；0 = 禁用）
    factAppendixBudgetChars?: number; // 附录字符预算（默认 200）
  },
): CaToolRewritePlanItem[];
export function tailTxnIds(view: CaRichViewElm[], tailTurns: number): Set<number>;
export function tailTxnIdsGraded(
  view: CaRichViewElm[],
  tailTurns: number,
  nearTurns?: number,
): { hard: Set<number>; near: Set<number> };
export function appendFactAppendix(
  text: string | null | undefined,
  row: CaToolTraceRow,
  opts?: { maxFacts?: number; budgetChars?: number },
): string;
export function executeToolRewrites(
  session: import('@deepseek-ai/dsh-session').Session,
  plan: CaToolRewritePlanItem[],
): Array<{ seq: number; appendedSeq: number }>;
export function snapshotToolTrace(ctx: Context, session: import('@deepseek-ai/dsh-session').Session): CaToolTraceRow[];

// ==================== 7.3 ca-db.js（公开库，exports["./ca-db"]） ====================
export const CA_DB_VERSION: 2;
export const SCHEMA: string;
export const HANDOFF_SCHEMA: string;
export type CaDb = import('node:sqlite').DatabaseSync;
export function openDb(path: string): CaDb;
export function migrateCaDb(db: CaDb): { from: number; to: number; legacyRenamed: string[] };
export function openCaDb(path: string): CaDb;
export function upsertSessionMeta(db: CaDb, row: Record<string, unknown>): void;
export function insertTurnRows(db: CaDb, rows: Array<Record<string, unknown>>): void;
export function insertToolTraceRows(db: CaDb, rows: Array<Record<string, unknown>>): void;
export function insertLlmCalls(db: CaDb, rows: Array<Record<string, unknown>>): void;
export function insertThinkTraceRows(db: CaDb, rows: Array<Record<string, unknown>>): void;
export function clearThinkTrace(db: CaDb): void;
export function updateThinkL1Rows(db: CaDb, rows: Array<Record<string, unknown>>): void;
export function upsertEntityNodes(db: CaDb, keys: string[]): void;
export function upsertEntityEdges(db: CaDb, edges: Array<Record<string, unknown>>): void;
export function loadEntityGraph(db: CaDb): {
  nodes: Set<string>;
  adjacency: Map<string, Map<string, number>>;
  edges: Array<Record<string, unknown>>;
  txnEntities: Map<number, string[]>;
};
export function insertStrand(db: CaDb, strand: Record<string, unknown>): number;
export function insertReality(db: CaDb, reality: Record<string, unknown>): number;
export function mapStrandToReality(db: CaDb, strand_id: number, reality_id: number): void;
export function clearStrandData(db: CaDb): void;
export function countStats(db: CaDb): Record<string, number>;

// ==================== 7.3 topic-state.js（handoff 噪声信号输入投影） ====================
export const TOPIC_STATE_KEY: 'ca-v7/topic-state';
export const TOPIC_STATE_VERSION: 1;
export const DEFAULT_TOPIC_STATE_CONFIG: { tailN: number; ageThresholdTurns: number; similarityThreshold: number; topicSwitchEntry: number };
export function initTopicState(): Record<string, unknown>;
export function applyTopicState(state: Record<string, unknown>, event: SessionEvent, config?: { tailN?: number; ageThresholdTurns?: number; similarityThreshold?: number; topicSwitchEntry?: number }): Record<string, unknown>;
export function viewTopicState(state: Record<string, unknown>): {
  topicClusters: number;
  grades: Record<string, 'ACT' | 'REL' | 'FAR'>;
  farRatio: number;
  totalGraded: number;
};
export const topicStateSchema: unknown;
export const topicStateViewSchema: unknown;
export function createTopicStateProjection(config?: { tailN?: number; ageThresholdTurns?: number; similarityThreshold?: number; topicSwitchEntry?: number }): {
  key: typeof TOPIC_STATE_KEY;
  schema: typeof topicStateViewSchema;
  init: typeof initTopicState;
  apply: typeof applyTopicState;
  view: typeof viewTopicState;
  stateVersion: typeof TOPIC_STATE_VERSION;
};
export function setTopicState(sessionId: string, value: unknown): void;
export function clearTopicStates(): void;

// ==================== 7.3 handoff-metrics.js（信号纯计算） ====================
export const PRESSURE_DEFAULTS: { ratioThreshold: number };
export const NOISE_DEFAULTS: {
  topicClustersMin: number;
  farRatioThreshold: number;
  toolResultCharRatioThreshold: number;
  injectionOverlapRejectsMin: number;
  unreachableFarRatioThreshold: number;
  extraHitsRequired: number;
};
export function collectPressureSignals(input: {
  measure: { totalTokens: number };
  contextWindow: number;
  lastPressureAttempt: { projected: number; thresholdTokens: number; gaveUp: boolean } | null;
  overflowLatch: { recovered: boolean } | null;
}): { ratio: number | null; b55NonConvergent: boolean; overflow: boolean };
export function pressureTriggered(p: { ratio: number | null; b55NonConvergent: boolean; overflow: boolean }, thresholds?: typeof PRESSURE_DEFAULTS): { triggered: boolean; hits: string[] };
export function collectNoiseSignals(input: {
  topicState?: { topicClusters?: number; farRatio?: number };
  toolTraceRows?: Array<{ resultChars?: number }>;
  derivedChars?: number;
  rejectStreak?: number;
  unreachableFarRatio?: number | null;
}): {
  topicClusters: number;
  farRatio: number;
  toolResultCharRatio: number | null;
  injectionOverlapRejects: number;
  unreachableFarRatio: number | null;
};
export function noiseTriggered(n: ReturnType<typeof collectNoiseSignals>, thresholds?: typeof NOISE_DEFAULTS): { triggered: boolean; hits: string[] };
export function signalRecords(sessionId: string, input: {
  pressure?: { hits?: string[] };
  noise?: { triggered?: boolean; hits?: string[] };
  pressureData?: Record<string, unknown>;
  noiseData?: Record<string, unknown>;
}): Array<{ kind: string; valueJson: string }>;

// ==================== 7.3 handoff-plan.js（分支划分与五门禁） ====================
export const HANDOFF_DEFAULTS: { minTurns: number; maxDepth: number; cooldownMs: number; tailN: number };
export interface HandoffBranchCluster {
  sourceTxnStart: number;
  sourceTxnEnd: number;
  txnIds: number[];
  seqRanges: number[][];
}
export function partitionBranches(
  view: CaRichViewElm[],
  grades: Map<number, 'ACT' | 'REL' | 'FAR'>,
  opts?: { tailN?: number },
): HandoffBranchCluster[];
export function branchKey(parentSessionId: string, cluster: HandoffBranchCluster): string;
export function buildPackageKey(parentSessionId: string, planKind: string, branches: HandoffBranchCluster[]): string;
export function evaluateHandoff(input: {
  mode?: string;
  now: number;
  sessionTurns: number;
  parentDepth?: number;
  lastHandoffAt?: number | null;
  existingBranchKeys?: Set<string>;
  pressure?: { triggered: boolean };
  noise?: { triggered: boolean };
  clusters?: HandoffBranchCluster[];
  planKind?: string;
  thresholds?: Partial<typeof HANDOFF_DEFAULTS>;
  parentSessionId?: string;
}): Record<string, unknown>;

// ==================== 7.3 handoff-branch-summary.js ====================
export const HANDOFF_BRANCH_INSTRUCTION: string;
export const BRANCH_SUMMARY_KEYS: string[];
export class BranchSummaryParseError extends Error {}
export interface BranchSummary {
  goal: string;
  current_state: string[];
  key_facts: string[];
  open_items: string[];
  next_step: string[];
  source_txn_ids: number[];
  source_seq_ranges: number[][];
  strand_id: number | null;
  reality_ids: number[];
}
export function segmentMessagesFromEvents(session: import('@deepseek-ai/dsh-session').Session, view: CaRichViewElm[], txnIds: number[]): unknown[];
export function parseBranchSummary(blocks: unknown[]): BranchSummary;
export function summarizeBranch(
  engine: { getView(session: unknown): CaRichViewElm[]; summarizeContent(session: unknown, messages: unknown[], agent: unknown, signal: AbortSignal, opts: { purpose: 'handoff-branch' }): Promise<{ blocks: unknown[] }> },
  session: import('@deepseek-ai/dsh-session').Session,
  txnIds: number[],
  agent: unknown,
  signal: AbortSignal,
): Promise<{ summary: BranchSummary; txnIds: number[]; seqRanges: number[][] }>;
export function renderBranchMarkdown(summary: Partial<BranchSummary>, meta?: Record<string, unknown>): string;

// ==================== 7.3 edge-strength.js（弱边强度） ====================
export const EDGE_KIND: 'co_attends';
export const EDGE_DEFAULTS: {
  clickDelta: number; dwellDelta: number; dwellMs: number; dwellMaxDelta: number;
  anchorDelta: number; lambdaPerDay: number; confirmTheta: number; freshDays: number;
  hysteresis: number; epsilon: number; maxWeakEdgesPerNode: number;
};
export interface CaEdgeStrength {
  from_key: string;
  to_key: string;
  kind: string;
  weight: number;
  n_click: number;
  n_dwell: number;
  n_anchor: number;
  last_seen_at: number | null;
  status: 'weak' | 'confirmed';
  confirmed_at: number | null;
  degraded_at: number | null;
}
export function emptyEdge(fromKey: string, toKey: string): CaEdgeStrength;
export function hebbianUpdate(w: number, delta: number): number;
export function dwellDelta(durationMs: number, cfg?: typeof EDGE_DEFAULTS): number;
export function applySignal(edge: CaEdgeStrength, input: { signal: 'click' | 'dwell' | 'anchor' | string; durationMs?: number; nowSec: number; cfg?: typeof EDGE_DEFAULTS }): CaEdgeStrength;
export function decayWeight(w: number, daysElapsed: number, cfg?: typeof EDGE_DEFAULTS): number;
export function decayEdge(edge: CaEdgeStrength, nowSec: number, cfg?: typeof EDGE_DEFAULTS): CaEdgeStrength;
export function evaluateStatus(edge: CaEdgeStrength, nowSec: number, cfg?: typeof EDGE_DEFAULTS): { status: 'weak' | 'confirmed'; confirmed_at: number | null; degraded_at: number | null };
export function edgeCost(w: number, cfg?: typeof EDGE_DEFAULTS): number;
export function rankEdges(edges: CaEdgeStrength[]): CaEdgeStrength[];
export function evictWeakEdges(edges: CaEdgeStrength[], max?: number): { kept: CaEdgeStrength[]; evicted: CaEdgeStrength[] };

// ==================== 7.3 viewpoint.js（会话树 + CA 索引图） ====================
export function buildSessionTree(sessions: Array<Record<string, unknown>>, handoffBranches: Array<Record<string, unknown>>): {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
};
export function buildCaGraph(input?: Record<string, unknown>): {
  nodes: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
};
export function shortestPath(graph: { nodes?: Array<{ id?: string }>; links?: Array<{ source?: string; target?: string; relation?: string; confidence_score?: number }> }, fromId: string, toId: string): { path: string[] | null; cost: number | null };
export function keyToNodeId(key: string, ctx?: { strandKeyMap?: Map<string, string> }): string;

// ==================== 7.3 route-policy.js（路由策略） ====================
export const ROUTE_STRATEGIES: string[];
export function derivePurpose(step: number): 'main' | 'tool-continuation';
export function assertRouteDecision(decision: unknown): { ok: true } | { ok: false; reason: string };
export function decideRoute(input: {
  turn?: number;
  step?: number;
  purpose?: string;
  humanOverride?: { provider?: string; model?: string } | null;
  policyTable?: Array<{ when?: Record<string, unknown>; route?: { provider?: string; model?: string } }>;
  catalog?: Array<{ provider: string; model: string }>;
  currentTarget?: { provider: string; model: string } | null;
  pressure?: unknown;
  noise?: unknown;
  switchPenalty?: boolean;
}): Record<string, unknown> | null;
