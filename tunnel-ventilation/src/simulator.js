/**
 * 时间步进仿真器：交通场景 → 排放源项 → 物理扩散 → 控制器决策 → 风机状态 → 能耗/安全指标。
 */

import { CONFIG } from './config.js';
import { emissionRates, pistonAirflow, wellMixedStep, coMgToPpm, visibilityMeters } from './physics.js';
import { FanController } from './controller.js';
import { getScenario, scenarioTrafficAt, scenarioFireAt, SCENARIO_DURATION } from './scenarios.js';

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 风机机械风随启动/停机一阶爬坡，模拟推力建立过程。 */
function ramp(current, target, dt, tau) {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export class Simulator {
  constructor(scenarioId = 'weekday', { mode = 'auto', fixedCount = 12, noise = true, seed } = {}) {
    this.scenario = getScenario(scenarioId);
    this.dt = CONFIG.sim.dtSec;
    this.duration = SCENARIO_DURATION;
    this.noise = noise;
    this.rng = mulberry32(seed ?? CONFIG.sim.seed + scenarioId.length * 7);

    this.controller = new FanController(mode, { fixedCount });
    this.reset();
  }

  reset() {
    this.t = 0;
    this.stepCount = 0;
    this.co = 0; // mg/m³
    this.k = 0; // m⁻¹
    this.mechAirflow = 0; // 爬坡中的机械风量
    this.finished = false;

    this.metrics = {
      fanEnergyKwh: 0, // 运行电耗
      startupEnergyKwh: 0, // 启动冲击能耗
      violationSec: 0, // 超正常限值累计时长
      emergencySec: 0, // 应急工况时长
      maxCoPpm: 0,
      maxK: 0,
      minVisibilityM: Infinity,
      fanStarts: 0,
      fanRunSeconds: 0, // Σ 风机运行秒数
    };
    this.series = []; // 全量历史（无头仿真用）
    this.lastEnv = null;
  }

  get totalAirflow() {
    return CONFIG.tunnel.portalNaturalAirflow + this.lastEnv.piston + this.mechAirflow;
  }

  currentTraffic() {
    const t = scenarioTrafficAt(this.scenario, this.t);
    if (!this.noise) return t;
    // ±2% 随机扰动
    const n = () => 1 + (this.rng() - 0.5) * 2 * CONFIG.sim.noiseRatio;
    return { q: Math.max(0, t.q * n()), v: Math.max(1, t.v * n()), d: t.d };
  }

  step() {
    if (this.finished) return null;
    const dt = this.dt;
    const cfg = CONFIG;

    // 1) 交通与火灾
    const traffic = this.currentTraffic();
    const fire = scenarioFireAt(this.scenario, this.t);

    // 2) 源项排放
    const { coMgS, smokeM2S } = emissionRates(traffic.q, traffic.v, traffic.d, fire);

    // 3) 非机械通风（自然 + 活塞）
    const piston = pistonAirflow(traffic.q, traffic.v);
    const freeAirflow = cfg.tunnel.portalNaturalAirflow + piston;

    // 4) 控制决策（按决策周期调用；用步数索引，避免浮点取模失效）
    const decisionEvery = cfg.control.decisionIntervalSec;
    if (this.stepCount % Math.round(decisionEvery / dt) === 0) {
      this.controller.decide(this.t, {
        coMgM3: this.co,
        k: this.k,
        speedKmh: traffic.v,
        coSourceMgS: coMgS,
        kSourceM2S: smokeM2S,
        freeAirflow,
        actualAirflow: freeAirflow + this.mechAirflow,
        fireActive: fire,
      });
    }

    // 5) 机械风爬坡 + 电机计时
    const targetMech = this.controller.activeCount * cfg.fan.inducedAirflow;
    const prevActive = this.controller.activeCount;
    this.mechAirflow = ramp(this.mechAirflow, targetMech, dt, cfg.fan.rampTimeSec);
    this.controller.tick(dt);
    const totalAirflow = freeAirflow + this.mechAirflow;
    const env = { ...traffic, fire, piston, freeAirflow, totalAirflow, coMgS, smokeM2S };
    this.lastEnv = env;

    // 6) 污染物扩散一步
    const V = cfg.tunnel.volumeM3;
    this.co = wellMixedStep(this.co, coMgS, totalAirflow, V, dt);
    this.k = wellMixedStep(this.k, smokeM2S, totalAirflow, V, dt);
    const coPpm = coMgToPpm(this.co);
    const vis = visibilityMeters(this.k);

    // 7) 指标累计
    const activeNow = this.controller.activeCount;
    this.metrics.fanRunSeconds += activeNow * dt;
    this.metrics.fanEnergyKwh += (activeNow * cfg.fan.powerKw * dt) / 3600;
    // 本步内发生的启动（starts 增量 × 冲击能耗）
    const totalStarts = this.controller.fans.reduce((s, f) => s + f.starts, 0);
    if (totalStarts > (this._startsPrev ?? 0)) {
      this.metrics.startupEnergyKwh += (totalStarts - (this._startsPrev ?? 0)) * cfg.fan.startupSurgeKwh;
    }
    this._startsPrev = totalStarts;

    const jam = traffic.v < 20;
    const coLimit = jam ? cfg.limits.coJamPpm : cfg.limits.coNormalPpm;
    const kLimit = jam ? cfg.limits.kJam : cfg.limits.kNormal;
    if (coPpm > coLimit || this.k > kLimit) this.metrics.violationSec += dt;
    if (this.controller.emergencyActive) this.metrics.emergencySec += dt;
    this.metrics.maxCoPpm = Math.max(this.metrics.maxCoPpm, coPpm);
    this.metrics.maxK = Math.max(this.metrics.maxK, this.k);
    this.metrics.minVisibilityM = Math.min(this.metrics.minVisibilityM, vis);
    this.metrics.fanStarts = totalStarts;

    const record = {
      t: this.t,
      q: traffic.q,
      v: traffic.v,
      d: traffic.d,
      fire: env.fire,
      coPpm,
      k: this.k,
      vis,
      piston,
      mech: this.mechAirflow,
      airflow: totalAirflow,
      fans: activeNow,
      emergency: this.controller.emergencyActive,
      decision: this.controller.lastDecision?.reason ?? 'hold',
    };
    this.series.push(record);

    this.t += dt;
    this.stepCount++;
    if (this.t >= this.duration) this.finished = true;
    return record;
  }

  /** 跑完整个场景并汇总。 */
  run() {
    while (!this.finished) this.step();
    return { metrics: this.summary(), series: this.series };
  }

  summary() {
    const hours = this.duration / 3600;
    return {
      ...this.metrics,
      totalEnergyKwh: this.metrics.fanEnergyKwh + this.metrics.startupEnergyKwh,
      avgFans: this.metrics.fanRunSeconds / this.duration,
      energyPerHourKwh: this.metrics.fanEnergyKwh / hours,
      violationPct: (this.metrics.violationSec / this.duration) * 100,
    };
  }

  /** 大屏快照（下采样，控制内存）。 */
  snapshot(stride = 12) {
    const coPpm = coMgToPpm(this.co);
    return {
      t: this.t,
      duration: this.duration,
      finished: this.finished,
      scenario: { id: this.scenario.id, name: this.scenario.name },
      mode: this.controller.mode,
      traffic: { q: this.lastEnv?.q ?? 0, v: this.lastEnv?.v ?? 0, d: this.lastEnv?.d ?? 0 },
      concentrations: { coPpm, k: this.k, visibilityM: visibilityMeters(this.k) },
      airflow: {
        total: this.lastEnv?.totalAirflow ?? 0,
        piston: this.lastEnv?.piston ?? 0,
        natural: CONFIG.tunnel.portalNaturalAirflow,
        mechanical: this.mechAirflow,
      },
      emergency: this.controller.emergencyActive,
      fire: this.lastEnv?.fire ?? false,
      fans: this.controller.fans.map((f) => ({
        id: f.id,
        group: f.group,
        on: f.on,
        fault: f.fault,
        runSec: Math.round(f.runSec),
        starts: f.starts,
      })),
      activeFans: this.controller.activeCount,
      demand: this.controller.lastDecision
        ? {
            qDemand: this.controller.lastDecision.qDemand,
            qEffective: this.controller.lastDecision.qEffective,
            feedbackMult: this.controller.lastDecision.feedbackMult,
            desiredCount: this.controller.lastDecision.desiredCount,
            reason: this.controller.lastDecision.reason,
          }
        : null,
      metrics: this.summary(),
      events: this.controller.events.slice(-12),
      series: this.series.filter((_, i) => i % stride === 0),
    };
  }
}

/** 同一交通场景下两种策略对比（定时编组 vs 按需调控）。 */
export function compareStrategies(scenarioId, fixedCount = 12) {
  const fixed = new Simulator(scenarioId, { mode: 'fixed', fixedCount, noise: false }).run();
  const auto = new Simulator(scenarioId, { mode: 'auto', noise: false }).run();
  const saving = ((fixed.metrics.totalEnergyKwh - auto.metrics.totalEnergyKwh) / fixed.metrics.totalEnergyKwh) * 100;
  return {
    scenarioId,
    fixed: fixed.metrics,
    auto: auto.metrics,
    energySavingPct: saving,
  };
}
