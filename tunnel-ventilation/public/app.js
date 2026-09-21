/* 实时大屏前端：SSE 订阅 + Canvas 渲染（零依赖）。 */

const $ = (id) => document.getElementById(id);
let state = null;

// ---------- 工具 ----------
const fmtTime = (t) => {
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor((t % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const fmt = (x, d = 0) => (x === Infinity || !isFinite(x) ? '∞' : x.toFixed(d));

function api(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

// ---------- SSE ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    state = JSON.parse(e.data);
    render();
  };
  es.onerror = () => setTimeout(connect, 1500);
}

// ---------- KPI ----------
function renderKpis() {
  $('kpiTime').textContent = fmtTime(state.t) + (state.finished ? '（已完成）' : '');
  $('kpiQ').textContent = Math.round(state.traffic.q);
  $('kpiV').textContent = state.traffic.v.toFixed(0);
  $('kpiCO').textContent = fmt(state.concentrations.coPpm, 1);
  $('kpiVis').textContent = fmt(state.concentrations.visibilityM, 0);
  $('kpiAir').textContent = state.airflow.total.toFixed(0);
  $('kpiFans').textContent = state.activeFans;
  $('kpiEnergy').textContent = state.metrics.totalEnergyKwh.toFixed(0);
  $('kpiViol').textContent = state.metrics.violationPct.toFixed(2);

  const coLimit = state.traffic.v < 20 ? state.config.coJamPpm : state.config.coNormalPpm;
  const coRatio = Math.min(1.2, state.concentrations.coPpm / coLimit);
  $('kpiCOBar').innerHTML = `<i style="width:${Math.min(100, coRatio * 100)}%;background:${barColor(coRatio)}"></i>`;
  const kLimit = state.traffic.v < 20 ? state.config.kJam : state.config.kNormal;
  const kRatio = Math.min(1.2, state.concentrations.k / kLimit);
  $('kpiKBar').innerHTML = `<i style="width:${Math.min(100, kRatio * 100)}%;background:${barColor(kRatio)}"></i>`;
  $('kpiCO').style.color = coRatio > 1 ? 'var(--danger)' : coRatio > 0.7 ? 'var(--warn)' : '';
  $('kpiVis').style.color = kRatio > 1 ? 'var(--danger)' : kRatio > 0.7 ? 'var(--warn)' : '';

  const mb = $('modeBadge');
  mb.textContent = state.mode === 'auto' ? '按需调控' : state.mode === 'fixed' ? '定时编组' : '人工控制';
  mb.className = `badge mode-${state.mode}`;
  $('emergencyBadge').classList.toggle('hidden', !state.emergency);
}

function barColor(r) {
  return r > 1 ? 'var(--danger)' : r > 0.7 ? 'var(--warn)' : 'var(--ok)';
}

// ---------- 隧道纵剖面 ----------
function drawTunnel() {
  const cv = $('tunnelCanvas');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);

  const padL = 70, padR = 30, top = 55, bottom = 150;
  const x0 = padL, x1 = W - padR;
  const tunnelW = x1 - x0;

  // 洞体
  ctx.fillStyle = '#11161f';
  ctx.strokeStyle = '#3a4453';
  ctx.lineWidth = 2;
  roundRect(ctx, x0, top, tunnelW, bottom - top, 14, true, true);

  // 烟雾着色（按浓度把隧道内部横向渐变染色）
  const kRatio = Math.min(1, state.concentrations.k / state.config.kJam);
  if (kRatio > 0.02) {
    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, `rgba(239,68,68,${0.05 * kRatio})`);
    grad.addColorStop(0.5, `rgba(239,68,68,${0.28 * kRatio})`);
    grad.addColorStop(1, `rgba(239,68,68,${0.05 * kRatio})`);
    ctx.fillStyle = grad;
    ctx.fillRect(x0, top, tunnelW, bottom - top);
  }

  // 车道线
  ctx.strokeStyle = '#3a4453';
  ctx.setLineDash([14, 12]);
  ctx.beginPath(); ctx.moveTo(x0, (top + bottom) / 2); ctx.lineTo(x1, (top + bottom) / 2); ctx.stroke();
  ctx.setLineDash([]);

  // 风向箭头（顶部，长度∝总风量）
  const maxAir = state.config.fanCount * state.config.inducedAirflow + 90;
  const airRatio = Math.min(1, state.airflow.total / maxAir);
  drawArrows(ctx, x0 + 14, top - 24, tunnelW - 28, airRatio,
    state.emergency ? '#ef4444' : '#2dd4bf', 5);

  // 风量标注
  ctx.fillStyle = '#8b98a9';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`总风量 ${state.airflow.total.toFixed(0)} m³/s（活塞 ${state.airflow.piston.toFixed(0)} + 机械 ${state.airflow.mechanical.toFixed(0)}）`, x0, top - 38);

  // 车辆（按流量密度撒点）
  const density = Math.min(1, state.traffic.q / 2400);
  const cars = Math.round(4 + density * 22);
  for (let i = 0; i < cars; i++) {
    const seed = (i * 137.5 + (state.t * 0.06 * (state.traffic.v / 40))) % tunnelW;
    const x = x0 + ((seed % tunnelW) + tunnelW) % tunnelW;
    const y = (top + bottom) / 2 - 16 + (i % 2) * 32;
    drawCar(ctx, x, y, state.traffic.v < 20);
  }

  // 16 台风机（顶部一排）
  const fanAreaW = tunnelW - 60;
  const startX = x0 + 30;
  state.fans.forEach((f, i) => {
    const x = startX + (i / (state.fans.length - 1)) * fanAreaW;
    const y = top + 20;
    drawFan(ctx, x, y, f, state.t);
  });

  // 洞口标注
  ctx.fillStyle = '#8b98a9';
  ctx.textAlign = 'center';
  ctx.fillText('入口', x0 - 24, (top + bottom) / 2);
  ctx.fillText('出口', x1 + 24, (top + bottom) / 2);
  ctx.textAlign = 'left';
  ctx.fillText(`${state.scenario.name} · ${fmtTime(state.t)}`, x0, bottom + 26);
}

