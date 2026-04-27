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

/* ── Multi-select filter state ──────────────────────── */
let _dashFilterSources  = new Set();
let _dashFilterTopics   = new Set();
let _dashFilterChannels = new Set();

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
  const days           = document.getElementById('dash-range')?.value || 14;
  const filterSources  = [..._dashFilterSources];
  const filterTopics   = [..._dashFilterTopics];
  const filterChannels = [..._dashFilterChannels];

  // Show loading state in stat cards
  ['ds-total-msgs', 'ds-period-msgs', 'ds-summaries', 'ds-sources'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  });

  let url = `/api/dashboard/stats?days=${days}`;
  if (filterSources.length)  url += `&filter_source=${encodeURIComponent(filterSources.join(','))}`;
  if (filterTopics.length)   url += `&filter_topic=${encodeURIComponent(filterTopics.join(','))}`;
  if (filterChannels.length) url += `&filter_channels=${encodeURIComponent(filterChannels.join(','))}`;

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

  /* ── Populate filter dropdowns (preserves Set state) ─ */
  populateDashboardFilters(data);

  /* ── Show/hide the clear-filters button ─────────── */
  const clearBtn = document.getElementById('dash-filter-clear-btn');
  if (clearBtn) clearBtn.style.display = (_dashFilterSources.size || _dashFilterTopics.size || _dashFilterChannels.size) ? '' : 'none';

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

  /* ── Subscribed Channels ────────────────────────── */
  renderDashChannels();
};

/* ── Populate source, topic, and channel dropdowns ──── */
function populateDashboardFilters(data) {
  // Sources: DB list + any configured channels not yet seen in DB
  const dbSources = data.all_sources || [];
  const cfgSources = [];
  if (window.globalConfig) {
    for (const coll of Object.values(window.globalConfig.collections || {})) {
      for (const ch of (coll.source_channels || [])) {
        const clean = ch.replace(/^@/, '');
        if (!dbSources.includes(ch) && !dbSources.includes(clean)) cfgSources.push(ch);
      }
    }
  }
  const allSources = [...dbSources, ...cfgSources];

  // Topics: DB list + config-defined topics
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

  _buildDashSourceDropdown(allSources);
  _buildDashTopicDropdown(allTopics);
  _buildDashChannelDropdown(allSources);
}

/* ── Source multi-select ─────────────────────────── */
function _buildDashSourceDropdown(sources) {
  const dd = document.getElementById('dash-source-ms-dd');
  if (!dd) return;
  dd.innerHTML =
    `<label class="mon-ms-item all-item">
       <input type="checkbox" onchange="dashSourceToggleAll(this)" ${_dashFilterSources.size === 0 ? 'checked' : ''}> All Sources
     </label>` +
    sources.map(s =>
      `<label class="mon-ms-item">
         <input type="checkbox" value="${escapeHtmlSys(s)}" onchange="dashSourceToggle(this)" ${_dashFilterSources.has(s) ? 'checked' : ''}>
         ${escapeHtml(s)}
       </label>`
    ).join('');
  _updateDashSourceBtnLabel();
}

function _updateDashSourceBtnLabel() {
  const btn = document.querySelector('#dash-source-ms-wrap .mon-ms-btn');
  if (!btn) return;
  const arrow = '<span class="mon-ms-arrow">▾</span>';
  if (_dashFilterSources.size === 0) {
    btn.innerHTML = `All Sources ${arrow}`;
  } else if (_dashFilterSources.size <= 2) {
    btn.innerHTML = `${[..._dashFilterSources].join(', ')} ${arrow}`;
  } else {
    btn.innerHTML = `${_dashFilterSources.size} sources ${arrow}`;
  }
}

window.toggleDashSourcePicker = function () {
  const wrap = document.getElementById('dash-source-ms-wrap');
  if (!wrap) return;
  const opening = !wrap.classList.contains('open');
  document.querySelectorAll('.mon-multi-select.open').forEach(el => el.classList.remove('open'));
  if (opening) wrap.classList.add('open');
};

window.dashSourceToggleAll = function (cb) {
  _dashFilterSources.clear();
  const dd = document.getElementById('dash-source-ms-dd');
  if (dd) dd.querySelectorAll('input[value]').forEach(el => { el.checked = false; });
  cb.checked = true;
  _updateDashSourceBtnLabel();
  loadDashboardData();
};

