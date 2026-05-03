// ==================== Bot Manager V3.0 - Complete Implementation ====================
// All 11 improvements included

// ==================== Theme ====================
(function () {
    const saved = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
})();

function _applyThemeButton(theme) {
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    if (theme === 'light') {
        btn.textContent = '🌙 Dark';
    } else {
        btn.textContent = '☀️ Light';
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    _applyThemeButton(next);
}

// ==================== Global State ====================
// NOTE: api, debounce, escapeHtml/Sys, jsAttr, _fmtLBN, _monTagsHtml → shared/api.js
// NOTE: showAlert, showConfirm, showPrompt, showNotification      → shared/dialogs.js
// NOTE: collections, channel picker, channel validator            → pages/collections.js
window.globalConfig  = null;
window.globalPrompts = null;

// _userAddedKeywords → moved into pages/bots.js IIFE

// ==================== Sidebar collapse & resize ====================
function initSidebar() {
    const sidebar = document.getElementById('main-sidebar');
    const btn     = document.getElementById('sidebar-collapse-btn');
    const handle  = document.getElementById('sidebar-resize-handle');
    if (!sidebar) return;

    // Restore collapsed state
    if (localStorage.getItem('sidebar-collapsed') === 'true') {
        sidebar.classList.add('collapsed');
        document.body.classList.add('sidebar-collapsed');
        if (btn) btn.textContent = '▶';
    }

    // Restore saved width
    const savedW = parseInt(localStorage.getItem('sidebar-width'));
    if (savedW && !sidebar.classList.contains('collapsed')) {
        _applySidebarWidth(savedW);
    }

    // Resize drag
    if (handle) {
        let startX, startW;
        handle.addEventListener('mousedown', e => {
            if (sidebar.classList.contains('collapsed')) return;
            e.preventDefault();
            startX = e.clientX;
            startW = sidebar.offsetWidth;
            handle.classList.add('dragging');
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', onDragEnd);
        });
        function onDrag(e) {
            const w = Math.max(180, Math.min(520, startW + e.clientX - startX));
            _applySidebarWidth(w);
        }
        function onDragEnd() {
            handle.classList.remove('dragging');
            localStorage.setItem('sidebar-width', sidebar.offsetWidth);
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', onDragEnd);
        }
    }
}

function _applySidebarWidth(w) {
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
}

function toggleSidebar() {
    const sidebar = document.getElementById('main-sidebar');
    const btn     = document.getElementById('sidebar-collapse-btn');
    if (!sidebar) return;
    const collapsed = sidebar.classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    if (btn) btn.textContent = collapsed ? '▶' : '◀';
    localStorage.setItem('sidebar-collapsed', collapsed);
    if (!collapsed) {
        const savedW = parseInt(localStorage.getItem('sidebar-width'));
        if (savedW) _applySidebarWidth(savedW);
    }
}

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', async () => {
    _applyThemeButton(document.documentElement.getAttribute('data-theme') || 'dark');
    initSidebar();
    initNavigation();
    await loadAllData();
    loadWarnings();
    // Wait for auth/role check (accounts.js) before showing initial page
    // so hidden nav sections are gated before the first render.
    if (typeof authReady !== 'undefined') await authReady;
    const initialPage = location.hash.slice(1) || localStorage.getItem('activePage') || 'system';
    // Seed the history entry so back/forward works from the start
    history.replaceState({ page: initialPage }, '', '#' + initialPage);
    showPage(initialPage);
});

// Global search keyboard shortcut (Ctrl+K / Cmd+K)
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const input = document.getElementById('global-search-input');
        if (input) { input.focus(); input.select(); }
    }
});

// Close search dropdown on outside click
document.addEventListener('click', e => {
    const searchEl = document.querySelector('.sidebar-search');
    if (searchEl && !searchEl.contains(e.target)) {
        hideSearchResults();
    }
});

// Back / forward navigation
let _poppingState = false;
window.addEventListener('popstate', () => {
    _poppingState = true;
    showPage(location.hash.slice(1) || 'system');
    _poppingState = false;
});

// ==================== Navigation ====================
function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.dataset.page;
            showPage(page);
        });
    });
}

const _ADMIN_ONLY_PAGES = new Set(['accounts', 'tg-tester', 'logs', 'ai-usage']);

