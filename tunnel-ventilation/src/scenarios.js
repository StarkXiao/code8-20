/**
 * 标准交通场景（24 h 时间线，分段线性插值）。
 * 每条断点：{ t（小时）, q（veh/h 双向合计）, v（km/h）, d（柴油车比例，可选） }
 * 可挂火灾演练窗口 fire: [{start, end}]（小时）。
 */

const H = 3600;

export const SCENARIOS = [
  {
    id: 'weekday',
    name: '典型工作日',
    description: '早晚高峰 + 早高峰事故性拥堵，检验按需风机的跟随与回落',
    points: [
      { t: 0, q: 220, v: 80 },
      { t: 5, q: 200, v: 80 },
      { t: 6, q: 800, v: 60 },
      { t: 7, q: 1800, v: 45 },
      { t: 7.6, q: 2000, v: 18 }, // 拥堵形成
      { t: 8.4, q: 1900, v: 18 },
      { t: 9.2, q: 1400, v: 50 }, // 拥堵消散
      { t: 11, q: 1200, v: 55 },
      { t: 16, q: 1300, v: 50 },
      { t: 17, q: 1600, v: 25 },
      { t: 17.8, q: 1500, v: 15 }, // 晚高峰低速
      { t: 18.6, q: 1400, v: 15 },
      { t: 19.4, q: 1100, v: 45 },
      { t: 21, q: 600, v: 70 },
      { t: 24, q: 220, v: 80 },
    ],
  },
  {
    id: 'night',
    name: '夜间低交通',
    description: '全天车流稀疏，风机应基本停转，仅维持卫生通风',
    points: [
      { t: 0, q: 160, v: 80 },
      { t: 3, q: 120, v: 80 },
      { t: 6, q: 260, v: 75 },
      { t: 10, q: 300, v: 75 },
      { t: 14, q: 280, v: 75 },
      { t: 18, q: 320, v: 72 },
      { t: 22, q: 200, v: 80 },
      { t: 24, q: 160, v: 80 },
    ],
  },
  {
    id: 'holiday',
    name: '节假日大流量',
    description: '持续高位车流、车速中等，风机长时间中等编组运行',
    points: [
      { t: 0, q: 200, v: 75 },
      { t: 7, q: 900, v: 60 },
      { t: 9, q: 2000, v: 50 },
      { t: 10, q: 2400, v: 45 },
      { t: 16, q: 2300, v: 45 },
      { t: 19, q: 1800, v: 50 },
      { t: 22, q: 700, v: 65 },
      { t: 24, q: 200, v: 75 },
    ],
  },
  {
    id: 'heavy',
    name: '重载货车上坡段',
    description: '柴油车占比 60%，烟雾排放主导，多段低速爬行',
    dieselRatio: 0.6,
    points: [
      { t: 0, q: 120, v: 60 },
      { t: 5.5, q: 400, v: 40 },
      { t: 8, q: 800, v: 30 },
      { t: 9, q: 900, v: 12 },
      { t: 10.5, q: 700, v: 25 },
      { t: 12, q: 900, v: 30 },
      { t: 15, q: 850, v: 12 },
      { t: 17, q: 600, v: 20 },
      { t: 20, q: 300, v: 45 },
      { t: 24, q: 120, v: 60 },
    ],
  },
  {
    id: 'fire',
    name: '火灾应急演练',
    description: '白天地段两次火源，全部健康风机须无条件立即投入',
    points: [
      { t: 0, q: 150, v: 70 },
      { t: 6, q: 800, v: 55 },
      { t: 12, q: 750, v: 55 },
      { t: 18, q: 900, v: 50 },
      { t: 21, q: 400, v: 65 },
      { t: 24, q: 150, v: 70 },
    ],
    fire: [
      { start: 8.5 * H, end: 8.8 * H },
      { start: 18.0 * H, end: 18.3 * H },
    ],
  },
];

export const SCENARIO_DURATION = 24 * H;

export function getScenario(id) {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** 分段线性插值时间线断点；字段缺失时返回 fallback。 */
export function interpTimeline(points, field, tSec, fallback = 0) {
  if (tSec <= points[0].t * H) return points[0][field] ?? fallback;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ta = a.t * H;
    const tb = b.t * H;
    if (tSec >= ta && tSec <= tb) {
      const va = a[field] ?? fallback;
      const vb = b[field] ?? fallback;
      return va + (vb - va) * ((tSec - ta) / (tb - ta));
    }
  }
  return points[points.length - 1][field] ?? fallback;
}

export function scenarioTrafficAt(scenario, tSec) {
  return {
    q: interpTimeline(scenario.points, 'q', tSec),
    v: interpTimeline(scenario.points, 'v', tSec),
    d: scenario.dieselRatio ?? interpTimeline(scenario.points, 'd', tSec, 0.3),
  };
}

export function scenarioFireAt(scenario, tSec) {
  return Boolean((scenario.fire ?? []).some((w) => tSec >= w.start && tSec < w.end));
}
