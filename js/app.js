'use strict';

/* =========================================================
   State
   ========================================================= */
const PAIRS = ['GD30/AL30', 'GD35/AL35', 'GD38/AE38', 'GD41/AL41'];

const state = {
  activePair: PAIRS[0],
  params: Object.fromEntries(PAIRS.map(p => [p, { period: 21, devs: 1.5 }])),
  initialized: Object.fromEntries(PAIRS.map(p => [p, false])),
  charts: {},
};

/* =========================================================
   Bollinger Bands
   ========================================================= */
function computeBollinger(ratios, period, devs) {
  return ratios.map((r, i) => {
    if (i < period - 1) {
      return { mm: null, upper: null, lower: null, signal: 'Neutro' };
    }
    const chunk = ratios.slice(i - period + 1, i + 1);
    const mm = chunk.reduce((s, v) => s + v, 0) / period;
    const variance = chunk.reduce((s, v) => s + (v - mm) ** 2, 0) / period;
    const sigma = Math.sqrt(variance);
    const upper = mm + devs * sigma;
    const lower = mm - devs * sigma;
    const signal = r >= upper ? 'GD' : r <= lower ? 'AL' : 'Neutro';
    return { mm, upper, lower, signal };
  });
}

/* =========================================================
   Helpers
   ========================================================= */
function signalLabel(s) {
  return s === 'GD' ? 'Rotar a GD' : s === 'AL' ? 'Rotar a AL' : 'Neutro';
}

function signalColor(s) {
  return s === 'GD' ? '#ef4444' : s === 'AL' ? '#22c55e' : '#6b7280';
}

function fmt(n) {
  return n != null ? n.toFixed(2) : '—';
}

/* =========================================================
   Init panel HTML (called once per pair on first visit)
   ========================================================= */
function initPanel(pairKey) {
  const panel = document.querySelector(`[data-panel="${pairKey}"]`);
  const sid = pairKey.replace('/', '-');
  const { b1, b2 } = BOND_DATA[pairKey];
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
      <span class="legend-item">
        <span class="legend-dash"></span>
        Media móvil
      </span>
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
  `;

  document.getElementById(`period-${sid}`).addEventListener('input', e => {
    state.params[pairKey].period = +e.target.value;
    document.getElementById(`pval-${sid}`).textContent = e.target.value;
    renderPair(pairKey);
  });

  document.getElementById(`devs-${sid}`).addEventListener('input', e => {
    state.params[pairKey].devs = +e.target.value;
    document.getElementById(`dval-${sid}`).textContent = (+e.target.value).toFixed(1);
    renderPair(pairKey);
  });

  state.initialized[pairKey] = true;
}

/* =========================================================
   Cards
   ========================================================= */
function renderCards(pairKey, lastData, lastBoll) {
  const sid = pairKey.replace('/', '-');
  const el = document.getElementById(`cards-${sid}`);
  const { b1, b2 } = BOND_DATA[pairKey];
  const { signal, mm, upper, lower } = lastBoll;
  const r = lastData.r;
  const sc = signalColor(signal);
  const sl = signalLabel(signal);

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
    </div>
  `;
}

/* =========================================================
   Chart
   ========================================================= */
function renderChart(pairKey, labels, ratios, bollData) {
  const sid = pairKey.replace('/', '-');
  const { period } = state.params[pairKey];

  if (state.charts[pairKey]) {
    state.charts[pairKey].destroy();
    state.charts[pairKey] = null;
  }

  const ctx = document.getElementById(`chart-${sid}`).getContext('2d');

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
        /* 0 — Upper band + red fill above */
        {
          label: 'Banda Superior',
          data: upperData,
          borderColor: 'rgba(239,68,68,0.55)',
          borderWidth: 1,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: 'end',
          backgroundColor: 'rgba(239,68,68,0.10)',
          spanGaps: false,
          tension: 0,
          order: 4,
        },
        /* 1 — Lower band + green fill below */
        {
          label: 'Banda Inferior',
          data: lowerData,
          borderColor: 'rgba(34,197,94,0.55)',
          borderWidth: 1,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: 'start',
          backgroundColor: 'rgba(34,197,94,0.10)',
          spanGaps: false,
          tension: 0,
          order: 4,
        },
        /* 2 — Moving average */
        {
          label: `MM(${period})`,
          data: mmData,
          borderColor: 'rgba(148,163,184,0.75)',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          spanGaps: false,
          tension: 0,
          order: 2,
        },
        /* 3 — Ratio line (signal-colored points) */
        {
          label: 'Ratio',
          data: ratios,
          borderColor: '#3b82f6',
          borderWidth: 2,
          pointRadius: ptRadii,
          pointBackgroundColor: ptColors,
          pointBorderColor: ptColors,
          pointHoverRadius: 5,
          fill: false,
          tension: 0.15,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2d3148',
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          padding: 12,
          /* Only show tooltip entry for the ratio dataset */
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
        x: {
          ticks: {
            color: '#94a3b8',
            maxTicksLimit: 14,
            maxRotation: 45,
            minRotation: 0,
          },
          grid: { color: 'rgba(45,49,72,0.65)' },
        },
        y: {
          grace: '5%',
          ticks: {
            color: '#94a3b8',
            callback: v => v.toFixed(2) + '%',
          },
          grid: { color: 'rgba(45,49,72,0.65)' },
        },
      },
    },
  });
}

/* =========================================================
   Table (last 20 rows, newest first)
   ========================================================= */
function renderTable(pairKey, bollData) {
  const sid = pairKey.replace('/', '-');
  const el = document.getElementById(`table-${sid}`);
  const { b1, b2, data } = BOND_DATA[pairKey];

  const n = data.length;
  const rows  = data.slice(Math.max(0, n - 20)).reverse();
  const bRows = bollData.slice(Math.max(0, n - 20)).reverse();

  const tbody = rows.map((d, i) => {
    const b = bRows[i];
    const sc = signalColor(b.signal);
    const sl = signalLabel(b.signal);
    const rowCls = b.signal === 'GD' ? ' class="row-red"' : b.signal === 'AL' ? ' class="row-green"' : '';
    return `
      <tr${rowCls}>
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
        <tr>
          <th>Fecha</th>
          <th>${b1}</th>
          <th>${b2}</th>
          <th>Ratio</th>
          <th>Señal</th>
        </tr>
      </thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

/* =========================================================
   Master render for a pair
   ========================================================= */
function renderPair(pairKey) {
  const { data } = BOND_DATA[pairKey];
  const { period, devs } = state.params[pairKey];
  const ratios   = data.map(d => d.r);
  const labels   = data.map(d => d.d);
  const bollData = computeBollinger(ratios, period, devs);

  renderCards(pairKey, data[data.length - 1], bollData[bollData.length - 1]);
  renderChart(pairKey, labels, ratios, bollData);
  renderTable(pairKey, bollData);
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

  if (!state.initialized[pairKey]) initPanel(pairKey);
  renderPair(pairKey);
}

/* =========================================================
   Bootstrap
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.pair))
  );

  initPanel(PAIRS[0]);
  renderPair(PAIRS[0]);
});