function showPage(pageName) {
    // Enforce admin-only pages — block even if URL hash is edited manually
    if (_ADMIN_ONLY_PAGES.has(pageName)) {
        // currentUser is the global from accounts.js; null means auth not yet resolved
        if (typeof currentUser !== 'undefined' && currentUser !== null && currentUser.role !== 'admin') {
            history.replaceState({ page: 'system' }, '', '#system');
            pageName = 'system';
        }
    }

    // Stop log auto-refresh when leaving the logs page; reset failure bot cache
    if (pageName !== 'logs' && typeof _resetLogsState === 'function') {
        _resetLogsState();
    }
    // Stop Gemini usage poller when leaving dashboard
    if (pageName !== 'dashboard' && window._stopGeminiUsagePoller) {
        _stopGeminiUsagePoller();
    }
    // Stop AI usage poller when leaving the AI Usage page
    if (pageName !== 'ai-usage' && typeof _stopAiUsagePoller === 'function') {
        _stopAiUsagePoller();
    }

    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === pageName) {
            item.classList.add('active');
        }
    });

    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    const pageEl = document.getElementById(`${pageName}-page`);
    if (pageEl) pageEl.classList.add('active');

    // Chat pages fill the viewport — strip main-content padding
    const chatPages = ['yt-chat', 'agent-chat'];
    document.body.classList.toggle('chat-page-active', chatPages.includes(pageName));

    // Update URL (skip when driven by popstate to avoid duplicate history entries)
    if (!_poppingState && location.hash !== '#' + pageName) {
        history.pushState({ page: pageName }, '', '#' + pageName);
    }
    localStorage.setItem('activePage', pageName);

    if (pageName === 'system') renderSystemPage();
    else if (pageName === 'collections') renderCollectionsPage();
    else if (pageName === 'bots') {
        if (typeof _resetBotDetail === 'function') _resetBotDetail();
        _showBotsListView();
    }
    else if (pageName === 'monitor') loadMonitorData();
    else if (pageName === 'dashboard') {
        loadDashboardData();
        if (window._startGeminiUsagePoller) _startGeminiUsagePoller();
    }
    // YouTube pages
    else if (pageName === 'yt-channels') loadYtChannelsData();
    else if (pageName === 'yt-keywords') loadYtKeywordsData();
    else if (pageName === 'yt-videos') {
        loadYtVideosData();
        // Start auto-refresh if the checkbox is checked (it defaults to checked in HTML)
        const arCb = document.getElementById('yt-queue-autorefresh');
        if (arCb && arCb.checked && !_ytQueueInterval) toggleYtQueueAutoRefresh(true);
    }
    else if (pageName === 'yt-chat') ytChatInit();
    else if (pageName === 'agent-chat') agentChatInit();
    else if (pageName === 'recycle-bin') loadRecycleBinData();
    else if (pageName === 'accounts') loadAccountsData();
    else if (pageName === 'profile') loadProfileData();
    else if (pageName === 'tg-setup') loadTgSetupPage();
    else if (pageName === 'tg-tester') tgTesterInit();
    else if (pageName === 'logs') loadLogsPage();
    else if (pageName === 'ai-usage') loadAiUsagePage();
    else if (pageName === 'privacy') loadPrivacyPage();
}

// ==================== System Bot FAB ====================
function toggleSysBot() {
    const drawer = document.getElementById('sys-bot-drawer');
    const isOpen = drawer.classList.contains('open');
    if (isOpen) {
        closeSysBot();
    } else {
        drawer.classList.add('open');
        document.getElementById('sys-bot-overlay').classList.add('open');
        document.getElementById('sys-bot-fab').classList.add('open');
        sysChatInit();
    }
}

function closeSysBot() {
    document.getElementById('sys-bot-drawer').classList.remove('open');
    document.getElementById('sys-bot-overlay').classList.remove('open');
    document.getElementById('sys-bot-fab').classList.remove('open');
}

// ==================== Data Loading ====================
async function loadAllData() {
    try {
        [window.globalConfig, window.globalPrompts] = await Promise.all([
            api('/api/config'),
            api('/api/prompts'),
        ]);
        updateStats();
        updateSystemStatus();
    } catch (error) {
        console.error('Error loading data:', error);
        showNotification('Failed to load configuration', 'error');
    }
}

// ==================== Warnings Panel ====================
async function loadWarnings() {
    const result = await api('/api/warnings');
    if (result && Array.isArray(result.warnings)) {
        renderWarningsPanel(result.warnings);
    }
}

