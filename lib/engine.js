/**
 * Phase 2 压缩后端（lib/engine.js）——CACompactionEngine extends CompactionEngine（注册为 ctx.compaction）。
 *
 * 三区降级（R5）：最小定级（grade.js）→ FAR 原文遮蔽 / REL 摘要节点承载 / ACT 保留；
 * 单次 compactRegion = 一次 replace；交错多段 = 每个连续 FAR/REL 段各一次（ACT 段隔离保留，直调场景）；
 * 未闭合工具对 → 契约异常（原生 Error，非 ManualCompactionError，无 code 字段，D1/B18/B28）。
 *
 * 收敛重试（design §3.4，B49-B61/B67-B78 定一）：
 *   - 判定协议「先复测后落地」：尝试 = 摘要生成（不落地）+ tokenMeter 投影复测；
 *     投影公式 = measure(session).totalTokens − Σ(遮蔽 seq tokens) + Σ estimateMessage(各段摘要包装 user Message)
 *     （B56/D62/B81/B82；遮蔽 seq 不在 measure 快照时字符/3 兜底，D73）
 *   - 复测低于阈值 → compactRegion 落地（一次 replace；落地复用复测通过的摘要，不在 compactRegion 内再生成，B65）；
 *     仍超 → 未耗尽 compactionRetries 则同段集合重试（重试不落地，B52）；耗尽 → 返回 null + warn（B55）
 *   - 退化拦截先于复测（B54/B64）：空串 / finish.kind==='max-tokens' / llm reject → 不固化、保留表层、
 *     不消耗 compactionRetries 预算、终止尝试序列（B60）；段集合内任一段退化 → 整次终止（B68/B73，早退语义 B72）
 *   - 溢出路径（B2/B58/B59/B74/B76/B78/B79/B80）：request-error（CONTEXT_WINDOW_EXCEEDED_CODE）
 *     绕过投影复测门控直接落地、不走逐段生成（整体单次摘要，llm 计数 = 1）、不受 auto 门控限制（A61）、
 *     不绕过退化拦截；溢出恢复由后续 request-error / pre-step 压力路径事件节奏自然触发（B79）
 *
 * compaction/summary 事件附带插件扩展 caCarrierDetail.carriedTxnIds（B3/A34/B32，插件本地类型
 * CompactionSummaryCarrier，不增广契约）；invariant 必填字段完整（compactionId/summary/shadowedRange/
 * shadowedSeqs/shadowedTokenCount/provider/model，E19）。
 */
import { randomUUID } from 'node:crypto';
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction';
import { BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE, createToolResultMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import { VIEW_KEY } from './view.js';
import { gradeTransactionsStable, initTopicGradeState } from './topic-grade.js';
// 7.3 handoff 专用摘要指令（单向依赖：engine → handoff-branch-summary；后者不得导入 engine，防环）
import { HANDOFF_BRANCH_INSTRUCTION } from './handoff-branch-summary.js';

/** 默认配置（与 §4.1 CaPluginConfig 默认一致） */
export const DEFAULT_ENGINE_CONFIG = {
  tailN: 2,
  gradeAgeThresholdTurns: 6,
  gradeSimilarityThreshold: 0.5,
  topicSwitchEntry: 0,
  // 水位压力话题切割（index.js apply 透传；缺省对齐 WATER_PRESSURE_DEFAULTS / topic-state 投影）
  topicSplitStartChars: 5000,
  topicSplitPeakChars: 20000,
  jaccardPenaltyMax: 0.30,
  topicSplitForceAtPeak: true,
  summarizationProvider: '',
  summarizationModel: '',
  thresholdRatio: 0.8,
  retainRatio: 0.16, // 继承兼容键（B66）——CA 不消费，仅读取一致
  maxTokens: 8192,
  auto: true,
  compactionRetries: 1,
};

/** 多段摘要 usage 聚合：仅数值字段求和（input/output/cache/reasoning tokens）。调用方保证每段 usage 存在。 */
function sumUsages(summaries) {
  const out = {};
  for (const s of summaries) {
    for (const [key, value] of Object.entries(s?.usage ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = (out[key] ?? 0) + value;
    }
  }
  return out;
}

/** 摘要退化标记错误（空串 / max-tokens / reject 同退化归属，B54/B64） */
export class DegenerateSummaryError extends Error {
  constructor(reason) {
    super(`summarization degenerate: ${reason}`);
    this.name = 'DegenerateSummaryError';
    this.reason = reason;
  }
}

/** 摘要指令（确定性，最终 user 消息；禁止 LLM 用于拼装/打标——此为压缩摘要调用自身） */
const COMPACTION_INSTRUCTION = [
  '你正在作为本 AI 编程助手的压缩引擎。请将上方对话浓缩为结构化检查点，使另一个模型可在不丢失关键上下文的情况下继续工作。',
  '',
  '要求：',
  '- 保留确切的文件路径、命令、错误串、标识符、数值、函数签名与关键语法片段；',
  '- 忠实记录用户反馈与显式指令（尤其是修正）；',
  '- 输出仅检查点文本，不调用任何工具、不采取其他动作。',
].join('\n');

/** 检查点前置说明（durable 替换消息 framing） */
const CHECKPOINT_PREAMBLE =
  '这是一条自动生成的检查点，浓缩了对话早前的一段以释放上下文。请将其视为既定背景，直接基于其后消息继续任务，无需复述或确认。';

/** 日志 fallback（mock ctx 无 logger 时静默） */
function namedLogger(ctx) {
  try {
    const log = ctx?.logger?.('ca-v7');
    if (log && typeof log.info === 'function') return log;
  } catch {
    /* 忽略 */
  }
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** 路由目标 = 最新 durable 请求头 provider/model（basic 先例 routedTarget） */
function routedTarget(session) {
  const config = session?.requestHeader?.()?.config;
  if (!config || !config.provider || !config.model) return undefined;
  return { provider: config.provider, model: config.model };
}

/** 提取文本（投影兜底估算用） */
function messageText(msg) {
  const blocks = msg?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && (b.type === 'text' || b.type === 'reasoning'))
    .map((b) => b.text)
    .join('');
}

/** 检查活动压缩锁状态（复制 basic inspectCompactionEntryState 语义：end-seed 之后的 stray start 非 busy） */
function inspectCompactionEntryState(events) {
  let openTurn = null;
  let openTurnStateKnown = false;
  let unmatchedCompactionStart;
  let compactionEntryStateKnown = false;
  let latestEndSeedSeq;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq;
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event;
        compactionEntryStateKnown = true;
      } else if (event.type === 'compaction/end') compactionEntryStateKnown = true;
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn;
        openTurnStateKnown = true;
      } else if (event.type === 'turn/end') openTurnStateKnown = true;
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break;
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq };
}

