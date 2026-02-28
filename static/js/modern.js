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

// ==================== Global State ====================
let globalConfig = null;
let globalPrompts = null;

// Collection modal state
let modalSources = [];
let modalTargets = [];
let _channelValidation = {}; // { '@channel': 'ok'|'warn'|'pending' }

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', async () => {
    _applyThemeButton(document.documentElement.getAttribute('data-theme') || 'dark');
    initNavigation();
    await loadAllData();
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
        return await response.json();
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
        renderBotsPage();
        restoreBotsPageScrollPosition();
    }
    else if (pageName === 'monitor') loadMonitorData();
    else if (pageName === 'dashboard') loadDashboardData();
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
    const enabled = globalConfig?.system?.enabled !== false;
    const statusEl = document.getElementById('system-status');
    const textEl = document.getElementById('status-text');
    const toggleEl = document.getElementById('system-toggle');
    const statusTextEl = document.getElementById('system-status-text');
    
    if (statusEl) {
        statusEl.className = 'status-indicator';
        if (!enabled) statusEl.classList.add('offline');
    }
    
    if (textEl) {
        textEl.textContent = enabled ? 'System Online' : 'System Offline';
    }
    
    if (toggleEl) {
        toggleEl.checked = enabled;
    }
    
    if (statusTextEl) {
        statusTextEl.textContent = enabled ? 
            '✅ System is online. All bots and collections are operational.' : 
            '⛔ System is offline. All bot operations are suspended.';
    }
}