function renderWarningsPanel(warnings) {
    const bell = document.getElementById('notif-bell-btn');
    const body = document.getElementById('notif-panel-body');
    const count = document.getElementById('notif-bell-count');
    const title = document.getElementById('notif-panel-title');
    if (!bell) return;

    if (!warnings.length) {
        bell.style.display = 'none';
        return;
    }

    bell.style.display = '';
    count.textContent = warnings.length;

    const errCount = warnings.filter(w => w.level === 'error').length;
    bell.classList.toggle('notif-bell-has-error', errCount > 0);
    title.textContent = errCount
        ? `⛔ Missing Definitions (${errCount} error${errCount > 1 ? 's' : ''})`
        : `⚠️ Missing Definitions (${warnings.length})`;

    const groups = {
        error: warnings.filter(w => w.level === 'error'),
        warning: warnings.filter(w => w.level === 'warning'),
    };

    body.innerHTML = [...groups.error, ...groups.warning].map(w => `
        <div class="notif-item notif-${w.level}">
            <span class="notif-item-icon">${w.level === 'error' ? '⛔' : '⚠️'}</span>
            <span class="notif-item-text">${escapeHtmlSys(w.message)}</span>
        </div>
    `).join('');
}

function toggleNotifPanel() {
    const panel = document.getElementById('notif-panel');
    if (panel) panel.classList.toggle('open');
}

// Close notification panel on outside click
document.addEventListener('click', e => {
    const wrap = document.getElementById('notif-bell-wrap');
    if (wrap && !wrap.contains(e.target)) {
        document.getElementById('notif-panel')?.classList.remove('open');
    }
});


// ==================== System Control ====================
async function toggleSystem(enabled) {
    const result = await api('/api/system/toggle', { enabled });
    if (result.status === 'ok') {
        await loadAllData();
        renderSystemPage();
        showNotification(result.message, 'success');
    } else {
        showNotification('Failed to toggle system', 'error');
    }
}

function updateSystemStatus() {
    const enabled  = globalConfig?.system?.enabled !== false;
    const isAdmin  = !currentUser || currentUser.role === 'admin';
    const statusEl = document.getElementById('system-status');
    const textEl   = document.getElementById('status-text');
    const toggleEl = document.getElementById('system-toggle');
    const statusTextEl = document.getElementById('system-status-text');

    if (statusEl) {
        statusEl.className = 'status-indicator';
        if (!enabled) statusEl.classList.add('offline');
    }
    if (textEl) textEl.textContent = enabled ? 'System Online' : 'System Offline';
    if (toggleEl) {
        toggleEl.checked  = enabled;
        toggleEl.disabled = !isAdmin;
    }
    if (statusTextEl) {
        statusTextEl.textContent = enabled
            ? '✅ System is online. All bots, collections, and YouTube monitors are operational.'
            : '⛔ System is offline. All bot operations and YouTube processing are suspended.';
    }
}

function renderSystemPage() {
    const container = document.getElementById('system-bots-list');
    if (!container) return;

    const isAdmin     = !currentUser || currentUser.role === 'admin';
    const hasBotAccess = isAdmin || !!currentUser?.has_bot_access;
    const hasYt        = isAdmin || !!currentUser?.youtube_on;

    // Show/hide admin-only controls
    const hide = (id, hidden) => { const el = document.getElementById(id); if (el) el.style.display = hidden ? 'none' : ''; };
    hide('sys-add-bot-btn',          !isAdmin);
    hide('sys-news-section-title',   !hasBotAccess);
    hide('sys-yt-section-title',     !hasYt);
    hide('system-yt-overview',       !hasYt);

    hide('sys-news-stats', !hasBotAccess);

    const bots = globalConfig.bots || {};

    if (!hasBotAccess || Object.keys(bots).length === 0) {
        container.innerHTML = hasBotAccess
            ? `<div class="create-bot-card">
                <h3>No bots configured yet</h3>
                <p class="text-muted">Create your first bot to get started</p>
                <button class="btn btn-primary mt-2" onclick="showPage('bots')"><span>➕</span> Create First Bot</button>
               </div>`
            : `<div class="card" style="text-align:center;padding:32px 20px">
                <div style="font-size:32px;margin-bottom:10px">🔒</div>
                <p class="text-muted">No bots have been shared with your account yet.</p>
                <p class="text-muted" style="font-size:12px;margin-top:4px">Contact the admin to request access.</p>
               </div>`;
        updateSystemStatus();
        if (!isAdmin) renderUserChannelsCard();
        if (hasYt) renderYoutubeOverview();
        return;
    }

    container.innerHTML = Object.entries(bots)
        .map(([name, bot]) => createBotDetailCard(name, bot))
        .join('');

    updateStats();
    updateSystemStatus();
    if (hasYt) renderYoutubeOverview();
}

// ── User Channel Access Card ──────────────────────────────────────────────────

