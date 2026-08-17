/**
 * 话题切换检测（lib/topic-switch.js）单测——Hermes TopicGradeManager 移植。
 * 覆盖：首轮=切换、强制短语、确认轮延续、Jaccard 延续/切换。
 */
import { describe, expect, it } from 'vitest';
import { detectTopicSwitch, applyWaterPressure, jaccard, TOPIC_JACCARD_ENTRY, FORCED_SPLIT_PHRASES, WATER_PRESSURE_DEFAULTS } from '../lib/topic-switch.js';

const fresh = () => ({ profile: '', seen: false });

describe('topic-switch 检测', () => {
  it('首个用户轮 → 切换（首轮 recall）', () => {
    const r = detectTopicSwitch('把深海主题变成插件', '', fresh());
    expect(r.switched).toBe(true);
    expect(r.state.seen).toBe(true);
  });

  it('强制分割短语 → 切换', () => {
    const st = detectTopicSwitch('把深海主题变成插件', '', fresh()).state;
    const r = detectTopicSwitch('换个话题，看看评审引擎', '', st);
    expect(r.switched).toBe(true);
    expect(FORCED_SPLIT_PHRASES).toContain('换个话题');
  });

  it('确认/简短消息（≤5 字符）→ 延续', () => {
    const st = detectTopicSwitch('把深海主题变成插件', '', fresh()).state;
    const r = detectTopicSwitch('继续', '', st);
    expect(r.switched).toBe(false);
  });

  it('Jaccard 高相似 → 延续（同话题）', () => {
    const st = detectTopicSwitch('把深海主题、颜色fork代码变为插件', '', fresh()).state;
    const r = detectTopicSwitch('现在如何？插件安装好了吗', '完成。深海主题插件已转换为独立插件', st);
    expect(r.switched).toBe(false);
  });

  it('Jaccard 低相似 → 切换（新话题）', () => {
    const st = detectTopicSwitch('把深海主题变成插件', '', fresh()).state;
    const r = detectTopicSwitch('内存优化与进程管理怎么做', '', st);
    expect(r.switched).toBe(true);
  });

  it('jaccard 函数与 Hermes 阈值对齐（ENTRY=0.04）', () => {
    expect(TOPIC_JACCARD_ENTRY).toBe(0.04);
    // 相同文本 j=1
    expect(jaccard('把深海主题变成插件', '把深海主题变成插件')).toBeGreaterThan(0.9);
    // 完全无关 j 低
    expect(jaccard('把深海主题变成插件', '天气不错今天出去走走')).toBeLessThan(0.04);
  });
});

describe('applyWaterPressure 水位压力（Hermes _apply_water_pressure 移植）', () => {
  it('start 以下不扣减', () => {
    expect(applyWaterPressure(0.5, 3000)).toBe(0.5);
    expect(applyWaterPressure(0.5)).toBe(0.5); // totalChars 缺省
    expect(applyWaterPressure(0.5, 0)).toBe(0.5);
  });
  it('start→peak 线性扣减（progress × penalty）', () => {
    // progress=(12000-5000)/(20000-5000)=0.4667 → penalty≈0.14
    const v = applyWaterPressure(0.5, 12000);
    expect(v).toBeGreaterThan(0.5 - 0.145);
    expect(v).toBeLessThan(0.5 - 0.135);
  });
  it('forceAtPeak=true：peak 及以上返回 -1（无条件切割，用户裁定）', () => {
    expect(applyWaterPressure(0.9, 25000, { forceAtPeak: true })).toBe(-1);
    expect(applyWaterPressure(0.01, 20000, { forceAtPeak: true })).toBe(-1); // 恰在 peak
  });
  it('forceAtPeak=false：peak 扣满 penalty（Hermes 原语义）', () => {
    expect(applyWaterPressure(0.5, 25000, { forceAtPeak: false })).toBeCloseTo(0.5 - 0.30, 5);
  });
  it('默认参数对齐 Hermes（5000/20000/0.30/forceAtPeak=true）', () => {
    expect(WATER_PRESSURE_DEFAULTS.splitStartChars).toBe(5000);
    expect(WATER_PRESSURE_DEFAULTS.splitPeakChars).toBe(20000);
    expect(WATER_PRESSURE_DEFAULTS.jaccardPenaltyMax).toBe(0.30);
    expect(WATER_PRESSURE_DEFAULTS.forceAtPeak).toBe(true);
  });
});

describe('detectTopicSwitch + 水位压力（entry=0 突破「永不切」）', () => {
  it('向后兼容：water 缺省时 entry=0 低相似也延续（旧行为）', () => {
    const st = detectTopicSwitch('把深海主题变成插件', '', fresh()).state;
    const r = detectTopicSwitch('内存优化与进程管理怎么做', '', st, 0);
    expect(r.switched).toBe(false);
  });
  it('线性区：水位扣减后低相似话题切换（entry=0 也切）', () => {
    const st = detectTopicSwitch('把深海主题变成插件', '', fresh()).state;
    const r = detectTopicSwitch('内存优化与进程管理怎么做', '', st, 0, { totalChars: 12000 });
    expect(r.switched).toBe(true); // effectiveJ = j - ~0.14 < 0
  });
  it('forceAtPeak：满压后高相似话题也强制切换（用户裁定「不管多接近」）', () => {
    const st = detectTopicSwitch('把深海主题、颜色fork代码变为插件', '', fresh()).state;
    const r = detectTopicSwitch('把深海主题、颜色fork代码变为插件安装好了吗', '', st, 0, { totalChars: 25000, forceAtPeak: true });
    expect(r.switched).toBe(true); // effectiveJ = -1
  });
  it('start 以下：水位不生效，高相似延续', () => {
    const st = detectTopicSwitch('把深海主题变成插件', '', fresh()).state;
    const r = detectTopicSwitch('把深海主题、颜色fork代码变为插件', '', st, 0, { totalChars: 3000 });
    expect(r.switched).toBe(false);
  });
});
