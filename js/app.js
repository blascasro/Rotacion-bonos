'use strict';

/* =========================================================
   Config
   ========================================================= */
const BASE_URL =
  'https://docs.google.com/spreadsheets/d/e/' +
  '2PACX-1vTuuPzwvPZac06ggk2VPnNrP8cnTXEx2qjcnoWXO59Lrvb-4ZpXwj6Zv2uh-Ss3ay3Sm2iKUP7X26KP/' +
  'pub?single=true&output=csv&gid=';

const GID = {
  'GD30/AL30': '1238880052',
  'GD35/AL35': '1993257442',
  'GD38/AE38': '925690249',
  'GD41/AL41': '1751658078',
   INTRADAY:   '1764500972',
};

const PAIR_INFO = {
  'GD30/AL30': { b1: 'GD30', b2: 'AL30' },
  'GD35/AL35': { b1: 'GD35', b2: 'AL35' },
  'GD38/AE38': { b1: 'GD38', b2: 'AE38' },
  'GD41/AL41': { b1: 'GD41', b2: 'AL41' },
};

const PAIRS = ['GD30/AL30', 'GD35/AL35', 'GD38/AE38', 'GD41/AL41'];

/* =========================================================
   State
   ========================================================= */
const state = {
  activePair:       PAIRS[0],
  params:           Object.fromEntries(PAIRS.map(p => [p, { period: 21, devs: 1.5 }])),
  initialized:      Object.fromEntries(PAIRS.map(p => [p, false])),
  charts:           {},           // historical Chart instances
  data:             {},           // { [pairKey]: [{d,b1,b2,r},...] }
  intradayData:     null,         // parsed intraday rows
  intradayChart:    null,         // intraday Chart instance
  intradayInterval: null,
};

/* =========================================================
   CSV helpers
   ========================================================= */
function parseCSV(text) {
  return text
    .replace(/^﻿/, '')       // strip BOM if present
    .trim()
    .split(/\r?\n/)
    .map(line => line.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
}

/** Historical sheets: detect data rows by date format in col 0 (d/m or dd/mm).
 *  Sheets may have variable-length headers/notes above the data, so we don't
 *  skip a fixed number of rows — we just look for the date pattern. */
function parseHistorical(csvText) {
  const data = [];
  for (const row of csvText.split('\n')) {
    const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, '').replace('\r', ''));
    // col[0] is always empty; date is in col[1]
    if (!/^\d{1,2}\/\d{1,2}$/.test(cols[1])) continue;
    const b1    = parseFloat(cols[2]);
    const b2    = parseFloat(cols[3]);
    const ratio = parseFloat((cols[4] || '').replace('%', '').replace(',', '.'));
    if (isNaN(b1) || isNaN(b2) || isNaN(ratio)) continue;
    data.push({ d: cols[1], b1, b2, r: ratio });
  }
  return data.reverse();   // CSV is newest-first → chronological for charting
}

/** Intraday sheet: newest-first → reverse → chronological */
function parseIntraday(csvText) {
  return parseCSV(csvText)
    .slice(2)
    .filter(r => /^\d{2}:\d{2}:\d{2}$/.test((r[0] || '').trim()))
    .filter(r => r.length >= 6 && [1, 2, 3, 4, 5].every(i => !isNaN(parseFloat(r[i]))))
    .reverse()
    .map(r => ({
      hora: r[0].trim(),
      gd30: parseFloat(r[1]),
      al30: parseFloat(r[2]),
      mid:  parseFloat(r[3]),
      gdal: parseFloat(r[4]),
      algd: parseFloat(r[5]),
    }));
}

