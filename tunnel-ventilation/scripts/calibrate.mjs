/**
 * 参数校准：打印各工况在不同风机档位下的稳态浓度与占限值比，
 * 用于确认「夜间不开机 / 高峰少量开机 / 拥堵多开机 / 火灾必报警」的分层是否成立。
 *   node scripts/calibrate.mjs
 */

import { DEFAULT_CONFIG as cfg } from '../src/config.js'
import {
  activeLimits,
  emissions,
  fanAirflow,
  pistonAir,
  ratios,
  steadyConcentration,
  maxRatio,
} from '../src/physics.js'

const cases = [
  ['夜间', 250, 78, 0.45],
  ['自由流', 1600, 65, 0.1],
  ['早高峰', 2900, 48, 0.14],
  ['事故缓行', 1800, 12, 0.3],
  ['拥堵', 3300, 8, 0.25],
  ['拥堵+货车×2（压力）', 3300, 8, 0.25, 2],
]

for (const [name, flow, speed, tf, truckFactor = 1] of cases) {
  const e = emissions(flow, speed, tf, cfg, truckFactor)
  const piston = pistonAir(flow, speed, cfg)
  const lim = activeLimits(flow, speed, cfg)
  console.log(`\n=== ${name}  flow=${flow} v=${speed} tf=${tf} 限值档=${lim.mode} ===`)
  console.log(`  活塞风 ${piston.toFixed(0)} m³/s`)
  for (let n = 0; n <= cfg.fans.groupCount; n += 2) {
    const q = piston + fanAirflow(n, cfg)
    const c = steadyConcentration(e, q, cfg)
    const r = ratios(c, lim)
    console.log(
      `  ${n} 组 Q=${q.toFixed(0).padStart(4)}  CO=${String(c.co.toFixed(1)).padStart(6)}ppm(${(r.co * 100).toFixed(0).padStart(3)}%)  NO2=${String(c.no2.toFixed(2)).padStart(5)}ppm(${(r.no2 * 100).toFixed(0).padStart(3)}%)  k=${String(c.smoke.toFixed(2)).padStart(5)}(${(r.smoke * 100).toFixed(0).padStart(3)}%)  max=${(maxRatio(r) * 100).toFixed(0)}%`
    )
  }
}
