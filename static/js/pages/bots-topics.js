// ==================== Bots — Categories, Topics & Keywords ====================
(function () {
    // keyed by 'botName|catName|topicName' -> string[]
    const _userAddedKeywords = {};

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
            : `<div class="topics-container category-lazy-body" data-lazy-bot="${b}" data-lazy-cat="${c}"></div>`;

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
        const placeholder = section.querySelector('.category-lazy-body');
        if (!placeholder) return;
        const botName = placeholder.getAttribute('data-lazy-bot');
        const catName = placeholder.getAttribute('data-lazy-cat');
        placeholder.removeAttribute('data-lazy-bot');
        placeholder.removeAttribute('data-lazy-cat');
        placeholder.classList.remove('category-lazy-body');
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

    function _buildTopicBodyHtml(botName, categoryName, topicName, topic, categoryEnabled = true) {
        const keywords = topic.keywords || [];
        const seoHidden = topic._keyword_count != null;
        const _ukKey    = `${botName}|${categoryName}|${topicName}`;
        const userKws   = seoHidden ? (_userAddedKeywords[_ukKey] || []) : [];
        const seoCount  = seoHidden ? topic._keyword_count : keywords.length;
        const schedules = topic.schedules || [];
        const linkedTopics = topic.linked_topics || [];
        const catchAll = !!topic.catch_all;
        const b = jsAttr(botName), c = jsAttr(categoryName), t = jsAttr(topicName);

        return `<div class="collapsible-inner">
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
                                <div style="display:flex;gap:6px;align-items:center;">
                                    ${!seoHidden && keywords.length > 0 ? `
                                    <button class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 8px;" onclick="kwToggleSelectAll('${b}','${c}','${t}')">Select All</button>
                                    <button class="btn btn-danger btn-sm kw-del-sel-btn" style="font-size:10px;padding:2px 8px;display:none;" data-topic="${b}|${c}|${t}" onclick="kwDeleteSelected('${b}','${c}','${t}')">Delete Selected</button>
                                    <button class="btn btn-danger btn-sm" style="font-size:10px;padding:2px 8px;" onclick="kwDeleteAll('${b}','${c}','${t}')">Delete All</button>
                                    ` : ''}
                                    <button class="btn-ai-suggest" onclick="suggestSEOs('${b}','${c}','${t}')"><span class="btn-ai-shine"></span>✨ Suggest with AI</button>
                                </div>
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
                            ${schedules.map((schedule) => `
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
                                        <span>📝 ${escapeHtmlSys(schedule.prompt_key)}${schedule.bullet_points ? ` <span style="background:var(--accent-primary,#6366f1);color:#fff;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500;">🔹 ${schedule.bullet_points_count}pt</span>` : ''}</span>
                                        <span>📨 ${escapeHtmlSys(schedule.header || `*${schedule.name}*`)}${schedule.header_datetime ? ' 🕐' : ''}${schedule.header_datetime && schedule.header_datetime_offset ? ` <span class="text-muted" style="font-size:11px;">(${schedule.header_datetime_offset > 0 ? '+' : ''}${schedule.header_datetime_offset}min)</span>` : ''}${schedule.telegram_targets?.length ? ` 📡 ${schedule.telegram_targets.length}` : ''}</span>
                                    </div>
                                </div>
                            `).join('')}
                            <button class="btn btn-secondary btn-sm mt-2"
                                    onclick="openAddTopicScheduleModal('${b}', '${c}', '${t}')">
                                + Add Schedule
                            </button>
                        </div>
                    </div>
                  </div>`;
    }

    function _renderLazyTopicContent(section) {
        const ph = section.querySelector('.topic-lazy-body');
        if (!ph) return;
        const { lazyBot: botName, lazyCat: categoryName, lazyTopic: topicName } = ph.dataset;
        const topic = globalConfig.bots?.[botName]?.categories?.[categoryName]?.topics?.[topicName];
        const categoryEnabled = globalConfig.bots?.[botName]?.categories?.[categoryName]?.enabled !== false;
        ph.className = 'collapsible-content';
        ph.innerHTML = topic
            ? _buildTopicBodyHtml(botName, categoryName, topicName, topic, categoryEnabled)
            : '';
        delete ph.dataset.lazyBot; delete ph.dataset.lazyCat; delete ph.dataset.lazyTopic;
    }

    function createTopicBox(botName, categoryName, topicName, topic, categoryEnabled = true) {
        const schedules = topic.schedules || [];
        const linkedTopics = topic.linked_topics || [];
        const catchAll = !!topic.catch_all;
        const sectionId = `topic-${botName}-${categoryName}-${topicName}`;
        const savedState = loadCollapsibleState(sectionId);
        const defaultOpen = savedState !== null ? savedState : false; // Default closed for Topics
        const isDisabledByCategory = !categoryEnabled;
        const b = jsAttr(botName), c = jsAttr(categoryName), t = jsAttr(topicName);

        // Lazy: render body only when topic is open; closed topics get a lightweight placeholder.
        const bodyHtml = defaultOpen
            ? `<div class="collapsible-content">${_buildTopicBodyHtml(botName, categoryName, topicName, topic, categoryEnabled)}</div>`
            : `<div class="collapsible-content topic-lazy-body" data-lazy-bot="${b}" data-lazy-cat="${c}" data-lazy-topic="${t}"></div>`;

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

                ${bodyHtml}
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
                ? (() => {
                    const startMins = (schedule.start_hour ?? 0) * 60 + (schedule.start_minute ?? 0);
                    const endMins   = schedule.end_hour * 60 + schedule.end_minute;
                    const tag = endMins < startMins ? ' (+1d)' : '';
                    return ` → ${String(schedule.end_hour).padStart(2,'0')}:${String(schedule.end_minute).padStart(2,'0')}${tag}`;
                })() : '';
            return `Every ${schedule.minutes || 30}min — starts ${sh}:${sm}${endPart}`;
        }
        if (type === 'interval_hourly') {
            const sh = String(schedule.start_hour   ?? 0).padStart(2, '0');
            const sm = String(schedule.start_minute ?? 0).padStart(2, '0');
            const endPart = (schedule.end_hour != null && schedule.end_minute != null)
                ? (() => {
                    const startMins = (schedule.start_hour ?? 0) * 60 + (schedule.start_minute ?? 0);
                    const endMins   = schedule.end_hour * 60 + schedule.end_minute;
                    const tag = endMins < startMins ? ' (+1d)' : '';
                    return ` → ${String(schedule.end_hour).padStart(2,'0')}:${String(schedule.end_minute).padStart(2,'0')}${tag}`;
                })() : '';
            return `Every ${schedule.hours || 1}h — starts ${sh}:${sm}${endPart}`;
        }
        if (type === 'daily') return `Daily at ${String(schedule.hour || 0).padStart(2, '0')}:${String(schedule.minute || 0).padStart(2, '0')}`;
        if (type === 'speeches_interval') {
            return `Speeches — every 1min check — send after ${schedule.wait_time || 5}m idle`;
        }
        return type;
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

        const updated = [...topic.linked_topics, linkedTopicName];
        const result = await api('/api/topic/update', {
            bot_name: botName,
            category_name: categoryName,
            topic_name: topicName,
            linked_topics: updated,
        });
        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${botName}-${categoryName}-${topicName}`;
            renderBotsPage([topicId, `categories-${botName}`]);
            closeModal('link-topic-modal');
            showNotification('Topic linked', 'success');
        }
    }

    async function removeLinkedTopic(botName, categoryName, topicName, index) {
        const topic = globalConfig.bots[botName]?.categories[categoryName]?.topics[topicName];
        if (!topic?.linked_topics) return;

        const updated = topic.linked_topics.filter((_, i) => i !== index);
        const result = await api('/api/topic/update', {
            bot_name: botName,
            category_name: categoryName,
            topic_name: topicName,
            linked_topics: updated,
        });
        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${botName}-${categoryName}-${topicName}`;
            renderBotsPage([topicId, `categories-${botName}`]);
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


    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window.createCategoriesSection      = createCategoriesSection;
    window.createCategoryBox            = createCategoryBox;
    window._buildCategoryTopicsHtml     = _buildCategoryTopicsHtml;
    window._renderLazyCategoryContent   = _renderLazyCategoryContent;
    window.openCategoryAndFocusNewTopic = openCategoryAndFocusNewTopic;
    window._buildTopicBodyHtml          = _buildTopicBodyHtml;
    window._renderLazyTopicContent      = _renderLazyTopicContent;
    window.createTopicBox               = createTopicBox;
    window.formatSchedule               = formatSchedule;
    window.addCategory                  = addCategory;
    window.deleteCategory               = deleteCategory;
    window.toggleCategory               = toggleCategory;
    window.addTopic                     = addTopic;
    window.renameTopic                  = renameTopic;
    window.deleteTopic                  = deleteTopic;
    window.toggleTopic                  = toggleTopic;
    window.setTopicCatchAll             = setTopicCatchAll;
    window.showLinkTopicModal           = showLinkTopicModal;
    window.saveLinkTopic                = saveLinkTopic;
    window.removeLinkedTopic            = removeLinkedTopic;
    window.handleKeywordInput           = handleKeywordInput;
    window.addKeyword                   = addKeyword;
    window.removeUserKeyword            = removeUserKeyword;
    window.kwSelectionChanged           = kwSelectionChanged;
    window.kwToggleSelectAll            = kwToggleSelectAll;
    window.kwDeleteSelected             = kwDeleteSelected;
    window.kwDeleteAll                  = kwDeleteAll;
    window.removeKeyword                = removeKeyword;
})();
