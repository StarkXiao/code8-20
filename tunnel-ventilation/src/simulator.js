/**
 * 仿真器：把车流模型、污染物演化、按需控制器、能耗计量串成一个时间推进系统。
 * 每次 tick 推进 physicsDtSec（默认 10 仿真秒），控制器按 controlInterval 决策。
 */

import { DEFAULT_CONFIG } from './config.js'
import { mulberry32 } from './rng.js'
import { TrafficModel } from './traffic.js'
import {
  advanceExact,
  emissions,
  fanAirflow,
  fanPowerKw,
  pistonAir,
  ratios,
  maxRatio,
} from './physics.js'
import { decide } from './controller.js'

export const MODES = {
  auto: { label: '自动（按需）' },
  manual: { label: '人工' },
  max: { label: '最大通风' },
  off: { label: '停机' },
}

const CONTROL_INTERVAL_SEC = 60
const MAX_EVENTS = 300
const MAX_CHART_POINTS = 24 * 60 // 24h × 每 60s 一个点

export class Simulator {
  constructor(cfg = DEFAULT_CONFIG, seed = 42) {
    this.cfg = cfg
    this.rand = mulberry32(seed)
    this.reset(seed)
  }

  reset(seed = 42) {
    this.rand = mulberry32(seed)
    this.simSec = 0
    this.clockSec = this.cfg.sim.startClockSec
    this.traffic = new TrafficModel(this.rand, 'daily', this.cfg)
    this.t = this.traffic.snapshot()

    this.conc = { ...this.cfg.background }
    this.onGroups = []
    this.manualSet = []
    this.mode = 'auto'
    this.lastChangeSec = -Infinity
    this.runtimeSec = new Map(
      Array.from({ length: this.cfg.fans.groupCount }, (_, i) => [i, 0])
    )

    this.fire = false
    this.fireUntilSec = -1
    this.truckFactor = this.cfg.fleet.truckFactor ?? 1
    this.interlockLatched = false

    this.events = []
    this.history = []
    this.lastDecision = null

    // 计量
    this.energyKwh = 0
    this.baselineEnergyKwh = 0
    this.safeSamples = 0
    this.totalSamples = 0
    this.violations = 0 // 越限次数（控制周期计）
    this.peakRatio = 0

    // 基线独立浓度（75% 风机常开，用于对比安全性）
    this.baselineConc = { ...this.cfg.background }
    this.baselineGroups = Math.round(this.cfg.fans.groupCount * this.cfg.sim.baselineAlwaysOnFraction)
    this.baselineViolations = 0

    this.chartAccum = 0
    this.controlAccum = 0

    this._log('info', '系统启动，进入自动按需调控模式')
    return this.snapshot()
  }

  _log(level, message) {
    this.events.unshift({ simSec: this.simSec, clockSec: this.clockSec, level, message })
    if (this.events.length > MAX_EVENTS) this.events.pop()
  }

  // —— 外部指令 ——

  setMode(mode, manualSet) {
    if (!MODES[mode]) throw new Error('未知模式: ' + mode)
    this.mode = mode
    if (mode !== 'manual' && mode !== 'off') this.interlockLatched = false
    if (mode === 'manual' && Array.isArray(manualSet)) {
      this.manualSet = [...new Set(manualSet.map((n) => Number(n)))]
        .filter((n) => Number.isInteger(n) && n >= 0 && n < this.cfg.fans.groupCount)
        .sort((a, b) => a - b)
    }
    this._log('info', `控制模式切换为「${MODES[mode].label}」`)
  }

  setRegime(regime) {
    this.traffic.setRegime(regime)
    this._log('info', regime === 'daily' ? '车流切换为 24 小时自动曲线' : `车流工况切换：${regime}`)
  }

  /** 触发火灾，持续 durationSec（仿真秒） */
  triggerFire(durationSec = 1200) {
    this.fire = true
    this.fireUntilSec = this.simSec + durationSec
    this._log('critical', '检测到火灾信号！射流风机全部投入，进入排烟模式')
  }

