/* ─────────────────────────────────────────────────
   dashboard.js — Analytics dashboard
   Depends on: Chart.js (CDN), modern.js (api fn)
   ───────────────────────────────────────────────── */
'use strict';

/* ── Colour palette (matches app accent colours) ─ */
const PALETTE = [
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d4', // cyan
  '#f97316', // orange
  '#84cc16', // lime
  '#ec4899', // pink
  '#a78bfa', // violet
  '#34d399', // emerald
  '#fb923c', // orange-400
];

/* ── Shared dark-theme Chart.js overrides ────────── */
const TOOLTIP = {
  backgroundColor: '#1e2433',
  borderColor: '#2d3748',
  borderWidth: 1,
  titleColor: '#f8fafc',
  bodyColor: '#94a3b8',
  padding: 10,
  cornerRadius: 6,
};
const GRID  = { color: 'rgba(45,55,72,0.6)', drawBorder: false };
const TICKS = { color: '#64748b', font: { size: 11 } };

/* ── Chart instance cache ─────────────────────────── */
const _ch = {};
function destroyChart(id) {
  if (_ch[id]) { _ch[id].destroy(); delete _ch[id]; }
}

/* ── Number formatter ─────────────────────────────── */
function fmt(n) { return Number(n).toLocaleString(); }

/* ── Fill missing days with 0 ────────────────────── */
function fillDays(perDay, days) {
  const map = {};
  perDay.forEach(d => { map[d.day] = d.count; });
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map[key] || 0 });
  }
  return out;
}

/* ══ Main loader ══════════════════════════════════ */
window.loadDashboardData = async function () {
  const days         = document.getElementById('dash-range')?.value || 14;
  const filterSource = document.getElementById('dash-filter-source')?.value || '';
  const filterTopic  = document.getElementById('dash-filter-topic')?.value  || '';

  // Show loading state in stat cards
  ['ds-total-msgs', 'ds-period-msgs', 'ds-summaries', 'ds-sources'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  });

  let url = `/api/dashboard/stats?days=${days}`;
  if (filterSource) url += `&filter_source=${encodeURIComponent(filterSource)}`;
  if (filterTopic)  url += `&filter_topic=${encodeURIComponent(filterTopic)}`;

  const data = await api(url);
  if (!data || data.status === 'error') {
    const msg = data?.message || 'Failed to load dashboard data.';
    console.error('Dashboard load error:', msg);
    ['ds-total-msgs', 'ds-period-msgs', 'ds-summaries', 'ds-sources'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = '—'; el.title = msg; }
    });
    const matrix = document.getElementById('dash-matrix');
    if (matrix) matrix.innerHTML = `<p class="mon-empty" style="color:#ef4444">Error: ${msg}</p>`;
    return;
  }

  /* ── Populate filter dropdowns (preserve selection) ─ */
  populateDashboardFilters(data, filterSource, filterTopic);

  /* ── Show/hide the clear-filters button ─────────── */
  const clearBtn = document.getElementById('dash-filter-clear-btn');
  if (clearBtn) clearBtn.style.display = (filterSource || filterTopic) ? '' : 'none';

  /* ── Stat cards ─────────────────────────────────── */
  document.getElementById('ds-total-msgs').textContent  = fmt(data.total_messages);
  document.getElementById('ds-period-msgs').textContent = fmt(data.period_messages);
  document.getElementById('ds-summaries').textContent   = fmt(data.total_summaries);
  document.getElementById('ds-sources').textContent     = fmt(data.active_sources);
  document.getElementById('ds-period-label').textContent = `Messages (${days}d)`;

  /* ── Charts ─────────────────────────────────────── */
  renderDailyChart(data.messages_per_day, Number(days));
  renderTopicsDonut(data.messages_per_topic);
  renderSourcesBar(data.messages_per_source);
  renderTrendChart(data.topic_trend, data.messages_per_topic);

  /* ── Matrix ─────────────────────────────────────── */
  renderSourceMatrix(data.source_topic_breakdown, data.messages_per_topic);
};

