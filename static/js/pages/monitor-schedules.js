// ==================== Monitor — Schedules, Countdowns & Summaries ====================
(function () {
    let _monitorTimerInterval = null;   // managed by startMonitorCountdowns
    let _allSummaries         = [];

    let _monSchFlat = []; // flat list of {botName, catName, topicName, topicEnabled, sch, pending}

    function renderMonitorBots(bots) {
        // Build flat schedule list for filtering/sorting
        _monSchFlat = [];
        const allBots    = new Set();
        const allTopics  = new Set();
        const allPrompts = new Set();
        const allTypes   = new Set();
        for (const botName in bots) {
            const botData = bots[botName];
            allBots.add(botName);
            const cats = botData.categories || {};
            for (const catName in cats) {
                const catData = cats[catName];
                const topics = catData.topics || {};
                for (const topicName in topics) {
                    const topicData = topics[topicName];
                    allTopics.add(topicName);
                    const schedules = topicData.schedules || [];
                    const p = topicData.pending || {};
                    const topicEnabled = topicData.enabled !== false;
                    for (let i = 0; i < schedules.length; i++) {
                        const sch = schedules[i];
                        if (sch.prompt_key) allPrompts.add(sch.prompt_key);
                        if (sch.type) allTypes.add(sch.type);
                        _monSchFlat.push({
                            botName, catName, topicName,
                            botEnabled: botData.enabled,
                            topicEnabled,
                            sch, pending: p[sch.type] || 0
                        });
                    }
                }
            }
        }

        populateMonMultiSelect('sch-filter-bot-wrap',    [...allBots].sort());
        populateMonMultiSelect('sch-filter-topic-wrap',  [...allTopics].sort());
        populateMonMultiSelect('sch-filter-prompt-wrap', [...allPrompts].sort());
        populateMonMultiSelect('sch-filter-type-wrap',   [...allTypes].sort());
        applySchFilters();
    }

    function toggleMonMultiSelect(wrapId) {
        const wrap = document.getElementById(wrapId);
        if (!wrap) return;
        wrap.classList.toggle('open');
    }

    // Close multi-select when clicking outside
    document.addEventListener('click', e => {
        document.querySelectorAll('.mon-multi-select.open').forEach(el => {
            if (!el.contains(e.target)) el.classList.remove('open');
        });
    });

    // -------- Generic multi-select engine --------
    const _monMsState = {};
    function _getMonMs(wrapId) {
        if (!_monMsState[wrapId]) _monMsState[wrapId] = new Set();
        return _monMsState[wrapId];
    }
    function populateMonMultiSelect(wrapId, values) {
        const wrap = document.getElementById(wrapId);
        if (!wrap) return;
        const allLabel = wrap.dataset.label || 'All';
        const dd = wrap.querySelector('.mon-ms-dropdown');
        if (!dd) return;
        const selected = _getMonMs(wrapId);
        for (const v of [...selected]) if (!values.includes(v)) selected.delete(v);
        dd.innerHTML = `<label class="mon-ms-item all-item"><input type="checkbox" ${selected.size === 0 ? 'checked' : ''} onchange="_monMsSelectAll('${wrapId}',this.checked)"> ${allLabel}</label>` +
            values.map(v => {
                const ch = selected.has(v) ? 'checked' : '';
                return `<label class="mon-ms-item"><input type="checkbox" value="${escapeHtmlSys(v)}" ${ch} onchange="_monMsToggle('${wrapId}',this)"> ${escapeHtml(v)}</label>`;
            }).join('');
        _updateMonMsBtn(wrapId);
    }
    function _monMsSelectAll(wrapId, checked) {
        const wrap = document.getElementById(wrapId);
        const selected = _getMonMs(wrapId);
        selected.clear();
        const dd = wrap?.querySelector('.mon-ms-dropdown');
        if (dd) dd.querySelectorAll('input[value]').forEach(cb => cb.checked = false);
        _updateMonMsBtn(wrapId);
        const fn = wrap?.dataset?.onchange;
        if (fn && window[fn]) window[fn]();
    }
    function _monMsToggle(wrapId, cb) {
        const selected = _getMonMs(wrapId);
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
        const wrap = document.getElementById(wrapId);
        if (!wrap) { _updateMonMsBtn(wrapId); return; }
        const dd = wrap.querySelector('.mon-ms-dropdown');
        if (dd) { const allCb = dd.querySelector('.all-item input'); if (allCb) allCb.checked = selected.size === 0; }
        _updateMonMsBtnFromWrap(wrap, wrapId);
        const fn = wrap.dataset?.onchange;
        if (fn && window[fn]) window[fn]();
    }
    function _updateMonMsBtn(wrapId) {
        const wrap = document.getElementById(wrapId);
        if (!wrap) return;
        _updateMonMsBtnFromWrap(wrap, wrapId);
    }
    function _updateMonMsBtnFromWrap(wrap, wrapId) {
        const btn = wrap.querySelector('.mon-ms-btn');
        if (!btn) return;
        const allLabel = wrap.dataset.label || 'All';
        const selected = _getMonMs(wrapId);
        if (selected.size === 0) {
            btn.innerHTML = `${allLabel} <span class="mon-ms-arrow">▾</span>`;
        } else if (selected.size <= 2) {
            btn.innerHTML = `${[...selected].map(escapeHtml).join(', ')} <span class="mon-ms-arrow">▾</span>`;
        } else {
            btn.innerHTML = `${selected.size} selected <span class="mon-ms-arrow">▾</span>`;
        }
    }
    function getMonMsValues(wrapId) { return _getMonMs(wrapId); }

    // Returns all fire timestamps for a schedule within the next 24h from nowMs.
    function getUpcomingFires24h(sch, nowMs) {
        const toMs = nowMs + 24 * 3600000;
        const type = sch.type;
        const fires = [];

        if (type === 'daily') {
            for (let d = 0; d <= 1; d++) {
                const t = new Date(nowMs);
                t.setDate(t.getDate() + d);
                t.setHours(sch.hour ?? 0, sch.minute ?? 0, 0, 0);
                if (t.getTime() > nowMs && t.getTime() < toMs) fires.push(t.getTime());
            }
        } else if (type === 'hourly') {
            const first = new Date(nowMs);
            first.setMinutes(sch.minute ?? 0, 0, 0);
            if (first.getTime() <= nowMs) first.setHours(first.getHours() + 1);
            let t = first.getTime();
            while (t < toMs) { fires.push(t); t += 3600000; }
        } else if (type === 'minute') {
            const intervalMs = (sch.minute ?? 1) * 60000;
            let t = Math.ceil((nowMs + 1000) / intervalMs) * intervalMs;
            // Cap at 120 rows for high-frequency schedules
            while (t < toMs && fires.length < 120) { fires.push(t); t += intervalMs; }
        } else if (type === 'interval_hourly' || type === 'interval_minutes') {
            const intervalMs = type === 'interval_hourly'
                ? (sch.hours ?? 1) * 3600000
                : (sch.minutes ?? 30) * 60000;
            const startH  = sch.start_hour   ?? 0;
            const startMn = sch.start_minute ?? 0;
            const endH    = sch.end_hour;
            const endMn   = sch.end_minute;
            const hasEnd  = endH != null && endMn != null;
            // Use Beirut-timezone-correct end time so comparison is right regardless of browser timezone
            const todayEndMs = hasEnd ? _beirutDayAt(nowMs, endH, endMn) : null;
            if (hasEnd && nowMs >= todayEndMs) return fires; // window closed for today
            const maxOffset = hasEnd ? 0 : 1;
            for (let dayOffset = 0; dayOffset <= maxOffset; dayOffset++) {
                const anchorMs = _beirutDayAt(nowMs + dayOffset * 86400000, startH, startMn);
                let t = anchorMs <= nowMs
                    ? anchorMs + Math.ceil((nowMs - anchorMs + 1) / intervalMs) * intervalMs
                    : anchorMs;
                while (t < toMs) {
                    if (hasEnd && t > todayEndMs) break;
                    fires.push(t);
                    t += intervalMs;
                }
            }
        } else if (type === 'speeches_interval') {
            // Fires every minute — show only the next 5
            let t = Math.ceil((nowMs + 1000) / 60000) * 60000;
            for (let i = 0; i < 5 && t < toMs; i++, t += 60000) fires.push(t);
        }

        return [...new Set(fires)].sort((a, b) => a - b);
    }

    function applySchFilters() {
        const container = document.getElementById('monitor-bots-container');
        const selBots    = getMonMsValues('sch-filter-bot-wrap');
        const selTopics  = getMonMsValues('sch-filter-topic-wrap');
        const selPrompts = getMonMsValues('sch-filter-prompt-wrap');
        const selTypes   = getMonMsValues('sch-filter-type-wrap');

        let items = _monSchFlat.filter(r => r.botEnabled !== false && r.topicEnabled !== false && r.sch.enabled !== false);
        if (selBots.size    > 0) items = items.filter(r => selBots.has(r.botName));
        if (selTopics.size  > 0) items = items.filter(r => selTopics.has(r.topicName));
        if (selPrompts.size > 0) items = items.filter(r => selPrompts.has(r.sch.prompt_key || ''));
        if (selTypes.size   > 0) items = items.filter(r => selTypes.has(r.sch.type || ''));

        if (!items.length) {
            container.innerHTML = '<p class="mon-empty">No enabled schedules match the filter.</p>';
            return;
        }

        // Expand each schedule into individual fire rows for the next 24h
        const nowMs = Date.now();
        const allFires = [];
        for (const item of items) {
            getUpcomingFires24h(item.sch, nowMs).forEach((fireAt, idx) => {
                allFires.push({ fireAt, ...item, pending: idx === 0 ? item.pending : 0 });
            });
        }
        allFires.sort((a, b) => a.fireAt - b.fireAt);

        if (!allFires.length) {
            container.innerHTML = '<p class="mon-empty">No upcoming fires in the next 24 hours.</p>';
            return;
        }

        const fmtTime = ms => new Date(ms).toLocaleTimeString('en-GB', {
            timeZone: _BEIRUT_TZ, hour: '2-digit', minute: '2-digit'
        });
        const fmtDate = ms => new Date(ms).toLocaleDateString('en-GB', {
            timeZone: _BEIRUT_TZ, weekday: 'short', day: '2-digit', month: 'short'
        });

        // Insert a date-separator row when the calendar date changes
        let lastDate = '';
        const tableRows = allFires.map(({ fireAt, botName, topicName, sch, pending }) => {
            const dateLabel = fmtDate(fireAt);
            let separator = '';
            if (dateLabel !== lastDate) {
                lastDate = dateLabel;
                separator = `<tr class="sch-date-sep"><td colspan="7">${escapeHtml(dateLabel)}</td></tr>`;
            }
            const diff    = fireAt - nowMs;
            const typeCls = sch.type || 'hourly';
            const pendingCls   = pending > 0 ? 'has' : 'none';
            const pendingTxt   = pending > 0 ? `${pending} pending` : 'none';
            const pendingClick = pending > 0
                ? `onclick="showPendingMessages(${escapeHtmlSys(JSON.stringify(botName))},${escapeHtmlSys(JSON.stringify(topicName))},${escapeHtmlSys(JSON.stringify(sch.type))},${escapeHtmlSys(JSON.stringify(sch))})" style="cursor:pointer"`
                : '';
            return separator + `<tr data-fire-at="${fireAt}">
                <td style="white-space:nowrap;font-weight:600;font-size:13px;">${fmtTime(fireAt)}</td>
                <td class="sch-in-cell" style="white-space:nowrap;font-size:12px;color:var(--text-muted);">${formatDuration(diff)}</td>
                <td>${escapeHtml(botName)}</td>
                <td>${escapeHtml(topicName)}</td>
                <td><span class="mon-type-badge ${typeCls}">${escapeHtml(sch.type)}</span></td>
                <td style="font-size:12px;color:var(--text-muted);">${escapeHtml(sch.name || '—')}</td>
                <td><span class="mon-pending ${pendingCls}" ${pendingClick}>${pendingTxt}</span></td>
            </tr>`;
        }).join('');

        container.innerHTML = `<div style="overflow-x:auto;max-height:75vh;overflow-y:auto;">
            <table class="mon-table sch-timeline-table">
                <thead><tr>
                    <th>Time</th><th>In</th><th>Bot</th><th>Topic</th>
                    <th>Type</th><th>Schedule</th><th>Pending</th>
                </tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>`;
    }

    function _schRowKey(r) {
        return `${r.botName}|${r.catName}|${r.topicName}|${JSON.stringify(r.sch)}`;
    }

    // Update only pending spans when schedule structure hasn't changed — avoids DOM flash
    function _tryInPlaceSchUpdate(container, items) {
        const rows = container.querySelectorAll('.mon-sch-row[data-row-key]');
        if (rows.length !== items.length) return false;
        for (let i = 0; i < items.length; i++) {
            if (rows[i].dataset.rowKey !== _schRowKey(items[i])) return false;
        }
        items.forEach((r, i) => {
            const pendingEl = rows[i].querySelector('.mon-pending');
            if (pendingEl) {
                pendingEl.className = `mon-pending ${r.pending > 0 ? 'has' : 'none'}`;
                pendingEl.textContent = r.pending > 0 ? `${r.pending} pending` : 'none';
            }
        });
        return true;
    }

    function renderSchRow(r) {
        const pendingCls = r.pending > 0 ? 'has' : 'none';
        const pendingTxt = r.pending > 0 ? `${r.pending} pending` : 'none';
        const pendingClick = r.pending > 0
            ? `onclick="showPendingMessages(${escapeHtmlSys(JSON.stringify(r.botName))},${escapeHtmlSys(JSON.stringify(r.topicName))},${escapeHtmlSys(JSON.stringify(r.sch.type))},${escapeHtmlSys(JSON.stringify(r.sch))})" style="cursor:pointer"`
            : '';
        const disabledCls = r.sch.enabled === false ? ' mon-sch-disabled' : '';
        const icon = scheduleIcon(r.sch);
        const spec = scheduleSpec(r.sch);
        const schJson = escapeHtml(JSON.stringify(r.sch));
        const rowKey = escapeHtml(_schRowKey(r));
        const topicLabel = document.getElementById('sch-sort-time')?.checked
            ? `<span class="mon-sch-topic">${escapeHtml(r.topicName)}</span>` : '';
        return `<div class="mon-sch-row${disabledCls}" data-schedule="${schJson}" data-row-key="${rowKey}">
            <div class="mon-sch-left">
                <span class="mon-sch-icon">${icon}</span>
                ${topicLabel}
                <span class="mon-sch-name">${escapeHtml(r.sch.name || r.sch.type)}</span>
                <span class="mon-sch-prompt">${escapeHtml(r.sch.prompt_key || '')}</span>
                <span class="mon-sch-spec">${spec}</span>
            </div>
            <div class="mon-sch-right">
                <span class="mon-pending ${pendingCls}" ${pendingClick}>${pendingTxt}</span>
                <span class="mon-next-label">next in</span>
                <span class="mon-countdown">${r.sch.enabled === false ? '—' : '…'}</span>
                <span class="mon-next-time"></span>
            </div>
        </div>`;
    }

    function scheduleIcon(sch) {
        if (sch.type === 'hourly')              return '🕐';
        if (sch.type === 'daily')               return '📅';
        if (sch.type === 'minute')              return '⚡';
        if (sch.type === 'interval_hourly')            return '🔁';
        if (sch.type === 'interval_minutes')    return '🔁';
        if (sch.type === 'speeches_interval')   return '🎙️';
        return '🔔';
    }

    function scheduleSpec(sch) {
        if (sch.type === 'hourly')   return `every hour at :${String(sch.minute ?? 0).padStart(2,'0')}`;
        if (sch.type === 'daily')    return `daily at ${String(sch.hour ?? 0).padStart(2,'0')}:${String(sch.minute ?? 0).padStart(2,'0')}`;
        if (sch.type === 'minute')   return `every ${sch.minute ?? 1} min`;
        if (sch.type === 'interval_minutes') {
            const sh = String(sch.start_hour   ?? 0).padStart(2, '0');
            const sm = String(sch.start_minute ?? 0).padStart(2, '0');
            const endPart = (sch.end_hour != null && sch.end_minute != null)
                ? ` → ${String(sch.end_hour).padStart(2,'0')}:${String(sch.end_minute).padStart(2,'0')}` : '';
            return `every ${sch.minutes || 30}m — starts ${sh}:${sm}${endPart}`;
        }
        if (sch.type === 'interval_hourly') {
            const sh = String(sch.start_hour   ?? 0).padStart(2, '0');
            const sm = String(sch.start_minute ?? 0).padStart(2, '0');
            const endPart = (sch.end_hour != null && sch.end_minute != null)
                ? ` → ${String(sch.end_hour).padStart(2,'0')}:${String(sch.end_minute).padStart(2,'0')}` : '';
            return `every ${sch.hours || 1}h — starts ${sh}:${sm}${endPart}`;
        }
        if (sch.type === 'speeches_interval') {
            return `every 1m check — send after ${sch.wait_time || 5}m idle`;
        }
        return sch.type;
    }

    // ---------- Pending-count silent refresh ----------
    // Re-fetches /api/monitor/data every 60s and updates only the pending counts in
    // _monSchFlat, then re-renders the table. No loading flash, no scroll jump.
    async function _refreshPendingCounts() {
        try {
            const data = await api('/api/monitor/data');
            if (!data?.bots) return;
            for (const item of _monSchFlat) {
                const botData   = data.bots[item.botName];
                if (!botData) continue;
                const catData   = (botData.categories || {})[item.catName];
                if (!catData) continue;
                const topicData = (catData.topics || {})[item.topicName];
                if (!topicData) continue;
                item.pending = (topicData.pending || {})[item.sch.type] || 0;
            }
            applySchFilters();
        } catch (_) { /* ignore network errors */ }
    }

    // ---------- Countdown timer ----------
    function startMonitorCountdowns() {
        if (_monitorTimerInterval) clearInterval(_monitorTimerInterval);
        _monitorTimerInterval = setInterval(tickCountdowns, 1000);
        setInterval(_refreshPendingCounts, 60000);
        tickCountdowns();
    }

    const _BEIRUT_TZ = 'Asia/Beirut';

    // Returns UTC ms for the Beirut calendar day of `ms`, at Beirut hour h:minute m.
    // Works correctly regardless of the browser's local timezone.
    function _beirutDayAt(ms, h, m) {
        const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: _BEIRUT_TZ }).format(new Date(ms));
        const [year, month, day] = dateStr.split('-').map(Number);
        // Place h:m directly in UTC on the same calendar date as the Beirut day
        const roughMs = Date.UTC(year, month - 1, day, h, m, 0);
        // Find what Beirut time roughMs actually represents
        const beirutStr = new Intl.DateTimeFormat('en-US', {
            timeZone: _BEIRUT_TZ, hour: '2-digit', minute: '2-digit', hour12: false
        }).format(new Date(roughMs));
        const [bh, bm] = beirutStr.split(':').map(Number);
        // Compute adjustment; wrap if > 12h to avoid going the wrong direction
        // (e.g. h=23, bh=2 gives +21h raw but the correct answer is -3h)
        let diffMs = ((h - bh) * 60 + (m - bm)) * 60000;
        if (diffMs >  43200000) diffMs -= 86400000; // +12h → subtract day
        if (diffMs < -43200000) diffMs += 86400000; // -12h → add day
        return roughMs + diffMs;
    }

    function tickCountdowns() {
        // Tick the 24h timeline "In" cells
        const nowMs = Date.now();
        let needRebuild = false;
        const fireRows = document.querySelectorAll('tr[data-fire-at]');
        for (let i = 0; i < fireRows.length; i++) {
            const row = fireRows[i];
            const cdEl = row.querySelector('.sch-in-cell');
            if (!cdEl) continue;
            const diff = Number(row.dataset.fireAt) - nowMs;
            if (diff <= -60000) {
                // Fire time is more than 60s in the past — remove this row and trigger rebuild
                row.remove();
                needRebuild = true;
            } else if (diff <= 0) {
                cdEl.textContent = 'now';
                cdEl.style.color = 'var(--success,#22c55e)';
            } else {
                cdEl.textContent = formatDuration(diff);
                cdEl.style.color = diff < 300000 ? 'var(--danger)' : 'var(--text-muted)';
            }
        }
        if (needRebuild) applySchFilters();

        // Legacy: tick mon-sch-row countdowns (used by pending-messages detail view)
        const schRows = document.querySelectorAll('[data-schedule]');
        for (let i = 0; i < schRows.length; i++) {
            const row = schRows[i];
            const cdEl   = row.querySelector('.mon-countdown');
            const timeEl = row.querySelector('.mon-next-time');
            if (!cdEl) continue;
            let sch;
            try { sch = JSON.parse(row.dataset.schedule); } catch { continue; }
            if (sch.enabled === false) {
                cdEl.textContent = '—';
                if (timeEl) timeEl.textContent = '';
                continue;
            }
            const next = computeNextRun(sch);
            if (!next) {
                cdEl.textContent = '—';
                if (timeEl) timeEl.textContent = '';
                continue;
            }
            const diff = Math.max(0, next - nowMs);
            cdEl.textContent = formatDuration(diff);
            cdEl.classList.toggle('urgent', diff < 60000);
            if (timeEl) {
                timeEl.textContent = next.toLocaleTimeString('en-GB', {
                    timeZone: _BEIRUT_TZ,
                    hour: '2-digit',
                    minute: '2-digit',
                });
            }
        }
    }

    function computeNextRun(sch) {
        const now = new Date();
        if (sch.type === 'hourly') {
            const next = new Date(now);
            next.setMinutes(sch.minute ?? 0, 0, 0);
            if (next <= now) next.setHours(next.getHours() + 1);
            return next;
        }
        if (sch.type === 'daily') {
            const next = new Date(now);
            next.setHours(sch.hour ?? 0, sch.minute ?? 0, 0, 0);
            if (next <= now) next.setDate(next.getDate() + 1);
            return next;
        }
        if (sch.type === 'minute') {
            const interval = sch.minute ?? 1;
            const totalMin = now.getHours() * 60 + now.getMinutes();
            const nextTotalMin = Math.ceil((totalMin + 1) / interval) * interval;
            const next = new Date(now);
            next.setHours(Math.floor(nextTotalMin / 60), nextTotalMin % 60, 0, 0);
            return next;
        }
        if (sch.type === 'interval_hourly') {
            // Anchor: today at start_hour:start_minute; find next fire after now
            const startH = sch.start_hour ?? 0;
            const startM   = sch.start_minute ?? 0;
            const hours  = sch.hours ?? 1;
            const anchor = new Date(now);
            anchor.setHours(startH, startM, 0, 0);
            if (anchor > now) anchor.setDate(anchor.getDate() - 1);
            const elapsed = (now - anchor) / 3600000; // hours
            const n = Math.floor(elapsed / hours);
            const next = new Date(anchor.getTime() + (n + 1) * hours * 3600000);
            return next;
        }
        if (sch.type === 'speeches_interval') {
            // Fixed 1-minute tick — next run is at the start of the next minute
            const next = new Date(now);
            next.setSeconds(0, 0);
            next.setMinutes(next.getMinutes() + 1);
            return next;
        }
        if (sch.type === 'interval_minutes') {
            const startH   = sch.start_hour ?? 0;
            const startM   = sch.start_minute ?? 0;
            const minutes  = sch.minutes ?? 30;
            const anchor   = new Date(now);
            anchor.setHours(startH, startM, 0, 0);
            if (anchor > now) anchor.setDate(anchor.getDate() - 1);
            const elapsed = (now - anchor) / 60000; // minutes
            const n = Math.floor(elapsed / minutes);
            const next = new Date(anchor.getTime() + (n + 1) * minutes * 60000);
            return next;
        }
        return null;
    }

    function formatDuration(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m`;
        if (m > 0) return `${m}m ${String(sec).padStart(2,'0')}s`;
        return `${sec}s`;
    }

    // ---------- Summaries Tab (Schedule Overview) ----------
    let _scheduleStats = [];  // today's sent/failed from /api/monitor/schedule-stats

    function _scheduleStartTime(sch) {
        const type = sch.type;
        if (type === 'daily') {
            const h = String(sch.hour   ?? 0).padStart(2, '0');
            const m = String(sch.minute ?? 0).padStart(2, '0');
            return `${h}:${m}`;
        }
        if (type === 'hourly') return `:${String(sch.minute ?? 0).padStart(2, '0')} (each hour)`;
        if (type === 'interval_hourly' || type === 'interval_minutes') {
            const h = String(sch.start_hour   ?? 0).padStart(2, '0');
            const m = String(sch.start_minute ?? 0).padStart(2, '0');
            return `${h}:${m}`;
        }
        if (type === 'minute') return '00:00';
        return '—';
    }

    function _scheduleEndTime(sch) {
        const type = sch.type;
        if (type === 'interval_hourly' || type === 'interval_minutes') {
            if (sch.end_hour != null && sch.end_minute != null) {
                return `${String(sch.end_hour).padStart(2, '0')}:${String(sch.end_minute).padStart(2, '0')}`;
            }
            return '—';
        }
        return '—';
    }

    function _scheduleRepeatsText(sch) {
        const type = sch.type;
        if (type === 'daily')    return 'once daily';
        if (type === 'hourly')   return `every hour at :${String(sch.minute ?? 0).padStart(2, '0')}`;
        if (type === 'minute')   return `every ${sch.minute ?? '?'} min`;
        if (type === 'interval_hourly') {
            const h = sch.hours ?? 1;
            return `every ${h} hour${h !== 1 ? 's' : ''}`;
        }
        if (type === 'interval_minutes') {
            const m = sch.minutes ?? 1;
            return `every ${m} min${m !== 1 ? 's' : ''}`;
        }
        return '—';
    }

    function _scheduleFiresPerDay(sch) {
        const type = sch.type;
        if (type === 'daily')    return 1;
        if (type === 'hourly')   return 24;
        if (type === 'minute')   return Math.floor(1440 / (sch.minute || 60));
        if (type === 'interval_hourly') {
            const hours = sch.hours ?? 1;
            if (sch.end_hour != null && sch.end_minute != null) {
                const startH = sch.start_hour ?? 0;
                const windowH = sch.end_hour - startH;
                return Math.max(1, Math.floor(windowH / hours));
            }
            return Math.max(1, Math.floor(24 / hours));
        }
        if (type === 'interval_minutes') {
            const mins = sch.minutes ?? 1;
            if (sch.end_hour != null && sch.end_minute != null) {
                const startMins = (sch.start_hour ?? 0) * 60 + (sch.start_minute ?? 0);
                const endMins   = sch.end_hour * 60 + sch.end_minute;
                return Math.max(1, Math.floor((endMins - startMins) / mins));
            }
            return Math.max(1, Math.floor(1440 / mins));
        }
        return 0;
    }

    async function renderMonSummaries(summaries) {
        // summaries arg kept for compatibility but no longer used directly in the table
        _allSummaries = summaries;

        // Populate bot/topic/type filter dropdowns from bots_data
        const botsData = (getMonitorData?.() || {}).bots || {};
        const allBots   = Object.keys(botsData).sort();
        const allTopics = [...new Set(
            Object.values(botsData).flatMap(b =>
                Object.values(b.categories || {}).flatMap(c => Object.keys(c.topics || {}))
            )
        )].sort();
        const allTypes = [...new Set(
            Object.values(botsData).flatMap(b =>
                Object.values(b.categories || {}).flatMap(c =>
                    Object.values(c.topics || {}).flatMap(t => (t.schedules || []).map(s => s.type).filter(Boolean))
                )
            )
        )].sort();
        populateMonMultiSelect('sum-filter-bot-wrap',   allBots);
        populateMonMultiSelect('sum-filter-topic-wrap', allTopics);
        populateMonMultiSelect('sum-filter-type-wrap',  allTypes);

        // Fetch today's stats
        const statsData = await api('/api/monitor/schedule-stats');
        _scheduleStats = (statsData.status === 'ok') ? (statsData.stats || []) : [];

        applyMonSummaryFilters();
    }

    function applyMonSummaryFilters() {
        const selBots   = getMonMsValues('sum-filter-bot-wrap');
        const selTopics = getMonMsValues('sum-filter-topic-wrap');
        const selTypes  = getMonMsValues('sum-filter-type-wrap');

        const el = document.getElementById('mon-summaries-content');
        if (!el) return;

        const botsData = (getMonitorData?.() || {}).bots || {};

        // Build a stats lookup: key = "bot|topic|type"
        const statsLookup = {};
        for (const s of _scheduleStats) {
            const key = `${s.bot_name}|${s.topic_name}|${s.schedule_type}`;
            statsLookup[key] = { sent: s.sent || 0, failed: s.failed || 0 };
        }

        // Flatten all schedules from bots config
        const rows = [];
        for (const botName in botsData) {
            if (selBots.size > 0 && !selBots.has(botName)) continue;
            const botData = botsData[botName];
            if (!botData.enabled) continue;
            const cats = botData.categories || {};
            for (const catName in cats) {
                const catData = cats[catName];
                if (!catData.enabled) continue;
                const topics = catData.topics || {};
                for (const topicName in topics) {
                    if (selTopics.size > 0 && !selTopics.has(topicName)) continue;
                    const topicData = topics[topicName];
                    if (!topicData.enabled) continue;
                    const schedules = topicData.schedules || [];
                    for (let i = 0; i < schedules.length; i++) {
                        const sch = schedules[i];
                        if (!sch.enabled) continue;
                        if (selTypes.size > 0 && !selTypes.has(sch.type || '')) continue;

                        const key    = `${botName}|${topicName}|${sch.type}`;
                        const stat   = statsLookup[key] || { sent: 0, failed: 0 };
                        const total  = _scheduleFiresPerDay(sch);
                        const remain = Math.max(0, total - stat.sent - stat.failed);

                        rows.push({ botName, topicName, sch, stat, total, remain });
                    }
                }
            }
        }

        if (!rows.length) {
            el.innerHTML = '<p class="mon-empty">No enabled schedules found.</p>';
            return;
        }

        const tableRows = rows.map(({ botName, topicName, sch, stat, total, remain }) => {
            const typeCls   = sch.type || 'hourly';
            const startTime = _scheduleStartTime(sch);
            const endTime   = _scheduleEndTime(sch);
            const repeats   = _scheduleRepeatsText(sch);
            const sentCell   = stat.sent   > 0 ? `<span style="color:var(--success,#22c55e);font-weight:600;">${stat.sent}</span>`   : `<span style="color:var(--text-muted);">0</span>`;
            const failedCell = stat.failed > 0 ? `<span style="color:var(--danger);font-weight:600;">${stat.failed}</span>`          : `<span style="color:var(--text-muted);">0</span>`;
            const remainCell = remain       > 0 ? `<span style="color:var(--text-secondary);">${remain}</span>`                      : `<span style="color:var(--text-muted);">0</span>`;
            const endCell    = endTime !== '—'
                ? `<span style="white-space:nowrap;font-size:12px;">${escapeHtml(endTime)}</span>`
                : `<span style="color:var(--text-muted);font-size:12px;">—</span>`;
            return `<tr>
                <td>${escapeHtml(botName)}</td>
                <td>${escapeHtml(topicName)}</td>
                <td><span class="mon-type-badge ${typeCls}">${escapeHtml(sch.type)}</span></td>
                <td style="white-space:nowrap;font-size:12px;">${escapeHtml(startTime)}</td>
                <td>${endCell}</td>
                <td style="font-size:12px;">${escapeHtml(repeats)}</td>
                <td style="text-align:center;">${sentCell}</td>
                <td style="text-align:center;">${failedCell}</td>
                <td style="text-align:center;">${remainCell} <span style="color:var(--text-muted);font-size:11px;">/ ${total}</span></td>
            </tr>`;
        }).join('');

        el.innerHTML = `<div style="overflow-x:auto;">
            <table class="mon-table">
                <thead><tr>
                    <th>Bot</th><th>Topic</th><th>Type</th>
                    <th>Start Time</th><th>End Time</th><th>Repeats</th>
                    <th style="text-align:center;">Sent Today</th>
                    <th style="text-align:center;">Failed Today</th>
                    <th style="text-align:center;">Remaining</th>
                </tr></thead>
                <tbody>${tableRows}</tbody>
            </table></div>`;
    }

    // ---------- Summary Source Messages — full inline view ----------
    let _sumMsgData = [];   // all messages for current summary
    let _sumMsgId   = null;

    async function showSummaryMessages(summaryId) {
        _sumMsgId   = summaryId;
        _sumMsgData = [];

        const panel = document.getElementById('mon-tab-summaries');
        panel.innerHTML = `
            <div class="sum-msg-page">
                <div class="sum-msg-page-header">
                    <button class="btn btn-secondary btn-sm" onclick="_closeSummaryMessages()">‹ Back to Summaries</button>
                    <h3 style="margin:0;font-size:15px">Source Messages</h3>
                </div>
                <div class="mon-filter-bar" style="flex-wrap:wrap;gap:8px">
                    <input type="text" class="input mon-filter-search" id="smp-search"
                           placeholder="🔍 Search message text…" oninput="_renderSumMsgTable()">
                    <select class="select mon-filter-sel" id="smp-filter-source" onchange="_renderSumMsgTable()">
                        <option value="">All Sources</option>
                    </select>
                    <input type="date" class="input" id="smp-filter-date-from" style="max-width:150px"
                           onchange="_renderSumMsgTable()">
                    <input type="date" class="input" id="smp-filter-date-to"   style="max-width:150px"
                           onchange="_renderSumMsgTable()">
                    <button class="btn btn-secondary btn-sm" onclick="_clearSumMsgFilters()">✕ Clear</button>
                </div>
                <div id="smp-table-wrap"><p class="mon-empty">Loading…</p></div>
            </div>`;

        const data = await api(`/api/monitor/summary-messages?id=${summaryId}`);
        const wrap = document.getElementById('smp-table-wrap');
        if (!wrap) return;

        if (data.status !== 'ok' || !data.messages?.length) {
            wrap.innerHTML = `<p class="mon-empty">No linked messages found.</p>`;
            return;
        }
        _sumMsgData = data.messages;

        // Populate source dropdown
        const sources = [...new Set(_sumMsgData.map(m => m.channel_username).filter(Boolean))].sort();
        const sel = document.getElementById('smp-filter-source');
        if (sel) sources.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = '@' + s; sel.appendChild(o); });

        _renderSumMsgTable();
    }

    function _renderSumMsgTable() {
        const wrap = document.getElementById('smp-table-wrap');
        if (!wrap) return;

        const search   = (document.getElementById('smp-search')?.value || '').toLowerCase();
        const source   = document.getElementById('smp-filter-source')?.value || '';
        const dateFrom = document.getElementById('smp-filter-date-from')?.value || '';
        const dateTo   = document.getElementById('smp-filter-date-to')?.value   || '';

        let filtered = _sumMsgData;
        if (search) filtered = filtered.filter(m => (m.preview || '').toLowerCase().includes(search));
        if (source) filtered = filtered.filter(m => m.channel_username === source);
        if (dateFrom) filtered = filtered.filter(m => m.timestamp && m.timestamp >= dateFrom);
        if (dateTo)   filtered = filtered.filter(m => m.timestamp && m.timestamp.slice(0,10) <= dateTo);

        if (!filtered.length) {
            wrap.innerHTML = `<p class="mon-empty">No messages match filters.</p>`;
            return;
        }

        const rows = filtered.map(m => {
            const ts  = _fmtLBN(m.timestamp);
            const src = m.channel_username ? `@${m.channel_username}` : '—';
            const col = m.collection_name  ? escapeHtml(m.collection_name)  : '—';
            const bot = m.bot_name         ? escapeHtml(m.bot_name)         : '—';
            const top = m.topics           ? escapeHtml(m.topics)           : '—';
            const kw  = m.keywords_found   ? escapeHtml(m.keywords_found)   : '—';
            const txt = escapeHtml(m.preview || '');
            return `<tr>
                <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                <td>${src}</td>
                <td>${col}</td>
                <td>${bot}</td>
                <td>${top}</td>
                <td>${kw}</td>
                <td class="smp-msg-cell" title="${txt}">${txt}</td>
            </tr>`;
        }).join('');

        wrap.innerHTML = `
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${filtered.length} message${filtered.length===1?'':'s'}</div>
            <div style="overflow-x:auto">
                <table class="mon-table smp-table">
                    <thead><tr>
                        <th>Date / Time</th><th>Source</th><th>Collection</th>
                        <th>Bot</th><th>Topics</th><th>Keywords</th><th>Message</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    function _clearSumMsgFilters() {
        ['smp-search','smp-filter-source','smp-filter-date-from','smp-filter-date-to']
            .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        _renderSumMsgTable();
    }

    function _closeSummaryMessages() {
        _sumMsgData = [];
        _sumMsgId   = null;
        // Rebuild the summaries tab HTML (matches index.html structure)
        const panel = document.getElementById('mon-tab-summaries');
        panel.innerHTML = `
            <div class="mon-filter-bar">
                <div class="mon-multi-select" id="sum-filter-bot-wrap" data-onchange="applyMonSummaryFilters" data-label="All Bots">
                    <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('sum-filter-bot-wrap')">All Bots <span class="mon-ms-arrow">▾</span></button>
                    <div class="mon-ms-dropdown" id="sum-filter-bot-dd"></div>
                </div>
                <div class="mon-multi-select" id="sum-filter-topic-wrap" data-onchange="applyMonSummaryFilters" data-label="All Topics">
                    <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('sum-filter-topic-wrap')">All Topics <span class="mon-ms-arrow">▾</span></button>
                    <div class="mon-ms-dropdown" id="sum-filter-topic-dd"></div>
                </div>
                <div class="mon-multi-select" id="sum-filter-type-wrap" data-onchange="applyMonSummaryFilters" data-label="All Types">
                    <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('sum-filter-type-wrap')">All Types <span class="mon-ms-arrow">▾</span></button>
                    <div class="mon-ms-dropdown" id="sum-filter-type-dd"></div>
                </div>
            </div>
            <div id="mon-summaries-content"><p class="mon-empty">Loading…</p></div>`;
        renderMonSummaries(_allSummaries || []);
    }

    // ---------- Pending messages viewer (schedules tab) ----------
    let _pendingMsgData = [];

    async function showPendingMessages(botName, topicName, schedType, sch) {
        _pendingMsgData = [];
        const panel = document.getElementById('mon-tab-schedules');
        panel.innerHTML = `
            <div class="sum-msg-page">
                <div class="sum-msg-page-header">
                    <button class="btn btn-secondary btn-sm" onclick="_closePendingMessages()">‹ Back to Schedules</button>
                    <h3 style="margin:0;font-size:15px">Pending Messages — ${escapeHtml(botName)} › ${escapeHtml(topicName)} › ${escapeHtml(schedType)}</h3>
                </div>
                <div id="pmp-table-wrap"><p class="mon-empty">Loading…</p></div>
            </div>`;

        const s = sch || {};
        const schParams = [
            s.minute   != null ? `sch_minute=${encodeURIComponent(s.minute)}`         : '',
            s.hour     != null ? `sch_hour=${encodeURIComponent(s.hour)}`             : '',
            s.hours    != null ? `sch_hours=${encodeURIComponent(s.hours)}`           : '',
            s.minutes  != null ? `sch_minutes=${encodeURIComponent(s.minutes)}`       : '',
            s.start_hour   != null ? `sch_start_hour=${encodeURIComponent(s.start_hour)}`     : '',
            s.start_minute != null ? `sch_start_minute=${encodeURIComponent(s.start_minute)}` : '',
            s.end_hour   != null ? `sch_end_hour=${encodeURIComponent(s.end_hour)}`   : '',
            s.end_minute != null ? `sch_end_minute=${encodeURIComponent(s.end_minute)}` : '',
        ].filter(Boolean).join('&');
        const url = `/api/monitor/pending-messages?bot=${encodeURIComponent(botName)}&topic=${encodeURIComponent(topicName)}&schedule_type=${encodeURIComponent(schedType)}${schParams ? '&' + schParams : ''}`;
        const data = await api(url);
        const wrap = document.getElementById('pmp-table-wrap');
        if (!wrap) return;

        if (data.status !== 'ok' || !data.messages?.length) {
            wrap.innerHTML = `<p class="mon-empty">No pending messages found.</p>`;
            return;
        }
        _pendingMsgData = data.messages;

        const rows = _pendingMsgData.map(m => {
            const ts  = _fmtLBN(m.timestamp);
            const src = m.channel_username ? `@${escapeHtml(m.channel_username)}` : '—';
            const col = m.collection_name  ? escapeHtml(m.collection_name)  : '—';
            const txt = escapeHtml(m.preview || '');
            return `<tr>
                <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                <td>${src}</td>
                <td>${col}</td>
                <td class="smp-msg-cell" title="${txt}">${txt}</td>
            </tr>`;
        }).join('');

        wrap.innerHTML = `
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${_pendingMsgData.length} pending message${_pendingMsgData.length===1?'':'s'}</div>
            <div style="overflow-x:auto">
                <table class="mon-table smp-table">
                    <thead><tr><th>Date / Time</th><th>Source</th><th>Collection</th><th>Message</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    function _closePendingMessages() {
        _pendingMsgData = [];
        const panel = document.getElementById('mon-tab-schedules');
        panel.innerHTML = `
            <div class="mon-filter-bar">
                <div class="mon-multi-select" id="sch-filter-bot-wrap" data-onchange="applySchFilters" data-label="All Bots">
                    <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('sch-filter-bot-wrap')">All Bots <span class="mon-ms-arrow">▾</span></button>
                    <div class="mon-ms-dropdown" id="sch-filter-bot-dd"></div>
                </div>
                <div class="mon-multi-select" id="sch-filter-topic-wrap" data-onchange="applySchFilters" data-label="All Topics">
                    <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('sch-filter-topic-wrap')">All Topics <span class="mon-ms-arrow">▾</span></button>
                    <div class="mon-ms-dropdown" id="sch-filter-topic-dd"></div>
                </div>
                <div class="mon-multi-select" id="sch-filter-prompt-wrap" data-onchange="applySchFilters" data-label="All Prompts">
                    <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('sch-filter-prompt-wrap')">All Prompts <span class="mon-ms-arrow">▾</span></button>
                    <div class="mon-ms-dropdown" id="sch-filter-prompt-dd"></div>
                </div>
                <div class="mon-multi-select" id="sch-filter-type-wrap" data-onchange="applySchFilters" data-label="All Types">
                    <button class="select mon-filter-sel mon-ms-btn" type="button" onclick="toggleMonMultiSelect('sch-filter-type-wrap')">All Types <span class="mon-ms-arrow">▾</span></button>
                    <div class="mon-ms-dropdown" id="sch-filter-type-dd"></div>
                </div>
                <label class="mon-sort-label"><input type="checkbox" id="sch-sort-time" onchange="applySchFilters()"> Sort by next run</label>
            </div>
            <div id="monitor-bots-container"><p class="mon-empty">Loading…</p></div>`;
        const _md = getMonitorData?.(); if (_md) renderMonitorBots(_md.bots || {});
    }


    // ── Bridge getters (used by monitor-export.js) ────────────────────────
    window._getMonSchFlat    = function () { return _monSchFlat; };
    window._getAllSummaries   = function () { return _allSummaries; };
    window._getScheduleStats = function () { return _scheduleStats; };

    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window.renderMonitorBots        = renderMonitorBots;
    window.toggleMonMultiSelect     = toggleMonMultiSelect;
    window.populateMonMultiSelect   = populateMonMultiSelect;
    window.getMonMsValues           = getMonMsValues;
    window._getMonMs                = _getMonMs;
    window._updateMonMsBtn          = _updateMonMsBtn;
    window._monMsSelectAll          = _monMsSelectAll;
    window._monMsToggle             = _monMsToggle;
    window.applySchFilters          = applySchFilters;
    window.renderMonSummaries       = renderMonSummaries;
    window.applyMonSummaryFilters   = applyMonSummaryFilters;
    window.showSummaryMessages      = showSummaryMessages;
    window._renderSumMsgTable       = _renderSumMsgTable;
    window._clearSumMsgFilters      = _clearSumMsgFilters;
    window._closeSummaryMessages    = _closeSummaryMessages;
    window.showPendingMessages      = showPendingMessages;
    window._closePendingMessages    = _closePendingMessages;
    window.startMonitorCountdowns   = startMonitorCountdowns;
    window.getUpcomingFires24h      = getUpcomingFires24h;
    window.computeNextRun           = computeNextRun;
    window.scheduleIcon             = scheduleIcon;
    window.scheduleSpec             = scheduleSpec;
    window.formatDuration           = formatDuration;
})();
