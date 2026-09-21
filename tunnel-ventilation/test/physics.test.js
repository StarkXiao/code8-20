import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG as cfg } from '../src/config.js'
import {
  activeLimits,
  advanceExact,
  emissions,
  fanAirflow,
  fanPowerKw,
  march,
  pistonAir,
  ratios,
  requiredAirflow,
  steadyConcentration,
  maxRatio,
} from '../src/physics.js'
import { tunnelVolume } from '../src/config.js'

test('风机风量：0 组为 0，多组并列存在折减且单调增', () => {
  assert.equal(fanAirflow(0, cfg), 0)
  const q4 = fanAirflow(4, cfg)
  const q8 = fanAirflow(8, cfg)
  assert.ok(q8 > q4)
  // 8 组应小于名义 8×单组（有折减）
  assert.ok(q8 < 8 * cfg.fans.groupAirflow)
  // 功率线性
  assert.equal(fanPowerKw(8, cfg), 8 * 2 * 15)
})

test('活塞风随车速降低而骤降（拥堵时通风保障差）', () => {
  const free = pistonAir(1600, 65, cfg)
  const jam = pistonAir(3400, 7, cfg)
  assert.ok(jam < free * 0.8)
})

test('排放：车速越低单位时间排放越高；货车倍率放大排放', () => {
  const fast = emissions(3000, 60, 0.2, cfg, 1)
  const slow = emissions(3000, 8, 0.2, cfg, 1)
  assert.ok(slow.co > fast.co)
  const stress = emissions(3000, 8, 0.2, cfg, 2)
  // NOx 中货车占绝对主导，倍率 ×2 应显著高于基准
  assert.ok(stress.no2 > slow.no2 * 1.5)
})

test('限值模式按车速/流量切换', () => {
  assert.equal(activeLimits(2000, 60, cfg).mode, 'normal')
  assert.equal(activeLimits(3400, 7, cfg).mode, 'jam')
  assert.equal(activeLimits(2000, 15, cfg).mode, 'jam') // 低速
  assert.equal(activeLimits(3600, 60, cfg).mode, 'jam') // 高流量
})

test('浓度解析解：从本底出发收敛到稳态，风量越大浓度越低', () => {
  const e = emissions(3000, 40, 0.15, cfg)
  const tau = tunnelVolume(cfg) / 120
  let c = { ...cfg.background }
  for (let i = 0; i < 20; i++) c = advanceExact(c, e, 120, tau, cfg)
  const cInf = steadyConcentration(e, 120, cfg)
  assert.ok(Math.abs(c.co - cInf.co) < 0.5)
  const cMoreFan = steadyConcentration(e, 200, cfg)
  assert.ok(cMoreFan.co < cInf.co)
})

test('march 沿预测序列推进，越拥堵末端浓度越高', () => {
  const free = Array.from({ length: 10 }, () => ({ flow: 1500, speed: 65, truckFraction: 0.1, q: 120 }))
  const jam = Array.from({ length: 10 }, () => ({ flow: 3400, speed: 7, truckFraction: 0.25, q: 120 }))
  const a = march({ ...cfg.background }, free, 120, cfg)
  const b = march({ ...cfg.background }, jam, 120, cfg)
  assert.ok(b[9].co > a[9].co * 2)
})

test('requiredAirflow：排放越大所需风量越大且为正有限值', () => {
  const e1 = emissions(1000, 60, 0.1, cfg)
  const e2 = emissions(3400, 7, 0.25, cfg)
  const lim = cfg.limits.jam
  const q1 = requiredAirflow(e1, lim, 0.88, cfg)
  const q2 = requiredAirflow(e2, lim, 0.88, cfg)
  assert.ok(q2 > q1)
  assert.ok(Number.isFinite(q1) && q1 > 0)
})

test('标定目标：夜间无需风机、拥堵需要多组、货车×2开满仍越限', () => {
  const cases = [
    { t: [250, 78, 0.45, 1], maxGroups: 0 },
    { t: [1600, 65, 0.1, 1], maxGroups: 0 },
    { t: [1800, 12, 0.3, 1], needMin: 2 },
    { t: [3400, 7, 0.25, 1], needMin: 6 },
  ]
  for (const c of cases) {
    const [flow, speed, tf, f] = c.t
    const e = emissions(flow, speed, tf, cfg, f)
    const pq = pistonAir(flow, speed, cfg)
    const lim = activeLimits(flow, speed, cfg)
    if (c.maxGroups === 0) {
      const r0 = maxRatio(ratios(steadyConcentration(e, pq, cfg), lim))
      assert.ok(r0 < 0.88, `工况应无需风机，实际 ${r0}`)
    }
    if (c.needMin) {
      const cUnder = steadyConcentration(e, pq + fanAirflow(c.needMin - 1, cfg), cfg)
      const rUnder = maxRatio(ratios(cUnder, lim))
      assert.ok(rUnder > 0.88, `${c.needMin - 1} 组应不足，实际 ${rUnder}`)
    }
  }
  // 货车 ×2：8 组开满仍越限 → 紧急报警前提
  const e = emissions(3400, 7, 0.25, cfg, 2)
  const pq = pistonAir(3400, 7, cfg)
  const c = steadyConcentration(e, pq + fanAirflow(8, cfg), cfg)
  const r = maxRatio(ratios(c, cfg.limits.jam))
  assert.ok(r > 1, `压力工况开满应越限，实际 ${r}`)
})