window.dashSourceToggle = function (cb) {
  if (cb.checked) _dashFilterSources.add(cb.value);
  else _dashFilterSources.delete(cb.value);
  const dd = document.getElementById('dash-source-ms-dd');
  if (dd) {
    const allCb = dd.querySelector('.all-item input');
    if (allCb) allCb.checked = _dashFilterSources.size === 0;
  }
  _updateDashSourceBtnLabel();
  loadDashboardData();
};

/* ── Topic multi-select ──────────────────────────── */
function _buildDashTopicDropdown(topics) {
  const dd = document.getElementById('dash-topic-ms-dd');
  if (!dd) return;
  dd.innerHTML =
    `<label class="mon-ms-item all-item">
       <input type="checkbox" onchange="dashTopicToggleAll(this)" ${_dashFilterTopics.size === 0 ? 'checked' : ''}> All Topics
     </label>` +
    topics.map(t =>
      `<label class="mon-ms-item">
         <input type="checkbox" value="${escapeHtmlSys(t)}" onchange="dashTopicToggle(this)" ${_dashFilterTopics.has(t) ? 'checked' : ''}>
         ${escapeHtml(t)}
       </label>`
    ).join('');
  _updateDashTopicBtnLabel();
}

function _updateDashTopicBtnLabel() {
  const btn = document.querySelector('#dash-topic-ms-wrap .mon-ms-btn');
  if (!btn) return;
  const arrow = '<span class="mon-ms-arrow">▾</span>';
  if (_dashFilterTopics.size === 0) {
    btn.innerHTML = `All Topics ${arrow}`;
  } else if (_dashFilterTopics.size <= 2) {
    btn.innerHTML = `${[..._dashFilterTopics].join(', ')} ${arrow}`;
  } else {
    btn.innerHTML = `${_dashFilterTopics.size} topics ${arrow}`;
  }
}

window.toggleDashTopicPicker = function () {
  const wrap = document.getElementById('dash-topic-ms-wrap');
  if (!wrap) return;
  const opening = !wrap.classList.contains('open');
  document.querySelectorAll('.mon-multi-select.open').forEach(el => el.classList.remove('open'));
  if (opening) wrap.classList.add('open');
};

window.dashTopicToggleAll = function (cb) {
  _dashFilterTopics.clear();
  const dd = document.getElementById('dash-topic-ms-dd');
  if (dd) dd.querySelectorAll('input[value]').forEach(el => { el.checked = false; });
  cb.checked = true;
  _updateDashTopicBtnLabel();
  loadDashboardData();
};

window.dashTopicToggle = function (cb) {
  if (cb.checked) _dashFilterTopics.add(cb.value);
  else _dashFilterTopics.delete(cb.value);
  const dd = document.getElementById('dash-topic-ms-dd');
  if (dd) {
    const allCb = dd.querySelector('.all-item input');
    if (allCb) allCb.checked = _dashFilterTopics.size === 0;
  }
  _updateDashTopicBtnLabel();
  loadDashboardData();
};

/* ── Channel multi-select ────────────────────────── */
function _buildDashChannelDropdown(channels) {
  const dd = document.getElementById('dash-channel-ms-dd');
  if (!dd) return;
  dd.innerHTML =
    `<label class="mon-ms-item all-item">
       <input type="checkbox" onchange="dashChannelToggleAll(this)" ${_dashFilterChannels.size === 0 ? 'checked' : ''}> All Channels
     </label>` +
    channels.map(ch =>
      `<label class="mon-ms-item">
         <input type="checkbox" value="${escapeHtmlSys(ch)}" onchange="dashChannelToggle(this)" ${_dashFilterChannels.has(ch) ? 'checked' : ''}>
         ${escapeHtml(ch)}
       </label>`
    ).join('');
  _updateDashChannelBtnLabel();
}

function _updateDashChannelBtnLabel() {
  const btn = document.querySelector('#dash-channel-ms-wrap .mon-ms-btn');
  if (!btn) return;
  const arrow = '<span class="mon-ms-arrow">▾</span>';
  if (_dashFilterChannels.size === 0) {
    btn.innerHTML = `All Channels ${arrow}`;
  } else if (_dashFilterChannels.size <= 2) {
    btn.innerHTML = `${[..._dashFilterChannels].join(', ')} ${arrow}`;
  } else {
    btn.innerHTML = `${_dashFilterChannels.size} channels ${arrow}`;
  }
}

