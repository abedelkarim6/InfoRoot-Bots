// ==================== Monitor — Core (data loading & tab switching) ====================
(function () {
    let _monitorData          = null;
    let _monitorRefreshInterval = null;
    let _monActiveTab         = localStorage.getItem('mon-active-tab') || 'schedules';

    async function loadMonitorData() {
        // Only load if monitor page is actually active
        if (document.getElementById('page-monitor')?.classList.contains('active') === false) {
            return;
        }
    
        const container = document.getElementById('monitor-bots-container');
        const isFirstLoad = !_monitorData;
        if (isFirstLoad) container.innerHTML = '<p class="mon-empty">Loading…</p>';

        const data = await api('/api/monitor/data');
        if (data.status !== 'ok') {
            container.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message)}</p>`;
            return;
        }
        _monitorData = data;

        // Preserve scroll position on refresh
        const scrollY = window.scrollY;
        const pageEl = document.getElementById('page-monitor');

        // Freeze the page height to prevent scroll jump during DOM swap
        if (!isFirstLoad && pageEl) pageEl.style.minHeight = pageEl.offsetHeight + 'px';

        renderMonitorBots(data.bots || {});
        renderMonSummaries(data.recent_summaries || []);  // async — fires stats fetch in background
        // applyMonSummaryFilters is called inside renderMonSummaries after stats load
        startMonitorCountdowns();

        // Load unclassified badge count in background (respects cleared-at)
        {
            const since = localStorage.getItem('mon-uncl-cleared-at');
            const url = '/api/monitor/unclassified?limit=1' + (since ? '&since=' + encodeURIComponent(since) : '');
            api(url).then(r => {
                if (r.status === 'ok') {
                    const total = (r.stats || []).reduce((s, x) => s + (x.cnt || 0), 0);
                    const badge = document.getElementById('mon-uncl-badge');
                    if (badge) {
                        badge.textContent = total;
                        badge.style.display = total > 0 ? 'inline-block' : 'none';
                    }
                }
            });
        }

        // Load missed badge count in background (respects cleared-at)
        {
            const since = localStorage.getItem('mon-missed-cleared-at');
            const url = '/api/monitor/missed?limit=1' + (since ? '&since=' + encodeURIComponent(since) : '');
            api(url).then(r => {
                if (r.status === 'ok') {
                    const total = (r.stats || []).reduce((s, x) => s + (x.cnt || 0), 0);
                    const badge = document.getElementById('mon-missed-badge');
                    if (badge) {
                        badge.textContent = total;
                        badge.style.display = total > 0 ? 'inline-block' : 'none';
                    }
                }
            });
        }

        // Restore active monitor tab (always, so the saved tab is applied after HTML re-render)
        switchMonTab(_monActiveTab);

        // Restore scroll position after paint
        if (!isFirstLoad) {
            window.scrollTo(0, scrollY);
            requestAnimationFrame(() => {
                window.scrollTo(0, scrollY);
                if (pageEl) pageEl.style.minHeight = '';
            });
        }
    }

    function switchMonTab(tab) {
        _monActiveTab = tab;
        localStorage.setItem('mon-active-tab', tab);
        document.querySelectorAll('.mon-tab').forEach(t =>
            t.classList.toggle('active', t.dataset.tab === tab)
        );
        ['schedules', 'summaries', 'messages', 'unclassified', 'missed', 'history'].forEach(t => {
            const el = document.getElementById('mon-tab-' + t);
            if (el) el.style.display = t === tab ? '' : 'none';
        });
        if (tab === 'messages' && (typeof _monMessagesReady !== 'function' || !_monMessagesReady())) loadMonitorMessages();
        if (tab === 'history' && _isHistoryEmpty()) loadScheduleHistory();
        if (tab === 'unclassified') {
            // Restore clear/show-all button state from persisted timestamp
            const clearedAt = localStorage.getItem('mon-uncl-cleared-at');
            const clearBtn   = document.getElementById('uncl-clear-btn');
            const showAllBtn = document.getElementById('uncl-showall-btn');
            if (clearBtn)   clearBtn.style.display   = '';
            if (showAllBtn) showAllBtn.style.display  = clearedAt ? '' : 'none';
            if (typeof _unclMessagesReady !== 'function' || !_unclMessagesReady()) loadUnclassifiedMessages();
        }
        if (tab === 'missed') {
            const clearedAt = localStorage.getItem('mon-missed-cleared-at');
            const clearBtn   = document.getElementById('missed-clear-btn');
            const showAllBtn = document.getElementById('missed-showall-btn');
            if (clearBtn)   clearBtn.style.display   = '';
            if (showAllBtn) showAllBtn.style.display  = clearedAt ? '' : 'none';
            if (typeof _missedMessagesReady !== 'function' || !_missedMessagesReady()) loadMissedMessages();
        }
    }

    function toggleMonSec(bodyId, iconId) {
        const body = document.getElementById(bodyId);
        const icon = document.getElementById(iconId);
        if (!body) return;
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? '' : 'none';
        if (icon) icon.textContent = isHidden ? '▼' : '▶';
    }

    // ---------- Auto-refresh (always on, seamless) ----------
    document.addEventListener('DOMContentLoaded', () => {
        _monitorRefreshInterval = setInterval(loadMonitorData, 15000);
    });

    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window.loadMonitorData = loadMonitorData;
    window.switchMonTab    = switchMonTab;
    window.toggleMonSec    = toggleMonSec;
    window.getMonitorData  = () => _monitorData;
})();
