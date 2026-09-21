/**
 * HTTP 端到端冒烟测试：启动真实 server，演练全部控制链路。
 *   node scripts/e2e-check.mjs
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8123
const base = `http://127.0.0.1:${PORT}`
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
})

const post = (p, b) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  }).then((r) => r.json())
const get = () => fetch(base + '/api/state').then((r) => r.json())

let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`)
  if (!cond) failures++
}

try {
  await sleep(600)

  // 静态资源
  for (const path of ['/', '/app.js', '/style.css']) {
    const r = await fetch(base + path)
    check(`静态资源 ${path}`, r.status === 200)
  }

  // 参数校验
  const bad = await post('/api/control', { action: 'hack' })
  const badJson = await fetch(base + '/api/sim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'xxx',
  }).then((r) => r.status)
  check('非法指令 400', bad.error !== undefined)
  check('非法 JSON 400', badJson === 400)

  // 拥堵高速推进
  await post('/api/sim', { speed: 1800, regime: 'jam' })
  await sleep(2500)
  let s = await get()
  check('拥堵开满 8 组', s.onGroups.length === 8, `实际 ${s.onGroups.length}`)
  check('拥堵不越限', s.decision.ratio < 1, `ratio=${s.decision.ratio.toFixed(2)}`)

  // 货车 ×2 压力 → 报警
  await post('/api/sim', { reset: true, speed: 1800, regime: 'jam' })
  await post('/api/control', { action: 'truck-factor', factor: 2 })
  await sleep(3200)
  s = await get()
  check('压力工况开满', s.onGroups.length === 8)
  check('压力工况触发紧急报警', s.alarm === 'ALL_FANS_INSUFFICIENT', s.alarm ?? 'null')

  // 火灾
  await post('/api/sim', { reset: true, speed: 60 })
  s = await post('/api/control', { action: 'fire', durationSec: 1200 })
  check('火灾状态置位', s.fire === true)
  await sleep(700) // 等待一个控制周期
  s = await get()
  check('火灾全部风机投入', s.onGroups.length === 8, `实际 ${s.onGroups.length}`)

  // SSE：能收到至少一帧
  const firstFrame = await new Promise((resolve) => {
    const req = fetch(base + '/api/events').then((r) => {
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      reader.read().then(function pump({ done, value }) {
        if (done) return resolve(null)
        const text = dec.decode(value)
        const line = text.split('\n').find((l) => l.startsWith('data: '))
        if (line) return resolve(JSON.parse(line.slice(6)))
        return reader.read().then(pump)
      })
    })
    setTimeout(() => resolve(null), 1500)
  })
  check('SSE 推送状态', firstFrame && typeof firstFrame.simSec === 'number')

  // 停机模式 + 拥堵 → 安全联锁
  await post('/api/control', { action: 'fire-clear' })
  await post('/api/sim', { reset: true, speed: 1800, regime: 'jam' })
  await post('/api/control', { action: 'mode', mode: 'off' })
  await sleep(3200)
  s = await get()
  check('停机模式联锁自动开机', s.onGroups.length > 0, `组数 ${s.onGroups.length}`)
  check('联锁兜底后浓度受控', s.metrics.peakRatio < 1.15, `峰值占限比=${s.metrics.peakRatio}`)

  // 复位
  s = await post('/api/sim', { reset: true, speed: 0 })
  check('复位清零', s.metrics.energyKwh === 0 && s.onGroups.length === 0)
} catch (e) {
  console.error('脚本异常:', e)
  failures++
} finally {
  server.kill()
  process.exit(failures ? 1 : 0)
}