function renderSystemPage() {
    const container = document.getElementById('system-bots-list');
    if (!container) return;
    
    const bots = globalConfig.bots || {};
    
    if (Object.keys(bots).length === 0) {
        container.innerHTML = `
            <div class="create-bot-card">
                <h3>No bots configured yet</h3>
                <p class="text-muted">Create your first bot to get started</p>
                <button class="btn btn-primary mt-2" onclick="showPage('bots')">
                    <span>➕</span> Create First Bot
                </button>
            </div>
        `;
        return;
    }
    
    container.innerHTML = Object.entries(bots)
        .map(([name, bot]) => createBotDetailCard(name, bot))
        .join('');
    
    updateStats();
    updateSystemStatus();
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
function renderBotsPage(keepOpen = null) {
    saveBotsPageScrollPosition(); // Save before re-render

    const container = document.getElementById('bots-container');
    const bots = globalConfig.bots || {};

    container.innerHTML = '';

    for (const [name, bot] of Object.entries(bots)) {
        const card = createBotConfigCard(name, bot);
        container.appendChild(card);
    }

    // Restore collapsible states and scroll after rendering
    setTimeout(() => {
        restoreCollapsibleStates();
        clearStaleCollapsibleStates();
        restoreBotsPageScrollPosition();

        // Keep specific sections open if requested
        if (keepOpen) {
            if (Array.isArray(keepOpen)) {
                keepOpen.forEach(id => {
                    const element = document.getElementById(id);
                    if (element) element.classList.add('open');
                });
            } else {
                const element = document.getElementById(keepOpen);
                if (element) element.classList.add('open');
            }
        }
    }, 50); // Reduced timeout for faster UI response
}

function createBotConfigCard(name, bot) {
    const card = document.createElement('div');
    card.className = 'bot-config-card';
    card.id = `bot-${name}`;
    
    card.innerHTML = `
        <div class="bot-config-header">
            <div class="bot-config-title">
                <h3>🤖 ${name}</h3>
                <label class="toggle-switch">
                    <input type="checkbox" ${bot.enabled ? 'checked' : ''} 
                           onchange="toggleBotEnabled('${name}', this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="bot-config-actions">
                <button class="btn btn-secondary btn-sm" onclick="renameBot('${name}')">
                    ✏️ Rename
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteBot('${name}')">
                    🗑️ Delete
                </button>
            </div>
        </div>
        <div class="bot-config-body">
            ${createBasicSettingsSection(name, bot)}
            ${createRulesSection(name, bot)}
            ${createPromptsSection(name)}
            ${createCategoriesSection(name, bot)}
        </div>
    `;
    
    return card;
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
                        const promptText   = (value && typeof value === 'object') ? (value.text   || '') : (value || '');
                        const promptHeader = (value && typeof value === 'object') ? (value.header || '') : '';
                        return `
                        <div class="form-group">
                            <div class="flex-between mb-1">
                                <input type="text" class="input" value="${key}"
                                       onchange="renamePrompt('${botName}', '${key}', this.value)"
                                       style="max-width: 200px;">
                                <button class="btn-icon btn-danger" onclick="deletePrompt('${botName}', '${key}')">🗑️</button>
                            </div>
                            <label class="form-label" style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Header <span style="font-weight:400;">(text shown above the summary in Telegram)</span></label>
                            <input type="text" class="input mb-1"
                                   id="prompt-header-${botName}-${key}"
                                   value="${escapeHtml(promptHeader)}"
                                   onchange="updateBotPrompt('${botName}', '${key}')"
                                   placeholder="e.g. 📰 ملخص الأخبار  (leave empty to auto-generate)">
                            <label class="form-label" style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Prompt</label>
                            <textarea class="textarea"
                                      id="prompt-${botName}-${key}"
                                      rows="3"
                                      onchange="updateBotPrompt('${botName}', '${key}')"
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
                               onkeydown="if(event.key==='Enter'){event.preventDefault(); addCategory('${botName}'); return false;}"
                               style="display:inline-block; width:auto; margin-right:8px;">
                        <button class="btn btn-secondary btn-sm" onclick="addCategory('${botName}')">
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

    return `
        <div class="category-box collapsible-section ${defaultOpen ? 'open' : ''}" id="${sectionId}">
            <div class="category-header-row" onclick="toggleCollapsible('${sectionId}')">
                <div class="category-title-group">
                    <h4>🗂️ ${categoryName}</h4>
                    <span class="text-muted" style="margin-left: 8px;">(${topicCount} topic${topicCount !== 1 ? 's' : ''})</span>
                </div>
                <div class="category-controls" onclick="event.stopPropagation()">
                    <button class="btn btn-secondary btn-sm"
                            onclick="document.getElementById('new-topic-${botName}-${categoryName}').focus()">
                        + Add Topic
                    </button>
                    <label class="toggle-switch">
                        <input type="checkbox" ${category.enabled ? 'checked' : ''}
                               onchange="toggleCategory('${botName}', '${categoryName}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <button class="btn-icon btn-danger"
                            onclick="deleteCategory('${botName}', '${categoryName}')">🗑️</button>
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
                               onkeydown="if(event.key==='Enter'){event.preventDefault(); event.stopPropagation(); addTopic('${botName}', '${categoryName}'); return false;}"
                               style="display:inline-block; width:auto; margin-right:8px;">
                        <button class="btn btn-secondary btn-sm" onclick="addTopic('${botName}', '${categoryName}')">
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

    return `
        <div class="topic-box collapsible-section ${defaultOpen ? 'open' : ''} ${isDisabledByCategory ? 'category-disabled' : ''}" id="${sectionId}">
            <div class="topic-header-row" onclick="toggleCollapsible('${sectionId}')">
                <div class="topic-title-group">
                    <strong>📌 ${topicName}</strong>
                    ${isDisabledByCategory ? '<span class="disabled-badge">Category Disabled</span>' : ''}
                    ${linkedTopics.length > 0 ? `<span class="linked-badge">🔗 ${linkedTopics.length} linked</span>` : ''}
                    <span class="schedule-indicator">🕐 ${schedules.length} schedule${schedules.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="topic-controls" onclick="event.stopPropagation()">
                    <label class="toggle-switch">
                        <input type="checkbox" ${topic.enabled ? 'checked' : ''}
                               onchange="toggleTopic('${botName}', '${categoryName}', '${topicName}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <button class="btn-icon btn-danger"
                            onclick="deleteTopic('${botName}', '${categoryName}', '${topicName}')">🗑️</button>
                    <span class="collapsible-toggle">▼</span>
                </div>
            </div>
            
            <div class="collapsible-content">
                <div class="topic-body">
                    <div class="form-group">
                        <label class="form-label">Keywords</label>
                        <div class="tags-container">
                            ${keywords.map((kw, idx) => `
                                <span class="tag">
                                    ${kw}
                                    <span class="tag-remove" 
                                          onclick="removeKeyword('${botName}', '${categoryName}', '${topicName}', ${idx})">×</span>
                                </span>
                            `).join('')}
                            <input type="text" class="tag-input" placeholder="+ Add keywords (comma-separated)"
                                   onkeydown="return handleKeywordInput(event, '${botName}', '${categoryName}', '${topicName}')">
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label class="form-label">Schedules</label>
                        ${schedules.map((schedule, idx) => `
                            <div class="summary-block">
                                <div class="summary-header">
                                    <div class="summary-title">
                                        <label class="toggle-switch">
                                            <input type="checkbox" ${schedule.enabled ? 'checked' : ''}
                                                   onchange="toggleTopicSchedule('${botName}', '${categoryName}', '${topicName}', ${idx}, this.checked)">
                                            <span class="toggle-slider"></span>
                                        </label>
                                        <strong>${schedule.name}</strong>
                                    </div>
                                    <div class="sch-menu-wrap">
                                        <button class="sch-menu-btn" onclick="toggleSchMenu(event, this)" title="Options">⋮</button>
                                        <div class="sch-menu-dropdown">
                                            <button onclick="closeAllSchMenus(); openEditTopicScheduleModal('${botName}', '${categoryName}', '${topicName}', ${idx})">✏️ Edit</button>
                                            <button class="danger" onclick="closeAllSchMenus(); deleteTopicSchedule('${botName}', '${categoryName}', '${topicName}', ${idx})">🗑️ Delete</button>
                                        </div>
                                    </div>
                                </div>
                                <div class="summary-details">
                                    <span>📅 ${formatSchedule(schedule)}</span>
                                    <span>📝 ${schedule.prompt_key}</span>
                                </div>
                            </div>
                        `).join('')}
                        <button class="btn btn-secondary btn-sm mt-2"
                                onclick="openAddTopicScheduleModal('${botName}', '${categoryName}', '${topicName}')">
                            + Add Schedule
                        </button>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Linked Topics (inherit keywords)</label>
                        <div class="tags-container">
                            ${linkedTopics.map((linkedTopic, idx) => `
                                <span class="tag">
                                    🔗 ${linkedTopic}
                                    <span class="tag-remove" onclick="removeLinkedTopic('${botName}', '${categoryName}', '${topicName}', ${idx})">×</span>
                                </span>
                            `).join('')}
                        </div>
                        <button class="btn btn-secondary btn-sm mt-1"
                                onclick="showLinkTopicModal('${botName}', '${categoryName}', '${topicName}')">
                            + Link Existing Topic
                        </button>
                        <small class="text-muted d-block mt-1">Link to other topics to inherit their keywords</small>
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

async function renameBot(oldName) {
    const newName = prompt(`Rename "${oldName}" to:`, oldName);
    if (!newName || newName === oldName) return;
    
    const result = await api('/api/bot/rename', { old_name: oldName, new_name: newName });
    if (result.status === 'ok') {
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
    const text   = document.getElementById(`prompt-${botName}-${promptKey}`)?.value || '';
    const header = document.getElementById(`prompt-header-${botName}-${promptKey}`)?.value || '';
    const result = await api('/api/prompts/update', { bot_name: botName, key: promptKey, text, header });
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
                    <label class="form-label">Header <span style="font-weight:400;color:var(--text-muted)">(text shown above the summary in Telegram)</span></label>
                    <input type="text" class="input" id="new-prompt-header" placeholder="e.g. 📰 ملخص الأخبار  (leave empty to auto-generate)">
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
    const promptName   = document.getElementById('new-prompt-name').value.trim();
    const promptHeader = document.getElementById('new-prompt-header').value.trim();
    const promptText   = document.getElementById('new-prompt-text').value.trim();

    if (!promptName) {
        showAlert('Please enter a prompt name', { icon: '✏️' });
        return;
    }

    const doSave = async () => {
        const result = await api('/api/prompts/update', { bot_name: botName, key: promptName, text: promptText, header: promptHeader });
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
    const oldVal    = botPrompts[oldKey];
    if (!oldVal) return;
    const oldText   = (oldVal && typeof oldVal === 'object') ? (oldVal.text   || '') : (oldVal || '');
    const oldHeader = (oldVal && typeof oldVal === 'object') ? (oldVal.header || '') : '';

    // Create new prompt with new key
    const addResult = await api('/api/prompts/update', { bot_name: botName, key: newKey, text: oldText, header: oldHeader });
    if (addResult.status === 'ok') {
        // Delete old prompt
        await api('/api/prompts/delete', { bot_name: botName, key: oldKey });
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
    keywordsToAdd.forEach(kw => {
        if (!topic.keywords.includes(kw)) {
            topic.keywords.push(kw);
            addedCount++;
        }
    });

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
    
    const schedule = {
        name,
        type,
        prompt_key,
        enabled: true
    };
    
    if (type === 'minute') {
        schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
    } else if (type === 'hourly') {
        schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
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

async function toggleTopicSchedule(botName, categoryName, topicName, scheduleIndex, enabled) {
    const topic = globalConfig.bots[botName].categories[categoryName].topics[topicName];
    if (topic.schedules && topic.schedules[scheduleIndex]) {
        topic.schedules[scheduleIndex].enabled = enabled;

        const result = await api('/api/topic/schedule/update', {
            bot_name: botName,
            category_name: categoryName,
            topic_name: topicName,
            schedule_index: scheduleIndex,
            schedule: topic.schedules[scheduleIndex]
        });

        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${botName}-${categoryName}-${topicName}`;
            const categoryId = `categories-${botName}`;
            renderBotsPage([topicId, categoryId]);
            showNotification('Schedule updated', 'success');
        }
    }
}

