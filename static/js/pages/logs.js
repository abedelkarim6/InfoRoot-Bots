// ==================== Logs Page ====================
(function () {
    let _allLogs    = [];
    let _logsTimer  = null;
    let _logsLoaded = false;

    const _LOG_LEVEL_CLS = {
        ERROR:   'log-level-error',
        WARNING: 'log-level-warn',
        INFO:    'log-level-info',
        DEBUG:   'log-level-debug',
    };

    (function _injectLogStyles() {
        const s = document.createElement('style');
        s.textContent = `
            #logs-table-wrap table { width:100%; border-collapse:collapse; font-size:12.5px; }
            #logs-table-wrap th { background:var(--bg-tertiary); color:var(--text-secondary);
                font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
                padding:8px 12px; text-align:left; position:sticky; top:0; z-index:1;
                border-bottom:1px solid var(--border-color); }
            #logs-table-wrap td { padding:6px 12px; border-bottom:1px solid var(--border-color);
                vertical-align:top; }
            #logs-table-wrap tr:last-child td { border-bottom:none; }
            #logs-table-wrap tr:hover td { background:var(--bg-tertiary); }
            .log-time  { white-space:nowrap; color:var(--text-muted); font-size:11.5px; width:155px; }
            .log-name  { white-space:nowrap; color:var(--text-muted); font-size:11.5px; max-width:110px;
                         overflow:hidden; text-overflow:ellipsis; }
            .log-level { font-weight:700; font-size:11px; white-space:nowrap; }
            .log-msg   { word-break:break-word; color:var(--text-primary); }
            .log-level-error   { color:#ef4444; }
            .log-level-warn    { color:#f59e0b; }
            .log-level-info    { color:#3b82f6; }
            .log-level-debug   { color:var(--text-muted); }
            tr.log-row-error td { background:rgba(239,68,68,.04); }
            tr.log-row-warn  td { background:rgba(245,158,11,.04); }
            .log-tag { display:inline-block; font-weight:700; font-size:11px;
                       background:rgba(99,102,241,.12); color:var(--accent-primary,#6366f1);
                       border-radius:3px; padding:0 3px; margin-right:2px; font-family:monospace; }
        `;
        document.head.appendChild(s);
    })();

    async function loadLogsPage() {
        const wrap = document.getElementById('logs-table-wrap');
        if (!wrap) return;
        if (!_logsLoaded) wrap.innerHTML = '<p class="mon-empty" style="padding:24px">Loading…</p>';

        const level  = document.getElementById('log-filter-level')?.value || '';
        const search = document.getElementById('log-search')?.value.trim() || '';

        let url = '/api/logs?limit=500';
        if (level)  url += `&level=${encodeURIComponent(level)}`;
        if (search) url += `&search=${encodeURIComponent(search)}`;

        const data = await api(url);
        if (data.status !== 'ok') { wrap.innerHTML = `<p class="mon-empty" style="padding:24px">Error: ${escapeHtml(data.message||'')}</p>`; return; }

        _allLogs    = data.logs || [];
        _logsLoaded = true;
        _renderLogTable(_getTagFilteredLogs());
        _updateLogsErrorBadge();
        _scheduleLogAutoRefresh();
    }

    function _getTagFilteredLogs() {
        const tag = document.getElementById('log-filter-tag')?.value || '';
        if (!tag) return _allLogs;
        return _allLogs.filter(r => (r.message || '').includes(tag));
    }

    function _renderLogTable(logs) {
        const wrap = document.getElementById('logs-table-wrap');
        if (!wrap) return;
        if (!logs.length) {
            wrap.innerHTML = '<p class="mon-empty" style="padding:24px">No log records.</p>';
            return;
        }
        const rows = logs.map(r => {
            const lvlCls = _LOG_LEVEL_CLS[r.level] || '';
            const rowCls = r.level === 'ERROR' ? 'log-row-error' : r.level === 'WARNING' ? 'log-row-warn' : '';
            const msg = escapeHtml(r.message || '').replace(
                /(\[([A-Z][A-Z0-9_-]+)\])/g,
                '<span class="log-tag">$1</span>'
            );
            return `<tr class="${rowCls}">
                <td class="log-time">${escapeHtml(r.time || '')}</td>
                <td class="log-name" title="${escapeHtmlSys(r.name || '')}">${escapeHtml(r.name || '')}</td>
                <td class="log-level ${lvlCls}">${escapeHtml(r.level || '')}</td>
                <td class="log-msg">${msg}</td>
            </tr>`;
        }).join('');
        wrap.innerHTML = `<table>
            <thead><tr>
                <th>Time</th><th>Logger</th><th>Level</th><th>Message</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    }

    function applyLogFilters() {
        clearTimeout(_logsTimer);
        loadLogsPage();
    }

    function applyLogTagFilter() {
        _renderLogTable(_getTagFilteredLogs());
    }

    function toggleLogAutoRefresh() {
        _scheduleLogAutoRefresh();
    }

    function _scheduleLogAutoRefresh() {
        clearTimeout(_logsTimer);
        const el = document.getElementById('log-auto-refresh');
        if (el && el.checked && document.getElementById('logs-page')?.style.display !== 'none') {
            _logsTimer = setTimeout(loadLogsPage, 5000);
        }
    }

    function _updateLogsErrorBadge() {
        const badge = document.getElementById('logs-error-badge');
        if (!badge) return;
        const errCount = _allLogs.filter(r => r.level === 'ERROR').length;
        if (errCount > 0) {
            badge.textContent = errCount > 99 ? '99+' : errCount;
            badge.style.display = '';
        } else {
            badge.style.display = 'none';
        }
    }

    async function clearLogs() {
        showConfirm('Clear all log records from memory?', async () => {
            await api('/api/logs/clear', {});
            _allLogs = [];
            _logsLoaded = false;
            document.getElementById('logs-table-wrap').innerHTML = '<p class="mon-empty" style="padding:24px">Log buffer cleared.</p>';
            const badge = document.getElementById('logs-error-badge');
            if (badge) badge.style.display = 'none';
            showNotification('Log buffer cleared', 'success');
        });
    }

    function downloadLogs() {
        const lines = _allLogs.map(r => `${r.time} | ${r.level.padEnd(7)} | ${r.name} | ${r.message}`).join('\n');
        const blob  = new Blob(['﻿' + lines], { type: 'text/plain;charset=utf-8' });
        const a     = document.createElement('a');
        a.href      = URL.createObjectURL(blob);
        a.download  = `logs_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ── Tab switching ──────────────────────────────────────────────────────────

    let _logsActiveTab = 'system';

    function switchLogsTab(tab) {
        _logsActiveTab = tab;
        document.getElementById('logs-panel-system').style.display   = tab === 'system'   ? '' : 'none';
        document.getElementById('logs-panel-failures').style.display = tab === 'failures' ? '' : 'none';
        document.getElementById('logs-tab-system').classList.toggle('active',   tab === 'system');
        document.getElementById('logs-tab-failures').classList.toggle('active', tab === 'failures');
        if (tab === 'failures') loadSummaryFailures();
    }

    // ── Summary Failures Tab ───────────────────────────────────────────────────

    let _failuresKnownBots = [];

    function _fmtRateVal(v) {
        if (v === null || v === undefined) return '<span style="color:var(--text-muted)">—</span>';
        if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
        if (v >= 1000)    return (v / 1000).toFixed(1) + 'K';
        return String(v);
    }

    function _fmtFailTime(iso) {
        return _fmtLBN(iso);
    }

    async function loadSummaryFailures() {
        const wrap = document.getElementById('failures-table-wrap');
        if (!wrap) return;
        wrap.innerHTML = '<p class="mon-empty" style="padding:24px">Loading…</p>';

        const botFilter  = document.getElementById('fail-filter-bot')?.value  || '';
        const daysFilter = document.getElementById('fail-filter-days')?.value || '7';

        let url = '/api/monitor/schedule-history?status=failed&limit=500';
        if (botFilter) url += '&bot=' + encodeURIComponent(botFilter);

        const data = await api(url);
        if (!data || data.status !== 'ok') {
            wrap.innerHTML = '<p class="mon-empty" style="padding:24px">Failed to load failures.</p>';
            return;
        }

        let runs = data.runs || [];

        if (daysFilter && daysFilter !== '0') {
            const cutoff = Date.now() - parseInt(daysFilter) * 86400000;
            runs = runs.filter(r => {
                const t = r.fired_at
                    ? new Date(r.fired_at.endsWith('Z') ? r.fired_at : r.fired_at + 'Z').getTime()
                    : 0;
                return t >= cutoff;
            });
        }

        const botSel = document.getElementById('fail-filter-bot');
        if (botSel) {
            const bots = Object.keys(globalConfig.bots || {}).sort();
            _failuresKnownBots = bots;
            const prevVal = botSel.value;
            while (botSel.options.length > 1) botSel.remove(1);
            bots.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b; opt.textContent = b;
                botSel.appendChild(opt);
            });
            botSel.value = botFilter || prevVal;
        }

        const badge = document.getElementById('logs-failures-badge');
        if (badge) {
            badge.textContent = runs.length > 99 ? '99+' : runs.length;
            badge.style.display = runs.length > 0 ? '' : 'none';
        }

        if (!runs.length) {
            wrap.innerHTML = '<p class="mon-empty" style="padding:24px">No failures in this period.</p>';
            return;
        }

        const rows = runs.map(r => {
            const rpm = r.rpm_at_failure;
            const tpm = r.tpm_at_failure;
            const rpd = r.rpd_at_failure;

            const rpmHtml = (rpm != null)
                ? '<span style="' + (rpm > 25000 ? 'color:#ef4444;font-weight:700' : '') + '">' + _fmtRateVal(rpm) + '</span>'
                : _fmtRateVal(null);
            const tpmHtml = (tpm != null)
                ? '<span style="' + (tpm > 1700000 ? 'color:#ef4444;font-weight:700' : '') + '">' + _fmtRateVal(tpm) + '</span>'
                : _fmtRateVal(null);
            const rpdHtml = (rpd != null)
                ? '<span style="' + (rpd > 85000 ? 'color:#f59e0b;font-weight:700' : '') + '">' + _fmtRateVal(rpd) + '</span>'
                : _fmtRateVal(null);

            const errShort = (r.error_text || '').slice(0, 120);
            const errHtml  = r.error_text
                ? '<details style="cursor:pointer"><summary style="color:#ef4444;font-size:12px">' +
                  escapeHtml(errShort) + (r.error_text.length > 120 ? '…' : '') +
                  '</summary><pre style="white-space:pre-wrap;font-size:11px;margin-top:4px;color:var(--text-secondary)">' +
                  escapeHtmlSys(r.error_text) + '</pre></details>'
                : '<span style="color:var(--text-muted)">—</span>';

            return '<tr>' +
                '<td style="white-space:nowrap;font-size:12px;color:var(--text-muted)">' + escapeHtml(_fmtFailTime(r.fired_at)) + '</td>' +
                '<td><span class="tag-blue">'  + escapeHtml(r.bot_name   || '—') + '</span></td>' +
                '<td><span class="tag-green">' + escapeHtml(r.topic_name || '—') + '</span></td>' +
                '<td style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(r.schedule_type || '—') + '</td>' +
                '<td style="text-align:center;font-size:12px">' + rpmHtml + '</td>' +
                '<td style="text-align:center;font-size:12px">' + tpmHtml + '</td>' +
                '<td style="text-align:center;font-size:12px">' + rpdHtml + '</td>' +
                '<td style="min-width:220px;text-align:left">'  + errHtml + '</td>' +
                '</tr>';
        }).join('');

        wrap.innerHTML =
            '<table class="yt-table">' +
            '<thead><tr>' +
            '<th>Time</th><th>Bot</th><th>Topic</th><th>Type</th>' +
            '<th style="text-align:center">RPM</th>' +
            '<th style="text-align:center">TPM</th>' +
            '<th style="text-align:center">RPD today</th>' +
            '<th style="text-align:left">Error</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody></table>';
    }

    // ── Exports ────────────────────────────────────────────────────────────────
    window.loadLogsPage         = loadLogsPage;
    window.applyLogFilters      = applyLogFilters;
    window.applyLogTagFilter    = applyLogTagFilter;
    window.toggleLogAutoRefresh = toggleLogAutoRefresh;
    window.clearLogs            = clearLogs;
    window.downloadLogs         = downloadLogs;
    window.switchLogsTab        = switchLogsTab;
    window.loadSummaryFailures  = loadSummaryFailures;
    window._resetLogsState      = function () {
        clearTimeout(_logsTimer);
        _logsActiveTab     = 'system';
        _failuresKnownBots = [];
    };
})();
