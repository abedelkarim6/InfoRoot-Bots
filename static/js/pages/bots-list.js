// ==================== Bots — List View & Bot CRUD ====================
(function () {
    let _currentBotDetail = null; // bot name shown in detail view

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
                    <button class="btn btn-secondary btn-xs" title="Duplicate bot"
                            onclick="duplicateBot('${jsAttr(name)}')">⧉</button>
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

    async function submitRenameBotInline(oldName) {
        const newName = document.getElementById(`bot-name-input-${oldName}`)?.value.trim();
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

    function duplicateBot(sourceName) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'duplicate-bot-modal';
        modal.innerHTML = `
            <div class="modal-dialog" style="max-width:480px">
                <div class="modal-header">
                    <h3>Duplicate Bot</h3>
                    <button class="btn-icon" onclick="closeModal('duplicate-bot-modal')">×</button>
                </div>
                <div class="modal-body">
                    <p class="text-muted" style="font-size:13px;margin-bottom:14px;">
                        Creates an independent copy of <strong>${escapeHtml(sourceName)}</strong>. The duplicate starts <strong>disabled</strong>. Choose what to include:
                    </p>
                    <div class="form-group" style="margin-bottom:14px;">
                        <label class="form-label">New Bot Name</label>
                        <input type="text" class="input" id="duplicate-bot-input"
                               value="Copy_of_${escapeHtml(sourceName)}" placeholder="Enter new bot name">
                    </div>
                    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:6px;">
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
                            <input type="checkbox" id="dup-opt-basic" checked>
                            <span><strong>Basic settings</strong> <span class="text-muted" style="font-size:12px;">(min messages, collections, default schedules)</span></span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
                            <input type="checkbox" id="dup-opt-rules" checked>
                            <span><strong>Rules</strong> <span class="text-muted" style="font-size:12px;">(remove / replace patterns)</span></span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
                            <input type="checkbox" id="dup-opt-prompts" checked>
                            <span><strong>Prompts</strong></span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
                            <input type="checkbox" id="dup-opt-cats" checked onchange="_dupToggleCatSubs(this.checked)">
                            <span><strong>Categories &amp; Topics</strong></span>
                        </label>
                        <div id="dup-cat-subs" style="margin-left:24px;display:flex;flex-direction:column;gap:6px;">
                            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                                <input type="checkbox" id="dup-opt-seos" checked>
                                <span>Include SEOs (keywords)</span>
                            </label>
                            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                                <input type="checkbox" id="dup-opt-schedules" checked>
                                <span>Include Schedules</span>
                            </label>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('duplicate-bot-modal')">Cancel</button>
                    <button class="btn btn-primary" id="duplicate-bot-submit-btn"
                            onclick="submitDuplicateBot('${jsAttr(sourceName)}')">⧉ Duplicate</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        const inp = document.getElementById('duplicate-bot-input');
        inp.focus();
        inp.select();
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitDuplicateBot(sourceName); });
    }

    function _dupToggleCatSubs(checked) {
        const subs = document.getElementById('dup-cat-subs');
        if (subs) subs.style.opacity = checked ? '1' : '0.4';
        ['dup-opt-seos', 'dup-opt-schedules'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = !checked;
        });
    }

    async function submitDuplicateBot(sourceName) {
        const newName = document.getElementById('duplicate-bot-input')?.value.trim();
        if (!newName) return;

        const btn = document.getElementById('duplicate-bot-submit-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Duplicating…'; }

        const includeCats = document.getElementById('dup-opt-cats')?.checked ?? true;
        const options = {
            include_basic:      document.getElementById('dup-opt-basic')?.checked ?? true,
            include_rules:      document.getElementById('dup-opt-rules')?.checked ?? true,
            include_prompts:    document.getElementById('dup-opt-prompts')?.checked ?? true,
            include_categories: includeCats,
            include_seos:       includeCats && (document.getElementById('dup-opt-seos')?.checked ?? true),
            include_schedules:  includeCats && (document.getElementById('dup-opt-schedules')?.checked ?? true),
        };

        const result = await api('/api/bot/duplicate', { source_name: sourceName, new_name: newName, options });

        if (result.status === 'ok') {
            closeModal('duplicate-bot-modal');
            await loadAllData();
            renderBotsPage();
            showNotification(`Bot duplicated as "${newName}"`, 'success');
        } else {
            if (btn) { btn.disabled = false; btn.textContent = '⧉ Duplicate'; }
            showNotification('Failed to duplicate: ' + (result.message || 'Unknown error'), 'error');
        }
    }


    function toggleCollapsible(id) {
        const section = document.getElementById(id);
        if (section) {
            section.classList.toggle('open');

            // Save state to localStorage
            const isOpen = section.classList.contains('open');
            saveCollapsibleState(id, isOpen);

            // Lazy-render content on first open — call only the renderer matching this section type
            if (isOpen) {
                if (section.classList.contains('category-box')) {
                    _renderLazyCategoryContent(section);
                } else if (section.classList.contains('topic-box')) {
                    _renderLazyTopicContent(section);
                }
            }
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


    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window._setBotDetail               = function (name) { _currentBotDetail = name; };
    window._resetBotDetail             = function () { _currentBotDetail = null; };
    window.renderBotsPage              = renderBotsPage;
    window._renderBotsListView         = _renderBotsListView;
    window._createBotListCard          = _createBotListCard;
    window.openBotDetail               = openBotDetail;
    window._showBotsListView           = _showBotsListView;
    window.createNewBot                = createNewBot;
    window.toggleBotEnabled            = toggleBotEnabled;
    window.renameBot                   = renameBot;
    window.submitRenameBot             = submitRenameBot;
    window.submitRenameBotInline       = submitRenameBotInline;
    window.deleteBot                   = deleteBot;
    window.duplicateBot                = duplicateBot;
    window._dupToggleCatSubs           = _dupToggleCatSubs;
    window.submitDuplicateBot          = submitDuplicateBot;
    window.toggleCollapsible           = toggleCollapsible;
    window.saveCollapsibleState        = saveCollapsibleState;
    window.loadCollapsibleState        = loadCollapsibleState;
    window.restoreCollapsibleStates    = restoreCollapsibleStates;
    window.clearStaleCollapsibleStates = clearStaleCollapsibleStates;
    window.saveBotsPageScrollPosition    = saveBotsPageScrollPosition;
    window.restoreBotsPageScrollPosition = restoreBotsPageScrollPosition;
    window.closeModal                  = closeModal;
})();
