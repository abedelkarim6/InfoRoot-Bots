// ==================== Recycle Bin ====================
(function () {
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

        const grouped = {};
        items.forEach(item => {
            const t = item.entity_type;
            if (!grouped[t]) grouped[t] = [];
            grouped[t].push(item);
        });

        let html = '';
        for (const [type, typeItems] of Object.entries(grouped)) {
            const icon  = _rbTypeIcons[type]  || '📎';
            const label = _rbTypeLabels[type] || type;
            html += `<div class="rb-group">
                <h3 class="rb-group-title">${icon} ${label}s (${typeItems.length})</h3>`;
            typeItems.forEach(item => {
                const age      = _rbTimeAgo(item.deleted_at);
                const daysLeft = _rbDaysLeft(item.deleted_at);
                const detail   = _rbDetail(item);
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
        const expiry  = deleted + 5 * 24 * 60 * 60 * 1000;
        const left    = expiry - Date.now();
        if (left <= 0) return 'Expiring soon';
        const days = Math.ceil(left / (24 * 60 * 60 * 1000));
        return `${days}d left`;
    }

    function _rbDetail(item) {
        const d    = item.entity_data;
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
            const kws  = (d.keywords  || []).length;
            const schs = (d.schedules || []).length;
            return `${kws} keywords, ${schs} schedules`;
        }
        if (type === 'collection') {
            const src = (d.source_channels || []).length;
            const tgt = (d.target_channels || []).length;
            return `${src} sources, ${tgt} targets`;
        }
        if (type === 'prompt')     return d.bot_name || '';
        if (type === 'schedule')   return `${d.bot_name}/${d.topic_name}`;
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

    // ── Exports ────────────────────────────────────────────────────────────────
    window.loadRecycleBinData    = loadRecycleBinData;
    window.restoreRecycleBinItem = restoreRecycleBinItem;
    window.deleteRecycleBinItem  = deleteRecycleBinItem;
    window.emptyRecycleBin       = emptyRecycleBin;
})();