/** 活动锁拒绝（busy 语义）：end-seed 证明 stray start 归属更早生命周期 → 非 busy 不阻塞 */
function assertCompactionInactive(entryState, stage, errorFactory) {
  const unmatched = entryState.unmatchedCompactionStart;
  if (unmatched === undefined || (entryState.latestEndSeedSeq !== undefined && entryState.latestEndSeedSeq > unmatched.seq)) {
    return;
  }
  throw errorFactory(`${stage}: 压缩锁已活动（存在未匹配 compaction/start）`);
}

/** 校验表层区间（missing/reversed/unbalanced → 契约异常，B18） */
function validateSurfaceRegion(session, start, end) {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  if (startIdx === -1) throw new Error(`compactRegion: 表层无 start seq ${start}`);
  if (endIdx === -1) throw new Error(`compactRegion: 表层无 end seq ${end}`);
  if (startIdx > endIdx) {
    throw new Error(`compactRegion: start seq ${start}（位置 ${startIdx}）晚于 end seq ${end}（位置 ${endIdx}）`);
  }
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) {
    throw new Error(`compactRegion: start seq ${start} 非平衡边界（会拆开步骤的 tool-call/result 对）`);
  }
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) {
    throw new Error(`compactRegion: end seq ${end} 非平衡边界（会拆开步骤，或步骤仍开放）`);
  }
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) };
}

/** 按事务分组的视图 Elm（复用 grade 导出的分组） */
function groupByTxn(view) {
  const map = new Map();
  for (const elm of view ?? []) {
    const list = map.get(elm.transaction_id) ?? [];
    list.push(elm);
    map.set(elm.transaction_id, list);
  }
  return map;
}

/** 选择 FAR/REL 候选事务 → 段集合（连续 REL 事务合并为段）与合并区间（A9 补） */
function selectSegments(view, grades, surfaceNodes) {
  const txns = groupByTxn(view);
  const surface = new Set(surfaceNodes ?? []);
  const txnSurfaceSeqs = (id) => (txns.get(id) ?? []).map((e) => e.elm_ref).filter((seq) => surface.has(seq));
  const candidateTxnIds = [...txns.keys()]
    .sort((a, b) => a - b)
    .filter((id) =>
      (grades.get(id) === 'FAR' || grades.get(id) === 'REL') &&
      txnSurfaceSeqs(id).length > 0); // 已全部遮蔽的事务不在表层：不可再进入替换区间，否则产生空输入摘要调用
  if (candidateTxnIds.length === 0) return null;
  // 段 = 相邻 REL 事务的最大连续段（FAR 事务参与区间但内容不进摘要，B17）
  const segments = [];
  let run = [];
  for (const id of candidateTxnIds) {
    if (grades.get(id) === 'REL') {
      if (run.length > 0 && run[run.length - 1] === id - 1) run.push(id);
      else {
        if (run.length > 0) segments.push(run);
        run = [id];
      }
    } else if (run.length > 0) {
      segments.push(run);
      run = [];
    }
  }
  if (run.length > 0) segments.push(run);
  const relTxnIds = candidateTxnIds.filter((id) => grades.get(id) === 'REL');
  const allSeqs = candidateTxnIds.flatMap((id) => txnSurfaceSeqs(id));
  if (allSeqs.length === 0) return null;
  // 区间 = 表层位置跨度（非数值 seq 跨度）：replace 后高 seq 检查点节点可位于表层前部，
  // 数值 min/max 会产出 start 晚于 end 的反转区间（B65/D73 语义——表层位置为权威）
  const surfaceList = [...(surfaceNodes ?? [])];
  const positions = allSeqs.map((seq) => surfaceList.indexOf(seq)).filter((p) => p >= 0);
  if (positions.length === 0) return null;
  const start = surfaceList[Math.min(...positions)];
  const end = surfaceList[Math.max(...positions)];
  return {
    candidateTxnIds,
    relTxnIds,
    segments,
    region: { start, end },
    regionSeqs: allSeqs,
  };
}

