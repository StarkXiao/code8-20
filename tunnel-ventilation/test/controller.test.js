import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG as cfg } from '../src/config.js'
import { decide, planGroups, selectGroups } from '../src/controller.js'
import { emissions, fanAirflow, pistonAir, steadyConcentration, ratios, maxRatio } from '../src/physics.js'

const runtime = () => new Map(Array.from({ length: 8 }, (_, i) => [i, 0]))

function baseCtx(over = {}) {
  const traffic = over.traffic ?? { flow: 1600, speed: 65, truckFraction: 0.1 }
  const pistonQ = pistonAir(traffic.flow, traffic.speed, cfg)
  return {
    simSec: 10000,
    c: { ...cfg.background },
    traffic,
    forecast: Array.from({ length: 30 }, () => ({ ...traffic })),
    pistonQ,
    onGroups: [],
    lastChangeSec: -1e9,
    runtimeSec: runtime(),
    mode: 'auto',
    manualSet: [],
    fire: false,
    cfg,
    ...over,
  }
}

test('磨损均衡：加机选最闲的组，减机停最忙的组', () => {
  const rt = new Map([[0, 100], [1, 50], [2, 80], [3, 10]])
  const added = selectGroups([], 2, rt)
  assert.deepEqual(added, [1, 3]) // 运行时长最少的两组
  const removed = selectGroups([0, 1, 2, 3], 2, rt)
  assert.deepEqual(removed.sort(), [1, 3]) // 停掉最忙的 0、2
})

test('自由流预测：0 组即可满足', () => {
  const ctx = baseCtx()
  const { plan } = planGroups(ctx.c, ctx.forecast, ctx.pistonQ, cfg)
  assert.equal(Math.max(...plan), 0)
  const d = decide(ctx)
  assert.equal(d.target, 0)
})

test('拥堵预测：稳态约束下规划开满且不报警（8 组稳态安全）', () => {
  const traffic = { flow: 3400, speed: 7, truckFraction: 0.25 }
  const ctx = baseCtx({
    traffic,
    forecast: Array.from({ length: 30 }, () => traffic),
    pistonQ: pistonAir(3400, 7, cfg),
  })
  const d = decide(ctx)
  assert.equal(d.target, 8)
  assert.equal(d.alarm, null)
})

test('货车 ×2 压力：开满仍报紧急警', () => {
  const traffic = { flow: 3400, speed: 7, truckFraction: 0.25, truckFactor: 2 }
  // 给一个已经很高的浓度，使实测越限
  const e = emissions(3400, 7, 0.25, cfg, 2)
  const c = steadyConcentration(e, pistonAir(3400, 7, cfg) + fanAirflow(8, cfg), cfg)
  const ctx = baseCtx({
    traffic,
    c,
    forecast: Array.from({ length: 30 }, () => traffic),
    pistonQ: pistonAir(3400, 7, cfg),
    onGroups: [0, 1, 2, 3, 4, 5, 6, 7],
  })
  const d = decide(ctx)
  assert.equal(d.target, 8)
  assert.equal(d.alarm, 'ALL_FANS_INSUFFICIENT')
})

test('滞环：刚加机后即使预测回落也不立刻减机', () => {
  // 当前 2 组、浓度仍偏高、上次变更在 10s 前
  const traffic = { flow: 3000, speed: 40, truckFraction: 0.12 }
  const ctx = baseCtx({
    traffic,
    forecast: Array.from({ length: 30 }, () => ({ flow: 1000, speed: 70, truckFraction: 0.1 })),
    onGroups: [0, 1],
    lastChangeSec: 9990, // 10s 前
    c: { co: 60, no2: 2, smoke: 3 },
  })
  const d = decide(ctx)
  assert.equal(d.target, 2, '减机停留时间内应保持')
})

test('实测越限保护：快速加机，无视停留时间', () => {
  const traffic = { flow: 3000, speed: 30, truckFraction: 0.2 }
  const c = { co: 105, no2: 5.2, smoke: 7.6 } // 全部越限
  const ctx = baseCtx({
    traffic,
    forecast: Array.from({ length: 30 }, () => traffic),
    onGroups: [0, 1],
    lastChangeSec: 9995, // 5s 前刚变过
    c,
  })
  const d = decide(ctx)
  assert.ok(d.target > 2)
})

test('停机模式默认不开机；越限后联锁闩锁生效，浓度未回落前不解除', () => {
  const ctx = baseCtx({ mode: 'off' })
  assert.equal(decide(ctx).target, 0)
  assert.equal(decide(ctx).interlockLatched, false)

  // 越限：闩锁置位，即使人工目标是 0 也按预测兜底
  const jam = { flow: 3400, speed: 7, truckFraction: 0.25 }
  const high = baseCtx({
    mode: 'off',
    traffic: jam,
    forecast: Array.from({ length: 30 }, () => jam),
    pistonQ: pistonAir(3400, 7, cfg),
    c: { co: 160, no2: 5.6, smoke: 9.5 },
  })
  const d1 = decide(high)
  assert.equal(d1.interlockLatched, true)
  assert.ok(d1.target >= 8)

  // 浓度仍在 70%~100% 之间：闩锁保持，不退回全关（闩锁状态由外部跨周期传入）
  const mid = { ...high, interlockLatched: true, c: { co: 120, no2: 4.2, smoke: 7 } }
  const d2 = decide(mid)
  assert.equal(d2.interlockLatched, true)
  assert.ok(d2.target >= 7, '闩锁期间必须按预测兜底')

  // 浓度低但拥堵预测仍在：闩锁不能解除（否则浓度会重新积累）
  const stillJam = { ...high, interlockLatched: true, c: { co: 60, no2: 2, smoke: 3 } }
  const d2b = decide(stillJam)
  assert.equal(d2b.interlockLatched, true)
  assert.equal(d2b.target, 8)

  // 浓度低且车流消散（预测变为自由流）：解除并真正停机
  const free = { flow: 1600, speed: 65, truckFraction: 0.1 }
  const low = {
    ...high,
    interlockLatched: true,
    traffic: free,
    forecast: Array.from({ length: 30 }, () => free),
    pistonQ: pistonAir(1600, 65, cfg),
    c: { co: 60, no2: 2, smoke: 3 },
  }
  const d3 = decide(low)
  assert.equal(d3.interlockLatched, false)
  assert.equal(d3.target, 0)
})

test('火灾：无视当前模式开满', () => {
  const ctx = baseCtx({ mode: 'off', fire: true })
  const d = decide(ctx)
  assert.equal(d.target, 8)
  assert.ok(d.events.some(([lv]) => lv === 'critical'))
})

test('最大通风模式：始终开满', () => {
  const ctx = baseCtx({ mode: 'max', traffic: { flow: 200, speed: 80, truckFraction: 0.4 } })
  assert.equal(decide(ctx).target, 8)
})

test('人工模式：按指定组数执行', () => {
  const ctx = baseCtx({
    mode: 'manual',
    manualSet: [0, 2, 4],
    onGroups: [1, 3],
  })
  const d = decide(ctx)
  assert.equal(d.target, 3)
  assert.equal(d.nextGroups.length, 3)
})
