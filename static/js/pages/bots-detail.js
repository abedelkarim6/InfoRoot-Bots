// ==================== Bots — Detail View, Settings, Rules & Prompts ====================
(function () {
    function _renderBotDetailView(name, bot, keepOpen = null) {
        if (typeof _setBotDetail === 'function') _setBotDetail(name);
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
                    if (el) {
                        el.classList.add('open');
                        if (el.classList.contains('category-box')) {
                            _renderLazyCategoryContent(el);
                        } else if (el.classList.contains('topic-box')) {
                            _renderLazyTopicContent(el);
                        }
                    }
                });
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
                            <label class="form-label">Bot Name</label>
                            <div style="display:flex;gap:8px;align-items:center;">
                                <input type="text" class="input" id="bot-name-input-${botName}" value="${escapeHtml(botName)}" style="flex:1;">
                                <button class="btn btn-secondary btn-sm" onclick="submitRenameBotInline('${jsAttr(botName)}')">✏️ Rename</button>
                            </div>
                            <small class="text-muted">Renaming preserves all settings, categories, topics and schedules.</small>
                        </div>
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
                <p class="text-muted" style="margin:0 0 4px;font-size:11px">Injected before every user prompt. Supports: {topic_name}, {messages}, {final_interim}, {b}.</p>
                <textarea class="textarea"
                          id="fixed-prefix-${botName}"
                          rows="5"
                          style="font-family:monospace;font-size:12px"
                          placeholder="Loading…"></textarea>
            </div>
            <div class="prompt-card prompt-card-fixed" id="fixed-bp-suffix-card-${botName}">
                <div class="prompt-card-header">
                    <h4 class="prompt-card-title">🔒 Bullet Points Suffix <span class="admin-badge">Admin</span></h4>
                    <div class="prompt-card-actions">
                        <button class="btn btn-secondary btn-sm" onclick="resetSummariesFixedPrompt('bullet_points_suffix', 'fixed-bp-suffix-${botName}')" title="Reset to default">Reset</button>
                        <button class="btn btn-primary btn-sm" onclick="saveSummariesFixedPrompt('bullet_points_suffix', 'fixed-bp-suffix-${botName}')">Save</button>
                    </div>
                </div>
                <p class="text-muted" style="margin:0 0 4px;font-size:11px">Appended after the user prompt when a schedule has Bullet Points enabled. Use {b} for the count.</p>
                <textarea class="textarea"
                          id="fixed-bp-suffix-${botName}"
                          rows="3"
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

    let _summariesFixedDefaults = { system_prompt: '', fixed_prefix: '', bullet_points_suffix: '' };
    let _summariesFixedLoaded = false;

    async function loadSummariesFixedPrompts() {
        if (_summariesFixedLoaded) return;
        const res = await api('/api/system/fixed-prefix');
        if (res.status !== 'ok') return;
        _summariesFixedDefaults.system_prompt       = res.default_system_prompt       || '';
        _summariesFixedDefaults.fixed_prefix        = res.default_fixed_prefix        || '';
        _summariesFixedDefaults.bullet_points_suffix = res.default_bullet_points_suffix || '';
        _summariesFixedLoaded = true;
        // Populate all visible fixed prompt textareas
        document.querySelectorAll('[id^="fixed-sysprompt-"]').forEach(el => {
            if (!el.value) el.value = res.system_prompt || res.default_system_prompt || '';
        });
        document.querySelectorAll('[id^="fixed-prefix-"]').forEach(el => {
            if (!el.value) el.value = res.fixed_prefix || res.default_fixed_prefix || '';
        });
        document.querySelectorAll('[id^="fixed-bp-suffix-"]').forEach(el => {
            if (!el.value) el.value = res.bullet_points_suffix || res.default_bullet_points_suffix || '';
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
            await loadAllData();
            renderBotsPage();
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


    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window._renderBotDetailView       = _renderBotDetailView;
    window.createBotConfigCard        = createBotConfigCard;
    window.switchBotTab               = switchBotTab;
    window.createBasicSettingsSection = createBasicSettingsSection;
    window.createPromptsSection       = createPromptsSection;
    window.loadSummariesFixedPrompts  = loadSummariesFixedPrompts;
    window.saveSummariesFixedPrompt   = saveSummariesFixedPrompt;
    window.resetSummariesFixedPrompt  = resetSummariesFixedPrompt;
    window.createRulesSection         = createRulesSection;
    window.addRemoveRule              = addRemoveRule;
    window.addReplaceRule             = addReplaceRule;
    window.deleteRuleRow              = deleteRuleRow;
    window.saveBotRules               = saveBotRules;
    window.updateBotSetting           = updateBotSetting;
    window.updateBotPrompt            = updateBotPrompt;
    window.showAddPromptModal         = showAddPromptModal;
    window.saveNewPrompt              = saveNewPrompt;
    window.deletePrompt               = deletePrompt;
    window.renamePromptDialog         = renamePromptDialog;
    window.renamePrompt               = renamePrompt;
    window.addCollectionToBot         = addCollectionToBot;
    window.removeCollectionFromBot    = removeCollectionFromBot;
})();