/* ── Populate source & topic filter dropdowns ──── */
function populateDashboardFilters(data, currentSource, currentTopic) {
  const srcEl   = document.getElementById('dash-filter-source');
  const topicEl = document.getElementById('dash-filter-topic');
  if (!srcEl || !topicEl) return;

  // --- Sources: merge DB list + config-defined source channels ---
  const dbSources = data.all_sources || [];
  const cfgSources = [];
  if (window.globalConfig) {
    for (const coll of Object.values(window.globalConfig.collections || {})) {
      for (const ch of (coll.source_channels || [])) {
        const clean = ch.replace(/^@/, '');
        if (!dbSources.includes(ch) && !dbSources.includes(clean)) {
          cfgSources.push(ch);
        }
      }
    }
  }
  const allSources = [...dbSources, ...cfgSources];

  // --- Topics: merge DB list + config-defined topics ---
  const dbTopics = data.all_topics || [];
  const cfgTopics = [];
  if (window.globalConfig) {
    for (const bot of Object.values(window.globalConfig.bots || {})) {
      for (const cat of Object.values(bot.categories || {})) {
        for (const topicName of Object.keys(cat.topics || {})) {
          if (!dbTopics.includes(topicName)) cfgTopics.push(topicName);
        }
      }
    }
  }
  const allTopics = [...dbTopics, ...cfgTopics];

  const rebuild = (el, items, current, label) => {
    el.innerHTML = `<option value="">${label}</option>`;
    items.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      if (v === current) opt.selected = true;
      el.appendChild(opt);
    });
  };

  rebuild(srcEl,   allSources, currentSource, 'All Sources');
  rebuild(topicEl, allTopics,  currentTopic,  'All Topics');
}

/* ── Clear all dashboard filters ─────────────────── */
window.clearDashboardFilters = function () {
  const s = document.getElementById('dash-filter-source');
  const t = document.getElementById('dash-filter-topic');
  if (s) s.value = '';
  if (t) t.value = '';
  loadDashboardData();
};

/* ── Chart 1: Messages per day (area line) ─────── */
function renderDailyChart(perDay, days) {
  destroyChart('daily');
  const ctx = document.getElementById('chart-daily');
  if (!ctx) return;

  const filled = fillDays(perDay, days);
  const labels = filled.map(d => d.day.slice(5));   // MM-DD
  const values = filled.map(d => d.count);

  _ch['daily'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Messages',
        data: values,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.08)',
        pointBackgroundColor: '#3b82f6',
        pointRadius: 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.35,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: TOOLTIP },
      scales: {
        x: { grid: GRID, ticks: TICKS },
        y: { grid: GRID, ticks: TICKS, beginAtZero: true },
      },
    },
  });
}

/* ── Chart 2: Topic distribution (doughnut) ─────── */
function renderTopicsDonut(perTopic) {
  destroyChart('topics');
  const ctx = document.getElementById('chart-topics');
  if (!ctx || !perTopic.length) return;

  const top = perTopic.slice(0, 10);
  _ch['topics'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: top.map(t => t.topic),
      datasets: [{
        data: top.map(t => t.count),
        backgroundColor: PALETTE.slice(0, top.length),
        borderColor: '#13161f',
        borderWidth: 2,
        hoverBorderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#94a3b8', font: { size: 10 }, padding: 8, boxWidth: 10 },
        },
        tooltip: TOOLTIP,
      },
    },
  });
}

/* ── Chart 3: Top sources (horizontal bar) ──────── */
function renderSourcesBar(perSource) {
  destroyChart('sources');
  const ctx = document.getElementById('chart-sources');
  if (!ctx || !perSource.length) return;

  const top = perSource.slice(0, 15);
  _ch['sources'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(s => s.source),
      datasets: [{
        label: 'Messages',
        data: top.map(s => s.count),
        backgroundColor: 'rgba(59,130,246,0.65)',
        borderColor: '#3b82f6',
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: TOOLTIP },
      scales: {
        x: { grid: GRID, ticks: TICKS, beginAtZero: true },
        y: { grid: { display: false }, ticks: { ...TICKS, font: { size: 10 } } },
      },
    },
  });
}