function drawArrows(ctx, x, y, w, ratio, color, n) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5;
  for (let i = 0; i < n; i++) {
    const ax = x + (i / n) * w;
    const len = 26 + ratio * 52;
    ctx.beginPath(); ctx.moveTo(ax, y); ctx.lineTo(ax + len, y); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax + len, y); ctx.lineTo(ax + len - 7, y - 4); ctx.lineTo(ax + len - 7, y + 4);
    ctx.closePath(); ctx.fill();
  }
}

function drawCar(ctx, x, y, jam) {
  ctx.fillStyle = jam ? '#f59e0b' : '#60a5fa';
  roundRect(ctx, x - 11, y - 6, 22, 12, 3, true, false);
}

function drawFan(ctx, x, y, f, t) {
  const r = 11;
  let color = '#3a4453';
  if (f.fault) color = '#ef4444';
  else if (f.on) color = '#22c55e';
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  // 扇叶：运行时旋转
  ctx.save();
  ctx.translate(x, y);
  if (f.on) ctx.rotate((t * 0.5) % (Math.PI * 2));
  ctx.strokeStyle = color; ctx.lineWidth = 1.6;
  for (let i = 0; i < 3; i++) {
    ctx.rotate((Math.PI * 2) / 3);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(4, -5, 2, -r + 2); ctx.stroke();
  }
  ctx.restore();
  // 组标 + 编号
  ctx.fillStyle = f.fault ? '#ef4444' : '#8b98a9';
  ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(String(f.id + 1), x, y + r + 12);
  if (f.id % 4 === 0) {
    ctx.fillStyle = '#60a5fa';
    ctx.fillText(f.group + '组', x - 16, y - r - 6);
  }
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

// ---------- 曲线图 ----------
function drawChart(canvasId, series, seriesDefs, yMaxManual) {
  const cv = $(canvasId);
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 44, r: 44, t: 12, b: 24 };
  if (!series.length) return;
  const tMax = state.duration;
  const x = (t) => pad.l + (t / tMax) * (W - pad.l - pad.r);
  // 网格
  ctx.strokeStyle = '#232b38'; ctx.lineWidth = 1;
  ctx.fillStyle = '#5d6b7e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let h = 0; h <= 4; h++) {
    const yy = pad.t + (h / 4) * (H - pad.t - pad.b);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
  }
  for (let hh = 0; hh <= 24; hh += 4) {
    const xx = x(hh * 3600);
    ctx.fillText(hh + 'h', xx + 2, H - 8);
  }
  seriesDefs.forEach((def, axis) => {
    const vals = series.map(def.value).filter(isFinite);
    if (!vals.length) return;
    const max = yMaxManual?.[axis] ?? Math.max(...vals, def.min ?? 1) * 1.15;
    const y = (v) => pad.t + (1 - Math.min(1, v / max)) * (H - pad.t - pad.b);
    ctx.strokeStyle = def.color; ctx.lineWidth = 1.8;
    ctx.setLineDash(def.dash ? [5, 4] : []);
    ctx.beginPath();
    series.forEach((p, i) => {
      const xx = x(p.t), yy = y(def.value(p));
      i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    });
    ctx.stroke(); ctx.setLineDash([]);
    // 限值线
    if (def.limit) {
      ctx.strokeStyle = 'rgba(239,68,68,0.6)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(pad.l, y(def.limit)); ctx.lineTo(W - pad.r, y(def.limit)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ef4444'; ctx.textAlign = 'left';
      ctx.fillText(def.limitLabel ?? `限 ${def.limit}`, pad.l + 4, y(def.limit) - 3);
    }
    // y 轴标签
    ctx.fillStyle = def.color; ctx.textAlign = 'right';
    ctx.fillText(Math.round(max), pad.l - 5, pad.t + 10);
  });
  // 当前时刻竖线
  const cx = x(state.t);
  ctx.strokeStyle = 'rgba(230,237,243,0.35)';
  ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, H - pad.b); ctx.stroke();
}

