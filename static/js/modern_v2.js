// ==================== Bot Manager V2.1 - Complete Implementation ====================
// All 11 improvements included

// ==================== Global State ====================
let globalConfig = null;
let globalPrompts = null;
let globalAdminChannels = [];

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', async () => {
    initNavigation();
    await loadAllData();
    renderSystemPage();
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
    
    if (pageName === 'system') renderSystemPage();
    else if (pageName === 'collections') renderCollectionsPage();
    else if (pageName === 'bots') {
        renderBotsPage();
        restoreBotsPageScrollPosition();
    }
}

// ==================== Data Loading ====================
async function loadAllData() {
    try {
        globalConfig = await api('/api/config');
        globalPrompts = await api('/api/prompts');
        await loadAdminChannels();
        updateStats();
        updateSystemStatus();
    } catch (error) {
        console.error('Error loading data:', error);
        showNotification('Failed to load configuration', 'error');
    }
}

async function loadAdminChannels() {
    try {
        const result = await api('/api/telegram/admin_channels');
        if (result.status === 'ok') {
            globalAdminChannels = result.channels || [];
            console.log(`Loaded ${globalAdminChannels.length} accessible channels:`, globalAdminChannels);
            if (globalAdminChannels.length === 0) {
                console.warn('No channels found. Make sure:');
                console.warn('1. Bot is added to your channels (as member for source, admin for target)');
                console.warn('2. Bot has posted or received messages in those channels');
                console.warn('3. Use "Add Channel" button to manually verify channels');
            }
        } else {
            console.error('Failed to load channels:', result.message);
            globalAdminChannels = [];
        }
    } catch (error) {
        console.error('Error loading channels:', error);
        globalAdminChannels = [];
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
    const categoriesCount = Object.keys(bot.categories || {}).length;
    const topicsCount = getTotalTopicsInBot(bot);
    const collectionsCount = (bot.collections || []).length;

    return `
        <div class="bot-detail-card">
            <div class="bot-detail-header">
                <div class="flex-center">
                    <h4>🤖 ${name}</h4>
                    <span class="bot-status-badge ${bot.enabled ? 'active' : 'inactive'}">
                        ${bot.enabled ? '✓ Active' : '○ Inactive'}
                    </span>
                </div>
                <button class="btn btn-primary btn-sm" onclick="navigateToBotConfig('${name}')">
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
                    <span class="stat-value">${categoriesCount}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">Topics:</span>
                    <span class="stat-value">${topicsCount}</span>
                </div>
            </div>
        </div>
    `;
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
    const activeBots = Object.values(bots).filter(b => b.enabled).length;
    
    const el = (id, val) => {
        const elem = document.getElementById(id);
        if (elem) elem.textContent = val;
    };
    
    el('total-bots', totalBots);
    el('active-bots', activeBots);
    el('total-collections', Object.keys(collections).length);
    el('total-topics', getTotalTopics());
    el('bots-count', totalBots);
    el('collections-count', Object.keys(collections).length);
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

function showAddCollectionModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'collection-modal';

    // Build source channel options (all accessible channels - bot can read)
    const sourceChannelOptions = globalAdminChannels.map(ch => {
        const displayName = ch.username || ch.title || ch.id;
        const value = ch.username || ch.id;
        const badge = ch.can_post ? ' ✓ Can Post' : ' 📖 Read Only';
        return `<option value="${value}">${displayName} (${ch.id})${badge}</option>`;
    }).join('');

    // Build target channel options (only channels where bot can post)
    const targetChannels = globalAdminChannels.filter(ch => ch.can_post);
    const targetChannelOptions = targetChannels.map(ch => {
        const displayName = ch.username || ch.title || ch.id;
        const value = ch.username || ch.id;
        return `<option value="${value}">${displayName} (${ch.id})</option>`;
    }).join('');

    const channelInfo = globalAdminChannels.length === 0
        ? `<div class="alert alert-warning">
                <strong>⚠️ No accessible channels found</strong>
                <p>Make sure the bot is added to your channels.</p>
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button class="btn btn-sm btn-secondary" onclick="refreshAdminChannels()">🔄 Refresh</button>
                    <button class="btn btn-sm btn-secondary" onclick="closeModal('collection-modal'); verifyAndAddChannel();">➕ Add Channel</button>
                </div>
            </div>`
        : `<div class="alert alert-info">
                <p>📋 ${globalAdminChannels.length} accessible channel(s) | ${targetChannels.length} can post.
                <a href="#" onclick="verifyAndAddChannel(); return false;">Add more</a></p>
            </div>`;

    const noTargetWarning = targetChannels.length === 0
        ? `<div class="alert alert-warning" style="margin-top: 8px;">
                <strong>⚠️ No target channels available</strong>
                <p>Bot must be admin with "Post Messages" permission in target channels.</p>
            </div>`
        : '';

    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Add Collection</h3>
                <button class="btn-icon" onclick="closeModal('collection-modal')">×</button>
            </div>
            <div class="modal-body">
                ${channelInfo}
                <div class="form-group">
                    <label class="form-label">Collection Name</label>
                    <input type="text" class="input" id="collection-name" placeholder="e.g., news_sources">
                </div>
                <div class="form-group">
                    <label class="form-label">Display Name</label>
                    <input type="text" class="input" id="collection-display-name" placeholder="e.g., News Sources">
                </div>
                <div class="form-group">
                    <label class="form-label">Source Channels (Read Messages)</label>
                    ${globalAdminChannels.length > 0
                        ? `<select multiple class="input multi-select" id="collection-sources" size="5">
                            ${sourceChannelOptions}
                           </select>
                           <small class="form-hint">Hold Ctrl/Cmd to select multiple. Bot needs to be a member.</small>`
                        : `<input type="text" class="input" id="collection-sources-text" placeholder="@channel1, @channel2, or channel_username">
                           <small class="form-hint">Enter channel usernames separated by commas. Use "Add Channel" button to verify them first.</small>`
                    }
                </div>
                <div class="form-group">
                    <label class="form-label">Target Channels (Post Summaries)</label>
                    ${targetChannels.length > 0
                        ? `<select multiple class="input multi-select" id="collection-targets" size="5">
                            ${targetChannelOptions}
                           </select>
                           <small class="form-hint">Hold Ctrl/Cmd to select multiple. Bot must be admin with "Post Messages".</small>`
                        : `<input type="text" class="input" id="collection-targets-text" placeholder="@channel1, @channel2, or channel_username">
                           <small class="form-hint">Enter channel usernames separated by commas. Bot must be admin with post permission.</small>
                           <div class="alert alert-warning" style="margin-top: 8px;">
                               <p>⚠️ Use "Add Channel" button above to verify channels first!</p>
                           </div>`
                    }
                    ${noTargetWarning}
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeModal('collection-modal')">Cancel</button>
                <button class="btn btn-primary" onclick="saveCollection()">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
}

async function refreshAdminChannels() {
    showNotification('Refreshing channels...', 'info');
    await loadAdminChannels();
    const postableCount = globalAdminChannels.filter(ch => ch.can_post).length;
    showNotification(`Loaded ${globalAdminChannels.length} accessible channels (${postableCount} can post)`, 'success');

    // Re-render the current page to update channel dropdowns
    const activePage = document.querySelector('.page.active');
    if (activePage && activePage.id === 'collections-page') {
        renderCollectionsPage();
    } else if (activePage && activePage.id === 'bots-page') {
        renderBotsPage();
    }
}

async function verifyAndAddChannel() {
    const channelIdentifier = prompt('Enter channel username (e.g., @mychannel) or channel ID:');
    if (!channelIdentifier) return;

    showNotification('Verifying channel...', 'info');

    try {
        const result = await api('/api/telegram/verify_channel', {
            channel_identifier: channelIdentifier.trim()
        });

        if (result.status === 'ok') {
            // Add to global admin channels if not already there
            const existingChannel = globalAdminChannels.find(ch => ch.id === result.channel.id);
            if (!existingChannel) {
                globalAdminChannels.push(result.channel);
            }
            showNotification(`✓ Channel verified: ${result.channel.title}`, 'success');

            // Refresh the current view
            await refreshAdminChannels();
        } else {
            showNotification(`✗ ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error verifying channel:', error);
        showNotification('Failed to verify channel', 'error');
    }
}

async function saveCollection(existingName = null) {
    const collectionName = existingName || document.getElementById('collection-name').value.trim();
    const displayName = document.getElementById('collection-display-name').value.trim();

    let sources = [];
    let targets = [];

    // Check if using select elements or text inputs
    const sourcesSelect = document.getElementById('collection-sources');
    const targetsSelect = document.getElementById('collection-targets');
    const sourcesText = document.getElementById('collection-sources-text');
    const targetsText = document.getElementById('collection-targets-text');

    // Get sources (from select or text input)
    if (sourcesSelect) {
        sources = Array.from(sourcesSelect.selectedOptions).map(opt => opt.value);
    } else if (sourcesText) {
        const textValue = sourcesText.value.trim();
        if (textValue) {
            sources = textValue.split(',').map(s => s.trim()).filter(s => s);
        }
    }

    // Get targets (from select or text input)
    if (targetsSelect) {
        targets = Array.from(targetsSelect.selectedOptions).map(opt => opt.value);
    } else if (targetsText) {
        const textValue = targetsText.value.trim();
        if (textValue) {
            targets = textValue.split(',').map(s => s.trim()).filter(s => s);
        }
    }

    if (!collectionName || !targets.length) {
        alert('Collection name and at least one target channel are required');
        return;
    }

    // Remove duplicates
    sources = [...new Set(sources)];
    targets = [...new Set(targets)];

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
    const collection = globalConfig.collections[collectionName];
    if (!collection) return;

    showAddCollectionModal();

    setTimeout(() => {
        document.getElementById('collection-name').value = collectionName;
        document.getElementById('collection-name').disabled = true;
        document.getElementById('collection-display-name').value = collection.name || '';

        // Set selected sources
        const sourcesSelect = document.getElementById('collection-sources');
        const sourceChannels = collection.source_channels || [];
        for (let option of sourcesSelect.options) {
            option.selected = sourceChannels.includes(option.value);
        }

        // Set selected targets (support both old and new format)
        const targetsSelect = document.getElementById('collection-targets');
        const targets = collection.target_channels || (collection.target_channel ? [collection.target_channel] : []);
        for (let option of targetsSelect.options) {
            option.selected = targets.includes(option.value);
        }

        const saveBtn = document.querySelector('#collection-modal .btn-primary');
        saveBtn.onclick = () => saveCollection(collectionName);
    }, 100);
}

async function deleteCollection(collectionName) {
    if (!confirm(`Delete collection "${collectionName}"?`)) return;
    
    const result = await api('/api/collection/delete', { collection_name: collectionName });
    if (result.status === 'ok') {
        await loadAllData();
        renderCollectionsPage();
        showNotification('Collection deleted', 'success');
    } else {
        showNotification('Failed to delete collection', 'error');
    }
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
                    ${Object.entries(prompts).map(([key, value]) => `
                        <div class="form-group">
                            <div class="flex-between mb-1">
                                <input type="text" class="input" value="${key}"
                                       onchange="renamePrompt('${botName}', '${key}', this.value)"
                                       style="max-width: 200px;">
                                <button class="btn-icon btn-danger" onclick="deletePrompt('${botName}', '${key}')">🗑️</button>
                            </div>
                            <textarea class="textarea"
                                      id="prompt-${botName}-${key}"
                                      rows="3"
                                      onchange="updateBotPrompt('${botName}', '${key}', this.value)"
                                      placeholder="Enter prompt text...">${value || ''}</textarea>
                        </div>
                    `).join('')}

                    <button class="btn btn-secondary btn-sm mt-2" onclick="showAddPromptModal('${botName}')">
                        + Add Prompt
                    </button>
                </div>
            </div>
        </div>
    `;
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
                                    <button class="btn-icon btn-danger"
                                            onclick="deleteTopicSchedule('${botName}', '${categoryName}', '${topicName}', ${idx})">🗑️</button>
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
    if (type === 'interval') return `Every ${schedule.hours} hour(s)`;
    if (type === 'daily') return `Daily at ${String(schedule.hour || 0).padStart(2, '0')}:${String(schedule.minute || 0).padStart(2, '0')}`;
    return type;
}

// ==================== Bot Actions ====================
async function createNewBot() {
    const name = document.getElementById('new-bot-name').value.trim();
    if (!name) {
        alert('Please enter a bot name');
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
    if (!confirm(`Delete bot "${botName}"? This cannot be undone.`)) return;
    
    const result = await api('/api/bot/delete', { name: botName });
    if (result.status === 'ok') {
        await loadAllData();
        renderBotsPage();
        renderSystemPage();
        showNotification('Bot deleted', 'success');
    }
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

async function updateBotPrompt(botName, promptKey, value) {
    const result = await api('/api/prompts/update', { bot_name: botName, key: promptKey, text: value });
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
        alert('Please enter a prompt name');
        return;
    }

    // Check if prompt already exists for this bot
    const botPrompts = (globalPrompts && globalPrompts[botName]) || {};
    if (botPrompts[promptName]) {
        if (!confirm(`Prompt "${promptName}" already exists. Overwrite?`)) {
            return;
        }
    }

    const result = await api('/api/prompts/update', { bot_name: botName, key: promptName, text: promptText });
    if (result.status === 'ok') {
        await loadAllData();
        renderBotsPage();
        closeModal('add-prompt-modal');
        showNotification('Prompt added', 'success');
    }
}

async function deletePrompt(botName, promptKey) {
    if (!confirm(`Delete prompt "${promptKey}"?`)) return;

    const result = await api('/api/prompts/delete', { bot_name: botName, key: promptKey });
    if (result.status === 'ok') {
        await loadAllData();
        renderBotsPage();
        showNotification('Prompt deleted', 'success');
    }
}

async function renamePrompt(botName, oldKey, newKey) {
    newKey = newKey.trim();
    if (!newKey || oldKey === newKey) return;

    // Get bot prompts
    const botPrompts = (globalPrompts && globalPrompts[botName]) || {};

    // Check if new key already exists for this bot
    if (botPrompts[newKey]) {
        alert(`Prompt "${newKey}" already exists`);
        renderBotsPage(); // Reset the input
        return;
    }

    // Get the old prompt text
    const oldText = botPrompts[oldKey];
    if (!oldText) return;

    // Create new prompt with new key
    const addResult = await api('/api/prompts/update', { bot_name: botName, key: newKey, text: oldText });
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
        alert('Please enter a category name');
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
    if (!confirm(`Delete category "${categoryName}" and all its topics?`)) return;
    
    const result = await api('/api/category/delete', {
        bot_name: botName,
        category_name: categoryName
    });
    
    if (result.status === 'ok') {
        await loadAllData();
        renderBotsPage();
        showNotification('Category deleted', 'success');
    }
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
        alert('Please enter a topic name');
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
    if (!confirm(`Delete topic "${topicName}"?`)) return;
    
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
        alert('Please select a topic to link');
        return;
    }

    const bot = globalConfig.bots[botName];
    const topic = bot.categories[categoryName].topics[topicName];

    if (!topic.linked_topics) topic.linked_topics = [];

    // Extract just the topic name from the path (e.g., "middle_east/lebanon" -> "lebanon")
    const linkedTopicName = linkedTopicPath.split('/')[1];

    if (topic.linked_topics.includes(linkedTopicName)) {
        alert('This topic is already linked');
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
            <small class="text-muted">Run every 1-24 hours</small>
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
        alert('Please enter a schedule name');
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
        schedule.hours = Number(document.getElementById('topic-schedule-hours').value);
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
    if (!confirm('Delete this schedule?')) return;

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
`;
document.head.appendChild(style);