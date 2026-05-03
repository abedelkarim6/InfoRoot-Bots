// ==================== Collections Module ====================
// All state here is private to this IIFE — nothing outside can read or write it.
// Functions that HTML onclick= or other scripts need are assigned to window.* below.
(function () {

    // ── Private state ─────────────────────────────────────────────────────────
    let _pickerChannels = [];   // cached joined channels for the picker dropdown
    let _pickerCloser   = null; // document click handler to close picker
    let _modalSources   = [];
    let _modalTargets   = [];
    let _channelValidation = {}; // { '@channel': 'ok'|'warn'|'pending' }
    let _chValOpen = false;

    // ── Collections page ──────────────────────────────────────────────────────
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

    // ── Channel Membership Validator ──────────────────────────────────────────
    function toggleChValCard() {
        _chValOpen = !_chValOpen;
        const body = document.getElementById('ch-val-body');
        const icon = document.getElementById('ch-val-toggle-icon');
        if (body) body.style.display = _chValOpen ? 'block' : 'none';
        if (icon) icon.textContent = _chValOpen ? '▼' : '▶';
    }

    async function validateChannels(e) {
        if (e) e.stopPropagation();

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

        const joined = {};
        (data.channels || []).forEach(ch => {
            if (ch.username) joined[ch.username.toLowerCase()] = ch;
            joined['id:' + ch.id] = ch;
        });

        function resolveJoined(raw) {
            const stripped = raw.replace(/^@/, '').trim();
            if (/^-?\d+$/.test(stripped)) {
                const num = parseInt(stripped, 10);
                if (num < 0) {
                    const s = String(-num);
                    const entityId = s.startsWith('100') ? parseInt(s.slice(3)) : -num;
                    return joined['id:' + entityId] || null;
                }
                return joined['id:' + num] || null;
            }
            return joined[stripped.toLowerCase()] || null;
        }

        const allConfiguredKeys = new Set();
        let totalConfigured = 0, totalJoined = 0;

        const collectionSections = Object.entries(globalConfig.collections || {}).map(([collName, coll]) => {
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
                const isJoined  = !!ch;
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
        const updatedAt    = data.updated_at ? _fmtLBN(data.updated_at) : null;

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

    // ── Channel Tag Input ─────────────────────────────────────────────────────
    function renderChannelTags(type) {
        const arr         = type === 'source' ? _modalSources : _modalTargets;
        const containerId = type === 'source' ? 'source-tags' : 'target-tags';
        const container   = document.getElementById(containerId);
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
                const arr = type === 'source' ? _modalSources : _modalTargets;
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
            const arr = type === 'source' ? _modalSources : _modalTargets;
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
            _modalSources = _modalSources.filter(c => c !== channel);
        } else {
            _modalTargets = _modalTargets.filter(c => c !== channel);
        }
        delete _channelValidation[channel];
        renderChannelTags(type);
    }

    // ── Channel Picker Dropdown ───────────────────────────────────────────────
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
        // Capture button ref before any await — event.currentTarget becomes null after await
        const btn = event.currentTarget;

        const existing = document.getElementById('ch-picker');
        if (existing) {
            if (existing.dataset.pickerType === type) { closeChannelPicker(); return; }
            closeChannelPicker();
        }

        if (!_pickerChannels.length) {
            const res = await api('/api/telegram/userbot/dialogs');
            if (res && res.status === 'ok') _pickerChannels = res.channels || [];
        }

        const picker = document.createElement('div');
        picker.className = 'ch-picker';
        picker.id = 'ch-picker';
        picker.dataset.pickerType = type;
        _rebuildPickerContent(picker, '', type);
        document.body.appendChild(picker);

        const rect = btn.getBoundingClientRect();
        picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 318)) + 'px';
        picker.style.top  = (rect.bottom + 6) + 'px';

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
        return type === 'source' ? _modalSources : _modalTargets;
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
        const arr   = _pickerCurrentArr(type);
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

        const item  = event.currentTarget;
        const isNow = _isInArr(arr, ch);
        item.classList.toggle('selected', isNow);
        const check = item.querySelector('.ch-picker-check');
        if (check) check.textContent = isNow ? '✓' : '';
    }

    function addAllFromPicker() {
        const picker = document.getElementById('ch-picker');
        if (!picker) return;
        const type    = picker.dataset.pickerType;
        const query   = picker.querySelector('.ch-picker-search')?.value || '';
        const all     = _pickerChannelsForType(type);
        const q       = query.toLowerCase();
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

    // ── Collection Modal ──────────────────────────────────────────────────────
    function showAddCollectionModal(existingName = null) {
        const existing = existingName ? globalConfig.collections[existingName] : null;

        _modalSources = existing ? [...(existing.source_channels || [])] : [];
        _modalTargets = existing
            ? [...(existing.target_channels || (existing.target_channel ? [existing.target_channel] : []))]
            : [];
        _channelValidation = {};
        _pickerChannels = [];

        // Pre-validate existing channels in the background
        [..._modalSources, ..._modalTargets].forEach(ch => {
            const type = _modalSources.includes(ch) ? 'source' : 'target';
            validateChannelTag(ch, type);
        });
        // Preload joined channels for the picker
        api('/api/telegram/userbot/dialogs').then(res => {
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
        const newName        = document.getElementById('collection-name').value.trim();
        const collectionName = newName || existingName;

        // Commit any partially-typed channel in the input fields
        ['source', 'target'].forEach(type => {
            const container = document.getElementById(`${type}-tags`);
            if (container) {
                const input = container.querySelector('.tag-input');
                if (input && input.value.trim()) commitChannelTagInput(input, type);
            }
        });

        const sources = [...new Set(_modalSources)];
        const targets = [...new Set(_modalTargets)];

        if (!collectionName || !targets.length) {
            showAlert('Collection name and at least one target channel are required', { icon: '⚠️' });
            return;
        }

        const allNames = Object.keys(globalConfig.collections || {});
        if (newName && newName !== existingName && allNames.includes(newName)) {
            showAlert(`A collection named "${newName}" already exists.`, { icon: '⚠️' });
            return;
        }

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

    // ── Expose public API to global scope ─────────────────────────────────────
    window.renderCollectionsPage   = renderCollectionsPage;
    window.createCollectionCard    = createCollectionCard;
    window.toggleCollection        = toggleCollection;
    window.toggleChValCard         = toggleChValCard;
    window.validateChannels        = validateChannels;
    window.renderChannelTags       = renderChannelTags;
    window.validateChannelTag      = validateChannelTag;
    window.handleChannelTagInput   = handleChannelTagInput;
    window.commitChannelTagInput   = commitChannelTagInput;
    window.removeChannelTag        = removeChannelTag;
    window.closeChannelPicker      = closeChannelPicker;
    window.openChannelPicker       = openChannelPicker;
    window.filterChannelPicker     = filterChannelPicker;
    window.togglePickerChannel     = togglePickerChannel;
    window.addAllFromPicker        = addAllFromPicker;
    window.showAddCollectionModal  = showAddCollectionModal;
    window.saveCollection          = saveCollection;
    window.editCollection          = editCollection;
    window.deleteCollection        = deleteCollection;

})();
