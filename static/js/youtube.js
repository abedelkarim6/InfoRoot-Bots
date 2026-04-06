// ==================== YouTube Monitor UI ====================

let _ytQueueInterval = null;
let _ytDefaultPrompt = '';
let _ytCurrentPage = 0;
const _ytPageSize = 50;
let _ytTotalItems = 0;
let _ytDateInitialized = false;
let _ytProcessingCount = 0;
const _ytProcessingMax = 3;

// ==================== Toast Notifications ====================

function ytToast(message, type = 'success', duration = 3000) {
    let container = document.getElementById('yt-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'yt-toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `yt-toast yt-toast-${type}`;

    const icons = { success: '✅', error: '❌', info: '💡', warning: '⚠️' };
    toast.innerHTML = `<span class="yt-toast-icon">${icons[type] || ''}</span><span>${message}</span>`;

    container.appendChild(toast);
    // Trigger entrance animation
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
}


// ==================== Channels Page ====================

async function loadYtChannelsData() {
    // Load blocked keywords count for the badge
    api('/api/youtube/blocked-keywords').then(r => {
        if (r.status === 'ok') {
            const cnt = (r.keywords || []).length;
            const el = document.getElementById('yt-bkw-count');
            if (el) el.textContent = cnt ? `(${cnt})` : '';
        }
    });

    const container = document.getElementById('yt-channels-container');
    container.innerHTML = '<p class="mon-empty">Loading…</p>';

    const res = await api('/api/youtube/channels');
    if (res.status !== 'ok') {
        container.innerHTML = '<p class="mon-empty">Failed to load channels.</p>';
        return;
    }

    const channels = res.channels || [];
    if (!channels.length) {
        container.innerHTML = '<p class="mon-empty">No channels configured. Click "Add Channel" to get started.</p>';
        return;
    }

    let html = '<div class="yt-cards-grid">';
    for (const ch of channels) {
        const statusClass = ch.active ? 'yt-status-active' : 'yt-status-inactive';
        const statusText = ch.active ? 'Active' : 'Inactive';

        // WebSub state
        const isSubscribed = !!ch.websub_subscribed_at;
        let websubBadge;
        if (isSubscribed) {
            const exp = ch.websub_expires_at ? new Date(ch.websub_expires_at).toLocaleDateString() : '?';
            websubBadge = `<span class="yt-status-badge yt-status-active">Subscribed (exp ${exp})</span>`;
        } else {
            websubBadge = `<span class="yt-status-badge yt-status-pending">Not subscribed</span>`;
        }

        const lastVideo = ch.last_video
            ? `<div class="yt-ch-detail">Last: <strong>${escapeHtml(ch.last_video.title || ch.last_video.video_id)}</strong> <span class="text-muted">(${timeAgo(ch.last_video.discovered_at)})</span></div>`
            : '<div class="yt-ch-detail text-muted">No videos received yet</div>';

        const targets = ch.telegram_targets || [];
        const tgTarget = targets.length
            ? `<div class="yt-ch-detail">📤 ${targets.map(t => `<span class="yt-filter-tag">${escapeHtml(t)}</span>`).join(' ')}</div>`
            : '<div class="yt-ch-detail text-muted">📤 No Telegram targets</div>';

        // Build filter tags
        const chFilters = [];
        if (ch.min_duration_seconds) chFilters.push(`Min ${Math.round(ch.min_duration_seconds/60)}min`);
        if (ch.max_duration_seconds) chFilters.push(`Max ${Math.round(ch.max_duration_seconds/60)}min`);
        if (ch.min_view_count > 0) chFilters.push(`≥${ch.min_view_count} views`);
        if (ch.language) chFilters.push(`Lang: ${ch.language}`);
        if (ch.upload_type) chFilters.push(`Type: ${ch.upload_type}`);
        const chMustInc = ch.title_must_include || [];
        const chMustExc = ch.title_must_exclude || [];
        if (chMustInc.length) chFilters.push(`+${chMustInc.length} title terms`);
        if (chMustExc.length) chFilters.push(`-${chMustExc.length} excluded`);
        const filterSummary = chFilters.length
            ? `<div class="yt-kw-filters">${chFilters.map(f => `<span class="yt-filter-tag">${f}</span>`).join('')}</div>`
            : '';

        html += `
            <div class="yt-channel-card">
                <div class="yt-ch-header">
                    <div>
                        <div class="yt-ch-name">${escapeHtml(ch.channel_name || ch.channel_id)}</div>
                        <div class="yt-ch-id text-muted">${escapeHtml(ch.channel_id)}</div>
                    </div>
                    <span class="yt-status-badge ${statusClass}">${statusText}</span>
                </div>
                <div class="yt-ch-detail">${websubBadge}</div>
                ${tgTarget}
                ${filterSummary}
                ${lastVideo}
                <div class="yt-ch-actions">
                    <label class="toggle-switch">
                        <input type="checkbox" ${ch.active ? 'checked' : ''} onchange="ytToggleChannel('${ch.channel_id}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <button class="btn btn-secondary btn-sm" onclick="ytSubscribeChannel('${ch.channel_id}')" title="Re-subscribe WebSub">🔔 ${isSubscribed ? 'Re-subscribe' : 'Subscribe'}</button>
                    <button class="btn btn-secondary btn-sm" onclick="showYtEditChannelModal('${ch.channel_id}')">✏️</button>
                    <button class="btn btn-danger btn-sm" onclick="ytDeleteChannel('${ch.channel_id}')">🗑️</button>
                </div>
            </div>`;
    }
    html += '</div>';
    container.innerHTML = html;

    // Sync master toggle: ON if all active, OFF if any inactive
    const allActive = channels.every(c => c.active);
    const masterToggle = document.getElementById('yt-channels-master-toggle');
    const masterLabel = document.getElementById('yt-channels-master-label');
    if (masterToggle) masterToggle.checked = allActive;
    if (masterLabel) masterLabel.textContent = allActive ? 'All Active' : 'All Paused';
}

function showYtAddChannelModal() {
    _showYtChannelModal();
}

function showYtEditChannelModal(channelId) {
    // Find channel data from DOM is not ideal — refetch
    (async () => {
        const res = await api('/api/youtube/channels');
        const ch = (res.channels || []).find(c => c.channel_id === channelId);
        if (ch) _showYtChannelModal(ch);
    })();
}

function _showYtChannelModal(ch) {
    const isEdit = !!ch;
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    const mustIncVal = (ch?.title_must_include || []).join(', ');
    const mustExcVal = (ch?.title_must_exclude || []).join(', ');

    overlay.innerHTML = `
        <div class="dialog-box yt-keyword-modal">
            <div class="dialog-title">${isEdit ? 'Edit' : 'Add'} YouTube Channel</div>
            <div class="yt-kw-form">
                <div class="yt-kw-form-field">
                    <label class="input-label">Channel ID or URL *</label>
                    <input type="text" class="input" id="yt-ch-id" value="${escapeHtml(ch?.channel_id || '')}" placeholder="UCxxxx or youtube.com/channel/UCxxxx" ${isEdit ? 'readonly style="opacity:0.6"' : ''}>
                </div>
                <div class="yt-kw-form-row">
                    <div class="yt-kw-form-field">
                        <label class="input-label">Display Name</label>
                        <input type="text" class="input" id="yt-ch-name" value="${escapeHtml(ch?.channel_name || '')}" placeholder="Channel name">
                    </div>
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Telegram Targets <span class="text-muted">(comma-separated: @ch1, @ch2)</span></label>
                    <input type="text" class="input" id="yt-ch-tg-targets" value="${escapeHtml((ch?.telegram_targets || []).join(', '))}" placeholder="@channel1, @channel2">
                </div>
                <div class="yt-kw-form-row">
                    <div class="yt-kw-form-field">
                        <label class="input-label">Min minutes</label>
                        <input type="number" class="input" id="yt-ch-min-dur" value="${ch?.min_duration_seconds ? Math.round(ch.min_duration_seconds/60) : ''}" placeholder="No min">
                    </div>
                    <div class="yt-kw-form-field">
                        <label class="input-label">Max minutes</label>
                        <input type="number" class="input" id="yt-ch-max-dur" value="${ch?.max_duration_seconds ? Math.round(ch.max_duration_seconds/60) : ''}" placeholder="No max">
                    </div>
                    <div class="yt-kw-form-field">
                        <label class="input-label">Min views</label>
                        <input type="number" class="input" id="yt-ch-min-views" value="${ch?.min_view_count || 0}" min="0">
                    </div>
                </div>
                <div class="yt-kw-form-row">
                    <div class="yt-kw-form-field">
                        <label class="input-label">Language</label>
                        <select class="select" id="yt-ch-lang">
                            <option value="">Any</option>
                            <option value="en" ${ch?.language==='en'?'selected':''}>English</option>
                            <option value="ar" ${ch?.language==='ar'?'selected':''}>Arabic</option>
                            <option value="es" ${ch?.language==='es'?'selected':''}>Spanish</option>
                            <option value="fr" ${ch?.language==='fr'?'selected':''}>French</option>
                            <option value="de" ${ch?.language==='de'?'selected':''}>German</option>
                            <option value="ru" ${ch?.language==='ru'?'selected':''}>Russian</option>
                            <option value="zh" ${ch?.language==='zh'?'selected':''}>Chinese</option>
                            <option value="ja" ${ch?.language==='ja'?'selected':''}>Japanese</option>
                            <option value="ko" ${ch?.language==='ko'?'selected':''}>Korean</option>
                            <option value="pt" ${ch?.language==='pt'?'selected':''}>Portuguese</option>
                            <option value="hi" ${ch?.language==='hi'?'selected':''}>Hindi</option>
                            <option value="tr" ${ch?.language==='tr'?'selected':''}>Turkish</option>
                        </select>
                    </div>
                    <div class="yt-kw-form-field">
                        <label class="input-label">Upload type</label>
                        <select class="select" id="yt-ch-upload-type">
                            <option value="" ${!ch?.upload_type?'selected':''}>Any</option>
                            <option value="video" ${ch?.upload_type==='video'?'selected':''}>Video</option>
                            <option value="live" ${ch?.upload_type==='live'?'selected':''}>Live</option>
                            <option value="completed" ${ch?.upload_type==='completed'?'selected':''}>Completed</option>
                        </select>
                    </div>
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Title must include <span class="text-muted">(comma-separated, empty = no requirement)</span></label>
                    <input type="text" class="input" id="yt-ch-must-include" value="${escapeHtml(mustIncVal)}" placeholder="term1, term2">
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Title must exclude <span class="text-muted">(comma-separated)</span></label>
                    <input type="text" class="input" id="yt-ch-must-exclude" value="${escapeHtml(mustExcVal)}" placeholder="term1, term2">
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Custom Prompt <span class="text-muted">(leave empty for global default)</span></label>
                    <textarea class="input yt-prompt-textarea" id="yt-ch-prompt" rows="3" placeholder="Custom summarization prompt…">${escapeHtml(ch?.prompt || '')}</textarea>
                </div>
            </div>
            <div class="dialog-actions">
                <button class="btn btn-secondary dialog-cancel">Cancel</button>
                <button class="btn btn-primary" id="yt-ch-submit">${isEdit ? 'Save' : 'Add'}</button>
            </div>
        </div>
    `;
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-cancel').addEventListener('click', close);
    overlay.querySelector('#yt-ch-submit').addEventListener('click', async () => {
        const channelId = document.getElementById('yt-ch-id').value.trim();
        const channelName = document.getElementById('yt-ch-name').value.trim();
        const tgTargets = _parseCommaSep(document.getElementById('yt-ch-tg-targets').value);
        const prompt = document.getElementById('yt-ch-prompt').value.trim();

        if (!channelId) return ytToast('Channel ID is required.', 'error');

        const minDurMin = document.getElementById('yt-ch-min-dur').value;
        const maxDurMin = document.getElementById('yt-ch-max-dur').value;

        const payload = {
            channel_id: channelId, channel_name: channelName || null,
            telegram_targets: tgTargets, prompt: prompt || null,
            min_duration_seconds: minDurMin ? parseInt(minDurMin) * 60 : null,
            max_duration_seconds: maxDurMin ? parseInt(maxDurMin) * 60 : null,
            min_view_count: parseInt(document.getElementById('yt-ch-min-views').value) || 0,
            language: document.getElementById('yt-ch-lang').value || null,
            upload_type: document.getElementById('yt-ch-upload-type').value || null,
            title_must_include: _parseCommaSep(document.getElementById('yt-ch-must-include').value),
            title_must_exclude: _parseCommaSep(document.getElementById('yt-ch-must-exclude').value),
        };

        let res;
        if (isEdit) {
            res = await api('/api/youtube/channels/update', payload);
        } else {
            res = await api('/api/youtube/channels/add', payload);
        }
        close();
        if (res.status === 'ok') {
            ytToast(isEdit ? 'Channel updated' : `Channel added${res.subscribed ? ' & subscribed' : ''}`, 'success');
            loadYtChannelsData();
        } else {
            ytToast(res.message || 'Failed', 'error');
        }
    });
    document.body.appendChild(overlay);
    document.getElementById(isEdit ? 'yt-ch-name' : 'yt-ch-id').focus();
}

async function ytToggleChannel(channelId, active) {
    await api('/api/youtube/channels/toggle', { channel_id: channelId, active });
    ytToast(active ? 'Channel enabled' : 'Channel disabled', 'info');
}

async function ytToggleAllChannels(active) {
    await api('/api/youtube/channels/toggle-all', { active });
    ytToast(active ? 'All channels enabled' : 'All channels disabled', 'info');
    loadYtChannelsData();
}

async function ytDeleteChannel(channelId) {
    showConfirm(`Delete channel <strong>${channelId}</strong>?`, async () => {
        await api('/api/youtube/channels/delete', { channel_id: channelId });
        ytToast('Channel deleted', 'success');
        loadYtChannelsData();
    });
}

async function ytSubscribeChannel(channelId) {
    const res = await api('/api/youtube/channels/subscribe', { channel_id: channelId });
    if (res.status === 'ok' && res.subscribed) {
        ytToast('WebSub subscription sent', 'success');
        loadYtChannelsData();
    } else if (res.message) {
        ytToast(res.message, 'error');
    } else {
        ytToast('Subscription request failed', 'error');
    }
}


// ==================== Blocked Keywords (Channels page) ====================

function toggleYtBlockedKeywords() {
    const body = document.getElementById('yt-bkw-body');
    const arrow = document.getElementById('yt-bkw-arrow');
    const open = body.style.display === 'none';
    body.style.display = open ? 'block' : 'none';
    arrow.style.transform = open ? 'rotate(90deg)' : '';
    if (open) loadYtBlockedKeywords();
}

async function loadYtBlockedKeywords() {
    const list = document.getElementById('yt-bkw-list');
    const res = await api('/api/youtube/blocked-keywords');
    if (res.status !== 'ok') return;
    const keywords = res.keywords || [];
    document.getElementById('yt-bkw-count').textContent = keywords.length ? `(${keywords.length})` : '';
    if (!keywords.length) {
        list.innerHTML = '<p class="text-muted">No blocked keywords.</p>';
        return;
    }
    list.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + keywords.map(kw => `
        <span class="yt-filter-tag" style="display:inline-flex;align-items:center;gap:4px;">
            ${escapeHtml(kw.keyword)}
            <span style="cursor:pointer;opacity:0.6;font-size:14px;" onclick="ytRemoveBlockedKeyword(${kw.id})" title="Remove">✕</span>
        </span>
    `).join('') + '</div>';
}

async function ytAddBlockedKeyword() {
    const input = document.getElementById('yt-bkw-input');
    const keyword = input.value.trim();
    if (!keyword) return ytToast('Keyword is required.', 'error');
    const res = await api('/api/youtube/blocked-keywords/add', { keyword });
    if (res.status === 'ok') {
        input.value = '';
        ytToast('Keyword blocked', 'success');
        loadYtBlockedKeywords();
    } else {
        ytToast(res.message || 'Failed', 'error');
    }
}

async function ytRemoveBlockedKeyword(id) {
    await api('/api/youtube/blocked-keywords/delete', { id });
    ytToast('Keyword unblocked', 'success');
    loadYtBlockedKeywords();
}

// ==================== Blocked Channels ====================

function toggleYtBlockedChannels() {
    const body = document.getElementById('yt-blocked-body');
    const arrow = document.getElementById('yt-blocked-arrow');
    const open = body.style.display === 'none';
    body.style.display = open ? 'block' : 'none';
    arrow.style.transform = open ? 'rotate(90deg)' : '';
    if (open) loadYtBlockedChannels();
}

async function loadYtBlockedChannels() {
    const list = document.getElementById('yt-blocked-list');
    const res = await api('/api/youtube/blocked-channels');
    if (res.status !== 'ok') return;
    const channels = res.channels || [];
    document.getElementById('yt-blocked-count').textContent = channels.length ? `(${channels.length})` : '';
    if (!channels.length) {
        list.innerHTML = '<p class="text-muted">No blocked channels.</p>';
        return;
    }
    list.innerHTML = channels.map(ch => `
        <div class="yt-blocked-item" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="flex:1;font-family:monospace;font-size:13px;">${escapeHtml(ch.channel_id)}</span>
            <span style="flex:1;color:var(--text-secondary);">${escapeHtml(ch.channel_name || '')}</span>
            <span class="text-muted" style="font-size:12px;">${ch.created_at ? timeAgo(ch.created_at) : ''}</span>
            <button class="btn btn-danger btn-sm" onclick="ytRemoveBlockedChannel('${escapeHtml(ch.channel_id)}')" title="Unblock">✕</button>
        </div>
    `).join('');
}

async function ytAddBlockedChannel() {
    const chId = document.getElementById('yt-blocked-ch-id').value.trim();
    const chName = document.getElementById('yt-blocked-ch-name').value.trim();
    if (!chId) return ytToast('Channel ID is required.', 'error');
    const res = await api('/api/youtube/blocked-channels/add', { channel_id: chId, channel_name: chName || null });
    if (res.status === 'ok') {
        document.getElementById('yt-blocked-ch-id').value = '';
        document.getElementById('yt-blocked-ch-name').value = '';
        ytToast('Channel blocked', 'success');
        loadYtBlockedChannels();
    } else {
        ytToast(res.message || 'Failed', 'error');
    }
}

async function ytRemoveBlockedChannel(channelId) {
    showConfirm(`Unblock channel <strong>${escapeHtml(channelId)}</strong>?`, async () => {
        await api('/api/youtube/blocked-channels/delete', { channel_id: channelId });
        ytToast('Channel unblocked', 'success');
        loadYtBlockedChannels();
    });
}

// ==================== Keywords Page ====================

async function loadYtKeywordsData() {
    // Load blocked channel count for the badge
    api('/api/youtube/blocked-channels').then(r => {
        if (r.status === 'ok') {
            const cnt = (r.channels || []).length;
            const el = document.getElementById('yt-blocked-count');
            if (el) el.textContent = cnt ? `(${cnt})` : '';
        }
    });

    const container = document.getElementById('yt-keywords-container');
    container.innerHTML = '<p class="mon-empty">Loading…</p>';
    // Restore header controls in case they were hidden on a previous seo_visible=false load
    const _kwHeader = document.querySelector('#yt-keywords-page .page-header > div:last-child');
    if (_kwHeader) _kwHeader.style.display = '';

    const res = await api('/api/youtube/keywords');
    if (res.status !== 'ok') {
        container.innerHTML = '<p class="mon-empty">Failed to load keywords.</p>';
        return;
    }

    // Non-admin user with seo_visible=false: show count-only placeholder
    if (res.seo_visible === false) {
        const count = res.seo_count || 0;
        container.innerHTML = `<p class="mon-empty" style="color:var(--text-muted)">🔎 ${count} SEO tracker${count !== 1 ? 's' : ''} assigned — details hidden by admin.</p>`;
        // Also hide the action bar controls (search, run, add) for this user
        const header = document.querySelector('#yt-keywords-page .page-header > div:last-child');
        if (header) header.style.display = 'none';
        return;
    }

    const keywords = res.keywords || [];
    if (!keywords.length) {
        container.innerHTML = '<p class="mon-empty">No keyword configs. Click "Add Tracker" to get started.</p>';
        return;
    }

    let html = '<div class="yt-cards-grid">';
    for (const kw of keywords) {
        const statusClass = kw.active ? 'yt-status-active' : 'yt-status-inactive';

        const filters = [];
        if (kw.min_duration_seconds) filters.push(`Min ${Math.round(kw.min_duration_seconds/60)}min`);
        if (kw.max_duration_seconds) filters.push(`Max ${Math.round(kw.max_duration_seconds/60)}min`);
        if (kw.min_view_count > 0) filters.push(`≥${kw.min_view_count} views`);
        if (kw.language) filters.push(`Lang: ${kw.language}`);
        const allowlist = kw.channel_allowlist || [];
        const blocklist = kw.channel_blocklist || [];
        if (allowlist.length) filters.push(`${allowlist.length} allowed ch`);
        if (blocklist.length) filters.push(`${blocklist.length} blocked ch`);
        const mustInclude = kw.title_must_include || [];
        const mustExclude = kw.title_must_exclude || [];
        if (mustInclude.length) filters.push(`+${mustInclude.length} title terms`);
        if (mustExclude.length) filters.push(`-${mustExclude.length} excluded`);

        const filterSummary = filters.length
            ? `<div class="yt-kw-filters">${filters.map(f => `<span class="yt-filter-tag">${f}</span>`).join('')}</div>`
            : '';

        const kwTargets = kw.telegram_targets || [];
        const tgTarget = kwTargets.length
            ? `<div class="yt-ch-detail" style="margin-top:6px;">📤 ${kwTargets.map(t => `<span class="yt-filter-tag">${escapeHtml(t)}</span>`).join(' ')}</div>`
            : '<div class="yt-ch-detail text-muted" style="margin-top:6px;">📤 No Telegram targets</div>';

        // Schedule display
        let scheduleInfo = '';
        if (kw.schedule_interval_minutes) {
            const sf = _kwScheduleToFields(kw.schedule_interval_minutes);
            const schedLabel = `${sf.val} ${sf.unit}`;
            const lastRun = kw.last_run_at ? timeAgo(kw.last_run_at) : 'never';
            scheduleInfo = `<div class="yt-ch-detail" style="margin-top:4px;">⏰ Every <strong>${schedLabel}</strong> <span class="text-muted">· Last run: ${lastRun}</span></div>`;
        } else {
            scheduleInfo = '<div class="yt-ch-detail text-muted" style="margin-top:4px;">⏰ No schedule (manual only)</div>';
        }

        const subKws = kw.sub_keywords || [];
        const subKwHtml = subKws.length
            ? `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">${subKws.map(sk => `<span class="yt-filter-tag" style="font-size:12px;">${escapeHtml(sk)}</span>`).join('')}</div>`
            : '';

        html += `
            <div class="yt-keyword-card" data-kw-id="${kw.id}">
                <div class="yt-kw-header">
                    <label class="yt-kw-select-label" onclick="event.stopPropagation()">
                        <input type="checkbox" class="yt-kw-select" data-id="${kw.id}" onchange="ytUpdateKwSelection()">
                    </label>
                    <div class="yt-kw-name">"${escapeHtml(kw.keyword)}"</div>
                    <span class="yt-status-badge ${statusClass}">${kw.active ? 'Active' : 'Inactive'}</span>
                </div>
                ${subKwHtml}
                <div class="text-muted" style="font-size:12px;">Window: ${kw.date_window_days} day(s) · Type: ${kw.upload_type || 'video'}</div>
                ${tgTarget}
                ${scheduleInfo}
                ${filterSummary}
                <div class="yt-kw-actions">
                    <label class="toggle-switch">
                        <input type="checkbox" ${kw.active ? 'checked' : ''} onchange="ytToggleKeyword(${kw.id}, this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <button class="btn btn-secondary btn-sm" onclick="ytRunKeyword(${kw.id})">▶ Run</button>
                    <button class="btn btn-secondary btn-sm" onclick="showYtKeywordModal(${kw.id})">✏️</button>
                    <button class="btn btn-danger btn-sm" onclick="ytDeleteKeyword(${kw.id})">🗑️</button>
                </div>
            </div>`;
    }
    html += '</div>';
    container.innerHTML = html;

    // Sync master toggle: ON if all active, OFF if any inactive
    const allActive = keywords.every(k => k.active);
    const masterToggle = document.getElementById('yt-trackers-master-toggle');
    const masterLabel = document.getElementById('yt-trackers-master-label');
    if (masterToggle) masterToggle.checked = allActive;
    if (masterLabel) masterLabel.textContent = allActive ? 'All Active' : 'All Paused';
}

function ytFilterKeywords() {
    const query = (document.getElementById('yt-kw-search')?.value || '').toLowerCase().trim();
    const cards = document.querySelectorAll('#yt-keywords-container .yt-keyword-card');
    cards.forEach(card => {
        const name = (card.querySelector('.yt-kw-name')?.textContent || '').toLowerCase();
        card.style.display = !query || name.includes(query) ? '' : 'none';
    });
}

function _ytGetSelectedKwIds() {
    return [...document.querySelectorAll('.yt-kw-select:checked')].map(cb => parseInt(cb.dataset.id));
}

function ytUpdateKwSelection() {
    const ids = _ytGetSelectedKwIds();
    const btn = document.getElementById('yt-kw-run-selected');
    const countEl = document.getElementById('yt-kw-sel-count');
    if (btn) btn.style.display = ids.length ? '' : 'none';
    if (countEl) countEl.textContent = ids.length;

    // Visual highlight on selected cards
    document.querySelectorAll('.yt-keyword-card').forEach(card => {
        card.classList.toggle('yt-kw-card-selected', card.querySelector('.yt-kw-select:checked') !== null);
    });
}

async function ytRunSelectedKeywords() {
    const ids = _ytGetSelectedKwIds();
    if (!ids.length) return ytToast('No trackers selected.', 'error');

    ytToast(`Running ${ids.length} tracker(s)…`, 'info');
    let totalEnqueued = 0;
    let errors = 0;
    for (const id of ids) {
        const res = await api('/api/youtube/keywords/run', { id });
        if (res.status === 'ok') {
            totalEnqueued += res.enqueued || 0;
        } else {
            errors++;
        }
    }
    if (errors) {
        ytToast(`Done: ${totalEnqueued} video(s) enqueued, ${errors} failed`, 'warning');
    } else {
        ytToast(`Done: ${totalEnqueued} video(s) enqueued from ${ids.length} tracker(s)`, 'success');
    }
    // Uncheck all
    document.querySelectorAll('.yt-kw-select').forEach(cb => cb.checked = false);
    ytUpdateKwSelection();
}

async function showYtKeywordModal(editId) {
    let kw = null;
    if (editId) {
        const res = await api('/api/youtube/keywords');
        kw = (res.keywords || []).find(k => k.id === editId);
    }

    const isEdit = !!kw;
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const allowlistVal = (kw?.channel_allowlist || []).join(', ');
    const blocklistVal = (kw?.channel_blocklist || []).join(', ');
    const mustIncVal = (kw?.title_must_include || []).join(', ');
    const mustExcVal = (kw?.title_must_exclude || []).join(', ');
    const subKwVal = (kw?.sub_keywords || []).join(', ');

    overlay.innerHTML = `
        <div class="dialog-box yt-keyword-modal">
            <div class="dialog-title">${isEdit ? 'Edit' : 'Add'} Keyword Config</div>
            <div class="yt-kw-form">
                <div class="yt-kw-form-row">
                    <div class="yt-kw-form-field">
                        <label class="input-label">Keyword *</label>
                        <input type="text" class="input" id="ytkw-keyword" value="${escapeHtml(kw?.keyword || '')}" placeholder="Main search term">
                    </div>
                    <div class="yt-kw-form-field" style="max-width:100px;">
                        <label class="input-label">Window (days)</label>
                        <input type="number" class="input" id="ytkw-window" value="${kw?.date_window_days || 1}" min="1" max="30">
                    </div>
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Sub-keywords <span class="text-muted">(comma-separated variations — same config, separate searches)</span></label>
                    <input type="text" class="input" id="ytkw-sub-keywords" value="${escapeHtml(subKwVal)}" placeholder="variation1, variation2, …">
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Telegram Targets <span class="text-muted">(comma-separated: @ch1, @ch2)</span></label>
                    <input type="text" class="input" id="ytkw-tg-targets" value="${escapeHtml((kw?.telegram_targets || []).join(', '))}" placeholder="@channel1, @channel2">
                </div>
                <div class="yt-kw-form-row">
                    <div class="yt-kw-form-field">
                        <label class="input-label">Min minutes</label>
                        <input type="number" class="input" id="ytkw-min-dur" value="${kw?.min_duration_seconds ? Math.round(kw.min_duration_seconds/60) : ''}" placeholder="No min">
                    </div>
                    <div class="yt-kw-form-field">
                        <label class="input-label">Max minutes</label>
                        <input type="number" class="input" id="ytkw-max-dur" value="${kw?.max_duration_seconds ? Math.round(kw.max_duration_seconds/60) : ''}" placeholder="No max">
                    </div>
                    <div class="yt-kw-form-field">
                        <label class="input-label">Min views</label>
                        <input type="number" class="input" id="ytkw-min-views" value="${kw?.min_view_count || 0}" min="0">
                    </div>
                </div>
                <div class="yt-kw-form-row">
                    <div class="yt-kw-form-field">
                        <label class="input-label">Language</label>
                        <select class="select" id="ytkw-lang">
                            <option value="">Any</option>
                            <option value="en" ${kw?.language==='en'?'selected':''}>English</option>
                            <option value="ar" ${kw?.language==='ar'?'selected':''}>Arabic</option>
                            <option value="es" ${kw?.language==='es'?'selected':''}>Spanish</option>
                            <option value="fr" ${kw?.language==='fr'?'selected':''}>French</option>
                            <option value="de" ${kw?.language==='de'?'selected':''}>German</option>
                            <option value="ru" ${kw?.language==='ru'?'selected':''}>Russian</option>
                            <option value="zh" ${kw?.language==='zh'?'selected':''}>Chinese</option>
                            <option value="ja" ${kw?.language==='ja'?'selected':''}>Japanese</option>
                            <option value="ko" ${kw?.language==='ko'?'selected':''}>Korean</option>
                            <option value="pt" ${kw?.language==='pt'?'selected':''}>Portuguese</option>
                            <option value="hi" ${kw?.language==='hi'?'selected':''}>Hindi</option>
                            <option value="tr" ${kw?.language==='tr'?'selected':''}>Turkish</option>
                        </select>
                    </div>
                    <div class="yt-kw-form-field">
                        <label class="input-label">Upload type</label>
                        <select class="select" id="ytkw-upload-type">
                            <option value="video" ${(kw?.upload_type||'video')==='video'?'selected':''}>Video</option>
                            <option value="any" ${kw?.upload_type==='any'?'selected':''}>Any</option>
                            <option value="live" ${kw?.upload_type==='live'?'selected':''}>Live</option>
                            <option value="completed" ${kw?.upload_type==='completed'?'selected':''}>Completed</option>
                        </select>
                    </div>
                </div>
                <div class="yt-kw-form-row">
                    <div class="yt-kw-form-field">
                        <label class="input-label">Schedule interval <span class="text-muted">(how often to auto-run)</span></label>
                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="number" class="input" id="ytkw-schedule-val" value="${_kwScheduleToFields(kw?.schedule_interval_minutes).val || ''}" min="1" placeholder="Off" style="width:80px;">
                            <select class="select" id="ytkw-schedule-unit" style="width:110px;">
                                <option value="minutes" ${_kwScheduleToFields(kw?.schedule_interval_minutes).unit==='minutes'?'selected':''}>Minutes</option>
                                <option value="hours" ${_kwScheduleToFields(kw?.schedule_interval_minutes).unit==='hours'?'selected':''}>Hours</option>
                                <option value="days" ${_kwScheduleToFields(kw?.schedule_interval_minutes).unit==='days'?'selected':''}>Days</option>
                            </select>
                        </div>
                    </div>
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Channel allowlist <span class="text-muted">(comma-separated IDs, empty = accept all)</span></label>
                    <input type="text" class="input" id="ytkw-allowlist" value="${escapeHtml(allowlistVal)}" placeholder="UCxxxx, UCyyyy">
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Channel blocklist <span class="text-muted">(comma-separated IDs)</span></label>
                    <input type="text" class="input" id="ytkw-blocklist" value="${escapeHtml(blocklistVal)}" placeholder="UCxxxx, UCyyyy">
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Title must include <span class="text-muted">(comma-separated, empty = no requirement)</span></label>
                    <input type="text" class="input" id="ytkw-must-include" value="${escapeHtml(mustIncVal)}" placeholder="term1, term2">
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Title must exclude <span class="text-muted">(comma-separated)</span></label>
                    <input type="text" class="input" id="ytkw-must-exclude" value="${escapeHtml(mustExcVal)}" placeholder="term1, term2">
                </div>
                <div class="yt-kw-form-field">
                    <label class="input-label">Custom Prompt <span class="text-muted">(leave empty for global default)</span></label>
                    <textarea class="input yt-prompt-textarea" id="ytkw-prompt" rows="3" placeholder="Custom summarization prompt…">${escapeHtml(kw?.prompt || '')}</textarea>
                </div>
            </div>
            <div class="dialog-actions">
                <button class="btn btn-secondary dialog-cancel">Cancel</button>
                <button class="btn btn-primary" id="ytkw-submit">${isEdit ? 'Save' : 'Add'}</button>
            </div>
        </div>
    `;
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-cancel').addEventListener('click', close);
    overlay.querySelector('#ytkw-submit').addEventListener('click', async () => {
        const keyword = document.getElementById('ytkw-keyword').value.trim();
        if (!keyword) return ytToast('Keyword is required.', 'error');

        const minDurMin = document.getElementById('ytkw-min-dur').value;
        const maxDurMin = document.getElementById('ytkw-max-dur').value;

        const data = {
            keyword,
            sub_keywords: _parseCommaSep(document.getElementById('ytkw-sub-keywords').value),
            telegram_targets: _parseCommaSep(document.getElementById('ytkw-tg-targets').value),
            prompt: document.getElementById('ytkw-prompt').value.trim() || null,
            date_window_days: parseInt(document.getElementById('ytkw-window').value) || 1,
            active: kw ? kw.active : true,
            min_duration_seconds: minDurMin ? parseInt(minDurMin) * 60 : null,
            max_duration_seconds: maxDurMin ? parseInt(maxDurMin) * 60 : null,
            min_view_count: parseInt(document.getElementById('ytkw-min-views').value) || 0,
            language: document.getElementById('ytkw-lang').value || null,
            upload_type: document.getElementById('ytkw-upload-type').value || 'video',
            channel_allowlist: _parseCommaSep(document.getElementById('ytkw-allowlist').value),
            channel_blocklist: _parseCommaSep(document.getElementById('ytkw-blocklist').value),
            title_must_include: _parseCommaSep(document.getElementById('ytkw-must-include').value),
            title_must_exclude: _parseCommaSep(document.getElementById('ytkw-must-exclude').value),
            schedule_interval_minutes: _kwFieldsToIntervalMinutes(),
        };

        let res;
        if (isEdit) {
            data.id = kw.id;
            res = await api('/api/youtube/keywords/update', data);
        } else {
            res = await api('/api/youtube/keywords/add', data);
        }
        close();
        if (res.status === 'ok') {
            ytToast(isEdit ? 'Keyword updated' : 'Keyword added', 'success');
            loadYtKeywordsData();
        } else {
            ytToast(res.message || 'Failed to save keyword.', 'error');
        }
    });
    document.body.appendChild(overlay);
    document.getElementById('ytkw-keyword').focus();
}

function _parseCommaSep(val) {
    return (val || '').split(',').map(s => s.trim()).filter(Boolean);
}

function _kwScheduleToFields(intervalMinutes) {
    if (!intervalMinutes) return { val: '', unit: 'hours' };
    if (intervalMinutes >= 1440 && intervalMinutes % 1440 === 0) return { val: intervalMinutes / 1440, unit: 'days' };
    if (intervalMinutes >= 60 && intervalMinutes % 60 === 0) return { val: intervalMinutes / 60, unit: 'hours' };
    return { val: intervalMinutes, unit: 'minutes' };
}

function _kwFieldsToIntervalMinutes() {
    const val = parseInt(document.getElementById('ytkw-schedule-val').value);
    if (!val || val <= 0) return null;
    const unit = document.getElementById('ytkw-schedule-unit').value;
    if (unit === 'days') return val * 1440;
    if (unit === 'hours') return val * 60;
    return val;
}

async function ytToggleKeyword(id, active) {
    await api('/api/youtube/keywords/toggle', { id, active });
    ytToast(active ? 'Keyword enabled' : 'Keyword disabled', 'info');
}

async function ytToggleAllKeywords(active) {
    await api('/api/youtube/keywords/toggle-all', { active });
    ytToast(active ? 'All trackers enabled' : 'All trackers disabled', 'info');
    loadYtKeywordsData();
}

async function ytDeleteKeyword(id) {
    showConfirm('Delete this keyword config?', async () => {
        await api('/api/youtube/keywords/delete', { id });
        ytToast('Keyword deleted', 'success');
        loadYtKeywordsData();
    });
}

async function ytRunKeyword(id) {
    ytToast('Running keyword search…', 'info');
    const res = await api('/api/youtube/keywords/run', { id });
    if (res.status === 'ok') {
        ytToast(`Search complete: ${res.enqueued} video(s) enqueued`, 'success');
    } else {
        ytToast('Search failed: ' + (res.message || 'Unknown error'), 'error');
    }
}

async function ytRunAllKeywords() {
    ytToast('Running all keyword searches…', 'info');
    const res = await api('/api/youtube/keywords/run-all');
    if (res.status === 'ok') {
        ytToast(`All searches done: ${res.enqueued} video(s) enqueued`, 'success');
    } else {
        ytToast('Search failed: ' + (res.message || 'Unknown error'), 'error');
    }
}


// ==================== Manual Video Submission ====================

async function ytAddManualVideo() {
    const urlInput = document.getElementById('yt-manual-url');
    const targetInput = document.getElementById('yt-manual-target');
    const url = urlInput.value.trim();
    const tgTarget = targetInput ? targetInput.value.trim() : '';

    if (!url) return ytToast('Please enter a YouTube URL or video ID.', 'error');

    const res = await api('/api/youtube/videos/add', {
        url, telegram_target: tgTarget || null
    });
    if (res.status === 'ok') {
        urlInput.value = '';
        ytToast(`Video ${res.video_id} queued`, 'success');
        loadYtVideosData();
    } else {
        ytToast(res.message || 'Failed to add video.', 'error');
    }
}


// ==================== Prompt Editor (Global Default) ====================

async function ytLoadPrompt() {
    const res = await api('/api/youtube/prompt');
    if (res.status !== 'ok') return;
    _ytDefaultPrompt = res.default_prompt || '';
    const textarea = document.getElementById('yt-prompt-text');
    if (textarea) textarea.value = res.prompt || res.default_prompt || '';
    // Load default targets
    const targetsInput = document.getElementById('yt-default-targets');
    if (targetsInput) targetsInput.value = (res.default_targets || []).join(', ');
}

async function ytSavePrompt() {
    const textarea = document.getElementById('yt-prompt-text');
    const prompt = textarea ? textarea.value : '';
    const res = await api('/api/youtube/prompt/save', { prompt });
    if (res.status === 'ok') ytToast('Default prompt saved', 'success');
    else ytToast('Failed to save prompt.', 'error');
}

function ytResetPrompt() {
    const textarea = document.getElementById('yt-prompt-text');
    if (textarea && _ytDefaultPrompt) textarea.value = _ytDefaultPrompt;
    ytToast('Reset to default prompt', 'info');
}

async function ytSaveDefaultTargets() {
    const input = document.getElementById('yt-default-targets');
    const targets = _parseCommaSep(input ? input.value : '');
    const res = await api('/api/youtube/default-targets/save', { targets });
    if (res.status === 'ok') ytToast('Default targets saved', 'success');
    else ytToast('Failed to save targets.', 'error');
}


// ==================== Videos Page (unified queue + summaries) ====================

async function loadYtVideosData() {
    // Load prompt on first visit
    const textarea = document.getElementById('yt-prompt-text');
    if (textarea && !textarea.value) ytLoadPrompt();

    // Default date to today on first load
    if (!_ytDateInitialized) {
        const today = new Date().toISOString().slice(0, 10);
        const dfEl = document.getElementById('ytv-filter-date-from');
        const dtEl = document.getElementById('ytv-filter-date-to');
        if (dfEl && !dfEl.value) dfEl.value = today;
        if (dtEl && !dtEl.value) dtEl.value = today;
        _ytDateInitialized = true;
    }

    const container = document.getElementById('yt-videos-container');

    const statusFilter = document.getElementById('ytv-filter-status')?.value || '';
    const channelFilter = document.getElementById('ytv-filter-channel')?.value || '';
    const sourceFilter = document.getElementById('ytv-filter-source')?.value || '';
    const dateFrom = document.getElementById('ytv-filter-date-from')?.value || '';
    const dateTo = document.getElementById('ytv-filter-date-to')?.value || '';

    const offset = _ytCurrentPage * _ytPageSize;
    let url = `/api/youtube/videos?limit=${_ytPageSize}&offset=${offset}`;
    if (statusFilter) url += `&status=${encodeURIComponent(statusFilter)}`;
    if (channelFilter) url += `&channel=${encodeURIComponent(channelFilter)}`;
    if (sourceFilter) url += `&source=${encodeURIComponent(sourceFilter)}`;
    if (dateFrom) url += `&date_from=${encodeURIComponent(dateFrom)}`;
    if (dateTo) url += `&date_to=${encodeURIComponent(dateTo)}`;

    // Show/hide clear filters button
    const clearBtn = document.getElementById('ytv-clear-filters');
    const hasFilters = statusFilter || channelFilter || sourceFilter || dateFrom || dateTo;
    if (clearBtn) clearBtn.style.display = hasFilters ? '' : 'none';

    const res = await api(url);
    if (res.status !== 'ok') {
        container.innerHTML = '<p class="mon-empty">Failed to load videos.</p>';
        return;
    }

    const stats = res.stats || {};
    document.getElementById('ytq-pending').textContent = stats.pending || 0;
    document.getElementById('ytq-processing').textContent = stats.processing || 0;
    document.getElementById('ytq-done').textContent = stats.done || 0;
    document.getElementById('ytq-failed').textContent = stats.failed || 0;
    const resetBtn = document.getElementById('ytq-reset-stuck-btn');
    if (resetBtn) resetBtn.style.display = (stats.processing || 0) > 0 ? '' : 'none';

    // Daily budget bar
    const daily = stats.daily || {};
    const budgetEl = document.getElementById('yt-daily-budget');
    if (budgetEl) {
        budgetEl.innerHTML = `
            <div class="yt-budget-row">
                <span class="yt-budget-title">Today's Activity</span>
                <span class="yt-budget-item">📥 <strong>${daily.queued || 0}</strong> queued</span>
                <span class="yt-budget-item">✅ <strong>${daily.processed || 0}</strong> processed</span>
                <span class="yt-budget-item">❌ <strong>${daily.failed || 0}</strong> failed</span>
                <span class="yt-budget-sep">|</span>
                <span class="yt-budget-item">📝 <strong>${daily.summaries || 0}</strong> summaries</span>
                <span class="yt-budget-item yt-budget-source">📄 ${daily.transcript || 0} transcript</span>
                <span class="yt-budget-item yt-budget-source">🏷️ ${daily.metadata || 0} metadata</span>
            </div>
        `;
    }

    // Highlight active stat card
    document.querySelectorAll('.yt-stat-clickable').forEach(c => c.classList.remove('yt-stat-selected'));
    if (statusFilter) {
        const labels = { pending: 0, processing: 1, done: 2, failed: 3 };
        const cards = document.querySelectorAll('.yt-stat-clickable');
        if (cards[labels[statusFilter]]) cards[labels[statusFilter]].classList.add('yt-stat-selected');
    }

    const items = res.items || [];
    _ytTotalItems = res.total || 0;
    if (!items.length) {
        container.innerHTML = '<p class="mon-empty">No videos found.</p>';
        const pag = document.getElementById('yt-pagination');
        if (pag) pag.style.display = 'none';
        return;
    }

    const _ytIsAdmin = currentUser && currentUser.role === 'admin';

    let html = `
        <table class="yt-table">
            <thead>
                <tr>
                    <th>Video</th>
                    <th>Channel</th>
                    <th>Status</th>
                    <th>Source</th>
                    ${_ytIsAdmin ? '<th>Cost</th>' : ''}
                    <th>Target</th>
                    <th>Sent</th>
                    <th>Created</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>`;

    for (const item of items) {
        const statusClass = {
            'pending': 'yt-status-pending',
            'processing': 'yt-status-processing',
            'done': 'yt-status-active',
            'failed': 'yt-status-inactive',
        }[item.status] || '';

        const title = item.title || item.video_id;
        const truncTitle = title.length > 50 ? title.substring(0, 50) + '…' : title;

        const sourceLabel = item.transcript_source
            ? ({ 'gemini_video': 'Video', 'transcript_api': 'Transcript', 'metadata': 'Metadata' }[item.transcript_source] || item.transcript_source)
            : '';

        // Cost estimate — Gemini 2.5 Flash Lite: $0.10/1M input, $0.40/1M output
        // Token estimation for gemini_video (1 FPS native video): ~299 tokens/sec
        let costCell = '<span class="text-muted">—</span>';
        if (item.status === 'done') {
            let inp = item.input_tokens || 0;
            let out = item.output_tokens || 0;
            if (!inp && item.transcript_source === 'gemini_video' && item.duration_secs) {
                inp = Math.round(item.duration_secs * 299);
            }
            if (inp || out) {
                const cost = (inp / 1_000_000) * 0.10 + (out / 1_000_000) * 0.40;
                const costStr = cost < 0.000001 ? '<$0.000001' : '$' + cost.toFixed(6);
                const tip = `In: ${inp.toLocaleString()} · Out: ${out.toLocaleString()} tokens`;
                costCell = `<span class="yt-cost-badge" title="${tip}">${costStr}</span>`;
            }
        }

        const sentBadge = item.status === 'done'
            ? (item.telegram_sent
                ? '<span class="yt-status-badge yt-status-active">Sent</span>'
                : '<span class="yt-status-badge yt-status-pending">Not sent</span>')
            : '<span class="text-muted">—</span>';

        const target = item.telegram_target
            ? `<span class="yt-filter-tag">${escapeHtml(item.telegram_target)}</span>`
            : '<span class="text-muted">—</span>';

        // Build action buttons based on status
        let actions = '';
        if (item.summary_id) {
            actions += `<button class="btn btn-secondary btn-sm" onclick="ytShowSummary(${item.summary_id})" title="View summary">👁️</button>`;
        }
        if (item.status === 'pending' || item.status === 'failed') {
            actions += `<button class="btn btn-secondary btn-sm" onclick="ytProcessOneItem(${item.id}, this)" title="Process now">▶</button>`;
        }
        if (item.status === 'failed') {
            actions += `<button class="btn btn-secondary btn-sm" onclick="ytRetryQueueItem(${item.id})" title="Retry">🔄</button>`;
        }
        if (item.error_log) {
            actions += `<button class="btn btn-secondary btn-sm" onclick="ytShowError(${item.id})" title="View error">⚠️</button>`;
        }
        actions += `<button class="btn btn-danger btn-sm" onclick="ytDeleteVideo(${item.id}, ${item.summary_id || 'null'})" title="Delete">🗑️</button>`;

        html += `
            <tr>
                <td>
                    <a href="https://youtube.com/watch?v=${item.video_id}" target="_blank" class="yt-vid-link" title="${escapeHtml(title)}">
                        ${escapeHtml(truncTitle)}
                    </a>
                </td>
                <td>${escapeHtml(item.channel_name || '—')}</td>
                <td><span class="yt-status-badge ${statusClass}">${item.status}</span></td>
                <td>${sourceLabel ? `<span class="yt-filter-tag">${sourceLabel}</span>` : '<span class="text-muted">—</span>'}</td>
                ${_ytIsAdmin ? `<td>${costCell}</td>` : ''}
                <td>${target}</td>
                <td>${sentBadge}</td>
                <td class="text-muted">${timeAgo(item.created_at)}</td>
                <td style="text-align:right;white-space:nowrap"><div class="yt-actions-cell">${actions}</div></td>
            </tr>`;
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Update pagination
    _ytTotalItems = res.total || items.length;
    _ytRenderPagination();
}

function _ytRenderPagination() {
    const pag = document.getElementById('yt-pagination');
    if (!pag) return;
    const totalPages = Math.max(1, Math.ceil(_ytTotalItems / _ytPageSize));
    if (_ytTotalItems <= _ytPageSize && _ytCurrentPage === 0) {
        pag.style.display = 'none';
        return;
    }
    pag.style.display = 'flex';
    document.getElementById('ytv-prev').disabled = _ytCurrentPage <= 0;
    document.getElementById('ytv-next').disabled = _ytCurrentPage >= totalPages - 1;
    document.getElementById('ytv-page-info').textContent = `Page ${_ytCurrentPage + 1} of ${totalPages} (${_ytTotalItems} items)`;
}

function ytGoToPage(page) {
    _ytCurrentPage = page;
    loadYtVideosData();
}

let _ytFilterDebounceTimer = null;
function ytDebouncedFilter() {
    clearTimeout(_ytFilterDebounceTimer);
    _ytFilterDebounceTimer = setTimeout(() => ytGoToPage(0), 400);
}

function ytPrevPage() {
    if (_ytCurrentPage > 0) { _ytCurrentPage--; loadYtVideosData(); }
}

function ytNextPage() {
    const totalPages = Math.ceil(_ytTotalItems / _ytPageSize);
    if (_ytCurrentPage < totalPages - 1) { _ytCurrentPage++; loadYtVideosData(); }
}

function ytFilterByStatus(status) {
    const sel = document.getElementById('ytv-filter-status');
    if (sel) {
        // Toggle: clicking the same status again clears the filter
        sel.value = sel.value === status ? '' : status;
    }
    _ytCurrentPage = 0;
    loadYtVideosData();
}

function ytClearFilters() {
    const ids = ['ytv-filter-status', 'ytv-filter-channel', 'ytv-filter-source', 'ytv-filter-date-from', 'ytv-filter-date-to'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    _ytCurrentPage = 0;
    loadYtVideosData();
}

function toggleYtQueueAutoRefresh(enabled) {
    if (_ytQueueInterval) {
        clearInterval(_ytQueueInterval);
        _ytQueueInterval = null;
    }
    if (enabled) {
        _ytQueueInterval = setInterval(() => {
            if (localStorage.getItem('activePage') === 'yt-videos') loadYtVideosData();
        }, 30000);
    }
}

async function ytRetryQueueItem(id) {
    await api('/api/youtube/queue/retry', { id });
    ytToast('Item re-queued for retry', 'success');
    loadYtVideosData();
}

async function ytResetStuck() {
    const res = await api('/api/youtube/queue/reset-stuck', {});
    if (res.status === 'ok') {
        ytToast(res.reset > 0 ? `Reset ${res.reset} stuck item(s) to Failed — you can now retry them` : 'No stuck items found', res.reset > 0 ? 'success' : 'info');
        loadYtVideosData();
    } else {
        ytToast('Reset failed', 'error');
    }
}

async function ytProcessOneItem(id, btn) {
    if (_ytProcessingCount >= _ytProcessingMax) {
        ytToast(`Max ${_ytProcessingMax} items processing at once — please wait`, 'warning');
        return;
    }
    _ytProcessingCount++;

    // Immediately reflect processing state in the row
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="yt-spin">⟳</span>';
        btn.title = 'Processing…';
        const row = btn.closest('tr');
        if (row) {
            const statusCell = row.querySelector('td:nth-child(3)');
            if (statusCell) statusCell.innerHTML = '<span class="yt-status-badge yt-status-processing">processing</span>';
        }
    }
    try {
        const res = await api('/api/youtube/queue/process-one', { id });
        if (res.status === 'ok') {
            ytToast(res.success ? 'Item processed successfully' : 'Processing failed', res.success ? 'success' : 'error');
        } else {
            ytToast(res.message || 'Processing failed', 'error');
        }
    } finally {
        _ytProcessingCount--;
        loadYtVideosData();
    }
}

async function ytShowError(queueId) {
    const res = await api(`/api/youtube/queue/${queueId}`);
    if (res.status !== 'ok') return ytToast('Failed to load details.', 'error');
    const item = res.item;

    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog-box yt-summary-modal">
            <div class="dialog-title">${escapeHtml(item.video_title || item.video_id)}</div>
            <div class="yt-summary-meta">
                <span>📊 ${item.status} (${item.attempts} attempts)</span>
                <span>🔗 <a href="https://youtube.com/watch?v=${item.video_id}" target="_blank">${item.video_id}</a></span>
            </div>
            <div style="margin-top:10px;"><strong>Error:</strong>
                <div class="yt-summary-text" style="max-height:40vh;color:var(--error);">${escapeHtml(item.error_log || 'No error details')}</div>
            </div>
            <div class="dialog-actions" style="justify-content:center;">
                <button class="btn btn-primary dialog-cancel">Close</button>
            </div>
        </div>
    `;
    overlay.querySelector('.dialog-cancel').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
}

async function ytDeleteVideo(queueId, summaryId) {
    showConfirm('Delete this video and its summary?', async () => {
        await api('/api/youtube/queue/delete', { id: queueId });
        if (summaryId) await api('/api/youtube/summaries/delete', { id: summaryId });
        ytToast('Video deleted', 'success');
        loadYtVideosData();
    });
}

async function ytClearAll() {
    showConfirm('Delete ALL videos and summaries? This cannot be undone.', async () => {
        const r1 = await api('/api/youtube/queue/clear', {});
        const r2 = await api('/api/youtube/summaries/clear', {});
        const total = (r1.deleted || 0) + (r2.deleted || 0);
        ytToast(`Cleared ${total} item(s)`, 'success');
        loadYtVideosData();
    });
}

async function ytTriggerProcessQueue() {
    ytToast('Processing queue…', 'info');
    const res = await api('/api/youtube/queue/process', {});
    if (res.status === 'ok') {
        ytToast(`Processed ${res.processed} item(s)`, 'success');
        loadYtVideosData();
    } else {
        ytToast('Processing failed: ' + (res.message || 'Unknown error'), 'error');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const cb = document.getElementById('yt-queue-autorefresh');
    if (cb && cb.checked) toggleYtQueueAutoRefresh(true);
});

async function ytShowSummary(id) {
    const res = await api(`/api/youtube/summaries/${id}`);
    if (res.status !== 'ok') return ytToast('Failed to load summary.', 'error');
    const s = res.summary;

    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog-box yt-summary-modal">
            <div class="dialog-title">${escapeHtml(s.title || 'Summary')}</div>
            <div class="yt-summary-meta">
                <span>📺 ${escapeHtml(s.channel_name || '—')}</span>
                <span>🔧 ${s.transcript_source || '—'}</span>
                <span>${s.telegram_sent ? '✅ Sent' : '⏳ Not sent'}${s.telegram_target ? ' → ' + escapeHtml(s.telegram_target) : ''}</span>
                <span>🔗 <a href="https://youtube.com/watch?v=${s.video_id}" target="_blank">${s.video_id}</a></span>
            </div>
            <div class="yt-summary-text">${escapeHtml(s.summary_text || '').replace(/\n/g, '<br>')}</div>
            <div class="dialog-actions" style="justify-content:center;">
                <button class="btn btn-primary dialog-cancel">Close</button>
            </div>
        </div>
    `;
    overlay.querySelector('.dialog-cancel').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
}


// ==================== Video Chat ====================

let _ytChatSessionId = null;
let _ytChatMessages = []; // {role, text, id, selected}

function ytChatInit() {
    // Focus the URL input when navigating to chat page
    const urlInput = document.getElementById('yt-chat-url');
    if (urlInput) setTimeout(() => urlInput.focus(), 100);
    _ytChatRestoreTgTarget();
    // Show plan badge (helper defined in chatbot.js)
    if (typeof _renderPlanBadge === 'function') _renderPlanBadge('yt-chat-plan-badge');
}

async function ytChatLoadVideo() {
    const urlInput = document.getElementById('yt-chat-url');
    const url = urlInput.value.trim();
    if (!url) return ytToast('Please enter a YouTube URL or video ID.', 'error');

    const loadBtn = document.getElementById('yt-chat-load-btn');
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading…';

    // End previous session if any
    if (_ytChatSessionId) {
        await api('/api/youtube/chat/end', { session_id: _ytChatSessionId });
        _ytChatSessionId = null;
        _ytChatMessages = [];
    }

    const res = await api('/api/youtube/chat/start', { url });
    loadBtn.disabled = false;
    loadBtn.textContent = 'Load Video';

    if (res.status !== 'ok') {
        ytToast(res.message || 'Failed to load video', 'error');
        return;
    }

    _ytChatSessionId = res.session.session_id;
    _ytChatMessages = [];

    // Show video info
    const infoEl = document.getElementById('yt-chat-video-info');
    const inputRow = document.querySelector('.yt-chat-video-input');
    const thumb = document.getElementById('yt-chat-thumb');
    const title = document.getElementById('yt-chat-video-title');
    const channel = document.getElementById('yt-chat-video-channel');

    if (res.session.thumbnail) {
        thumb.src = res.session.thumbnail;
        thumb.style.display = '';
    } else {
        thumb.style.display = 'none';
    }
    title.textContent = res.session.title || res.session.video_id;
    channel.textContent = res.session.channel_name || '';
    infoEl.style.display = 'flex';
    inputRow.style.display = 'none';

    // Show chat UI
    document.getElementById('yt-chat-input-bar').style.display = '';
    _ytChatRenderMessages();

    ytToast('Video loaded — start chatting!', 'success');
    document.getElementById('yt-chat-input').focus();
}

function ytChatReset() {
    if (_ytChatSessionId) {
        api('/api/youtube/chat/end', { session_id: _ytChatSessionId });
    }
    _ytChatSessionId = null;
    _ytChatMessages = [];

    document.getElementById('yt-chat-video-info').style.display = 'none';
    document.querySelector('.yt-chat-video-input').style.display = '';
    document.getElementById('yt-chat-input-bar').style.display = 'none';
    document.getElementById('yt-chat-url').value = '';
    _ytChatRenderMessages();
    _ytChatUpdateSelectedCount();
}

async function ytChatSend(text) {
    if (!_ytChatSessionId) return ytToast('No video loaded', 'error');

    const input = document.getElementById('yt-chat-input');
    const message = text || input.value.trim();
    if (!message) return;

    if (!text) input.value = '';

    // Hide suggestions after first message
    const suggestions = document.getElementById('yt-chat-suggestions');
    if (suggestions) suggestions.style.display = 'none';

    const msgId = Date.now();
    _ytChatMessages.push({ role: 'user', text: message, id: msgId, selected: false });

    // Add placeholder for AI response
    const replyId = msgId + 1;
    _ytChatMessages.push({ role: 'assistant', text: '', id: replyId, selected: false, loading: true });
    _ytChatRenderMessages();

    // Disable input while waiting
    const sendBtn = document.getElementById('yt-chat-send-btn');
    input.disabled = true;
    sendBtn.disabled = true;

    const res = await api('/api/youtube/chat/send', { session_id: _ytChatSessionId, message });

    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();

    // Update placeholder with actual reply
    const placeholder = _ytChatMessages.find(m => m.id === replyId);
    if (placeholder) {
        placeholder.loading = false;
        if (res.status === 'ok') {
            placeholder.text = res.reply;
        } else {
            _ytChatMessages = _ytChatMessages.filter(m => m.id !== replyId && m.id !== msgId);
            if (res.limit_reached && typeof _showLimitBanner === 'function') {
                _showLimitBanner('yt-chat-plan-badge', res.message);
            } else {
                ytToast(`Error: ${res.message || 'Failed to get response'}`, 'error');
            }
            _ytChatRenderMessages();
            return;
        }
    }
    _ytChatRenderMessages();
    if (typeof _usageWidgetDecrement === 'function') _usageWidgetDecrement('yt-chat-plan-badge');
}

function _ytChatRenderMessages() {
    const container = document.getElementById('yt-chat-messages');
    if (!_ytChatMessages.length) {
        container.innerHTML = `
            <div class="yt-chat-empty">
                <div class="yt-chat-empty-icon">💬</div>
                <p>Load a YouTube video to start chatting</p>
                <p class="text-muted">Ask questions, generate summaries, extract key points — all using the video's content</p>
            </div>`;
        return;
    }

    let html = '';
    for (const msg of _ytChatMessages) {
        if (msg.role === 'user') {
            html += `<div class="yt-chat-msg yt-chat-msg-user">
                <div class="yt-chat-msg-content">${escapeHtml(msg.text)}</div>
            </div>`;
        } else {
            const checkable = !msg.loading && !msg.error;
            html += `<div class="yt-chat-msg yt-chat-msg-ai ${msg.selected ? 'yt-chat-msg-selected' : ''}">
                <div class="yt-chat-msg-header">
                    ${checkable ? `<label class="yt-chat-msg-check">
                        <input type="checkbox" ${msg.selected ? 'checked' : ''} onchange="ytChatToggleSelect(${msg.id}, this.checked)">
                    </label>` : ''}
                    ${msg.loading ? '<span class="yt-chat-typing">Thinking…</span>' : ''}
                </div>
                <div class="yt-chat-msg-content ${msg.error ? 'yt-chat-msg-error' : ''}">
                    ${msg.loading ? '<div class="yt-chat-dots"><span></span><span></span><span></span></div>' : _ytChatFormatText(msg.text)}
                </div>
            </div>`;
        }
    }
    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

function _ytChatFormatText(text) {
    if (!text) return '';
    return marked.parse(text, { gfm: true, breaks: true });
}

function ytChatToggleSelect(msgId, checked) {
    const msg = _ytChatMessages.find(m => m.id === msgId);
    if (msg) msg.selected = checked;
    _ytChatRenderMessages();
    _ytChatUpdateSelectedCount();
}

function ytChatSelectAll() {
    _ytChatMessages.filter(m => m.role === 'assistant' && !m.loading && !m.error)
        .forEach(m => m.selected = true);
    _ytChatRenderMessages();
    _ytChatUpdateSelectedCount();
}

function ytChatDeselectAll() {
    _ytChatMessages.forEach(m => m.selected = false);
    _ytChatRenderMessages();
    _ytChatUpdateSelectedCount();
}

function _ytChatUpdateSelectedCount() {
    const count = _ytChatMessages.filter(m => m.selected).length;
    const el = document.getElementById('yt-chat-selected-count');
    if (el) el.textContent = `${count} selected`;
}

function ytChatMerge() {
    const selected = _ytChatMessages.filter(m => m.selected && m.role === 'assistant');
    if (!selected.length) return ytToast('Select at least one response to merge.', 'error');

    const merged = selected.map(m => m.text).join('\n\n---\n\n');
    document.getElementById('yt-chat-final-text').value = merged;
    ytToast(`Merged ${selected.length} response(s)`, 'success');
}

function ytChatCopyFinal() {
    const text = document.getElementById('yt-chat-final-text').value;
    if (!text) return ytToast('Nothing to copy', 'error');
    navigator.clipboard.writeText(text).then(() => ytToast('Copied to clipboard', 'success'));
}

function ytChatClearFinal() {
    document.getElementById('yt-chat-final-text').value = '';
}

async function ytChatRefine() {
    const textarea = document.getElementById('yt-chat-final-text');
    const text = textarea.value.trim();
    if (!text) return ytToast('Nothing to refine — merge some responses first.', 'error');

    ytToast('Refining…', 'info');
    const res = await api('/api/youtube/chat/refine', { text });
    if (res.status === 'ok') {
        textarea.value = res.result;
        ytToast('Message refined', 'success');
    } else {
        ytToast(res.message || 'Refine failed', 'error');
    }
}


async function ytChatSendTelegram() {
    const text = document.getElementById('yt-chat-final-text').value.trim();
    const target = document.getElementById('yt-chat-tg-target').value.trim();
    if (!text) return ytToast('Nothing to send — compose a message first.', 'error');
    if (!target) return ytToast('Enter a Telegram target (@channel or chat ID).', 'error');

    // Save target for reuse
    localStorage.setItem('yt_chat_tg_target', target);

    const res = await api('/api/youtube/chat/send-telegram', { text, target });
    if (res.status === 'ok') {
        ytToast(`Sent to ${target}`, 'success');
    } else {
        ytToast(res.message || 'Failed to send', 'error');
    }
}

// Restore saved telegram target on page load
function _ytChatRestoreTgTarget() {
    const saved = localStorage.getItem('yt_chat_tg_target');
    const input = document.getElementById('yt-chat-tg-target');
    if (saved && input) input.value = saved;
}


// ==================== Helpers ====================

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    return `${Math.floor(diff/86400)}d ago`;
}
