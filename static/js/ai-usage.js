/* AI Usage page — Gemini quota, per-summary token breakdown, hourly activity */

let _aiUsageTimer = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function _aiuFmtNum(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function _aiuPctClass(pct) {
    if (pct >= 85) return 'danger';
    if (pct >= 60) return 'warn';
    return 'ok';
}

function _aiuMeterHtml(label, used, limit) {
    const pct    = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const cls    = _aiuPctClass(pct);
    const pctStr = pct.toFixed(1) + '%';
    return `
    <div class="aiu-meter">
        <div class="aiu-meter-label">
            <span>${label}</span>
            <span class="aiu-meter-vals">${_aiuFmtNum(used)} / ${_aiuFmtNum(limit)}</span>
        </div>
        <div class="aiu-bar-track">
            <div class="aiu-bar-fill aiu-bar-${cls}" style="width:${pctStr}"></div>
        </div>
        <div class="aiu-bar-pct">${pctStr}</div>
    </div>`;
}

function _aiuRelTime(iso) {
    if (!iso) return '—';
    const norm = iso.endsWith('Z') ? iso : iso + 'Z';
    const diff = Math.floor((Date.now() - new Date(norm).getTime()) / 1000);
    if (diff < 60)    return diff + 's ago';
    if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
}

function _aiuFmtHour(isoHour) {
    if (!isoHour) return '—';
    const norm = isoHour.endsWith('Z') ? isoHour : isoHour + 'Z';
    const d  = new Date(norm);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${dd}/${mo} ${hh}:00`;
}

// ── Render meters block (used by initial load + poller) ────────────────────

function _aiuRenderMeters(live, limits) {
    const tpm = live.tpm || {};
    const rpm = live.rpm || {};
    const rpd = live.rpd || {};

    const meters = [
        { label: 'Tokens / min',    used: tpm.used || 0, limit: tpm.limit || limits.tpm || 2_000_000 },
        { label: 'Requests / min',  used: rpm.used || 0, limit: rpm.limit || limits.rpm || 30_000 },
        { label: 'Requests today',  used: rpd.used || 0, limit: rpd.limit || limits.rpd || 100_000 },
    ];

    const warnings = [];
    meters.forEach(m => {
        const pct = m.limit > 0 ? (m.used / m.limit) * 100 : 0;
        if (pct >= 85) warnings.push(`⚠ ${m.label} is at ${pct.toFixed(0)}% — consider pausing heavy schedules.`);
        else if (pct >= 60) warnings.push(`ℹ ${m.label} is at ${pct.toFixed(0)}%.`);
    });

    return {
        metersHtml:  meters.map(m => _aiuMeterHtml(m.label, m.used, m.limit)).join(''),
        warningHtml: warnings.length
            ? `<div data-aiu-warn class="aiu-warning">${warnings.join('<br>')}</div>`
            : '',
    };
}

// ── Main render ────────────────────────────────────────────────────────────

async function loadAiUsagePage() {
    const wrap = document.getElementById('ai-usage-content');
    if (!wrap) return;
    wrap.innerHTML = `<p class="mon-empty" style="padding:40px">Loading…</p>`;

    _stopAiUsagePoller();

    const d = await api('/api/system/ai-usage-details');
    if (!d || d.status !== 'ok') {
        wrap.innerHTML = `<p class="mon-empty" style="padding:40px">Failed to load AI usage data.</p>`;
        return;
    }

    const live   = d.live   || {};
    const limits = d.limits || {};
    const hourly = d.hourly || [];
    const recent = d.recent || [];

    // ── Live quota meters ─────────────────────────────────────────────────
    const { metersHtml, warningHtml } = _aiuRenderMeters(live, limits);

    // ── 24-hour totals ────────────────────────────────────────────────────
    const todaySummaries = hourly.reduce((s, r) => s + (r.summary_count || 0), 0);
    const todayTokens    = hourly.reduce((s, r) => s + (r.total_tokens  || 0), 0);
    const todayMsgs      = hourly.reduce((s, r) => s + (r.total_messages|| 0), 0);
    const avgTokens      = todaySummaries > 0 ? Math.round(todayTokens / todaySummaries) : 0;

    // ── Hourly rows ───────────────────────────────────────────────────────
    let hourlyRows = '';
    if (hourly.length === 0) {
        hourlyRows = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No summaries in last 24 hours</td></tr>`;
    } else {
        hourly.forEach(row => {
            const bots   = (row.bots   || []).map(b => `<span class="tag-blue">${escapeHtml(b)}</span>`).join(' ');
            const topics = (row.topics || []).map(t => `<span class="tag-green">${escapeHtml(t)}</span>`).join(' ');
            hourlyRows += `<tr>
                <td style="white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--text-muted);font-size:12px">${_aiuFmtHour(row.hour_utc)} UTC</td>
                <td style="text-align:center;font-weight:600">${row.summary_count}</td>
                <td style="text-align:center">${_aiuFmtNum(row.total_tokens || 0)}</td>
                <td>${bots   || '<span style="color:var(--text-muted)">—</span>'}</td>
                <td style="text-align:left">${topics|| '<span style="color:var(--text-muted)">—</span>'}</td>
            </tr>`;
        });
    }

    // ── Recent summaries rows ─────────────────────────────────────────────
    let recentRows = '';
    if (recent.length === 0) {
        recentRows = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">No summaries yet</td></tr>`;
    } else {
        recent.forEach(row => {
            const tokens   = row.tokens_used || 0;
            const tokStyle = tokens > 5000 ? 'color:#ef4444;font-weight:700'
                           : tokens > 2000 ? 'color:#f59e0b;font-weight:700'
                           :                 'font-weight:600';
            recentRows += `<tr>
                <td style="white-space:nowrap;color:var(--text-muted);font-size:12px">${_aiuRelTime(row.timestamp)}</td>
                <td><span class="tag-blue">${escapeHtml(row.bot_name || '—')}</span></td>
                <td><span class="tag-green">${escapeHtml(row.topic_name || '—')}</span></td>
                <td style="font-size:12px;color:var(--text-secondary)">${escapeHtml(row.summary_type || '—')}</td>
                <td style="text-align:center">${row.message_count || 0}</td>
                <td style="text-align:center;${tokStyle}">${tokens > 0 ? _aiuFmtNum(tokens) : '—'}</td>
                <td style="font-size:12px;color:var(--text-muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left" title="${escapeHtmlSys(row.target_entity || '')}">${escapeHtml(row.target_entity || '—')}</td>
            </tr>`;
        });
    }

    // ── Assemble page ─────────────────────────────────────────────────────
    wrap.innerHTML = `

    <!-- Section 1: Live quota -->
    <div class="card" style="margin-bottom:1.25rem">
        <div class="card-header" style="gap:.75rem">
            <span style="font-size:1.1rem">⚡</span>
            <strong>Live API Quota</strong>
            <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">Tier 1 · auto-refreshes every 15s</span>
            <button class="btn btn-secondary btn-sm" onclick="loadAiUsagePage()">↻ Refresh</button>
        </div>
        <div class="card-body" id="aiu-meters-body" style="display:flex;flex-wrap:wrap;gap:1.75rem 2.5rem">
            ${metersHtml}
        </div>
        ${warningHtml ? `<div id="aiu-warning-wrap" style="padding:.5rem 1.25rem .75rem;font-size:12px;color:var(--warning,#f59e0b);border-top:1px solid var(--border-color)">${warningHtml}</div>` : `<div id="aiu-warning-wrap"></div>`}
    </div>

    <!-- Section 2: 24h totals -->
    <div class="dash-stat-grid" style="margin-bottom:1.25rem">
        <div class="dash-stat-card">
            <div class="dash-stat-icon">📝</div>
            <div class="dash-stat-value">${todaySummaries}</div>
            <div class="dash-stat-label">Summaries sent (24h)</div>
        </div>
        <div class="dash-stat-card">
            <div class="dash-stat-icon">🔢</div>
            <div class="dash-stat-value">${_aiuFmtNum(todayTokens)}</div>
            <div class="dash-stat-label">Tokens used (24h)</div>
        </div>
        <div class="dash-stat-card">
            <div class="dash-stat-icon">📨</div>
            <div class="dash-stat-value">${todayMsgs}</div>
            <div class="dash-stat-label">Messages processed (24h)</div>
        </div>
        <div class="dash-stat-card">
            <div class="dash-stat-icon">📊</div>
            <div class="dash-stat-value">${avgTokens > 0 ? _aiuFmtNum(avgTokens) : '—'}</div>
            <div class="dash-stat-label">Avg tokens / summary</div>
        </div>
    </div>

    <!-- Section 3: Hourly activity -->
    <div class="card" style="margin-bottom:1.25rem">
        <div class="card-header">
            <strong>📅 Hourly Activity</strong>
            <span style="font-size:11px;color:var(--text-muted)">(last 24h · ${hourly.length} hour${hourly.length !== 1 ? 's' : ''} with activity)</span>
        </div>
        <div style="overflow-x:auto">
            <table class="yt-table">
                <thead><tr>
                    <th>Hour (UTC)</th>
                    <th style="text-align:center">Summaries</th>
                    <th style="text-align:center">Tokens</th>
                    <th>Bots</th>
                    <th style="text-align:left">Topics</th>
                </tr></thead>
                <tbody>${hourlyRows}</tbody>
            </table>
        </div>
    </div>

    <!-- Section 4: Recent summaries -->
    <div class="card">
        <div class="card-header">
            <strong>🕐 Recent Summaries</strong>
            <span style="font-size:11px;color:var(--text-muted)">(last 100)</span>
        </div>
        <div style="overflow-x:auto">
            <table class="yt-table">
                <thead><tr>
                    <th>When</th>
                    <th>Bot</th>
                    <th>Topic</th>
                    <th>Type</th>
                    <th style="text-align:center">Msgs</th>
                    <th style="text-align:center">Tokens</th>
                    <th style="text-align:left">Target</th>
                </tr></thead>
                <tbody>${recentRows}</tbody>
            </table>
        </div>
    </div>`;

    _startAiUsagePoller();
}

// ── Poller — refreshes only the live meters card ───────────────────────────

function _startAiUsagePoller() {
    _stopAiUsagePoller();
    _aiUsageTimer = setInterval(async () => {
        const metersBody = document.getElementById('aiu-meters-body');
        if (!metersBody) { _stopAiUsagePoller(); return; }
        const d = await api('/api/system/ai-usage-details');
        if (!d || d.status !== 'ok') return;
        const { metersHtml, warningHtml } = _aiuRenderMeters(d.live || {}, d.limits || {});
        metersBody.innerHTML = metersHtml;
        const warningWrap = document.getElementById('aiu-warning-wrap');
        if (warningWrap) warningWrap.innerHTML = warningHtml
            ? `<div class="aiu-warning">${warningHtml}</div>`
            : '';
    }, 15_000);
}

function _stopAiUsagePoller() {
    clearInterval(_aiUsageTimer);
    _aiUsageTimer = null;
}