// ---------- 决策与事件 ----------
function renderDemand() {
  const d = state.demand;
  if (!d) return;
  const reasonMap = {
    hold: '保持（滞回确认中）', up: '增机', down: '减机',
    emergency: '应急越权：全部投入', fixed: '定时编组', manual: '人工指定',
  };
  const rows = [
    ['决策动作', reasonMap[d.reason] ?? d.reason],
    ['前馈需风量', `${d.qDemand.toFixed(1)} m³/s`],
    ['反馈修正后需风', `${d.qEffective.toFixed(1)} m³/s（×${d.feedbackMult.toFixed(2)}）`],
    ['前馈目标台数', `${d.desiredCount} 台`],
    ['实际运行', `${state.activeFans} 台 / 16`],
    ['拥堵判定', d.jam ? '阻滞（车速 < 20 km/h）' : '正常行驶'],
  ];
  $('demandDetail').innerHTML = rows
    .map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('');
}

function renderEvents() {
  const ul = $('eventList');
  ul.innerHTML = state.events
    .slice()
    .reverse()
    .map((e) => `<li><span class="time">${fmtTime(e.tSec)}</span><span class="lvl-${e.level}">${e.message}</span></li>`)
    .join('');
}

// ---------- 主渲染 ----------
function render() {
  if ($('scenarioSelect').value !== state.scenario.id) $('scenarioSelect').value = state.scenario.id;
  if ($('modeSelect').value !== state.mode) $('modeSelect').value = state.mode;
  const desc = state.scenarios.find((x) => x.id === state.scenario.id)?.description;
  if (desc && $('scenarioDesc').textContent !== desc) $('scenarioDesc').textContent = desc;
  renderKpis();
  drawTunnel();
  const s = state.series;
  drawChart('chartTraffic', s, [
    { color: '#60a5fa', value: (p) => p.q },
    { color: '#f59e0b', value: (p) => p.v * 30, dash: true },
  ], [2600, 80 * 30]);
  drawChart('chartPollution', s, [
    { color: '#2dd4bf', value: (p) => p.coPpm, limit: state.config.coNormalPpm, limitLabel: `CO 限 ${state.config.coNormalPpm} ppm` },
    { color: '#a78bfa', value: (p) => Math.min(3000, p.vis), dash: true },
  ], [160, 3000]);
  drawChart('chartAirflow', s, [
    { color: '#f59e0b', value: (p) => p.piston },
    { color: '#22c55e', value: (p) => p.mech + p.piston },
    { color: '#e6edf3', value: (p) => p.fans * 20, dash: true },
  ], [320, 320]);
  renderDemand();
  renderEvents();
}