async function fetchCSV(gid) {
  const res = await fetch(BASE_URL + gid);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* =========================================================
   Bollinger Bands
   ========================================================= */
function computeBollinger(ratios, period, devs) {
  const n = ratios.length;
  return ratios.map((r, i) => {
    if (i < period - 1) {
      // Not enough history for a full window.
      // Exception: if the whole dataset is shorter than 'period', still
      // compute the last point using all available data so renderCards
      // always has a value to display.
      if (i < n - 1) return { mm: null, upper: null, lower: null, signal: 'Neutro' };
      // i === n-1 AND n < period → fall through with partial window
    }
    const chunk = ratios.slice(Math.max(0, i - period + 1), i + 1);
    const ep       = chunk.length;                                        // actual elements used
    const mm       = chunk.reduce((s, v) => s + v, 0) / ep;
    const variance = chunk.reduce((s, v) => s + (v - mm) ** 2, 0) / ep;
    const sigma    = Math.sqrt(variance);
    const upper    = mm + devs * sigma;
    const lower    = mm - devs * sigma;
    const signal   = r >= upper ? 'GD' : r <= lower ? 'AL' : 'Neutro';
    return { mm, upper, lower, signal };
  });
}

/* =========================================================
   Shared helpers
   ========================================================= */
function signalLabel(s) {
  return s === 'GD' ? 'Rotar a GD' : s === 'AL' ? 'Rotar a AL' : 'Neutro';
}
function signalColor(s) {
  return s === 'GD' ? '#ef4444' : s === 'AL' ? '#22c55e' : '#6b7280';
}
function fmt(n) { return n != null ? n.toFixed(2) : '—'; }

/* =========================================================
   Loading / Error states
   ========================================================= */
function showLoading(pairKey) {
  const panel = document.querySelector(`[data-panel="${pairKey}"]`);
  panel.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Cargando ${pairKey}…</p>
    </div>`;
}

function showError(pairKey, err) {
  const panel = document.querySelector(`[data-panel="${pairKey}"]`);
  panel.innerHTML = `
    <div class="error-state">
      <p class="error-title">⚠ No se pudieron cargar los datos de ${pairKey}</p>
      <p class="error-detail">${err.message}</p>
    </div>`;
}

/* =========================================================
   Panel init (called once per pair, after data is ready)
   ========================================================= */
function initPanel(pairKey) {
  const panel = document.querySelector(`[data-panel="${pairKey}"]`);
  const sid   = pairKey.replace('/', '-');
  const { b1, b2 } = PAIR_INFO[pairKey];
  const { period, devs } = state.params[pairKey];

  panel.innerHTML = `
    <div class="cards-row" id="cards-${sid}"></div>

    <div class="controls-row">
      <div class="control-group">
        <label class="control-label">
          <span>Período MM</span>
          <span class="control-value" id="pval-${sid}">${period}</span>
        </label>
        <input type="range" class="slider" id="period-${sid}"
               min="5" max="40" step="1" value="${period}">
        <div class="slider-bounds"><span>5</span><span>40</span></div>
      </div>
      <div class="control-group">
        <label class="control-label">
          <span>Desvíos σ</span>
          <span class="control-value" id="dval-${sid}">${devs.toFixed(1)}</span>
        </label>
        <input type="range" class="slider" id="devs-${sid}"
               min="0.5" max="3.0" step="0.1" value="${devs}">
        <div class="slider-bounds"><span>0.5</span><span>3.0</span></div>
      </div>
    </div>

    <div class="chart-wrapper">
      <canvas id="chart-${sid}"></canvas>
    </div>

    <div class="chart-legend">
      <span class="legend-item">
        <span class="legend-swatch" style="background:#3b82f6;border-radius:50%"></span>
        Ratio diario
      </span>
      <span class="legend-item"><span class="legend-dash"></span>Media móvil</span>
      <span class="legend-item">
        <span class="legend-swatch" style="background:rgba(239,68,68,0.28)"></span>
        Zona &gt; banda sup.
      </span>
      <span class="legend-item">
        <span class="legend-swatch" style="background:rgba(34,197,94,0.28)"></span>
        Zona &lt; banda inf.
      </span>
      <span class="legend-item">
        <span class="legend-swatch" style="background:#ef4444;border-radius:50%"></span>
        Señal: Rotar a ${b1}
      </span>
      <span class="legend-item">
        <span class="legend-swatch" style="background:#22c55e;border-radius:50%"></span>
        Señal: Rotar a ${b2}
      </span>
    </div>

    <div class="table-wrap" id="table-${sid}"></div>

    ${pairKey === 'GD30/AL30' ? buildIntradayHTML() : ''}
  `;

  /* Slider events */
  document.getElementById(`period-${sid}`).addEventListener('input', e => {
    state.params[pairKey].period = +e.target.value;
    document.getElementById(`pval-${sid}`).textContent = e.target.value;
    renderHistorical(pairKey);
  });
  document.getElementById(`devs-${sid}`).addEventListener('input', e => {
    state.params[pairKey].devs = +e.target.value;
    document.getElementById(`dval-${sid}`).textContent = (+e.target.value).toFixed(1);
    renderHistorical(pairKey);
  });

  state.initialized[pairKey] = true;

  /* If intraday data already arrived, render it immediately */
  if (pairKey === 'GD30/AL30' && state.intradayData?.length > 0) {
    renderIntradaySection();
  }
}

function buildIntradayHTML() {
  return `
    <section class="intraday-section">
      <div class="section-header">
        <h2 class="section-title">Intraday GD30 / AL30</h2>
        <span class="refresh-indicator" id="refresh-status">
          <span class="refresh-dot">●</span> Cargando…
        </span>
      </div>

      <div class="cards-row" id="intraday-cards"></div>

      <div class="chart-wrapper intraday-chart-wrap">
        <canvas id="chart-intraday"></canvas>
      </div>

      <div class="chart-legend">
        <span class="legend-item">
          <span class="legend-swatch" style="background:#3b82f6;border-radius:50%"></span>
          Ratio mid
        </span>
        <span class="legend-item">
          <span class="legend-swatch" style="background:rgba(239,68,68,0.45)"></span>
          GD→AL ejecutable
        </span>
        <span class="legend-item">
          <span class="legend-swatch" style="background:rgba(34,197,94,0.45)"></span>
          AL→GD ejecutable
        </span>
        <span class="legend-item">
          <span class="legend-swatch" style="background:rgba(120,120,140,0.3)"></span>
          Spread ejecutable
        </span>
      </div>
    </section>`;
}

/* =========================================================
   Historical — Cards
   ========================================================= */
function renderCards(pairKey, lastData, lastBoll) {
  const sid = pairKey.replace('/', '-');
  const el  = document.getElementById(`cards-${sid}`);
  if (!el) return;
  const { b1, b2 } = PAIR_INFO[pairKey];
  const r = lastData.r;

  // Guard: lastBoll can be null/undefined when there are not enough data points
  const { signal = null, mm = null, upper = null, lower = null } = lastBoll ?? {};
  const hasSignal = signal !== null;
  const sc = hasSignal ? signalColor(signal) : '#6b7280';
  const sl = hasSignal ? signalLabel(signal) : 'Sin datos suficientes';

  el.innerHTML = `
    <div class="card">
      <div class="card-label">Ratio actual</div>
      <div class="card-value">${r.toFixed(2)}%</div>
      <div class="card-sub">${b1} / ${b2}</div>
    </div>
    <div class="card">
      <div class="card-label">Banda superior</div>
      <div class="card-value">${fmt(upper)}%</div>
      ${signal === 'GD'
        ? `<div class="card-signal red">▲ Rotar a ${b1}</div>`
        : '<div class="card-sub">&nbsp;</div>'}
    </div>
    <div class="card">
      <div class="card-label">Banda inferior</div>
      <div class="card-value">${fmt(lower)}%</div>
      ${signal === 'AL'
        ? `<div class="card-signal green">▼ Rotar a ${b2}</div>`
        : '<div class="card-sub">&nbsp;</div>'}
    </div>
    <div class="card">
      <div class="card-label">Señal actual</div>
      <div class="card-value-badge">
        <span class="badge" style="background:${sc}20;color:${sc};border-color:${sc}50">${sl}</span>
      </div>
      <div class="card-sub">MM: ${fmt(mm)}%</div>
    </div>`;
}

/* =========================================================
   Historical — Chart
   ========================================================= */
function renderChart(pairKey, labels, ratios, bollData) {
  const sid = pairKey.replace('/', '-');
  const { period } = state.params[pairKey];

  if (state.charts[pairKey]) {
    state.charts[pairKey].destroy();
    state.charts[pairKey] = null;
  }

  const canvas = document.getElementById(`chart-${sid}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const mmData    = bollData.map(b => b.mm);
  const upperData = bollData.map(b => b.upper);
  const lowerData = bollData.map(b => b.lower);

  const ptColors = bollData.map(b =>
    b.signal === 'GD' ? '#ef4444' : b.signal === 'AL' ? '#22c55e' : '#3b82f6'
  );
  const ptRadii = bollData.map(b => b.signal !== 'Neutro' ? 5 : 2);

  state.charts[pairKey] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Banda Superior', data: upperData,
          borderColor: 'rgba(239,68,68,0.55)', borderWidth: 1, borderDash: [5,4],
          pointRadius: 0, fill: 'end', backgroundColor: 'rgba(239,68,68,0.10)',
          spanGaps: false, tension: 0, order: 4 },
        { label: 'Banda Inferior', data: lowerData,
          borderColor: 'rgba(34,197,94,0.55)', borderWidth: 1, borderDash: [5,4],
          pointRadius: 0, fill: 'start', backgroundColor: 'rgba(34,197,94,0.10)',
          spanGaps: false, tension: 0, order: 4 },
        { label: `MM(${period})`, data: mmData,
          borderColor: 'rgba(148,163,184,0.75)', borderWidth: 1.5, borderDash: [6,4],
          pointRadius: 0, fill: false, spanGaps: false, tension: 0, order: 2 },
        { label: 'Ratio', data: ratios,
          borderColor: '#3b82f6', borderWidth: 2,
          pointRadius: ptRadii, pointBackgroundColor: ptColors, pointBorderColor: ptColors,
          pointHoverRadius: 5, fill: false, tension: 0.15, order: 1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2d3148', borderWidth: 1,
          titleColor: '#e2e8f0', bodyColor: '#94a3b8', padding: 12,
          filter: item => item.datasetIndex === 3,
          callbacks: {
            title: items => `Fecha: ${labels[items[0].dataIndex]}`,
            label: item => {
              const i = item.dataIndex;
              const b = bollData[i];
              const lines = [`Ratio:    ${ratios[i].toFixed(2)}%`];
              if (b.mm != null) {
                lines.push(`MM(${period}): ${b.mm.toFixed(2)}%`);
                lines.push(`B. Sup:  ${b.upper.toFixed(2)}%`);
                lines.push(`B. Inf:  ${b.lower.toFixed(2)}%`);
                lines.push(`Señal:   ${signalLabel(b.signal)}`);
              }
              return lines;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#94a3b8', maxTicksLimit: 14, maxRotation: 45, minRotation: 0 },
             grid: { color: 'rgba(45,49,72,0.65)' } },
        y: { grace: '5%',
             ticks: { color: '#94a3b8', callback: v => v.toFixed(2) + '%' },
             grid: { color: 'rgba(45,49,72,0.65)' } },
      },
    },
  });
}