/** 段（REL 事务集合）的表层消息（surface 顺序，供摘要输入） */
function segmentMessages(session, view, txnIds) {
  const surface = new Set(session.surface.nodes);
  const txns = groupByTxn(view);
  const seqs = txnIds
    .flatMap((id) => (txns.get(id) ?? []).map((e) => e.elm_ref))
    .filter((seq) => surface.has(seq));
  const messages = [];
  for (const seq of seqs) {
    const event = session.events[seq];
    if (!event) continue;
    const message = session.deriveEventMessage(event);
    if (message === null) continue;
    // 工具结果摘要替代原文进入摘要输入（Hermes「Fct 主输入、不含 Elm」的 DSH 等价物；
    // 视图 toolResult Elm 已由 tool-summarizer 生成 L1 摘要，原文留在事件日志）
    if (event.type === 'tool/result') {
      const elm = view.find((e) => e.elm_ref === seq);
      if (elm?.type === 'toolResult' && elm.text) {
        const block = event.data?.message?.content?.[0];
        const callId = event.data?.message?.source?.callId ?? block?.toolCallId;
        if (callId) {
          messages.push(createToolResultMessage({
            callId,
            content: [{ type: 'text', text: elm.text }],
            isError: block?.isError === true,
          }));
          continue;
        }
      }
    }
    messages.push(message);
  }
  return messages;
}

/** 区间内事务 ID（直接 compactRegion 承载明细用；B4：以表层位置为准，数值 seq 在 replace 后不单调） */
function txnsInRange(view, surfaceNodes, start, end) {
  const txns = groupByTxn(view);
  const surfaceList = [...(surfaceNodes ?? [])];
  const surface = new Set(surfaceList);
  const startPos = surfaceList.indexOf(start);
  const endPos = surfaceList.indexOf(end);
  const result = [];
  for (const [id, elms] of txns) {
    for (const e of elms) {
      if (!surface.has(e.elm_ref)) continue;
      const pos = surfaceList.indexOf(e.elm_ref);
      if (pos >= startPos && pos <= endPos) {
        result.push(id);
        break;
      }
    }
  }
  return result;
}

/** 摘要退化判定：空串 / max-tokens / reject 统一为 DegenerateSummaryError（B54/B64） */
function isDegenerate(error) {
  return error instanceof DegenerateSummaryError;
}

/**
 * CACompactionEngine：注册为 ctx.compaction 的三区降级压缩后端。
 */
