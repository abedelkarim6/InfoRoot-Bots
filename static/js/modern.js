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

// ==================== Custom Dialogs ====================
function showAlert(message, { title = 'Notice', icon = 'ℹ️' } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog-box" role="dialog" aria-modal="true">
            <span class="dialog-icon">${icon}</span>
            <div class="dialog-title">${title}</div>
            <div class="dialog-message">${message}</div>
            <div class="dialog-actions" style="justify-content:center;">
                <button class="btn btn-primary dialog-ok">OK</button>
            </div>
        </div>
    `;
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-ok').addEventListener('click', close);
    overlay.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') close(); });
    document.body.appendChild(overlay);
    overlay.querySelector('.dialog-ok').focus();
}

function showConfirm(message, onConfirm, { title = 'Confirm', icon = '⚠️', confirmLabel = 'Delete', confirmClass = 'btn-danger' } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog-box" role="dialog" aria-modal="true">
            <span class="dialog-icon">${icon}</span>
            <div class="dialog-title">${title}</div>
            <div class="dialog-message">${message}</div>
            <div class="dialog-actions">
                <button class="btn btn-secondary dialog-cancel">Cancel</button>
                <button class="btn ${confirmClass} dialog-confirm">${confirmLabel}</button>
            </div>
        </div>
    `;
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-cancel').addEventListener('click', close);
    overlay.querySelector('.dialog-confirm').addEventListener('click', () => { close(); onConfirm(); });
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') { close(); onConfirm(); }
    });
    document.body.appendChild(overlay);
    overlay.querySelector('.dialog-cancel').focus();
}

function showPrompt(title, defaultValue, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog-box" role="dialog" aria-modal="true">
            <span class="dialog-icon">✏️</span>
            <div class="dialog-title">${title}</div>
            <div class="dialog-message">
                <input type="text" class="input dialog-input" value="${escapeHtmlSys(defaultValue)}" style="width:100%;margin-top:8px;">
            </div>
            <div class="dialog-actions">
                <button class="btn btn-secondary dialog-cancel">Cancel</button>
                <button class="btn btn-primary dialog-confirm">Save</button>
            </div>
        </div>
    `;
    const close = () => overlay.remove();
    const input = overlay.querySelector('.dialog-input');
    overlay.querySelector('.dialog-cancel').addEventListener('click', close);
    overlay.querySelector('.dialog-confirm').addEventListener('click', () => { close(); onConfirm(input.value); });
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') { close(); onConfirm(input.value); }
    });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
}

// ==================== Global State ====================
let globalConfig = null;
let globalPrompts = null;

// Collection modal state
let modalSources = [];
let modalTargets = [];
let _channelValidation = {}; // { '@channel': 'ok'|'warn'|'pending' }
let _pickerChannels = [];    // cached joined channels for the picker dropdown
let _pickerCloser  = null;   // document click handler to close picker

// SEO hidden mode: tracks keywords added by the user this session (not visible from server)
// keyed by "botName|catName|topicName" → string[]
const _userAddedKeywords = {};

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

// ==================== API Helper ====================
async function api(path, body) {
    const options = {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    try {
        const response = await fetch(path, options);
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            return { status: 'error', message: text || `Server error (${response.status})` };
        }
    } catch (error) {
        console.error('API Error:', error);
        return { status: 'error', message: error.message };
    }
}

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

function showPage(pageName) {
    // Stop log auto-refresh when leaving the logs page
    if (pageName !== 'logs') {
        clearTimeout(_logsTimer);
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
        _currentBotDetail = null;
        _showBotsListView();
    }
    else if (pageName === 'monitor') loadMonitorData();
    else if (pageName === 'dashboard') loadDashboardData();
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
        globalConfig = await api('/api/config');
        globalPrompts = await api('/api/prompts');
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

    let totalCats = catEntries.length;
    let enabledCats = catEntries.filter(([, c]) => c.enabled !== false).length;
    let totalTopics = 0, enabledTopics = 0;
    catEntries.forEach(([, cat]) => {
        const topicEntries = Object.entries(cat.topics || {});
        totalTopics += topicEntries.length;
        enabledTopics += topicEntries.filter(([, t]) => t.enabled !== false).length;
    });
    const disabledCats   = totalCats   - enabledCats;
    const disabledTopics = totalTopics - enabledTopics;

    const countHtml = (on, off) =>
        `<span style="color:var(--success);font-weight:600;">${on} on</span>`
        + (off > 0 ? ` / <span style="color:var(--danger);font-weight:600;">${off} off</span>` : '');

    // Per-category breakdown rows
    const catRows = catEntries.map(([catName, cat]) => {
        const topicEntries = Object.entries(cat.topics || {});
        const catOn  = cat.enabled !== false;
        const tOn    = topicEntries.filter(([, t]) => t.enabled !== false).length;
        const tOff   = topicEntries.length - tOn;
        const dotColor = catOn ? 'var(--success)' : 'var(--danger)';
        const topicStr = topicEntries.length === 0 ? '—'
            : `${tOn} on` + (tOff > 0 ? ` / <span style="color:var(--danger);">${tOff} off</span>` : '');
        return `<div class="sys-cat-row">
            <span style="color:${dotColor};font-size:10px;flex-shrink:0;">●</span>
            <span class="sys-cat-name">${escapeHtmlSys(catName)}</span>
            <span class="sys-cat-topics">${topicStr} topics</span>
        </div>`;
    }).join('');

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

// lightweight escaper for system page (escapeHtml defined later in monitor block)
function escapeHtmlSys(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Escape a string for safe use inside single-quoted inline JS attributes (onclick, onkeydown, etc.) */
function jsAttr(str) {
    if (str == null) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

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
    for (const bot of Object.values(bots)) {
        for (const [, cat] of Object.entries(bot.categories || {})) {
            totalCats++;
            if (cat.enabled !== false) enabledCats++;
            for (const [, topic] of Object.entries(cat.topics || {})) {
                totalTopics++;
                if (topic.enabled !== false) enabledTopics++;
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

// ==================== Collections Page ====================
function renderCollectionsPage() {
    const container = document.getElementById('collections-container');
    if (!container) return;

    const collections = globalConfig.collections || {};

    if (Object.keys(collections).length === 0) {
        container.innerHTML = `
            <div class="create-bot-card">
                <h3>No collections yet</h3>
                <p class="text-muted">Create a collection to group source and target channels</p>
                <button class="btn btn-primary mt-2" onclick="showAddCollectionModal()">
                    <span>➕</span> Create First Collection
                </button>
            </div>
        `;
        return;
    }

    container.innerHTML = Object.entries(collections)
        .map(([name, collection]) => createCollectionCard(name, collection))
        .join('');
}

function createCollectionCard(collectionName, collection) {
    const sources = (collection.source_channels || []).join(', ') || 'None';
    const targets = (collection.target_channels || [collection.target_channel]).filter(Boolean).join(', ') || 'Not set';

    const safeCollId = 'coll-card-' + collectionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `
        <div class="collection-card" id="${safeCollId}">
            <div class="collection-header">
                <div class="flex-center">
                    <label class="toggle-switch">
                        <input type="checkbox" ${collection.enabled ? 'checked' : ''}
                               onchange="toggleCollection('${collectionName}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <h3>${escapeHtmlSys(collectionName)}</h3>
                </div>
                <div class="collection-actions">
                    <button class="btn btn-secondary btn-sm" onclick="editCollection('${collectionName}')">
                        ✏️ Edit
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteCollection('${collectionName}')">
                        🗑️ Delete
                    </button>
                </div>
            </div>
            <div class="collection-body">
                <div class="collection-info">
                    <div class="info-row">
                        <span class="info-label">📥 Sources:</span>
                        <span class="info-value">${sources}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">📤 Targets:</span>
                        <span class="info-value">${targets}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function toggleCollection(collectionName, enabled) {
    const result = await api('/api/collection/toggle', { collection_name: collectionName, enabled });
    if (result.status === 'ok') {
        globalConfig.collections[collectionName].enabled = enabled;
        showNotification('Collection updated', 'success');
    } else {
        showNotification('Failed to update collection', 'error');
    }
}

// ==================== Channel Membership Validator ====================
let _chValOpen = false;

function toggleChValCard() {
    _chValOpen = !_chValOpen;
    const body = document.getElementById('ch-val-body');
    const icon = document.getElementById('ch-val-toggle-icon');
    if (body) body.style.display = _chValOpen ? 'block' : 'none';
    if (icon) icon.textContent = _chValOpen ? '▼' : '▶';
}

async function validateChannels(e) {
    if (e) e.stopPropagation();

    // Open the card if closed
    if (!_chValOpen) {
        _chValOpen = true;
        const body = document.getElementById('ch-val-body');
        const icon = document.getElementById('ch-val-toggle-icon');
        if (body) body.style.display = 'block';
        if (icon) icon.textContent = '▼';
    }

    const btn  = document.getElementById('ch-val-btn');
    const body = document.getElementById('ch-val-body');
    if (!body) return;

    if (btn) { btn.textContent = '⏳ Loading…'; btn.disabled = true; }
    body.innerHTML = '<p class="mon-empty">Loading cached channel data…</p>';

    const data = await api('/api/telegram/admin_channels');

    if (btn) { btn.textContent = '🔍 Validate'; btn.disabled = false; }

    if (!data || data.status === 'error') {
        body.innerHTML = `<p class="mon-empty" style="color:#ef4444">Error: ${data?.message || 'Failed to load'}</p>`;
        return;
    }

    // Build lookup by username AND by raw entity id (Telethon returns id without -100 prefix)
    const joined = {};
    (data.channels || []).forEach(ch => {
        if (ch.username) joined[ch.username.toLowerCase()] = ch;
        joined['id:' + ch.id] = ch;
    });

    // Resolve a config channel string (@username or numeric ID) to its entry in `joined`
    function resolveJoined(raw) {
        const stripped = raw.replace(/^@/, '').trim();
        if (/^-?\d+$/.test(stripped)) {
            const num = parseInt(stripped, 10);
            // Bot API format: -100XXXXXXXXX → Telethon entity.id = XXXXXXXXX (strip -100 prefix)
            if (num < 0) {
                const s = String(-num);
                const entityId = s.startsWith('100') ? parseInt(s.slice(3)) : -num;
                return joined['id:' + entityId] || null;
            }
            return joined['id:' + num] || null;
        }
        return joined[stripped.toLowerCase()] || null;
    }

    // Track all configured channel keys for the "extra" section
    const allConfiguredKeys = new Set();

    // ── Section 1: Grouped by collection ──
    let totalConfigured = 0, totalJoined = 0;

    const collectionSections = Object.entries(globalConfig.collections || {}).map(([collName, coll]) => {
        // Merge source + target, deduplicated by key, preserving both roles
        const channelMap = {};
        const addCh = (raw, role) => {
            const key = raw.replace(/^@/, '').trim().toLowerCase();
            allConfiguredKeys.add(key);
            if (!channelMap[key]) channelMap[key] = { raw, roles: [], ch: resolveJoined(raw) };
            if (!channelMap[key].roles.includes(role)) channelMap[key].roles.push(role);
        };
        (coll.source_channels || []).forEach(ch => addCh(ch, 'source'));
        const targets = coll.target_channels || (coll.target_channel ? [coll.target_channel] : []);
        targets.forEach(ch => addCh(ch, 'target'));

        const rows = Object.values(channelMap).map(({ raw, roles, ch }) => {
            const isJoined = !!ch;
            const isNumeric = /^-?\d+$/.test(raw.replace(/^@/, '').trim());
            totalConfigured++;
            if (isJoined) totalJoined++;

            const roleBadges = roles.map(r =>
                r === 'source'
                    ? '<span class="ch-val-role source">📥 Reads from</span>'
                    : '<span class="ch-val-role target">📤 Posts to</span>'
            ).join('');

            const statusBadge = isJoined
                ? '<span class="ch-val-badge ok">✓ Joined</span>'
                : (isNumeric
                    ? '<span class="ch-val-badge warn">⚠ Not found (numeric ID)</span>'
                    : '<span class="ch-val-badge warn">✗ Not Joined</span>');

            const displayName = ch?.username ? `@${ch.username}` : raw;
            const titleText   = ch ? escapeHtmlSys(ch.title) : '';

            return `
                <div class="ch-val-row">
                    <div class="ch-val-name">
                        <span class="ch-val-at">${displayName}</span>
                        ${titleText ? `<span class="ch-val-title-text">${titleText}</span>` : ''}
                    </div>
                    <div class="ch-val-meta">${roleBadges}${statusBadge}</div>
                </div>`;
        }).join('');

        return `
            <div class="ch-val-collection">
                <div class="ch-val-collection-name">📁 ${escapeHtmlSys(collName)}</div>
                ${rows || '<p class="mon-empty" style="padding:4px 0">No channels configured</p>'}
            </div>`;
    }).join('');

    // ── Section 2: Extra joined channels not in any collection ──
    const extraRows = (data.channels || []).filter(ch => {
        if (!ch.username) return false;
        return !allConfiguredKeys.has(ch.username.toLowerCase());
    }).map(ch => {
        const type = ch.is_broadcast
            ? '<span class="ch-val-role channel">Channel</span>'
            : '<span class="ch-val-role group">Group</span>';
        return `
            <div class="ch-val-row extra">
                <div class="ch-val-name">
                    <span class="ch-val-at">@${ch.username}</span>
                    <span class="ch-val-title-text">${escapeHtmlSys(ch.title)}</span>
                </div>
                <div class="ch-val-meta">${type}<span class="ch-val-badge info">Not in Config</span></div>
            </div>`;
    }).join('');

    const summaryClass = totalJoined < totalConfigured ? 'ch-val-sum-warn' : 'ch-val-sum-ok';
    const extraCount   = (data.channels || []).filter(c => c.username && !allConfiguredKeys.has(c.username.toLowerCase())).length;
    const updatedAt    = data.updated_at
        ? new Date(data.updated_at).toLocaleString()
        : null;

    body.innerHTML = `
        <div class="ch-val-summary ${summaryClass}">
            <span>${totalJoined === totalConfigured
                ? `✅ All ${totalConfigured} configured channels joined`
                : `⚠️ ${totalJoined} of ${totalConfigured} configured channels joined`}</span>
            ${updatedAt ? `<span class="ch-val-updated">cached ${updatedAt}</span>` : ''}
        </div>
        <div class="ch-val-section">
            <div class="ch-val-section-title">Configured channels</div>
            ${collectionSections || '<p class="mon-empty">No collections configured yet.</p>'}
        </div>
        <div class="ch-val-section">
            <div class="ch-val-section-title">Other joined channels <span class="ch-val-count">${extraCount}</span></div>
            ${extraRows || '<p class="mon-empty" style="padding:8px 0">None</p>'}
        </div>`;
}

// ==================== Channel Tag Input Helpers ====================
function renderChannelTags(type) {
    const arr = type === 'source' ? modalSources : modalTargets;
    const containerId = type === 'source' ? 'source-tags' : 'target-tags';
    const container = document.getElementById(containerId);
    if (!container) return;

    const placeholder = type === 'source' ? '+ @channel to read from' : '+ @channel to post into';
    container.innerHTML = arr.map(ch => {
        const state = _channelValidation[ch];
        const badge = state === 'ok'      ? '<span class="tag-status ok" title="Userbot is a member ✓">✓</span>'
                    : state === 'warn'    ? '<span class="tag-status warn" title="Userbot is NOT a member">✗</span>'
                    : state === 'pending' ? '<span class="tag-status pending" title="Checking…">⏳</span>'
                    : '';
        return `<span class="tag">
            ${ch}${badge}
            <span class="tag-remove" onclick="removeChannelTag('${ch.replace(/'/g, "\\'")}', '${type}')">×</span>
        </span>`;
    }).join('') + `<input type="text" class="tag-input" placeholder="${placeholder}"
        onkeydown="handleChannelTagInput(event, '${type}')"
        onblur="commitChannelTagInput(this, '${type}')">`;
}

async function validateChannelTag(ch, type) {
    _channelValidation[ch] = 'pending';
    renderChannelTags(type);
    const res = await api('/api/telegram/check_channel', { channel: ch });
    _channelValidation[ch] = (res && res.joined) ? 'ok' : 'warn';
    renderChannelTags(type);
}

function handleChannelTagInput(event, type) {
    if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        const value = event.target.value.trim().replace(/,/g, '');
        if (value) {
            const arr = type === 'source' ? modalSources : modalTargets;
            if (!arr.includes(value)) {
                arr.push(value);
                validateChannelTag(value, type);
            } else {
                renderChannelTags(type);
            }
        }
    }
}

function commitChannelTagInput(input, type) {
    const value = input.value.trim().replace(/,/g, '');
    if (value) {
        const arr = type === 'source' ? modalSources : modalTargets;
        if (!arr.includes(value)) {
            arr.push(value);
            validateChannelTag(value, type);
        } else {
            renderChannelTags(type);
        }
    }
}

function removeChannelTag(channel, type) {
    if (type === 'source') {
        modalSources = modalSources.filter(c => c !== channel);
    } else {
        modalTargets = modalTargets.filter(c => c !== channel);
    }
    delete _channelValidation[channel];
    renderChannelTags(type);
}

// ==================== Channel Picker Dropdown ====================
function closeChannelPicker() {
    const el = document.getElementById('ch-picker');
    if (el) el.remove();
    if (_pickerCloser) {
        document.removeEventListener('click', _pickerCloser);
        _pickerCloser = null;
    }
}

async function openChannelPicker(event, type) {
    event.stopPropagation();
    // Toggle off if already open for the same type
    const existing = document.getElementById('ch-picker');
    if (existing) {
        if (existing.dataset.pickerType === type) { closeChannelPicker(); return; }
        closeChannelPicker();
    }

    // Lazy-load channels from API
    if (!_pickerChannels.length) {
        const res = await api('/api/telegram/admin_channels');
        if (res && res.status === 'ok') _pickerChannels = res.channels || [];
    }

    const picker = document.createElement('div');
    picker.className = 'ch-picker';
    picker.id = 'ch-picker';
    picker.dataset.pickerType = type;
    _rebuildPickerContent(picker, '', type);
    document.body.appendChild(picker);

    // Position below the button
    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 318)) + 'px';
    picker.style.top  = (rect.bottom + 6) + 'px';

    // Flip above if clipped at bottom
    requestAnimationFrame(() => {
        const pr = picker.getBoundingClientRect();
        if (pr.bottom > window.innerHeight - 16) {
            picker.style.top = (rect.top - pr.height - 6) + 'px';
        }
    });

    picker.querySelector('.ch-picker-search')?.focus();

    _pickerCloser = (e) => { if (!picker.contains(e.target)) closeChannelPicker(); };
    setTimeout(() => document.addEventListener('click', _pickerCloser), 0);
}

function _pickerChannelsForType(type) {
    return type === 'source'
        ? _pickerChannels
        : _pickerChannels.filter(ch => ch.can_post);
}

function _pickerCurrentArr(type) {
    return type === 'source' ? modalSources : modalTargets;
}

function _isInArr(arr, ch) {
    return arr.some(c => {
        const s = c.replace(/^@/, '').toLowerCase();
        return (ch.username && s === ch.username.toLowerCase()) || s === String(ch.id);
    });
}

function _renderPickerItem(ch, currentArr) {
    const display  = ch.username ? '@' + ch.username : '#' + ch.id;
    const selected = _isInArr(currentArr, ch);
    const icon     = ch.is_broadcast ? '📢' : '👥';
    return `<div class="ch-picker-item${selected ? ' selected' : ''}"
                 onclick="togglePickerChannel(${ch.id}, '${(ch.username||'').replace(/'/g,"\\'")}', event)"
                 data-id="${ch.id}" data-username="${ch.username || ''}">
        <div class="ch-picker-check">${selected ? '✓' : ''}</div>
        <div class="ch-picker-info">
            <div class="ch-picker-title">${escapeHtmlSys(ch.title)}</div>
            <div class="ch-picker-sub">${display} ${icon}</div>
        </div>
    </div>`;
}

function _rebuildPickerContent(picker, query, type) {
    const all      = _pickerChannelsForType(type);
    const q        = (query || '').toLowerCase();
    const filtered = q ? all.filter(ch =>
        ch.title.toLowerCase().includes(q) ||
        (ch.username && ch.username.toLowerCase().includes(q))
    ) : all;
    const arr = _pickerCurrentArr(type);
    const label = type === 'source' ? 'all readable' : 'all writable';
    picker.innerHTML = `
        <div class="ch-picker-header">
            <input class="ch-picker-search" type="text" placeholder="Search channels…"
                   value="${escapeHtmlSys(query)}"
                   oninput="filterChannelPicker(this.value)">
        </div>
        <div class="ch-picker-list">
            ${filtered.length
                ? filtered.map(ch => _renderPickerItem(ch, arr)).join('')
                : '<p class="ch-picker-empty">No channels found.<br>Make sure the bot is running.</p>'}
        </div>
        <div class="ch-picker-footer">
            <span>${filtered.length} channel${filtered.length !== 1 ? 's' : ''}</span>
            <button class="btn btn-xs btn-secondary" onclick="addAllFromPicker()">Add ${label}</button>
        </div>`;
}

