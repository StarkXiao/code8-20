/* 监控大屏前端逻辑：SSE 实时订阅 + Canvas 双图 + 控制指令下发（无任何外部依赖） */

const $ = (id) => document.getElementById(id)

let state = null
let speed = 60
let manualSelection = new Set()

// —— 网络 ——

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error((await r.json()).error || '请求失败')
  return r.json()
}

function connectSSE() {
  const es = new EventSource('/api/events')
  es.onmessage = (ev) => {
    const data = JSON.parse(ev.data)
    state = data
    render()
  }
  es.onerror = () => {
    // 浏览器会自动重连
  }
}

// —— 风机组面板 ——

function buildFanGrid() {
  const n = 8
  $('fanGrid').innerHTML = ''
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div')
    d.className = 'fan'
    d.id = 'fan-' + i
    d.innerHTML = `<span class="impeller">🌀</span><span class="gid">第 ${i + 1} 组</span><span class="hrs" id="fan-hrs-${i}"></span>`
    $('fanGrid').appendChild(d)
  }
}

function buildManualChips() {
  $('manualChips').innerHTML = ''
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('div')
    c.className = 'chip' + (manualSelection.has(i) ? ' on' : '')
    c.textContent = i + 1
    c.onclick = () => {
      manualSelection.has(i) ? manualSelection.delete(i) : manualSelection.add(i)
      buildManualChips()
    }
    $('manualChips').appendChild(c)
  }
}

// —— 渲染 ——

function ratioColor(r) {
  if (r >= 1) return 'var(--red)'
  if (r >= 0.88) return 'var(--amber)'
  return 'var(--green)'
}

function setKpiAlarm(el, card) {
  el.style.color = ''
  card.classList.remove('warn', 'danger')
}

function render() {
  if (!state) return
  const d = state.decision
  const m = state.metrics

  $('clock').textContent = state.clock
  $('modeBadge').textContent = state.modeLabel + (state.fire ? ' · 火灾排烟' : '')
  $('alarmBadge').classList.toggle('hidden', !state.alarm)
  $('interlockBadge').classList.toggle('hidden', !state.interlockLatched)
  $('modeBadge').style.borderColor = state.fire ? 'var(--red)' : ''
  $('modeBadge').style.color = state.fire ? 'var(--red)' : ''

  // KPI
  $('kpiFlow').textContent = Math.round(state.traffic.flow)
  $('kpiSpeed').textContent = state.traffic.speed.toFixed(0)
  $('kpiTruck').textContent = (state.traffic.truckFraction * 100).toFixed(0)
  $('kpiCO').textContent = state.concentration.co.toFixed(1)
  $('kpiNO2').textContent = state.concentration.no2.toFixed(2)
  $('kpiSmoke').textContent = state.concentration.smoke.toFixed(2)
  if (d) {
    $('limCO').textContent = d.limits.co
    $('limNO2').textContent = d.limits.no2
    $('limSmoke').textContent = d.limits.smoke
    const pct = d.ratio * 100
    const gauge = $('kpiRatio')
    gauge.textContent = pct.toFixed(0)
    gauge.parentElement.style.color = ratioColor(d.ratio)
    const bar = $('ratioBar')
    bar.style.width = Math.min(100, pct) + '%'
    bar.style.background = ratioColor(d.ratio)
    $('decisionText').textContent = d.rationale
  }
  $('kpiSave').textContent = m.savings
  $('kpiEnergy').textContent = m.energyKwh
  $('kpiBase').textContent = m.baselineEnergyKwh

  // 风机
  $('fanSummary').textContent = `${state.onGroups.length} / ${state.groupCount} 组运行 · ${state.onGroups.length * state.fansPerGroup} 台`
  for (let i = 0; i < state.groupCount; i++) {
    const el = $('fan-' + i)
    if (el) el.classList.toggle('on', state.onGroups.includes(i))
    const hrs = $('fan-hrs-' + i)
    if (hrs) hrs.textContent = (state.runtimeHours[i] ?? 0).toFixed(1) + 'h'
  }
  $('qPiston').textContent = state.pistonQ.toFixed(0)
  $('qFan').textContent = state.fanQ.toFixed(0)
  $('qTotal').textContent = state.totalQ.toFixed(0)

  // 日志（增量渲染：直接全量替换，数量 ≤ 80）
  $('eventLog').innerHTML = state.events
    .map(
      (e) =>
        `<li class="${e.level}"><span class="t">${fmtClock(e.clockSec)}</span><span class="lv">${
          { info: '信息', warn: '预警', critical: '紧急' }[e.level]
        }</span><span class="msg">${escapeHtml(e.message)}</span></li>`
    )
    .join('')

  drawPollChart()
  drawFlowChart()
}