export class CACompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions'];

  constructor(ctx, config = {}) {
    super(ctx);
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    // P1 第一步：话题块内冻结定级（Hermes topic→grade 冻结语义；见 lib/topic-grade.js）。
    // 冻结定级状态按 session 隔离（引擎为 Service 级单例，多会话共用一个引擎实例）；
    // _topicGradeState 仅作无 session 直调/旧测试的兼容兜底。
    this._topicGradeState = initTopicGradeState();
    this._topicGradeStateBySession = new WeakMap();
    // 7.3 handoff 诊断（H11/H12）：最近一次压力检查结果 + 溢出恢复一次性 latch（pre-step 消费后置 null）。
    // 同样按 session 隔离；公开字段保留为最近一次写入的镜像，供 debug/既有测试读取。
    this.lastPressureAttempt = null;
    this.overflowLatch = null;
    this.lastContext = null; // 最近一次压力检查解析的上下文窗口（index.js 读压力 ratio 用）
    // 按 session 隔离的镜像（index.js planHandoff 读取——公开属性名，2026-08-18 修复：
    // 旧实现为 _ 前缀私有名，index.js 读不到 → 恒回落到共享镜像，跨会话串扰）
    this.lastPressureAttemptBySession = new WeakMap();
    this.overflowLatchBySession = new WeakMap();
    this.lastContextBySession = new WeakMap();
    this._registerOverflowRecovery();
  }

  /** 当前视图的话题块稳定定级（切换时冻结，块内复用；可选 7.1 P3 实体图输入）。
   *  entityCtx.session 存在时使用该会话的冻结定级状态（多会话隔离）；
   *  缺省回退实例级兼容状态（直调/旧测试无 session 场景）。 */
  gradeView(view, entityCtx) {
    let state = this._topicGradeState;
    const session = entityCtx?.session;
    if (session) {
      let perSession = this._topicGradeStateBySession.get(session);
      if (!perSession) {
        perSession = initTopicGradeState();
        this._topicGradeStateBySession.set(session, perSession);
      }
      state = perSession;
    }
    const topicStateValue = this.getTopicStateValue(session);
    return gradeTransactionsStable(view, {
      tailN: this.config.tailN,
      ageThresholdTurns: this.config.gradeAgeThresholdTurns,
      similarityThreshold: this.config.gradeSimilarityThreshold,
      topicSwitchEntry: this.config.topicSwitchEntry,
      totalChars: topicStateValue.totalChars ?? 0,
      topicSplitStartChars: this.config.topicSplitStartChars,
      topicSplitPeakChars: this.config.topicSplitPeakChars,
      jaccardPenaltyMax: this.config.jaccardPenaltyMax,
      topicSplitForceAtPeak: this.config.topicSplitForceAtPeak,
    }, state, entityCtx);
  }

  /** 压缩路径专用：一次性全量定级（P2-1）——不读不写冻结快照。
   *  冻结快照（gradeView）仅用于缓存敏感路径（tool 回写 / handoff 分支）；
   *  压缩选择须反映当前视图成熟度——否则首拍过早（turn 1 全 ACT，tail 保护）会把
   *  单话题会话永久锁死为不可压缩（话题切换永不触发 → 永不重算）。 */
  gradeViewFresh(view) {
    return gradeTransactionsStable(view, {
      tailN: this.config.tailN,
      ageThresholdTurns: this.config.gradeAgeThresholdTurns,
      similarityThreshold: this.config.gradeSimilarityThreshold,
      topicSwitchEntry: this.config.topicSwitchEntry,
    }, initTopicGradeState());
  }

  /** request-error 溢出恢复 listener（B2/B79：事件驱动重触发、无节流上限；不受 auto 门控限制，A61） */
  _registerOverflowRecovery() {
    const { ctx } = this;
    const log = namedLogger(ctx);
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal?.aborted) return next();
      const generation = agent.session.surface.replaceGeneration;
      try {
        const result = await this.compactIfNeeded(agent, 'context-overflow', signal);
        // 7.3 H12：一次性溢出 latch（恢复成功/退化各写一次；每次溢出覆盖写；pre-step 按会话消费后置 null）
        const latch = { sessionId: agent.session.id, at: Date.now(), recovered: result !== null, seq: 0 };
        this.overflowLatch = latch;
        this.overflowLatchBySession.set(agent.session, latch);
        if (signal?.aborted || agent.session.surface.replaceGeneration <= generation) return next();
        if (result !== null) {
          log.info(`ca-v7 溢出恢复：遮蔽 ${result.shadowedSeqs.length} 个表层节点`);
        }
        return { kind: 'retry' };
      } catch (error) {
        const latch = { sessionId: agent.session.id, at: Date.now(), recovered: false, seq: 0 };
        this.overflowLatch = latch;
        this.overflowLatchBySession.set(agent.session, latch);
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`ca-v7 上下文溢出压缩失败：${message}；保留原始请求错误（basic L821 语义）`);
        return next();
      }
    });
  }

  /** 读取会话视图（rich Elm 列表；sessionProjections 快照） */
  getView(session) {
    try {
      const snapshot = this.ctx.sessionProjections?.snapshot?.(session);
      const value = snapshot?.values?.[VIEW_KEY];
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  /** 读取话题状态投影（totalChars 水位源，与 topic-state fold 同口径；缺省 {} → 水位不生效） */
  getTopicStateValue(session) {
    try {
      const snapshot = this.ctx.sessionProjections?.snapshot?.(session);
      return snapshot?.values?.[TOPIC_STATE_KEY] ?? {};
    } catch {
      return {};
    }
  }

  /**
   * 摘要生成（ctx.llm.stream，purpose 默认 'compaction'，signal 转发，maxTokens 默认 8192）。
   * 失败/退化（空串/max-tokens/reject）统一抛 DegenerateSummaryError。
   * 7.3 H9：options.purpose 透传 ctx.llm.stream；purpose==='handoff-branch' 时用 handoff 专用指令。
   * @returns {Promise<{ blocks: import('@deepseek-ai/dsh-llm').ContentBlock[]; provider: string; model: string; maxTokens: number; usage?: unknown }>}
   */
  async summarizeContent(session, messages, agent, signal, options = {}) {
    const latest = session.requestHeader?.()?.config;
    const configured =
      this.config.summarizationProvider && this.config.summarizationModel
        ? { provider: this.config.summarizationProvider, model: this.config.summarizationModel }
        : undefined;
    const agentTarget =
      agent?.options?.provider && agent?.options?.model
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined;
    const target = configured ?? latest ?? agentTarget;
    if (!target) {
      throw new Error('无可用 provider/model 进行摘要：请配置 summarizationProvider/summarizationModel、路由一次请求或设置 AgentOptions');
    }
    const assembler = new BlockAssembler();
    const purpose = options.purpose ?? 'compaction';
    const instruction = createUserMessage({
      content: [
        { type: 'text', text: purpose === 'handoff-branch' ? HANDOFF_BRANCH_INSTRUCTION : COMPACTION_INSTRUCTION },
      ],
      source: { kind: 'plugin', plugin: 'ca-v7' },
    });
    const streamOptions = {
      provider: target.provider,
      model: target.model,
      messages: [...messages, instruction],
      maxTokens: this.config.maxTokens,
      sessionId: session.id,
      purpose,
      ...(signal ? { signal } : {}),
    };
    try {
      for await (const chunk of this.ctx.llm.stream(streamOptions)) assembler.push(chunk);
    } catch (error) {
      // 调用方主动取消必须原样冒泡（AbortError 不属于「摘要退化」，不能被自动路径吞成 null）
      if (signal?.aborted) throw error;
      throw new DegenerateSummaryError(`reject: ${error instanceof Error ? error.message : String(error)}`);
    }
    const finish = assembler.finish;
    if (finish.kind === 'aborted' && signal?.aborted) {
      throw finish.failure ?? new DOMException('This operation was aborted', 'AbortError');
    }
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new DegenerateSummaryError(`reject: ${finish.failure?.message ?? finish.kind}`);
    }
    if (finish.kind === 'max-tokens') {
      throw new DegenerateSummaryError('max-tokens（输出在 token 上限处截断）');
    }
    const blocks = assembler.blocks().filter((b) => b.type === 'text');
    if (blocks.length === 0 || blocks.every((b) => !b.text || b.text.trim().length === 0)) {
      throw new DegenerateSummaryError('empty（无文本摘要内容）');
    }
    return {
      blocks,
      provider: streamOptions.provider,
      model: streamOptions.model,
      maxTokens: this.config.maxTokens,
      ...(assembler.usage ? { usage: assembler.usage } : {}),
    };
  }

  /** 投影复测（B56/D62）：projected = measure.total − Σ(遮蔽 seq tokens) + Σ estimateMessage(包装 user Message) */
  project(session, shadowedSeqs, summaryMessages) {
    const measure = this.ctx.tokenMeter.measure(session);
    const nodeTokens = new Map(measure.nodes.map((n) => [n.seq, n.tokens]));
    let shadowed = 0;
    for (const seq of shadowedSeqs) {
      const tokens = nodeTokens.get(seq);
      if (tokens !== undefined) {
        shadowed += tokens;
      } else {
        // D73 兜底：遮蔽 seq 不在最近一次 measure 快照 → 字符数/3 近似（不可测盲区，测试不覆盖）
        const event = session.events[seq];
        const message = event ? session.deriveEventMessage(event) : null;
        shadowed += Math.ceil((message ? messageText(message).length : 0) / 3);
      }
    }
    const added = summaryMessages.reduce((sum, msg) => sum + this.ctx.tokenMeter.estimateMessage(msg), 0);
    return measure.totalTokens - shadowed + added;
  }

  /** 摘要块包装为 user Message（B82：estimateMessage 要求 Message，对齐 basic L555 先例） */
  wrapSummary(blocks) {
    return createUserMessage({
      content: blocks,
      source: { kind: 'plugin', plugin: 'ca-v7' },
    });
  }

  /**
   * 落地：compaction/start → compaction/summary（含 caCarrierDetail）→ 检查点 replace → compaction/end。
   * 落地复用已通过复测的摘要（B65：不在 compactRegion 内再生成）。
   * @param {object} opts { owner: 'current-turn'|null, sourceCommandId?, activeError, flush? }
   */
  async landCompaction(session, region, summaryBlocksList, carriedTxnIds, agent, signal, callFacts, opts) {
    // 生命周期 turn 归属：自动/直调路径 = 当前开放轮次；手动路径 = null（standalone）
    const owner = opts.owner === null ? null : entryOpenTurn(session);
    const selection = validateSurfaceRegion(session, region.start, region.end);
    const entryState = inspectCompactionEntryState(session.events);
    if (opts.owner === 'current-turn') {
      // 自动/直调路径：压缩事件必须封闭在开放轮次内（T-Err3 契约异常）
      if (entryState.openTurn === null) {
        throw new Error('compactRegion: 无开放轮次——自动压缩事件必须封闭在轮次内');
      }
    } else if (entryState.openTurn !== null) {
      // 手动路径：空闲期压缩要求无开放轮次
      throw new ManualCompactionError('busy', '手动压缩：会话已有开放轮次');
    }
    assertCompactionInactive(entryState, 'compaction', opts.activeError);
    const compactionId = CompactionId(randomUUID());
    const lifecycle = {
      compactionId,
      ...(opts.sourceCommandId ? { sourceCommandId: opts.sourceCommandId } : {}),
      turn: owner,
    };
    const startEvent = session.append('compaction/start', lifecycle);
    let closed = false;
    try {
      const measurement = this.ctx.tokenMeter.measure(session);
      const nodeTokens = new Map(measurement.nodes.map((n) => [n.seq, n.tokens]));
      const shadowedTokenCount = selection.shadowedSeqs.reduce((sum, seq) => sum + (nodeTokens.get(seq) ?? 0), 0);
      const summaryBlocks = summaryBlocksList.flat();
      const summaryEvent = session.append('compaction/summary', {
        compactionId,
        ...(opts.sourceCommandId ? { sourceCommandId: opts.sourceCommandId } : {}),
        summary: summaryBlocks,
        rawOutput: summaryBlocks,
        llmStreamCall: true,
        shadowedRange: { start: region.start, end: region.end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount,
        provider: callFacts.provider,
        model: callFacts.model,
        ...(callFacts.maxTokens !== undefined ? { maxTokens: callFacts.maxTokens } : {}),
        ...(callFacts.usage ? { usage: callFacts.usage } : {}),
        caCarrierDetail: { carriedTxnIds: [...carriedTxnIds] },
      });
      const checkpointMessage = createUserMessage({
        content: [
          { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n<ca-checkpoint>` },
          ...summaryBlocks,
          { type: 'text', text: '</ca-checkpoint>' },
        ],
        source: compactCheckpointSource(compactionId, opts.sourceCommandId),
      });
      session.append('user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', start: region.start, end: region.end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.shadowedSeqs],
      });
      const endEvent = session.append('compaction/end', lifecycle);
      closed = true;
      const result = {
        compactionId,
        ...(opts.sourceCommandId ? { sourceCommandId: opts.sourceCommandId } : {}),
        startSeq: startEvent.seq,
        summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq,
        summary: summaryBlocks,
        shadowedRange: { start: region.start, end: region.end },
        shadowedSeqs: [...selection.shadowedSeqs],
        shadowedTokenCount,
      };
      if (typeof opts.flush === 'function') {
        try {
          await opts.flush();
        } catch (flushError) {
          if (owner === null) {
            throw new ManualCompactionError('persistence', '手动压缩持久化检查点失败', { cause: flushError });
          }
        }
      }
      return result;
    } catch (error) {
      if (!closed) {
        try {
          session.append('compaction/end', { ...lifecycle, error: errorChain(error) });
          closed = true;
        } catch {
          /* 关闭失败：保留未匹配 start 可检测（seam 语义） */
        }
      }
      if (owner === null) {
        if (error instanceof ManualCompactionError) throw error;
        throw new ManualCompactionError('summary', '手动压缩未能产出更小摘要', { cause: error });
      }
      throw error;
    }
  }

  /**
   * 7.3 H2：解析当前路由目标的上下文窗口并写入 lastContext（handoff 压力 ratio 输入）。
   * 独立于 compactIfNeeded：handoff 优先路径在尚未做过压缩的步骤也能计算压力信号。
   * @returns {Promise<number|null>} contextWindow，或无法解析时 null
   */
  async resolveContextWindow(agent, signal) {
    const target = routedTarget(agent.session);
    if (!target) return null;
    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;
    if (!context || typeof context.contextWindow !== 'number' || context.contextWindow <= 0) return null;
    this.lastContext = context.contextWindow;
    this.lastContextBySession.set(agent.session, context.contextWindow);
    return context.contextWindow;
  }

  /** 自动压缩入口（压力 / 溢出）。auto 门控仅压力路径（A60/A61）；溢出绕过投影复测门控直接落地（B58） */
  async compactIfNeeded(agent, trigger, signal) {
    const session = agent.session;
    const log = namedLogger(this.ctx);
    if (trigger === 'pressure' && !this.config.auto) return null;
    const target = routedTarget(session);
    if (!target) return null;
    const meter = this.ctx.tokenMeter;
    const measurement = meter.measure(session);
    const contextWindow = await this.resolveContextWindow(agent, signal);
    if (contextWindow === null) {
      log.warn(`ca-v7：路由目标 ${target.provider}/${target.model} 无 context 容量，跳过自动压缩`);
      return null;
    }
    const thresholdTokens = Math.floor(contextWindow * this.config.thresholdRatio);
    // busy 锁检查先于阈值（T-Err1 双入口：未匹配 start → ManualCompactionError code='busy'）
    const entryState = inspectCompactionEntryState(session.events);
    assertCompactionInactive(entryState, 'automatic compaction', (msg) => new ManualCompactionError('busy', msg));
    if (trigger === 'pressure' && measurement.totalTokens < thresholdTokens) {
      // 7.3 H11：低于阈值早退也写入诊断（gaveUp=false，供 handoff b55NonConvergent 判定）
      const attempt = { projected: measurement.totalTokens, thresholdTokens, gaveUp: false };
      this.lastPressureAttempt = attempt;
      this.lastPressureAttemptBySession.set(session, attempt);
      return null;
    }
    const view = this.getView(session);
    const grades = this.gradeViewFresh(view); // P2-1：压缩路径 fresh 定级（冻结快照首拍过早陷阱）
    const selection = selectSegments(view, grades, session.surface.nodes);
    if (!selection) return null;
    const { region, segments, relTxnIds } = selection;
    // B2：FAR-only 空段守卫（P1）对压力/溢出两路径统一适用——无 REL 事务即无可摘要内容。
    // 溢出路径不得对空输入生成空检查点替换 FAR 原文；返回 null 交由上游保留原始请求错误/等待后续节奏。
    if (relTxnIds.length === 0) {
      log.info('ca-v7：FAR-only 会话（无 REL 事务），跳过压缩（不落地、不产生 compaction 事件）');
      return null;
    }

    if (trigger === 'context-overflow') {
      // 溢出：整体单次摘要（B78，llm 计数 = 1）+ 直接落地（B58；落地复用本次摘要，B76）
      try {
        const summary = await this.summarizeContent(session, segmentMessages(session, view, relTxnIds), agent, signal);
        const result = await this.landCompaction(
          session,
          region,
          [summary.blocks],
          relTxnIds,
          agent,
          signal,
          { provider: summary.provider, model: summary.model, maxTokens: summary.maxTokens, usage: summary.usage },
          { owner: 'current-turn', activeError: (msg) => new ManualCompactionError('busy', msg) },
        );
        log.info(`ca-v7 上下文溢出压缩：遮蔽 ${result.shadowedSeqs.length} 个表层节点（${result.shadowedTokenCount} tokens）`);
        return result;
      } catch (error) {
        if (isDegenerate(error)) {
          log.warn(`ca-v7 溢出摘要退化（${error.reason}）：不落地、保留表层，等待后续事件节奏重触发`);
          return null;
        }
        throw error;
      }
    }

    // 压力路径：收敛重试（先复测后落地，B51）
    for (let attempt = 0; attempt <= this.config.compactionRetries; attempt += 1) {
      const summaries = [];
      let degenerate = null;
      for (const seg of segments) {
        try {
          summaries.push(await this.summarizeContent(session, segmentMessages(session, view, seg), agent, signal));
        } catch (error) {
          if (isDegenerate(error)) {
            degenerate = error;
            break; // 早退语义（B72）：退化段之后不再生成
          }
          throw error;
        }
      }
      if (degenerate) {
        log.warn(`ca-v7 摘要退化（${degenerate.reason}）：不固化节点、保留表层、终止尝试序列（B54/B60）`);
        return null;
      }
      const projected = this.project(
        session,
        selection.regionSeqs,
        summaries.map((s) => this.wrapSummary(s.blocks)),
      );
      if (projected < thresholdTokens) {
        const callFacts = summaries[0] ?? {};
        // 多段压缩：usage 全部可得时按数值字段求和（避免 summary 事件只报第一段用量）
        const usage = summaries.length > 1 && summaries.every((s) => s?.usage)
          ? sumUsages(summaries)
          : callFacts.usage;
        const result = await this.landCompaction(
          session,
          region,
          summaries.map((s) => s.blocks),
          relTxnIds,
          agent,
          signal,
          { provider: callFacts.provider, model: callFacts.model, maxTokens: callFacts.maxTokens, usage },
          { owner: 'current-turn', activeError: (msg) => new ManualCompactionError('busy', msg) },
        );
        // 7.3 H11：压力路径落地（gaveUp=false）
        const attempt = { projected, thresholdTokens, gaveUp: false };
        this.lastPressureAttempt = attempt;
        this.lastPressureAttemptBySession.set(session, attempt);
        log.info(`ca-v7 压力压缩：遮蔽 ${result.shadowedSeqs.length} 个表层节点（${result.shadowedTokenCount} tokens）`);
        return result;
      }
      if (attempt < this.config.compactionRetries) continue;
      // 7.3 H11：B55 放弃（重试耗尽不收敛，表层保留、replaceGeneration 不前进）
      const gaveUpAttempt = { projected, thresholdTokens, gaveUp: true };
      this.lastPressureAttempt = gaveUpAttempt;
      this.lastPressureAttemptBySession.set(session, gaveUpAttempt);
      log.warn(
        `ca-v7 压缩仍在阈值之上（投影 ${projected} >= 阈值 ${thresholdTokens}），${this.config.compactionRetries + 1} 次尝试后放弃；表层保留、replaceGeneration 不前进（B55）`,
      );
      return null;
    }
    return null;
  }

  /** 手动压缩（/compact 复用）：runMaintenance 空闲期；busy/取消/摘要失败按 ManualCompactionError 封闭集分类 */
  compactNow(agent, signal, sourceCommandId) {
    if (signal.aborted) {
      throw new ManualCompactionError('cancelled', '手动压缩已取消', { cause: signal.reason });
    }
    const log = namedLogger(this.ctx);
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          operationSignal.throwIfAborted();
          const session = agent.session;
          const view = this.getView(session);
          const grades = this.gradeViewFresh(view); // P2-1：压缩路径 fresh 定级（冻结快照首拍过早陷阱）
          const selection = selectSegments(view, grades, session.surface.nodes);
          if (!selection) return null;
          // FAR-only 空段守卫（B17/P1）：候选事务全为 FAR、无 REL 段 → segments 空 → 无可摘要内容，
          // 与 !selection 同语义返回 null（不落地、不产生 compaction 事件）
          if (selection.segments.length === 0) {
            log.info('ca-v7 手动压缩：无可摘要内容（FAR-only 会话，无 REL 段），跳过');
            return null;
          }
          const { region, segments, relTxnIds } = selection;
          const summaries = [];
          for (const seg of segments) {
            try {
              summaries.push(await this.summarizeContent(session, segmentMessages(session, view, seg), agent, operationSignal));
            } catch (error) {
              if (isDegenerate(error)) {
                throw new ManualCompactionError('summary', `手动压缩：摘要退化（${error.reason}）`, { cause: error });
              }
              throw error;
            }
          }
          const callFacts = summaries[0] ?? {};
          const usage = summaries.length > 1 && summaries.every((s) => s?.usage)
            ? sumUsages(summaries)
            : callFacts.usage;
          const result = await this.landCompaction(
            session,
            region,
            summaries.map((s) => s.blocks),
            relTxnIds,
            agent,
            operationSignal,
            { provider: callFacts.provider, model: callFacts.model, maxTokens: callFacts.maxTokens, usage },
            {
              owner: null,
              ...(sourceCommandId ? { sourceCommandId } : {}),
              activeError: (msg) => new ManualCompactionError('busy', msg),
              flush: async () => {
                await this.ctx.sessions.flush(session);
              },
            },
          );
          log.info(`ca-v7 手动压缩：遮蔽 ${result.shadowedSeqs.length} 个表层节点`);
          return result;
        } catch (error) {
          if (operationSignal.aborted) {
            throw new ManualCompactionError('cancelled', '手动压缩已取消', { cause: error });
          }
          throw error;
        }
      });
    } catch (error) {
      // 内层已按 ManualCompactionError 封闭集分类的错误（busy/summary/cancelled/persistence）原样透出；
      // 仅 agent 维护入口本身的未知失败才归一为 busy（契约与注释「busy/取消/摘要失败分类」一致）。
      if (error instanceof ManualCompactionError) throw error;
      throw new ManualCompactionError('busy', '手动压缩要求空闲代理且无排队唤醒工作', { cause: error });
    }
  }

  /**
   * 强制压缩表层区间（直调/默认路径）：校验（active/missing/reversed/unbalanced → 契约异常）→
   * 摘要（B69：直调路径内部生成）→ replace。交错多段 = 调用方对每个连续 FAR/REL 段各调用一次。
   */
  async compactRegion(start, end, agent, signal) {
    const log = namedLogger(this.ctx);
    try {
      const session = agent.session;
      const view = this.getView(session);
      // B3：所有契约校验（开放轮次/活动锁/区间存在且平衡）必须在 LLM 摘要生成之前完成，
      // 非法调用不得消耗任何云端/本地摘要 token。
      const entryState = inspectCompactionEntryState(session.events);
      if (entryState.openTurn === null) {
        throw new Error('compactRegion: 无开放轮次——自动压缩事件必须封闭在轮次内');
      }
      assertCompactionInactive(entryState, 'compactRegion', (msg) => new Error(msg));
      const selection = validateSurfaceRegion(session, start, end);
      const carriedTxnIds = txnsInRange(view, session.surface.nodes, start, end);
      const messages = selection.shadowedSeqs
        .map((seq) => session.events[seq])
        .filter(Boolean)
        .map((event) => session.deriveEventMessage(event))
        .filter((m) => m !== null);
      let summary;
      try {
        summary = await this.summarizeContent(session, messages, agent, signal);
      } catch (error) {
        if (isDegenerate(error)) {
          throw new Error(`compactRegion: 摘要退化（${error.reason}），不固化节点、保留表层`);
        }
        throw error;
      }
      return await this.landCompaction(
        session,
        { start, end },
        [summary.blocks],
        carriedTxnIds,
        agent,
        signal,
        { provider: summary.provider, model: summary.model, maxTokens: summary.maxTokens, usage: summary.usage },
        {
          owner: 'current-turn',
          activeError: (msg) => new Error(msg), // B28：compactRegion + 活动压缩 → 契约异常（原生 Error）
        },
      );
    } catch (error) {
      // 契约类失败（非法范围/未闭合对/无开放轮次/active）→ 日志（T6b「日志含拒绝记录」）+ 抛契约异常（原生 Error）
      log.warn(`ca-v7 compactRegion 拒绝：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

export default CACompactionEngine;

/** 当前开放轮次（landing 自动路径 owner） */
function entryOpenTurn(session) {
  const entryState = inspectCompactionEntryState(session.events);
  return entryState.openTurn;
}