let _userChOpen = false;
function toggleUserChCard() {
    _userChOpen = !_userChOpen;
    const body = document.getElementById('user-ch-body');
    const icon = document.getElementById('user-ch-toggle-icon');
    if (body) body.style.display = _userChOpen ? 'block' : 'none';
    if (icon) icon.textContent   = _userChOpen ? '▼' : '▶';
}

function renderUserChannelsCard(targetId) {
    const el = document.getElementById(targetId || 'sys-user-channels');
    if (!el) return;

    const collections = globalConfig.collections || {};
    const entries = Object.entries(collections);

    if (!entries.length) {
        el.innerHTML = `
        <div class="ch-val-card">
            <div class="ch-val-header">
                <div class="ch-val-title">
                    <span style="font-size:20px">📡</span>
                    <h3 style="margin:0">Subscribed Channels</h3>
                </div>
            </div>
            <div class="ch-val-body" style="display:block;padding:12px 16px">
                <p class="text-muted" style="font-size:13px;margin:0">No channels have been shared with your account yet. Contact the admin to request access.</p>
            </div>
        </div>`;
        return;
    }

    let totalChannels = 0;
    const sections = entries.map(([collName, coll]) => {
        const sources = coll.source_channels || [];
        totalChannels += sources.length;

        const chips = sources.length
            ? sources.map(ch => {
                const display = ch.startsWith('@') ? ch : (ch.toString().startsWith('-') ? ch : `@${ch}`);
                return `<span class="ch-val-badge info" style="margin:2px 4px 2px 0">${escapeHtmlSys(display)}</span>`;
              }).join('')
            : `<span style="font-size:12px;color:var(--text-muted)">No source channels</span>`;

        const statusBadge = coll.enabled === false
            ? `<span class="ch-val-badge warn">● Paused</span>`
            : `<span class="ch-val-badge ok">● Active</span>`;

        return `
        <div class="ch-val-collection">
            <div class="ch-val-collection-name" style="display:flex;align-items:center;gap:8px">
                📦 ${escapeHtmlSys(collName)} ${statusBadge}
            </div>
            <div style="margin-top:6px;display:flex;flex-wrap:wrap">${chips}</div>
        </div>`;
    }).join('');

    const subtitle = `${totalChannels} source channel${totalChannels !== 1 ? 's' : ''} across ${entries.length} collection${entries.length !== 1 ? 's' : ''}`;

    el.innerHTML = `
    <div class="ch-val-card">
        <div class="ch-val-header" onclick="toggleUserChCard()" style="cursor:pointer">
            <div class="ch-val-title">
                <span class="ch-val-toggle-icon" id="user-ch-toggle-icon">▶</span>
                <h3>📡 Subscribed Channels</h3>
                <span class="text-muted" style="font-size:0.8rem;margin-left:8px">${escapeHtmlSys(subtitle)}</span>
            </div>
        </div>
        <div class="ch-val-body" id="user-ch-body" style="display:none">
            ${sections}
        </div>
    </div>`;
}


async function restartBotProcess(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Restarting…'; }
    const r = await api('/api/system/restart', {});
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Restart Bot to Apply'; }
    if (r.status === 'ok') {
        showNotification('Bot restarted successfully', 'success');
        await checkTelegramSessionStatus();
    } else {
        showAlert(r.message || 'Failed to restart bot');
    }
}

async function renderYoutubeOverview() {
    const container = document.getElementById('system-yt-overview');
    if (!container) return;
    try {
        const res = await api('/api/youtube/overview');
        if (res.status !== 'ok') { container.innerHTML = '<p class="text-muted">YouTube Monitor not available</p>'; return; }
        const ch = res.channels || {};
        const kw = res.keywords || {};
        const q  = res.queue || {};
        const today = res.today || {};
        const totalSummaries = res.summaries_total || 0;

        const subLine = (on, total) => {
            const off = total - on;
            return off > 0
                ? `<span style="color:var(--success)">${on} on</span> / <span style="color:var(--danger)">${off} off</span>`
                : `<span style="color:var(--success)">all active</span>`;
        };

        const queueSub = () => {
            const parts = [];
            if (q.pending)    parts.push(`<span style="color:var(--warning)">${q.pending} pending</span>`);
            if (q.processing) parts.push(`<span style="color:var(--info)">${q.processing} in progress</span>`);
            if (q.failed)     parts.push(`<span style="color:var(--danger)">${q.failed} failed</span>`);
            return parts.length ? parts.join(' · ') : `<span style="color:var(--success)">all clear</span>`;
        };

        container.innerHTML = `
            <div class="stats-grid" style="margin-bottom:16px">
                <div class="stat-card">
                    <div class="stat-icon">📡</div>
                    <div class="stat-content">
                        <div class="stat-value">${ch.total || 0}</div>
                        <div class="stat-label">Channels</div>
                        <div class="stat-sub">${subLine(ch.active||0, ch.total||0)}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">🔑</div>
                    <div class="stat-content">
                        <div class="stat-value">${kw.total || 0}</div>
                        <div class="stat-label">SEOs</div>
                        <div class="stat-sub">${subLine(kw.active||0, kw.total||0)}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">📄</div>
                    <div class="stat-content">
                        <div class="stat-value">${totalSummaries}</div>
                        <div class="stat-label">Summaries</div>
                        <div class="stat-sub">${today.done_today||0} today</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">📥</div>
                    <div class="stat-content">
                        <div class="stat-value">${q.done || 0}</div>
                        <div class="stat-label">Queue Done</div>
                        <div class="stat-sub">${queueSub()}</div>
                    </div>
                </div>
            </div>
            <div style="text-align:right">
                <button class="btn btn-primary btn-sm" onclick="showPage('youtube')">Open YouTube Monitor →</button>
            </div>
        `;
    } catch (e) {
        container.innerHTML = '';
    }
}