  clearFire() {
    if (this.fire) this._log('info', '火灾解除，恢复按需调控')
    this.fire = false
    this.fireUntilSec = -1
    this.interlockLatched = false
  }

  /** 货车排放倍率（压力测试） */
  setTruckFactor(factor) {
    this.truckFactor = Math.max(0.5, Math.min(3, Number(factor)))
    this._log('warn', `货车排放倍率调整为 ×${this.truckFactor.toFixed(1)}`)
  }

  // —— 时间推进 ——

  tick(dt = this.cfg.sim.physicsDtSec) {
    this.simSec += dt
    this.clockSec = (this.clockSec + dt) % 86400

    if (this.fire && this.simSec >= this.fireUntilSec) this.clearFire()

    // 1) 车流推进（火灾时交通强制为疏散状态）
    if (this.fire) {
      this.t = {
        flow: this.cfg.fire.flow,
        speed: this.cfg.fire.speed,
        truckFraction: 0.2,
      }
    } else {
      this.t = this.traffic.advance(dt, this.clockSec)
    }

    // 2) 控制决策（每 CONTROL_INTERVAL_SEC 一次，首拍立即决策）
    this.controlAccum += dt
    if (this.controlAccum >= CONTROL_INTERVAL_SEC - 1e-9 || this.lastDecision === null) {
      this.controlAccum = 0
      this._control()
    }

    // 3) 污染物演化（实际组合）
    const fanQ = fanAirflow(this.onGroups.length, this.cfg)
    const pistonQ = this.fire ? 20 : pistonAir(this.t.flow, this.t.speed, this.cfg)
    const naturalQ = pistonQ // 自然风均值 0 时，驱动风量=活塞风+风机风
    const q = naturalQ + fanQ
    let e = emissions(
      this.t.flow * (this.fire ? 0.6 : 1),
      this.t.speed,
      this.t.truckFraction,
      this.cfg,
      this.truckFactor
    )
    if (this.fire) {
      e.co += this.cfg.fire.co
      e.no2 += this.cfg.fire.nox
      e.smoke += this.cfg.fire.pm
    }
    this.conc = advanceExact(this.conc, e, q, dt, this.cfg)

    // 4) 基线（固定 75% 风机常开）
    const qBase = pistonQ + fanAirflow(this.baselineGroups, this.cfg)
    this.baselineConc = advanceExact(this.baselineConc, e, qBase, dt, this.cfg)

    // 5) 计量
    this.energyKwh += (fanPowerKw(this.onGroups.length, this.cfg) * dt) / 3600
    this.baselineEnergyKwh += (fanPowerKw(this.baselineGroups, this.cfg) * dt) / 3600
    for (const id of this.onGroups) this.runtimeSec.set(id, (this.runtimeSec.get(id) ?? 0) + dt)

    // 6) 趋势曲线采样
    this.chartAccum += dt
    if (this.chartAccum >= this.cfg.sim.chartDtSec - 1e-9) {
      this.chartAccum = 0
      this._sample(pistonQ, fanQ, q)
    }

    return this.snapshot()
  }

  _control() {
    const forecastTraffic = this.fire
      ? Array.from({ length: this.cfg.control.horizonSec / this.cfg.control.sampleSec }, () => ({
          flow: this.cfg.fire.flow,
          speed: this.cfg.fire.speed,
          truckFraction: 0.2,
        }))
      : this.traffic
          .forecast(
            this.clockSec,
            this.cfg.control.horizonSec,
            this.cfg.control.sampleSec,
            this.t
          )
          .map((f) => ({ ...f, truckFactor: this.truckFactor }))
    const pistonQ = this.fire ? 20 : pistonAir(this.t.flow, this.t.speed, this.cfg)

    const d = decide({
      simSec: this.simSec,
      c: this.conc,
      traffic: this.t,
      forecast: forecastTraffic,
      pistonQ,
      onGroups: this.onGroups,
      lastChangeSec: this.lastChangeSec,
      runtimeSec: this.runtimeSec,
      mode: this.mode,
      manualSet: this.manualSet,
      fire: this.fire,
      interlockLatched: this.interlockLatched,
      cfg: this.cfg,
    })

    this.interlockLatched = d.interlockLatched

    const changed = d.nextGroups.length !== this.onGroups.length ||
      d.nextGroups.some((g, i) => g !== this.onGroups[i])
    if (changed) {
      const before = this.onGroups.length
      this.onGroups = d.nextGroups
      this.lastChangeSec = this.simSec
      const names = d.nextGroups.map((g) => g + 1).join(',') || '无'
      this._log(
        d.alarm || this.fire ? 'warn' : 'info',
        `风机组合调整：${before} 组 → ${d.nextGroups.length} 组（开启：${names}）`
      )
    }
    if (d.alarm) this._log('critical', `报警：${d.alarm}`)
    d.events.forEach(([level, msg]) => this._log(level, msg))
    this.lastDecision = d

    // 安全性统计（按控制周期）
    this.totalSamples++
    if (d.currentRatio < 1) this.safeSamples++
    else this.violations++
    this.peakRatio = Math.max(this.peakRatio, d.currentRatio)

    const baseR = maxRatio(ratios(this.baselineConc, d.limits))
    if (baseR >= 1) this.baselineViolations++
  }

