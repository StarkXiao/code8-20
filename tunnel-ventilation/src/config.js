/**
 * 全局配置：所有物理参数、卫生限值、控制阈值都集中在此。
 * 单位约定：
 *   车流量 flow      : veh/h（单洞双向车道合计，单向行驶）
 *   车速   speed     : km/h
 *   风量   Q         : m³/s
 *   污染物排放 E     : g/s（全洞合计）
 *   CO / NO₂ 浓度    : ppm
 *   烟雾消光系数 k   : 1/km
 */

export const DEFAULT_CONFIG = {
  // —— 隧道几何（典型城市山岭单洞单向隧道示例）——
  tunnel: {
    length: 3200, // m
    area: 68, // m²
    lanes: 2,
  },

  // —— 射流风机：8 组，每组 2 台，共 16 台 ——
  fans: {
    groupCount: 8,
    fansPerGroup: 2,
    fanPowerKw: 15, // 单台功率 kW
    groupAirflow: 12.5, // 单组名义诱导风量 m³/s
    deratePerGroup: 0.015, // 多组并列时每组额外衰减（组间气流干扰）
  },

  // —— 交通车队构成（比例随工况变化，见 traffic.js）——
  fleet: {
    no2Fraction: 0.22, // NOx 中 NO₂ 占比
    emissionScale: 1.35, // 排放整体标定系数（车队平均，含老旧车辆）
    truckFactor: 1, // 货车排放倍率（压力测试：2 = 货车排放翻倍，模拟老旧车混入）
    // 排放因子 g/(车·km)，车速越低单位里程排放越高（简化的速度修正模型）
    emission: {
      car: {
        co: (v) => 1.35 * Math.max(0.6, 4.2 - 0.04 * v),
        nox: (v) => 1.35 * Math.max(0.12, 0.8 - 0.006 * v),
        pm: (v) => 1.35 * Math.max(0.003, 0.02 - 0.0002 * v),
      },
      truck: {
        co: (v) => 1.35 * Math.max(0.8, 4.6 - 0.05 * v),
        nox: (v) => 1.35 * Math.max(1.2, 4.2 - 0.03 * v),
        pm: (v) => 1.35 * Math.max(0.02, 0.12 - 0.0006 * v),
      },
    },
    pmToSmoke: 3500, // PM g/s 换算烟雾 k(1/km) 的系数 = 1000 × 质量消光系数 3.5 m²/g
  },

  // —— 活塞风（交通风力）经验模型：车速主导，拥堵时骤降 ——
  piston: {
    base: 25,
    speedCoef: 0.9,
    capacityVehPerH: 3600, // 单洞饱和流量
    flowCoef: 35, // V/C 项系数
    minQ: 12,
    maxQ: 200,
  },
  naturalWindSigma: 4, // 自然风脉动 m³/s（均值默认 0）

  // —— 污染物本底浓度（洞口来流）——
  background: { co: 2.0, no2: 0.05, smoke: 0.8 },

  // —— 卫生设计限值（简化工程参考值，可按实际规范调整）——
  // 参考 PIARC 与国内公路隧道通风设计常用取值：
  //   CO 正常 100 ppm / 阻塞短时 150 ppm；
  //   NO₂ 按职业接触短时限值量级取 5 ppm；
  //   烟雾 k 正常 7.5、阻塞 9（1/km）。
  limits: {
    normal: { co: 100, no2: 5.0, smoke: 7.5 },
    jam: { co: 150, no2: 5.0, smoke: 9.0 },
    jamSpeed: 20, // km/h，低于此车速按阻塞限值
    jamFlow: 3500, // veh/h，高于此流量按阻塞限值
  },

  // —— 控制器参数 ——
  control: {
    horizonSec: 1800, // 预测时域（隧道换气时间常数约 30~40 分钟）
    sampleSec: 60, // 预测采样步长
    targetRatio: 0.88, // 规划目标：最不利污染物占限值比 ≤ 0.88（提前量）
    guardRatio: 1.0, // 实测越限即解除停留约束、立即加机
    fastUpRatio: 0.95, // 实测接近越限：快速加机
    fastDownRatio: 0.7, // 实测低于该值才允许减机
    upDwellSec: 60, // 加机最小停留
    downDwellSec: 180, // 减机最小停留（减机更保守）
    emergencyRatio: 1.2, // 全机开满仍超标：报紧急警
  },

  // —— 仿真 ——
  sim: {
    physicsDtSec: 10,
    chartDtSec: 60, // 趋势曲线采样间隔（仿真秒）
    startClockSec: 4 * 3600, // 仿真从凌晨 04:00 开始
    baselineAlwaysOnFraction: 0.75, // 节能对比基线：75% 风机常开
  },

  // —— 火灾工况附加源项（g/s）——
  fire: {
    co: 25,
    nox: 0,
    pm: 6, // 浓烟
    flow: 400, // 火灾后洞内疏散车流
    speed: 4,
  },

  server: {
    port: Number(process.env.PORT) || 8088,
  },
}

/** 隧道空间体积 m³ */
export function tunnelVolume(cfg = DEFAULT_CONFIG) {
  return cfg.tunnel.length * cfg.tunnel.area
}
