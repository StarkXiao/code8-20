/**
 * 零依赖 HTTP 服务：
 * - 静态托管 public/ 实时大屏
 * - REST：场景切换、运行控制、策略切换、故障注入、火灾演练、策略对比
 * - SSE：/api/stream 按仿真节拍推送快照（大屏无需轮询）
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Simulator, compareStrategies } from './simulator.js';
import { SCENARIOS } from './scenarios.js';
import { CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT ?? 8080);

class Session {
  constructor() {
    this.scenarioId = 'weekday';
    this.mode = 'auto';
    this.speed = 600; // 1 真实秒 = 600 仿真秒（24 h 约 144 s 跑完）
    this.running = false;
    this.sim = new Simulator(this.scenarioId, { mode: this.mode });
    this.clients = new Set();
    this.lastTick = Date.now();
  }

  ensureTimer() {
    if (this._timer) return;
    this.lastTick = Date.now();
    this._timer = setInterval(() => this.tick(), 100);
    this._timer.unref?.();
  }

  tick() {
    if (!this.running) return;
    const now = Date.now();
    const elapsedReal = (now - this.lastTick) / 1000;
    this.lastTick = now;
    let simSeconds = elapsedReal * this.speed;
    // 按物理 dt 取整推进
    const dt = this.sim.dt;
    let steps = Math.min(Math.round(simSeconds / dt), 600); // 防止后台恢复后一次冲太多
    while (steps-- > 0) {
      const rec = this.sim.step();
      if (!rec) {
        this.running = false;
        break;
      }
    }
    this.broadcast();
  }

  broadcast() {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(this.snapshot());
    for (const res of this.clients) res.write(`data: ${data}\n\n`);
  }

  snapshot() {
    return {
      ...this.sim.snapshot(6),
      running: this.running,
      speed: this.speed,
      config: {
        fanCount: CONFIG.fan.count,
        fanPowerKw: CONFIG.fan.powerKw,
        inducedAirflow: CONFIG.fan.inducedAirflow,
        coNormalPpm: CONFIG.limits.coNormalPpm,
        coJamPpm: CONFIG.limits.coJamPpm,
        kNormal: CONFIG.limits.kNormal,
        kJam: CONFIG.limits.kJam,
        targetCoRatio: CONFIG.limits.targetCoRatio,
      },
      scenarios: SCENARIOS.map((s) => ({ id: s.id, name: s.name, description: s.description })),
    };
  }

  reset(scenarioId = this.scenarioId, mode = this.mode) {
    this.scenarioId = scenarioId;
    this.mode = mode;
    this.sim = new Simulator(scenarioId, { mode });
    this.running = false;
    this.broadcast();
  }
}

const session = new Session();
session.ensureTimer();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const buf = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // ---- SSE ----
  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(session.snapshot())}\n\n`);
    session.clients.add(res);
    req.on('close', () => session.clients.delete(res));
    return;
  }

  // ---- REST ----
  if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, session.snapshot());

  if (p === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.speed === 'number' && body.speed > 0) session.speed = Math.min(6000, body.speed);
    if (session.sim.finished) session.reset();
    session.running = true;
    session.lastTick = Date.now();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/pause' && req.method === 'POST') {
    session.running = false;
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/step' && req.method === 'POST') {
    const body = await readBody(req);
    const n = Math.min(Number(body.steps ?? 60), 6000);
    for (let i = 0; i < n; i++) if (!session.sim.step()) break;
    session.broadcast();
    return sendJson(res, 200, session.snapshot());
  }

  if (p === '/api/reset' && req.method === 'POST') {
    const body = await readBody(req);
    session.reset(body.scenario ?? session.scenarioId, body.mode ?? session.mode);
    return sendJson(res, 200, session.snapshot());
  }

  if (p === '/api/mode' && req.method === 'POST') {
    const body = await readBody(req);
    if (!['auto', 'fixed', 'manual'].includes(body.mode)) return sendJson(res, 400, { error: 'bad mode' });
    session.mode = body.mode;
    session.sim.controller.setMode(body.mode);
    if (typeof body.fixedCount === 'number') session.sim.controller.fixedCount = body.fixedCount;
    session.broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/fan' && req.method === 'POST') {
    const body = await readBody(req);
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 0 || id >= CONFIG.fan.count) return sendJson(res, 400, { error: 'bad fan id' });
    if (body.fault !== undefined) session.sim.controller.setFault(id, Boolean(body.fault));
    if (session.mode === 'manual' && body.on !== undefined) session.sim.controller.setManual(id, Boolean(body.on));
    session.broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/compare' && req.method === 'GET') {
    const scenario = url.searchParams.get('scenario') ?? session.scenarioId;
    const fixedCount = Number(url.searchParams.get('fixed') ?? 12);
    return sendJson(res, 200, compareStrategies(scenario, fixedCount));
  }

  // ---- 静态文件 ----
  let filePath = p === '/' ? '/index.html' : p;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  try {
    const buf = await readFile(path.join(PUBLIC_DIR, filePath));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`隧道通风按需调控系统已启动: http://localhost:${PORT}`);
  console.log(`实时大屏: http://localhost:${PORT}/  |  SSE: /api/stream`);
});
