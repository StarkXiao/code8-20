/**
 * 风机组合按需调控器。
 *
 * 三层决策（每个决策周期执行一次）：
 *   1) 安全越权：CO/烟雾超应急限、或火灾 → 全部健康风机立即投入（无滞回、无台数限制）。
 *   2) 前馈：按当前车流排放与目标浓度算出"需要多少风"
 *        Q_req = max(E_co / C_co*, E_k / C_k*, Q_min)
 *      扣除自然风与交通活塞风，得到需要的机械风，折算风机台数。
 *   3) 反馈（PI）：用实测浓度误差修正前馈倍数，消除模型偏差与扰动；
 *      叠加滞回（连续 N 个周期确认）与单次最多 4 台的变化约束，抑制风机频繁启停。
 *
 * 工程保护：最小连续运行时间、重启冷却、按累计运行时长轮换（磨损均衡）、
 * 故障风机剔除、健康风机不足时输出容量告警。
 */

import { CONFIG } from './config.js';
import { coMgToPpm } from './physics.js';

const C = CONFIG;
const JAM_SPEED_KMH = 20; // 低于该车速视为阻滞工况

/**
 * @typedef {Object} Env 控制器环境输入
 * @property {number} coMgM3        CO 浓度 mg/m³
 * @property {number} k             烟雾消光系数 m⁻¹
 * @property {number} speedKmh      平均车速
 * @property {number} coSourceMgS   CO 排放率 mg/s
 * @property {number} kSourceM2S    烟雾排放率 m²/s
 * @property {number} freeAirflow   非机械风量（自然+活塞）m³/s
 * @property {number} actualAirflow 当前总风量 m³/s（含爬坡中的机械风）
 * @property {boolean} fireActive   是否有火源
 */

export class FanController {
  constructor(mode = 'auto', { fixedCount = 12 } = {}) {
    /** @type {Array<{id:number,group:string,on:boolean,secOn:number,secOff:number,runSec:number,starts:number,fault:boolean}>} */
    this.fans = Array.from({ length: C.fan.count }, (_, i) => ({
      id: i,
      group: C.fan.groups[Math.floor(i / C.fan.perGroup)],
      on: false,
      secOn: Infinity, // 启动前视为"已停足够久"
      secOff: Infinity,
      runSec: 0,
      starts: 0,
      fault: false,
    }));
    this.mode = mode; // 'auto' 按需 | 'fixed' 定时编组 | 'manual'
    this.fixedCount = fixedCount;
    this.manualSet = new Set(); // manual 模式下指定开启的风机

    // PI 反馈与滞回计数
    this.integral = 0;
    this.upPending = 0;
    this.downPending = 0;
    this.emergencyActive = false;

    this.events = []; // {tSec, level, code, message}
    this.lastDecision = null;
  }

  get healthyFans() {
    return this.fans.filter((f) => !f.fault);
  }
  get activeCount() {
    return this.fans.filter((f) => f.on).length;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.upPending = this.downPending = 0;
    this.integral = 0;
  }

  /** 注入/解除风机故障。 */
  setFault(id, fault) {
    const fan = this.fans[id];
    if (!fan || fan.fault === fault) return;
    fan.fault = fault;
    if (fault && fan.on) {
      fan.on = false;
      fan.secOn = 0;
    }
    this.log(0, 'warn', 'FAN_FAULT', `#${id + 1} 号风机${fault ? '故障退出' : '恢复可用'}`);
  }

  /** manual 模式下指定单机开关。 */
  setManual(id, on) {
    const fan = this.fans[id];
    if (!fan || fan.fault) return;
    if (on) this.manualSet.add(id);
    else this.manualSet.delete(id);
  }

  /** 每个物理步推进电机计时（dt 秒）。 */
  tick(dt) {
    for (const f of this.fans) {
      if (f.on) {
        f.secOn += dt;
        f.runSec += dt;
        f.secOff = 0;
      } else {
        f.secOff += dt;
        f.secOn = 0;
      }
    }
  }

  log(tSec, level, code, message) {
    this.events.push({ tSec, level, code, message });
    if (this.events.length > 500) this.events.shift();
  }

  // ---- 前馈：按源项与目标浓度求需风量（限值按是否阻滞分档）----
  feedforwardDemand(env, jam) {
    const lim = C.limits;
    const coLimitMg = (jam ? lim.coJamPpm : lim.coNormalPpm) * C.emissions.coMgPerM3PerPpm;
    const kLimit = jam ? lim.kJam : lim.kNormal;
    const coTarget = coLimitMg * lim.targetCoRatio;
    const kTarget = kLimit * lim.targetKRatio;

    const qByCo = env.coSourceMgS / coTarget;
    const qByK = env.kSourceM2S / kTarget;
    return Math.max(lim.minAirflow, qByCo, qByK);
  }