/* =========================================================
   Historical — Table (last 20 rows, newest first)
   ========================================================= */
function renderTable(pairKey, bollData) {
  const sid = pairKey.replace('/', '-');
  const el  = document.getElementById(`table-${sid}`);
  if (!el) return;
  const { b1, b2 } = PAIR_INFO[pairKey];
  const data = state.data[pairKey];
  const n    = data.length;

  const rows  = data.slice(Math.max(0, n - 20)).reverse();
  const bRows = bollData.slice(Math.max(0, n - 20)).reverse();

  const tbody = rows.map((d, i) => {
    const b   = bRows[i];
    const sc  = signalColor(b.signal);
    const sl  = signalLabel(b.signal);
    const cls = b.signal === 'GD' ? ' class="row-red"' : b.signal === 'AL' ? ' class="row-green"' : '';
    return `<tr${cls}>
      <td>${d.d}</td>
      <td>${(d.b1 / 1000).toFixed(2)}</td>
      <td>${(d.b2 / 1000).toFixed(2)}</td>
      <td>${d.r.toFixed(2)}%</td>
      <td><span class="badge-sm" style="background:${sc}20;color:${sc};border:1px solid ${sc}50">${sl}</span></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Fecha</th><th>${b1}</th><th>${b2}</th><th>Ratio</th><th>Señal</th></tr>
      </thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

/* =========================================================
   Historical — master render (called by sliders + tab switch)
   ========================================================= */
function renderHistorical(pairKey) {
  const data = state.data[pairKey];
  if (!data) return;
  const { period, devs } = state.params[pairKey];
  const ratios   = data.map(d => d.r);
  const labels   = data.map(d => d.d);
  const bollData = computeBollinger(ratios, period, devs);

  renderCards(pairKey, data[data.length - 1], bollData[bollData.length - 1]);
  renderChart(pairKey, labels, ratios, bollData);
  renderTable(pairKey, bollData);
}

/* =========================================================
   Intraday — Cards
   ========================================================= */
function renderIntradayCards(rows) {
  const el = document.getElementById('intraday-cards');
  if (!el) return;

  const last   = rows[rows.length - 1];
  const mids   = rows.map(r => r.mid);
  const spread = (Math.max(...mids) - Math.min(...mids)).toFixed(2);

  el.innerHTML = `
    <div class="card">
      <div class="card-label">Ratio actual</div>
      <div class="card-value">${last.mid.toFixed(2)}%</div>
      <div class="card-sub">Último: ${last.hora}</div>
    </div>
    <div class="card">
      <div class="card-label">GD→AL ejecutable</div>
      <div class="card-value">${last.gdal.toFixed(2)}%</div>
      <div class="card-sub card-signal red">Rotar GD→AL</div>
    </div>
    <div class="card">
      <div class="card-label">AL→GD ejecutable</div>
      <div class="card-value">${last.algd.toFixed(2)}%</div>
      <div class="card-sub card-signal green">Rotar AL→GD</div>
    </div>
    <div class="card">
      <div class="card-label">Spread del día</div>
      <div class="card-value">${spread}%</div>
      <div class="card-sub">Max − Min ratio</div>
    </div>`;
}

/* =========================================================
   Intraday — Chart
   ========================================================= */
function renderIntradayChart(rows) {
  if (state.intradayChart) {
    state.intradayChart.destroy();
    state.intradayChart = null;
  }
  const canvas = document.getElementById('chart-intraday');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const labels   = rows.map(r => r.hora);
  const midData  = rows.map(r => r.mid);
  const gdalData = rows.map(r => r.gdal);
  const algdData = rows.map(r => r.algd);

  state.intradayChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        /* GD>AL — fills DOWN to AL>GD (gray spread area) */
        { label: 'GD→AL ejecutable', data: gdalData,
          borderColor: 'rgba(239,68,68,0.65)', borderWidth: 1.5, borderDash: [5,3],
          pointRadius: 0, fill: '+1', backgroundColor: 'rgba(110,110,140,0.15)',
          tension: 0, order: 3 },
        /* AL>GD — lower bound of spread, no fill */
        { label: 'AL→GD ejecutable', data: algdData,
          borderColor: 'rgba(34,197,94,0.65)', borderWidth: 1.5, borderDash: [5,3],
          pointRadius: 0, fill: false, tension: 0, order: 3 },
        /* Mid ratio — blue solid line */
        { label: 'Ratio mid', data: midData,
          borderColor: '#3b82f6', borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 4,
          fill: false, tension: 0.15, order: 1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2d3148', borderWidth: 1,
          titleColor: '#e2e8f0', bodyColor: '#94a3b8', padding: 12,
          filter: item => item.datasetIndex === 2,
          callbacks: {
            title: items => `Hora: ${labels[items[0].dataIndex]}`,
            label: item => {
              const i = item.dataIndex;
              return [
                `Ratio mid:  ${midData[i].toFixed(2)}%`,
                `GD→AL:      ${gdalData[i].toFixed(2)}%`,
                `AL→GD:      ${algdData[i].toFixed(2)}%`,
              ];
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#94a3b8', maxTicksLimit: 12, maxRotation: 45 },
             grid: { color: 'rgba(45,49,72,0.65)' } },
        y: { grace: '5%',
             ticks: { color: '#94a3b8', callback: v => v.toFixed(2) + '%' },
             grid: { color: 'rgba(45,49,72,0.65)' } },
      },
    },
  });
}

/* =========================================================
   Intraday — render section (cards + chart)
   ========================================================= */
function renderIntradaySection() {
  if (!state.intradayData?.length) return;
  renderIntradayCards(state.intradayData);
  renderIntradayChart(state.intradayData);
}

/* =========================================================
   Intraday — fetch + render + refresh indicator
   ========================================================= */
async function fetchAndRenderIntraday() {
  try {
    const text = await fetchCSV(GID.INTRADAY);
    const rows = parseIntraday(text);
    console.log(`[INTRADAY] CSV recibido → ${rows.length} filas válidas`);
    state.intradayData = rows;

    if (rows.length === 0) {
      setRefreshStatus('Sin datos disponibles', false);
      return;
    }

    renderIntradaySection();

    const hms = new Date().toTimeString().slice(0, 8);
    setRefreshStatus(`Actualizado ${hms}`, true);
  } catch (err) {
    setRefreshStatus(`Error: ${err.message}`, false);
  }
}

function setRefreshStatus(msg, ok) {
  const el = document.getElementById('refresh-status');
  if (!el) return;
  el.innerHTML = `<span class="refresh-dot ${ok ? 'ok' : 'err'}">●</span> ${msg}`;
}

/* =========================================================
   Tab switching
   ========================================================= */
function switchTab(pairKey) {
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.pair === pairKey)
  );
  document.querySelectorAll('.tab-panel').forEach(panel =>
    panel.classList.toggle('active', panel.dataset.panel === pairKey)
  );

  state.activePair = pairKey;

  if (state.data[pairKey]) {
    if (!state.initialized[pairKey]) initPanel(pairKey);
    renderHistorical(pairKey);
    /* Re-render intraday when switching back to GD30/AL30 */
    if (pairKey === 'GD30/AL30') renderIntradaySection();
  }
  /* else: panel still showing loading/error state — will update when data arrives */
}

/* =========================================================
   Historical fetch — per pair
   ========================================================= */
function loadPair(pairKey) {
  showLoading(pairKey);
  fetchCSV(GID[pairKey])
    .then(text => {
      const parsed = parseHistorical(text);
      console.log(`[${pairKey}] CSV recibido → ${parsed.length} filas válidas`);
      state.data[pairKey] = parsed;
      /* If this tab is active (or was already switched to), render immediately */
      if (state.activePair === pairKey) {
        if (!state.initialized[pairKey]) initPanel(pairKey);
        renderHistorical(pairKey);
        if (pairKey === 'GD30/AL30') renderIntradaySection();
      }
      /* else: data is cached; will render when user visits the tab */
    })
    .catch(err => showError(pairKey, err));
}

/* =========================================================
   Bootstrap
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
  /* Wire up tab buttons */
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.pair))
  );

  /* Fetch all 4 historical pairs independently (best-effort parallel) */
  PAIRS.forEach(loadPair);

  /* Intraday: fetch now, then every 60 s */
  fetchAndRenderIntraday();
  state.intradayInterval = setInterval(fetchAndRenderIntraday, 60_000);
});
