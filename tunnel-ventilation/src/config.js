/**
 * 全局配置：隧道几何、射流风机、交通排放、污染物限值与控制参数。
 * 所有物理量统一使用 SI 单位（流量 m³/s、浓度 mg/m³、消光系数 m⁻¹）。
 */

export const CONFIG = Object.freeze({
  // ---- 隧道本体（示例：1.2 km 双向四车道城市快速路隧道）----
  tunnel: {
    lengthM: 1200,
    areaM2: 60, // 断面面积
    volumeM3: 1200 * 60,
    // 洞口自然风/交通风之外的基线通风（m³/s）
    portalNaturalAirflow: 12,
  },

  // ---- 射流风机组：4 组 × 4 台 = 16 台 ----
  fan: {
    count: 16,
    groups: ['A', 'B', 'C', 'D'],
    perGroup: 4,
    inducedAirflow: 18, // 单台风机诱导风量 m³/s（全部开启 ≈ 4.8 m/s 断面风速）
    powerKw: 22, // 单台功率
    startupSurgeKwh: 0.05, // 单次启动冲击能耗当量
    minRunSec: 120, // 最小连续运行时间（电机保护）
    restartCooldownSec: 60, // 停机后再启动冷却
    rampTimeSec: 35, // 风量爬坡时间常数
  },

  // ---- 交通活塞风：vp = k · Q · (v/v0)^α ----
  piston: {
    coefficient: 0.0275, // 标定值：2000 veh/h、60 km/h 时 ≈ 55 m³/s
    refSpeedKmh: 60,
    exponent: 0.5,
  },

  traffic: {
    defaultDieselRatio: 0.3, // 柴油车（含货车）比例
  },

  // ---- 排放因子（混合车队均值，可按路段实测替换）----
  emissions: {
    coBaseGPerVehKm: 3.0, // 汽油车 60 km/h 基准 CO 排放
    dieselCoMultiplier: 0.7, // 柴油车 CO 相对汽油车
    smokeDieselM2PerVehKm: 1.0, // 柴油车烟雾（消光）排放
    smokeGasolineM2PerVehKm: 0.06,
    // 低速拥堵时排放恶化的指数放大（标定到工况曲线）
    coSpeedExponent: 0.03, // v=15 时 ≈ ×3.9
    smokeSpeedExponent: 0.025, // v=15 时 ≈ ×3.1
    refSpeedKmh: 60,
    maxCoSpeedFactor: 4.5,
    maxSmokeSpeedFactor: 4.0,
    // CO: ppm 与 mg/m³ 换算（20 ℃、1 atm，摩尔质量 28）
    coMgPerM3PerPpm: 1.165,
  },

  // ---- 污染物限值（参照 JTG/T D70/2-02 思路给出演示取值）----
  limits: {
    coNormalPpm: 100, // 正常交通 CO 限值
    coJamPpm: 150, // 阻滞工况短时容许
    coEmergencyPpm: 150, // 超过即进入应急
    kNormal: 0.0065, // 正常烟雾消光系数限值（对应能见度约 400 m）
    kJam: 0.009,
    kEmergency: 0.012,
    targetCoRatio: 0.7, // 按需调控目标浓度 = 限值 × 比例（留裕量）
    targetKRatio: 0.7,
    minAirflow: 15, // 最小卫生通风量 m³/s
  },

  // ---- 控制器参数 ----
  control: {
    decisionIntervalSec: 5, // 决策周期（浓度变化慢，但风机爬坡需要提前动作）
    upRatio: 1.1, // 实际需风 > 当前供风 ×1.1 才考虑加机
    downRatio: 0.7, // 需风 < 当前供风 ×0.7 才考虑减机（宽滞回，抗抖动）
    upDwellDecisions: 2, // 连续 2 次（10 s）满足才加机
    downDwellDecisions: 12, // 连续 12 次（60 s）满足才减机
    // PI 反馈修正（作用在"需风量倍数"上）
    feedbackKp: 0.8,
    feedbackKi: 0.15,
    integralDecaySec: 300,
    maxFeedbackMult: 2.5,
    maxChangePerDecision: 4, // 单次决策最多增/减台数（避免电网冲击）
    downConcurrencyRatio: 0.7, // 浓度低于目标 70% 才允许减机
  },

  // ---- 火灾源项（应急演练用）----
  fire: {
    coMgS: 40_000, // 40 g/s
    smokeM2S: 8,
  },

  // ---- 仿真 ----
  sim: {
    dtSec: 5,
    noiseRatio: 0.02, // 交通量/车速的小幅随机扰动
    seed: 20260920,
  },
});