  /**
   * 浓度位置（相对"正常工况控制目标"，全程不随阻滞分档跳变）。
   * 控制目标取正常限值 ×70%；浓度一旦超过它就开始加风，超过 1.15 倍加速加风，
   * 给射流风机 ~35 s 的风量爬坡预留提前量。
   */
  concentrationRatio(env) {
    const lim = C.limits;
    const coTarget = lim.coNormalPpm * C.emissions.coMgPerM3PerPpm * lim.targetCoRatio;
    const kTarget = lim.kNormal * lim.targetKRatio;
    return Math.max(env.coMgM3 / coTarget, env.k / kTarget);
  }

  /**
   * 执行一次决策。
   * @param {number} tSec
   * @param {Env} env
   * @returns 决策明细（需风量、台数、模式、原因等）
   */
  decide(tSec, env) {
    const cfg = C.control;
    const jam = env.speedKmh < JAM_SPEED_KMH;
    const coPpm = coMgToPpm(env.coMgM3);

    const emergency =
      env.fireActive ||
      env.coMgM3 > C.limits.coEmergencyPpm * C.emissions.coMgPerM3PerPpm ||
      env.k > C.limits.kEmergency;

    const qDemand = this.feedforwardDemand(env, jam);
    const concRatio = this.concentrationRatio(env);
    const err = concRatio - 1;

    // 积分项：误差为负时缓慢衰减，防止积分饱和
    this.integral += err;
    this.integral = Math.max(-2, Math.min(2, this.integral));
    if (err < 0) this.integral *= 1 - (cfg.decisionIntervalSec / cfg.integralDecaySec);
    const feedbackMult = Math.max(
      0.6,
      Math.min(cfg.maxFeedbackMult, 1 + cfg.feedbackKp * err + cfg.feedbackKi * this.integral),
    );

    const qEffective = qDemand * feedbackMult;
    const mechDemand = Math.max(0, qEffective - env.freeAirflow);
    const desiredCount = Math.min(
      this.healthyFans.length,
      Math.ceil(mechDemand / C.fan.inducedAirflow),
    );

    const detail = {
      tSec,
      jam,
      emergency,
      fire: env.fireActive,
      coPpm,
      k: env.k,
      qDemand,
      qEffective,
      freeAirflow: env.freeAirflow,
      mechDemand,
      desiredCount,
      feedbackMult,
      error: err,
      mode: this.mode,
      targetCount: this.activeCount,
      reason: 'hold',
    };

    // —— 第 1 层：安全越权 ——
    if (emergency) {
      if (!this.emergencyActive) {
        this.log(tSec, 'danger', 'EMERGENCY_ON',
          `应急启动：${env.fireActive ? '检测到火源' : '污染物超应急限（CO ' + coPpm.toFixed(0) + ' ppm）'}，全部健康风机投入`);
      }
      this.emergencyActive = true;
      detail.reason = 'emergency';
      detail.targetCount = this.healthyFans.length;
      this.applyTarget(tSec, this.healthyFans.length, { force: true });
    } else {
      if (this.emergencyActive) {
        this.emergencyActive = false;
        this.log(tSec, 'info', 'EMERGENCY_OFF', '应急条件解除，风机交回调控策略');
      }
      // —— 模式分支 ——
      if (this.mode === 'manual') {
        detail.reason = 'manual';
        this.applyManual();
      } else if (this.mode === 'fixed') {
        detail.reason = 'fixed';
        detail.targetCount = Math.min(this.fixedCount, this.healthyFans.length);
        this.applyTarget(tSec, detail.targetCount, { force: false });
      } else {
        this.applyOnDemand(tSec, env, qEffective, desiredCount, detail);
      }
    }

    detail.targetCount = this.activeCount;
    this.lastDecision = detail;
    return detail;
  }