async function deleteTopicSchedule(botName, categoryName, topicName, scheduleIndex) {
    showConfirm('Delete this schedule?', async () => {
        const result = await api('/api/topic/schedule/delete', {
            bot_name: botName,
            category_name: categoryName,
            topic_name: topicName,
            schedule_index: scheduleIndex
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
function openEditTopicScheduleModal(botName, categoryName, topicName, scheduleIndex) {
    const schedule = globalConfig.bots[botName]?.categories[categoryName]?.topics[topicName]?.schedules[scheduleIndex];
    if (!schedule) return;

    const botPrompts = (globalPrompts && globalPrompts[botName]) || {};
    const existingModal = document.getElementById('topic-schedule-edit-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'topic-schedule-edit-modal';

    const typeOptions = ['minute', 'hourly', 'interval', 'daily'];
    const typeLabels  = { minute: 'Every Minute', hourly: 'Hourly', interval: 'Every X Hours', daily: 'Daily' };

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
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('topic-schedule-edit-modal')">Cancel</button>
                <button class="btn btn-primary"
                        onclick="saveEditedSchedule('${botName}', '${categoryName}', '${topicName}', ${scheduleIndex})">Save Changes</button>
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

async function saveEditedSchedule(botName, categoryName, topicName, scheduleIndex) {
    const name = document.getElementById('edit-sch-name').value.trim();
    const type = document.getElementById('edit-sch-type').value;
    const prompt_key = document.getElementById('edit-sch-prompt').value;

    if (!name) {
        showAlert('Please enter a schedule name', { icon: '✏️' });
        return;
    }

    const original = globalConfig.bots[botName]?.categories[categoryName]?.topics[topicName]?.schedules[scheduleIndex];
    const schedule = { name, type, prompt_key, enabled: original ? original.enabled : true };

    if (type === 'minute') {
        schedule.minute = Number(document.getElementById('edit-sch-minute').value);
    } else if (type === 'hourly') {
        schedule.minute = Number(document.getElementById('edit-sch-minute').value);
    } else if (type === 'interval') {
        schedule.hours        = Number(document.getElementById('edit-sch-hours').value);
        schedule.start_hour   = Number(document.getElementById('edit-sch-start-hour').value);
        schedule.start_minute = Number(document.getElementById('edit-sch-start-minute').value);
    } else if (type === 'daily') {
        schedule.hour   = Number(document.getElementById('edit-sch-hour').value);
        schedule.minute = Number(document.getElementById('edit-sch-minute').value);
    }

    const result = await api('/api/topic/schedule/update', {
        bot_name: botName,
        category_name: categoryName,
        topic_name: topicName,
        schedule_index: scheduleIndex,
        schedule
    });

    if (result.status === 'ok') {
        await loadAllData();
        const topicId    = `topic-${botName}-${categoryName}-${topicName}`;
        const categoryId = `categories-${botName}`;
        renderBotsPage([topicId, categoryId]);
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
    .mon-bot-hdr { display:flex; align-items:center; gap:10px; padding:13px 18px; background:var(--bg-secondary); border-bottom:1px solid var(--border-color); font-weight:700; font-size:14px; }
    .mon-bot-dot-on  { font-size:10px; color:var(--success); }
    .mon-bot-dot-off { font-size:10px; color:var(--danger); }

    /* category */
    .mon-cat-hdr { padding:6px 18px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); background:var(--bg-primary); border-bottom:1px solid var(--border-color); }

    /* topic block */
    .mon-topic-block { border-bottom:1px solid var(--border-color); }
    .mon-topic-block:last-child { border-bottom:none; }
    .mon-topic-title { display:flex; align-items:center; gap:8px; padding:9px 18px 4px; font-weight:600; font-size:13px; color:var(--text-primary); text-transform:capitalize; }
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
    .mon-filter-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px 0 14px; border-bottom:1px solid var(--border-color); margin-bottom:14px; }
    .mon-filter-sel { min-width:130px; max-width:180px; height:32px; font-size:12px; padding:0 8px; }
    .mon-filter-search { flex:1; min-width:160px; max-width:320px; height:32px; font-size:12px; padding:0 10px; }
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
    const container = document.getElementById('monitor-bots-container');
    container.innerHTML = '<p class="mon-empty">Loading…</p>';
    const data = await api('/api/monitor/data');
    if (data.status !== 'ok') {
        container.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message)}</p>`;
        return;
    }
    _monitorData = data;
    renderMonitorBots(data.bots || {});
    renderMonSummaries(data.recent_summaries || []);
    if (_monActiveTab === 'messages') loadMonitorMessages();
    else if (_monActiveTab === 'summaries') applyMonSummaryFilters();
    startMonitorCountdowns();
}

function switchMonTab(tab) {
    _monActiveTab = tab;
    document.querySelectorAll('.mon-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === tab)
    );
    document.getElementById('mon-tab-schedules').style.display = tab === 'schedules' ? '' : 'none';
    document.getElementById('mon-tab-summaries').style.display = tab === 'summaries' ? '' : 'none';
    document.getElementById('mon-tab-messages').style.display  = tab === 'messages'  ? '' : 'none';
    if (tab === 'messages') loadMonitorMessages();
}

// ---------- Topics & Schedules ----------
function renderMonitorBots(bots) {
    const container = document.getElementById('monitor-bots-container');
    if (!Object.keys(bots).length) {
        container.innerHTML = '<p class="mon-empty">No bots configured.</p>';
        return;
    }

    container.innerHTML = Object.entries(bots).map(([botName, botData]) => {
        const dotCls = botData.enabled ? 'mon-bot-dot-on' : 'mon-bot-dot-off';
        const dotTxt = botData.enabled ? '● ACTIVE' : '● OFF';

        const categoriesHtml = Object.entries(botData.categories || {}).map(([catName, catData]) => {
            const topicsHtml = Object.entries(catData.topics || {}).map(([topicName, topicData]) => {
                const p = topicData.pending || {};
                const offCls = topicData.enabled === false ? ' mon-topic-off' : '';

                const schRows = (topicData.schedules || []).map(sch => {
                    const pending = p[sch.type] || 0;
                    const pendingCls = pending > 0 ? 'has' : 'none';
                    const pendingTxt = pending > 0 ? `${pending} pending` : 'none';
                    const disabledCls = sch.enabled === false ? ' mon-sch-disabled' : '';
                    const icon = scheduleIcon(sch);
                    const spec = scheduleSpec(sch);
                    const schJson = escapeHtml(JSON.stringify(sch));
                    return `<div class="mon-sch-row${disabledCls}" data-schedule="${schJson}">
                        <div class="mon-sch-left">
                            <span class="mon-sch-icon">${icon}</span>
                            <span class="mon-sch-name">${escapeHtml(sch.name || sch.type)}</span>
                            <span class="mon-sch-prompt">${escapeHtml(sch.prompt_key || '')}</span>
                            <span class="mon-sch-spec">${spec}</span>
                        </div>
                        <div class="mon-sch-right">
                            <span class="mon-pending ${pendingCls}">${pendingTxt}</span>
                            <span class="mon-next-label">next in</span>
                            <span class="mon-countdown">${sch.enabled === false ? '—' : '…'}</span>
                        </div>
                    </div>`;
                }).join('');

                return `<div class="mon-topic-block">
                    <div class="mon-topic-title${offCls}">
                        ${escapeHtml(topicName)}
                        ${topicData.enabled === false ? '<span style="font-size:10px;color:var(--danger);">OFF</span>' : ''}
                    </div>
                    ${schRows}
                </div>`;
            }).join('');

            return `<div class="mon-cat-hdr">${escapeHtml(catName)}</div>${topicsHtml}`;
        }).join('');

        return `<div class="mon-bot-card">
            <div class="mon-bot-hdr">🤖 ${escapeHtml(botName)} <span class="${dotCls}">${dotTxt}</span></div>
            ${categoriesHtml}
        </div>`;
    }).join('');
}

function scheduleIcon(sch) {
    if (sch.type === 'hourly')   return '🕐';
    if (sch.type === 'daily')    return '📅';
    if (sch.type === 'minute')   return '⚡';
    if (sch.type === 'interval') return '🔁';
    return '🔔';
}

function scheduleSpec(sch) {
    if (sch.type === 'hourly')   return `every hour at :${String(sch.minute ?? 0).padStart(2,'0')}`;
    if (sch.type === 'daily')    return `daily at ${String(sch.hour ?? 0).padStart(2,'0')}:${String(sch.minute ?? 0).padStart(2,'0')}`;
    if (sch.type === 'minute')   return `every ${sch.minute ?? 1} min`;
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

function tickCountdowns() {
    document.querySelectorAll('[data-schedule]').forEach(row => {
        const cdEl = row.querySelector('.mon-countdown');
        if (!cdEl) return;
        let sch;
        try { sch = JSON.parse(row.dataset.schedule); } catch { return; }
        if (sch.enabled === false) { cdEl.textContent = '—'; return; }
        const next = computeNextRun(sch);
        if (!next) { cdEl.textContent = '—'; return; }
        const diff = Math.max(0, next - Date.now());
        cdEl.textContent = formatDuration(diff);
        cdEl.classList.toggle('urgent', diff < 60000);
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
        return `<tr>
            <td style="white-space:nowrap;">${ts}</td>
            <td>${escapeHtml(s.bot_name || '—')}</td>
            <td>${escapeHtml(s.topic_name || '—')}</td>
            <td><span class="mon-type-badge ${typeCls}">${escapeHtml(s.summary_type || '—')}</span></td>
            <td style="text-align:center;">${s.message_count ?? '—'}</td>
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

// ---------- Received Messages ----------
async function loadMonitorMessages() {
    const el = document.getElementById('mon-messages-content');
    el.innerHTML = '<p class="mon-empty">Loading…</p>';
    const data = await api('/api/monitor/messages');
    if (data.status !== 'ok') {
        el.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message)}</p>`;
        return;
    }
    renderMonMessages(data.messages || []);
}

function renderMonMessages(messages) {
    _allMessages = messages;
    // Populate dynamic dropdowns
    const colls    = [...new Set(messages.map(m => m.collection).filter(Boolean))].sort();
    const channels = [...new Set(messages.map(m => m.channel_username ? `@${m.channel_username}` : null).filter(Boolean))].sort();
    const topics   = [...new Set(messages.flatMap(m => (m.topics || '').split(',').map(t => t.trim())).filter(Boolean))].sort();
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

    el.innerHTML = Object.entries(grouped).map(([collName, channels]) => {
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

// ---------- Collapsible sections ----------
function toggleMonSec(bodyId, iconId) {
    const body = document.getElementById(bodyId);
    const icon = document.getElementById(iconId);
    if (!body) return;
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? '' : 'none';
    if (icon) icon.textContent = isHidden ? '▼' : '▶';
}

// ---------- Auto-refresh ----------
function toggleMonitorAutoRefresh(enabled) {
    if (_monitorRefreshInterval) { clearInterval(_monitorRefreshInterval); _monitorRefreshInterval = null; }
    if (enabled) _monitorRefreshInterval = setInterval(loadMonitorData, 15000);
}

document.addEventListener('DOMContentLoaded', () => {
    toggleMonitorAutoRefresh(true);
});

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.head.appendChild(style);