function fmtClock(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// —— Canvas 通用 ——

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = 220
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  return { ctx, w, h }
}

function drawGrid(ctx, w, h, pad, yTicks, yFmt = (v) => v) {
  ctx.strokeStyle = '#1c2738'
  ctx.lineWidth = 1
  ctx.fillStyle = '#5b6a82'
  ctx.font = '10px ui-monospace, monospace'
  for (let i = 0; i <= yTicks; i++) {
    const y = pad.t + ((h - pad.t - pad.b) * i) / yTicks
    ctx.beginPath()
    ctx.moveTo(pad.l, y)
    ctx.lineTo(w - pad.r, y)
    ctx.stroke()
    const val = 1 - i / yTicks
    ctx.fillText(yFmt(val), 4, y + 3)
  }
}

function drawLine(ctx, pts, pad, w, h, xMax, yMax, color, dashed = false, width = 1.6) {
  if (pts.length < 2) return
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.setLineDash(dashed ? [4, 4] : [])
  ctx.beginPath()
  pts.forEach((p, i) => {
    const x = pad.l + (w - pad.l - pad.r) * (p[0] / xMax)
    const y = pad.t + (h - pad.t - pad.b) * (1 - Math.min(1, p[1] / yMax))
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
  })
  ctx.stroke()
  ctx.setLineDash([])
}

// —— 污染物图（占限值 %） ——

function drawPollChart() {
  const canvas = $('pollChart')
  const { ctx, w, h } = setupCanvas(canvas)
  const pad = { l: 42, r: 10, t: 8, b: 20 }
  ctx.clearRect(0, 0, w, h)
  drawGrid(ctx, w, h, pad, 4, (v) => Math.round(v * 120))

  const hist = state.history
  if (hist.length < 2) return
  const lim = state.decision?.limits
  if (!lim) return
  const t0 = hist[0].simSec
  const tMax = Math.max(600, hist[hist.length - 1].simSec - t0)
  const x = (p) => (p.simSec - t0) / tMax

  drawLine(
    ctx,
    hist.map((p) => [x(p) * tMax, (p.co / lim.co) * 100]),
    pad, w, h, tMax, 120, '#ffb020'
  )
  drawLine(
    ctx,
    hist.map((p) => [x(p) * tMax, (p.no2 / lim.no2) * 100]),
    pad, w, h, tMax, 120, '#b478ff'
  )
  drawLine(
    ctx,
    hist.map((p) => [x(p) * tMax, (p.smoke / lim.smoke) * 100]),
    pad, w, h, tMax, 120, '#9aa7bd'
  )
  drawLine(
    ctx,
    hist.map((p) => [x(p) * tMax, p.baselineRatio * 100]),
    pad, w, h, tMax, 120, 'rgba(255,82,96,0.55)', true, 1.2
  )
  // 限值线、目标线
  drawLine(ctx, [[0, 100], [tMax, 100]], pad, w, h, tMax, 120, '#ff5260', true, 1)
  drawLine(ctx, [[0, 88], [tMax, 88]], pad, w, h, tMax, 120, '#ffb020', true, 1)

  // x 轴时刻
  ctx.fillStyle = '#5b6a82'
  ctx.font = '10px ui-monospace, monospace'
  for (let i = 0; i <= 4; i++) {
    const p = hist[Math.floor((hist.length - 1) * (i / 4))]
    const xx = pad.l + (w - pad.l - pad.r) * (i / 4)
    ctx.fillText(fmtClock(p.clock), xx - 14, h - 6)
  }
}

// —— 车流/风量/档位图 ——