function filterChannelPicker(query) {
    const picker = document.getElementById('ch-picker');
    if (!picker) return;
    const type = picker.dataset.pickerType;
    _rebuildPickerContent(picker, query, type);
    // Re-focus search after re-render
    const s = picker.querySelector('.ch-picker-search');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

function togglePickerChannel(id, username, event) {
    event.stopPropagation();
    const picker = document.getElementById('ch-picker');
    const type   = picker ? picker.dataset.pickerType : null;
    if (!type) return;

    const arr   = _pickerCurrentArr(type);
    const value = username ? '@' + username : String(id);
    const ch    = { id, username };
    const idx   = arr.findIndex(c => {
        const s = c.replace(/^@/, '').toLowerCase();
        return (username && s === username.toLowerCase()) || s === String(id);
    });

    if (idx >= 0) {
        const removed = arr.splice(idx, 1)[0];
        delete _channelValidation[removed];
    } else {
        arr.push(value);
        validateChannelTag(value, type);
    }
    renderChannelTags(type);

    // Update just this item in the picker without full re-render
    const item      = event.currentTarget;
    const isNow     = _isInArr(arr, ch);
    item.classList.toggle('selected', isNow);
    const check = item.querySelector('.ch-picker-check');
    if (check) check.textContent = isNow ? '✓' : '';
}

function addAllFromPicker() {
    const picker = document.getElementById('ch-picker');
    if (!picker) return;
    const type  = picker.dataset.pickerType;
    const query = picker.querySelector('.ch-picker-search')?.value || '';
    const all   = _pickerChannelsForType(type);
    const q     = query.toLowerCase();
    const filtered = q ? all.filter(ch =>
        ch.title.toLowerCase().includes(q) ||
        (ch.username && ch.username.toLowerCase().includes(q))
    ) : all;
    const arr = _pickerCurrentArr(type);

    filtered.forEach(ch => {
        if (!_isInArr(arr, ch)) {
            const value = ch.username ? '@' + ch.username : String(ch.id);
            arr.push(value);
            validateChannelTag(value, type);
        }
    });
    renderChannelTags(type);
    _rebuildPickerContent(picker, query, type);
    const s = picker.querySelector('.ch-picker-search');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ==================== Collection Modal ====================
function showAddCollectionModal(existingName = null) {
    const existing = existingName ? globalConfig.collections[existingName] : null;

    modalSources = existing ? [...(existing.source_channels || [])] : [];
    modalTargets = existing
        ? [...(existing.target_channels || (existing.target_channel ? [existing.target_channel] : []))]
        : [];
    _channelValidation = {};
    _pickerChannels = [];
    // Pre-validate existing channels in the background
    [...modalSources, ...modalTargets].forEach(ch => {
        const type = modalSources.includes(ch) ? 'source' : 'target';
        validateChannelTag(ch, type);
    });
    // Preload joined channels for the picker
    api('/api/telegram/admin_channels').then(res => {
        if (res && res.status === 'ok') _pickerChannels = res.channels || [];
    });

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'collection-modal';

    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>${existing ? 'Edit Collection' : 'Add Collection'}</h3>
                <button class="btn-icon" onclick="closeModal('collection-modal')">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">Collection Name</label>
                    <input type="text" class="input" id="collection-name"
                           placeholder="e.g., News Sources"
                           value="${existingName || ''}">
                </div>
                <div class="form-group">
                    <div class="form-label-row">
                        <label class="form-label">Source Channels</label>
                        <button type="button" class="btn btn-sm btn-secondary" onclick="openChannelPicker(event, 'source')">📋 Browse joined</button>
                    </div>
                    <div class="tags-container" id="source-tags"></div>
                    <small class="form-hint">Choose from joined channels or type @channel and press Enter.</small>
                </div>
                <div class="form-group">
                    <div class="form-label-row">
                        <label class="form-label">Target Channels</label>
                        <button type="button" class="btn btn-sm btn-secondary" onclick="openChannelPicker(event, 'target')">📋 Browse writable</button>
                    </div>
                    <div class="tags-container" id="target-tags"></div>
                    <small class="form-hint">Only channels where the userbot has write access are shown in Browse.</small>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('collection-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveCollection(${existingName ? `'${existingName}'` : ''})">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    renderChannelTags('source');
    renderChannelTags('target');
}

async function saveCollection(existingName = null) {
    const newName = document.getElementById('collection-name').value.trim();
    const collectionName = newName || existingName;

    // Commit any partially-typed channel in the input fields
    ['source', 'target'].forEach(type => {
        const container = document.getElementById(`${type}-tags`);
        if (container) {
            const input = container.querySelector('.tag-input');
            if (input && input.value.trim()) commitChannelTagInput(input, type);
        }
    });

    const sources = [...new Set(modalSources)];
    const targets = [...new Set(modalTargets)];

    if (!collectionName || !targets.length) {
        showAlert('Collection name and at least one target channel are required', { icon: '⚠️' });
        return;
    }

    // Check for duplicate name when creating new or renaming
    const allNames = Object.keys(globalConfig.collections || {});
    if (newName && newName !== existingName && allNames.includes(newName)) {
        showAlert(`A collection named "${newName}" already exists.`, { icon: '⚠️' });
        return;
    }

    // Rename if the name changed
    if (existingName && newName && newName !== existingName) {
        const renameResult = await api('/api/collection/rename', { old_name: existingName, new_name: newName });
        if (renameResult.status !== 'ok') {
            showAlert(renameResult.message || 'Failed to rename collection', { icon: '⚠️' });
            return;
        }
    }

    const result = await api('/api/collection/save', {
        collection_name: collectionName,
        source_channels: sources,
        target_channels: targets,
        enabled: true
    });

    if (result.status === 'ok') {
        await loadAllData();
        renderCollectionsPage();
        // Re-render bots page too so collection name updates are reflected there
        if (existingName && newName && newName !== existingName) renderBotsPage();
        closeModal('collection-modal');
        showNotification('Collection saved', 'success');
    } else {
        showNotification('Failed to save collection', 'error');
    }
}

function editCollection(collectionName) {
    showAddCollectionModal(collectionName);
}

async function deleteCollection(collectionName) {
    showConfirm(`Delete collection "${collectionName}"?`, async () => {
        const result = await api('/api/collection/delete', { collection_name: collectionName });
        if (result.status === 'ok') {
            await loadAllData();
            renderCollectionsPage();
            loadWarnings();
            showNotification('Collection deleted', 'success');
        } else {
            showAlert(result.message || 'Failed to delete collection', { title: 'Cannot Delete', icon: '⛔' });
        }
    }, { title: 'Delete Collection' });
}

// ==================== Bots Page ====================
let _currentBotDetail = null; // name of bot currently shown in detail view

function renderBotsPage(keepOpen = null) {
    const bots = globalConfig.bots || {};

    // If we're in detail view, refresh just that bot's detail
    if (_currentBotDetail) {
        if (bots[_currentBotDetail]) {
            _renderBotDetailView(_currentBotDetail, bots[_currentBotDetail], keepOpen);
        } else {
            // Bot was deleted — back to list
            _showBotsListView();
        }
        return;
    }

    _renderBotsListView();
}

function _renderBotsListView() {
    const bots = globalConfig.bots || {};
    const container = document.getElementById('bots-container');
    container.innerHTML = '';

    if (Object.keys(bots).length === 0) {
        container.innerHTML = `<p class="text-muted" style="padding:12px 0">No bots yet. Create one above.</p>`;
        return;
    }

    for (const [name, bot] of Object.entries(bots)) {
        container.appendChild(_createBotListCard(name, bot));
    }
}

function _createBotListCard(name, bot) {
    const categories = Object.keys(bot.categories || {});
    const topicCount = categories.reduce((n, c) => n + Object.keys(bot.categories[c].topics || {}).length, 0);
    const card = document.createElement('div');
    card.className = 'bot-list-card';
    card.innerHTML = `
        <div class="bot-list-main" onclick="openBotDetail('${jsAttr(name)}')">
            <div class="bot-list-info">
                <span class="bot-list-icon">🤖</span>
                <div>
                    <div class="bot-list-name">${escapeHtmlSys(name)}</div>
                    <div class="bot-list-meta">
                        ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} &middot;
                        ${topicCount} topic${topicCount === 1 ? '' : 's'}
                    </div>
                </div>
            </div>
            <div class="bot-list-right" onclick="event.stopPropagation()">
                <label class="toggle-switch toggle-sm">
                    <input type="checkbox" ${bot.enabled ? 'checked' : ''}
                           onchange="toggleBotEnabled('${jsAttr(name)}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
                <span class="bot-list-arrow">›</span>
            </div>
        </div>
    `;
    return card;
}

function openBotDetail(name) {
    const bots = globalConfig.bots || {};
    if (!bots[name]) return;
    _currentBotDetail = name;
    _renderBotDetailView(name, bots[name]);
    saveBotsPageScrollPosition();
    window.scrollTo(0, 0);
}

function _showBotsListView() {
    _currentBotDetail = null;
    document.getElementById('bots-list-view').style.display = '';
    document.getElementById('bots-detail-view').style.display = 'none';
    document.getElementById('bots-list-header').style.display = '';
    _renderBotsListView();
}

function _renderBotDetailView(name, bot, keepOpen = null) {
    _currentBotDetail = name;
    document.getElementById('bots-list-view').style.display = 'none';
    document.getElementById('bots-list-header').style.display = 'none';
    document.getElementById('bots-detail-view').style.display = '';

    const container = document.getElementById('bot-detail-container');
    container.innerHTML = '';

    // Back button header
    const header = document.createElement('div');
    header.className = 'bot-detail-header';
    header.innerHTML = `
        <button class="btn btn-secondary btn-sm" onclick="_showBotsListView()">‹ All Bots</button>
        <h2 style="margin:0;font-size:18px">🤖 ${escapeHtmlSys(name)}</h2>
        <label class="toggle-switch" style="margin-left:auto">
            <input type="checkbox" ${bot.enabled ? 'checked' : ''}
                   onchange="toggleBotEnabled('${jsAttr(name)}', this.checked)">
            <span class="toggle-slider"></span>
        </label>
        <button class="btn btn-secondary btn-sm" onclick="renameBot('${jsAttr(name)}')">✏️ Rename</button>
        <button class="btn btn-danger btn-sm" onclick="deleteBot('${jsAttr(name)}')">🗑️ Delete</button>
    `;
    container.appendChild(header);

    // Bot card with tabs (no collapse needed — single bot view)
    const card = createBotConfigCard(name, bot);
    container.appendChild(card);

    setTimeout(() => {
        restoreCollapsibleStates();
        clearStaleCollapsibleStates();
        if (keepOpen) {
            (Array.isArray(keepOpen) ? keepOpen : [keepOpen]).forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('open');
            });
        }
        // If the prompts tab is already active on render, load fixed prompts
        const savedTab = 'categories';
        if (savedTab === 'prompts') {
            const isAdmin = !currentUser || currentUser.role === 'admin';
            if (isAdmin) loadSummariesFixedPrompts();
        }
    }, 50);
}

function createBotConfigCard(name, bot) {
    const card = document.createElement('div');
    card.className = 'bot-config-card';
    card.id = `bot-${name}`;

    const savedTab  = 'categories';
    const tabs      = ['basic', 'rules', 'prompts', 'categories'];
    const tabLabels = { basic: '⚙️ Basic', rules: '🔧 Rules', prompts: '📝 Prompts', categories: '📂 Categories & Topics' };

    const tabHeaders = tabs.map(t => `
        <button class="bot-tab-btn ${savedTab === t ? 'active' : ''}"
                onclick="switchBotTab('${jsAttr(name)}', '${t}')"
                data-tab="${t}">${tabLabels[t]}</button>
    `).join('');

    card.innerHTML = `
        <div class="bot-tab-bar">${tabHeaders}</div>
        <div class="bot-config-body">
            <div class="bot-tab-pane ${savedTab === 'basic'      ? 'active' : ''}" data-tab="basic">
                ${createBasicSettingsSection(name, bot)}
            </div>
            <div class="bot-tab-pane ${savedTab === 'rules'      ? 'active' : ''}" data-tab="rules">
                ${createRulesSection(name, bot)}
            </div>
            <div class="bot-tab-pane ${savedTab === 'prompts'    ? 'active' : ''}" data-tab="prompts">
                ${createPromptsSection(name)}
            </div>
            <div class="bot-tab-pane ${savedTab === 'categories' ? 'active' : ''}" data-tab="categories">
                ${createCategoriesSection(name, bot)}
            </div>
        </div>
    `;

    return card;
}

function switchBotTab(botName, tab) {
    const card = document.getElementById(`bot-${botName}`);
    if (!card) return;
    card.querySelectorAll('.bot-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    card.querySelectorAll('.bot-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
    if (tab === 'prompts') {
        const isAdmin = !currentUser || currentUser.role === 'admin';
        if (isAdmin) loadSummariesFixedPrompts();
    }
}

function createBasicSettingsSection(botName, bot) {
    const collections = bot.collections || [];
    const minMessages = bot.minimum_messages || 5;
    const sectionId = `basic-${botName}`;
    const savedState = loadCollapsibleState(sectionId);
    const defaultOpen = savedState !== null ? savedState : true; // Default open for Basic Settings

    const noCollectionsWarning = Object.keys(globalConfig.collections || {}).length === 0
        ? `<div class="alert alert-info" style="margin-bottom: 16px;">
                <p>ℹ️ Create collections to define target channels for this bot.</p>
            </div>`
        : '';

    return `
        <div class="collapsible-section ${defaultOpen ? 'open' : ''}" id="${sectionId}">
            <div class="collapsible-header" onclick="toggleCollapsible('${sectionId}')">
                <div class="collapsible-title">
                    <span class="icon">⚙️</span>
                    <span>Basic Settings</span>
                </div>
                <span class="collapsible-toggle">▼</span>
            </div>
            <div class="collapsible-content">
                <div class="collapsible-body">
                    ${noCollectionsWarning}
                    <div class="form-group">
                        <label class="form-label">Collections</label>
                        <select class="select" id="collections-select-${botName}"
                                onchange="addCollectionToBot('${botName}', this.value); this.value='';">
                            <option value="">Add collection...</option>
                            ${Object.keys(globalConfig.collections || {}).map(name => `
                                <option value="${name}" ${collections.includes(name) ? 'disabled' : ''}>${name}</option>
                            `).join('')}
                        </select>
                        <div class="tags-container mt-1" id="collections-${botName}">
                            ${collections.map(coll => `
                                <span class="tag">
                                    📦 ${coll}
                                    <span class="tag-remove" onclick="removeCollectionFromBot('${botName}', '${coll}')">×</span>
                                </span>
                            `).join('')}
                        </div>
                        <small class="text-muted">Collections define source and target channels for this bot.</small>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Minimum Messages for Summary</label>
                        <input type="number" class="input input-number-sm" id="min-messages-${botName}" value="${minMessages}" min="1"
                               onchange="updateBotSetting('${botName}', 'minimum_messages', Number(this.value))">
                        <small class="text-muted">Number of messages required before generating a summary</small>
                    </div>

                    <div class="form-group">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                            <label class="form-label" style="margin:0;">Default Schedules for New Topics</label>
                            <button class="btn btn-secondary btn-sm" style="font-size:11px;padding:3px 10px;"
                                    onclick="openDefaultScheduleModal('${botName}')">+ Add</button>
                        </div>
                        <small class="text-muted d-block mb-2">These schedules are automatically created when a new topic is added. Use <code>{topic_name}</code> in name/header.</small>
                        <div id="default-schedules-${botName}">
                            ${(bot.default_schedules || []).length === 0
                                ? '<p class="text-muted" style="font-size:12px;">No default schedules configured.</p>'
                                : (bot.default_schedules || []).map((ds, idx) => {
                                    const tgCount = (ds.telegram_targets || []).length;
                                    const tgLabel = tgCount ? `<span style="font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(139,92,246,0.15);color:#a78bfa;">📡 ${tgCount}</span>` : '';
                                    return `
                                    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-md);margin-bottom:6px;padding:10px 14px;">
                                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;">
                                            <span style="font-size:14px;">${scheduleIcon(ds)}</span>
                                            <span style="font-size:12px;font-weight:600;color:var(--text-primary);">${escapeHtmlSys(ds.name || ds.type)}</span>
                                            <span style="font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(59,130,246,0.12);color:#93c5fd;font-weight:600;">${escapeHtmlSys(ds.prompt_key || '')}</span>
                                            <span style="font-size:11px;color:var(--text-muted);">${scheduleSpec(ds)}</span>
                                            ${tgLabel}
                                        </div>
                                        <div style="display:flex;gap:6px;flex-shrink:0;">
                                            <button class="btn-icon" style="font-size:12px;" onclick="editDefaultSchedule('${botName}', ${idx})" title="Edit">✏️</button>
                                            <button class="btn-icon btn-danger" style="font-size:12px;" onclick="removeDefaultSchedule('${botName}', ${idx})" title="Remove">🗑️</button>
                                        </div>
                                    </div>`;
                                }).join('')
                            }
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function createPromptsSection(botName) {
    const prompts = (globalPrompts && globalPrompts[botName]) || {};
    const sectionId = `prompts-${botName}`;
    const savedState = loadCollapsibleState(sectionId);
    const defaultOpen = savedState !== null ? savedState : false; // Default closed for Prompts
    const isAdmin = !currentUser || currentUser.role === 'admin';

    const fixedPromptsHtml = isAdmin ? `
        <div class="prompt-card prompt-card-fixed" id="fixed-sysprompt-card-${botName}">
            <div class="prompt-card-header">
                <h4 class="prompt-card-title">🔒 System Prompt <span class="admin-badge">Admin</span></h4>
                <div class="prompt-card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="resetSummariesFixedPrompt('system_prompt', 'fixed-sysprompt-${botName}')" title="Reset to default">Reset</button>
                    <button class="btn btn-primary btn-sm" onclick="saveSummariesFixedPrompt('system_prompt', 'fixed-sysprompt-${botName}')">Save</button>
                </div>
            </div>
            <textarea class="textarea"
                      id="fixed-sysprompt-${botName}"
                      rows="2"
                      placeholder="Loading…"></textarea>
        </div>
        <div class="prompt-card prompt-card-fixed" id="fixed-prefix-card-${botName}">
            <div class="prompt-card-header">
                <h4 class="prompt-card-title">🔒 Fixed Prefix <span class="admin-badge">Admin</span></h4>
                <div class="prompt-card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="resetSummariesFixedPrompt('fixed_prefix', 'fixed-prefix-${botName}')" title="Reset to default">Reset</button>
                    <button class="btn btn-primary btn-sm" onclick="saveSummariesFixedPrompt('fixed_prefix', 'fixed-prefix-${botName}')">Save</button>
                </div>
            </div>
            <p class="text-muted" style="margin:0 0 4px;font-size:11px">Injected before every user prompt. Supports: {topic_name}, {messages}.</p>
            <textarea class="textarea"
                      id="fixed-prefix-${botName}"
                      rows="5"
                      style="font-family:monospace;font-size:12px"
                      placeholder="Loading…"></textarea>
        </div>` : '';

    return `
        <div class="collapsible-section ${defaultOpen ? 'open' : ''}" id="${sectionId}">
            <div class="collapsible-header" onclick="toggleCollapsible('${sectionId}')">
                <div class="collapsible-title">
                    <span class="icon">📝</span>
                    <span>Custom Prompts (${Object.keys(prompts).length})</span>
                </div>
                <span class="collapsible-toggle">▼</span>
            </div>
            <div class="collapsible-content">
                <div class="collapsible-body">
                    <p class="text-muted mb-2">Manage prompts for this bot</p>
                    ${fixedPromptsHtml}
                    ${Object.entries(prompts).map(([key, value]) => {
                        const promptText = (value && typeof value === 'object') ? (value.text || '') : (value || '');
                        return `
                        <div class="prompt-card">
                            <div class="prompt-card-header">
                                <h4 class="prompt-card-title">${escapeHtmlSys(key)}</h4>
                                <div class="prompt-card-actions">
                                    <button class="btn-icon" onclick="renamePromptDialog('${jsAttr(botName)}', '${jsAttr(key)}')" title="Rename">✏️</button>
                                    <button class="btn-icon btn-danger" onclick="deletePrompt('${jsAttr(botName)}', '${jsAttr(key)}')" title="Delete">🗑️</button>
                                </div>
                            </div>
                            <textarea class="textarea"
                                      id="prompt-${botName}-${key}"
                                      rows="3"
                                      onchange="updateBotPrompt('${jsAttr(botName)}', '${jsAttr(key)}')"
                                      placeholder="Enter prompt text...">${escapeHtml(promptText)}</textarea>
                        </div>`;
                    }).join('')}

                    <button class="btn btn-secondary btn-sm mt-2" onclick="showAddPromptModal('${botName}')">
                        + Add Prompt
                    </button>
                </div>
            </div>
        </div>
    `;
}

// ==================== Summaries Fixed Prompts (Admin Only) ====================

let _summariesFixedDefaults = { system_prompt: '', fixed_prefix: '' };
let _summariesFixedLoaded = false;

async function loadSummariesFixedPrompts() {
    if (_summariesFixedLoaded) return;
    const res = await api('/api/system/fixed-prefix');
    if (res.status !== 'ok') return;
    _summariesFixedDefaults.system_prompt = res.default_system_prompt || '';
    _summariesFixedDefaults.fixed_prefix  = res.default_fixed_prefix  || '';
    _summariesFixedLoaded = true;
    // Populate all visible fixed prompt textareas
    document.querySelectorAll('[id^="fixed-sysprompt-"]').forEach(el => {
        if (!el.value) el.value = res.system_prompt || res.default_system_prompt || '';
    });
    document.querySelectorAll('[id^="fixed-prefix-"]').forEach(el => {
        if (!el.value) el.value = res.fixed_prefix || res.default_fixed_prefix || '';
    });
}

async function saveSummariesFixedPrompt(field, textareaId) {
    const ta = document.getElementById(textareaId);
    if (!ta) return;
    const body = { [field]: ta.value };
    const res = await api('/api/system/fixed-prefix/save', body);
    if (res.status === 'ok') showAlert('Saved successfully.');
    else showAlert('Failed to save.');
}

function resetSummariesFixedPrompt(field, textareaId) {
    const ta = document.getElementById(textareaId);
    if (!ta) return;
    ta.value = _summariesFixedDefaults[field] || '';
}

// ==================== Bot Rules Section ====================
function createRulesSection(botName, bot) {
    const rules       = bot.rules || {};
    const removeRules = rules.remove  || [];
    const replaceRules = rules.replace || [];
    const total = removeRules.length + replaceRules.length;
    const sectionId = `rules-${botName}`;
    const savedState = loadCollapsibleState(sectionId);
    const defaultOpen = savedState !== null ? savedState : false;

    const removeRows = removeRules.map(kw => `
        <div class="rules-row">
            <input type="text" class="input rules-input" value="${escapeHtml(kw)}"
                   placeholder="word or phrase…" onchange="saveBotRules('${botName}')">
            <button class="btn-icon btn-danger" onclick="deleteRuleRow(this,'${botName}')">🗑️</button>
        </div>`).join('');

    const replaceRows = replaceRules.map(r => `
        <div class="rules-row">
            <input type="text" class="input rules-input" value="${escapeHtml(r.match || '')}"
                   placeholder="Find…" onchange="saveBotRules('${botName}')">
            <span class="rules-arrow">→</span>
            <input type="text" class="input rules-input" value="${escapeHtml(r.replace_with || '')}"
                   placeholder="Replace with…" onchange="saveBotRules('${botName}')">
            <button class="btn-icon btn-danger" onclick="deleteRuleRow(this,'${botName}')">🗑️</button>
        </div>`).join('');

    return `
        <div class="collapsible-section ${defaultOpen ? 'open' : ''}" id="${sectionId}">
            <div class="collapsible-header" onclick="toggleCollapsible('${sectionId}')">
                <div class="collapsible-title">
                    <span class="icon">🔧</span>
                    <span>Rules (${total})</span>
                </div>
                <span class="collapsible-toggle">▼</span>
            </div>
            <div class="collapsible-content">
                <div class="collapsible-body">

                    <div class="form-group">
                        <label class="form-label">🚫 Remove Message</label>
                        <small class="text-muted d-block mb-1">Message is discarded for this bot if it contains any of these words</small>
                        <div id="rules-remove-${botName}">${removeRows}</div>
                        <button class="btn btn-secondary btn-sm mt-1" onclick="addRemoveRule('${botName}')">+ Add Word</button>
                    </div>

                    <div class="form-group" style="margin-top:16px;">
                        <label class="form-label">🔄 Replace in Message</label>
                        <small class="text-muted d-block mb-1">Replaces matching words before categorisation &amp; summary</small>
                        <div id="rules-replace-${botName}">${replaceRows}</div>
                        <button class="btn btn-secondary btn-sm mt-1" onclick="addReplaceRule('${botName}')">+ Add Rule</button>
                    </div>

                </div>
            </div>
        </div>
    `;
}

function addRemoveRule(botName) {
    const container = document.getElementById(`rules-remove-${botName}`);
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'rules-row';
    row.innerHTML = `
        <input type="text" class="input rules-input" placeholder="word or phrase…" onchange="saveBotRules('${botName}')">
        <button class="btn-icon btn-danger" onclick="deleteRuleRow(this,'${botName}')">🗑️</button>`;
    container.appendChild(row);
    row.querySelector('input').focus();
}

function addReplaceRule(botName) {
    const container = document.getElementById(`rules-replace-${botName}`);
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'rules-row';
    row.innerHTML = `
        <input type="text" class="input rules-input" placeholder="Find…" onchange="saveBotRules('${botName}')">
        <span class="rules-arrow">→</span>
        <input type="text" class="input rules-input" placeholder="Replace with…" onchange="saveBotRules('${botName}')">
        <button class="btn-icon btn-danger" onclick="deleteRuleRow(this,'${botName}')">🗑️</button>`;
    container.appendChild(row);
    row.querySelector('input').focus();
}

function deleteRuleRow(btn, botName) {
    btn.closest('.rules-row').remove();
    saveBotRules(botName);
}

async function saveBotRules(botName) {
    const bot = globalConfig.bots?.[botName];
    if (!bot) return;

    // Collect remove rules
    const remove = [...document.querySelectorAll(`#rules-remove-${botName} .rules-row input`)]
        .map(el => el.value.trim()).filter(Boolean);

    // Collect replace rules (each row has 2 inputs: match + replace_with)
    const replace = [...document.querySelectorAll(`#rules-replace-${botName} .rules-row`)]
        .map(row => {
            const inputs = row.querySelectorAll('input');
            const match = inputs[0]?.value.trim();
            const replace_with = inputs[1]?.value.trim() ?? '';
            return match ? { match, replace_with } : null;
        }).filter(Boolean);

    bot.rules = { remove, replace };

    const result = await api('/api/bot/save', {
        name: botName,
        enabled: bot.enabled ?? true,
        collections: bot.collections || [],
        minimum_messages: bot.minimum_messages ?? 5,
        rules: { remove, replace },
        default_schedules: bot.default_schedules || [],
        categories: bot.categories || {}
    });

    if (result.status === 'updated') {
        // Update the Rules count in the collapsible header without full re-render
        const header = document.querySelector(`#rules-${botName} .collapsible-title span:last-child`);
        if (header) header.textContent = `Rules (${remove.length + replace.length})`;
        showNotification('Rules saved', 'success');
    }
}

function createCategoriesSection(botName, bot) {
    const categories = bot.categories || {};
    const sectionId = `categories-${botName}`;
    const savedState = loadCollapsibleState(sectionId);
    const defaultOpen = savedState !== null ? savedState : true; // Default open for Categories

    return `
        <div class="collapsible-section ${defaultOpen ? 'open' : ''}" id="${sectionId}">
            <div class="collapsible-header" onclick="toggleCollapsible('${sectionId}')">
                <div class="collapsible-title">
                    <span class="icon">📁</span>
                    <span>Categories & Topics</span>
                </div>
                <span class="collapsible-toggle">▼</span>
            </div>
            <div class="collapsible-content">
                <div class="collapsible-body">
                    ${Object.entries(categories).map(([categoryName, category]) => 
                        createCategoryBox(botName, categoryName, category)
                    ).join('')}
                    
                    <div class="add-category-section">
                        <input type="text" class="input" id="new-category-${botName}"
                               placeholder="New category name"
                               onkeydown="if(event.key==='Enter'){event.preventDefault(); addCategory('${jsAttr(botName)}'); return false;}"
                               style="display:inline-block; width:auto; margin-right:8px;">
                        <button class="btn btn-secondary btn-sm" onclick="addCategory('${jsAttr(botName)}')">
                            + Add Category
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function createCategoryBox(botName, categoryName, category) {
    const topics = category.topics || {};
    const topicCount = Object.keys(topics).length;
    const sectionId = `category-${botName}-${categoryName}`;
    const savedState = loadCollapsibleState(sectionId);
    const defaultOpen = savedState !== null ? savedState : true; // Default open for Categories
    const b = jsAttr(botName), c = jsAttr(categoryName);

    // Lazy rendering: only render full topic content when the category is open.
    // Closed categories get a lightweight placeholder that is populated on first open.
    const topicsContent = defaultOpen
        ? _buildCategoryTopicsHtml(botName, categoryName, category)
        : `<div class="topics-container" data-lazy-bot="${b}" data-lazy-cat="${c}"></div>`;

    return `
        <div class="category-box collapsible-section ${defaultOpen ? 'open' : ''}" id="${sectionId}">
            <div class="category-header-row" onclick="toggleCollapsible('${jsAttr(sectionId)}')">
                <div class="category-title-group">
                    <h4>🗂️ ${escapeHtmlSys(categoryName)}</h4>
                    <span class="text-muted" style="margin-left: 8px;">(${topicCount} topic${topicCount !== 1 ? 's' : ''})</span>
                </div>
                <div class="category-controls" onclick="event.stopPropagation()">
                    <button class="btn btn-secondary btn-sm"
                            onclick="openCategoryAndFocusNewTopic('${jsAttr(sectionId)}', '${b}', '${c}')">
                        + Add Topic
                    </button>
                    <label class="toggle-switch">
                        <input type="checkbox" ${category.enabled ? 'checked' : ''}
                               onchange="toggleCategory('${b}', '${c}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <button class="btn-icon btn-danger"
                            onclick="deleteCategory('${b}', '${c}')">🗑️</button>
                    <span class="collapsible-toggle">▼</span>
                </div>
            </div>

            <div class="collapsible-content">
                ${topicsContent}
            </div>
        </div>
    `;
}

function _buildCategoryTopicsHtml(botName, categoryName, category) {
    const topics = category.topics || {};
    const b = jsAttr(botName), c = jsAttr(categoryName);
    return `
        <div class="topics-container">
            ${Object.entries(topics).map(([topicName, topic]) =>
                createTopicBox(botName, categoryName, topicName, topic, category.enabled)
            ).join('')}
            <div style="margin-top: 16px;">
                <input type="text" class="input" id="new-topic-${botName}-${categoryName}"
                       placeholder="New topic name"
                       onkeydown="if(event.key==='Enter'){event.preventDefault(); event.stopPropagation(); addTopic('${b}', '${c}'); return false;}"
                       style="display:inline-block; width:auto; margin-right:8px;">
                <button class="btn btn-secondary btn-sm" onclick="addTopic('${b}', '${c}')">
                    Add
                </button>
            </div>
        </div>
    `;
}

function _renderLazyCategoryContent(section) {
    const placeholder = section.querySelector('[data-lazy-bot]');
    if (!placeholder) return;
    const botName = placeholder.getAttribute('data-lazy-bot');
    const catName = placeholder.getAttribute('data-lazy-cat');
    placeholder.removeAttribute('data-lazy-bot');
    placeholder.removeAttribute('data-lazy-cat');
    const bot = globalConfig.bots?.[botName];
    const category = bot?.categories?.[catName];
    if (!category) return;
    placeholder.outerHTML = _buildCategoryTopicsHtml(botName, catName, category);
}

function openCategoryAndFocusNewTopic(sectionId, b, c) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const wasOpen = section.classList.contains('open');
    if (!wasOpen) {
        section.classList.add('open');
        saveCollapsibleState(sectionId, true);
        _renderLazyCategoryContent(section);
    }
    // Focus the new-topic input (may be just rendered)
    const input = document.getElementById(`new-topic-${b}-${c}`);
    if (input) input.focus();
}

function createTopicBox(botName, categoryName, topicName, topic, categoryEnabled = true) {
    const keywords = topic.keywords || [];
    const seoHidden = topic._keyword_count != null;   // admin stripped keyword text
    const _ukKey    = `${botName}|${categoryName}|${topicName}`;
    const userKws   = seoHidden ? (_userAddedKeywords[_ukKey] || []) : [];
    // seoCount = admin's count + user's own additions (shown separately)
    const seoCount  = seoHidden ? topic._keyword_count : keywords.length;
    const schedules = topic.schedules || [];
    const linkedTopics = topic.linked_topics || [];
    const catchAll = !!topic.catch_all;
    const sectionId = `topic-${botName}-${categoryName}-${topicName}`;
    const savedState = loadCollapsibleState(sectionId);
    const defaultOpen = savedState !== null ? savedState : false; // Default closed for Topics
    const isDisabledByCategory = !categoryEnabled;
    const b = jsAttr(botName), c = jsAttr(categoryName), t = jsAttr(topicName);

    return `
        <div class="topic-box collapsible-section ${defaultOpen ? 'open' : ''} ${isDisabledByCategory ? 'category-disabled' : ''}" id="${sectionId}">
            <div class="topic-header-row" onclick="toggleCollapsible('${jsAttr(sectionId)}')">
                <div class="topic-title-group">
                    <strong>📌 ${escapeHtmlSys(topicName)}</strong>
                    ${isDisabledByCategory ? '<span class="disabled-badge">Category Disabled</span>' : ''}
                    ${catchAll ? '<span class="linked-badge" style="background:var(--accent-primary,#6366f1);color:#fff;">🌐 Catch All</span>' : ''}
                    ${linkedTopics.length > 0 ? `<span class="linked-badge">🔗 ${linkedTopics.length} linked</span>` : ''}
                    <span class="schedule-indicator">🕐 ${schedules.length} schedule${schedules.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="topic-controls" onclick="event.stopPropagation()">
                    <label class="toggle-switch">
                        <input type="checkbox" ${topic.enabled ? 'checked' : ''}
                               onchange="toggleTopic('${b}', '${c}', '${t}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <button class="btn-icon" title="Rename topic"
                            onclick="renameTopic('${b}', '${c}', '${t}')">✏️</button>
                    <button class="btn-icon btn-danger" title="Delete topic"
                            onclick="deleteTopic('${b}', '${c}', '${t}')">🗑️</button>
                    <span class="collapsible-toggle">▼</span>
                </div>
            </div>

            <div class="collapsible-content">
              <div class="collapsible-inner">
                <div class="topic-body">
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-secondary,#1e1e2e);border-radius:6px;margin-bottom:8px;">
                        <label class="toggle-switch">
                            <input type="checkbox" ${catchAll ? 'checked' : ''}
                                   onchange="setTopicCatchAll('${b}', '${c}', '${t}', this.checked)">
                            <span class="toggle-slider"></span>
                        </label>
                        <div>
                            <span style="font-size:13px;font-weight:500;">🌐 Catch All Messages</span>
                            <small class="text-muted d-block" style="font-size:11px;">Matches every incoming message — no keywords required</small>
                        </div>
                    </div>

                    <div class="form-group" ${catchAll ? 'style="opacity:0.4;pointer-events:none;"' : ''}>
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                            <label class="form-label" style="margin:0;">SEOs (${seoCount})</label>
                            ${!seoHidden && keywords.length > 0 ? `<div class="kw-bulk-actions" style="display:flex;gap:6px;align-items:center;">
                                <button class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px;" onclick="kwToggleSelectAll('${b}','${c}','${t}')">Select All</button>
                                <button class="btn btn-danger btn-sm kw-del-sel-btn" style="font-size:10px;padding:2px 8px;display:none;" data-topic="${b}|${c}|${t}" onclick="kwDeleteSelected('${b}','${c}','${t}')">Delete Selected</button>
                                <button class="btn btn-danger btn-sm" style="font-size:10px;padding:2px 8px;" onclick="kwDeleteAll('${b}','${c}','${t}')">Delete All</button>
                            </div>` : ''}
                        </div>
                        <div class="tags-container tags-scrollable" id="kw-tags-${b}-${c}-${t}">
                            ${seoHidden ? `
                                <span class="tag" style="background:rgba(99,102,241,.12);color:var(--text-muted);border:1px dashed var(--border-color);cursor:default;pointer-events:none;">
                                    🔒 ${seoCount} SEO${seoCount !== 1 ? 's' : ''} active — details hidden by admin
                                </span>
                                ${userKws.map(kw => `
                                    <span class="tag tag-user-kw">
                                        ${escapeHtmlSys(kw)}
                                        <span class="tag-remove" onclick="removeUserKeyword('${b}','${c}','${t}','${jsAttr(kw)}')">×</span>
                                    </span>
                                `).join('')}` :
                            keywords.map((kw, idx) => `
                                <span class="tag kw-selectable" data-idx="${idx}">
                                    <input type="checkbox" class="kw-cb" style="margin:0 4px 0 0;accent-color:var(--accent-primary);cursor:pointer;" onchange="kwSelectionChanged('${b}','${c}','${t}')">
                                    ${escapeHtmlSys(kw)}
                                    <span class="tag-remove"
                                          onclick="removeKeyword('${b}', '${c}', '${t}', ${idx})">×</span>
                                </span>
                            `).join('')}
                            <input type="text" class="tag-input" placeholder="+ Add SEOs (comma-separated)"
                                   onkeydown="return handleKeywordInput(event, '${b}', '${c}', '${t}')">
                        </div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Linked Topics (inherit SEOs)</label>
                        <div class="tags-container">
                            ${linkedTopics.map((linkedTopic, idx) => `
                                <span class="tag">
                                    🔗 ${escapeHtmlSys(linkedTopic)}
                                    <span class="tag-remove" onclick="removeLinkedTopic('${b}', '${c}', '${t}', ${idx})">×</span>
                                </span>
                            `).join('')}
                        </div>
                        <button class="btn btn-secondary btn-sm mt-1"
                                onclick="showLinkTopicModal('${b}', '${c}', '${t}')">
                            + Link Existing Topic
                        </button>
                        <small class="text-muted d-block mt-1">Link to other topics to inherit their SEOs</small>
                    </div>
                </div>

                <div class="topic-schedules-section">
                    <div class="form-group">
                        <label class="form-label">Schedules</label>
                        ${schedules.map((schedule, idx) => `
                            <div class="summary-block">
                                <div class="summary-header">
                                    <div class="summary-title">
                                        <label class="toggle-switch">
                                            <input type="checkbox" ${schedule.enabled ? 'checked' : ''}
                                                   onchange="toggleTopicSchedule('${b}', '${c}', '${t}', ${schedule.id}, this.checked)">
                                            <span class="toggle-slider"></span>
                                        </label>
                                        <strong>${escapeHtmlSys(schedule.name)}</strong>
                                    </div>
                                    <div style="display:flex;align-items:center;gap:4px">
                                        <button class="btn-icon" title="Edit schedule"
                                                onclick="openEditTopicScheduleModal('${b}', '${c}', '${t}', ${schedule.id})">✏️</button>
                                        <button class="btn-icon btn-danger" title="Delete schedule"
                                                onclick="deleteTopicSchedule('${b}', '${c}', '${t}', ${schedule.id})">🗑️</button>
                                    </div>
                                </div>
                                <div class="summary-details">
                                    <span>📅 ${formatSchedule(schedule)}</span>
                                    <span>📝 ${escapeHtmlSys(schedule.prompt_key)}</span>
                                    <span>📨 ${escapeHtmlSys(schedule.header || `*${schedule.name}*`)}${schedule.header_datetime ? ' 🕐' : ''}${schedule.telegram_targets?.length ? ` 📡 ${schedule.telegram_targets.length}` : ''}</span>
                                </div>
                            </div>
                        `).join('')}
                        <button class="btn btn-secondary btn-sm mt-2"
                                onclick="openAddTopicScheduleModal('${b}', '${c}', '${t}')">
                            + Add Schedule
                        </button>
                    </div>
                </div>
              </div>
            </div>
        </div>
    `;
}

function formatSchedule(schedule) {
    if (!schedule) return 'Not set';
    const type = schedule.type;
    if (type === 'minute') return `Every ${schedule.minute || 1} minute(s)`;
    if (type === 'hourly') return `Hourly at :${String(schedule.minute || 0).padStart(2, '0')}`;
    if (type === 'interval_minutes') {
        const sh = String(schedule.start_hour   ?? 0).padStart(2, '0');
        const sm = String(schedule.start_minute ?? 0).padStart(2, '0');
        const endPart = (schedule.end_hour != null && schedule.end_minute != null)
            ? ` → ${String(schedule.end_hour).padStart(2,'0')}:${String(schedule.end_minute).padStart(2,'0')}` : '';
        return `Every ${schedule.minutes || 30}min — starts ${sh}:${sm}${endPart}`;
    }
    if (type === 'interval') {
        const sh = String(schedule.start_hour   ?? 0).padStart(2, '0');
        const sm = String(schedule.start_minute ?? 0).padStart(2, '0');
        const endPart = (schedule.end_hour != null && schedule.end_minute != null)
            ? ` → ${String(schedule.end_hour).padStart(2,'0')}:${String(schedule.end_minute).padStart(2,'0')}` : '';
        return `Every ${schedule.hours || 1}h — starts ${sh}:${sm}${endPart}`;
    }
    if (type === 'daily') return `Daily at ${String(schedule.hour || 0).padStart(2, '0')}:${String(schedule.minute || 0).padStart(2, '0')}`;
    if (type === 'speeches_interval') {
        return `Speeches — every 1min check — send after ${schedule.wait_time || 5}m idle`;
    }
    return type;
}

// ==================== Bot Actions ====================
async function createNewBot() {
    const name = document.getElementById('new-bot-name').value.trim();
    if (!name) {
        showAlert('Please enter a bot name', { icon: '✏️' });
        return;
    }
    
    const botData = {
        name: name,
        enabled: false,
        collections: [],
        minimum_messages: 5,
        summaries: [],
        categories: {},
        create_only: true
    };

    const result = await api('/api/bot/save', botData);
    if (result.status === 'updated') {
        document.getElementById('new-bot-name').value = '';
        await loadAllData();
        renderBotsPage();
        renderSystemPage();
        showNotification('Bot created successfully', 'success');
        
        setTimeout(() => navigateToBotConfig(name), 300);
    } else {
        showNotification('Failed to create bot: ' + (result.message || ''), 'error');
    }
}

async function toggleBotEnabled(botName, enabled) {
    const bot = globalConfig.bots[botName];
    if (!bot) return;
    
    bot.enabled = enabled;
    
    const result = await api('/api/bot/save', { name: botName, ...bot });
    if (result.status === 'updated') {
        showNotification(`Bot ${enabled ? 'enabled' : 'disabled'}`, 'success');
        await loadAllData();
        renderSystemPage();
    } else {
        showNotification('Failed to update bot', 'error');
    }
}

function renameBot(oldName) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'rename-bot-modal';
    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Rename Bot</h3>
                <button class="btn-icon" onclick="closeModal('rename-bot-modal')">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">New Bot Name</label>
                    <input type="text" class="input" id="rename-bot-input" value="${escapeHtml(oldName)}" placeholder="Enter new bot name">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('rename-bot-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="submitRenameBot('${jsAttr(oldName)}')">Rename</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const inp = document.getElementById('rename-bot-input');
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitRenameBot(oldName); });
}

async function submitRenameBot(oldName) {
    const newName = document.getElementById('rename-bot-input').value.trim();
    if (!newName || newName === oldName) { closeModal('rename-bot-modal'); return; }

    const result = await api('/api/bot/rename', { old_name: oldName, new_name: newName });
    if (result.status === 'ok') {
        closeModal('rename-bot-modal');
        await loadAllData();
        renderBotsPage();
        renderSystemPage();
        showNotification('Bot renamed', 'success');
    } else {
        showNotification('Failed to rename bot: ' + (result.message || ''), 'error');
    }
}

async function deleteBot(botName) {
    showConfirm(`Delete bot "${botName}"? This cannot be undone.`, async () => {
        const result = await api('/api/bot/delete', { name: botName });
        if (result.status === 'ok') {
            await loadAllData();
            renderBotsPage();
            renderSystemPage();
            showNotification('Bot deleted', 'success');
        }
    }, { title: 'Delete Bot' });
}

// ==================== Default Schedule Management ====================
function openDefaultScheduleModal(botName) {
    const botPrompts = globalPrompts[botName] || {};
    const promptOptions = Object.keys(botPrompts).length
        ? Object.keys(botPrompts).map(key => `<option value="${key}">${key}</option>`).join('')
        : '<option value="">No prompts defined</option>';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'default-schedule-modal';
    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Add Default Schedule</h3>
                <button class="btn-icon" onclick="closeModal('default-schedule-modal')">×</button>
            </div>
            <div class="modal-body">
                <small class="text-muted d-block mb-2">This schedule template will be auto-created on every new topic. Use <code>{topic_name}</code> in name/header to insert the topic name.</small>
                <div class="form-group">
                    <label class="form-label">Schedule Name</label>
                    <input type="text" class="input" id="ds-name" value="{topic_name}" placeholder="{topic_name}">
                </div>
                <div class="form-group">
                    <label class="form-label">Type</label>
                    <select class="select" id="ds-type" onchange="updateDsInputs()">
                        <option value="minute">Minute</option>
                        <option value="hourly">Hourly</option>
                        <option value="interval_minutes">Interval (Minutes)</option>
                        <option value="interval">Interval (Hours)</option>
                        <option value="daily">Daily</option>
                        <option value="speeches_interval">Speeches Interval</option>
                    </select>
                </div>
                <div id="ds-type-inputs"></div>
                <div class="form-group">
                    <label class="form-label">Prompt</label>
                    <select class="select" id="ds-prompt">${promptOptions}</select>
                </div>
                <div class="form-group">
                    <label class="form-label">Header</label>
                    <input type="text" class="input" id="ds-header" value="*{topic_name}*" placeholder="*{topic_name}*">
                </div>
                <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                    <label class="toggle-switch">
                        <input type="checkbox" id="ds-header-datetime" onchange="toggleSchDatetimeOptions('ds')">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="form-label" style="margin:0;">Show date & time in header</span>
                </div>
                <div id="ds-datetime-opts" style="display:none;padding-left:16px;">
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="ds-date-arabic">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Date in Arabic numerals</span>
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="ds-time-arabic">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Time in Arabic numerals</span>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Telegram Targets (optional)</label>
                    <div class="tags-container" id="ds-tg-targets"></div>
                    <input type="text" class="input mt-1" id="ds-tg-input"
                           placeholder="@channel or chat ID — press Enter to add"
                           onkeydown="if(event.key==='Enter'){event.preventDefault();addSchTgTarget('ds');}">
                    <small class="text-muted sch-tg-hint" id="ds-tg-hint">Leave empty to use collection targets.</small>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('default-schedule-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveDefaultSchedule('${botName}')">Add</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    updateDsInputs();
}

function updateDsInputs() {
    const type = document.getElementById('ds-type')?.value;
    const container = document.getElementById('ds-type-inputs');
    if (!container) return;
    if (type === 'minute') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Every N Minutes</label>
            <input type="number" class="input" id="ds-minute" min="1" max="59" value="30"></div>`;
    } else if (type === 'hourly') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Minute</label>
            <input type="number" class="input" id="ds-minute" min="0" max="59" value="0"></div>`;
    } else if (type === 'interval_minutes') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Every N Minutes</label>
            <input type="number" class="input" id="ds-minutes" min="1" value="30">
            <div class="form-group"><label class="form-label">Starting at (HH : MM)</label>
            <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="ds-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                <input type="number" class="input" id="ds-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
            </div>
            <small class="text-muted">First run at this time, then every X minutes</small>
        </div>`;
    } else if (type === 'interval') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Every X Hours</label>
            <input type="number" class="input" id="ds-hours" min="1" max="24" value="3">
            <div class="form-group"><label class="form-label">Starting at (HH : MM)</label>
            <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="ds-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                <input type="number" class="input" id="ds-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
            </div>
            <small class="text-muted">First run at this time, then every X hours</small>
        </div>`;
    } else if (type === 'daily') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Hour</label>
            <input type="number" class="input" id="ds-hour" min="0" max="23" value="18">
            <div class="form-group"><label class="form-label">Minute</label>
            <input type="number" class="input" id="ds-minute" min="0" max="59" value="0">
        </div>`;
    } else if (type === 'speeches_interval') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Wait Time (mins) — send buckets when idle</label>
            <input type="number" class="input" id="ds-wait-time" min="1" value="5">
            <small class="text-muted">Checks every minute. Sends each bucket as a separate message after this many idle minutes. Separate LLM response sections with <code>---</code> on its own line.</small>`;
    } else {
        container.innerHTML = '';
    }
}

async function saveDefaultSchedule(botName) {
    const name = document.getElementById('ds-name')?.value.trim();
    const type = document.getElementById('ds-type')?.value;
    const prompt_key = document.getElementById('ds-prompt')?.value;
    if (!name) { showAlert('Please enter a schedule name', { icon: '✏️' }); return; }

    const ds = {
        name, type, prompt_key, enabled: true,
        header: document.getElementById('ds-header')?.value || `*${name}*`,
        header_datetime: document.getElementById('ds-header-datetime')?.checked || false,
        header_date_arabic: document.getElementById('ds-date-arabic')?.checked || false,
        header_time_arabic: document.getElementById('ds-time-arabic')?.checked || false,
        telegram_targets: getSchTgTargets('ds'),
    };

    if (type === 'minute' || type === 'hourly') ds.minute = Number(document.getElementById('ds-minute')?.value || 0);
    if (type === 'interval_minutes') {
        ds.minutes = Number(document.getElementById('ds-minutes')?.value || 30);
        ds.start_hour = Number(document.getElementById('ds-start-hour')?.value || 0);
        ds.start_minute = Number(document.getElementById('ds-start-minute')?.value || 0);
    }
    if (type === 'interval') {
        ds.hours = Number(document.getElementById('ds-hours')?.value || 3);
        ds.start_hour = Number(document.getElementById('ds-start-hour')?.value || 0);
        ds.start_minute = Number(document.getElementById('ds-start-minute')?.value || 0);
    }
    if (type === 'daily') {
        ds.hour = Number(document.getElementById('ds-hour')?.value || 0);
        ds.minute = Number(document.getElementById('ds-minute')?.value || 0);
    }
    if (type === 'speeches_interval') {
        ds.wait_time = Number(document.getElementById('ds-wait-time')?.value || 5);
    }

    const bot = globalConfig.bots[botName];
    if (!bot.default_schedules) bot.default_schedules = [];
    bot.default_schedules.push(ds);

    await updateBotSetting(botName, 'default_schedules', bot.default_schedules);
    closeModal('default-schedule-modal');
    await loadAllData();
    renderBotsPage();
}

async function removeDefaultSchedule(botName, index) {
    showConfirm('Remove this default schedule?', async () => {
        const bot = globalConfig.bots[botName];
        bot.default_schedules.splice(index, 1);
        await updateBotSetting(botName, 'default_schedules', bot.default_schedules);
        await loadAllData();
        renderBotsPage();
    }, { title: 'Remove Default Schedule' });
}

function editDefaultSchedule(botName, idx) {
    const bot = globalConfig.bots[botName];
    if (!bot || !bot.default_schedules) return;
    const ds = bot.default_schedules[idx];
    if (!ds) return;

    const botPrompts = globalPrompts[botName] || {};
    const promptOptions = Object.keys(botPrompts).length
        ? Object.keys(botPrompts).map(key => `<option value="${key}">${key}</option>`).join('')
        : '<option value="">No prompts defined</option>';

    const existingModal = document.getElementById('default-schedule-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'default-schedule-modal';
    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Edit Default Schedule</h3>
                <button class="btn-icon" onclick="closeModal('default-schedule-modal')">×</button>
            </div>
            <div class="modal-body">
                <small class="text-muted d-block mb-2">This schedule template will be auto-created on every new topic. Use <code>{topic_name}</code> in name/header to insert the topic name.</small>
                <div class="form-group">
                    <label class="form-label">Schedule Name</label>
                    <input type="text" class="input" id="ds-name" placeholder="{topic_name}">
                </div>
                <div class="form-group">
                    <label class="form-label">Type</label>
                    <select class="select" id="ds-type" onchange="updateDsInputs()">
                        <option value="minute">Minute</option>
                        <option value="hourly">Hourly</option>
                        <option value="interval_minutes">Interval (Minutes)</option>
                        <option value="interval">Interval (Hours)</option>
                        <option value="daily">Daily</option>
                        <option value="speeches_interval">Speeches Interval</option>
                    </select>
                </div>
                <div id="ds-type-inputs"></div>
                <div class="form-group">
                    <label class="form-label">Prompt</label>
                    <select class="select" id="ds-prompt">${promptOptions}</select>
                </div>
                <div class="form-group">
                    <label class="form-label">Header</label>
                    <input type="text" class="input" id="ds-header" placeholder="*{topic_name}*">
                </div>
                <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                    <label class="toggle-switch">
                        <input type="checkbox" id="ds-header-datetime" onchange="toggleSchDatetimeOptions('ds')">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="form-label" style="margin:0;">Show date & time in header</span>
                </div>
                <div id="ds-datetime-opts" style="display:none;padding-left:16px;">
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="ds-date-arabic">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Date in Arabic numerals</span>
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="ds-time-arabic">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Time in Arabic numerals</span>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Telegram Targets (optional)</label>
                    <div class="tags-container" id="ds-tg-targets"></div>
                    <input type="text" class="input mt-1" id="ds-tg-input"
                           placeholder="@channel or chat ID — press Enter to add"
                           onkeydown="if(event.key==='Enter'){event.preventDefault();addSchTgTarget('ds');}">
                    <small class="text-muted sch-tg-hint" id="ds-tg-hint">Leave empty to use collection targets.</small>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('default-schedule-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveEditedDefaultSchedule('${botName}', ${idx})">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Pre-fill type and render type-specific inputs first
    const typeSelect = document.getElementById('ds-type');
    if (typeSelect) typeSelect.value = ds.type || 'daily';
    updateDsInputs();

    // Pre-fill type-specific numeric fields
    if (ds.type === 'minute' || ds.type === 'hourly') {
        const el = document.getElementById('ds-minute');
        if (el) el.value = ds.minute ?? 0;
    } else if (ds.type === 'interval_minutes') {
        const el = document.getElementById('ds-minutes');
        if (el) el.value = ds.minutes ?? 30;
        const sh = document.getElementById('ds-start-hour');
        if (sh) sh.value = ds.start_hour ?? 0;
        const sm = document.getElementById('ds-start-minute');
        if (sm) sm.value = ds.start_minute ?? 0;
    } else if (ds.type === 'interval') {
        const el = document.getElementById('ds-hours');
        if (el) el.value = ds.hours ?? 3;
        const sh = document.getElementById('ds-start-hour');
        if (sh) sh.value = ds.start_hour ?? 0;
        const sm = document.getElementById('ds-start-minute');
        if (sm) sm.value = ds.start_minute ?? 0;
    } else if (ds.type === 'daily') {
        const h = document.getElementById('ds-hour');
        if (h) h.value = ds.hour ?? 18;
        const m = document.getElementById('ds-minute');
        if (m) m.value = ds.minute ?? 0;
    } else if (ds.type === 'speeches_interval') {
        const el = document.getElementById('ds-wait-time');
        if (el) el.value = ds.wait_time ?? 5;
    }

    // Pre-fill remaining fields
    const nameEl = document.getElementById('ds-name');
    if (nameEl) nameEl.value = ds.name || '';

    const promptEl = document.getElementById('ds-prompt');
    if (promptEl && ds.prompt_key) promptEl.value = ds.prompt_key;

    const headerEl = document.getElementById('ds-header');
    if (headerEl) headerEl.value = ds.header || '';

    const dtCheck = document.getElementById('ds-header-datetime');
    if (dtCheck && ds.header_datetime) {
        dtCheck.checked = true;
        toggleSchDatetimeOptions('ds');
        const dateAr = document.getElementById('ds-date-arabic');
        if (dateAr) dateAr.checked = !!ds.header_date_arabic;
        const timeAr = document.getElementById('ds-time-arabic');
        if (timeAr) timeAr.checked = !!ds.header_time_arabic;
    }

    // Pre-fill telegram targets
    const tgInput = document.getElementById('ds-tg-input');
    (ds.telegram_targets || []).forEach(t => {
        if (t && tgInput) { tgInput.value = t; addSchTgTarget('ds'); }
    });
}

async function saveEditedDefaultSchedule(botName, idx) {
    const name = document.getElementById('ds-name')?.value.trim();
    const type = document.getElementById('ds-type')?.value;
    const prompt_key = document.getElementById('ds-prompt')?.value;
    if (!name) { showAlert('Please enter a schedule name', { icon: '✏️' }); return; }

    const ds = {
        name, type, prompt_key, enabled: true,
        header: document.getElementById('ds-header')?.value || `*${name}*`,
        header_datetime: document.getElementById('ds-header-datetime')?.checked || false,
        header_date_arabic: document.getElementById('ds-date-arabic')?.checked || false,
        header_time_arabic: document.getElementById('ds-time-arabic')?.checked || false,
        telegram_targets: getSchTgTargets('ds'),
    };

    if (type === 'minute' || type === 'hourly') ds.minute = Number(document.getElementById('ds-minute')?.value || 0);
    if (type === 'interval_minutes') {
        ds.minutes = Number(document.getElementById('ds-minutes')?.value || 30);
        ds.start_hour = Number(document.getElementById('ds-start-hour')?.value || 0);
        ds.start_minute = Number(document.getElementById('ds-start-minute')?.value || 0);
    }
    if (type === 'interval') {
        ds.hours = Number(document.getElementById('ds-hours')?.value || 3);
        ds.start_hour = Number(document.getElementById('ds-start-hour')?.value || 0);
        ds.start_minute = Number(document.getElementById('ds-start-minute')?.value || 0);
    }
    if (type === 'daily') {
        ds.hour = Number(document.getElementById('ds-hour')?.value || 0);
        ds.minute = Number(document.getElementById('ds-minute')?.value || 0);
    }
    if (type === 'speeches_interval') {
        ds.wait_time = Number(document.getElementById('ds-wait-time')?.value || 5);
    }

    const bot = globalConfig.bots[botName];
    if (!bot || !bot.default_schedules) return;
    bot.default_schedules[idx] = ds;

    await updateBotSetting(botName, 'default_schedules', bot.default_schedules);
    closeModal('default-schedule-modal');
    await loadAllData();
    renderBotsPage();
}

async function updateBotSetting(botName, key, value) {
    const bot = globalConfig.bots[botName];
    if (!bot) return;

    bot[key] = value;

    // DEFENSIVE: Save complete bot object to avoid partial updates
    // Note: prompts are stored in prompts.yaml, not in bot config
    const fullBotData = {
        name: botName,
        enabled: bot.enabled ?? true,
        collections: bot.collections || [],
        minimum_messages: bot.minimum_messages ?? 5,
        rules: bot.rules || { remove: [], replace: [] },
        default_schedules: bot.default_schedules || [],
        categories: bot.categories || {}
    };

    const result = await api('/api/bot/save', fullBotData);
    if (result.status === 'updated') {
        // Reload data and update system stats (backend now properly saves all fields)
        await loadAllData();
        renderSystemPage();
        showNotification('Setting updated', 'success');
    } else {
        showNotification('Failed to update setting', 'error');
    }
}

async function updateBotPrompt(botName, promptKey) {
    const ta = document.getElementById(`prompt-${botName}-${promptKey}`);
    const text = ta?.value || '';
    const result = await api('/api/prompts/update', { bot_name: botName, key: promptKey, text });
    if (result.status === 'ok') {
        // Update in-memory cache only — no re-render needed
        if (globalPrompts[botName]) {
            if (typeof globalPrompts[botName][promptKey] === 'object') {
                globalPrompts[botName][promptKey].text = text;
            } else {
                globalPrompts[botName][promptKey] = text;
            }
        }
        showNotification('Prompt updated', 'success');
    }
}

function showAddPromptModal(botName) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'add-prompt-modal';

    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Add Custom Prompt</h3>
                <button class="btn-icon" onclick="closeModal('add-prompt-modal')">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">Prompt Name</label>
                    <input type="text" class="input" id="new-prompt-name" placeholder="e.g., brief_update, detailed_summary">
                </div>
                <div class="form-group">
                    <label class="form-label">Prompt Text</label>
                    <textarea class="textarea" id="new-prompt-text" rows="5" placeholder="Enter the prompt text..."></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('add-prompt-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveNewPrompt('${botName}')">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

async function saveNewPrompt(botName) {
    const promptName = document.getElementById('new-prompt-name').value.trim();
    const promptText = document.getElementById('new-prompt-text').value.trim();

    if (!promptName) {
        showAlert('Please enter a prompt name', { icon: '✏️' });
        return;
    }

    const doSave = async () => {
        const result = await api('/api/prompts/update', { bot_name: botName, key: promptName, text: promptText });
        if (result.status === 'ok') {
            await loadAllData();
            renderBotsPage();
            closeModal('add-prompt-modal');
            showNotification('Prompt added', 'success');
        }
    };

    // Check if prompt already exists for this bot
    const botPrompts = (globalPrompts && globalPrompts[botName]) || {};
    if (botPrompts[promptName]) {
        showConfirm(`Prompt "${promptName}" already exists. Overwrite?`, doSave, {
            title: 'Overwrite Prompt', confirmLabel: 'Overwrite', confirmClass: 'btn-primary'
        });
    } else {
        await doSave();
    }
}

async function deletePrompt(botName, promptKey) {
    showConfirm(`Delete prompt "${promptKey}"?`, async () => {
        const result = await api('/api/prompts/delete', { bot_name: botName, key: promptKey });
        if (result.status === 'ok') {
            await loadAllData();
            renderBotsPage();
            loadWarnings();
            showNotification('Prompt deleted', 'success');
        } else {
            showAlert(result.message || 'Failed to delete prompt', { title: 'Cannot Delete', icon: '⛔' });
        }
    }, { title: 'Delete Prompt' });
}

function renamePromptDialog(botName, oldKey) {
    showPrompt('Rename Prompt', oldKey, async (newName) => {
        await renamePrompt(botName, oldKey, newName);
    });
}

async function renamePrompt(botName, oldKey, newName) {
    newName = newName.trim();
    if (!newName || oldKey === newName) return;

    // Get bot prompts
    const botPrompts = (globalPrompts && globalPrompts[botName]) || {};

    // Check if new key already exists for this bot
    if (botPrompts[newName]) {
        showAlert(`Prompt "${newName}" already exists`, { icon: '⚠️' });
        renderBotsPage(); // Reset the input
        return;
    }

    // Get the old prompt value (may be string or {header, text} dict)
    const oldVal = botPrompts[oldKey];
    if (!oldVal) return;
    const oldText = (oldVal && typeof oldVal === 'object') ? (oldVal.text || '') : (oldVal || '');

    // Create new prompt with new key
    const addResult = await api('/api/prompts/update', { bot_name: botName, key: newName, text: oldText });
    if (addResult.status === 'ok') {
        // Delete old prompt
        await api('/api/prompts/delete', { bot_name: botName, key: oldKey });
        // Cascade rename to all schedules that referenced the old prompt key
        await api('/api/prompts/rename-cascade', { bot_name: botName, old_key: oldKey, new_key: newName });
        await loadAllData();
        renderBotsPage();
        showNotification('Prompt renamed', 'success');
    }
}

async function addCollectionToBot(botName, collectionName) {
    if (!collectionName) return;

    const bot = globalConfig.bots[botName];
    if (!bot.collections) bot.collections = [];

    if (!bot.collections.includes(collectionName)) {
        bot.collections.push(collectionName);

        // Update UI immediately for instant feedback
        const tagsContainer = document.getElementById(`collections-${botName}`);
        if (tagsContainer) {
            const newTag = document.createElement('span');
            newTag.className = 'tag';
            newTag.innerHTML = `📦 ${collectionName} <span class="tag-remove" onclick="removeCollectionFromBot('${botName}', '${collectionName}')">×</span>`;
            tagsContainer.appendChild(newTag);
        }

        // Update dropdown to disable the selected option
        const select = document.getElementById(`collections-select-${botName}`);
        if (select) {
            const option = select.querySelector(`option[value="${collectionName}"]`);
            if (option) option.disabled = true;
            select.value = '';
        }

        const result = await api('/api/bot/save', { name: botName, ...bot });
        if (result.status === 'updated') {
            await loadAllData();
            showNotification('Collection added', 'success');
        } else {
            // Revert on failure
            renderBotsPage();
        }
    }
}

async function removeCollectionFromBot(botName, collectionName) {
    const bot = globalConfig.bots[botName];
    const idx = (bot.collections || []).indexOf(collectionName);
    if (idx > -1) {
        bot.collections.splice(idx, 1);

        // DEFENSIVE: Save complete bot object to avoid partial updates
        // Note: prompts are stored in prompts.yaml, not in bot config
        const fullBotData = {
            name: botName,
            enabled: bot.enabled ?? true,
            collections: bot.collections || [],
            minimum_messages: bot.minimum_messages ?? 5,
            rules: bot.rules || { remove: [], replace: [] },
            default_schedules: bot.default_schedules || [],
            categories: bot.categories || {}
        };

        const result = await api('/api/bot/save', fullBotData);
        if (result.status === 'updated') {
            await loadAllData();
            renderBotsPage();
            showNotification('Collection removed', 'success');
        }
    }
}

// ==================== Category Management ====================
async function addCategory(botName) {
    const input = document.getElementById(`new-category-${botName}`);
    const name = input.value.trim();
    
    if (!name) {
        showAlert('Please enter a category name', { icon: '✏️' });
        return;
    }
    
    const result = await api('/api/category/add', {
        bot_name: botName,
        category_name: name
    });
    
    if (result.status === 'ok') {
        input.value = '';
        await loadAllData();
        renderBotsPage();
        showNotification('Category added', 'success');
    } else {
        showNotification(result.message || 'Failed to add category', 'error');
    }
}

async function deleteCategory(botName, categoryName) {
    showConfirm(`Delete category "${categoryName}" and all its topics?`, async () => {
        const result = await api('/api/category/delete', {
            bot_name: botName,
            category_name: categoryName
        });
        if (result.status === 'ok') {
            await loadAllData();
            renderBotsPage();
            loadWarnings();
            showNotification('Category deleted', 'success');
        }
    }, { title: 'Delete Category' });
}

async function toggleCategory(botName, categoryName, enabled) {
    const result = await api('/api/category/toggle', {
        bot_name: botName,
        category_name: categoryName,
        enabled
    });
    
    if (result.status === 'ok') {
        await loadAllData();
        renderBotsPage();
        showNotification(`Category ${enabled ? 'enabled (all topics restored)' : 'disabled'}`, 'success');
    }
}

// ==================== Topic Management ====================
async function addTopic(botName, categoryName) {
    const input = document.getElementById(`new-topic-${botName}-${categoryName}`);
    const name = input.value.trim();
    
    if (!name) {
        showAlert('Please enter a topic name', { icon: '✏️' });
        return;
    }
    
    const result = await api('/api/topic/add', {
        bot_name: botName,
        category_name: categoryName,
        topic_name: name
    });
    
    if (result.status === 'ok') {
        input.value = '';
        await loadAllData();
        renderBotsPage();
        showNotification('Topic added', 'success');
    } else {
        showNotification(result.message || 'Failed to add topic', 'error');
    }
}

async function renameTopic(botName, categoryName, topicName) {
    showPrompt('Rename Topic', topicName, async (newName) => {
        newName = newName.trim();
        if (!newName || newName === topicName) return;
        const result = await api('/api/topic/rename', {
            bot_name: botName, category_name: categoryName,
            old_name: topicName, new_name: newName,
        });
        if (result.status === 'ok') {
            await loadAllData();
            renderBotsPage([`topic-${botName}-${categoryName}-${newName}`, `categories-${botName}`]);
            showNotification('Topic renamed', 'success');
        } else {
            showAlert(result.message || 'Rename failed');
        }
    });
}

async function deleteTopic(botName, categoryName, topicName) {
    showConfirm(`Delete topic "${topicName}"?`, async () => {
        const result = await api('/api/topic/delete', {
            bot_name: botName,
            category_name: categoryName,
            topic_name: topicName
        });
        if (result.status === 'ok') {
            await loadAllData();
            renderBotsPage();
            showNotification('Topic deleted', 'success');
        }
    }, { title: 'Delete Topic' });
}

async function toggleTopic(botName, categoryName, topicName, enabled) {
    const result = await api('/api/topic/toggle', {
        bot_name: botName,
        category_name: categoryName,
        topic_name: topicName,
        enabled
    });

    if (result.status === 'ok') {
        await loadAllData();
        renderBotsPage();
        showNotification(`Topic ${enabled ? 'enabled' : 'disabled'}`, 'success');
    }
}

async function setTopicCatchAll(botName, categoryName, topicName, value) {
    const result = await api('/api/topic/catch_all', {
        bot_name: botName,
        category_name: categoryName,
        topic_name: topicName,
        catch_all: value,
    });
    if (result.status === 'ok') {
        await loadAllData();
        const topicId = `topic-${botName}-${categoryName}-${topicName}`;
        const categoryId = `categories-${botName}`;
        renderBotsPage([topicId, categoryId]);
        showNotification(value ? 'Catch All enabled' : 'Catch All disabled', 'success');
    }
}

function showLinkTopicModal(botName, categoryName, currentTopicName) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'link-topic-modal';

    // Get all topics from all categories in this bot to link to
    const bot = globalConfig.bots[botName];
    const allTopics = [];

    // Collect all topics from all categories
    Object.entries(bot.categories || {}).forEach(([catName, category]) => {
        Object.keys(category.topics || {}).forEach(topicName => {
            if (topicName !== currentTopicName) { // Don't include current topic
                allTopics.push(`${catName}/${topicName}`);
            }
        });
    });

    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Link to Existing Topic</h3>
                <button class="btn-icon" onclick="closeModal('link-topic-modal')">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">Select Topic to Link</label>
                    <select class="select" id="link-topic-select">
                        <option value="">-- Select a topic --</option>
                        ${allTopics.map(topic => `
                            <option value="${topic}">${topic}</option>
                        `).join('')}
                    </select>
                    <small class="text-muted">This topic will inherit all SEOs from the linked topic</small>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('link-topic-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveLinkTopic('${botName}', '${categoryName}', '${currentTopicName}')">Link</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

async function saveLinkTopic(botName, categoryName, topicName) {
    const linkedTopicPath = document.getElementById('link-topic-select').value;

    if (!linkedTopicPath) {
        showAlert('Please select a topic to link', { icon: '⚠️' });
        return;
    }

    const bot = globalConfig.bots[botName];
    const topic = bot.categories[categoryName].topics[topicName];

    if (!topic.linked_topics) topic.linked_topics = [];

    // Extract just the topic name from the path (e.g., "middle_east/lebanon" -> "lebanon")
    const linkedTopicName = linkedTopicPath.split('/')[1];

    if (topic.linked_topics.includes(linkedTopicName)) {
        showAlert('This topic is already linked', { icon: '⚠️' });
        return;
    }

    topic.linked_topics.push(linkedTopicName);

    const result = await api('/api/bot/save', { name: botName, ...bot });
    if (result.status === 'updated') {
        await loadAllData();
        renderBotsPage();
        closeModal('link-topic-modal');
        showNotification('Topic linked', 'success');
    }
}

async function removeLinkedTopic(botName, categoryName, topicName, index) {
    const bot = globalConfig.bots[botName];
    const topic = bot.categories[categoryName].topics[topicName];

    if (!topic.linked_topics) return;

    topic.linked_topics.splice(index, 1);

    const result = await api('/api/bot/save', { name: botName, ...bot });
    if (result.status === 'updated') {
        await loadAllData();
        renderBotsPage();
        showNotification('Topic unlinked', 'success');
    }
}

// ==================== Keyword Management ====================
function handleKeywordInput(event, botName, categoryName, topicName) {
    if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const value = event.target.value.trim();
        if (value) {
            addKeyword(botName, categoryName, topicName, value);
            event.target.value = '';
        }
        return false;
    }
}

async function addKeyword(botName, categoryName, topicName, keyword) {
    const topic = globalConfig.bots[botName].categories[categoryName].topics[topicName];
    if (!topic.keywords) topic.keywords = [];

    // Split comma-separated keywords (trim whitespace around each)
    const keywordsToAdd = keyword.split(',').map(kw => kw.trim()).filter(kw => kw);

    if (keywordsToAdd.length === 0) return;

    const seoHidden = topic._keyword_count != null;

    // When keyword text is hidden, use per-keyword add (don't overwrite admin's keywords)
    if (seoHidden) {
        const ukKey = `${botName}|${categoryName}|${topicName}`;
        if (!_userAddedKeywords[ukKey]) _userAddedKeywords[ukKey] = [];
        let addedCount = 0;
        for (const kw of keywordsToAdd) {
            // Skip duplicates already tracked locally
            if (_userAddedKeywords[ukKey].includes(kw)) continue;
            const result = await api('/api/topic/keyword/add', {
                bot_name: botName, category_name: categoryName,
                topic_name: topicName, keyword: kw
            });
            if (result.status === 'ok' && result.inserted) {
                _userAddedKeywords[ukKey].push(kw);
                // Update the local count so the label stays accurate
                topic._keyword_count = (topic._keyword_count || 0) + 1;
                addedCount++;
            }
        }
        if (addedCount > 0) {
            const topicId = `topic-${botName}-${categoryName}-${topicName}`;
            const categoryId = `categories-${botName}`;
            renderBotsPage([topicId, categoryId]);
            showNotification(addedCount === 1 ? 'SEO added' : `${addedCount} SEOs added`, 'success');
        }
        return;
    }

    let addedCount = 0;
    const skipped = [];
    keywordsToAdd.forEach(kw => {
        if (topic.keywords.includes(kw)) { skipped.push(kw); return; }
        topic.keywords.push(kw);
        addedCount++;
    });

    if (skipped.length > 0) {
        showNotification(`Skipped ${skipped.length} duplicate(s): ${skipped.join(', ')}`, 'info');
    }

    if (addedCount > 0) {
        const result = await api('/api/topic/update', {
            bot_name: botName,
            category_name: categoryName,
            topic_name: topicName,
            keywords: topic.keywords
        });

        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${botName}-${categoryName}-${topicName}`;
            const categoryId = `categories-${botName}`;
            renderBotsPage([topicId, categoryId]);
            const message = addedCount === 1 ? 'SEO added' : `${addedCount} SEOs added`;
            showNotification(message, 'success');
        }
    }
}

