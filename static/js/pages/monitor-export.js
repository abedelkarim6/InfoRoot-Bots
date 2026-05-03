// ==================== Monitor — Export to CSV ====================
(function () {
    let _exportTab = null;

    function openExportModal(tabName) {
        _exportTab = tabName;
        const cols = _EXPORT_COLS[tabName] || [];

        const tabLabels = {
            summaries:        'Summaries',
            schedules_24h:    'Schedules (next 24h)',
            mon_summaries:    'Monitor Summaries',
            history:          'Schedule History',
            messages:         'Messages',
            unclassified:     'Unclassified',
            history_messages: 'History Source Messages',
        };
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
        const selBots   = getMonMsValues('sum-filter-bot-wrap');
        const selTopics = getMonMsValues('sum-filter-topic-wrap');
        const selTypes  = getMonMsValues('sum-filter-type-wrap');
        const search = (document.getElementById('sum-search')?.value || '').trim().toLowerCase();
        let d = (typeof _getAllSummaries === 'function' ? _getAllSummaries() : []);
        if (selBots.size   > 0) d = d.filter(s => selBots.has(s.bot_name || ''));
        if (selTopics.size > 0) d = d.filter(s => selTopics.has(s.topic_name || ''));
        if (selTypes.size  > 0) d = d.filter(s => selTypes.has(s.summary_type || ''));
        if (search) d = d.filter(s => (s.preview || '').toLowerCase().includes(search));
        return d;
    }

    function _getExportMessages() {
        const selColls    = getMonMsValues('msg-filter-coll-wrap');
        const selChannels = getMonMsValues('msg-filter-channel-wrap');
        const selTopics   = getMonMsValues('msg-filter-topic-wrap');
        const search  = (document.getElementById('msg-search')?.value || '').trim().toLowerCase();
        let d = (typeof _getAllMessages === 'function' ? _getAllMessages() : []);
        if (selColls.size    > 0) d = d.filter(m => selColls.has(m.collection || ''));
        if (selChannels.size > 0) d = d.filter(m => selChannels.has(`@${m.channel_username}`));
        if (selTopics.size   > 0) d = d.filter(m => (m.topics || '').split(',').map(t => t.trim()).some(t => selTopics.has(t)));
        if (search)  d = d.filter(m => (m.preview || '').toLowerCase().includes(search));
        return d;
    }

    function _getExportUnclassified() {
        const _ua = typeof _getUnclMessages  === 'function' ? _getUnclMessages()  : [];
        const _uc = typeof _getUnclClearedAt === 'function' ? _getUnclClearedAt() : null;
        const clearedAtMs = _uc ? new Date(_uc).getTime() : null;
        return clearedAtMs
            ? _ua.filter(m => m.timestamp && new Date(m.timestamp).getTime() > clearedAtMs)
            : _ua;
    }

    function _doExport(tabName, selectedKeys) {
        const colDefs = (_EXPORT_COLS[tabName] || []).filter(c => selectedKeys.includes(c.key));
        let rows = [];

        if (tabName === 'summaries') {
            rows = _getExportSummaries().map(s => colDefs.map(c => {
                switch (c.key) {
                    case 'time':    return s.timestamp ? _fmtLBN(s.timestamp) : '';
                    case 'bot':     return s.bot_name    || '';
                    case 'topic':   return s.topic_name  || '';
                    case 'type':    return s.summary_type || '';
                    case 'msgs':    return s.message_count ?? '';
                    case 'target':  return s.target_entity || '';
                    case 'preview': return s.preview || '';
                    default: return '';
                }
            }));
        } else if (tabName === 'schedules_24h') {
            const nowMs = Date.now();
            const selBots2   = getMonMsValues('sch-filter-bot-wrap');
            const selTopics  = getMonMsValues('sch-filter-topic-wrap');
            const selPrompts = getMonMsValues('sch-filter-prompt-wrap');
            let items = _monSchFlat.filter(r => r.botEnabled !== false && r.topicEnabled !== false && r.sch.enabled !== false);
            if (selBots2.size  > 0) items = items.filter(r => selBots2.has(r.botName));
            if (selTopics.size  > 0) items = items.filter(r => selTopics.has(r.topicName));
            if (selPrompts.size > 0) items = items.filter(r => selPrompts.has(r.sch.prompt_key || ''));
            const fires = [];
            for (const item of items) {
                getUpcomingFires24h(item.sch, nowMs).forEach((fireAt, idx) => {
                    fires.push({ fireAt, ...item, pending: idx === 0 ? item.pending : 0 });
                });
            }
            fires.sort((a, b) => a.fireAt - b.fireAt);
            rows = fires.map(({ fireAt, botName, topicName, sch, pending }) => colDefs.map(c => {
                switch (c.key) {
                    case 'time':    return _fmtLBN(fireAt);
                    case 'bot':     return botName   || '';
                    case 'topic':   return topicName || '';
                    case 'type':    return sch.type  || '';
                    case 'name':    return sch.name  || '';
                    case 'pending': return pending ?? 0;
                    default: return '';
                }
            }));
        } else if (tabName === 'mon_summaries') {
            const selBots   = getMonMsValues('sum-filter-bot-wrap');
            const selTopics = getMonMsValues('sum-filter-topic-wrap');
            const selTypes  = getMonMsValues('sum-filter-type-wrap');
            const botsData  = (getMonitorData?.() || {}).bots || {};
            const statsLookup = {};
            for (const s of _scheduleStats) {
                statsLookup[`${s.bot_name}|${s.topic_name}|${s.schedule_type}`] = { sent: s.sent || 0, failed: s.failed || 0 };
            }
            const sumRows = [];
            for (const [botName, botData] of Object.entries(botsData)) {
                if (selBots.size > 0 && !selBots.has(botName)) continue;
                if (!botData.enabled) continue;
                for (const [, catData] of Object.entries(botData.categories || {})) {
                    if (!catData.enabled) continue;
                    for (const [topicName, topicData] of Object.entries(catData.topics || {})) {
                        if (selTopics.size > 0 && !selTopics.has(topicName)) continue;
                        if (!topicData.enabled) continue;
                        for (const sch of (topicData.schedules || [])) {
                            if (!sch.enabled) continue;
                            if (selTypes.size > 0 && !selTypes.has(sch.type || '')) continue;
                            const stat   = statsLookup[`${botName}|${topicName}|${sch.type}`] || { sent: 0, failed: 0 };
                            const total  = _scheduleFiresPerDay(sch);
                            const remain = Math.max(0, total - stat.sent - stat.failed);
                            sumRows.push({ botName, topicName, sch, stat, total, remain });
                        }
                    }
                }
            }
            rows = sumRows.map(({ botName, topicName, sch, stat, total, remain }) => colDefs.map(c => {
                switch (c.key) {
                    case 'bot':     return botName   || '';
                    case 'topic':   return topicName || '';
                    case 'type':    return sch.type  || '';
                    case 'start':   return _scheduleStartTime(sch);
                    case 'end':     return _scheduleEndTime(sch);
                    case 'repeats': return _scheduleRepeatsText(sch);
                    case 'sent':    return stat.sent;
                    case 'failed':  return stat.failed;
                    case 'remain':  return remain;
                    case 'total':   return total;
                    default: return '';
                }
            }));
        } else if (tabName === 'history') {
            const selBots   = getMonMsValues('hist-filter-bot-wrap');
            const selTopics = getMonMsValues('hist-filter-topic-wrap');
            const selStatus = getMonMsValues('hist-filter-status-wrap');
            let runs = _getHistoryRuns();
            if (selBots.size   > 0) runs = runs.filter(r => selBots.has(r.bot_name   || ''));
            if (selTopics.size > 0) runs = runs.filter(r => selTopics.has(r.topic_name || ''));
            if (selStatus.size > 0) runs = runs.filter(r => selStatus.has(r.status    || ''));
            rows = runs.map(r => colDefs.map(c => {
                switch (c.key) {
                    case 'time':   return r.fired_at ? _fmtLBN(r.fired_at) : '';
                    case 'bot':    return r.bot_name    || '';
                    case 'topic':  return r.topic_name  || '';
                    case 'type':   return r.schedule_type || '';
                    case 'status': return r.status      || '';
                    case 'msgs':   return r.message_count ?? '';
                    case 'prompt': return r.prompt_key  || '';
                    case 'error':  return r.error_text  || '';
                    default: return '';
                }
            }));
        } else if (tabName === 'messages') {
            rows = _getExportMessages().map(m => colDefs.map(c => {
                switch (c.key) {
                    case 'time':       return m.timestamp ? _fmtLBN(m.timestamp) : '';
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
                    case 'time':       return m.timestamp ? _fmtLBN(m.timestamp) : '';
                    case 'collection': return m.collection_name || '';
                    case 'channel':    return m.channel_username ? `@${m.channel_username}` : '';
                    case 'bot':        return m.bot_name || '';
                    case 'preview':    return m.preview || '';
                    default: return '';
                }
            }));
        } else if (tabName === 'history_messages') {
            const search = (document.getElementById('hmsg-search')?.value || '').toLowerCase();
            const source = document.getElementById('hmsg-filter-source')?.value || '';
            let d = _getHistMsgData();
            if (search) d = d.filter(m => (m.preview || '').toLowerCase().includes(search));
            if (source) d = d.filter(m => m.channel_username === source);
            rows = d.map(m => colDefs.map(c => {
                switch (c.key) {
                    case 'time':     return m.timestamp ? _fmtLBN(m.timestamp) : '';
                    case 'source':   return m.channel_username ? `@${m.channel_username}` : '';
                    case 'topics':   return m.topics || '';
                    case 'keywords': return m.keywords_found || '';
                    case 'message':  return m.preview || '';
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
        const fileLabel = { schedules_24h: 'schedules_24h', mon_summaries: 'monitor_summaries', history: 'schedule_history', history_messages: 'history_source_messages' }[tabName] || tabName;
        a.download = `${fileLabel}_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Sync "Select all" when individual checkboxes change
    document.addEventListener('change', e => {
        if (e.target.name === 'export-col') _syncExportAllCheckbox();
    });


    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window.openExportModal      = openExportModal;
    window.closeExportModal     = closeExportModal;
    window.toggleAllExportCols  = toggleAllExportCols;
    window.confirmExport        = confirmExport;
})();