  _sample(pistonQ, fanQ, totalQ) {
    const lim = this.lastDecision?.limits
    const r = lim ? ratios(this.conc, lim) : { co: 0, no2: 0, smoke: 0 }
    const rb = lim ? ratios(this.baselineConc, lim) : { co: 0, no2: 0, smoke: 0 }
    this.history.push({
      simSec: this.simSec,
      clock: this.clockSec,
      co: this.conc.co,
      no2: this.conc.no2,
      smoke: this.conc.smoke,
      ratio: maxRatio(r),
      baselineRatio: maxRatio(rb),
      flow: this.t.flow,
      speed: this.t.speed,
      pistonQ,
      fanQ,
      totalQ,
      groups: this.onGroups.length,
      powerKw: fanPowerKw(this.onGroups.length, this.cfg),
    })
    if (this.history.length > MAX_CHART_POINTS) this.history.shift()
  }

  // —— 输出 ——

  clockText() {
    const h = Math.floor(this.clockSec / 3600)
    const m = Math.floor((this.clockSec % 3600) / 60)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  snapshot() {
    const fanQ = fanAirflow(this.onGroups.length, this.cfg)
    const pistonQ = this.fire ? 20 : pistonAir(this.t.flow, this.t.speed, this.cfg)
    const d = this.lastDecision
    const savings =
      this.baselineEnergyKwh > 0
        ? 1 - this.energyKwh / this.baselineEnergyKwh
        : 0
    return {
      simSec: this.simSec,
      clock: this.clockText(),
      mode: this.mode,
      modeLabel: MODES[this.mode].label,
      traffic: this.t,
      concentration: this.conc,
      pistonQ,
      fanQ,
      totalQ: pistonQ + fanQ,
      onGroups: this.onGroups,
      groupCount: this.cfg.fans.groupCount,
      fansPerGroup: this.cfg.fans.fansPerGroup,
      groupAirflow: this.cfg.fans.groupAirflow,
      runtimeHours: Object.fromEntries(
        [...this.runtimeSec.entries()].map(([k, v]) => [k, +(v / 3600).toFixed(2)])
      ),
      fire: this.fire,
      truckFactor: this.truckFactor,
      interlockLatched: this.interlockLatched,
      alarm: d?.alarm ?? null,
      decision: d
        ? {
            planned: d.planned,
            rationale: d.rationale,
            ratio: d.currentRatio,
            ratios: d.ratios,
            limits: d.limits,
          }
        : null,
      metrics: {
        energyKwh: +this.energyKwh.toFixed(1),
        baselineEnergyKwh: +this.baselineEnergyKwh.toFixed(1),
        savings: +(savings * 100).toFixed(1),
        safeRate: this.totalSamples ? +((this.safeSamples / this.totalSamples) * 100).toFixed(1) : 100,
        violations: this.violations,
        baselineViolations: this.baselineViolations,
        peakRatio: +this.peakRatio.toFixed(2),
      },
      events: this.events.slice(0, 80),
      history: this.history,
    }
  }
}
