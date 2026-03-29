// ==================== Bot Manager V3.0 - Complete Implementation ====================
// All 11 improvements included

// ==================== Theme ====================
(function () {
    const saved = localStorage.getItem('theme') || 'dark';
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
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
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
    // Wait for auth/role check (accounts.js) before showing initial page
    // so hidden nav sections are gated before the first render.
    if (typeof authReady !== 'undefined') await authReady;
    const savedPage = localStorage.getItem('activePage') || 'system';
    showPage(savedPage);
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
    else if (pageName === 'yt-videos') loadYtVideosData();
    else if (pageName === 'yt-chat') ytChatInit();
    else if (pageName === 'agent-chat') agentChatInit();
    else if (pageName === 'system-chat') sysChatInit();
    else if (pageName === 'recycle-bin') loadRecycleBinData();
    else if (pageName === 'accounts') loadAccountsData();
    else if (pageName === 'profile') loadProfileData();
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
    hide('sys-control-toggle-wrap',  !isAdmin);
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
                        <div class="stat-label">Keywords</div>
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
    
    return `
        <div class="collection-card">
            <div class="collection-header">
                <div class="flex-center">
                    <label class="toggle-switch">
                        <input type="checkbox" ${collection.enabled ? 'checked' : ''} 
                               onchange="toggleCollection('${collectionName}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <h3>${collection.name || collectionName}</h3>
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

// ==================== Collection Modal ====================
function showAddCollectionModal(existingName = null) {
    const existing = existingName ? globalConfig.collections[existingName] : null;

    modalSources = existing ? [...(existing.source_channels || [])] : [];
    modalTargets = existing
        ? [...(existing.target_channels || (existing.target_channel ? [existing.target_channel] : []))]
        : [];
    _channelValidation = {};
    // Pre-validate existing channels in the background
    [...modalSources, ...modalTargets].forEach(ch => {
        const type = modalSources.includes(ch) ? 'source' : 'target';
        validateChannelTag(ch, type);
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
                           placeholder="e.g., news_sources"
                           value="${existingName || ''}"
                           ${existingName ? 'disabled' : ''}>
                </div>
                <div class="form-group">
                    <label class="form-label">Display Name</label>
                    <input type="text" class="input" id="collection-display-name"
                           placeholder="e.g., News Sources"
                           value="${existing ? (existing.name || '') : ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Source Channels</label>
                    <div class="tags-container" id="source-tags"></div>
                    <small class="form-hint">Type @channel and press Enter. Userbot must be a member to receive messages.</small>
                </div>
                <div class="form-group">
                    <label class="form-label">Target Channels</label>
                    <div class="tags-container" id="target-tags"></div>
                    <small class="form-hint">Type @channel and press Enter. Userbot must be a member and have send permission.</small>
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
    const collectionName = existingName || document.getElementById('collection-name').value.trim();
    const displayName = document.getElementById('collection-display-name').value.trim();

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

    const result = await api('/api/collection/save', {
        collection_name: collectionName,
        name: displayName || collectionName,
        source_channels: sources,
        target_channels: targets,
        enabled: true
    });

    if (result.status === 'ok') {
        await loadAllData();
        renderCollectionsPage();
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
            showNotification('Collection deleted', 'success');
        } else {
            showNotification('Failed to delete collection', 'error');
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
    }, 50);
}

function createBotConfigCard(name, bot) {
    const card = document.createElement('div');
    card.className = 'bot-config-card';
    card.id = `bot-${name}`;

    const savedTab  = localStorage.getItem(`bot-tab-${name}`) || 'basic';
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
    localStorage.setItem(`bot-tab-${botName}`, tab);
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
                                        <button class="btn-icon btn-danger" style="font-size:12px;flex-shrink:0;" onclick="removeDefaultSchedule('${botName}', ${idx})">🗑️</button>
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

    return `
        <div class="category-box collapsible-section ${defaultOpen ? 'open' : ''}" id="${sectionId}">
            <div class="category-header-row" onclick="toggleCollapsible('${jsAttr(sectionId)}')">
                <div class="category-title-group">
                    <h4>🗂️ ${escapeHtmlSys(categoryName)}</h4>
                    <span class="text-muted" style="margin-left: 8px;">(${topicCount} topic${topicCount !== 1 ? 's' : ''})</span>
                </div>
                <div class="category-controls" onclick="event.stopPropagation()">
                    <button class="btn btn-secondary btn-sm"
                            onclick="document.getElementById('new-topic-${botName}-${categoryName}').focus()">
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
            </div>
        </div>
    `;
}

function createTopicBox(botName, categoryName, topicName, topic, categoryEnabled = true) {
    const keywords = topic.keywords || [];
    const schedules = topic.schedules || [];
    const linkedTopics = topic.linked_topics || [];
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
                    <div class="form-group">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                            <label class="form-label" style="margin:0;">Keywords (${keywords.length})</label>
                            ${keywords.length > 0 ? `<div class="kw-bulk-actions" style="display:flex;gap:6px;align-items:center;">
                                <button class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px;" onclick="kwToggleSelectAll('${b}','${c}','${t}')">Select All</button>
                                <button class="btn btn-danger btn-sm kw-del-sel-btn" style="font-size:10px;padding:2px 8px;display:none;" data-topic="${b}|${c}|${t}" onclick="kwDeleteSelected('${b}','${c}','${t}')">Delete Selected</button>
                                <button class="btn btn-danger btn-sm" style="font-size:10px;padding:2px 8px;" onclick="kwDeleteAll('${b}','${c}','${t}')">Delete All</button>
                            </div>` : ''}
                        </div>
                        <div class="tags-container tags-scrollable" id="kw-tags-${b}-${c}-${t}">
                            ${keywords.map((kw, idx) => `
                                <span class="tag kw-selectable" data-idx="${idx}">
                                    <input type="checkbox" class="kw-cb" style="margin:0 4px 0 0;accent-color:var(--accent-primary);cursor:pointer;" onchange="kwSelectionChanged('${b}','${c}','${t}')">
                                    ${escapeHtmlSys(kw)}
                                    <span class="tag-remove"
                                          onclick="removeKeyword('${b}', '${c}', '${t}', ${idx})">×</span>
                                </span>
                            `).join('')}
                            <input type="text" class="tag-input" placeholder="+ Add keywords (comma-separated)"
                                   onkeydown="return handleKeywordInput(event, '${b}', '${c}', '${t}')">
                        </div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Linked Topics (inherit keywords)</label>
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
                        <small class="text-muted d-block mt-1">Link to other topics to inherit their keywords</small>
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
        return `Every ${schedule.minutes || 30}min — starts ${sh}:${sm}`;
    }
    if (type === 'interval') {
        const sh = String(schedule.start_hour   ?? 0).padStart(2, '0');
        const sm = String(schedule.start_minute ?? 0).padStart(2, '0');
        return `Every ${schedule.hours || 1}h — starts ${sh}:${sm}`;
    }
    if (type === 'daily') return `Daily at ${String(schedule.hour || 0).padStart(2, '0')}:${String(schedule.minute || 0).padStart(2, '0')}`;
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
        categories: {}
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
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Prompt</label>
                    <select class="select" id="ds-prompt">${promptOptions}</select>
                </div>
                <div id="ds-type-inputs"></div>
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
        container.innerHTML = `<div class="form-group"><label class="form-label">At Minute</label>
            <input type="number" class="input" id="ds-minute" min="0" max="59" value="0"></div>`;
    } else if (type === 'interval_minutes') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Every N Minutes</label>
            <input type="number" class="input" id="ds-minutes" min="1" value="30"></div>
            <div class="form-group"><label class="form-label">Start Hour</label>
            <input type="number" class="input" id="ds-start-hour" min="0" max="23" value="0"></div>
            <div class="form-group"><label class="form-label">Start Minute</label>
            <input type="number" class="input" id="ds-start-minute" min="0" max="59" value="0"></div>`;
    } else if (type === 'interval') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Every N Hours</label>
            <input type="number" class="input" id="ds-hours" min="1" max="24" value="3"></div>
            <div class="form-group"><label class="form-label">Start Hour</label>
            <input type="number" class="input" id="ds-start-hour" min="0" max="23" value="0"></div>
            <div class="form-group"><label class="form-label">Start Minute</label>
            <input type="number" class="input" id="ds-start-minute" min="0" max="59" value="0"></div>`;
    } else if (type === 'daily') {
        container.innerHTML = `<div class="form-group"><label class="form-label">Hour</label>
            <input type="number" class="input" id="ds-hour" min="0" max="23" value="18"></div>
            <div class="form-group"><label class="form-label">Minute</label>
            <input type="number" class="input" id="ds-minute" min="0" max="59" value="0"></div>`;
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
    const text = document.getElementById(`prompt-${botName}-${promptKey}`)?.value || '';
    const result = await api('/api/prompts/update', { bot_name: botName, key: promptKey, text });
    if (result.status === 'ok') {
        await loadAllData();
        renderBotsPage();
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
            showNotification('Prompt deleted', 'success');
        }
    }, { title: 'Delete Prompt' });
}

function renamePromptDialog(botName, oldKey) {
    showPrompt('Rename Prompt', oldKey, async (newKey) => {
        await renamePrompt(botName, oldKey, newKey);
    });
}

async function renamePrompt(botName, oldKey, newKey) {
    newKey = newKey.trim();
    if (!newKey || oldKey === newKey) return;

    // Get bot prompts
    const botPrompts = (globalPrompts && globalPrompts[botName]) || {};

    // Check if new key already exists for this bot
    if (botPrompts[newKey]) {
        showAlert(`Prompt "${newKey}" already exists`, { icon: '⚠️' });
        renderBotsPage(); // Reset the input
        return;
    }

    // Get the old prompt value (may be string or {header, text} dict)
    const oldVal = botPrompts[oldKey];
    if (!oldVal) return;
    const oldText = (oldVal && typeof oldVal === 'object') ? (oldVal.text || '') : (oldVal || '');

    // Create new prompt with new key
    const addResult = await api('/api/prompts/update', { bot_name: botName, key: newKey, text: oldText });
    if (addResult.status === 'ok') {
        // Delete old prompt
        await api('/api/prompts/delete', { bot_name: botName, key: oldKey });
        // Cascade rename to all schedules that referenced the old prompt key
        await api('/api/prompts/rename-cascade', { bot_name: botName, old_key: oldKey, new_key: newKey });
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
        showNotification(`Category and all topics ${enabled ? 'enabled' : 'disabled'}`, 'success');
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
                    <small class="text-muted">This topic will inherit all keywords from the linked topic</small>
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
            const message = addedCount === 1 ? 'Keyword added' : `${addedCount} keywords added`;
            showNotification(message, 'success');
        }
    }
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
            renderBotsPage([`topic-${b}-${c}-${t}`, `categories-${b}`]);
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
            renderBotsPage([`topic-${b}-${c}-${t}`, `categories-${b}`]);
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
            <label class="form-label mt-1">Starting at (HH : MM)</label>
            <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="topic-schedule-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                <input type="number" class="input" id="topic-schedule-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
            </div>
            <small class="text-muted">First run at this time, then every X minutes</small>
        `;
    } else if (type === 'interval') {
        container.innerHTML = `
            <label class="form-label">Every X Hours</label>
            <input type="number" class="input" id="topic-schedule-hours" min="1" max="24" value="2">
            <label class="form-label mt-1">Starting at (HH : MM)</label>
            <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="topic-schedule-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                <input type="number" class="input" id="topic-schedule-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
            </div>
            <small class="text-muted">First run at this time, then every X hours</small>
        `;
    } else if (type === 'daily') {
        container.innerHTML = `
            <label class="form-label">Hour</label>
            <input type="number" class="input" id="topic-schedule-hour" min="0" max="23" value="18">
            <label class="form-label mt-1">Minute</label>
            <input type="number" class="input" id="topic-schedule-minute" min="0" max="59" value="0">
        `;
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
    
    const headerInput = document.getElementById('topic-schedule-header').value;
    const header = headerInput || `**${name}**`;
    const header_datetime = document.getElementById('topic-schedule-header-datetime').checked;
    const header_date_arabic = document.getElementById('topic-schedule-date-arabic').checked;
    const header_time_arabic = document.getElementById('topic-schedule-time-arabic').checked;

    const telegram_targets = getSchTgTargets('topic-schedule');

    const schedule = {
        name,
        type,
        prompt_key,
        enabled: true,
        header,
        header_datetime,
        header_date_arabic,
        header_time_arabic,
        telegram_targets
    };

    if (type === 'minute') {
        schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
    } else if (type === 'hourly') {
        schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
    } else if (type === 'interval_minutes') {
        schedule.minutes      = Number(document.getElementById('topic-schedule-minutes').value);
        schedule.start_hour   = Number(document.getElementById('topic-schedule-start-hour').value);
        schedule.start_minute = Number(document.getElementById('topic-schedule-start-minute').value);
    } else if (type === 'interval') {
        schedule.hours        = Number(document.getElementById('topic-schedule-hours').value);
        schedule.start_hour   = Number(document.getElementById('topic-schedule-start-hour').value);
        schedule.start_minute = Number(document.getElementById('topic-schedule-start-minute').value);
    } else if (type === 'daily') {
        schedule.hour = Number(document.getElementById('topic-schedule-hour').value);
        schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
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

    const typeOptions = ['minute', 'hourly', 'interval_minutes', 'interval', 'daily'];
    const typeLabels  = { minute: 'Every Minute', hourly: 'Hourly', interval_minutes: 'Every X Minutes', interval: 'Every X Hours', daily: 'Daily' };

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
                            <option value="${key}"${schedule.prompt_key === key ? ' selected' : ''}>${key}</option>
                        `).join('')}
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
        return `<label class="form-label">Every X Minutes</label>
                <input type="number" class="input" id="edit-sch-minutes" min="1" max="1440" value="${schedule.minutes || 30}">
                <label class="form-label mt-1">Starting at (HH : MM)</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="edit-sch-start-hour" min="0" max="23" value="${schedule.start_hour ?? 0}" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="edit-sch-start-minute" min="0" max="59" value="${schedule.start_minute ?? 0}" placeholder="MM" style="width:80px;">
                </div>
                <small class="text-muted">First run at this time, then every X minutes</small>`;
    } else if (type === 'interval') {
        return `<label class="form-label">Every X Hours</label>
                <input type="number" class="input" id="edit-sch-hours" min="1" max="24" value="${schedule.hours || 2}">
                <label class="form-label mt-1">Starting at (HH : MM)</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="edit-sch-start-hour" min="0" max="23" value="${schedule.start_hour ?? 0}" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="edit-sch-start-minute" min="0" max="59" value="${schedule.start_minute ?? 0}" placeholder="MM" style="width:80px;">
                </div>
                <small class="text-muted">First run at this time, then every X hours</small>`;
    } else if (type === 'daily') {
        return `<label class="form-label">Hour</label>
                <input type="number" class="input" id="edit-sch-hour" min="0" max="23" value="${schedule.hour || 0}">
                <label class="form-label mt-1">Minute</label>
                <input type="number" class="input" id="edit-sch-minute" min="0" max="59" value="${schedule.minute || 0}">`;
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
    } else if (type === 'interval') {
        schedule.hours        = Number(document.getElementById('edit-sch-hours').value);
        schedule.start_hour   = Number(document.getElementById('edit-sch-start-hour').value);
        schedule.start_minute = Number(document.getElementById('edit-sch-start-minute').value);
    } else if (type === 'daily') {
        schedule.hour   = Number(document.getElementById('edit-sch-hour').value);
        schedule.minute = Number(document.getElementById('edit-sch-minute').value);
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
`;

// ==================== Monitor Page ====================
let _monitorData = null;
let _monitorTimerInterval = null;
let _monitorRefreshInterval = null;
let _monActiveTab = 'schedules';
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
    renderMonSummaries(data.recent_summaries || []);
    // Only re-render summaries filter on auto-refresh (lightweight); messages/unclassified are on-demand
    if (_monActiveTab === 'summaries') applyMonSummaryFilters();
    startMonitorCountdowns();

    // Load unclassified badge count in background
    api('/api/monitor/unclassified?limit=1').then(r => {
        if (r.status === 'ok') {
            const total = (r.stats || []).reduce((s, x) => s + (x.cnt || 0), 0);
            const badge = document.getElementById('mon-uncl-badge');
            if (badge) {
                badge.textContent = total;
                badge.style.display = total > 0 ? 'inline-block' : 'none';
            }
        }
    });

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
    document.querySelectorAll('.mon-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === tab)
    );
    ['schedules', 'summaries', 'messages', 'unclassified'].forEach(t => {
        const el = document.getElementById('mon-tab-' + t);
        if (el) el.style.display = t === tab ? '' : 'none';
    });
    if (tab === 'messages' && !_allMessages.length) loadMonitorMessages();
    if (tab === 'unclassified' && !_unclMessages.length) loadUnclassifiedMessages();
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
    if (sch.type === 'hourly')           return '🕐';
    if (sch.type === 'daily')            return '📅';
    if (sch.type === 'minute')           return '⚡';
    if (sch.type === 'interval')         return '🔁';
    if (sch.type === 'interval_minutes') return '🔁';
    return '🔔';
}

function scheduleSpec(sch) {
    if (sch.type === 'hourly')   return `every hour at :${String(sch.minute ?? 0).padStart(2,'0')}`;
    if (sch.type === 'daily')    return `daily at ${String(sch.hour ?? 0).padStart(2,'0')}:${String(sch.minute ?? 0).padStart(2,'0')}`;
    if (sch.type === 'minute')   return `every ${sch.minute ?? 1} min`;
    if (sch.type === 'interval_minutes') {
        const sh = String(sch.start_hour   ?? 0).padStart(2, '0');
        const sm = String(sch.start_minute ?? 0).padStart(2, '0');
        return `every ${sch.minutes || 30}m — starts ${sh}:${sm}`;
    }
    if (sch.type === 'interval') {
        const sh = String(sch.start_hour   ?? 0).padStart(2, '0');
        const sm = String(sch.start_minute ?? 0).padStart(2, '0');
        return `every ${sch.hours || 1}h — starts ${sh}:${sm}`;
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
        const startM = sch.start_minute ?? 0;
        const hours  = sch.hours ?? 1;
        const anchor = new Date(now);
        anchor.setHours(startH, startM, 0, 0);
        if (anchor > now) anchor.setDate(anchor.getDate() - 1);
        const elapsed = (now - anchor) / 3600000; // hours
        const n = Math.floor(elapsed / hours);
        const next = new Date(anchor.getTime() + (n + 1) * hours * 3600000);
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

// ---------- Recent Summaries ----------
function renderMonSummaries(summaries) {
    _allSummaries = summaries;
    // Populate dynamic dropdowns
    const bots   = [...new Set(summaries.map(s => s.bot_name).filter(Boolean))].sort();
    const topics = [...new Set(summaries.map(s => s.topic_name).filter(Boolean))].sort();
    _populateMonSelect('sum-filter-bot',   bots,   'All Bots');
    _populateMonSelect('sum-filter-topic', topics, 'All Topics');
    applyMonSummaryFilters();
}

function applyMonSummaryFilters() {
    const bot    = document.getElementById('sum-filter-bot')?.value   || '';
    const topic  = document.getElementById('sum-filter-topic')?.value || '';
    const type   = document.getElementById('sum-filter-type')?.value  || '';
    const search = (document.getElementById('sum-search')?.value || '').trim().toLowerCase();

    let filtered = _allSummaries;
    if (bot)    filtered = filtered.filter(s => s.bot_name    === bot);
    if (topic)  filtered = filtered.filter(s => s.topic_name  === topic);
    if (type)   filtered = filtered.filter(s => s.summary_type === type);
    if (search) filtered = filtered.filter(s => (s.preview || '').toLowerCase().includes(search));

    const el = document.getElementById('mon-summaries-content');
    if (!filtered.length) {
        el.innerHTML = `<p class="mon-empty">${_allSummaries.length ? 'No summaries match the filters.' : 'No summaries sent yet.'}</p>`;
        return;
    }
    const rows = filtered.map(s => {
        const ts = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
        const typeCls = s.summary_type || 'hourly';
        const count = s.message_count ?? '—';
        const msgsCell = s.message_ids
            ? `<span class="mon-msgs-link" onclick="showSummaryMessages(${s.id})">${count}</span>`
            : count;
        return `<tr>
            <td style="white-space:nowrap;">${ts}</td>
            <td>${escapeHtml(s.bot_name || '—')}</td>
            <td>${escapeHtml(s.topic_name || '—')}</td>
            <td><span class="mon-type-badge ${typeCls}">${escapeHtml(s.summary_type || '—')}</span></td>
            <td style="text-align:center;">${msgsCell}</td>
            <td>${escapeHtml(s.target_entity || '—')}</td>
            <td class="mon-ellipsis" title="${escapeHtml(s.preview || '')}">${escapeHtml(s.preview || '')}</td>
        </tr>`;
    }).join('');
    el.innerHTML = `<div style="overflow-x:auto;">
        <table class="mon-table">
            <thead><tr><th>Time</th><th>Bot</th><th>Topic</th><th>Type</th><th>Msgs</th><th>Target</th><th>Preview</th></tr></thead>
            <tbody>${rows}</tbody>
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
        const src = m.channel_username ? `@${escapeHtml(m.channel_username)}` : '—';
        const col = m.collection_name  ? escapeHtml(m.collection_name)  : '—';
        const bot = m.bot_name         ? escapeHtml(m.bot_name)         : '—';
        const top = m.topics           ? escapeHtml(m.topics)           : '—';
        const kw  = m.keywords_found   ? escapeHtml(m.keywords_found)   : '—';
        const txt = escapeHtml(m.preview || '');
        return `<tr>
            <td style="white-space:nowrap;font-size:11px">${ts}</td>
            <td><span class="mon-ch-badge">${src}</span></td>
            <td style="font-size:11px">${col}</td>
            <td style="font-size:11px">${bot}</td>
            <td style="font-size:11px">${top}</td>
            <td style="font-size:11px">${kw}</td>
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
    // Rebuild the summaries tab HTML
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
            </select>
            <input type="text" class="input mon-filter-search" id="sum-search" placeholder="🔍 Search preview…" oninput="applyMonSummaryFilters()">
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
        if (!append) el.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message)}</p>`;
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

function applyMonMessageFilters() {
    const coll    = document.getElementById('msg-filter-coll')?.value    || '';
    const channel = document.getElementById('msg-filter-channel')?.value || '';
    const topic   = document.getElementById('msg-filter-topic')?.value   || '';
    const search  = (document.getElementById('msg-search')?.value || '').trim().toLowerCase();

    let filtered = _allMessages;
    if (coll)    filtered = filtered.filter(m => m.collection === coll);
    if (channel) filtered = filtered.filter(m => `@${m.channel_username}` === channel);
    if (topic)   filtered = filtered.filter(m => (m.topics || '').split(',').map(t => t.trim()).includes(topic));
    if (search)  filtered = filtered.filter(m => (m.preview || '').toLowerCase().includes(search));

    const el = document.getElementById('mon-messages-content');
    if (!filtered.length) {
        el.innerHTML = `<p class="mon-empty">${_allMessages.length ? 'No messages match the filters.' : 'No messages in DB yet.'}</p>`;
        return;
    }

    // Group: collection → channel → [messages]
    const grouped = {};
    for (const msg of filtered) {
        const c  = msg.collection || '—';
        const ch = msg.channel_username ? `@${msg.channel_username}` : `id:${msg.channel_id}`;
        if (!grouped[c])     grouped[c]     = {};
        if (!grouped[c][ch]) grouped[c][ch] = [];
        grouped[c][ch].push(msg);
    }

    let html = Object.entries(grouped).map(([collName, channels]) => {
        const chHtml = Object.entries(channels).map(([chName, msgs]) => {
            const rowsHtml = msgs.map(m => {
                const ts = m.timestamp ? new Date(m.timestamp).toLocaleString() : '—';
                const topicTags = (m.topics || '').split(',').filter(Boolean)
                    .map(t => `<span class="mon-tag">${escapeHtml(t.trim())}</span>`).join('');
                const catTags = (m.categories || '').split(',').filter(Boolean)
                    .map(c => `<span class="mon-tag cat">${escapeHtml(c.trim())}</span>`).join('');
                const kwTags = (m.keywords_found || '').split(',').filter(Boolean).slice(0,5)
                    .map(k => `<span class="mon-tag">${escapeHtml(k.trim())}</span>`).join('');
                return `<tr>
                    <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                    <td>${topicTags || '<span style="color:var(--text-muted)">—</span>'}</td>
                    <td>${catTags  || '<span style="color:var(--text-muted)">—</span>'}</td>
                    <td>${kwTags   || '<span style="color:var(--text-muted)">—</span>'}</td>
                    <td class="mon-ellipsis" title="${escapeHtml(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
                </tr>`;
            }).join('');
            return `<div class="mon-ch-hdr">📢 ${escapeHtml(chName)}</div>
                <div style="overflow-x:auto;">
                <table class="mon-table">
                    <thead><tr><th>Time</th><th>Topics</th><th>Categories</th><th>Keywords</th><th>Preview</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table></div>`;
        }).join('');
        return `<div class="mon-coll-hdr">📦 ${escapeHtml(collName)}</div>${chHtml}`;
    }).join('');

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
let _unclMessages = [];
let _unclGrouped = false;

function toggleUnclGroupView() {
    _unclGrouped = !_unclGrouped;
    const btn = document.getElementById('uncl-group-btn');
    if (btn) {
        btn.classList.toggle('btn-primary', _unclGrouped);
        btn.classList.toggle('btn-secondary', !_unclGrouped);
    }
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
    'من','في','على','إلى','عن','مع','هذا','هذه','التي','الذي','ان','أن','لا','ما','هو','هي',
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

    if (!messages.length) {
        content.innerHTML = '<p class="mon-empty">No unclassified messages found.</p>';
        return;
    }

    if (_unclGrouped) {
        _renderUnclGroupedByWords(messages, content);
    } else {
        _renderUnclByChannel(messages, content);
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
                const botTag = m.bot_name ? `<span class="mon-tag cat">${escapeHtml(m.bot_name)}</span>` : '';
                return `<tr>
                    <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                    <td>${botTag}</td>
                    <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
                </tr>`;
            }).join('');
            return `<div class="mon-ch-hdr">📢 ${escapeHtml(chName)} <span class="text-muted">(${msgs.length})</span></div>
                <div style="overflow-x:auto;">
                <table class="mon-table">
                    <thead><tr><th style="width:140px;">Time</th><th style="width:100px;">Bot</th><th>Message Preview</th></tr></thead>
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
        if (!_unclMessages.length) content.innerHTML = '<p class="mon-empty">Loading…</p>';
    }
    const scrollY = window.scrollY;

    const bot  = document.getElementById('uncl-filter-bot')?.value  || '';
    const coll = document.getElementById('uncl-filter-coll')?.value || '';
    const search = document.getElementById('uncl-search')?.value?.trim() || '';

    let url = `/api/monitor/unclassified?limit=${_UNCL_PAGE_SIZE}&offset=${_unclOffset}`;
    if (bot)    url += `&bot=${encodeURIComponent(bot)}`;
    if (coll)   url += `&collection=${encodeURIComponent(coll)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    const data = await api(url);
    if (data.status !== 'ok') {
        if (!append) content.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message || 'Unknown error')}</p>`;
        return;
    }

    const newMsgs = data.messages || [];
    const stats = data.stats || [];
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