/**
 * 按需调控核心：
 *  1. 读取当前实测浓度与交通预测；
 *  2. 在预测时域内推演「每个候选风机档位」的浓度轨迹；
 *  3. 选最不利污染物占限值比 ≤ targetRatio 的最小档位（能耗最优）；
 *  4. 叠加滞环 / 最小停留时间 / 实测越限保护 / 紧急报警。
 * 任何模式下安全联锁优先：浓度越限且风机未满则自动加机，手动/停机模式也不能旁路。
 */

import {
  activeLimits,
  emissions,
  fanAirflow,
  march,
  maxRatio,
  pistonAir,
  ratios,
  steadyConcentration,
} from './physics.js'

/**
 * 规划：沿预测序列找出每一步需要的最小组数。
 * @returns {{plan: number[], worst: number, neededQ: number[]}}
 */
export function planGroups(c, forecast, pistonQ, cfg, extraSource = null) {
  const cp = cfg.control
  const dt = cp.sampleSec
  const plan = []
  const worst = []
  const neededQ = []
  // 从多到少试档，选每个时刻满足要求的最小档
  for (let n = 0; n <= cfg.fans.groupCount; n++) {
    const q = pistonQ + fanAirflow(n, cfg)
    const steps = forecast.map((f) => ({ ...f, q }))
    const traj = march(c, steps, dt, cfg, extraSource)
    traj.forEach((cc, i) => {
      const lim = activeLimits(steps[i].flow, steps[i].speed, cfg)
      const rTrans = maxRatio(ratios(cc, lim))
      // 末端稳态约束：换气时间常数约 30~60 分钟，长于预测时域。
      // 若该交通状况持续存在，稳态也必须达标，避免"久堵慢积"导致欠通风。
      const eInf = emissions(
        steps[i].flow,
        steps[i].speed,
        steps[i].truckFraction,
        cfg,
        steps[i].truckFactor ?? 1
      )
      if (extraSource) {
        eInf.co += extraSource.co ?? 0
        eInf.no2 += extraSource.no2 ?? 0
        eInf.smoke += extraSource.smoke ?? 0
      }
      const rInf = maxRatio(ratios(steadyConcentration(eInf, q, cfg), lim))
      const r = Math.max(rTrans, rInf)
      if (n === cfg.fans.groupCount) {
        worst[i] = r
        neededQ[i] = q
      }
      if (plan[i] === undefined && r <= cp.targetRatio) plan[i] = n
    })
  }
  // 任何档位都压不住的时刻，plan 留 undefined → 开满
  for (let i = 0; i < forecast.length; i++) if (plan[i] === undefined) plan[i] = cfg.fans.groupCount
  return { plan, worst, neededQ }
}