  // —— 第 2/3 层：前馈台数 + 浓度反馈 + 滞回确认 ——
  applyOnDemand(tSec, env, qEffective, desiredCount, detail) {
    const cfg = C.control;
    const concRatio = this.concentrationRatio(env);
    detail.concRatio = concRatio;

    // 增机的两条触发路径（任一满足即计数）：
    //   A 供给路径：稳态需风量高于当前实际供风（前馈台数未到位）
    //   B 浓度路径：实测浓度已超过控制目标——此时无论前馈说什么，必须加风
    // 浓度超过目标 1.15 倍时单次加倍增机，抢回风机爬坡损失的时间
    const supplyShort = desiredCount > this.activeCount && qEffective > env.actualAirflow * cfg.upRatio;
    const concOverTarget = concRatio > 1.0;
    const needUp = supplyShort || concOverTarget;

    // 减机必须同时满足：前馈台数更少、供风裕量充足、浓度明显低于目标（防止边超标边减机）
    const needDown =
      desiredCount < this.activeCount &&
      qEffective < env.actualAirflow * cfg.downRatio &&
      concRatio < cfg.downConcurrencyRatio;

    if (needUp) {
      this.upPending++;
      this.downPending = 0;
      const dwellNeeded = concOverTarget ? 1 : cfg.upDwellDecisions;
      if (this.upPending >= dwellNeeded) {
        const step = concRatio > 1.15 ? cfg.maxChangePerDecision * 2 : cfg.maxChangePerDecision;
        const next = Math.min(this.healthyFans.length, this.activeCount + step, desiredCount + step);
        if (next > this.activeCount) {
          this.log(tSec, concRatio > 1 ? 'warn' : 'info', 'DEMAND_UP',
            `需风 ${qEffective.toFixed(0)} m³/s、浓度/目标=${concRatio.toFixed(2)}，风机 ${this.activeCount} → ${next} 台`);
        }
        this.applyTarget(tSec, next, { force: false });
        detail.reason = 'up';
        this.upPending = 0;
      }
    } else if (needDown) {
      this.downPending++;
      this.upPending = 0;
      if (this.downPending >= cfg.downDwellDecisions) {
        const next = Math.max(desiredCount, this.activeCount - cfg.maxChangePerDecision);
        if (next < this.activeCount) {
          this.log(tSec, 'info', 'DEMAND_DOWN',
            `需风回落至 ${qEffective.toFixed(0)} m³/s（浓度/目标=${concRatio.toFixed(2)}），风机 ${this.activeCount} → ${next} 台`);
        }
        this.applyTarget(tSec, next, { force: false });
        detail.reason = 'down';
        this.downPending = 0;
      }
    } else {
      this.upPending = 0;
      this.downPending = 0;
    }
  }

  applyManual() {
    for (const f of this.fans) {
      if (f.fault) continue;
      f.on = this.manualSet.has(f.id);
    }
  }

  /**
   * 把目标台数变成具体的开/停机指令。
   * force=true（应急）时跳过最小运行/冷却约束。
   */
  applyTarget(tSec, targetCount, { force }) {
    const healthy = this.healthyFans;
    const active = healthy.filter((f) => f.on);

    if (active.length < targetCount) {
      // 增机：优先累计运行时间最短的，实现磨损均衡；跳过冷却中的
      const candidates = healthy
        .filter((f) => !f.on && (force || f.secOff >= C.fan.restartCooldownSec))
        .sort((a, b) => a.runSec - b.runSec);
      let need = targetCount - active.length;
      for (const f of candidates) {
        if (need <= 0) break;
        need--;
        f.on = true;
        f.secOn = 0;
        f.starts++;
        this.log(tSec, 'info', 'FAN_START', `#${f.id + 1} 号风机（${f.group} 组）启动`);
      }
      if (need > 0) {
        this.log(tSec, 'warn', 'CAPACITY_SHORT',
          `健康/可立即启动风机不足，仍缺 ${need} 台的通风能力`);
      }
    } else if (active.length > targetCount) {
      // 减机：满足最小运行保护的在线风机中，累计运行最长者先轮休；
      // 增机侧选累计最短者，两侧配合让多日运行的累计负载向均值收敛
      // （单日双峰下基础负荷/调峰风机天然分两档，属正常现象）。
      const minRunSec = force ? 0 : C.fan.minRunSec;
      const candidates = active
        .filter((f) => f.secOn >= minRunSec)
        .sort((a, b) => b.runSec - a.runSec);
      let excess = active.length - targetCount;
      for (const f of candidates) {
        if (excess <= 0) break;
        excess--;
        f.on = false;
        f.secOff = 0;
        this.log(tSec, 'info', 'FAN_STOP', `#${f.id + 1} 号风机（${f.group} 组）停机`);
      }
      if (excess > 0 && !force) {
        this.log(tSec, 'warn', 'LOCKED_MIN_RUN',
          `${excess} 台风机处于最小运行保护期，本次暂不能停`);
      }
    }
  }
}