async function removeUserKeyword(botName, categoryName, topicName, kw) {
    const result = await api('/api/topic/keyword/delete', {
        bot_name: botName, category_name: categoryName,
        topic_name: topicName, keyword: kw
    });
    if (result.status !== 'ok') {
        showNotification('Failed to remove SEO', 'error');
        return;
    }
    const ukKey = `${botName}|${categoryName}|${topicName}`;
    if (_userAddedKeywords[ukKey]) {
        _userAddedKeywords[ukKey] = _userAddedKeywords[ukKey].filter(k => k !== kw);
    }
    // Decrement local count
    const topic = globalConfig?.bots?.[botName]?.categories?.[categoryName]?.topics?.[topicName];
    if (topic && topic._keyword_count > 0) topic._keyword_count--;
    const topicId = `topic-${botName}-${categoryName}-${topicName}`;
    const categoryId = `categories-${botName}`;
    renderBotsPage([topicId, categoryId]);
    showNotification('SEO removed', 'success');
}

function kwSelectionChanged(b, c, t) {
    const container = document.getElementById(`kw-tags-${b}-${c}-${t}`);
    if (!container) return;
    const anyChecked = container.querySelector('.kw-cb:checked');
    const delBtn = document.querySelector(`.kw-del-sel-btn[data-topic="${b}|${c}|${t}"]`);
    if (delBtn) delBtn.style.display = anyChecked ? '' : 'none';
}

