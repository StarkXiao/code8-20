/**
 * 隧道通风物理模型（全混合近似 / well-mixed）。
 * 统一用「负载单位」做内部计算：
 *   CO/NO₂：ppm；烟雾：k(1/km)
 * 稳态浓度   C = C0 + E' / Q
 * 瞬态解析解 C(t) = C∞(t) + (C(0) - C∞(0))·e^(-Q/V·t)
 *   （在区间内 Q、E' 恒定时精确成立）
 */

import { tunnelVolume } from './config.js'

/** 1 ppm CO 在标准状态下对应的 mg/m³ */
export const CO_PPM_FACTOR = 1.145
/** 1 ppm NO₂ 对应的 mg/m³ */
export const NO2_PPM_FACTOR = 1.88

// —— 风机组合 ——

/**
 * n 组风机投运时的有效诱导总风量。
 * 多组并列存在气流干扰，有效风量按组次线性折减。
 */
export function fanAirflow(n, cfg) {
  const g = cfg.fans
  if (n <= 0) return 0
  const cap = Math.min(n, g.groupCount)
  let q = 0
  for (let i = 0; i < cap; i++) q += g.groupAirflow * (1 - g.deratePerGroup * i)
  return q
}

/** n 组风机功率 kW */
export function fanPowerKw(n, cfg) {
  const g = cfg.fans
  return Math.min(n, g.groupCount) * g.fansPerGroup * g.fanPowerKw
}

/**
 * 活塞风（交通风力）m³/s —— 经验模型。
 * 车越快、V/C 越高，活塞作用越强。
 */
export function pistonAir(flow, speed, cfg) {
  const p = cfg.piston
  const vc = flow / p.capacityVehPerH
  const q = p.base + p.speedCoef * speed + p.flowCoef * Math.min(vc, 1)
  return Math.min(p.maxQ, Math.max(p.minQ, q))
}

// —— 排放源项 ——

/**
 * 计算全洞污染物排放（负载单位对应的 g/s）。
 * @param {number} flow  veh/h
 * @param {number} speed km/h
 * @param {number} truckFraction 货车比例 0..1
 * @param {object} truckFactor 货车排放倍率（压力测试用，默认 1）
 * @returns {{co:number, no2:number, smoke:number}} 与浓度同量纲的源项
 */
export function emissions(flow, speed, truckFraction, cfg, truckFactor = cfg.fleet.truckFactor ?? 1) {
  const { car, truck } = cfg.fleet.emission
  const { no2Fraction, pmToSmoke } = cfg.fleet
  const L = cfg.tunnel.length
  const ft = truckFraction
  const totalVehKmPerSec = (flow * L) / 1000 / 3600 // veh·km / s

  const mix = (ef) => (1 - ft) * ef.car(speed) + ft * ef.truck(speed) * truckFactor

  const coG = totalVehKmPerSec * mix({ car: car.co, truck: truck.co })
  const noxG = totalVehKmPerSec * mix({ car: car.nox, truck: truck.nox })
  const pmG = totalVehKmPerSec * mix({ car: car.pm, truck: truck.pm })

  // g/s × 1000 = mg/s；ppm换算系数单位 mg/m³ → 「ppm·m³/s」
  const co = (coG * 1000) / CO_PPM_FACTOR
  const no2 = (noxG * no2Fraction * 1000) / NO2_PPM_FACTOR
  const smoke = pmG * pmToSmoke // (k·m³/s)
  return { co, no2, smoke }
}

// —— 限值与浓度推演 ——

/** 当前工况适用的卫生限值 */
export function activeLimits(flow, speed, cfg) {
  const jam = speed < cfg.limits.jamSpeed || flow > cfg.limits.jamFlow
  return { mode: jam ? 'jam' : 'normal', ...(jam ? cfg.limits.jam : cfg.limits.normal) }
}

/** 各污染物占限值比（>1 即越限） */
export function ratios(c, limits) {
  return {
    co: c.co / limits.co,
    no2: c.no2 / limits.no2,
    smoke: c.smoke / limits.smoke,
  }
}

export function maxRatio(r) {
  return Math.max(r.co, r.no2, r.smoke)
}

/** 稳态浓度 */
export function steadyConcentration(e, q, cfg) {
  const bg = cfg.background
  return {
    co: bg.co + e.co / q,
    no2: bg.no2 + e.no2 / q,
    smoke: bg.smoke + e.smoke / q,
  }
}

/**
 * 恒风量、恒排放下推进 dt 秒（解析解）。
 * @returns 新浓度
 */
export function advanceExact(c, e, q, dt, cfg) {
  const v = tunnelVolume(cfg)
  const tau = v / q // 换气时间常数 s
  const cInf = steadyConcentration(e, q, cfg)
  const decay = Math.exp(-dt / tau)
  return {
    co: cInf.co + (c.co - cInf.co) * decay,
    no2: cInf.no2 + (c.no2 - cInf.no2) * decay,
    smoke: cInf.smoke + (c.smoke - cInf.smoke) * decay,
  }
}

/**
 * 沿一条交通预测序列推进，返回每个采样点的浓度。
 * @param {object} c0 起始浓度
 * @param {Array<{flow,speed,truckFraction,q}>} steps
 * @param {number} dt 每步秒数
 */
export function march(c0, steps, dt, cfg, extraSource = null) {
  let c = { ...c0 }
  const out = []
  for (const s of steps) {
    const e = emissions(s.flow, s.speed, s.truckFraction, cfg, s.truckFactor ?? 1)
    if (extraSource) {
      e.co += extraSource.co ?? 0
      e.no2 += extraSource.no2 ?? 0
      e.smoke += extraSource.smoke ?? 0
    }
    c = advanceExact(c, e, s.q, dt, cfg)
    out.push({ ...c })
  }
  return out
}

/**
 * 求「恰好把稳态浓度控制在 targetRatio 以内」所需的最小总风量（连续值）。
 * 解析：要求 E/(L-C0) ≤ targetRatio → Q ≥ E / (targetRatio·L - C0)
 */
export function requiredAirflow(e, limits, targetRatio, cfg) {
  const bg = cfg.background
  const need = (em, bgC, lim) => {
    const headroom = targetRatio * lim - bgC
    return headroom > 0 ? em / headroom : Infinity
  }
  return Math.max(
    need(e.co, bg.co, limits.co),
    need(e.no2, bg.no2, limits.no2),
    need(e.smoke, bg.smoke, limits.smoke)
  )
}
