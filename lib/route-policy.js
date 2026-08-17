/**
 * ca-v7 7.3 route-policy —— 路由纯策略模块（任务书 B §3.3，R1-5 / D-13 / D-14）。
 *
 * - derivePurpose：agent/request 之外的路由（工具续跑）自带 purpose；step1='main'，step>1='tool-continuation'
 * - assertRouteDecision：RouteDecision.strategy 三值预留（single/fanout/ensemble）；
 *   v1 执行器只收 single，fanout/ensemble 显式拒绝（不回改 schema，D-14）
 * - decideRoute：humanOverride 优先 → policyTable 首行命中（when 全匹配，purpose 缺省=通配）
 *   → catalog 校验 → switchPenalty 缓存纪律（D-13）；未命中返回 null（透传，不覆写）
 *
 * 人工/AI/程序优先级与压力噪声组合决策的复杂 case 不在 v1（defer：pressure/noise
 * 仅作后续版本决策输入，v1 不进判定逻辑）。
 * 纯函数模块：无 host 单例、无 IO、不 import 其他 lib。
 */

/** D-14：strategy 三值预留；v1 执行器只收 single */
export const ROUTE_STRATEGIES = ['single', 'fanout', 'ensemble'];

/** R1-5：agent/request 之外的路由自带 purpose，不经本模块 */
export function derivePurpose(step) {
  return step === 1 ? 'main' : 'tool-continuation';
}

/**
 * RouteDecision 结构断言 → { ok:true } | { ok:false, reason }
 *   'unsupported strategy: <s> (v1 executor accepts single only, D-14)'
 *   'single requires exactly 1 target'
 *   'target requires provider/model'
 *   'strategy missing'
 */
export function assertRouteDecision(decision) {
  const d = decision ?? {};
  if (!d.strategy) return { ok: false, reason: 'strategy missing' };
  if (d.strategy !== 'single') {
    // fanout/ensemble 在 ROUTE_STRATEGIES 三值预留内，但 v1 执行器只收 single（D-14）
    return { ok: false, reason: `unsupported strategy: ${d.strategy} (v1 executor accepts single only, D-14)` };
  }
  if (d.strategy === 'single') {
    const targets = Array.isArray(d.targets) ? d.targets : [];
    if (targets.length !== 1) return { ok: false, reason: 'single requires exactly 1 target' };
    if (!targets[0]?.provider || !targets[0]?.model) return { ok: false, reason: 'target requires provider/model' };
  }
  return { ok: true };
}

const sameTarget = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;
const inCatalog = (catalog, t) => !Array.isArray(catalog) || catalog.length === 0
  || catalog.some((c) => c.provider === t.provider && c.model === t.model);

/** when 全匹配：turn/step/stepMin/purpose；未写入 when 的键 = 通配 */
function whenMatches(when, { turn, step, purpose }) {
  if (!when) return true;
  if (when.turn !== undefined && turn !== when.turn) return false;
  if (when.step !== undefined && step !== when.step) return false;
  if (when.stepMin !== undefined && !(step >= when.stepMin)) return false;
  if (when.purpose !== undefined && purpose !== when.purpose) return false;
  return true;
}

/**
 * decideRoute({
 *   turn, step, purpose,          // purpose 由调用方 derivePurpose 派生
 *   humanOverride,                // { provider, model } | null（只覆盖下一步，host 负责一次性消费）
 *   policyTable,                  // [{ when: {turn?,step?,stepMin?,purpose?}, route: {provider,model} }]
 *   catalog,                      // 只读目录 [{ provider, model }]；空数组 = 不校验
 *   currentTarget,                // { provider, model } | null
 *   pressure = null, noise = null,// v1 只进 reason/元数据（复杂组合决策 defer）
 *   switchPenalty = true,         // D-13 缓存纪律：切换成本项
 * }) → RouteDecision | null
 * RouteDecision = { strategy:'single', targets:[{ provider, model }], reason, expiresAtStep, meta? }
 *   humanOverride（catalog 内或 catalog 空）→ reason 'human-override'，expiresAtStep = step+1
 *   policyTable 首行命中且目标在 catalog（若非空）：
 *     目标 ≠ currentTarget → reason `policy#<i> (switch, penalty)`，meta.switchCost=true
 *     目标 = currentTarget → reason `policy#<i> (stable)`
 *   全无效/未命中 → null（透传，不覆写）
 */
export function decideRoute({
  turn, step, purpose,
  humanOverride,
  policyTable,
  catalog,
  currentTarget,
  pressure = null, noise = null, // v1 不参与判定（defer 到组合决策版本）
  switchPenalty = true,
}) {
  // 1) humanOverride 优先（只覆盖下一步；不在 catalog（catalog 非空）则跳过回落策略表）
  if (humanOverride?.provider && humanOverride?.model && inCatalog(catalog, humanOverride)) {
    return {
      strategy: 'single',
      targets: [{ provider: humanOverride.provider, model: humanOverride.model }],
      reason: 'human-override',
      expiresAtStep: step + 1,
    };
  }
  // 2) policyTable 首行命中（when 全匹配；目标不在 catalog → 跳过该行继续；全无效 → null）
  const table = Array.isArray(policyTable) ? policyTable : [];
  for (let i = 0; i < table.length; i += 1) {
    const row = table[i];
    if (!whenMatches(row?.when, { turn, step, purpose })) continue;
    const target = row?.route;
    if (!target?.provider || !target?.model) continue;
    if (!inCatalog(catalog, target)) continue;
    const isSwitch = !sameTarget(target, currentTarget);
    const reason = isSwitch
      ? `policy#${i} (${switchPenalty ? 'switch, penalty' : 'switch'})`
      : `policy#${i} (stable)`;
    const meta = isSwitch && switchPenalty ? { switchCost: true } : undefined;
    return {
      strategy: 'single',
      targets: [{ provider: target.provider, model: target.model }],
      reason,
      expiresAtStep: step + 1,
      ...(meta ? { meta } : {}),
    };
  }
  return null;
}