function kwToggleSelectAll(b, c, t) {
    const container = document.getElementById(`kw-tags-${b}-${c}-${t}`);
    if (!container) return;
    const cbs = container.querySelectorAll('.kw-cb');
    const allChecked = [...cbs].every(cb => cb.checked);
    cbs.forEach(cb => cb.checked = !allChecked);
    kwSelectionChanged(b, c, t);
}

function kwDeleteSelected(b, c, t) {
    const container = document.getElementById(`kw-tags-${b}-${c}-${t}`);
    if (!container) return;
    const checked = container.querySelectorAll('.kw-cb:checked');
    const indices = [...checked].map(cb => Number(cb.closest('.kw-selectable').dataset.idx));
    if (!indices.length) return;
    const count = indices.length;
    showConfirm(`Delete ${count} selected keyword${count > 1 ? 's' : ''}?`, async () => {
        const topic = globalConfig.bots[b].categories[c].topics[t];
        // Remove from highest index first to preserve lower indices
        indices.sort((a, x) => x - a).forEach(i => topic.keywords.splice(i, 1));
        const result = await api('/api/topic/update', {
            bot_name: b, category_name: c, topic_name: t, keywords: topic.keywords
        });
        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${b}-${c}-${t}`;
            const categoryId = `categories-${b}`;
            renderBotsPage([topicId, categoryId]);
            showNotification(`${count} keyword${count > 1 ? 's' : ''} deleted`, 'success');
        }
    }, { title: 'Delete Keywords' });
}

function kwDeleteAll(b, c, t) {
    const topic = globalConfig.bots[b]?.categories[c]?.topics[t];
    if (!topic?.keywords?.length) return;
    const count = topic.keywords.length;
    showConfirm(`Delete all ${count} keywords from this topic?`, async () => {
        const result = await api('/api/topic/update', {
            bot_name: b, category_name: c, topic_name: t, keywords: []
        });
        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${b}-${c}-${t}`;
            const categoryId = `categories-${b}`;
            renderBotsPage([topicId, categoryId]);
            showNotification(`All ${count} keywords deleted`, 'success');
        }
    }, { title: 'Delete All Keywords' });
}

async function removeKeyword(botName, categoryName, topicName, index) {
    const topic = globalConfig.bots[botName].categories[categoryName].topics[topicName];
    topic.keywords.splice(index, 1);

    const result = await api('/api/topic/update', {
        bot_name: botName,
        category_name: categoryName,
        topic_name: topicName,
        keywords: topic.keywords
    });

    if (result.status === 'ok') {
        await loadAllData();
        const topicId = `topic-${botName}-${categoryName}-${topicName}`;
        const categoryId = `categories-${botName}`;
        renderBotsPage([topicId, categoryId]);
        showNotification('Keyword removed', 'success');
    }
}

