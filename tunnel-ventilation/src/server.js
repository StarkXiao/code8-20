/**
 * 零依赖 HTTP 服务：
 *   GET  /                 监控大屏（web/index.html）
 *   GET  /api/state        全量状态快照
 *   POST /api/control      控制指令 {action, ...}
 *   POST /api/sim          仿真控制 {speed}|{reset}|{regime}
 *   GET  /api/events       SSE：实时状态推送（250ms）
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Simulator } from './simulator.js'
import { DEFAULT_CONFIG } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(__dirname, '..', 'web')

const sim = new Simulator(DEFAULT_CONFIG, 20260921)

// 仿真主循环：按 speed 把仿真秒映射到真实毫秒
const SPEEDS = { 0: 0, 30: 30, 60: 60, 300: 300, 600: 600, 1800: 1800 }
let speed = 60 // 默认 60 倍速：真实 1 秒 = 仿真 1 分钟
let lastWall = Date.now()

setInterval(() => {
  const now = Date.now()
  const wallDt = (now - lastWall) / 1000
  lastWall = now
  if (speed > 0) {
    const simDt = wallDt * speed
    // 拆成不超过 physicsDtSec 的子步，保证物理精度
    const dt = DEFAULT_CONFIG.sim.physicsDtSec
    let remain = simDt
    while (remain > 0) {
      const step = Math.min(dt, remain)
      sim.tick(step === dt ? dt : step)
      remain -= step
    }
  }
}, 200)

// —— SSE 订阅 ——
const sseClients = new Set()
setInterval(() => {
  const payload = `data: ${JSON.stringify(sim.snapshot())}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}, 250)

// —— 工具 ——

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) reject(new Error('payload too large'))
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (urlPath === '/') urlPath = '/index.html'
  const filePath = path.normalize(path.join(WEB_DIR, urlPath))
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403)
    return res.end('Forbidden')
  }
  try {
    const data = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
}

// —— 指令处理 ——

async function handleControl(body) {
  switch (body.action) {
    case 'mode':
      sim.setMode(body.mode, body.groups)
      break
    case 'fire':
      sim.triggerFire(body.durationSec ?? 1200)
      break
    case 'fire-clear':
      sim.clearFire()
      break
    case 'truck-factor':
      sim.setTruckFactor(body.factor)
      break
    default:
      throw Object.assign(new Error('未知控制指令'), { status: 400 })
  }
}

async function handleSim(body) {
  if (body.speed !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(SPEEDS, String(body.speed))) {
      throw Object.assign(new Error('不支持的倍速'), { status: 400 })
    }
    speed = Number(body.speed)
  }
  if (body.reset) sim.reset(20260921)
  if (body.regime) {
    if (body.regime !== 'daily' && !['night', 'free', 'peak', 'jam', 'incident'].includes(body.regime)) {
      throw Object.assign(new Error('未知工况'), { status: 400 })
    }
    sim.setRegime(body.regime)
  }
  return { speed }
}

// —— HTTP 服务 ——

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, { speed, ...sim.snapshot() })
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      const body = await readJson(req)
      await handleControl(body)
      return sendJson(res, 200, { ok: true, ...sim.snapshot() })
    }
    if (req.method === 'POST' && url.pathname === '/api/sim') {
      const body = await readJson(req)
      const out = await handleSim(body)
      return sendJson(res, 200, { ok: true, ...out, ...sim.snapshot() })
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify(sim.snapshot())}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    if (req.method === 'GET') return serveStatic(req, res)
    sendJson(res, 405, { error: 'method not allowed' })
  } catch (e) {
    sendJson(res, e.status ?? 500, { error: e.message })
  }
})

const PORT = DEFAULT_CONFIG.server.port
server.listen(PORT, () => {
  console.log(`隧道通风按需调控系统已启动: http://localhost:${PORT}`)
})

// SSE 客户端写失败时摘除，避免异常中断仿真循环
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message)
})
