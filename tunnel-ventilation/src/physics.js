/**
 * 隧道通风物理模型（零依赖）。
 *
 * 采用一维均匀混合（CSTR）近似：
 *   V·dC/dt = E(t) − Q(t)·C
 * - E：交通源项排放率（CO: mg/s，烟雾: m²/s）
 * - Q：通风量（自然风 + 交通活塞风 + 射流风机诱导风）
 * - V：隧道容积
 * 该模型对长隧道分段建模是简化，但足以支撑"按需调控"的控制律设计与闭环验证。
 */

import { CONFIG } from './config.js';

const C = CONFIG;

/** 低速行驶时的排放恶化系数（指数曲线，封顶）。 */
export function speedFactor(speedKmh, exponent, max) {
  const f = Math.exp(exponent * (C.emissions.refSpeedKmh - speedKmh));
  return Math.min(max, f);
}

/**
 * 交通活塞风量（m³/s）。
 * 与交通量线性相关、与车速开方相关；拥堵时车多但慢，活塞风显著下降。
 */
export function pistonAirflow(trafficPerHour, speedKmh) {
  const p = C.piston;
  const speedTerm = Math.pow(Math.max(speedKmh, 0) / p.refSpeedKmh, p.exponent);
  return p.coefficient * Math.max(trafficPerHour, 0) * speedTerm;
}

/**
 * 交通污染源排放率。
 * @returns {{coMgS:number, smokeM2S:number}}
 */
export function emissionRates(trafficPerHour, speedKmh, dieselRatio, fireActive = false) {
  const e = C.emissions;
  const tunnelKm = C.tunnel.lengthM / 1000;
  const d = Math.min(Math.max(dieselRatio, 0), 1);
  const speed = Math.max(speedKmh, 1);

  const fCo = speedFactor(speed, e.coSpeedExponent, e.maxCoSpeedFactor);
  const fSmoke = speedFactor(speed, e.smokeSpeedExponent, e.maxSmokeSpeedFactor);

  // 混合车队单车排放因子
  const coPerVehKm = e.coBaseGPerVehKm * ((1 - d) + d * e.dieselCoMultiplier);
  const smokePerVehKm =
    e.smokeGasolineM2PerVehKm * (1 - d) + e.smokeDieselM2PerVehKm * d;

  const vehPerSec = Math.max(trafficPerHour, 0) / 3600;

  let coMgS = vehPerSec * tunnelKm * fCo * coPerVehKm * 1000; // g → mg
  let smokeM2S = vehPerSec * tunnelKm * fSmoke * smokePerVehKm;

  // 火灾源项叠加（应急演练）
  if (fireActive) {
    coMgS += C.fire.coMgS;
    smokeM2S += C.fire.smokeM2S;
  }

  return { coMgS, smokeM2S };
}

export function coMgToPpm(mgPerM3) {
  return mgPerM3 / C.emissions.coMgPerM3PerPpm;
}

/**
 * 均匀混合模型一步积分（解析欧拉步，dt 取 5 s 足够稳定）。
 * @param concentration 当前浓度（mg/m³ 或 m⁻¹）
 * @param source        源项排放率（mg/s 或 m²/s⁻¹）
 * @param airflow       通风量 m³/s
 * @param volume        隧道容积 m³
 */
export function wellMixedStep(concentration, source, airflow, volume, dtSec) {
  const next = concentration + (dtSec * (source - airflow * concentration)) / volume;
  return next < 0 ? 0 : next;
}

/** 消光系数 k 换算能见度（m）：能见度 ≈ 2.63 / k（车灯照明经验关系）。 */
export function visibilityMeters(k) {
  return k > 1e-6 ? 2.63 / k : 9999;
}
