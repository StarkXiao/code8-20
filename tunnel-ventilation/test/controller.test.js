import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulator } from '../src/simulator.js';
import { FanController } from '../src/controller.js';
import { CONFIG } from '../src/config.js';
import { SCENARIOS, getScenario, scenarioTrafficAt } from '../src/scenarios.js';

test('全场景闭环：按需策略保持浓度在正常限值以内（火灾窗口期除外）', () => {
  for (const s of SCENARIOS) {
    const r = new Simulator(s.id, { mode: 'auto', noise: false });
    r.run();
    const m = r.summary();
    if (s.id !== 'fire') {
      assert.equal(m.violationSec, 0, `${s.name} 不应出现限值超标`);
      assert.equal(m.emergencySec, 0, `${s.name} 不应触发应急`);
    }
    assert.ok(m.maxCoPpm < CONFIG.limits.coJamPpm);
  }
});

test('节能性：低交通场景按需策略可完全停开风机；高负荷场景相对定时编组显著节能', () => {
  const night = new Simulator('night', { mode: 'auto', noise: false }).run().metrics;
  assert.equal(night.avgFans, 0);
  assert.equal(night.totalEnergyKwh, 0);

  for (const id of ['weekday', 'holiday', 'heavy']) {
    const fixed = new Simulator(id, { mode: 'fixed', fixedCount: 12, noise: false }).run().metrics;
    const auto = new Simulator(id, { mode: 'auto', noise: false }).run().metrics;
    const saving = (fixed.totalEnergyKwh - auto.totalEnergyKwh) / fixed.totalEnergyKwh;
    assert.ok(saving >= 0.75, `${id} 节能率应 ≥75%，实际 ${(saving * 100).toFixed(1)}%`);
    assert.equal(auto.violationSec, 0);
  }
});

test('安全优先：火灾时所有健康风机在一个决策周期内投入，火源解除后可回落', () => {
  const r = new Simulator('fire', { mode: 'auto', noise: false });
  let fireOnSeenFans = null;
  while (!r.finished) {
    const wasFire = r.lastEnv?.fire ?? false;
    r.step();
    if (r.lastEnv?.fire && !wasFire && fireOnSeenFans === null) {
      // 火源开始后再推进一个决策周期
      for (let i = 0; i < CONFIG.control.decisionIntervalSec / r.dt; i++) r.step();
      fireOnSeenFans = r.controller.activeCount;
    }
  }
  assert.equal(fireOnSeenFans, 16, '火灾发生后全部风机应立即投入');
  // 第二次火灾结束 2 小时后风机应已回落
  const late = r.series.find((p) => p.t > 20.5 * 3600);
  assert.equal(late.fans, 0, '排烟完成后风机应回落');
  assert.ok(r.summary().maxCoPpm > 100, '火灾 CO 峰值应显著升高（模型确实生效）');
});

test('控制器对高浓度立即响应：浓度超过控制目标后一个周期开始增机', () => {
  const c = new FanController('auto');
  const env = {
    coMgM3: 0, k: CONFIG.limits.kNormal, // 正好 1.43 倍目标（0.0065*0.7=0.00455）
    speedKmh: 40, coSourceMgS: 200, kSourceM2S: 0.3,
    freeAirflow: 20, actualAirflow: 20, fireActive: false,
  };
  c.decide(0, env);
  assert.ok(c.activeCount > 0, '超目标浓度应立即触发增机');
});

test('抗抖动：浓度在目标附近波动时风机不频繁启停', () => {
  const r = new Simulator('heavy', { mode: 'auto', noise: true });
  r.run();
  const m = r.summary();
  assert.ok(m.fanStarts <= 120, `重载场景启动次数应受控，实际 ${m.fanStarts}`);
});