function createBotDetailCard(name, bot) {
    const catEntries = Object.entries(bot.categories || {});
    const collectionsCount = (bot.collections || []).length;

    const totalCats = catEntries.length;
    let enabledCats = 0, totalTopics = 0, enabledTopics = 0;

    // Single pass over categories: collect totals AND build per-category breakdown rows
    const catRowParts = [];
    for (let i = 0; i < catEntries.length; i++) {
        const [catName, cat] = catEntries[i];
        const catOn = cat.enabled !== false;
        if (catOn) enabledCats++;
        let tCount = 0, tOn = 0;
        const topics = cat.topics || {};
        for (const tName in topics) {
            tCount++;
            if (topics[tName].enabled !== false) tOn++;
        }
        totalTopics += tCount;
        enabledTopics += tOn;
        const tOff = tCount - tOn;
        const dotColor = catOn ? 'var(--success)' : 'var(--danger)';
        const topicStr = tCount === 0 ? '—'
            : `${tOn} on` + (tOff > 0 ? ` / <span style="color:var(--danger);">${tOff} off</span>` : '');
        catRowParts.push(`<div class="sys-cat-row">
            <span style="color:${dotColor};font-size:10px;flex-shrink:0;">●</span>
            <span class="sys-cat-name">${escapeHtmlSys(catName)}</span>
            <span class="sys-cat-topics">${topicStr} topics</span>
        </div>`);
    }
    const disabledCats   = totalCats   - enabledCats;
    const disabledTopics = totalTopics - enabledTopics;

    const countHtml = (on, off) =>
        `<span style="color:var(--success);font-weight:600;">${on} on</span>`
        + (off > 0 ? ` / <span style="color:var(--danger);font-weight:600;">${off} off</span>` : '');

    const catRows = catRowParts.join('');

    return `
        <div class="bot-detail-card">
            <div class="bot-detail-header">
                <div class="flex-center">
                    <h4>🤖 ${escapeHtmlSys(name)}</h4>
                    <span class="bot-status-badge ${bot.enabled !== false ? 'active' : 'inactive'}">
                        ${bot.enabled !== false ? '✓ Active' : '○ Inactive'}
                    </span>
                </div>
                <button class="btn btn-primary btn-sm" onclick="navigateToBotConfig('${escapeHtmlSys(name)}')">
                    Configure →
                </button>
            </div>
            <div class="bot-detail-stats">
                <div class="stat-item">
                    <span class="stat-label">Collections:</span>
                    <span class="stat-value">${collectionsCount}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Categories:</span>
                    <span>${totalCats} total — ${countHtml(enabledCats, disabledCats)}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Topics:</span>
                    <span>${totalTopics} total — ${countHtml(enabledTopics, disabledTopics)}</span>
                </div>
            </div>
            ${catRows ? `<div class="sys-cat-breakdown">${catRows}</div>` : ''}
        </div>
    `;
}

// escapeHtmlSys, jsAttr → shared/api.js

function navigateToBotConfig(botName) {
    showPage('bots');
    setTimeout(() => {
        const card = document.getElementById(`bot-${botName}`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            card.style.boxShadow = '0 0 0 3px #3b82f6';
            setTimeout(() => card.style.boxShadow = '', 2000);
        }
    }, 100);
}

