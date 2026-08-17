/**
 * 话题块内稳定的最小定级（lib/topic-grade.js）——P1 第一步：冻结语义移植。
 *
 * 意图（docs/CA-V7-设计意图与Hermes对照.md §2/§6）：
 *   Hermes TopicGradeManager 在话题切换时 `grade_on_switch` 计算旧话题形心并定级，
 *   topic→grade 映射**冻结到下次切换**（decisions/07，注释「切换间冻结，保证 prompt caching 稳定」）。
 *   CA-V7 初版在每次压力检查时现算 gradeTransactions，块中段压缩会改变历史表面，破坏前缀稳定。
 *
 * 本模块为 DSH 版的确定性实现：
 *   - 话题切换检测复用 lib/topic-switch.js（首轮/强制短语/确认轮/Jaccard ENTRY）；
 *   - 切换或首次定级时调用 gradeTransactions 生成文本定级快照；若调用方提供
 *     entityCtx（tool_trace 行 + 当前提问），则叠加 7.1 P3 实体图定级并冻结；
 *   - 冻结期内新事务（当前话题块内的新轮）一律 ACT（对齐 Hermes「新话题强制 ACT」）；
 *   - 下次切换再重算。
 * 7.1 P3 说明：embedding 形心半径降级为实体缺失时的兜底（用户裁定），本模块接口保持不变。
 */
import { groupByTxn, gradeTransactions } from './grade.js';
import { detectTopicSwitch } from './topic-switch.js';
import { entityGradeView, mergeGrades } from './entity-graph.js';

/** 会话级话题定级状态（内存态；DSH projection 持久化留待 P1 完整版） */
export function initTopicGradeState() {
  return {
    profile: '',
    seen: false,
    grades: new Map(),
    maxTxnId: 0,
  };
}

/** 用视图末尾 user/fin 检测话题切换，并更新累积话题 profile */
function updateTopicProfile(view, state, entry = 0, water = {}) {
  const reversed = [...(view ?? [])].reverse();
  const userElm = reversed.find((e) => e.type === 'user');
  const finElm = reversed.find((e) => e.type === 'fin' && e.text);
  const sw = detectTopicSwitch(userElm?.text ?? '', finElm?.text ?? '', {
    profile: state.profile,
    seen: state.seen,
  }, entry, water);
  state.profile = sw.state.profile;
  state.seen = sw.state.seen;
  return sw.switched;
}

/**
 * 返回当前视图的稳定定级 Map。
 * @param {any[]} view 视图 rich Elm 列表
 * @param {{ tailN?: number; ageThresholdTurns?: number; similarityThreshold?: number; topicSwitchEntry?: number }} [config]
 * @param {{ profile: string; seen: boolean; grades: Map<number,'ACT'|'REL'|'FAR'>; maxTxnId: number }} state
 *   由 initTopicGradeState 创建，每个引擎实例一份
 * @param {{ rows?: any[]; questionText?: string; graph?: any }} [entityCtx]
 *   7.1 P3 实体图定级输入（tool_trace 行 + 当前提问）；缺省纯文本定级
 * @returns {Map<number, 'ACT'|'REL'|'FAR'>}
 */
export function gradeTransactionsStable(view, config, state, entityCtx) {
  const txns = groupByTxn(view);
  const txnIds = [...txns.keys()].sort((a, b) => a - b);
  if (txnIds.length === 0) return new Map();
  const switched = updateTopicProfile(view, state, config?.topicSwitchEntry ?? 0, {
    totalChars: config?.totalChars ?? 0,
    splitStartChars: config?.topicSplitStartChars,
    splitPeakChars: config?.topicSplitPeakChars,
    jaccardPenaltyMax: config?.jaccardPenaltyMax,
    forceAtPeak: config?.topicSplitForceAtPeak,
  });
  if (!state.seen || state.grades.size === 0 || switched) {
    const textGrades = gradeTransactions(view, config);
    let grades = textGrades;
    if (entityCtx) {
      // 7.1 P3：实体图定级优先覆盖有实体的旧事务；无实体时回落文本定级（宁缺勿错不降级为猜测）
      const eg = entityGradeView(view, entityCtx.rows ?? [], entityCtx.questionText ?? '', entityCtx.graph);
      if (eg.grades.size > 0) grades = mergeGrades(textGrades, eg.grades);
    }
    state.grades = new Map(grades);
    state.maxTxnId = txnIds[txnIds.length - 1];
    return state.grades;
  }
  // 冻结期内：沿用快照；本话题块新增事务 = ACT（Hermes 当前话题保持最详细）
  const grades = new Map(state.grades);
  for (const id of txnIds) {
    if (id > state.maxTxnId) grades.set(id, 'ACT');
  }
  return grades;
}