window.toggleDashChannelPicker = function () {
  const wrap = document.getElementById('dash-channel-ms-wrap');
  if (!wrap) return;
  const opening = !wrap.classList.contains('open');
  document.querySelectorAll('.mon-multi-select.open').forEach(el => el.classList.remove('open'));
  if (opening) wrap.classList.add('open');
};

window.dashChannelToggleAll = function (cb) {
  _dashFilterChannels.clear();
  const dd = document.getElementById('dash-channel-ms-dd');
  if (dd) dd.querySelectorAll('input[value]').forEach(el => { el.checked = false; });
  cb.checked = true;
  _updateDashChannelBtnLabel();
  loadDashboardData();
};

window.dashChannelToggle = function (cb) {
  if (cb.checked) _dashFilterChannels.add(cb.value);
  else _dashFilterChannels.delete(cb.value);
  const dd = document.getElementById('dash-channel-ms-dd');
  if (dd) {
    const allCb = dd.querySelector('.all-item input');
    if (allCb) allCb.checked = _dashFilterChannels.size === 0;
  }
  _updateDashChannelBtnLabel();
  loadDashboardData();
};

/* ── Clear all dashboard filters ─────────────────── */
window.clearDashboardFilters = function () {
  _dashFilterSources.clear();
  _dashFilterTopics.clear();
  _dashFilterChannels.clear();
  ['dash-source-ms-dd', 'dash-topic-ms-dd', 'dash-channel-ms-dd'].forEach(id => {
    const dd = document.getElementById(id);
    if (!dd) return;
    dd.querySelectorAll('input[value]').forEach(el => { el.checked = false; });
    const allCb = dd.querySelector('.all-item input');
    if (allCb) allCb.checked = true;
  });
  _updateDashSourceBtnLabel();
  _updateDashTopicBtnLabel();
  _updateDashChannelBtnLabel();
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

/* ── Subscribed / Registered Channels card ─────────── */
function renderDashChannels() {
  // currentUser is declared in accounts.js (shared classic-script scope)
  const user    = typeof currentUser !== 'undefined' ? currentUser : null;
  const isAdmin = !user || user.role === 'admin';
  const chValCard = document.getElementById('ch-val-card');
  const userChDiv = document.getElementById('dash-user-channels');

  if (isAdmin) {
    if (chValCard) chValCard.style.display = '';
    if (userChDiv) userChDiv.innerHTML = '';
  } else {
    if (chValCard) chValCard.style.display = 'none';
    if (userChDiv) renderDashUserChannels(userChDiv);
  }
}

async function renderDashUserChannels(container) {
  container.innerHTML = `
    <div class="ch-val-card">
      <div class="ch-val-header">
        <div class="ch-val-title">
          <span style="font-size:20px">📡</span>
          <h3 style="margin:0">Subscribed Channels</h3>
        </div>
      </div>
      <div class="ch-val-body" style="display:block;padding:12px 16px">
        <p class="text-muted" style="font-size:13px;margin:0">Loading…</p>
      </div>
    </div>`;

  const token = localStorage.getItem('auth_token');
  let data;
  try {
    const r = await fetch('/api/telegram/userbot/dialogs', {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    });
    data = await r.json();
  } catch (e) {
    data = {};
  }

  if (data.status !== 'ok' || !data.channels?.length) {
    container.innerHTML = `
      <div class="ch-val-card">
        <div class="ch-val-header">
          <div class="ch-val-title">
            <span style="font-size:20px">📡</span>
            <h3 style="margin:0">Subscribed Channels</h3>
          </div>
        </div>
        <div class="ch-val-body" style="display:block;padding:12px 16px">
          <p class="text-muted" style="font-size:13px;margin:0">
            ${data.status === 'no_session' || data.status === 'unauthorized'
              ? 'No Telegram account linked. Link your account in Profile to see subscribed channels.'
              : 'No subscribed channels found.'}
          </p>
        </div>
      </div>`;
    return;
  }

  const channels = data.channels;
  const rows = channels.map(ch => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;
                background:var(--bg-secondary);font-size:12px;margin-bottom:4px">
      <span>${ch.is_group ? '👥' : '📢'}</span>
      <div style="flex:1;overflow:hidden">
        <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escapeHtmlSys(ch.title || ch.username || 'Unknown')}
        </div>
        ${ch.username ? `<div style="color:var(--text-muted)">@${escapeHtmlSys(ch.username)}</div>` : ''}
      </div>
    </div>`).join('');

  container.innerHTML = `
    <div class="ch-val-card">
      <div class="ch-val-header" onclick="this.parentElement.querySelector('.ch-val-body').style.display = this.parentElement.querySelector('.ch-val-body').style.display==='none'?'block':'none'; this.querySelector('.ch-dash-toggle').textContent = this.parentElement.querySelector('.ch-val-body').style.display==='none'?'▶':'▼'" style="cursor:pointer">
        <div class="ch-val-title">
          <span class="ch-dash-toggle">▼</span>
          <h3>📡 Subscribed Channels</h3>
          <span class="text-muted" style="font-size:0.8rem;margin-left:8px">${channels.length} channel${channels.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="ch-val-body" style="display:block">
        <div style="max-height:220px;overflow-y:auto">
          ${rows}
        </div>
        ${data.updated_at ? `<div style="font-size:10px;color:var(--text-muted);margin-top:6px">
          Last refreshed: ${new Date(data.updated_at).toLocaleString()}</div>` : ''}
      </div>
    </div>`;
}

/* ── Source filter ────────────────────────────────── */
window.filterSourceMatrix = function () {
  const q = (document.getElementById('dash-src-filter')?.value || '').toLowerCase();
  document.querySelectorAll('#source-matrix-tbl tbody tr').forEach(row => {
    row.style.display = (row.dataset.source || '').toLowerCase().includes(q) ? '' : 'none';
  });
};

/* ══ Gemini usage widget ══════════════════════════════════════════════ */
let _geminiUsageTimer = null;

function _pct(used, limit) { return limit > 0 ? Math.min(100, (used / limit) * 100) : 0; }
function _fmtK(n) { return n >= 1_000_000 ? (n/1_000_000).toFixed(2)+'M' : n >= 1_000 ? (n/1_000).toFixed(1)+'k' : String(n); }

function _setMeter(barId, valId, used, limit, warn, danger) {
    const pct = _pct(used, limit);
    const bar = document.getElementById(barId);
    const val = document.getElementById(valId);
    if (!bar || !val) return;
    bar.style.width = pct + '%';
    bar.style.background = pct >= danger ? 'var(--danger,#ef4444)'
        : pct >= warn ? 'var(--warning,#f59e0b)'
        : 'var(--success,#22c55e)';
    val.textContent = `${_fmtK(used)} / ${_fmtK(limit)} (${pct.toFixed(1)}%)`;
}

async function loadGeminiUsage() {
    try {
        const d = await api('/api/system/gemini-usage');
        if (d.status !== 'ok') return;
        _setMeter('gm-tpm-bar', 'gm-tpm-vals', d.tpm.used, d.tpm.limit, 60, 85);
        _setMeter('gm-rpm-bar', 'gm-rpm-vals', d.rpm.used, d.rpm.limit, 60, 85);
        _setMeter('gm-rpd-bar', 'gm-rpd-vals', d.rpd.used, d.rpd.limit, 70, 90);
        const tpmPct = _pct(d.tpm.used, d.tpm.limit);
        const rpmPct = _pct(d.rpm.used, d.rpm.limit);
        const w = document.getElementById('gemini-usage-warning');
        if (!w) return;
        const warnings = [];
        if (tpmPct >= 85) warnings.push(`⚠️ TPM at ${tpmPct.toFixed(0)}% — approaching Tier 1 limit (${_fmtK(d.tpm.limit)} tokens/min). Avoid scheduling more concurrent topics.`);
        else if (tpmPct >= 60) warnings.push(`⚡ TPM at ${tpmPct.toFixed(0)}% — moderate usage. New high-frequency schedules may push you over the limit.`);
        if (rpmPct >= 85) warnings.push(`⚠️ RPM at ${rpmPct.toFixed(0)}% — too many concurrent schedule fires.`);
        w.style.display = warnings.length ? '' : 'none';
        w.innerHTML = warnings.join('<br>');
    } catch (e) { /* silent */ }
}

window._startGeminiUsagePoller = function () {
    loadGeminiUsage();
    if (_geminiUsageTimer) clearInterval(_geminiUsageTimer);
    _geminiUsageTimer = setInterval(loadGeminiUsage, 15000);
};
window._stopGeminiUsagePoller = function () {
    if (_geminiUsageTimer) { clearInterval(_geminiUsageTimer); _geminiUsageTimer = null; }
};