function getTotalTopicsInBot(bot) {
    let total = 0;
    const categories = bot.categories || {};
    for (const category of Object.values(categories)) {
        total += Object.keys(category.topics || {}).length;
    }
    return total;
}

function getTotalCategories() {
    let total = 0;
    const bots = globalConfig.bots || {};
    for (const bot of Object.values(bots)) {
        total += Object.keys(bot.categories || {}).length;
    }
    return total;
}

function getTotalTopics() {
    let total = 0;
    const bots = globalConfig.bots || {};
    for (const bot of Object.values(bots)) {
        const categories = bot.categories || {};
        for (const category of Object.values(categories)) {
            total += Object.keys(category.topics || {}).length;
        }
    }
    return total;
}

function updateStats() {
    const bots = globalConfig.bots || {};
    const collections = globalConfig.collections || {};

    const totalBots = Object.keys(bots).length;
    const activeBots = Object.values(bots).filter(b => b.enabled !== false).length;

    const totalColls = Object.keys(collections).length;
    const enabledColls = Object.values(collections).filter(c => c.enabled !== false).length;

    let totalCats = 0, enabledCats = 0, totalTopics = 0, enabledTopics = 0;
    for (const botName in bots) {
        const cats = bots[botName].categories || {};
        for (const catName in cats) {
            const cat = cats[catName];
            totalCats++;
            if (cat.enabled !== false) enabledCats++;
            const topics = cat.topics || {};
            for (const topicName in topics) {
                totalTopics++;
                if (topics[topicName].enabled !== false) enabledTopics++;
            }
        }
    }

    const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    const setSub = (id, on, total) => {
        const e = document.getElementById(id);
        if (!e) return;
        const off = total - on;
        e.innerHTML = off > 0
            ? `<span style="color:var(--success)">${on} on</span> / <span style="color:var(--danger)">${off} off</span>`
            : `<span style="color:var(--success)">all enabled</span>`;
    };

    set('total-bots', totalBots);
    setSub('stat-sub-bots', activeBots, totalBots);
    set('total-collections', totalColls);
    setSub('stat-sub-collections', enabledColls, totalColls);
    set('total-categories', totalCats);
    setSub('stat-sub-categories', enabledCats, totalCats);
    set('total-topics', totalTopics);
    setSub('stat-sub-topics', enabledTopics, totalTopics);

    set('bots-count', totalBots);
    set('collections-count', totalColls);
}

// Collections page → pages/collections.js