function drawFlowChart() {
  const canvas = $('flowChart')
  const { ctx, w, h } = setupCanvas(canvas)
  const pad = { l: 42, r: 10, t: 8, b: 20 }
  ctx.clearRect(0, 0, w, h)
  drawGrid(ctx, w, h, pad, 4, (v) => Math.round(v * 3600))

  const hist = state.history
  if (hist.length < 2) return
  const t0 = hist[0].simSec
  const tMax = Math.max(600, hist[hist.length - 1].simSec - t0)
  const x = (p) => (p.simSec - t0) / tMax

  drawLine(
    ctx,
    hist.map((p) => [x(p) * tMax, p.flow]),
    pad, w, h, tMax, 3600, '#4f8cff'
  )
  // 风量按 3600 量程缩放显示（实际 0~260），单独右侧轴感：用透明度区分
  drawLine(
    ctx,
    hist.map((p) => [x(p) * tMax, p.totalQ * 10]),
    pad, w, h, tMax, 3600, '#35d0e0'
  )
  // 组数：阶梯填充
  ctx.fillStyle = 'rgba(255,176,32,0.13)'
  let stepStart = 0
  for (let i = 1; i <= hist.length; i++) {
    if (i < hist.length && hist[i].groups === hist[stepStart].groups) continue
    const x1 = pad.l + (w - pad.l - pad.r) * x(hist[stepStart])
    const x2 =
      pad.l + (w - pad.l - pad.r) * (i === hist.length ? 1 : x(hist[i]))
    const yy = pad.t + (h - pad.t - pad.b) * (1 - hist[stepStart].groups / 8)
    ctx.fillRect(x1, yy, Math.max(1, x2 - x1), h - pad.b - yy)
    stepStart = i
  }
  drawLine(
    ctx,
    hist.map((p) => [x(p) * tMax, (p.groups / 8) * 3600]),
    pad, w, h, tMax, 3600, '#ffb020', false, 1.4
  )
  // 车速：虚线绿
  drawLine(
    ctx,
    hist.map((p) => [x(p) * tMax, p.speed * 36]),
    pad, w, h, tMax, 3600, '#3ddc84', true, 1.3
  )

  ctx.fillStyle = '#5b6a82'
  ctx.font = '10px ui-monospace, monospace'
  for (let i = 0; i <= 4; i++) {
    const p = hist[Math.floor((hist.length - 1) * (i / 4))]
    const xx = pad.l + (w - pad.l - pad.r) * (i / 4)
    ctx.fillText(fmtClock(p.clock), xx - 14, h - 6)
  }
  // 右端数值标注
  const last = hist[hist.length - 1]
  ctx.fillStyle = '#4f8cff'; ctx.fillText(`${Math.round(last.flow)}辆/h`, w - 86, pad.t + 10)
  ctx.fillStyle = '#35d0e0'; ctx.fillText(`${Math.round(last.totalQ)}m³/s`, w - 86, pad.t + 24)
  ctx.fillStyle = '#3ddc84'; ctx.fillText(`${last.speed.toFixed(0)}km/h`, w - 86, pad.t + 38)
  ctx.fillStyle = '#ffb020'; ctx.fillText(`${last.groups}组`, w - 86, pad.t + 52)
}

// —— 控件事件 ——

function bindControls() {
  document.querySelectorAll('#speedBtns button').forEach((b) =>
    b.addEventListener('click', async () => {
      speed = Number(b.dataset.speed)
      await post('/api/sim', { speed })
      document.querySelectorAll('#speedBtns button').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
    })
  )

  document.querySelectorAll('#regimeBtns button').forEach((b) =>
    b.addEventListener('click', async () => {
      await post('/api/sim', { regime: b.dataset.regime })
      document.querySelectorAll('#regimeBtns button').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
    })
  )

  document.querySelectorAll('#modeBtns button').forEach((b) =>
    b.addEventListener('click', async () => {
      const mode = b.dataset.mode
      await post('/api/control', { action: 'mode', mode })
      document.querySelectorAll('#modeBtns button').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
      $('manualBar').classList.toggle('hidden', mode !== 'manual')
      if (mode === 'manual' && state) {
        manualSelection = new Set(state.onGroups)
        buildManualChips()
      }
    })
  )

  $('manualApply').addEventListener('click', async () => {
    await post('/api/control', { action: 'mode', mode: 'manual', groups: [...manualSelection] })
  })

  $('fireBtn').addEventListener('click', async () => {
    await post('/api/control', { action: 'fire', durationSec: 1200 })
  })

  let truckOn = false
  $('truckBtn').addEventListener('click', async () => {
    truckOn = !truckOn
    await post('/api/control', { action: 'truck-factor', factor: truckOn ? 2 : 1 })
    $('truckBtn').classList.toggle('warn-active', truckOn)
    $('truckBtn').textContent = truckOn ? '货车 ×1 恢复' : '货车 ×2 压力'
  })

  $('resetBtn').addEventListener('click', async () => {
    await post('/api/sim', { reset: true, speed })
    truckOn = false
    $('truckBtn').classList.remove('warn-active')
    $('truckBtn').textContent = '货车 ×2 压力'
  })
}

buildFanGrid()
buildManualChips()
bindControls()
connectSSE()
