/** 可播种随机数（测试确定性）+ 高斯噪声 + OU 过程。 */

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 由均匀随机数生成标准正态（Box–Muller） */
export function gaussian(rand) {
  let u = 0
  let v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Ornstein–Uhlenbeck 均值回归一步更新。
 * x += theta*(mean-x)*dt + sigma*sqrt(dt)*Z
 */
export function ouStep(x, mean, theta, sigma, dt, rand) {
  const next = x + theta * (mean - x) * dt + sigma * Math.sqrt(dt) * gaussian(rand)
  return next
}