// ---------- 交互 ----------
$('scenarioSelect').addEventListener('change', (e) => api('/api/reset', { scenario: e.target.value, mode: state.mode }));
$('modeSelect').addEventListener('change', (e) => api('/api/mode', { mode: e.target.value }));
$('speedSelect').addEventListener('change', (e) => api('/api/run', { speed: Number(e.target.value) }));
$('btnRun').addEventListener('click', () => api('/api/run', { speed: Number($('speedSelect').value) }));
$('btnPause').addEventListener('click', () => api('/api/pause'));
$('btnStep').addEventListener('click', () => api('/api/step', { steps: 60 }));
$('btnReset').addEventListener('click', () =>
  api('/api/reset', { scenario: $('scenarioSelect').value, mode: $('modeSelect').value }));

$('tunnelCanvas').addEventListener('click', (e) => {
  const cv = e.target;
  const rect = cv.getBoundingClientRect();
  const mx = ((e.clientX - rect.left) / rect.width) * cv.width;
  const my = ((e.clientY - rect.top) / rect.height) * cv.height;
  // 风机位置（与 drawTunnel 相同布局）
  const x0 = 70, x1 = cv.width - 30, startX = x0 + 30, fanAreaW = x1 - x0 - 60;
  state.fans.forEach((f, i) => {
    const x = startX + (i / (state.fans.length - 1)) * fanAreaW;
    const y = 55 + 20;
    if (Math.hypot(mx - x, my - y) < 16) {
      if (state.mode === 'manual') api('/api/fan', { id: f.id, on: !f.on });
      else api('/api/fan', { id: f.id, fault: !f.fault });
    }
  });
});

$('btnCompare').addEventListener('click', async () => {
  const ids = state.scenarios.map((s) => s.id);
  const results = await Promise.all(
    ids.map(async (id) => ({ id, name: state.scenarios.find((s) => s.id === id).name, ...(await (await fetch(`/api/compare?scenario=${id}`)).json()) })),
  );
  $('compareContent').innerHTML = `<table class="cmp">
    <tr><th>场景</th><th>定时 kWh</th><th>按需 kWh</th><th>节能</th><th>定时峰值 CO</th><th>按需峰值 CO</th><th>按需超标%</th><th>按需启动次数</th></tr>
    ${results
      .map(
        (r) => `<tr><td>${r.name}</td>
          <td>${r.fixed.totalEnergyKwh.toFixed(0)}</td>
          <td>${r.auto.totalEnergyKwh.toFixed(0)}</td>
          <td class="save">${r.energySavingPct.toFixed(1)}%</td>
          <td>${r.fixed.maxCoPpm.toFixed(1)}</td>
          <td>${r.auto.maxCoPpm.toFixed(1)}</td>
          <td>${r.auto.violationPct.toFixed(2)}</td>
          <td>${r.auto.fanStarts}</td></tr>`,
      )
      .join('')}
  </table>`;
  $('compareModal').classList.remove('hidden');
});
$('btnCloseCompare').addEventListener('click', () => $('compareModal').classList.add('hidden'));

// 初始化
fetch('/api/state')
  .then((r) => r.json())
  .then((s) => {
    state = s;
    $('scenarioSelect').innerHTML = s.scenarios.map((x) => `<option value="${x.id}">${x.name}</option>`).join('');
    $('scenarioSelect').value = s.scenario.id;
    $('scenarioDesc').textContent = s.scenarios.find((x) => x.id === s.scenario.id).description;
    $('modeSelect').value = s.mode;
    render();
    connect();
  });