// ==================== Topic Schedule Management ====================
function openAddTopicScheduleModal(botName, categoryName, topicName) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'topic-schedule-modal';

    // Get bot-specific prompts
    const botPrompts = (globalPrompts && globalPrompts[botName]) || {};

    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Add Schedule to ${topicName}</h3>
                <button class="btn-icon" onclick="closeModal('topic-schedule-modal')">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">Schedule Name</label>
                    <input type="text" class="input" id="topic-schedule-name" placeholder="e.g., Hourly Updates">
                </div>
                <div class="form-group">
                    <label class="form-label">Schedule Type</label>
                    <select class="select" id="topic-schedule-type" onchange="updateTopicScheduleInputs()">
                        <option value="minute">Every Minute</option>
                        <option value="hourly" selected>Hourly</option>
                        <option value="interval_minutes">Every X Minutes</option>
                        <option value="interval">Every X Hours</option>
                        <option value="daily">Daily</option>
                        <option value="speeches_interval">Speeches Interval</option>
                    </select>
                </div>
                <div class="form-group" id="topic-schedule-inputs">
                    <label class="form-label">Minute</label>
                    <input type="number" class="input" id="topic-schedule-minute" min="0" max="59" value="0">
                </div>
                <div class="form-group">
                    <label class="form-label">Prompt</label>
                    <select class="select" id="topic-schedule-prompt">
                        ${Object.keys(botPrompts).map(key => `
                            <option value="${key}">${key}</option>
                        `).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Header</label>
                    <input type="text" class="input" id="topic-schedule-header" placeholder="**Schedule Name**">
                    <small class="text-muted">Leave empty to use *schedule name* as header. Clear completely to send without header.</small>
                </div>
                <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                    <label class="toggle-switch">
                        <input type="checkbox" id="topic-schedule-header-datetime" onchange="toggleSchDatetimeOptions('topic-schedule')">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="form-label" style="margin:0;">Show date & time in header</span>
                </div>
                <div id="topic-schedule-datetime-opts" style="display:none;padding-left:16px;">
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="topic-schedule-date-arabic">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Date in Arabic numerals (٢٠٢٦/٠٣/٢١)</span>
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="topic-schedule-time-arabic">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Time in Arabic numerals (٠٣:٠٩ م)</span>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Telegram Targets (optional)</label>
                    <div class="tags-container" id="topic-schedule-tg-targets"></div>
                    <input type="text" class="input mt-1" id="topic-schedule-tg-input"
                           placeholder="@channel or chat ID — press Enter to add"
                           onkeydown="if(event.key==='Enter'){event.preventDefault();addSchTgTarget('topic-schedule');}">
                    <small class="text-muted sch-tg-hint" id="topic-schedule-tg-hint">Leave empty to use collection targets.</small>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('topic-schedule-modal')">Cancel</button>
                <button class="btn btn-primary"
                        onclick="saveTopicSchedule('${botName}', '${categoryName}', '${topicName}')">Add</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

function updateTopicScheduleInputs() {
    const type = document.getElementById('topic-schedule-type').value;
    const container = document.getElementById('topic-schedule-inputs');
    
    if (type === 'minute') {
        container.innerHTML = `
            <label class="form-label">Every N Minutes</label>
            <input type="number" class="input" id="topic-schedule-minute" min="1" max="59" value="1">
        `;
    } else if (type === 'hourly') {
        container.innerHTML = `
            <label class="form-label">Minute</label>
            <input type="number" class="input" id="topic-schedule-minute" min="0" max="59" value="0">
        `;
    } else if (type === 'interval_minutes') {
        container.innerHTML = `
            <label class="form-label">Every X Minutes</label>
            <input type="number" class="input" id="topic-schedule-minutes" min="1" max="1440" value="30">
            <label class="form-label mt-1">Starts at (HH : MM)</label>
            <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="topic-schedule-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                <input type="number" class="input" id="topic-schedule-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
            </div>
            <label class="form-label mt-1">Ends at (HH : MM) — leave blank to run indefinitely</label>
            <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="topic-schedule-end-hour" min="0" max="23" placeholder="HH" style="width:80px;">
                <input type="number" class="input" id="topic-schedule-end-minute" min="0" max="59" placeholder="MM" style="width:80px;">
            </div>
            <small class="text-muted">First run at start time, then every X minutes until end time. Next day resumes at start time.</small>
        `;
    } else if (type === 'interval') {
        container.innerHTML = `
            <label class="form-label">Every X Hours</label>
            <input type="number" class="input" id="topic-schedule-hours" min="1" max="24" value="2">
            <label class="form-label mt-1">Starts at (HH : MM)</label>
            <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="topic-schedule-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                <input type="number" class="input" id="topic-schedule-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
            </div>
            <label class="form-label mt-1">Ends at (HH : MM) — leave blank to run indefinitely</label>
            <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="topic-schedule-end-hour" min="0" max="23" placeholder="HH" style="width:80px;">
                <input type="number" class="input" id="topic-schedule-end-minute" min="0" max="59" placeholder="MM" style="width:80px;">
            </div>
            <small class="text-muted">First run at start time, then every X hours until end time. Next day resumes at start time and sends all messages since end time.</small>
        `;
    } else if (type === 'daily') {
        container.innerHTML = `
            <label class="form-label">Hour</label>
            <input type="number" class="input" id="topic-schedule-hour" min="0" max="23" value="18">
            <label class="form-label mt-1">Minute</label>
            <input type="number" class="input" id="topic-schedule-minute" min="0" max="59" value="0">
        `;
    } else if (type === 'speeches_interval') {
        container.innerHTML = `
            <label class="form-label">Wait Time (mins) — send buckets when idle</label>
            <input type="number" class="input" id="topic-schedule-wait-time" min="1" value="5">
            <small class="text-muted">Checks every minute. Sends each bucket as a separate message after this many idle minutes. Separate LLM response sections with <code>---</code>.</small>`;
    }
}

async function saveTopicSchedule(botName, categoryName, topicName) {
    const name = document.getElementById('topic-schedule-name').value.trim();
    const type = document.getElementById('topic-schedule-type').value;
    const prompt_key = document.getElementById('topic-schedule-prompt').value;
    
    if (!name) {
        showAlert('Please enter a schedule name', { icon: '✏️' });
        return;
    }
    
    const header = document.getElementById('topic-schedule-header').value;
    const header_datetime = document.getElementById('topic-schedule-header-datetime').checked;
    const header_date_arabic = document.getElementById('topic-schedule-date-arabic').checked;
    const header_time_arabic = document.getElementById('topic-schedule-time-arabic').checked;
    const telegram_targets = getSchTgTargets('topic-schedule');
    const schedule = { name, type, prompt_key, header, header_datetime, header_date_arabic, header_time_arabic, telegram_targets };

    if (type === 'minute') {
        schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
    } else if (type === 'hourly') {
        schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
    } else if (type === 'interval_minutes') {
        schedule.minutes      = Number(document.getElementById('topic-schedule-minutes').value);
        schedule.start_hour   = Number(document.getElementById('topic-schedule-start-hour').value);
        schedule.start_minute = Number(document.getElementById('topic-schedule-start-minute').value);
        const ehM = document.getElementById('topic-schedule-end-hour').value;
        const emM = document.getElementById('topic-schedule-end-minute').value;
        if (ehM !== '' && emM !== '') { schedule.end_hour = Number(ehM); schedule.end_minute = Number(emM); }
    } else if (type === 'interval') {
        schedule.hours        = Number(document.getElementById('topic-schedule-hours').value);
        schedule.start_hour   = Number(document.getElementById('topic-schedule-start-hour').value);
        schedule.start_minute = Number(document.getElementById('topic-schedule-start-minute').value);
        const ehI = document.getElementById('topic-schedule-end-hour').value;
        const emI = document.getElementById('topic-schedule-end-minute').value;
        if (ehI !== '' && emI !== '') { schedule.end_hour = Number(ehI); schedule.end_minute = Number(emI); }
    } else if (type === 'daily') {
        schedule.hour   = Number(document.getElementById('topic-schedule-hour').value);
        schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
    } else if (type === 'speeches_interval') {
        schedule.wait_time = Number(document.getElementById('topic-schedule-wait-time').value);
    }

    const result = await api('/api/topic/schedule/add', {
        bot_name: botName,
        category_name: categoryName,
        topic_name: topicName,
        schedule
    });
    
    if (result.status === 'ok') {
        await loadAllData();
        const topicId = `topic-${botName}-${categoryName}-${topicName}`;
        const categoryId = `categories-${botName}`;
        renderBotsPage([topicId, categoryId]); // Keep topic and category open
        closeModal('topic-schedule-modal');
        showNotification('Schedule added', 'success');
    } else {
        showNotification('Failed to add schedule', 'error');
    }
}

async function toggleTopicSchedule(botName, categoryName, topicName, scheduleId, enabled) {
    const result = await api('/api/topic/schedule/update', {
        schedule_id: scheduleId,
        schedule: { enabled }
    });

    if (result.status === 'ok') {
        await loadAllData();
        const topicId = `topic-${botName}-${categoryName}-${topicName}`;
        const categoryId = `categories-${botName}`;
        renderBotsPage([topicId, categoryId]);
        showNotification('Schedule updated', 'success');
    }
}

async function deleteTopicSchedule(botName, categoryName, topicName, scheduleId) {
    showConfirm('Delete this schedule?', async () => {
        const result = await api('/api/topic/schedule/delete', {
            schedule_id: scheduleId,
            bot_name: botName,
            category_name: categoryName,
            topic_name: topicName
        });

        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${botName}-${categoryName}-${topicName}`;
            const categoryId = `categories-${botName}`;
            renderBotsPage([topicId, categoryId]);
            showNotification('Schedule deleted', 'success');
        }
    }, { title: 'Delete Schedule' });
}

// ==================== Schedule 3-dots Menu ====================
function toggleSchMenu(e, btn) {
    e.stopPropagation();
    const dropdown = btn.nextElementSibling;
    const isOpen = dropdown.classList.contains('open');
    closeAllSchMenus();
    if (!isOpen) {
        // Show hidden first to measure dimensions, then position
        dropdown.style.visibility = 'hidden';
        dropdown.classList.add('open');
        const rect = btn.getBoundingClientRect();
        const dw   = dropdown.offsetWidth;
        const dh   = dropdown.offsetHeight;
        // Right-align with button; flip up if no room below
        const left     = Math.max(4, rect.right - dw);
        const topBelow = rect.bottom + 4;
        const topAbove = rect.top - dh - 4;
        const finalTop = (topBelow + dh > window.innerHeight) ? topAbove : topBelow;
        dropdown.style.top        = `${finalTop}px`;
        dropdown.style.left       = `${left}px`;
        dropdown.style.visibility = '';
    }
}

function closeAllSchMenus() {
    document.querySelectorAll('.sch-menu-dropdown.open').forEach(d => d.classList.remove('open'));
}

document.addEventListener('click', closeAllSchMenus);

// ==================== Edit Schedule Modal ====================
function toggleSchDatetimeOptions(prefix) {
    const checked = document.getElementById(`${prefix}-header-datetime`).checked;
    const opts = document.getElementById(`${prefix}-datetime-opts`);
    if (opts) opts.style.display = checked ? 'block' : 'none';
}

function addSchTgTarget(prefix) {
    const input = document.getElementById(`${prefix}-tg-input`);
    const container = document.getElementById(`${prefix}-tg-targets`);
    if (!input || !container) return;
    const val = input.value.trim();
    if (!val) return;
    // Check for duplicate
    const existing = [...container.querySelectorAll('.tag')].map(t => t.textContent.replace('×', '').trim());
    if (existing.includes(val)) { input.value = ''; return; }
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${escapeHtmlSys(val)}<span class="tag-remove" onclick="removeSchTgTarget('${prefix}', this)">×</span>`;
    container.appendChild(tag);
    input.value = '';
    _updateSchTgHint(prefix);
}

function removeSchTgTarget(prefix, el) {
    el.closest('.tag').remove();
    _updateSchTgHint(prefix);
}

function _updateSchTgHint(prefix) {
    const hint = document.getElementById(`${prefix}-tg-hint`);
    if (!hint) return;
    const container = document.getElementById(`${prefix}-tg-targets`);
    const hasTargets = container && container.querySelectorAll('.tag').length > 0;
    if (hasTargets) {
        hint.innerHTML = '⚠️ These targets <b>override</b> the collection target channels your bot is subscribed to.';
        hint.style.color = 'var(--warning)';
    } else {
        hint.textContent = 'Leave empty to use collection targets.';
        hint.style.color = '';
    }
}

function getSchTgTargets(prefix) {
    // Auto-add any text left in the input field (user typed but didn't press Enter)
    const input = document.getElementById(`${prefix}-tg-input`);
    if (input && input.value.trim()) {
        addSchTgTarget(prefix);
    }
    const container = document.getElementById(`${prefix}-tg-targets`);
    if (!container) return [];
    return [...container.querySelectorAll('.tag')].map(t => t.textContent.replace('×', '').trim()).filter(Boolean);
}

function openEditTopicScheduleModal(botName, categoryName, topicName, scheduleId) {
    const schedules = globalConfig.bots[botName]?.categories[categoryName]?.topics[topicName]?.schedules || [];
    const schedule = schedules.find(s => s.id === scheduleId);
    if (!schedule) return;

    const botPrompts = (globalPrompts && globalPrompts[botName]) || {};
    const existingModal = document.getElementById('topic-schedule-edit-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'topic-schedule-edit-modal';
    modal.dataset.botName = botName;
    modal.dataset.categoryName = categoryName;
    modal.dataset.topicName = topicName;

    const typeOptions = ['minute', 'hourly', 'interval_minutes', 'interval', 'daily', 'speeches_interval'];
    const typeLabels  = { minute: 'Every Minute', hourly: 'Hourly', interval_minutes: 'Every X Minutes', interval: 'Every X Hours', daily: 'Daily', speeches_interval: 'Speeches Interval' };

    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Edit Schedule — ${escapeHtmlSys(schedule.name)}</h3>
                <button class="btn-icon" onclick="closeModal('topic-schedule-edit-modal')">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">Schedule Name</label>
                    <input type="text" class="input" id="edit-sch-name" value="${escapeHtmlSys(schedule.name)}">
                </div>
                <div class="form-group">
                    <label class="form-label">Schedule Type</label>
                    <select class="select" id="edit-sch-type" onchange="updateEditScheduleInputs()">
                        ${typeOptions.map(t => `<option value="${t}"${schedule.type === t ? ' selected' : ''}>${typeLabels[t]}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group" id="edit-sch-inputs">
                    ${buildEditScheduleInputs(schedule)}
                </div>
                <div class="form-group">
                    <label class="form-label">Prompt</label>
                    <select class="select" id="edit-sch-prompt">
                        ${Object.keys(botPrompts).map(key => `
                            <option value="${key}"${schedule.prompt_key === key ? ' selected' : ''}>${key}</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Header</label>
                    <input type="text" class="input" id="edit-sch-header" value="${escapeHtmlSys(schedule.header || `*${schedule.name}*`)}">
                    <small class="text-muted">Leave empty to send without header.</small>
                </div>
                <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                    <label class="toggle-switch">
                        <input type="checkbox" id="edit-sch-header-datetime" ${schedule.header_datetime ? 'checked' : ''} onchange="toggleSchDatetimeOptions('edit-sch')">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="form-label" style="margin:0;">Show date & time in header</span>
                </div>
                <div id="edit-sch-datetime-opts" style="display:${schedule.header_datetime ? 'block' : 'none'};padding-left:16px;">
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="edit-sch-date-arabic" ${schedule.header_date_arabic ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Date in Arabic numerals (٢٠٢٦/٠٣/٢١)</span>
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="edit-sch-time-arabic" ${schedule.header_time_arabic ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Time in Arabic numerals (٠٣:٠٩ م)</span>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Telegram Targets (optional)</label>
                    <div class="tags-container" id="edit-sch-tg-targets">
                        ${(schedule.telegram_targets || []).map(t => `
                            <span class="tag">${escapeHtmlSys(t)}
                                <span class="tag-remove" onclick="removeSchTgTarget('edit-sch', this)">×</span>
                            </span>
                        `).join('')}
                    </div>
                    <input type="text" class="input mt-1" id="edit-sch-tg-input"
                           placeholder="@channel or chat ID — press Enter to add"
                           onkeydown="if(event.key==='Enter'){event.preventDefault();addSchTgTarget('edit-sch');}">
                    <small class="text-muted sch-tg-hint" id="edit-sch-tg-hint">${(schedule.telegram_targets || []).length ? 'These targets override the collection target channels your bot is subscribed to.' : 'Leave empty to use collection targets.'}</small>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('topic-schedule-edit-modal')">Cancel</button>
                <button class="btn btn-primary"
                        onclick="saveEditedSchedule(${scheduleId})">Save Changes</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

function buildEditScheduleInputs(schedule) {
    const type = schedule.type;
    if (type === 'minute') {
        return `<label class="form-label">Every N Minutes</label>
                <input type="number" class="input" id="edit-sch-minute" min="1" max="59" value="${schedule.minute || 1}">`;
    } else if (type === 'hourly') {
        return `<label class="form-label">Minute</label>
                <input type="number" class="input" id="edit-sch-minute" min="0" max="59" value="${schedule.minute || 0}">`;
    } else if (type === 'interval_minutes') {
        const ehM = schedule.end_hour   != null ? schedule.end_hour   : '';
        const emM = schedule.end_minute != null ? schedule.end_minute : '';
        return `<label class="form-label">Every X Minutes</label>
                <input type="number" class="input" id="edit-sch-minutes" min="1" max="1440" value="${schedule.minutes || 30}">
                <label class="form-label mt-1">Starts at (HH : MM)</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="edit-sch-start-hour" min="0" max="23" value="${schedule.start_hour ?? 0}" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="edit-sch-start-minute" min="0" max="59" value="${schedule.start_minute ?? 0}" placeholder="MM" style="width:80px;">
                </div>
                <label class="form-label mt-1">Ends at (HH : MM) — leave blank to run indefinitely</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="edit-sch-end-hour" min="0" max="23" value="${ehM}" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="edit-sch-end-minute" min="0" max="59" value="${emM}" placeholder="MM" style="width:80px;">
                </div>
                <small class="text-muted">First run at start time, then every X minutes until end time. Next day resumes at start time.</small>`;
    } else if (type === 'interval') {
        const ehI = schedule.end_hour   != null ? schedule.end_hour   : '';
        const emI = schedule.end_minute != null ? schedule.end_minute : '';
        return `<label class="form-label">Every X Hours</label>
                <input type="number" class="input" id="edit-sch-hours" min="1" max="24" value="${schedule.hours || 2}">
                <label class="form-label mt-1">Starts at (HH : MM)</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="edit-sch-start-hour" min="0" max="23" value="${schedule.start_hour ?? 0}" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="edit-sch-start-minute" min="0" max="59" value="${schedule.start_minute ?? 0}" placeholder="MM" style="width:80px;">
                </div>
                <label class="form-label mt-1">Ends at (HH : MM) — leave blank to run indefinitely</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="edit-sch-end-hour" min="0" max="23" value="${ehI}" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="edit-sch-end-minute" min="0" max="59" value="${emI}" placeholder="MM" style="width:80px;">
                </div>
                <small class="text-muted">First run at start time, then every X hours until end time. Next day resumes at start time and sends all messages since end time.</small>`;
    } else if (type === 'daily') {
        return `<label class="form-label">Hour</label>
                <input type="number" class="input" id="edit-sch-hour" min="0" max="23" value="${schedule.hour || 0}">
                <label class="form-label mt-1">Minute</label>
                <input type="number" class="input" id="edit-sch-minute" min="0" max="59" value="${schedule.minute || 0}">`;
    } else if (type === 'speeches_interval') {
        return `<label class="form-label">Wait Time (mins) — send buckets when idle</label>
                <input type="number" class="input" id="edit-sch-wait-time" min="1" value="${schedule.wait_time || 5}">
                <small class="text-muted">Checks every minute. Sends each bucket as a separate message after this many idle minutes. Separate LLM response sections with <code>---</code>.</small>`;
    }
    return '';
}

function updateEditScheduleInputs() {
    const type = document.getElementById('edit-sch-type').value;
    const container = document.getElementById('edit-sch-inputs');
    container.innerHTML = buildEditScheduleInputs({ type });
}

async function saveEditedSchedule(scheduleId) {
    const name = document.getElementById('edit-sch-name').value.trim();
    const type = document.getElementById('edit-sch-type').value;
    const prompt_key = document.getElementById('edit-sch-prompt').value;

    if (!name) {
        showAlert('Please enter a schedule name', { icon: '✏️' });
        return;
    }

    const header = document.getElementById('edit-sch-header').value;
    const header_datetime = document.getElementById('edit-sch-header-datetime').checked;
    const header_date_arabic = document.getElementById('edit-sch-date-arabic').checked;
    const header_time_arabic = document.getElementById('edit-sch-time-arabic').checked;
    const telegram_targets = getSchTgTargets('edit-sch');
    const schedule = { name, type, prompt_key, header, header_datetime, header_date_arabic, header_time_arabic, telegram_targets };

    if (type === 'minute') {
        schedule.minute = Number(document.getElementById('edit-sch-minute').value);
    } else if (type === 'hourly') {
        schedule.minute = Number(document.getElementById('edit-sch-minute').value);
    } else if (type === 'interval_minutes') {
        schedule.minutes      = Number(document.getElementById('edit-sch-minutes').value);
        schedule.start_hour   = Number(document.getElementById('edit-sch-start-hour').value);
        schedule.start_minute = Number(document.getElementById('edit-sch-start-minute').value);
        const ehM = document.getElementById('edit-sch-end-hour').value;
        const emM = document.getElementById('edit-sch-end-minute').value;
        schedule.end_hour   = (ehM !== '' && emM !== '') ? Number(ehM) : null;
        schedule.end_minute = (ehM !== '' && emM !== '') ? Number(emM) : null;
    } else if (type === 'interval') {
        schedule.hours        = Number(document.getElementById('edit-sch-hours').value);
        schedule.start_hour   = Number(document.getElementById('edit-sch-start-hour').value);
        schedule.start_minute = Number(document.getElementById('edit-sch-start-minute').value);
        const ehI = document.getElementById('edit-sch-end-hour').value;
        const emI = document.getElementById('edit-sch-end-minute').value;
        schedule.end_hour   = (ehI !== '' && emI !== '') ? Number(ehI) : null;
        schedule.end_minute = (ehI !== '' && emI !== '') ? Number(emI) : null;
    } else if (type === 'daily') {
        schedule.hour   = Number(document.getElementById('edit-sch-hour').value);
        schedule.minute = Number(document.getElementById('edit-sch-minute').value);
    } else if (type === 'speeches_interval') {
        schedule.wait_time = Number(document.getElementById('edit-sch-wait-time').value);
    }

    const result = await api('/api/topic/schedule/update', {
        schedule_id: scheduleId,
        schedule
    });

    if (result.status === 'ok') {
        await loadAllData();
        const modal = document.getElementById('topic-schedule-edit-modal');
        const bn = modal?.dataset.botName;
        const cn = modal?.dataset.categoryName;
        const tn = modal?.dataset.topicName;
        const keepOpen = bn ? [`topic-${bn}-${cn}-${tn}`, `categories-${bn}`] : null;
        renderBotsPage(keepOpen);
        closeModal('topic-schedule-edit-modal');
        showNotification('Schedule updated', 'success');
    } else {
        showNotification('Failed to update schedule', 'error');
    }
}

// ==================== Utility Functions ====================
function showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 16px 24px;
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
        color: white;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        z-index: 10001;
        animation: slideIn 0.3s;
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function toggleCollapsible(id) {
    const section = document.getElementById(id);
    if (section) {
        section.classList.toggle('open');

        // Save state to localStorage
        const isOpen = section.classList.contains('open');
        saveCollapsibleState(id, isOpen);

        // Lazy-render category topics on first open
        if (isOpen) _renderLazyCategoryContent(section);
    }
}

// ==================== Collapsible State Persistence ====================
const COLLAPSIBLE_STATE_KEY = 'collapsibleStates';

function saveCollapsibleState(elementId, isOpen) {
    try {
        const states = JSON.parse(localStorage.getItem(COLLAPSIBLE_STATE_KEY) || '{}');
        states[elementId] = isOpen;
        localStorage.setItem(COLLAPSIBLE_STATE_KEY, JSON.stringify(states));
    } catch (e) {
        console.error('Failed to save collapsible state:', e);
    }
}

function loadCollapsibleState(elementId) {
    try {
        const states = JSON.parse(localStorage.getItem(COLLAPSIBLE_STATE_KEY) || '{}');
        return states[elementId];
    } catch (e) {
        console.error('Failed to load collapsible state:', e);
        return null;
    }
}

function restoreCollapsibleStates() {
    try {
        const states = JSON.parse(localStorage.getItem(COLLAPSIBLE_STATE_KEY) || '{}');

        for (const [elementId, isOpen] of Object.entries(states)) {
            const element = document.getElementById(elementId);
            if (element) {
                if (isOpen) {
                    element.classList.add('open');
                } else {
                    element.classList.remove('open');
                }
            }
        }
    } catch (e) {
        console.error('Failed to restore collapsible states:', e);
    }
}

function clearStaleCollapsibleStates() {
    try {
        const states = JSON.parse(localStorage.getItem(COLLAPSIBLE_STATE_KEY) || '{}');
        const cleanedStates = {};

        for (const [elementId, isOpen] of Object.entries(states)) {
            if (document.getElementById(elementId)) {
                cleanedStates[elementId] = isOpen;
            }
        }

        localStorage.setItem(COLLAPSIBLE_STATE_KEY, JSON.stringify(cleanedStates));
    } catch (e) {
        console.error('Failed to clear stale states:', e);
    }
}

// ==================== Scroll Position Restoration ====================
const SCROLL_STORAGE_KEY = 'botsPageScrollPosition';

function saveBotsPageScrollPosition() {
    const botsPage = document.getElementById('bots-page');
    if (botsPage && botsPage.classList.contains('active')) {
        const scrollPos = window.scrollY || document.documentElement.scrollTop;
        localStorage.setItem(SCROLL_STORAGE_KEY, scrollPos.toString());
    }
}

function restoreBotsPageScrollPosition() {
    const savedPosition = localStorage.getItem(SCROLL_STORAGE_KEY);
    if (savedPosition) {
        setTimeout(() => {
            window.scrollTo({
                top: parseInt(savedPosition, 10),
                behavior: 'smooth'
            });
        }, 100); // Delay for DOM rendering
    }
}

// Save before page unload
window.addEventListener('beforeunload', saveBotsPageScrollPosition);

function closeModal(id) {
    closeChannelPicker();
    const modal = document.getElementById(id);
    if (modal) modal.remove();
}

// Add animations
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

// ==================== Monitor Page ====================
let _monitorData = null;
let _monitorTimerInterval = null;
let _monitorRefreshInterval = null;
let _monActiveTab = localStorage.getItem('mon-active-tab') || 'schedules';
let _allSummaries = [];
let _allMessages  = [];


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
    if (tab === 'messages' && !_allMessages.length) loadMonitorMessages();
    if (tab === 'history') loadScheduleHistory();
    if (tab === 'unclassified') {
        // Restore clear/show-all button state from persisted timestamp
        const clearedAt = localStorage.getItem('mon-uncl-cleared-at');
        const clearBtn   = document.getElementById('uncl-clear-btn');
        const showAllBtn = document.getElementById('uncl-showall-btn');
        if (clearBtn)   clearBtn.style.display   = clearedAt ? 'none' : '';
        if (showAllBtn) showAllBtn.style.display  = clearedAt ? ''     : 'none';
        if (!_unclMessages.length) loadUnclassifiedMessages();
    }
    if (tab === 'missed') {
        const clearedAt = localStorage.getItem('mon-missed-cleared-at');
        const clearBtn   = document.getElementById('missed-clear-btn');
        const showAllBtn = document.getElementById('missed-showall-btn');
        if (clearBtn)   clearBtn.style.display   = '';
        if (showAllBtn) showAllBtn.style.display  = clearedAt ? '' : 'none';
        if (!_missedMessages.length) loadMissedMessages();
    }
}

// ---------- Topics & Schedules ----------
let _monSchFlat = []; // flat list of {botName, catName, topicName, topicEnabled, sch, pending}

let _schSelectedTopics = new Set(); // multi-select state

function renderMonitorBots(bots) {
    // Build flat schedule list for filtering/sorting
    _monSchFlat = [];
    const allTopics = new Set();
    const allPrompts = new Set();
    Object.entries(bots).forEach(([botName, botData]) => {
        Object.entries(botData.categories || {}).forEach(([catName, catData]) => {
            Object.entries(catData.topics || {}).forEach(([topicName, topicData]) => {
                allTopics.add(topicName);
                (topicData.schedules || []).forEach(sch => {
                    if (sch.prompt_key) allPrompts.add(sch.prompt_key);
                    const p = topicData.pending || {};
                    _monSchFlat.push({
                        botName, catName, topicName,
                        botEnabled: botData.enabled,
                        topicEnabled: topicData.enabled !== false,
                        sch, pending: p[sch.type] || 0
                    });
                });
            });
        });
    });

    // Populate topic multi-select dropdown (preserve selection)
    const dd = document.getElementById('sch-filter-topic-dd');
    if (dd) {
        const sorted = [...allTopics].sort();
        dd.innerHTML = `<label class="mon-ms-item all-item"><input type="checkbox" onchange="schTopicSelectAll(this.checked)" ${_schSelectedTopics.size === 0 ? 'checked' : ''}> All Topics</label>` +
            sorted.map(t => {
                const checked = _schSelectedTopics.has(t) ? 'checked' : '';
                return `<label class="mon-ms-item"><input type="checkbox" value="${escapeHtml(t)}" ${checked} onchange="schTopicToggle(this)"> ${escapeHtml(t)}</label>`;
            }).join('');
        _updateSchTopicBtnLabel();
    }

    // Populate prompt filter dropdown (preserve selection)
    const promptSel = document.getElementById('sch-filter-prompt');
    if (promptSel) {
        const cur = promptSel.value;
        promptSel.innerHTML = '<option value="">All Prompts</option>' +
            [...allPrompts].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
        promptSel.value = cur;
    }

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

function schTopicSelectAll(checked) {
    _schSelectedTopics.clear();
    const dd = document.getElementById('sch-filter-topic-dd');
    if (dd) dd.querySelectorAll('input[value]').forEach(cb => cb.checked = false);
    _updateSchTopicBtnLabel();
    applySchFilters();
}

function schTopicToggle(cb) {
    if (cb.checked) _schSelectedTopics.add(cb.value);
    else _schSelectedTopics.delete(cb.value);
    // Update "All" checkbox
    const dd = document.getElementById('sch-filter-topic-dd');
    if (dd) {
        const allCb = dd.querySelector('.all-item input');
        if (allCb) allCb.checked = _schSelectedTopics.size === 0;
    }
    _updateSchTopicBtnLabel();
    applySchFilters();
}

function _updateSchTopicBtnLabel() {
    const wrap = document.getElementById('sch-filter-topic-wrap');
    if (!wrap) return;
    const btn = wrap.querySelector('.mon-ms-btn');
    if (!btn) return;
    if (_schSelectedTopics.size === 0) {
        btn.innerHTML = 'All Topics <span class="mon-ms-arrow">▾</span>';
    } else if (_schSelectedTopics.size <= 2) {
        btn.innerHTML = `${[..._schSelectedTopics].join(', ')} <span class="mon-ms-arrow">▾</span>`;
    } else {
        btn.innerHTML = `${_schSelectedTopics.size} topics <span class="mon-ms-arrow">▾</span>`;
    }
}

function applySchFilters() {
    const container = document.getElementById('monitor-bots-container');
    const filterPrompt = document.getElementById('sch-filter-prompt')?.value || '';
    const sortByTime = document.getElementById('sch-sort-time')?.checked || false;

    let items = _monSchFlat;
    if (_schSelectedTopics.size > 0) items = items.filter(r => _schSelectedTopics.has(r.topicName));
    if (filterPrompt) items = items.filter(r => (r.sch.prompt_key || '') === filterPrompt);

    if (!items.length) {
        container.innerHTML = '<p class="mon-empty">No schedules match the filter.</p>';
        return;
    }

    if (sortByTime) {
        // Sort by next run time (earliest first), disabled at bottom
        items = [...items].sort((a, b) => {
            if (a.sch.enabled === false && b.sch.enabled !== false) return 1;
            if (a.sch.enabled !== false && b.sch.enabled === false) return -1;
            const na = computeNextRun(a.sch) || Infinity;
            const nb = computeNextRun(b.sch) || Infinity;
            return na - nb;
        });
        // Flat rendering (no grouping by bot/category)
        const rows = items.map(r => renderSchRow(r)).join('');
        container.innerHTML = `<div class="mon-bot-card"><div class="mon-bot-hdr">All Schedules (sorted by next run)</div>${rows}</div>`;
    } else {
        // Grouped rendering: bot → category → topic → schedules
        const grouped = {};
        items.forEach(r => {
            if (!grouped[r.botName]) grouped[r.botName] = { enabled: r.botEnabled, cats: {} };
            if (!grouped[r.botName].cats[r.catName]) grouped[r.botName].cats[r.catName] = {};
            if (!grouped[r.botName].cats[r.catName][r.topicName]) grouped[r.botName].cats[r.catName][r.topicName] = { enabled: r.topicEnabled, rows: [] };
            grouped[r.botName].cats[r.catName][r.topicName].rows.push(r);
        });

        container.innerHTML = Object.entries(grouped).map(([botName, bd]) => {
            const dotCls = bd.enabled ? 'mon-bot-dot-on' : 'mon-bot-dot-off';
            const dotTxt = bd.enabled ? '● ACTIVE' : '● OFF';
            const botPending = _monSchFlat
                .filter(r => r.botName === botName)
                .reduce((s, r) => s + (r.pending || 0), 0);
            const catsHtml = Object.entries(bd.cats).map(([catName, topics]) => {
                const topicsHtml = Object.entries(topics).map(([topicName, td]) => {
                    const offCls = td.enabled ? '' : ' mon-topic-off';
                    const schRows = td.rows.map(r => renderSchRow(r)).join('');
                    const topicPending = td.rows.reduce((s, r) => s + (r.pending || 0), 0);
                    return `<div class="mon-topic-block">
                        <div class="mon-topic-title${offCls}">
                            <span>${escapeHtml(topicName)}${!td.enabled ? ' <span style="font-size:10px;color:var(--danger);">OFF</span>' : ''}</span>
                        </div>
                        ${schRows}
                    </div>`;
                }).join('');
                return `<div class="mon-cat-hdr">${escapeHtml(catName)}</div>${topicsHtml}`;
            }).join('');
            return `<div class="mon-bot-card">
                <div class="mon-bot-hdr">
                    <span>🤖 ${escapeHtml(botName)} <span class="${dotCls}">${dotTxt}</span></span>
                </div>
                ${catsHtml}
            </div>`;
        }).join('');
    }
}

function renderSchRow(r) {
    const pendingCls = r.pending > 0 ? 'has' : 'none';
    const pendingTxt = r.pending > 0 ? `${r.pending} pending` : 'none';
    const disabledCls = r.sch.enabled === false ? ' mon-sch-disabled' : '';
    const icon = scheduleIcon(r.sch);
    const spec = scheduleSpec(r.sch);
    const schJson = escapeHtml(JSON.stringify(r.sch));
    const topicLabel = document.getElementById('sch-sort-time')?.checked
        ? `<span class="mon-sch-topic">${escapeHtml(r.topicName)}</span>` : '';
    return `<div class="mon-sch-row${disabledCls}" data-schedule="${schJson}">
        <div class="mon-sch-left">
            <span class="mon-sch-icon">${icon}</span>
            ${topicLabel}
            <span class="mon-sch-name">${escapeHtml(r.sch.name || r.sch.type)}</span>
            <span class="mon-sch-prompt">${escapeHtml(r.sch.prompt_key || '')}</span>
            <span class="mon-sch-spec">${spec}</span>
        </div>
        <div class="mon-sch-right">
            <span class="mon-pending ${pendingCls}">${pendingTxt}</span>
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
    if (sch.type === 'interval')            return '🔁';
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
    if (sch.type === 'interval') {
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

// ---------- Countdown timer ----------
function startMonitorCountdowns() {
    if (_monitorTimerInterval) clearInterval(_monitorTimerInterval);
    _monitorTimerInterval = setInterval(tickCountdowns, 1000);
    tickCountdowns();
}

const _BEIRUT_TZ = 'Asia/Beirut';

function tickCountdowns() {
    document.querySelectorAll('[data-schedule]').forEach(row => {
        const cdEl   = row.querySelector('.mon-countdown');
        const timeEl = row.querySelector('.mon-next-time');
        if (!cdEl) return;
        let sch;
        try { sch = JSON.parse(row.dataset.schedule); } catch { return; }
        if (sch.enabled === false) {
            cdEl.textContent = '—';
            if (timeEl) timeEl.textContent = '';
            return;
        }
        const next = computeNextRun(sch);
        if (!next) {
            cdEl.textContent = '—';
            if (timeEl) timeEl.textContent = '';
            return;
        }
        const diff = Math.max(0, next - Date.now());
        cdEl.textContent = formatDuration(diff);
        cdEl.classList.toggle('urgent', diff < 60000);
        if (timeEl) {
            timeEl.textContent = next.toLocaleTimeString('en-GB', {
                timeZone: _BEIRUT_TZ,
                hour: '2-digit',
                minute: '2-digit',
            });
        }
    });
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
    if (sch.type === 'interval') {
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
    if (type === 'interval') {
        const h = String(sch.start_hour   ?? 0).padStart(2, '0');
        const m = String(sch.start_minute ?? 0).padStart(2, '0');
        return `${h}:${m}`;
    }
    if (type === 'minute') return '00:00';
    return '—';
}

function _scheduleRepeatsText(sch) {
    const type = sch.type;
    if (type === 'daily')    return 'once daily';
    if (type === 'hourly')   return `every hour at :${String(sch.minute ?? 0).padStart(2, '0')}`;
    if (type === 'minute')   return `every ${sch.minute ?? '?'} min`;
    if (type === 'interval') {
        const h = sch.hours ?? 1;
        return `every ${h} hour${h !== 1 ? 's' : ''}`;
    }
    return '—';
}

function _scheduleFiresPerDay(sch) {
    const type = sch.type;
    if (type === 'daily')    return 1;
    if (type === 'hourly')   return 24;
    if (type === 'minute')   return Math.floor(1440 / (sch.minute || 60));
    if (type === 'interval') {
        const startH = sch.start_hour   ?? 0;
        const endH   = sch.end_hour     ?? 24;
        const hours  = sch.hours        ?? 1;
        return Math.max(1, Math.floor((endH - startH) / hours));
    }
    return 0;
}

async function renderMonSummaries(summaries) {
    // summaries arg kept for compatibility but no longer used directly in the table
    _allSummaries = summaries;

    // Populate bot/topic filter dropdowns from bots_data
    const botsData = _monitorData?.bots || {};
    const allBots   = Object.keys(botsData).sort();
    const allTopics = [...new Set(
        Object.values(botsData).flatMap(b =>
            Object.values(b.categories || {}).flatMap(c => Object.keys(c.topics || {}))
        )
    )].sort();
    _populateMonSelect('sum-filter-bot',   allBots,   'All Bots');
    _populateMonSelect('sum-filter-topic', allTopics, 'All Topics');

    // Fetch today's stats
    const statsData = await api('/api/monitor/schedule-stats');
    _scheduleStats = (statsData.status === 'ok') ? (statsData.stats || []) : [];

    applyMonSummaryFilters();
}

function applyMonSummaryFilters() {
    const filterBot   = document.getElementById('sum-filter-bot')?.value   || '';
    const filterTopic = document.getElementById('sum-filter-topic')?.value || '';
    const filterType  = document.getElementById('sum-filter-type')?.value  || '';

    const el = document.getElementById('mon-summaries-content');
    if (!el) return;

    const botsData = _monitorData?.bots || {};

    // Build a stats lookup: key = "bot|topic|type"
    const statsLookup = {};
    for (const s of _scheduleStats) {
        const key = `${s.bot_name}|${s.topic_name}|${s.schedule_type}`;
        statsLookup[key] = { sent: s.sent || 0, failed: s.failed || 0 };
    }

    // Flatten all schedules from bots config
    const rows = [];
    for (const [botName, botData] of Object.entries(botsData)) {
        if (filterBot && botName !== filterBot) continue;
        if (!botData.enabled) continue;
        for (const [, catData] of Object.entries(botData.categories || {})) {
            if (!catData.enabled) continue;
            for (const [topicName, topicData] of Object.entries(catData.topics || {})) {
                if (filterTopic && topicName !== filterTopic) continue;
                if (!topicData.enabled) continue;
                for (const sch of (topicData.schedules || [])) {
                    if (!sch.enabled) continue;
                    if (filterType && sch.type !== filterType) continue;

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
        const repeats   = _scheduleRepeatsText(sch);
        const sentCell   = stat.sent   > 0 ? `<span style="color:var(--success,#22c55e);font-weight:600;">${stat.sent}</span>`   : `<span style="color:var(--text-muted);">0</span>`;
        const failedCell = stat.failed > 0 ? `<span style="color:var(--danger);font-weight:600;">${stat.failed}</span>`          : `<span style="color:var(--text-muted);">0</span>`;
        const remainCell = remain       > 0 ? `<span style="color:var(--text-secondary);">${remain}</span>`                      : `<span style="color:var(--text-muted);">0</span>`;
        return `<tr>
            <td>${escapeHtml(botName)}</td>
            <td>${escapeHtml(topicName)}</td>
            <td><span class="mon-type-badge ${typeCls}">${escapeHtml(sch.type)}</span></td>
            <td style="white-space:nowrap;font-size:12px;">${escapeHtml(startTime)}</td>
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
                <th>Start Time</th><th>Repeats</th>
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
        const ts  = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
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
            <select class="select mon-filter-sel" id="sum-filter-bot"   onchange="applyMonSummaryFilters()"><option value="">All Bots</option></select>
            <select class="select mon-filter-sel" id="sum-filter-topic" onchange="applyMonSummaryFilters()"><option value="">All Topics</option></select>
            <select class="select mon-filter-sel" id="sum-filter-type"  onchange="applyMonSummaryFilters()">
                <option value="">All Types</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="minute">Minute</option>
                <option value="interval">Interval</option>
            </select>
        </div>
        <div id="mon-summaries-content"><p class="mon-empty">Loading…</p></div>`;
    renderMonSummaries(_allSummaries || []);
}

// ---------- Received Messages ----------
const _MSG_PAGE_SIZE = 50;
let _msgOffset = 0;
let _msgHasMore = true;

async function loadMonitorMessages(append = false) {
    const el = document.getElementById('mon-messages-content');
    if (!append) {
        _msgOffset = 0;
        _msgHasMore = true;
        _allMessages = [];
        el.innerHTML = '<p class="mon-empty">Loading…</p>';
    }
    const scrollY = window.scrollY;
    const data = await api(`/api/monitor/messages?limit=${_MSG_PAGE_SIZE}&offset=${_msgOffset}`);
    if (data.status !== 'ok') {
        if (!append) el.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message || 'Unknown error')}</p>`;
        return;
    }
    const newMsgs = data.messages || [];
    _msgHasMore = newMsgs.length === _MSG_PAGE_SIZE;
    _allMessages = _allMessages.concat(newMsgs);
    _msgOffset += newMsgs.length;
    renderMonMessages();
    window.scrollTo(0, scrollY);
}

function renderMonMessages() {
    // Populate dynamic dropdowns
    const colls    = [...new Set(_allMessages.map(m => m.collection).filter(Boolean))].sort();
    const channels = [...new Set(_allMessages.map(m => m.channel_username ? `@${m.channel_username}` : null).filter(Boolean))].sort();
    const topics   = [...new Set(_allMessages.flatMap(m => (m.topics || '').split(',').map(t => t.trim())).filter(Boolean))].sort();
    _populateMonSelect('msg-filter-coll',    colls,    'All Collections');
    _populateMonSelect('msg-filter-channel', channels, 'All Channels');
    _populateMonSelect('msg-filter-topic',   topics,   'All Topics');
    applyMonMessageFilters();
}

let _msgFlatView = false;

function toggleMsgFlatView() {
    _msgFlatView = !_msgFlatView;
    const btn = document.getElementById('msg-flat-btn');
    if (btn) {
        btn.classList.toggle('btn-primary', _msgFlatView);
        btn.classList.toggle('btn-secondary', !_msgFlatView);
    }
    applyMonMessageFilters();
}

function applyMonMessageFilters() {
    const coll     = document.getElementById('msg-filter-coll')?.value      || '';
    const channel  = document.getElementById('msg-filter-channel')?.value   || '';
    const topic    = document.getElementById('msg-filter-topic')?.value     || '';
    const search   = (document.getElementById('msg-search')?.value || '').trim().toLowerCase();
    const dateFrom = document.getElementById('msg-filter-date-from')?.value || '';
    const dateTo   = document.getElementById('msg-filter-date-to')?.value   || '';

    let filtered = _allMessages;
    if (coll)     filtered = filtered.filter(m => m.collection === coll);
    if (channel)  filtered = filtered.filter(m => `@${m.channel_username}` === channel);
    if (topic)    filtered = filtered.filter(m => (m.topics || '').split(',').map(t => t.trim()).includes(topic));
    if (search)   filtered = filtered.filter(m => (m.preview || '').toLowerCase().includes(search));
    if (dateFrom) filtered = filtered.filter(m => m.timestamp && m.timestamp.slice(0,10) >= dateFrom);
    if (dateTo)   filtered = filtered.filter(m => m.timestamp && m.timestamp.slice(0,10) <= dateTo);

    const el = document.getElementById('mon-messages-content');
    if (!filtered.length) {
        el.innerHTML = `<p class="mon-empty">${_allMessages.length ? 'No messages match the filters.' : 'No messages in DB yet.'}</p>`;
        return;
    }

    let html = '';

    if (_msgFlatView) {
        // Flat view: all messages sorted latest first, no grouping
        const sorted = [...filtered].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        const rowsHtml = sorted.map(m => {
            const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
            const ch = m.channel_username ? `@${m.channel_username}` : `id:${m.channel_id}`;
            const cname = m.collection || '—';
            const topicTags = (m.topics || '').split(',').map(t => t.trim()).filter(Boolean)
                .map(t => `<span class="mon-tag topic">${escapeHtml(t)}</span>`).join(' ') || '<span style="color:var(--text-muted)">—</span>';
            const catTags = (m.categories || '').split(',').map(c => c.trim()).filter(Boolean)
                .map(c => `<span class="mon-tag cat">${escapeHtml(c)}</span>`).join(' ') || '<span style="color:var(--text-muted)">—</span>';
            const kwTags = (m.keywords_found || '').split(',').map(k => k.trim()).filter(Boolean)
                .map(k => `<span class="mon-tag">${escapeHtml(k)}</span>`).join(' ') || '<span style="color:var(--text-muted)">—</span>';
            return `<tr>
                <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                <td>${escapeHtml(ch)}</td>
                <td>${escapeHtml(cname)}</td>
                <td>${topicTags}</td>
                <td>${catTags}</td>
                <td>${kwTags}</td>
                <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
            </tr>`;
        }).join('');
        html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;padding:0 4px;">${sorted.length} message${sorted.length===1?'':'s'}</div>
            <div style="overflow-x:auto;">
            <table class="mon-table">
                <thead><tr><th>Time</th><th>Source</th><th>Collection</th><th>Topics</th><th>Categories</th><th>Keywords</th><th>Preview</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table></div>`;
    } else {
        // Grouped view: collection → channel → messages
        const grouped = {};
        for (const msg of filtered) {
            const c  = msg.collection || '—';
            const ch = msg.channel_username ? `@${msg.channel_username}` : `id:${msg.channel_id}`;
            if (!grouped[c])     grouped[c]     = {};
            if (!grouped[c][ch]) grouped[c][ch] = [];
            grouped[c][ch].push(msg);
        }

        html = Object.entries(grouped).map(([collName, channels]) => {
            const chHtml = Object.entries(channels).map(([chName, msgs]) => {
                const rowsHtml = msgs.map(m => {
                    const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
                    const topicTags = (m.topics || '').split(',').map(t => t.trim()).filter(Boolean)
                        .map(t => `<span class="mon-tag topic">${escapeHtml(t)}</span>`).join(' ') || '<span style="color:var(--text-muted)">—</span>';
                    const catTags = (m.categories || '').split(',').map(c => c.trim()).filter(Boolean)
                        .map(c => `<span class="mon-tag cat">${escapeHtml(c)}</span>`).join(' ') || '<span style="color:var(--text-muted)">—</span>';
                    const kwTags = (m.keywords_found || '').split(',').map(k => k.trim()).filter(Boolean)
                        .map(k => `<span class="mon-tag">${escapeHtml(k)}</span>`).join(' ') || '<span style="color:var(--text-muted)">—</span>';
                    return `<tr>
                        <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                        <td>${topicTags}</td>
                        <td>${catTags}</td>
                        <td>${kwTags}</td>
                        <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
                    </tr>`;
                }).join('');
                return `<div class="mon-ch-hdr">📢 ${escapeHtml(chName)} <span class="text-muted">(${msgs.length})</span></div>
                    <div style="overflow-x:auto;">
                    <table class="mon-table">
                        <thead><tr><th>Time</th><th>Topics</th><th>Categories</th><th>Keywords</th><th>Preview</th></tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table></div>`;
            }).join('');
            return `<div class="mon-coll-hdr">📦 ${escapeHtml(collName)}</div>${chHtml}`;
        }).join('');
    }

    if (_msgHasMore) {
        html += `<div style="text-align:center;padding:16px;">
            <button class="btn btn-secondary" onclick="loadMonitorMessages(true)">Load more messages…</button>
            <span class="text-muted" style="margin-left:8px;font-size:12px;">${_allMessages.length} loaded</span>
        </div>`;
    } else if (_allMessages.length > _MSG_PAGE_SIZE) {
        html += `<p class="text-muted" style="text-align:center;padding:8px;font-size:12px;">All ${_allMessages.length} messages loaded</p>`;
    }
    el.innerHTML = html;
}

// Populate a <select> keeping its first "All …" option and preserving current selection.
function _populateMonSelect(id, values, allLabel) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = `<option value="">${allLabel}</option>` +
        values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (values.includes(current)) el.value = current;
}

// ---------- Unclassified messages ----------
let _unclInitialized = false;
let _unclMessages    = [];
let _unclGrouped     = false;
let _unclFlatView    = false;
let _unclClearedAt   = localStorage.getItem('mon-uncl-cleared-at') || null;

function toggleUnclGroupView() {
    _unclGrouped = !_unclGrouped;
    if (_unclGrouped) _unclFlatView = false; // mutually exclusive
    const btn = document.getElementById('uncl-group-btn');
    const flatBtn = document.getElementById('uncl-flat-btn');
    if (btn) { btn.classList.toggle('btn-primary', _unclGrouped); btn.classList.toggle('btn-secondary', !_unclGrouped); }
    if (flatBtn) { flatBtn.classList.remove('btn-primary'); flatBtn.classList.add('btn-secondary'); }
    _renderUnclassified(_unclMessages);
}

function toggleUnclFlatView() {
    _unclFlatView = !_unclFlatView;
    if (_unclFlatView) _unclGrouped = false; // mutually exclusive
    const btn = document.getElementById('uncl-flat-btn');
    const grpBtn = document.getElementById('uncl-group-btn');
    if (btn) { btn.classList.toggle('btn-primary', _unclFlatView); btn.classList.toggle('btn-secondary', !_unclFlatView); }
    if (grpBtn) { grpBtn.classList.remove('btn-primary'); grpBtn.classList.add('btn-secondary'); }
    _renderUnclassified(_unclMessages);
}

// Stop-words to ignore when extracting common words
const _unclStopWords = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','it',
    'was','are','be','been','has','had','have','do','does','did','will','would','could','should',
    'may','can','this','that','these','those','not','no','so','if','as','its','he','she','they',
    'we','you','i','my','your','his','her','our','their','me','him','us','them','what','which',
    'who','whom','when','where','how','why','all','each','every','both','few','more','most',
    'other','some','such','than','too','very','just','about','above','after','again','also',
    'any','because','before','between','during','into','only','over','same','then','through',
    'under','until','up','while','into','out','new','one','two','said','says','been','being',
    'get','got','still','back','much','even','well','here','there','now','via','per','المزيد',
    'من','في','على','إلى','عن','مع','هذا',' هذه','التي','الذي','ان','أن','لا','ما','هو','هي',
    'كان','بين','بعد','قبل','حتى','عند','ذلك','أو','ولا','كل','غير','بل','لم','ثم','إن',
    'يتم','تم','لن','قد','منذ','خلال','حول','ضد','نحو','عبر','أي','لها','له','لهم','التى',
    'وفي','وقد','يوم','أنه','تلك','هؤلاء','الى','وهو','أكثر','فيها','فيه','وعلى','ومن'
]);

function _extractCommonWords(messages, topN = 30) {
    const freq = {};
    for (const m of messages) {
        const text = (m.preview || '').toLowerCase();
        // Split on non-word chars (supports Arabic + Latin)
        const words = text.split(/[\s\p{P}\p{S}\d]+/u).filter(w => w.length > 2);
        const seen = new Set(); // count each word once per message
        for (const w of words) {
            if (_unclStopWords.has(w) || w.length > 40) continue;
            if (!seen.has(w)) {
                seen.add(w);
                freq[w] = (freq[w] || 0) + 1;
            }
        }
    }
    // Only words appearing in 2+ messages
    return Object.entries(freq)
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN);
}

function _renderUnclassified(messages) {
    const content = document.getElementById('mon-uncl-content');
    if (!content) return;

    // Apply cleared-at filter
    const clearedAtMs = _unclClearedAt ? new Date(_unclClearedAt).getTime() : null;
    let visible = clearedAtMs
        ? messages.filter(m => m.timestamp && new Date(m.timestamp).getTime() > clearedAtMs)
        : messages;

    // Apply channel filter
    const chFilter = document.getElementById('uncl-filter-channel')?.value || '';
    if (chFilter) visible = visible.filter(m => (m.channel_username || '') === chFilter);

    // Apply date filters
    const dateFrom = document.getElementById('uncl-filter-date-from')?.value || '';
    const dateTo   = document.getElementById('uncl-filter-date-to')?.value   || '';
    if (dateFrom) visible = visible.filter(m => m.timestamp && m.timestamp.slice(0,10) >= dateFrom);
    if (dateTo)   visible = visible.filter(m => m.timestamp && m.timestamp.slice(0,10) <= dateTo);

    // Populate channel dropdown from loaded data (once)
    const chSel = document.getElementById('uncl-filter-channel');
    if (chSel && chSel.options.length <= 1) {
        const channels = [...new Set(messages.map(m => m.channel_username).filter(Boolean))].sort();
        channels.forEach(ch => { const o = document.createElement('option'); o.value = ch; o.textContent = `@${ch}`; chSel.appendChild(o); });
        if (chFilter) chSel.value = chFilter;
    }

    if (!visible.length) {
        content.innerHTML = _unclClearedAt
            ? '<p class="mon-empty">No new unclassified messages since last clear. <button class="btn btn-sm btn-secondary" onclick="showAllUnclassifiedView()">Show all</button></p>'
            : '<p class="mon-empty">No unclassified messages found.</p>';
        return;
    }

    if (_unclFlatView) {
        _renderUnclFlat(visible, content);
    } else if (_unclGrouped) {
        _renderUnclGroupedByWords(visible, content);
    } else {
        _renderUnclByChannel(visible, content);
    }

    // Append load-more button
    if (_unclHasMore) {
        content.insertAdjacentHTML('beforeend', `<div style="text-align:center;padding:16px;">
            <button class="btn btn-secondary" onclick="loadUnclassifiedMessages(true)">Load more messages…</button>
            <span class="text-muted" style="margin-left:8px;font-size:12px;">${_unclMessages.length} loaded</span>
        </div>`);
    } else if (_unclMessages.length > _UNCL_PAGE_SIZE) {
        content.insertAdjacentHTML('beforeend', `<p class="text-muted" style="text-align:center;padding:8px;font-size:12px;">All ${_unclMessages.length} messages loaded</p>`);
    }
}

function _renderUnclFlat(messages, content) {
    const sorted = [...messages].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const rowsHtml = sorted.map(m => {
        const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
        const ch = m.channel_username ? `@${m.channel_username}` : `id:${m.channel_id}`;
        const cname = m.collection_name || '—';
        const botTag = m.bot_name ? `<span class="mon-tag cat">${escapeHtml(m.bot_name)}</span>` : '—';
        return `<tr>
            <td style="white-space:nowrap;font-size:11px;">${ts}</td>
            <td>${escapeHtml(ch)}</td>
            <td>${escapeHtml(cname)}</td>
            <td>${botTag}</td>
            <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
        </tr>`;
    }).join('');
    content.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;padding:0 4px;">${sorted.length} message${sorted.length===1?'':'s'}</div>
        <div style="overflow-x:auto;">
        <table class="mon-table">
            <thead><tr><th>Time</th><th>Source</th><th>Collection</th><th>Bot</th><th>Preview</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table></div>`;
}

function _renderUnclByChannel(messages, content) {
    const grouped = {};
    for (const msg of messages) {
        const c  = msg.collection_name || '—';
        const ch = msg.channel_username ? `@${msg.channel_username}` : `id:${msg.channel_id}`;
        if (!grouped[c])     grouped[c]     = {};
        if (!grouped[c][ch]) grouped[c][ch] = [];
        grouped[c][ch].push(msg);
    }

    content.innerHTML = Object.entries(grouped).map(([collName, channels]) => {
        const chHtml = Object.entries(channels).map(([chName, msgs]) => {
            const rowsHtml = msgs.map(m => {
                const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
                const botTag = m.bot_name ? `<span class="mon-tag cat">${escapeHtml(m.bot_name)}</span>` : '—';
                return `<tr>
                    <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                    <td>${botTag}</td>
                    <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
                </tr>`;
            }).join('');
            return `<div class="mon-ch-hdr">📢 ${escapeHtml(chName)} <span class="text-muted">(${msgs.length})</span></div>
                <div style="overflow-x:auto;">
                <table class="mon-table">
                    <thead><tr><th>Time</th><th>Bot</th><th>Preview</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table></div>`;
        }).join('');
        return `<div class="mon-coll-hdr">📦 ${escapeHtml(collName)}</div>${chHtml}`;
    }).join('');
}

function _renderUnclGroupedByWords(messages, content) {
    const commonWords = _extractCommonWords(messages);

    if (!commonWords.length) {
        content.innerHTML = '<p class="mon-empty">No common words found across messages.</p>';
        return;
    }

    // Assign each message to the first (most frequent) matching word group
    const wordGroups = {};     // word → [messages]
    const assigned = new Set(); // track assigned message ids

    for (const [word] of commonWords) {
        wordGroups[word] = [];
    }

    for (const m of messages) {
        const text = (m.preview || '').toLowerCase();
        for (const [word] of commonWords) {
            if (text.includes(word)) {
                wordGroups[word].push(m);
                assigned.add(m.id);
                break; // assign to first matching group only
            }
        }
    }

    // Collect unassigned messages
    const unassigned = messages.filter(m => !assigned.has(m.id));

    // Build HTML
    let html = '<div class="uncl-word-groups">';

    // Sort groups by count desc, filter out empty
    const sortedGroups = commonWords
        .filter(([w]) => wordGroups[w].length > 0)
        .map(([word, totalFreq]) => [word, wordGroups[word], totalFreq]);

    for (const [word, msgs] of sortedGroups) {
        const rowsHtml = msgs.map(m => {
            const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
            const ch = m.channel_username ? `@${m.channel_username}` : '';
            // Highlight the word in preview
            const preview = escapeHtml(m.preview || '');
            const highlighted = preview.replace(
                new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                '<mark>$1</mark>'
            );
            return `<tr>
                <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                <td style="white-space:nowrap;font-size:11px;">${escapeHtml(ch)}</td>
                <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${highlighted}</td>
            </tr>`;
        }).join('');
        html += `<div class="uncl-word-group">
            <div class="uncl-word-hdr" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none'">
                <span class="uncl-word-label">"${escapeHtml(word)}"</span>
                <span class="uncl-word-count">${msgs.length} messages</span>
            </div>
            <div style="overflow-x:auto;">
            <table class="mon-table">
                <thead><tr><th style="width:140px;">Time</th><th style="width:120px;">Channel</th><th>Message Preview</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table></div>
        </div>`;
    }

    if (unassigned.length) {
        const rowsHtml = unassigned.map(m => {
            const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
            const ch = m.channel_username ? `@${m.channel_username}` : '';
            return `<tr>
                <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                <td style="white-space:nowrap;font-size:11px;">${escapeHtml(ch)}</td>
                <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
            </tr>`;
        }).join('');
        html += `<div class="uncl-word-group">
            <div class="uncl-word-hdr" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none'">
                <span class="uncl-word-label" style="color:var(--text-muted);">Other (no common word)</span>
                <span class="uncl-word-count">${unassigned.length} messages</span>
            </div>
            <div style="overflow-x:auto;">
            <table class="mon-table">
                <thead><tr><th style="width:140px;">Time</th><th style="width:120px;">Channel</th><th>Message Preview</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table></div>
        </div>`;
    }

    html += '</div>';
    content.innerHTML = html;
}

const _UNCL_PAGE_SIZE = 50;
let _unclOffset = 0;
let _unclHasMore = true;

async function loadUnclassifiedMessages(append = false) {
    const content = document.getElementById('mon-uncl-content');
    if (!append) {
        _unclOffset = 0;
        _unclHasMore = true;
        _unclMessages = [];
        _unclInitialized = false; // reset so dropdowns rebuild
        const chSel = document.getElementById('uncl-filter-channel');
        if (chSel) chSel.innerHTML = '<option value="">All Sources</option>';
        content.innerHTML = '<p class="mon-empty">Loading…</p>';
    }
    const scrollY = window.scrollY;

    const bot  = document.getElementById('uncl-filter-bot')?.value  || '';
    const coll = document.getElementById('uncl-filter-coll')?.value || '';
    const search = document.getElementById('uncl-search')?.value?.trim() || '';

    let url = `/api/monitor/unclassified?limit=${_UNCL_PAGE_SIZE}&offset=${_unclOffset}`;
    if (bot)            url += `&bot=${encodeURIComponent(bot)}`;
    if (coll)           url += `&collection=${encodeURIComponent(coll)}`;
    if (search)         url += `&search=${encodeURIComponent(search)}`;
    if (_unclClearedAt) url += `&since=${encodeURIComponent(_unclClearedAt)}`;

    const data = await api(url);
    if (data.status !== 'ok') {
        if (!append) content.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message || 'Unknown error')}</p>`;
        return;
    }

    const newMsgs = data.messages || [];
    const stats = data.stats    || [];
    _unclHasMore = newMsgs.length === _UNCL_PAGE_SIZE;
    _unclMessages = _unclMessages.concat(newMsgs);
    _unclOffset += newMsgs.length;

    // Update badge
    const totalUncl = stats.reduce((s, r) => s + (r.cnt || 0), 0);
    const badge = document.getElementById('mon-uncl-badge');
    if (badge) {
        badge.textContent = totalUncl;
        badge.style.display = totalUncl > 0 ? 'inline-block' : 'none';
    }

    // Populate filter dropdowns (only once)
    if (!_unclInitialized) {
        const bots  = [...new Set(stats.map(s => s.bot_name).filter(Boolean))].sort();
        const colls = [...new Set(stats.map(s => s.collection_name).filter(Boolean))].sort();
        _populateMonSelect('uncl-filter-bot',  bots,  'All Bots');
        _populateMonSelect('uncl-filter-coll', colls, 'All Collections');
        if (bot)  document.getElementById('uncl-filter-bot').value  = bot;
        if (coll) document.getElementById('uncl-filter-coll').value = coll;
        // Reset channel dropdown so _renderUnclassified can re-populate from messages
        const chSel = document.getElementById('uncl-filter-channel');
        if (chSel) chSel.innerHTML = '<option value="">All Sources</option>';
        _unclInitialized = true;
    }

    // Render stats summary
    const statsEl = document.getElementById('mon-uncl-stats');
    if (statsEl) {
        if (stats.length) {
            statsEl.innerHTML = `<div class="mon-uncl-stats-bar">${stats.map(s =>
                `<span class="yt-filter-tag">${escapeHtml(s.bot_name || '?')} / ${escapeHtml(s.collection_name || '?')}: <strong>${s.cnt}</strong></span>`
              ).join('')}</div>`;
        } else {
            statsEl.innerHTML = '';
        }
    }

    _renderUnclassified(_unclMessages);
    window.scrollTo(0, scrollY);
}

// --- Unclassified clear/show-all ---
function clearUnclassifiedView() {
    _unclClearedAt = new Date().toISOString();
    localStorage.setItem('mon-uncl-cleared-at', _unclClearedAt);
    document.getElementById('uncl-clear-btn').style.display = 'none';
    document.getElementById('uncl-showall-btn').style.display = '';
    // Reset badge immediately — background poll will fetch only new messages
    const badge = document.getElementById('mon-uncl-badge');
    if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
    _renderUnclassified(_unclMessages);
}

function showAllUnclassifiedView() {
    _unclClearedAt = null;
    localStorage.removeItem('mon-uncl-cleared-at');
    document.getElementById('uncl-clear-btn').style.display = '';
    document.getElementById('uncl-showall-btn').style.display = 'none';
    _renderUnclassified(_unclMessages);
}

// ---------- Missed messages ----------
let _missedMessages  = [];
let _missedOffset    = 0;
let _missedHasMore   = true;
let _missedClearedAt = localStorage.getItem('mon-missed-cleared-at') || null;
let _missedFlatView  = false;
const _MISSED_PAGE_SIZE = 50;

function toggleMissedFlatView() {
    _missedFlatView = !_missedFlatView;
    const btn = document.getElementById('missed-flat-btn');
    if (btn) { btn.classList.toggle('btn-primary', _missedFlatView); btn.classList.toggle('btn-secondary', !_missedFlatView); }
    _renderMissed(_missedMessages);
}

async function loadMissedMessages(append = false) {
    const content = document.getElementById('mon-missed-content');
    if (!append) {
        _missedOffset   = 0;
        _missedHasMore  = true;
        _missedMessages = [];
        const chSel = document.getElementById('missed-filter-channel');
        if (chSel) chSel.innerHTML = '<option value="">All Sources</option>';
        if (content) content.innerHTML = '<p class="mon-empty">Loading…</p>';
    }
    const scrollY = window.scrollY;

    const bot    = document.getElementById('missed-filter-bot')?.value   || '';
    const topic  = document.getElementById('missed-filter-topic')?.value || '';
    const search = document.getElementById('missed-search')?.value        || '';

    let url = `/api/monitor/missed?limit=${_MISSED_PAGE_SIZE}&offset=${_missedOffset}`;
    if (bot)              url += `&bot=${encodeURIComponent(bot)}`;
    if (topic)            url += `&topic=${encodeURIComponent(topic)}`;
    if (search)           url += `&search=${encodeURIComponent(search)}`;
    if (_missedClearedAt) url += `&since=${encodeURIComponent(_missedClearedAt)}`;

    const data = await api(url);
    if (!data || data.status !== 'ok') return;

    const newMsgs = data.messages || [];
    const stats   = data.stats    || [];
    _missedHasMore = newMsgs.length === _MISSED_PAGE_SIZE;
    _missedMessages = _missedMessages.concat(newMsgs);
    _missedOffset  += newMsgs.length;

    // Populate filters on first load
    if (!append) {
        const botSel   = document.getElementById('missed-filter-bot');
        const topicSel = document.getElementById('missed-filter-topic');
        if (botSel && botSel.options.length <= 1) {
            const bots = [...new Set(_missedMessages.map(m => m.bot_name).filter(Boolean))].sort();
            bots.forEach(b => {
                const o = document.createElement('option'); o.value = b; o.textContent = b;
                botSel.appendChild(o);
            });
            if (bot) botSel.value = bot;
        }
        if (topicSel && topicSel.options.length <= 1) {
            const topics = [...new Set(_missedMessages.map(m => m.topic_name).filter(Boolean))].sort();
            topics.forEach(t => {
                const o = document.createElement('option'); o.value = t; o.textContent = t;
                topicSel.appendChild(o);
            });
            if (topic) topicSel.value = topic;
        }
    }

    // Update badge
    const totalMissed = stats.reduce((s, r) => s + (r.cnt || 0), 0);
    const badge = document.getElementById('mon-missed-badge');
    if (badge) { badge.textContent = totalMissed; badge.style.display = totalMissed > 0 ? 'inline-block' : 'none'; }

    // Render stats bar
    const statsEl = document.getElementById('mon-missed-stats');
    if (statsEl) {
        statsEl.innerHTML = stats.length
            ? `<div class="mon-uncl-stats-bar">${stats.map(s =>
                `<span class="yt-filter-tag">${escapeHtml(s.bot_name || '?')} / ${escapeHtml(s.topic_name || '?')}: <strong>${s.cnt}</strong></span>`
              ).join('')}</div>`
            : '';
    }

    _renderMissed(_missedMessages);
    window.scrollTo(0, scrollY);
}

function _renderMissed(messages) {
    const content = document.getElementById('mon-missed-content');
    if (!content) return;

    // Apply cleared-at filter
    const missedClearedAtMs = _missedClearedAt ? new Date(_missedClearedAt).getTime() : null;
    let visible = missedClearedAtMs
        ? messages.filter(m => m.timestamp && new Date(m.timestamp).getTime() > missedClearedAtMs)
        : messages;

    // Apply channel filter
    const chFilter = document.getElementById('missed-filter-channel')?.value || '';
    if (chFilter) visible = visible.filter(m => (m.channel_username || '') === chFilter);

    // Apply date filters
    const dateFrom = document.getElementById('missed-filter-date-from')?.value || '';
    const dateTo   = document.getElementById('missed-filter-date-to')?.value   || '';
    if (dateFrom) visible = visible.filter(m => m.timestamp && m.timestamp.slice(0,10) >= dateFrom);
    if (dateTo)   visible = visible.filter(m => m.timestamp && m.timestamp.slice(0,10) <= dateTo);

    // Populate channel dropdown from loaded data
    const chSel = document.getElementById('missed-filter-channel');
    if (chSel && chSel.options.length <= 1) {
        const channels = [...new Set(messages.map(m => m.channel_username).filter(Boolean))].sort();
        channels.forEach(ch => { const o = document.createElement('option'); o.value = ch; o.textContent = `@${ch}`; chSel.appendChild(o); });
        if (chFilter) chSel.value = chFilter;
    }

    if (!visible.length) {
        content.innerHTML = _missedClearedAt
            ? '<p class="mon-empty">No new missed messages since last clear. <button class="btn btn-sm btn-secondary" onclick="showAllMissedView()">Show all</button></p>'
            : '<p class="mon-empty">No missed messages found.</p>';
        return;
    }

    let html = '';

    if (_missedFlatView) {
        // Flat view: all messages sorted latest first
        const sorted = [...visible].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        const rows = sorted.map(m => {
            const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
            const ch = m.channel_username ? `@${m.channel_username}` : String(m.channel_id || '?');
            return `<tr>
                <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                <td><span class="mon-tag">${escapeHtml(ch)}</span></td>
                <td>${escapeHtml(m.bot_name || '—')}</td>
                <td>${escapeHtml(m.topic_name || '—')}</td>
                <td><span class="mon-tag cat">${escapeHtml(m.schedule_type || '—')}</span></td>
                <td class="mon-ellipsis">${escapeHtml(m.preview || '—')}</td>
            </tr>`;
        }).join('');
        html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;padding:0 4px;">${sorted.length} message${sorted.length===1?'':'s'}</div>
            <div style="overflow-x:auto;">
            <table class="mon-table">
                <thead><tr><th>Time</th><th>Source</th><th>Bot</th><th>Topic</th><th>Schedule</th><th>Preview</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;
    } else {
        // Grouped view: bot › topic
        const groups = {};
        for (const m of visible) {
            const key = `${m.bot_name || '?'} › ${m.topic_name || '?'}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(m);
        }
        for (const [key, msgs] of Object.entries(groups)) {
            const rows = msgs.map(m => `
                <tr>
                    <td style="white-space:nowrap;font-size:11px;">${m.timestamp ? m.timestamp.replace('T',' ').slice(0,16) : '—'}</td>
                    <td><span class="mon-tag">${escapeHtml(m.channel_username || String(m.channel_id || '?'))}</span></td>
                    <td><span class="mon-tag cat">${escapeHtml(m.schedule_type || '—')}</span></td>
                    <td class="mon-ellipsis">${escapeHtml(m.preview || '—')}</td>
                </tr>`).join('');
            html += `<div class="mon-ch-hdr">⏭ ${escapeHtml(key)} <span style="font-size:11px;color:var(--text-muted);font-weight:400;">(${msgs.length})</span></div>
                <div style="overflow-x:auto;">
                <table class="mon-table">
                    <thead><tr><th>Time</th><th>Source</th><th>Schedule</th><th>Preview</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table></div>`;
        }
    }

    content.innerHTML = html;

    if (_missedHasMore) {
        content.insertAdjacentHTML('beforeend', `<div style="text-align:center;padding:16px;">
            <button class="btn btn-secondary" onclick="loadMissedMessages(true)">Load more…</button>
            <span class="text-muted" style="margin-left:8px;font-size:12px;">${_missedMessages.length} loaded</span>
        </div>`);
    }
}

function clearMissedView() {
    _missedClearedAt = new Date().toISOString();
    localStorage.setItem('mon-missed-cleared-at', _missedClearedAt);
    document.getElementById('missed-showall-btn').style.display = '';
    // Reset badge immediately — background poll will fetch only new messages
    const badge = document.getElementById('mon-missed-badge');
    if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
    // Reset stats bar
    const statsEl = document.getElementById('mon-missed-stats');
    if (statsEl) statsEl.innerHTML = '';
    _renderMissed(_missedMessages);
}

function showAllMissedView() {
    _missedClearedAt = null;
    localStorage.removeItem('mon-missed-cleared-at');
    document.getElementById('missed-clear-btn').style.display   = '';
    document.getElementById('missed-showall-btn').style.display = 'none';
    _renderMissed(_missedMessages);
}

// ==================== Export to CSV ====================

const _EXPORT_COLS = {
    summaries: [
        { key: 'time',    label: 'Time' },
        { key: 'bot',     label: 'Bot' },
        { key: 'topic',   label: 'Topic' },
        { key: 'type',    label: 'Type' },
        { key: 'msgs',    label: 'Messages Count' },
        { key: 'target',  label: 'Target' },
        { key: 'preview', label: 'Preview' },
    ],
    messages: [
        { key: 'time',       label: 'Time' },
        { key: 'collection', label: 'Collection' },
        { key: 'channel',    label: 'Channel' },
        { key: 'topics',     label: 'Topics' },
        { key: 'categories', label: 'Categories' },
        { key: 'keywords',   label: 'Keywords' },
        { key: 'preview',    label: 'Preview' },
    ],
    unclassified: [
        { key: 'time',       label: 'Time' },
        { key: 'collection', label: 'Collection' },
        { key: 'channel',    label: 'Channel' },
        { key: 'bot',        label: 'Bot' },
        { key: 'preview',    label: 'Preview' },
    ],
};

let _exportTab = null;

function openExportModal(tabName) {
    _exportTab = tabName;
    const cols = _EXPORT_COLS[tabName] || [];

    const tabLabels = { summaries: 'Summaries', messages: 'Messages', unclassified: 'Unclassified' };
    document.getElementById('export-col-title').textContent =
        `Export ${tabLabels[tabName] || tabName} — Select Columns`;

    document.getElementById('export-col-list').innerHTML = cols.map(c =>
        `<label class="export-col-item">
            <input type="checkbox" name="export-col" value="${c.key}" checked>
            <span>${c.label}</span>
        </label>`
    ).join('');

    // Sync the "Select all" checkbox
    document.getElementById('export-all-cols').checked = true;

    document.getElementById('export-col-modal').style.display = 'flex';
}

function closeExportModal() {
    document.getElementById('export-col-modal').style.display = 'none';
    _exportTab = null;
}

function toggleAllExportCols(checked) {
    document.querySelectorAll('#export-col-list input[name="export-col"]')
        .forEach(cb => cb.checked = checked);
}

function _syncExportAllCheckbox() {
    const all = document.querySelectorAll('#export-col-list input[name="export-col"]');
    const checked = document.querySelectorAll('#export-col-list input[name="export-col"]:checked');
    const allCb = document.getElementById('export-all-cols');
    if (allCb) allCb.checked = all.length === checked.length;
}

function confirmExport() {
    const selected = [...document.querySelectorAll('#export-col-list input[name="export-col"]:checked')]
        .map(cb => cb.value);
    if (!selected.length) {
        showAlert('Please select at least one column.');
        return;
    }
    const tab = _exportTab;
    closeExportModal();
    _doExport(tab, selected);
}

function _csvCell(v) {
    const s = (v == null ? '' : String(v)).replace(/"/g, '""');
    return `"${s}"`;
}

function _csvRow(values) {
    return values.map(_csvCell).join(',');
}

function _getExportSummaries() {
    const bot    = document.getElementById('sum-filter-bot')?.value   || '';
    const topic  = document.getElementById('sum-filter-topic')?.value || '';
    const type   = document.getElementById('sum-filter-type')?.value  || '';
    const search = (document.getElementById('sum-search')?.value || '').trim().toLowerCase();
    let d = _allSummaries;
    if (bot)    d = d.filter(s => s.bot_name     === bot);
    if (topic)  d = d.filter(s => s.topic_name   === topic);
    if (type)   d = d.filter(s => s.summary_type === type);
    if (search) d = d.filter(s => (s.preview || '').toLowerCase().includes(search));
    return d;
}

function _getExportMessages() {
    const coll    = document.getElementById('msg-filter-coll')?.value    || '';
    const channel = document.getElementById('msg-filter-channel')?.value || '';
    const topic   = document.getElementById('msg-filter-topic')?.value   || '';
    const search  = (document.getElementById('msg-search')?.value || '').trim().toLowerCase();
    let d = _allMessages;
    if (coll)    d = d.filter(m => m.collection === coll);
    if (channel) d = d.filter(m => `@${m.channel_username}` === channel);
    if (topic)   d = d.filter(m => (m.topics || '').split(',').map(t => t.trim()).includes(topic));
    if (search)  d = d.filter(m => (m.preview || '').toLowerCase().includes(search));
    return d;
}

function _getExportUnclassified() {
    const clearedAtMs = _unclClearedAt ? new Date(_unclClearedAt).getTime() : null;
    return clearedAtMs
        ? _unclMessages.filter(m => m.timestamp && new Date(m.timestamp).getTime() > clearedAtMs)
        : _unclMessages;
}

function _doExport(tabName, selectedKeys) {
    const colDefs = (_EXPORT_COLS[tabName] || []).filter(c => selectedKeys.includes(c.key));
    let rows = [];

    if (tabName === 'summaries') {
        rows = _getExportSummaries().map(s => colDefs.map(c => {
            switch (c.key) {
                case 'time':    return s.timestamp ? new Date(s.timestamp).toLocaleString() : '';
                case 'bot':     return s.bot_name    || '';
                case 'topic':   return s.topic_name  || '';
                case 'type':    return s.summary_type || '';
                case 'msgs':    return s.message_count ?? '';
                case 'target':  return s.target_entity || '';
                case 'preview': return s.preview || '';
                default: return '';
            }
        }));
    } else if (tabName === 'messages') {
        rows = _getExportMessages().map(m => colDefs.map(c => {
            switch (c.key) {
                case 'time':       return m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
                case 'collection': return m.collection || '';
                case 'channel':    return m.channel_username ? `@${m.channel_username}` : '';
                case 'topics':     return m.topics || '';
                case 'categories': return m.categories || '';
                case 'keywords':   return m.keywords_found || '';
                case 'preview':    return m.preview || '';
                default: return '';
            }
        }));
    } else if (tabName === 'unclassified') {
        rows = _getExportUnclassified().map(m => colDefs.map(c => {
            switch (c.key) {
                case 'time':       return m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
                case 'collection': return m.collection_name || '';
                case 'channel':    return m.channel_username ? `@${m.channel_username}` : '';
                case 'bot':        return m.bot_name || '';
                case 'preview':    return m.preview || '';
                default: return '';
            }
        }));
    }

    if (!rows.length) {
        showAlert('No data to export. Apply different filters or load more data first.');
        return;
    }

    // UTF-8 BOM so Excel reads Arabic / non-ASCII correctly
    const header = _csvRow(colDefs.map(c => c.label));
    const csv = '\uFEFF' + header + '\n' + rows.map(_csvRow).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${tabName}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Sync "Select all" when individual checkboxes change
document.addEventListener('change', e => {
    if (e.target.name === 'export-col') _syncExportAllCheckbox();
});

// ---------- Collapsible sections ----------
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

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.head.appendChild(style);

// ==================== Recycle Bin ====================

const _rbTypeIcons = {
    bot: '🤖', category: '🗂️', topic: '📝', collection: '📦',
    prompt: '📄', schedule: '⏰', yt_channel: '📺', yt_keyword: '🔍'
};
const _rbTypeLabels = {
    bot: 'Bot', category: 'Category', topic: 'Topic', collection: 'Collection',
    prompt: 'Prompt', schedule: 'Schedule', yt_channel: 'YouTube Channel', yt_keyword: 'YouTube Tracker'
};

async function loadRecycleBinData() {
    const container = document.getElementById('recycle-bin-content');
    if (!container) return;
    const result = await api('/api/recycle-bin/list');
    if (result.status !== 'ok') {
        container.innerHTML = `<p class="text-muted">Failed to load recycle bin: ${escapeHtmlSys(result.message || 'unknown error')}</p>`;
        return;
    }
    const items = result.items || [];
    // Update badge
    const badge = document.getElementById('recycle-bin-count');
    if (badge) {
        badge.textContent = items.length;
        badge.style.display = items.length > 0 ? '' : 'none';
    }
    const emptyBtn = document.getElementById('rb-empty-btn');
    if (emptyBtn) emptyBtn.style.display = items.length > 0 ? '' : 'none';

    if (items.length === 0) {
        container.innerHTML = `
            <div class="rb-empty">
                <div class="rb-empty-icon">🗑️</div>
                <h3>Recycle Bin is Empty</h3>
                <p class="text-muted">Deleted items will appear here for 5 days before permanent removal.</p>
            </div>`;
        return;
    }

    // Group by type
    const grouped = {};
    items.forEach(item => {
        const t = item.entity_type;
        if (!grouped[t]) grouped[t] = [];
        grouped[t].push(item);
    });

    let html = '';
    for (const [type, typeItems] of Object.entries(grouped)) {
        const icon = _rbTypeIcons[type] || '📎';
        const label = _rbTypeLabels[type] || type;
        html += `<div class="rb-group">
            <h3 class="rb-group-title">${icon} ${label}s (${typeItems.length})</h3>`;
        typeItems.forEach(item => {
            const age = _rbTimeAgo(item.deleted_at);
            const daysLeft = _rbDaysLeft(item.deleted_at);
            const detail = _rbDetail(item);
            html += `
            <div class="rb-item">
                <div class="rb-item-info">
                    <span class="rb-item-icon">${icon}</span>
                    <div class="rb-item-text">
                        <span class="rb-item-name">${escapeHtmlSys(item.entity_name)}</span>
                        ${detail ? `<span class="rb-item-detail">${detail}</span>` : ''}
                    </div>
                </div>
                <div class="rb-item-meta">
                    <span class="rb-item-age" title="Deleted ${escapeHtmlSys(item.deleted_at)}">${age}</span>
                    <span class="rb-item-expiry">${daysLeft}</span>
                </div>
                <div class="rb-item-actions">
                    <button class="btn btn-primary btn-sm" onclick="restoreRecycleBinItem(${item.id})">Restore</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteRecycleBinItem(${item.id})">Delete</button>
                </div>
            </div>`;
        });
        html += '</div>';
    }
    container.innerHTML = html;
}

function _rbTimeAgo(isoStr) {
    if (!isoStr) return '';
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

function _rbDaysLeft(isoStr) {
    if (!isoStr) return '';
    const deleted = new Date(isoStr).getTime();
    const expiry = deleted + 5 * 24 * 60 * 60 * 1000;
    const left = expiry - Date.now();
    if (left <= 0) return 'Expiring soon';
    const days = Math.ceil(left / (24 * 60 * 60 * 1000));
    return `${days}d left`;
}

function _rbDetail(item) {
    const d = item.entity_data;
    if (!d) return '';
    const type = item.entity_type;
    if (type === 'bot') {
        const cats = Object.keys(d.categories || {}).length;
        return `${cats} categories`;
    }
    if (type === 'category') {
        const topics = Object.keys(d.topics || {}).length;
        return `${topics} topics`;
    }
    if (type === 'topic') {
        const kws = (d.keywords || []).length;
        const schs = (d.schedules || []).length;
        return `${kws} keywords, ${schs} schedules`;
    }
    if (type === 'collection') {
        const src = (d.source_channels || []).length;
        const tgt = (d.target_channels || []).length;
        return `${src} sources, ${tgt} targets`;
    }
    if (type === 'prompt') return d.bot_name || '';
    if (type === 'schedule') return `${d.bot_name}/${d.topic_name}`;
    if (type === 'yt_channel') return d.channel_name || d.channel_id || '';
    if (type === 'yt_keyword') return d.keyword || '';
    return '';
}

async function restoreRecycleBinItem(id) {
    showConfirm('Restore this item?', async () => {
        const result = await api('/api/recycle-bin/restore', { id });
        if (result.status === 'ok') {
            showNotification('Item restored', 'success');
            await loadAllData();
            loadRecycleBinData();
        } else {
            showNotification(result.message || 'Restore failed', 'error');
        }
    }, { title: 'Restore Item' });
}

async function deleteRecycleBinItem(id) {
    showConfirm('Permanently delete this item? This cannot be undone.', async () => {
        const result = await api('/api/recycle-bin/delete', { id });
        if (result.status === 'ok') {
            showNotification('Item permanently deleted', 'success');
            loadRecycleBinData();
        } else {
            showNotification(result.message || 'Delete failed', 'error');
        }
    }, { title: 'Permanent Delete' });
}

async function emptyRecycleBin() {
    showConfirm('Permanently delete ALL items in the recycle bin? This cannot be undone.', async () => {
        const result = await api('/api/recycle-bin/empty', {});
        if (result.status === 'ok') {
            showNotification(`Recycle bin emptied (${result.deleted} items)`, 'success');
            loadRecycleBinData();
        }
    }, { title: 'Empty Recycle Bin' });
}

// ==================== Global Search ====================
let _searchDebounceTimer = null;
let _searchResults = [];
let _searchSelectedIndex = -1;

function buildSearchIndex() {
    const index = [];
    if (!globalConfig) return index;

    // Bots, categories, topics, keywords
    const bots = globalConfig.bots || {};
    for (const [botName, bot] of Object.entries(bots)) {
        const cats = bot.categories || {};
        const catCount = Object.keys(cats).length;
        index.push({ type: 'bot', label: botName, subtitle: `Bot · ${catCount} categor${catCount === 1 ? 'y' : 'ies'}`, icon: '🤖', page: 'bots', botName, openIds: [] });

        for (const [catName, cat] of Object.entries(cats)) {
            const catId = `category-${botName}-${catName}`;
            const topicCount = Object.keys(cat.topics || {}).length;
            index.push({ type: 'category', label: catName, subtitle: `Category in ${botName} · ${topicCount} topic${topicCount === 1 ? '' : 's'}`, icon: '🗂️', page: 'bots', botName, openIds: [catId] });

            for (const [topicName, topic] of Object.entries(cat.topics || {})) {
                const topicId = `topic-${botName}-${catName}-${topicName}`;
                index.push({ type: 'topic', label: topicName, subtitle: `Topic in ${catName} › ${botName}`, icon: '📌', page: 'bots', botName, openIds: [catId, topicId] });

                for (const kw of (topic.keywords || [])) {
                    index.push({ type: 'keyword', label: kw, subtitle: `SEO in ${topicName} › ${catName}`, icon: '🔎', page: 'bots', botName, openIds: [catId, topicId] });
                }
            }
        }
    }

    // Collections, sources, targets
    const collections = globalConfig.collections || {};
    for (const [collName, coll] of Object.entries(collections)) {
        const safeId = 'coll-card-' + collName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const srcCount = (coll.source_channels || []).length;
        index.push({ type: 'collection', label: collName, subtitle: `Collection · ${srcCount} source${srcCount === 1 ? '' : 's'}`, icon: '📦', page: 'collections', scrollTo: safeId });

        for (const src of (coll.source_channels || [])) {
            index.push({ type: 'source', label: src, subtitle: `Source channel in ${collName}`, icon: '📡', page: 'collections', scrollTo: safeId });
        }
        const targets = [coll.target_channel, ...(coll.target_channels || [])].filter(Boolean);
        for (const tgt of [...new Set(targets)]) {
            index.push({ type: 'target', label: tgt, subtitle: `Target channel in ${collName}`, icon: '📤', page: 'collections', scrollTo: safeId });
        }
    }

    return index;
}

function handleSearchInput(query) {
    clearTimeout(_searchDebounceTimer);
    const clearBtn = document.getElementById('global-search-clear');
    if (clearBtn) clearBtn.style.display = query ? '' : 'none';

    if (!query.trim()) { hideSearchResults(); return; }

    _searchDebounceTimer = setTimeout(() => performSearch(query.trim()), 150);
}

function performSearch(query) {
    const index = buildSearchIndex();
    const q = query.toLowerCase();
    _searchResults = index.filter(item =>
        item.label.toLowerCase().includes(q) || item.subtitle.toLowerCase().includes(q)
    ).slice(0, 25);
    renderSearchResults(_searchResults, query);
}

function _highlightMatch(text, query) {
    const q = query.toLowerCase();
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return text;
    return text.slice(0, idx) + '<mark class="search-highlight">' + text.slice(idx, idx + query.length) + '</mark>' + text.slice(idx + query.length);
}

function renderSearchResults(results, query) {
    const dropdown = document.getElementById('global-search-results');
    if (!dropdown) return;
    _searchSelectedIndex = -1;

    // Position the dropdown below the search input
    const input = document.getElementById('global-search-input');
    if (input) {
        const rect = input.closest('.sidebar-search').getBoundingClientRect();
        dropdown.style.top  = (rect.bottom + 4) + 'px';
        dropdown.style.left = rect.left + 'px';
        dropdown.style.width = Math.max(rect.width, 280) + 'px';
    }

    if (results.length === 0) {
        dropdown.innerHTML = `<div class="search-no-results">No results for "<strong>${escapeHtmlSys(query)}</strong>"</div>`;
        dropdown.style.display = '';
        return;
    }

    const typeOrder = ['bot', 'category', 'topic', 'keyword', 'collection', 'source', 'target'];
    const typeLabels = { bot: 'Bots', category: 'Categories', topic: 'Topics', keyword: 'SEOs', collection: 'Collections', source: 'Sources', target: 'Targets' };
    const grouped = {};
    for (const item of results) {
        if (!grouped[item.type]) grouped[item.type] = [];
        grouped[item.type].push(item);
    }

    let html = '';
    let globalIdx = 0;
    for (const type of typeOrder) {
        if (!grouped[type]) continue;
        html += `<div class="search-result-group-label">${typeLabels[type]}</div>`;
        for (const item of grouped[type]) {
            const highlighted = _highlightMatch(escapeHtmlSys(item.label), query);
            html += `<div class="search-result-item" data-idx="${globalIdx}" onclick="selectSearchResult(${globalIdx})">
                <span class="search-result-icon">${item.icon}</span>
                <div class="search-result-text">
                    <div class="search-result-label">${highlighted}</div>
                    <div class="search-result-subtitle">${escapeHtmlSys(item.subtitle)}</div>
                </div>
            </div>`;
            globalIdx++;
        }
    }

    dropdown.innerHTML = html;
    dropdown.style.display = '';
}

function handleSearchKeydown(event) {
    const dropdown = document.getElementById('global-search-results');
    if (!dropdown || dropdown.style.display === 'none') {
        if (event.key === 'Escape') clearSearch();
        return;
    }
    const items = dropdown.querySelectorAll('.search-result-item');
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        _searchSelectedIndex = Math.min(_searchSelectedIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === _searchSelectedIndex));
        if (items[_searchSelectedIndex]) items[_searchSelectedIndex].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        _searchSelectedIndex = Math.max(_searchSelectedIndex - 1, 0);
        items.forEach((el, i) => el.classList.toggle('selected', i === _searchSelectedIndex));
        if (items[_searchSelectedIndex]) items[_searchSelectedIndex].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (_searchSelectedIndex >= 0 && _searchSelectedIndex < _searchResults.length) {
            selectSearchResult(_searchSelectedIndex);
        }
    } else if (event.key === 'Escape') {
        clearSearch();
    }
}

function selectSearchResult(idx) {
    const result = _searchResults[idx];
    if (!result) return;
    clearSearch();

    if (result.page === 'bots') {
        showPage('bots');
        if (result.botName) {
            openBotDetail(result.botName);
            if (result.openIds && result.openIds.length > 0) {
                setTimeout(() => {
                    // Switch to categories tab for category/topic/keyword results
                    if (result.type !== 'bot') switchBotTab(result.botName, 'categories');
                    result.openIds.forEach(id => {
                        const el = document.getElementById(id);
                        if (el && !el.classList.contains('open')) el.classList.add('open');
                    });
                    const target = document.getElementById(result.openIds[result.openIds.length - 1]);
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 120);
            }
        }
    } else if (result.page === 'collections') {
        showPage('collections');
        if (result.scrollTo) {
            setTimeout(() => {
                const el = document.getElementById(result.scrollTo);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 80);
        }
    }
}

function hideSearchResults() {
    const dropdown = document.getElementById('global-search-results');
    if (dropdown) dropdown.style.display = 'none';
    _searchResults = [];
    _searchSelectedIndex = -1;
}

function clearSearch() {
    const input = document.getElementById('global-search-input');
    const clearBtn = document.getElementById('global-search-clear');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    hideSearchResults();
}

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

// ==================== Schedule History Tab ====================
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
    `;
    document.head.appendChild(s);
})();

async function loadScheduleHistory() {
    const wrap = document.getElementById('mon-history-content');
    if (!wrap) return;
    wrap.innerHTML = '<p class="mon-empty">Loading…</p>';

    const bot    = document.getElementById('hist-filter-bot')?.value    || '';
    const topic  = document.getElementById('hist-filter-topic')?.value  || '';
    const status = document.getElementById('hist-filter-status')?.value || '';

    let url = '/api/monitor/schedule-history?limit=200';
    if (bot)    url += '&bot='    + encodeURIComponent(bot);
    if (topic)  url += '&topic='  + encodeURIComponent(topic);
    if (status) url += '&status=' + encodeURIComponent(status);

    const data = await api(url);
    if (data.status !== 'ok') {
        wrap.innerHTML = `<p class="mon-empty">Error: ${escapeHtml(data.message || '')}</p>`;
        return;
    }
    const runs = data.runs || [];
    _populateHistoryFilters(runs);
    _renderScheduleHistory(runs);
}

function _populateHistoryFilters(runs) {
    const bots   = [...new Set(runs.map(r => r.bot_name).filter(Boolean))].sort();
    const topics = [...new Set(runs.map(r => r.topic_name).filter(Boolean))].sort();
    _populateMonSelect('hist-filter-bot',   bots,   'All Bots');
    _populateMonSelect('hist-filter-topic', topics, 'All Topics');
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
        const typeCls  = { hourly: 'hourly', daily: 'daily', minute: 'minute', interval: 'interval' }[r.schedule_type] || '';
        const errorBtn = (!isOk && r.error_text)
            ? `<button class="btn btn-sm" style="font-size:11px;padding:2px 8px;"
                  onclick="showHistError(this)"
                  data-err="${escapeHtmlSys(r.error_text)}">View Error</button>`
            : '—';
        const timeStr = r.fired_at ? r.fired_at.replace('T', ' ').slice(0, 19) : '—';
        const msgsCell = r.summary_id
            ? `<span class="mon-msgs-link" onclick="showHistoryMessages(${r.summary_id})">${r.message_count || 0}</span>`
            : (r.message_count || 0);
        return `<tr class="${rowCls}">
            <td class="hist-time">${escapeHtml(timeStr)}</td>
            <td>${escapeHtml(r.bot_name   || '—')}</td>
            <td>${escapeHtml(r.topic_name || '—')}</td>
            <td><span class="mon-type-badge ${typeCls}">${escapeHtml(r.schedule_type || '—')}</span></td>
            <td>${statusEl}</td>
            <td style="text-align:center">${msgsCell}</td>
            <td>${errorBtn}</td>
        </tr>`;
    }).join('');
    wrap.innerHTML = `<div style="overflow-x:auto;max-height:70vh;overflow-y:auto;">
        <table class="hist-table">
            <thead><tr>
                <th>Time</th><th>Bot</th><th>Topic</th><th>Type</th>
                <th>Status</th><th>Msgs</th><th>Error</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

window.showHistError = function (btn) {
    const err = btn.getAttribute('data-err') || '(no error text)';

    // Parse a friendly label from the error string
    let label = 'Schedule Error';
    let detail = err;
    let isKnown = false;

    if (/429|resource.?exhausted/i.test(err)) {
        label = '429 Resource Exhausted — AI quota limit reached';
        isKnown = true;
    } else if (/499|cancelled/i.test(err)) {
        label = '499 Cancelled — the AI request was cancelled';
        isKnown = true;
    } else if (/500|internal/i.test(err)) {
        label = '500 Internal Server Error';
        isKnown = true;
    } else if (/503|unavailable/i.test(err)) {
        label = '503 Service Unavailable — AI backend is down';
        isKnown = true;
    }

    const safeErr = escapeHtml(detail);
    const safeLabel = escapeHtml(label);

    const html = `
        <div style="font-weight:600;color:var(--danger);margin-bottom:10px;">${safeLabel}</div>
        ${isKnown ? `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">
            ${/429|exhausted/i.test(err)
                ? 'The AI API rate limit was hit. The next scheduled run should succeed automatically once the quota resets.'
                : /499|cancel/i.test(err)
                ? 'The request was cancelled before the AI could respond — usually a timeout or network interruption. The next run will retry.'
                : 'An error occurred with the AI backend.'}
        </p>` : ''}
        <details style="margin-top:8px;">
            <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none;">Show technical details</summary>
            <pre style="margin-top:8px;font-size:11px;background:var(--bg-secondary,#f5f5f5);padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow-y:auto;">${safeErr}</pre>
        </details>`;

    showAlert(html, { title: 'Schedule Run Error', icon: '⚠️' });
};

// ---------- History Source Messages — inline view ----------
let _histMsgData = [];

async function showHistoryMessages(summaryId) {
    _histMsgData = [];
    const panel = document.getElementById('mon-tab-history');
    panel.innerHTML = `
        <div class="sum-msg-page">
            <div class="sum-msg-page-header">
                <button class="btn btn-secondary btn-sm" onclick="_closeHistoryMessages()">‹ Back to History</button>
                <h3 style="margin:0;font-size:15px">Source Messages</h3>
            </div>
            <div class="mon-filter-bar" style="flex-wrap:wrap;gap:8px">
                <input type="text" class="input mon-filter-search" id="hmsg-search"
                       placeholder="🔍 Search message text…" oninput="_renderHistMsgTable()">
                <select class="select mon-filter-sel" id="hmsg-filter-source" onchange="_renderHistMsgTable()">
                    <option value="">All Sources</option>
                </select>
                <button class="btn btn-secondary btn-sm" onclick="_clearHistMsgFilters()">✕ Clear</button>
            </div>
            <div id="hmsg-table-wrap"><p class="mon-empty">Loading…</p></div>
        </div>`;

    const data = await api(`/api/monitor/summary-messages?id=${summaryId}`);
    const wrap = document.getElementById('hmsg-table-wrap');
    if (!wrap) return;

    if (data.status !== 'ok' || !data.messages?.length) {
        wrap.innerHTML = `<p class="mon-empty">No linked messages found.</p>`;
        return;
    }
    _histMsgData = data.messages;

    const sources = [...new Set(_histMsgData.map(m => m.channel_username).filter(Boolean))].sort();
    const sel = document.getElementById('hmsg-filter-source');
    if (sel) sources.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = '@' + s; sel.appendChild(o); });

    _renderHistMsgTable();
}

function _renderHistMsgTable() {
    const wrap = document.getElementById('hmsg-table-wrap');
    if (!wrap) return;

    const search = (document.getElementById('hmsg-search')?.value || '').toLowerCase();
    const source = document.getElementById('hmsg-filter-source')?.value || '';

    let filtered = _histMsgData;
    if (search) filtered = filtered.filter(m => (m.preview || '').toLowerCase().includes(search));
    if (source) filtered = filtered.filter(m => m.channel_username === source);

    if (!filtered.length) {
        wrap.innerHTML = `<p class="mon-empty">No messages match filters.</p>`;
        return;
    }

    const rows = filtered.map(m => {
        const ts  = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
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
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${filtered.length} message${filtered.length === 1 ? '' : 's'}</div>
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

function _clearHistMsgFilters() {
    const s = document.getElementById('hmsg-search');
    const src = document.getElementById('hmsg-filter-source');
    if (s) s.value = '';
    if (src) src.value = '';
    _renderHistMsgTable();
}

function _closeHistoryMessages() {
    _histMsgData = [];
    loadScheduleHistory();
}

// ==================== Logs Page ====================
let _allLogs       = [];
let _logsTimer     = null;
let _logsLoaded    = false;

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

    _allLogs   = data.logs || [];
    _logsLoaded = true;
    _renderLogTable(_allLogs);
    _updateLogsErrorBadge();
    _scheduleLogAutoRefresh();
}

function _renderLogTable(logs) {
    const wrap = document.getElementById('logs-table-wrap');
    if (!wrap) return;
    if (!logs.length) {
        wrap.innerHTML = '<p class="mon-empty" style="padding:24px">No log records.</p>';
        return;
    }
    const rows = logs.map(r => {
        const lvlCls  = _LOG_LEVEL_CLS[r.level] || '';
        const rowCls  = r.level === 'ERROR' ? 'log-row-error' : r.level === 'WARNING' ? 'log-row-warn' : '';
        return `<tr class="${rowCls}">
            <td class="log-time">${escapeHtml(r.time || '')}</td>
            <td class="log-name" title="${escapeHtmlSys(r.name || '')}">${escapeHtml(r.name || '')}</td>
            <td class="log-level ${lvlCls}">${escapeHtml(r.level || '')}</td>
            <td class="log-msg">${escapeHtml(r.message || '')}</td>
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
    // Re-fetch from server (filters applied server-side for efficiency)
    clearTimeout(_logsTimer);
    loadLogsPage();
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
    // Count errors from the full unfiltered buffer (fetch separately if needed;
    // here we count from the current loaded set as a best-effort indicator)
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
    const blob  = new Blob(['\uFEFF' + lines], { type: 'text/plain;charset=utf-8' });
    const a     = document.createElement('a');
    a.href      = URL.createObjectURL(blob);
    a.download  = `logs_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
}