test('电机保护：未满足最小运行时间的风机不会被正常减机', () => {
  const c = new FanController('auto');
  // 应急拉起全部
  c.decide(0, {
    coMgM3: 0, k: 0.02, speedKmh: 40, coSourceMgS: 0, kSourceM2S: 0.3,
    freeAirflow: 20, actualAirflow: 20, fireActive: false,
  });
  assert.equal(c.activeCount, 16);
  // 立即解除应急并转入低需求，正常减机受最小运行时间保护
  c.decide(CONFIG.control.decisionIntervalSec, {
    coMgM3: 0, k: 0, speedKmh: 40, coSourceMgS: 0.01, kSourceM2S: 0.001,
    freeAirflow: 100, actualAirflow: 100, fireActive: false,
  });
  for (let i = 0; i < 6; i++) {
    c.tick(CONFIG.control.decisionIntervalSec);
    c.decide((i + 2) * CONFIG.control.decisionIntervalSec, {
      coMgM3: 0, k: 0, speedKmh: 40, coSourceMgS: 0.01, kSourceM2S: 0.001,
      freeAirflow: 100, actualAirflow: 100, fireActive: false,
    });
  }
  assert.ok(c.activeCount > 0, '最小运行期内不应全部停完');
});

test('故障风机被剔除：应急时健康风机全部投入、故障机不参与', () => {
  const c = new FanController('auto');
  c.setFault(2, true);
  c.setFault(9, true);
  c.decide(0, {
    coMgM3: 0, k: 0.02, speedKmh: 40, coSourceMgS: 0, kSourceM2S: 0.3,
    freeAirflow: 20, actualAirflow: 20, fireActive: true,
  });
  assert.equal(c.activeCount, 14);
  assert.ok(!c.fans[2].on && !c.fans[9].on);
});

test('manual 模式：策略不越权改变人工指定的单机状态；应急仍可越权', () => {
  const c = new FanController('manual');
  c.setManual(0, true);
  c.setManual(15, true);
  c.decide(0, {
    coMgM3: 0, k: 0, speedKmh: 60, coSourceMgS: 500, kSourceM2S: 0.5,
    freeAirflow: 20, actualAirflow: 20, fireActive: false,
  });
  assert.deepEqual(c.fans.map((f) => f.on), c.fans.map((f) => f.id === 0 || f.id === 15));
  // 应急越权
  c.decide(5, {
    coMgM3: 0, k: 0.02, speedKmh: 60, coSourceMgS: 500, kSourceM2S: 0.5,
    freeAirflow: 20, actualAirflow: 20, fireActive: true,
  });
  assert.equal(c.activeCount, 16);
});

test('fixed 模式保持常开编组台数', () => {
  const c = new FanController('fixed', { fixedCount: 12 });
  c.decide(0, {
    coMgM3: 0, k: 0, speedKmh: 60, coSourceMgS: 10, kSourceM2S: 0,
    freeAirflow: 50, actualAirflow: 50, fireActive: false,
  });
  assert.equal(c.activeCount, 12);
});

test('磨损均衡：稳态场景各风机累计运行时长极差很小', () => {
  const r = new Simulator('holiday', { mode: 'auto', noise: false });
  r.run();
  const runs = r.controller.fans.map((f) => f.runSec);
  assert.ok(Math.max(...runs) - Math.min(...runs) <= 20 * 60, '稳态日极差应 ≤ 20 分钟');
});

test('指标单调自洽：累计电耗、运行时长非负且随时间增长', () => {
  const r = new Simulator('holiday', { mode: 'fixed', fixedCount: 8, noise: false });
  let prev = 0;
  for (let i = 0; i < 1000; i++) {
    r.step();
    assert.ok(r.summary().totalEnergyKwh >= prev - 1e-9);
    prev = r.summary().totalEnergyKwh;
  }
});

test('确定性：相同种子重复仿真结果完全一致', () => {
  const a = new Simulator('weekday', { mode: 'auto', noise: true, seed: 42 }).run().metrics;
  const b = new Simulator('weekday', { mode: 'auto', noise: true, seed: 42 }).run().metrics;
  assert.deepEqual(a, b);
});

test('场景时间线插值正确且无 NaN（含缺省柴油车比例的场景）', () => {
  const t = getScenario('holiday');
  const mid = (t.points[0].t + t.points[1].t) / 2 * 3600;
  const s = scenarioTrafficAt(t, mid);
  assert.ok(Number.isFinite(s.q) && Number.isFinite(s.v) && Number.isFinite(s.d));
  assert.ok(s.d > 0 && s.d < 1);
});
