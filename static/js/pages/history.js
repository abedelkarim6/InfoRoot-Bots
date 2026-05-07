// ==================== Schedule History Tab ====================
(function () {
    (function _injectHistStyles() {
        const s = document.createElement('style');
        s.textContent = `
            .hist-table { width:100%; border-collapse:collapse; font-size:12.5px; }
            .hist-table th { background:var(--bg-tertiary); color:var(--text-secondary);
                font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
                padding:8px 12px; text-align:left; position:sticky; top:0; z-index:1;
                border-bottom:1px solid var(--border-color); }
            .hist-table td { padding:6px 12px; border-bottom:1px solid var(--border-color); vertical-align:middle; }
            .hist-table tr:last-child td { border-bottom:none; }
            .hist-table tr:hover td { background:var(--bg-tertiary); }
            .hist-row-failed td { background:rgba(239,68,68,.04); }
            .hist-time { white-space:nowrap; color:var(--text-muted); font-size:11.5px; }
            .hist-badge-ok   { display:inline-block; font-size:11px; font-weight:700; padding:2px 8px;
                border-radius:20px; background:rgba(16,185,129,.15); color:#6ee7b7; }
            .hist-badge-fail { display:inline-block; font-size:11px; font-weight:700; padding:2px 8px;
                border-radius:20px; background:rgba(239,68,68,.15); color:#fca5a5; }
            .hist-prompt-link { cursor:pointer; font-size:11.5px; color:var(--accent,#7c6af7);
                text-decoration:underline; text-underline-offset:2px; white-space:nowrap; }
            .hist-prompt-link:hover { opacity:.75; }
        `;
        document.head.appendChild(s);
    })();

    let _historyRuns = [];
    let _histMsgData = [];

    async function loadScheduleHistory() {
        const wrap = document.getElementById('mon-history-content');
        if (!wrap) return;
        wrap.innerHTML = '<p class="mon-empty">Loading…</p>';

        const data = await api('/api/monitor/schedule-history?limit=200');
        if (data.status !== 'ok') {
            wrap.innerHTML = `<p class="mon-empty">Error: ${escapeHtml(data.message || '')}</p>`;
            return;
        }
        _historyRuns = data.runs || [];
        _populateHistoryFilters(_historyRuns);
        _reRenderHistory();
    }

    function _reRenderHistory() {
        const selBots   = getMonMsValues('hist-filter-bot-wrap');
        const selTopics = getMonMsValues('hist-filter-topic-wrap');
        const selStatus = getMonMsValues('hist-filter-status-wrap');
        let runs = _historyRuns;
        if (selBots.size   > 0) runs = runs.filter(r => selBots.has(r.bot_name   || ''));
        if (selTopics.size > 0) runs = runs.filter(r => selTopics.has(r.topic_name || ''));
        if (selStatus.size > 0) runs = runs.filter(r => selStatus.has(r.status    || ''));
        _renderScheduleHistory(runs);
    }

    function _populateHistoryFilters(runs) {
        const bots     = [...new Set(runs.map(r => r.bot_name).filter(Boolean))].sort();
        const topics   = [...new Set(runs.map(r => r.topic_name).filter(Boolean))].sort();
        const statuses = [...new Set(runs.map(r => r.status).filter(Boolean))].sort();
        populateMonMultiSelect('hist-filter-bot-wrap',    bots);
        populateMonMultiSelect('hist-filter-topic-wrap',  topics);
        populateMonMultiSelect('hist-filter-status-wrap', statuses);
    }

    function _renderScheduleHistory(runs) {
        const wrap = document.getElementById('mon-history-content');
        if (!runs.length) {
            wrap.innerHTML = '<p class="mon-empty" style="padding:24px">No schedule runs recorded yet.</p>';
            return;
        }
        const rows = runs.map(r => {
            const isOk     = r.status === 'success';
            const rowCls   = isOk ? '' : 'hist-row-failed';
            const statusEl = isOk
                ? '<span class="hist-badge-ok">✓ Success</span>'
                : '<span class="hist-badge-fail">✗ Failed</span>';
            const typeCls  = r.schedule_type || '';
            const errorBtn = (!isOk && r.error_text)
                ? `<button class="btn btn-sm" style="font-size:11px;padding:2px 8px;"
                      onclick="showHistError(this)"
                      data-err="${escapeHtmlSys(r.error_text)}">View Error</button>`
                : '—';
            const timeStr    = _fmtLBN(r.fired_at);
            const msgsCell   = r.summary_id
                ? `<span class="mon-msgs-link" onclick="showHistoryMessages(${r.summary_id})">${r.message_count || 0}</span>`
                : (r.message_count || 0);
            const summaryCell = r.summary_text
                ? `<button class="btn btn-sm" style="font-size:11px;padding:2px 8px;"
                       onclick="showHistSummary(this)" data-text="${escapeHtmlSys(r.summary_text)}">View</button>`
                : '<span style="color:var(--text-muted)">—</span>';
            const targetCell = r.target_entities
                ? escapeHtml(r.target_entities)
                : '<span style="color:var(--text-muted)">—</span>';
            return `<tr class="${rowCls}">
                <td class="hist-time">${escapeHtml(timeStr)}</td>
                <td>${escapeHtml(r.bot_name   || '—')}</td>
                <td>${escapeHtml(r.topic_name || '—')}</td>
                <td><span class="mon-type-badge ${typeCls}">${escapeHtml(r.schedule_type || '—')}</span></td>
                <td>${statusEl}</td>
                <td style="text-align:center">${msgsCell}</td>
                <td>${summaryCell}</td>
                <td style="font-size:11px;max-width:160px;word-break:break-all;">${targetCell}</td>
                <td>${errorBtn}</td>
            </tr>`;
        }).join('');
        wrap.innerHTML = `<div style="overflow-x:auto;max-height:70vh;overflow-y:auto;">
            <table class="hist-table">
                <thead><tr>
                    <th>Time</th><th>Bot</th><th>Topic</th><th>Type</th>
                    <th>Status</th><th>Msgs</th><th>Summary</th><th>Target</th><th>Error</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    function showHistSummary(btn) {
        const text = btn.getAttribute('data-text') || '';
        showAlert(
            `<div style="direction:rtl;text-align:right;white-space:pre-wrap;
                         max-height:420px;overflow-y:auto;font-size:13px;
                         line-height:1.7;padding:4px 2px;">${escapeHtml(text)}</div>`,
            { title: 'Summary Output', icon: '📄' }
        );
    }

    function showHistError(btn) {
        const err = btn.getAttribute('data-err') || '(no error text)';

        let label   = 'Schedule Error';
        let isKnown = false;

        if (/429|resource.?exhausted/i.test(err)) {
            label   = '429 Resource Exhausted — AI quota limit reached';
            isKnown = true;
        } else if (/499|cancelled/i.test(err)) {
            label   = '499 Cancelled — the AI request was cancelled';
            isKnown = true;
        } else if (/500|internal/i.test(err)) {
            label   = '500 Internal Server Error';
            isKnown = true;
        } else if (/503|unavailable/i.test(err)) {
            label   = '503 Service Unavailable — AI backend is down';
            isKnown = true;
        } else if (/less than min_msgs/i.test(err)) {
            label   = 'Not enough messages — below minimum threshold';
            isKnown = true;
        }

        const safeErr   = escapeHtml(err);
        const safeLabel = escapeHtml(label);

        const html = `
            <div style="font-weight:600;color:var(--danger);margin-bottom:10px;">${safeLabel}</div>
            ${isKnown ? `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">
                ${/429|exhausted/i.test(err)
                    ? 'The AI API rate limit was hit. The next scheduled run should succeed automatically once the quota resets.'
                    : /499|cancel/i.test(err)
                    ? 'The request was cancelled before the AI could respond — usually a timeout or network interruption. The next run will retry.'
                    : /less than min_msgs/i.test(err)
                    ? 'The number of messages collected in the time window was below the bot\'s configured minimum_messages — no summary was generated.'
                    : 'An error occurred with the AI backend.'}
            </p>` : ''}
            <details style="margin-top:8px;">
                <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none;">Show technical details</summary>
                <pre style="margin-top:8px;font-size:11px;background:var(--bg-secondary,#f5f5f5);padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow-y:auto;">${safeErr}</pre>
            </details>`;

        showAlert(html, { title: 'Schedule Run Error', icon: '⚠️' });
    }

    // ── History Source Messages — composition view ─────────────────────────────

    async function showHistoryMessages(summaryId) {
        _histMsgData = [];
        const panel  = document.getElementById('mon-tab-history');
        panel.innerHTML = `
            <div class="sum-msg-page">
                <div class="sum-msg-page-header">
                    <button class="btn btn-secondary btn-sm" onclick="_closeHistoryMessages()">‹ Back to History</button>
                    <h3 style="margin:0;font-size:15px">Summary Composition</h3>
                </div>
                <div id="hmsg-comp-wrap"><p class="mon-empty">Loading…</p></div>
            </div>`;

        const data = await api(`/api/monitor/summary-composition?id=${summaryId}`);
        const wrap = document.getElementById('hmsg-comp-wrap');
        if (!wrap) return;

        if (data.status !== 'ok') {
            wrap.innerHTML = `<p class="mon-empty" style="color:var(--danger)">${escapeHtml(data.message || 'Error loading composition.')}</p>`;
            return;
        }

        const interims   = data.interims           || [];
        const remaining  = data.remaining_messages || [];

        if (!interims.length && !remaining.length) {
            wrap.innerHTML = `<p class="mon-empty">No linked messages found.</p>`;
            return;
        }

        let html = '';
        const lastInterimIdx = interims.length - 1;
        interims.forEach((interim, idx) => {
            const num      = interim.interim_number ?? (idx + 1);
            const msgCnt   = interim.message_count  ?? (interim.messages?.length ?? 0);
            const ts       = interim.created_at ? _fmtLBN(interim.created_at) : '—';
            const output   = escapeHtml(interim.summary_text || '');
            const msgsHtml = _buildCompMsgsTable(interim.messages || []);
            const domId    = `hcomp-interim-${summaryId}-${idx}`;
            const isLast   = idx === lastInterimIdx;

            const bodyDisplay  = isLast ? '' : 'none';
            const chevRotation = isLast ? '' : 'rotate(-90deg)';

            const usedBadge = isLast
                ? `<span style="background:rgba(16,185,129,.15);color:#10b981;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap">▶ Used in final</span>`
                : `<span style="font-size:11px;color:var(--text-muted)">(rolled into #${num + 1})</span>`;

            const outputLabel = isLast
                ? `<div style="font-size:11px;font-weight:600;color:#10b981;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">Rolling Output (cumulative — used in final summary)</div>`
                : `<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">Rolling Output (rolled into next interim)</div>`;

            html += `
            <div class="sum-comp-card" style="margin-bottom:10px;border:1px solid ${isLast ? '#10b981' : 'var(--border-color)'};border-radius:8px;overflow:hidden">
                <div class="sum-comp-card-header" style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--bg-secondary);cursor:pointer;user-select:none"
                     onclick="_toggleCompCard('${domId}')">
                    <span style="font-weight:700;font-size:13px;color:var(--accent-primary)">Interim #${num}</span>
                    <span style="font-size:12px;color:var(--text-muted)">${msgCnt} new message${msgCnt !== 1 ? 's' : ''}</span>
                    ${usedBadge}
                    <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${ts}</span>
                    <span class="sum-comp-chevron" id="${domId}-chev" style="font-size:12px;color:var(--text-muted);transition:transform .2s;transform:${chevRotation}">▼</span>
                </div>
                <div id="${domId}" style="padding:12px 14px;display:${bodyDisplay}">
                    ${outputLabel}
                    <div style="white-space:pre-wrap;font-size:13px;background:var(--bg-tertiary);border-radius:6px;padding:10px 12px;border:1px solid var(--border-color);margin-bottom:10px;max-height:200px;overflow-y:auto">${output}</div>
                    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">New Source Messages (${msgCnt})</div>
                    ${msgsHtml}
                </div>
            </div>`;
        });

        if (remaining.length) {
            const remHtml = _buildCompMsgsTable(remaining);
            html += `
            <div style="margin-top:4px">
                <div style="font-size:12px;font-weight:600;color:var(--text-secondary);padding:6px 0;border-top:1px solid var(--border-color);margin-bottom:8px">
                    Remaining Messages (${remaining.length}) — not yet batched into an interim
                </div>
                ${remHtml}
            </div>`;
        }

        wrap.innerHTML = html;
    }

    function _buildCompMsgsTable(messages) {
        if (!messages.length) return `<p class="mon-empty" style="padding:4px 0;font-size:12px">No messages.</p>`;
        const rows = messages.map(m => {
            const ts  = _fmtLBN(m.timestamp);
            const src = m.channel_username ? `@${escapeHtml(m.channel_username)}` : '—';
            const top = m.topics          ? escapeHtml(m.topics)          : '—';
            const kw  = m.keywords_found  ? escapeHtml(m.keywords_found)  : '—';
            const txt = escapeHtml(m.preview || '');
            return `<tr>
                <td style="white-space:nowrap;font-size:11px">${ts}</td>
                <td>${src}</td>
                <td>${top}</td>
                <td>${kw}</td>
                <td class="smp-msg-cell" title="${txt}">${txt}</td>
            </tr>`;
        }).join('');
        return `<div style="overflow-x:auto"><table class="mon-table smp-table" style="font-size:12px">
            <thead><tr><th>Date / Time</th><th>Source</th><th>Topics</th><th>Keywords</th><th>Message</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
    }

    function _toggleCompCard(id) {
        const body = document.getElementById(id);
        const chev = document.getElementById(id + '-chev');
        if (!body) return;
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        if (chev) chev.style.transform = collapsed ? '' : 'rotate(-90deg)';
    }

    function _closeHistoryMessages() {
        _histMsgData = [];
        const panel  = document.getElementById('mon-tab-history');
        if (panel) {
            panel.innerHTML = `
                <div class="mon-filter-bar">
                    <div class="mon-multi-select" id="hist-filter-bot-wrap" data-onchange="_reRenderHistory" data-label="All Bots">
                        <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('hist-filter-bot-wrap')">All Bots <span class="mon-ms-arrow">▾</span></button>
                        <div class="mon-ms-dropdown" id="hist-filter-bot-dd"></div>
                    </div>
                    <div class="mon-multi-select" id="hist-filter-topic-wrap" data-onchange="_reRenderHistory" data-label="All Topics">
                        <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('hist-filter-topic-wrap')">All Topics <span class="mon-ms-arrow">▾</span></button>
                        <div class="mon-ms-dropdown" id="hist-filter-topic-dd"></div>
                    </div>
                    <div class="mon-multi-select" id="hist-filter-status-wrap" data-onchange="_reRenderHistory" data-label="All Statuses">
                        <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('hist-filter-status-wrap')">All Statuses <span class="mon-ms-arrow">▾</span></button>
                        <div class="mon-ms-dropdown" id="hist-filter-status-dd"></div>
                    </div>
                </div>
                <div id="mon-history-content"><p class="mon-empty">Loading…</p></div>`;
        }
        loadScheduleHistory();
    }

    // ── Exports ────────────────────────────────────────────────────────────────
    window._isHistoryEmpty      = () => _historyRuns.length === 0;
    window._getHistoryRuns      = () => _historyRuns;
    window._getHistMsgData      = () => _histMsgData;
    window.loadScheduleHistory  = loadScheduleHistory;
    window._reRenderHistory     = _reRenderHistory;
    window.showHistoryMessages  = showHistoryMessages;
    window.showHistSummary      = showHistSummary;
    window.showHistError        = showHistError;
    window._closeHistoryMessages = _closeHistoryMessages;
    window._toggleCompCard      = _toggleCompCard;
})();