const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }

    /* ==================== Monitor Page ==================== */
    /* collapsible section */
    .mon-section { background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius-lg); margin-bottom:14px; overflow:hidden; }
    .mon-section-hdr { display:flex; justify-content:space-between; align-items:center; padding:13px 18px; font-weight:600; font-size:13px; cursor:pointer; user-select:none; background:var(--bg-tertiary); transition:var(--transition); }
    .mon-section-hdr:hover { background:var(--border-color); }
    .mon-section-body { padding:0; }
    .mon-chevron { font-size:11px; color:var(--text-muted); }
    .mon-empty { padding:20px; text-align:center; color:var(--text-muted); font-size:13px; }

    /* bot card */
    .mon-bot-card { background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius-lg); margin-bottom:14px; overflow:hidden; }
    .mon-bot-hdr { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:13px 18px; background:var(--bg-secondary); border-bottom:1px solid var(--border-color); font-weight:700; font-size:14px; }
    .mon-bot-dot-on  { font-size:10px; color:var(--success); }
    .mon-bot-dot-off { font-size:10px; color:var(--danger); }

    /* category */
    .mon-cat-hdr { padding:6px 18px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); background:var(--bg-primary); border-bottom:1px solid var(--border-color); }

    /* topic block */
    .mon-topic-block { border-bottom:1px solid var(--border-color); }
    .mon-topic-block:last-child { border-bottom:none; }
    .mon-topic-title { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 18px 4px; font-weight:600; font-size:13px; color:var(--text-primary); text-transform:capitalize; }
    .mon-topic-off { opacity:0.45; }

    /* schedule row */
    .mon-sch-row { display:flex; align-items:center; justify-content:space-between; padding:6px 18px 6px 32px; gap:12px; flex-wrap:wrap; }
    .mon-sch-row:last-child { padding-bottom:10px; }
    .mon-sch-left { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .mon-sch-icon { font-size:14px; }
    .mon-sch-name { font-size:12px; font-weight:600; color:var(--text-primary); }
    .mon-sch-prompt { font-size:10px; padding:1px 7px; border-radius:20px; background:rgba(59,130,246,0.12); color:#93c5fd; font-weight:600; }
    .mon-sch-spec { font-size:11px; color:var(--text-muted); }
    .mon-sch-disabled { opacity:0.4; }

    .mon-sch-right { display:flex; align-items:center; gap:10px; flex-shrink:0; }
    .mon-pending { font-size:11px; font-weight:700; padding:2px 9px; border-radius:20px; white-space:nowrap; }
    .mon-pending.has  { background:rgba(16,185,129,0.15); color:#34d399; }
    .mon-pending.none { background:rgba(100,116,139,0.12); color:var(--text-muted); }
.mon-next-label { font-size:10px; color:var(--text-muted); }
    .mon-countdown { font-size:12px; font-weight:700; color:var(--success); min-width:60px; text-align:right; }
    .mon-countdown.urgent { color:var(--warning); }
    .mon-next-time { font-size:11px; color:var(--text-muted); min-width:38px; text-align:right; }

    /* shared table style */
    .mon-table { width:100%; border-collapse:collapse; font-size:12px; }
    .mon-table th { padding:8px 12px; text-align:left; color:var(--text-muted); font-weight:600; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .mon-table td { padding:7px 12px; border-bottom:1px solid rgba(45,55,72,0.4); vertical-align:top; color:var(--text-secondary); }
    .mon-table tr:last-child td { border-bottom:none; }
    .mon-table tr:hover td { background:var(--bg-tertiary); }
    .sch-timeline-table thead { position:sticky; top:0; z-index:1; }
    .sch-timeline-table thead th { background:var(--bg-secondary); }
    .sch-date-sep td { background:var(--bg-tertiary); color:var(--text-muted); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; padding:5px 12px; border-bottom:1px solid var(--border-color); }
    .sch-date-sep:hover td { background:var(--bg-tertiary) !important; cursor:default; }
    .mon-ellipsis { max-width:300px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .mon-type-badge { font-size:10px; font-weight:700; padding:2px 7px; border-radius:20px; white-space:nowrap; }
    .mon-type-badge.hourly { background:rgba(59,130,246,0.18); color:#60a5fa; }
    .mon-type-badge.daily  { background:rgba(139,92,246,0.18); color:#a78bfa; }
    .mon-type-badge.minute { background:rgba(245,158,11,0.18); color:#fbbf24; }

    /* messages section */
    .mon-coll-hdr { padding:9px 14px; font-weight:700; font-size:12px; color:var(--accent-primary); background:var(--bg-tertiary); border-bottom:1px solid var(--border-color); }
    .mon-ch-hdr   { padding:6px 14px; font-size:11px; color:var(--text-muted); background:var(--bg-secondary); border-bottom:1px solid var(--border-color); }
    .mon-tag { display:inline-block; font-size:10px; padding:1px 6px; border-radius:10px; background:rgba(59,130,246,0.13); color:#93c5fd; margin:1px; }
    .mon-tag.cat { background:rgba(139,92,246,0.13); color:#c4b5fd; }

    /* tab bar */
    .mon-tab-bar { display:flex; gap:2px; padding:12px 16px 0; background:var(--bg-secondary); border-bottom:1px solid var(--border-color); }
    .mon-tab { padding:7px 20px; border:none; border-radius:6px 6px 0 0; background:transparent; color:var(--text-muted); cursor:pointer; font-size:13px; font-weight:500; transition:all 0.15s; border-bottom:2px solid transparent; margin-bottom:-1px; }
    .mon-tab:hover { color:var(--text-primary); background:var(--bg-tertiary); }
    .mon-tab.active { color:var(--accent-primary); background:var(--bg-card); border-bottom:2px solid var(--accent-primary); font-weight:600; }
    .mon-tab-panel { padding:16px; }
    .mon-uncl-badge { display:inline-block; background:var(--danger); color:#fff; font-size:10px; font-weight:700; min-width:18px; height:18px; line-height:18px; text-align:center; border-radius:9px; padding:0 5px; margin-left:4px; vertical-align:middle; }
    .mon-uncl-stats-bar { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
    .uncl-word-groups { display:flex; flex-direction:column; gap:12px; }
    .uncl-word-group { border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; }
    .uncl-word-hdr { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:var(--bg-tertiary); cursor:pointer; user-select:none; }
    .uncl-word-hdr:hover { background:var(--bg-hover); }
    .uncl-word-label { font-weight:600; font-size:14px; color:var(--accent-primary); }
    .uncl-word-count { font-size:12px; color:var(--text-muted); }
    .uncl-word-group mark { background:var(--accent-primary); color:#fff; padding:0 2px; border-radius:2px; }
    .mon-filter-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px 0 14px; border-bottom:1px solid var(--border-color); margin-bottom:14px; }
    .mon-filter-sel { min-width:130px; max-width:180px; height:32px; font-size:12px; padding:0 8px; }
    .mon-filter-search { flex:1; min-width:160px; max-width:320px; height:32px; font-size:12px; padding:0 10px; }
    .mon-sort-label { display:flex; align-items:center; gap:5px; font-size:12px; color:var(--text-muted); cursor:pointer; user-select:none; }
    .mon-sort-label input { accent-color:var(--accent-primary); }
    .mon-sch-topic { font-size:11px; background:var(--accent-primary); color:#fff; padding:1px 7px; border-radius:10px; white-space:nowrap; }

    /* multi-select dropdown */
    .mon-multi-select { position:relative; display:inline-block; }
    .mon-ms-btn { display:flex; align-items:center; justify-content:space-between; gap:6px; cursor:pointer; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .mon-ms-arrow { font-size:10px; flex-shrink:0; }
    .mon-ms-dropdown { display:none; position:absolute; top:100%; left:0; min-width:200px; max-height:280px; overflow-y:auto; background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius-md); box-shadow:var(--shadow-lg); z-index:100; padding:4px 0; margin-top:2px; }
    .mon-multi-select.open .mon-ms-dropdown { display:block; }
    .mon-ms-item { display:flex; align-items:center; gap:8px; padding:5px 12px; font-size:12px; color:var(--text-secondary); cursor:pointer; transition:background 0.1s; }
    .mon-ms-item:hover { background:var(--bg-tertiary); }
    .mon-ms-item input { accent-color:var(--accent-primary); flex-shrink:0; }
    .mon-ms-item.all-item { font-weight:600; color:var(--text-primary); border-bottom:1px solid var(--border-color); margin-bottom:2px; }
    .rules-row { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
    .rules-row:last-child { margin-bottom:0; }
    .rules-input { flex:1; min-width:0; height:32px; font-size:13px; }
    .rules-arrow { color:var(--text-muted); font-size:14px; flex-shrink:0; }

    /* Export column picker */
    .export-col-item { display:flex; align-items:center; gap:9px; padding:7px 10px; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; color:var(--text-secondary); transition:background 0.1s; user-select:none; }
    .export-col-item:hover { background:var(--bg-tertiary); }
    .export-col-item input[type=checkbox] { accent-color:var(--accent-primary); cursor:pointer; width:14px; height:14px; flex-shrink:0; }
    .export-col-all { font-weight:600; color:var(--text-primary); border-bottom:1px solid var(--border-color); border-radius:0; margin-bottom:2px; }
`;
document.head.appendChild(style);

// ── Privacy / Legal page loader ─────────────────────────────────────────────

let _privacyLoaded = false;

function loadPrivacyPage() {
    if (_privacyLoaded) return;
    const card = document.getElementById('privacy-card');
    if (!card) return;

    function inlineRender(text) {
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g,
            '<a href="mailto:$1">$1</a>');
        return text;
    }

    fetch('/static/privacy_policy.txt?_=' + Date.now())
        .then(r => { if (!r.ok) throw new Error(); return r.text(); })
        .then(raw => {
            const lines = raw.split('\n');
            let i = 0;
            // Skip title + effective date lines (already in page header)
            let skipped = 0;
            while (i < lines.length && skipped < 2) {
                if (lines[i].trim()) skipped++;
                i++;
            }
            // Build blocks
            const blocks = [];
            let cur = [];
            while (i < lines.length) {
                const l = lines[i++];
                if (l.trim() === '') { if (cur.length) { blocks.push(cur); cur = []; } }
                else cur.push(l);
            }
            if (cur.length) blocks.push(cur);

            let html = '';
            for (const block of blocks) {
                const first = block[0].trim();
                if (first.startsWith('# ')) {
                    html += `<h4>${inlineRender(first.slice(2).trim())}</h4>`;
                    if (block.length > 1)
                        html += `<p>${inlineRender(block.slice(1).map(l => l.trim()).join(' '))}</p>`;
                } else if (block.every(l => l.trim().startsWith('- '))) {
                    html += '<ul>' + block.map(l => `<li>${inlineRender(l.trim().slice(2))}</li>`).join('') + '</ul>';
                } else {
                    html += `<p>${inlineRender(block.map(l => l.trim()).join(' '))}</p>`;
                }
            }
            card.innerHTML = html;
            _privacyLoaded = true;
        })
        .catch(() => {
            card.innerHTML = '<p class="text-muted">Could not load Privacy Policy.</p>';
        });
}
