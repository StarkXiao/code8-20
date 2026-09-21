import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  speedFactor, pistonAirflow, emissionRates, wellMixedStep, coMgToPpm, visibilityMeters,
} from '../src/physics.js';
import { CONFIG } from '../src/config.js';

test('低速时排放恶化系数随车速降低而升高，且有上限', () => {
  assert.ok(speedFactor(30, CONFIG.emissions.coSpeedExponent, 4.5) > 1);
  assert.ok(speedFactor(15, CONFIG.emissions.coSpeedExponent, 4.5) > speedFactor(30, CONFIG.emissions.coSpeedExponent, 4.5));
  assert.equal(speedFactor(1, CONFIG.emissions.coSpeedExponent, 4.5), 4.5);
  assert.equal(speedFactor(60, CONFIG.emissions.coSpeedExponent, 4.5), 1);
});

test('活塞风随交通量线性增加、随车速开方增加；零车流时为零', () => {
  assert.equal(pistonAirflow(0, 60), 0);
  const base = pistonAirflow(1000, 60);
  assert.ok(Math.abs(pistonAirflow(2000, 60) - base * 2) < 1e-9);
  const slow = pistonAirflow(1000, 15);
  assert.ok(slow < base);
  assert.ok(Math.abs(slow - base * 0.5) < 1e-9); // sqrt(15/60)=0.5
});

test('排放率随车流与柴油车比例合理变化，火灾叠加源项', () => {
  const normal = emissionRates(1000, 60, 0.3, false);
  const jam = emissionRates(1000, 15, 0.3, false);
  assert.ok(jam.coMgS > normal.coMgS);
  assert.ok(jam.smokeM2S > normal.smokeM2S);
  const diesel = emissionRates(1000, 60, 0.8, false);
  assert.ok(diesel.smokeM2S > normal.smokeM2S);
  assert.ok(diesel.coMgS < normal.coMgS); // 柴油车 CO 因子更低
  const fire = emissionRates(1000, 60, 0.3, true);
  assert.ok(fire.coMgS > normal.coMgS + CONFIG.fire.coMgS - 1);
  assert.ok(fire.smokeM2S > normal.smokeM2S + CONFIG.fire.smokeM2S - 1e-9);
  assert.deepEqual(emissionRates(0, 60, 0.3, false), { coMgS: 0, smokeM2S: 0 });
});

test('均匀混合模型：无源时浓度指数衰减；零风量时线性积累', () => {
  const V = CONFIG.tunnel.volumeM3;
  assert.ok(wellMixedStep(10, 0, 100, V, 5) < 10);
  assert.equal(wellMixedStep(10, 0, 0, V, 5), 10);
  const c0 = 5;
  const c1 = wellMixedStep(c0, 100, 0, V, 5);
  assert.ok(Math.abs(c1 - (c0 + (5 * 100) / V)) < 1e-12);
  // 结果不得为负
  assert.ok(wellMixedStep(0, 0, 1000, V, 5) >= 0);
});

test('稳态浓度 = 源项/风量（CSTR 稳态解）', () => {
  const V = CONFIG.tunnel.volumeM3;
  let c = 0;
  for (let i = 0; i < 20000; i++) c = wellMixedStep(c, 500, 100, V, 1);
  assert.ok(Math.abs(c - 5) < 0.02);
});

test('单位换算：CO ppm↔mg/m³ 与能见度换算', () => {
  assert.ok(Math.abs(coMgToPpm(116.5) - 100) < 1e-9);
  assert.ok(Math.abs(visibilityMeters(0.0065) - 2.63 / 0.0065) < 1e-9);
});
