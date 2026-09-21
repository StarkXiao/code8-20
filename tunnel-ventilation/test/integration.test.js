import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Simulator } from '../src/simulator.js'

/** 连续推进仿真分钟数 */
function runMinutes(sim, minutes, dt = 10) {
  const steps = Math.round((minutes * 60) / dt)
  let s
  for (let i = 0; i < steps; i++) s = sim.tick(dt)
  return s
}

test('24h 自动运行：无越限、峰值留有余量、相对基线显著节能', () => {
  const sim = new Simulator(undefined, 7)
  runMinutes(sim, 24 * 60)
  const s = sim.snapshot()
  assert.equal(s.metrics.violations, 0, '按需控制不应出现越限')
  assert.ok(s.metrics.peakRatio < 1, '峰值占限比必须 <100%')
  assert.ok(s.metrics.savings > 50, `节能率应 >50%，实际 ${s.metrics.savings}%`)
  // 高峰确实开过风机（不是永远停机）
  const maxGroups = Math.max(...s.history.map((h) => h.groups))
  assert.ok(maxGroups >= 3, '高峰应至少开启 3 组风机')
})

test('拥堵持续 40 分钟：最终开满且不越限', () => {
  const sim = new Simulator(undefined, 11)
  sim.setRegime('jam')
  runMinutes(sim, 40)
  const s = sim.snapshot()
  assert.equal(s.onGroups.length, 8)
  assert.ok(s.decision.ratio < 1)
  assert.equal(s.alarm, null)
})

test('自由流：风机关停', () => {
  const sim = new Simulator(undefined, 3)
  sim.setRegime('free')
  runMinutes(sim, 30)
  const s = sim.snapshot()
  assert.equal(s.onGroups.length, 0)
})

test('火灾演练：全部风机立即投入，火灾期间持续运行，解除后自动回落', () => {
  const sim = new Simulator(undefined, 5)
  sim.setRegime('night')
  runMinutes(sim, 20)
  assert.equal(sim.snapshot().onGroups.length, 0)

  sim.triggerFire(600)
  runMinutes(sim, 2)
  assert.equal(sim.snapshot().onGroups.length, 8)

  // 火灾持续期间保持开满
  runMinutes(sim, 5)
  assert.equal(sim.snapshot().onGroups.length, 8)

  // 等火灾自动解除（600s = 10 分钟）后再跑一段时间
  runMinutes(sim, 15)
  assert.equal(sim.fire, false)
  assert.ok(sim.snapshot().onGroups.length < 8)
})

test('停机模式下发生拥堵：安全联锁闩锁接管，长期不回落到超标状态', () => {
  const sim = new Simulator(undefined, 9)
  sim.setMode('off')
  sim.setRegime('jam')
  runMinutes(sim, 50)
  const s = sim.snapshot()
  assert.ok(s.onGroups.length > 0, '联锁必须在停机模式下自动开机')
  assert.equal(s.interlockLatched, true)
  // 闩锁兜底的档位与自动模式相当（8 组），稳态占限比应 <1
  assert.equal(s.onGroups.length, 8)
  assert.ok(s.decision.ratio < 1, `ratio=${s.decision.ratio}`)
  // 整个过程峰值只能短暂越限（换气滞后所致），不应严重超标
  assert.ok(s.metrics.peakRatio < 1.15, `peak=${s.metrics.peakRatio}`)
})

test('联锁解除：拥堵消散、浓度回落后，停机模式真正停机', () => {
  const sim = new Simulator(undefined, 9)
  sim.setMode('off')
  sim.setRegime('jam')
  runMinutes(sim, 50)
  assert.equal(sim.snapshot().interlockLatched, true)
  sim.setRegime('night')
  runMinutes(sim, 40)
  const s = sim.snapshot()
  assert.equal(s.interlockLatched, false)
  assert.equal(s.onGroups.length, 0)
})

test('货车 ×2 压力工况：开满仍超标时产生紧急报警事件', () => {
  const sim = new Simulator(undefined, 13)
  sim.setRegime('jam')
  sim.setTruckFactor(2)
  runMinutes(sim, 45)
  const s = sim.snapshot()
  assert.equal(s.onGroups.length, 8)
  assert.equal(s.alarm, 'ALL_FANS_INSUFFICIENT')
  assert.ok(s.events.some((e) => e.level === 'critical' && e.message.includes('紧急报警')))
})

test('复位：所有计量清零、回到自动模式', () => {
  const sim = new Simulator(undefined, 1)
  sim.setRegime('peak')
  runMinutes(sim, 60)
  assert.ok(sim.snapshot().metrics.energyKwh > 0)
  sim.reset(1)
  const s = sim.snapshot()
  assert.equal(s.metrics.energyKwh, 0)
  assert.equal(s.mode, 'auto')
  assert.equal(s.onGroups.length, 0)
})

test('磨损均衡：长时间运行后各组累计运行时长差距不悬殊', () => {
  const sim = new Simulator(undefined, 21)
  runMinutes(sim, 24 * 60)
  const hours = Object.values(sim.snapshot().runtimeHours)
  const min = Math.min(...hours)
  const max = Math.max(...hours)
  // 轮换使用：最大差不超过最忙组的 60%
  assert.ok(max - min < max * 0.6 + 0.01, `min=${min} max=${max}`)
})

test('模式切换与事件日志：切换模式产生日志条目', () => {
  const sim = new Simulator(undefined, 2)
  sim.setMode('max')
  assert.ok(sim.events[0].message.includes('最大通风'))
  sim.triggerFire(300)
  assert.ok(sim.events.some((e) => e.level === 'critical'))
})