/** 按累计运行时长做磨损均衡：加机选最闲的组，减机停最忙的组 */
export function selectGroups(currentOn, target, runtimeSec) {
  const on = new Set(currentOn)
  if (target > on.size) {
    const add = [...runtimeSec.entries()]
      .filter(([id]) => !on.has(id))
      .sort((a, b) => a[1] - b[1])
      .slice(0, target - on.size)
    add.forEach(([id]) => on.add(id))
  } else if (target < on.size) {
    const remove = [...on]
      .map((id) => [id, runtimeSec.get(id) ?? 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, on.size - target)
    remove.forEach(([id]) => on.delete(id))
  }
  return [...on].sort((a, b) => a - b)
}

/**
 * 主决策。
 * @param ctx
 *   simSec        仿真累计秒（用于停留计时）
 *   c             当前浓度
 *   traffic       当前车流 {flow,speed,truckFraction}
 *   forecast      交通预测序列
 *   pistonQ       当前活塞风量
 *   onGroups      当前开启的组 id
 *   lastChangeSec 上次组合变更时刻
 *   runtimeSec   Map：每组累计运行秒数
 *   mode          auto | manual | max | off
 *   manualSet     manual 模式下请求开启的组 id
 *   fire          是否火灾
 *   cfg
 */
export function decide(ctx) {
  const { cfg, simSec, c, traffic, forecast, pistonQ, onGroups, lastChangeSec, runtimeSec, mode } =
    ctx
  const sinceChange = simSec - lastChangeSec
  const curN = onGroups.length
  const lim = activeLimits(traffic.flow, traffic.speed, cfg)
  const rNow = ratios(c, lim)
  const mNow = maxRatio(rNow)

  const events = []
  let target = curN
  let alarm = null
  // 任何模式都先算一遍按需规划，供自动模式决策与安全联锁兜底
  const planning = planGroups(c, forecast, pistonQ, cfg)
  const planned = Math.max(...planning.plan)
  let rationale = ''

  // —— 火灾：全部射流风机投入，辅助排烟 ——
  if (ctx.fire) {
    target = cfg.fans.groupCount
    rationale = '火灾工况：全部风机投入排烟'
    events.push(['critical', '火灾联锁：全部射流风机开启'])
  } else if (mode === 'max') {
    target = cfg.fans.groupCount
    rationale = '人工最大通风模式'
  } else if (mode === 'off') {
    target = 0
    rationale = '停机模式（安全联锁仍生效）'
  } else if (mode === 'manual') {
    target = new Set(ctx.manualSet ?? []).size
    rationale = `人工模式：指定 ${target} 组`
  } else {
    // —— 自动：滚动预测 + 能耗最优档位 ——
    rationale = `预测时域 ${cfg.control.horizonSec}s 内最不利需求 ${planned} 组`

    const cp = cfg.control
    if (mNow >= cp.guardRatio) {
      // 实测越限：立即加机，解除一切停留约束
      target = Math.max(curN + 1, planned)
      events.push(['warn', `实测污染物越限（占限值 ${(mNow * 100).toFixed(0)}%），快速加机`])
    } else if (mNow >= cp.fastUpRatio) {
      target = Math.max(curN, planned)
      if (target > curN) events.push(['info', '浓度逼近限值，提前加机'])
    } else {
      // 常规滞环
      if (planned > curN && sinceChange >= cp.upDwellSec) {
        target = planned
      } else if (planned < curN && mNow < cp.fastDownRatio && sinceChange >= cp.downDwellSec) {
        // 减机更保守：一次只减一组，给浓度回升留出观察窗口
        target = curN - 1
        events.push(['info', '浓度回落且预测无压力，减机一组观察'])
      } else {
        target = curN
      }
    }

    // 开满仍超标 → 紧急报警
    if (mNow >= cp.guardRatio && curN >= cfg.fans.groupCount) {
      alarm = 'ALL_FANS_INSUFFICIENT'
      events.push(['critical', '全部风机运行仍超卫生限值，触发紧急报警'])
    } else if (Math.max(...planning.worst) >= cp.emergencyRatio) {
      alarm = 'FORECAST_OVERLOAD'
      events.push(['critical', '预测显示即使全部风机运行仍将严重超标，请启动应急预案'])
    }
  }

  // —— 安全联锁（manual / off 同样不可旁路）——
  // 带滞环闩锁：一旦越限，按预测档位兜底，不会一降到限值下就全关
  // （污染物有 30~60 分钟积累滞后，否则会"全关→重新攀升→长期超标"振荡）。
  let interlockLatched = ctx.interlockLatched ?? false
  if (!ctx.fire && (mode === 'manual' || mode === 'off')) {
    const cp = cfg.control
    if (mNow >= cp.guardRatio && !interlockLatched) {
      interlockLatched = true
      events.push(['critical', '安全联锁接管：实测越限，按预测需求补开风机'])
    }
    if (interlockLatched) {
      target = Math.max(target, planned)
      if (mNow >= cp.guardRatio) target = Math.max(target, curN + 1)
      // 只有"浓度回落"且"预测已不再需要风机"（车流确实消散）才解除：
      // 若拥堵仍在，过早解除会让浓度沿同样的轨迹重新积累。
      if (mNow < cp.fastDownRatio && planned === 0) {
        interlockLatched = false
        events.push(['info', '浓度已回落且车流消散，安全联锁解除，交还人工控制'])
      }
    }
    if (mNow >= cp.guardRatio && curN >= cfg.fans.groupCount) {
      alarm = 'ALL_FANS_INSUFFICIENT'
    }
  }

  target = Math.max(0, Math.min(cfg.fans.groupCount, target))
  const nextGroups = selectGroups(onGroups, target, runtimeSec)

  return {
    target,
    nextGroups,
    currentRatio: mNow,
    ratios: rNow,
    limits: lim,
    alarm,
    planned,
    interlockLatched,
    rationale,
    events,
  }
}
