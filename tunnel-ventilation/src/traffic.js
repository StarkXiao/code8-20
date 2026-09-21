/**
 * 车流模型：离散工况 + 24 小时时变曲线（含 OU 随机波动）。
 */

import { ouStep } from './rng.js'

/** 离散工况（仪表盘可手动切换，也可让系统跟随 24h 曲线） */
export const REGIMES = {
  night: { label: '夜间低流量', flow: 250, speed: 78, truckFraction: 0.45 },
  free: { label: '自由流', flow: 1600, speed: 65, truckFraction: 0.1 },
  peak: { label: '高峰', flow: 3350, speed: 40, truckFraction: 0.12 },
  jam: { label: '拥堵', flow: 3400, speed: 7, truckFraction: 0.25 },
  incident: { label: '事故缓行', flow: 1800, speed: 12, truckFraction: 0.3 },
}

const DAY_MULT = [
  // [起始小时, 流量系数(×3000), 车速 km/h, 货车比例]
  [0, 0.08, 80, 0.45],
  [5, 0.2, 78, 0.35],
  [6.5, 0.62, 60, 0.12],
  [7.5, 0.95, 46, 0.1], // 早高峰爬坡
  [8.2, 1.04, 24, 0.14], // 早高峰饱和蠕动
  [9.2, 0.55, 66, 0.12],
  [11.5, 0.7, 58, 0.14], // 午峰
  [13.5, 0.5, 68, 0.13],
  [16.5, 0.96, 44, 0.1], // 晚高峰爬坡
  [17.5, 1.07, 22, 0.14], // 晚高峰饱和蠕动
  [19, 0.55, 64, 0.12],
  [22, 0.22, 76, 0.35],
]

/** 一天中某时刻的交通均值（clockSec 从 0 点起） */
export function dailyMean(clockSec) {
  const h = (clockSec / 3600) % 24
  let row = DAY_MULT[0]
  for (const r of DAY_MULT) if (h >= r[0]) row = r
  return { flow: 3000 * row[1], speed: row[2], truckFraction: row[3] }
}

export class TrafficModel {
  constructor(rand, regime = 'daily', cfg) {
    this.rand = rand
    this.cfg = cfg
    this.regime = regime // 'daily' 或 REGIMES 的键
    const m = this._target(0)
    this.flow = m.flow
    this.speed = m.speed
    this.truckFraction = m.truckFraction
    this.last = m
  }

  _target(clockSec) {
    if (this.regime === 'daily') return dailyMean(clockSec)
    return REGIMES[this.regime] ?? REGIMES.free
  }

  setRegime(regime) {
    this.regime = regime
  }

  /** 推进 dt 秒；火灾时由 simulator 直接覆盖交通，这里只处理常规波动 */
  advance(dt, clockSec) {
    const m = this._target(clockSec)
    this.last = m
    // OU 均值回归（theta 单位 1/s，sigma 为每秒噪声尺度）：
    // 流量缓波、速度中等波动、货车比例慢漂移
    this.flow = Math.max(0, ouStep(this.flow, m.flow, 1 / 600, m.flow * 0.0022, dt, this.rand))
    this.speed = Math.max(2, ouStep(this.speed, m.speed, 1 / 300, 0.12, dt, this.rand))
    this.truckFraction = Math.min(
      0.6,
      Math.max(0.02, ouStep(this.truckFraction, m.truckFraction, 1 / 900, 0.0005, dt, this.rand))
    )
    return this.snapshot()
  }

  snapshot() {
    return {
      flow: this.flow,
      speed: this.speed,
      truckFraction: this.truckFraction,
    }
  }

  /**
   * 交通预测：均值缓慢回归到工况目标（不再叠加随机波动，
   * 避免把噪声当成上升趋势而误开风机）。
   * 返回 horizonSec 内按 sampleSec 采样的预测序列。
   */
  forecast(clockSec, horizonSec, sampleSec, current) {
    const steps = Math.ceil(horizonSec / sampleSec)
    const out = []
    let f = current.flow
    let s = current.speed
    let t = current.truckFraction
    for (let i = 0; i < steps; i++) {
      const t0 = clockSec + i * sampleSec
      const m = this._target(t0)
      const k = 1 - Math.exp(-sampleSec / 300)
      f += (m.flow - f) * k
      s += (m.speed - s) * k
      t += (m.truckFraction - t) * k
      out.push({ flow: f, speed: s, truckFraction: t })
    }
    return out
  }
}