/* ── Chart 4: Topic trend (multi-line) ──────────── */
function renderTrendChart(trendData, perTopic) {
  destroyChart('trend');
  const ctx = document.getElementById('chart-trend');
  if (!ctx || !trendData.length) return;

  const allDays    = [...new Set(trendData.map(d => d.day))].sort();
  const labels     = allDays.map(d => d.slice(5));
  const topTopics  = perTopic.slice(0, 6).map(t => t.topic);

  const datasets = topTopics.map((topic, i) => {
    const dayMap = {};
    trendData.filter(d => d.topic === topic).forEach(d => { dayMap[d.day] = d.count; });
    return {
      label: topic,
      data: allDays.map(d => dayMap[d] || 0),
      borderColor: PALETTE[i],
      backgroundColor: PALETTE[i] + '18',
      pointRadius: 2,
      pointHoverRadius: 4,
      fill: false,
      tension: 0.3,
      borderWidth: 1.8,
    };
  });

  _ch['trend'] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#94a3b8', font: { size: 10 }, padding: 10, boxWidth: 10 },
        },
        tooltip: { ...TOOLTIP, mode: 'index', intersect: false },
      },
      scales: {
        x: { grid: GRID, ticks: TICKS },
        y: { grid: GRID, ticks: TICKS, beginAtZero: true },
      },
    },
  });
}

/* ── Source × Topic heatmap table ───────────────── */
function renderSourceMatrix(breakdown, perTopic) {
  const container = document.getElementById('dash-matrix');
  if (!container) return;

  if (!breakdown.length) {
    container.innerHTML = '<p class="mon-empty">No data for this period.</p>';
    return;
  }

  // Unique ordered topics (column headers) — same order as perTopic ranking
  const topicOrder = perTopic.slice(0, 10).map(t => t.topic);
  const topics = topicOrder.filter(t => breakdown.some(r => r.topic === t));

  // Unique sources (row headers)
  const sources = [...new Set(breakdown.map(r => r.source))];

  // Lookup: "source|topic" -> count
  const lut = {};
  breakdown.forEach(r => { lut[`${r.source}|${r.topic}`] = r.count; });

  // Max for heat scaling
  const maxVal = Math.max(...breakdown.map(r => r.count), 1);

  let html = '<table class="dash-matrix-table" id="source-matrix-tbl"><thead><tr>';
  html += '<th>Source</th>';
  topics.forEach(t => { html += `<th title="${t}">${t}</th>`; });
  html += '<th>Total</th></tr></thead><tbody>';

  sources.forEach(src => {
    const rowTotal = topics.reduce((s, t) => s + (lut[`${src}|${t}`] || 0), 0);
    if (rowTotal === 0) return;

    html += `<tr data-source="${src}"><td class="dash-matrix-src" title="${src}">${src}</td>`;
    topics.forEach(t => {
      const val   = lut[`${src}|${t}`] || 0;
      const alpha = val > 0 ? (val / maxVal * 0.55).toFixed(2) : '0';
      const style = val > 0 ? `background:rgba(59,130,246,${alpha})` : '';
      html += `<td class="dash-matrix-cell" style="${style}">${val > 0 ? val : '<span style="opacity:.2">—</span>'}</td>`;
    });
    html += `<td class="dash-matrix-total">${fmt(rowTotal)}</td></tr>`;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

/* ── Source filter ────────────────────────────────── */
window.filterSourceMatrix = function () {
  const q = (document.getElementById('dash-src-filter')?.value || '').toLowerCase();
  document.querySelectorAll('#source-matrix-tbl tbody tr').forEach(row => {
    row.style.display = (row.dataset.source || '').toLowerCase().includes(q) ? '' : 'none';
  });
};
