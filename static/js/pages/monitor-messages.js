// ==================== Monitor — Messages, Unclassified & Missed ====================
(function () {
    let _allMessages = [];

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
            if (!append) el.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message || 'Unknown error')}</p>`;
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
        populateMonMultiSelect('msg-filter-coll-wrap',    colls);
        populateMonMultiSelect('msg-filter-channel-wrap', channels);
        populateMonMultiSelect('msg-filter-topic-wrap',   topics);
        applyMonMessageFilters();
    }

    let _msgFlatView = false;

    function toggleMsgFlatView() {
        _msgFlatView = !_msgFlatView;
        const btn = document.getElementById('msg-flat-btn');
        if (btn) {
            btn.classList.toggle('btn-primary', _msgFlatView);
            btn.classList.toggle('btn-secondary', !_msgFlatView);
        }
        applyMonMessageFilters();
    }

    function applyMonMessageFilters() {
        const selColls    = getMonMsValues('msg-filter-coll-wrap');
        const selChannels = getMonMsValues('msg-filter-channel-wrap');
        const selTopics   = getMonMsValues('msg-filter-topic-wrap');
        const searchEl   = document.getElementById('msg-search');
        const dateFromEl = document.getElementById('msg-filter-date-from');
        const dateToEl   = document.getElementById('msg-filter-date-to');
        const search   = (searchEl?.value || '').trim().toLowerCase();
        const dateFrom = dateFromEl?.value || '';
        const dateTo   = dateToEl?.value   || '';

        let filtered = _allMessages;
        if (selColls.size > 0)    filtered = filtered.filter(m => selColls.has(m.collection || ''));
        if (selChannels.size > 0) filtered = filtered.filter(m => selChannels.has(`@${m.channel_username}`));
        if (selTopics.size > 0)   filtered = filtered.filter(m => (m.topics || '').split(',').map(t => t.trim()).some(t => selTopics.has(t)));
        if (search)   filtered = filtered.filter(m => (m.preview || '').toLowerCase().includes(search));
        if (dateFrom) filtered = filtered.filter(m => m.timestamp && m.timestamp.slice(0,10) >= dateFrom);
        if (dateTo)   filtered = filtered.filter(m => m.timestamp && m.timestamp.slice(0,10) <= dateTo);

        const el = document.getElementById('mon-messages-content');
        if (!filtered.length) {
            el.innerHTML = `<p class="mon-empty">${_allMessages.length ? 'No messages match the filters.' : 'No messages in DB yet.'}</p>`;
            return;
        }

        let html = '';

        if (_msgFlatView) {
            // Flat view: all messages sorted latest first, no grouping
            const sorted = [...filtered].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
            const rowsHtml = sorted.map(m => {
                const ts = _fmtLBN(m.timestamp);
                const ch = m.channel_username ? `@${m.channel_username}` : `id:${m.channel_id}`;
                const cname = m.collection || '—';
                const topicTags = _monTagsHtml(m.topics, 'topic');
                const catTags   = _monTagsHtml(m.categories, 'cat');
                const kwTags    = _monTagsHtml(m.keywords_found, '');
                return `<tr>
                    <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                    <td>${escapeHtml(ch)}</td>
                    <td>${escapeHtml(cname)}</td>
                    <td>${topicTags}</td>
                    <td>${catTags}</td>
                    <td>${kwTags}</td>
                    <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
                </tr>`;
            }).join('');
            html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;padding:0 4px;">${sorted.length} message${sorted.length===1?'':'s'}</div>
                <div style="overflow-x:auto;">
                <table class="mon-table">
                    <thead><tr><th>Time</th><th>Source</th><th>Collection</th><th>Topics</th><th>Categories</th><th>Keywords</th><th>Preview</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table></div>`;
        } else {
            // Grouped view: collection → channel → messages
            const grouped = {};
            for (const msg of filtered) {
                const c  = msg.collection || '—';
                const ch = msg.channel_username ? `@${msg.channel_username}` : `id:${msg.channel_id}`;
                if (!grouped[c])     grouped[c]     = {};
                if (!grouped[c][ch]) grouped[c][ch] = [];
                grouped[c][ch].push(msg);
            }

            html = Object.entries(grouped).map(([collName, channels]) => {
                const chHtml = Object.entries(channels).map(([chName, msgs]) => {
                    const rowsHtml = msgs.map(m => {
                        const ts = _fmtLBN(m.timestamp);
                        const topicTags = _monTagsHtml(m.topics, 'topic');
                        const catTags   = _monTagsHtml(m.categories, 'cat');
                        const kwTags    = _monTagsHtml(m.keywords_found, '');
                        return `<tr>
                            <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                            <td>${topicTags}</td>
                            <td>${catTags}</td>
                            <td>${kwTags}</td>
                            <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
                        </tr>`;
                    }).join('');
                    return `<div class="mon-ch-hdr">📢 ${escapeHtml(chName)} <span class="text-muted">(${msgs.length})</span></div>
                        <div style="overflow-x:auto;">
                        <table class="mon-table">
                            <thead><tr><th>Time</th><th>Topics</th><th>Categories</th><th>Keywords</th><th>Preview</th></tr></thead>
                            <tbody>${rowsHtml}</tbody>
                        </table></div>`;
                }).join('');
                return `<div class="mon-coll-hdr">📦 ${escapeHtml(collName)}</div>${chHtml}`;
            }).join('');
        }

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
    let _unclMessages    = [];
    let _unclGrouped     = false;
    let _unclFlatView    = false;
    let _unclClearedAt   = localStorage.getItem('mon-uncl-cleared-at') || null;

    function toggleUnclGroupView() {
        _unclGrouped = !_unclGrouped;
        if (_unclGrouped) _unclFlatView = false; // mutually exclusive
        const btn = document.getElementById('uncl-group-btn');
        const flatBtn = document.getElementById('uncl-flat-btn');
        if (btn) { btn.classList.toggle('btn-primary', _unclGrouped); btn.classList.toggle('btn-secondary', !_unclGrouped); }
        if (flatBtn) { flatBtn.classList.remove('btn-primary'); flatBtn.classList.add('btn-secondary'); }
        _renderUnclassified(_unclMessages);
    }

    function toggleUnclFlatView() {
        _unclFlatView = !_unclFlatView;
        if (_unclFlatView) _unclGrouped = false; // mutually exclusive
        const btn = document.getElementById('uncl-flat-btn');
        const grpBtn = document.getElementById('uncl-group-btn');
        if (btn) { btn.classList.toggle('btn-primary', _unclFlatView); btn.classList.toggle('btn-secondary', !_unclFlatView); }
        if (grpBtn) { grpBtn.classList.remove('btn-primary'); grpBtn.classList.add('btn-secondary'); }
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
        'من','في','على','إلى','عن','مع','هذا',' هذه','التي','الذي','ان','أن','لا','ما','هو','هي',
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

        // Apply cleared-at filter
        const clearedAtMs = _unclClearedAt ? new Date(_unclClearedAt).getTime() : null;
        let visible = clearedAtMs
            ? messages.filter(m => m.timestamp && new Date(m.timestamp).getTime() > clearedAtMs)
            : messages;

        // Apply multi-select filters (bot, collection, channel)
        const unclSelBots  = getMonMsValues('uncl-filter-bot-wrap');
        const unclSelColls = getMonMsValues('uncl-filter-coll-wrap');
        const unclSelCh    = getMonMsValues('uncl-filter-channel-wrap');
        if (unclSelBots.size  > 0) visible = visible.filter(m => unclSelBots.has(m.bot_name || ''));
        if (unclSelColls.size > 0) visible = visible.filter(m => unclSelColls.has(m.collection_name || ''));
        if (unclSelCh.size    > 0) visible = visible.filter(m => unclSelCh.has(`@${m.channel_username}`));

        // Apply date filters
        const dateFromEl = document.getElementById('uncl-filter-date-from');
        const dateToEl   = document.getElementById('uncl-filter-date-to');
        const dateFrom = dateFromEl?.value || '';
        const dateTo   = dateToEl?.value   || '';
        if (dateFrom) visible = visible.filter(m => m.timestamp && m.timestamp.slice(0,10) >= dateFrom);
        if (dateTo)   visible = visible.filter(m => m.timestamp && m.timestamp.slice(0,10) <= dateTo);

        // Populate channel multi-select from loaded data
        const chValues = [...new Set(messages.map(m => m.channel_username ? `@${m.channel_username}` : null).filter(Boolean))].sort();
        populateMonMultiSelect('uncl-filter-channel-wrap', chValues);

        if (!visible.length) {
            content.innerHTML = _unclClearedAt
                ? '<p class="mon-empty">No new unclassified messages since last clear. <button class="btn btn-sm btn-secondary" onclick="showAllUnclassifiedView()">Show all</button></p>'
                : '<p class="mon-empty">No unclassified messages found.</p>';
            return;
        }

        if (_unclFlatView) {
            _renderUnclFlat(visible, content);
        } else if (_unclGrouped) {
            _renderUnclGroupedByWords(visible, content);
        } else {
            _renderUnclByChannel(visible, content);
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

    function _renderUnclFlat(messages, content) {
        const sorted = [...messages].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        const rowsHtml = sorted.map(m => {
            const ts = _fmtLBN(m.timestamp);
            const ch = m.channel_username ? `@${m.channel_username}` : `id:${m.channel_id}`;
            const cname = m.collection_name || '—';
            const botTag = m.bot_name ? `<span class="mon-tag cat">${escapeHtml(m.bot_name)}</span>` : '—';
            return `<tr>
                <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                <td>${escapeHtml(ch)}</td>
                <td>${escapeHtml(cname)}</td>
                <td>${botTag}</td>
                <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
            </tr>`;
        }).join('');
        content.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;padding:0 4px;">${sorted.length} message${sorted.length===1?'':'s'}</div>
            <div style="overflow-x:auto;">
            <table class="mon-table">
                <thead><tr><th>Time</th><th>Source</th><th>Collection</th><th>Bot</th><th>Preview</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table></div>`;
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
                    const ts = _fmtLBN(m.timestamp);
                    const botTag = m.bot_name ? `<span class="mon-tag cat">${escapeHtml(m.bot_name)}</span>` : '—';
                    return `<tr>
                        <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                        <td>${botTag}</td>
                        <td class="mon-ellipsis" title="${escapeHtmlSys(m.preview || '')}">${escapeHtml(m.preview || '')}</td>
                    </tr>`;
                }).join('');
                return `<div class="mon-ch-hdr">📢 ${escapeHtml(chName)} <span class="text-muted">(${msgs.length})</span></div>
                    <div style="overflow-x:auto;">
                    <table class="mon-table">
                        <thead><tr><th>Time</th><th>Bot</th><th>Preview</th></tr></thead>
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
                const ts = _fmtLBN(m.timestamp);
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
                const ts = _fmtLBN(m.timestamp);
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

    function _reRenderUnclassified() { _renderUnclassified(_unclMessages); }

    async function loadUnclassifiedMessages(append = false) {
        const content = document.getElementById('mon-uncl-content');
        if (!append) {
            _unclOffset = 0;
            _unclHasMore = true;
            _unclMessages = [];
            _unclInitialized = false;
            // Clear multi-select state so dropdowns rebuild from fresh data
            ['uncl-filter-bot-wrap', 'uncl-filter-coll-wrap', 'uncl-filter-channel-wrap'].forEach(w => {
                _getMonMs(w).clear();
                _updateMonMsBtn(w);
                const dd = document.getElementById(w.replace('-wrap', '-dd'));
                if (dd) dd.innerHTML = '';
            });
            content.innerHTML = '<p class="mon-empty">Loading…</p>';
        }
        const scrollY = window.scrollY;

        const search = document.getElementById('uncl-search')?.value?.trim() || '';

        let url = `/api/monitor/unclassified?limit=${_UNCL_PAGE_SIZE}&offset=${_unclOffset}`;
        if (search)         url += `&search=${encodeURIComponent(search)}`;
        if (_unclClearedAt) url += `&since=${encodeURIComponent(_unclClearedAt)}`;

        const data = await api(url);
        if (data.status !== 'ok') {
            if (!append) content.innerHTML = `<p class="mon-empty" style="color:var(--danger);">Error: ${escapeHtml(data.message || 'Unknown error')}</p>`;
            return;
        }

        const newMsgs = data.messages || [];
        const stats = data.stats    || [];
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

        // Populate bot/collection multi-selects (only once per load)
        if (!_unclInitialized) {
            const bots  = [...new Set(stats.map(s => s.bot_name).filter(Boolean))].sort();
            const colls = [...new Set(stats.map(s => s.collection_name).filter(Boolean))].sort();
            populateMonMultiSelect('uncl-filter-bot-wrap',  bots);
            populateMonMultiSelect('uncl-filter-coll-wrap', colls);
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

    // --- Unclassified clear/show-all ---
    function clearUnclassifiedView() {
        _unclClearedAt = new Date().toISOString();
        localStorage.setItem('mon-uncl-cleared-at', _unclClearedAt);
        document.getElementById('uncl-showall-btn').style.display = '';
        // Reset badge immediately — background poll will fetch only new messages
        const badge = document.getElementById('mon-uncl-badge');
        if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
        _renderUnclassified(_unclMessages);
    }

    function showAllUnclassifiedView() {
        _unclClearedAt = null;
        localStorage.removeItem('mon-uncl-cleared-at');
        document.getElementById('uncl-showall-btn').style.display = 'none';
        _renderUnclassified(_unclMessages);
    }

    // ---------- Missed messages ----------
    let _missedMessages  = [];
    let _missedOffset    = 0;
    let _missedHasMore   = true;
    let _missedClearedAt = localStorage.getItem('mon-missed-cleared-at') || null;
    let _missedFlatView  = false;
    const _MISSED_PAGE_SIZE = 50;

    function toggleMissedFlatView() {
        _missedFlatView = !_missedFlatView;
        const btn = document.getElementById('missed-flat-btn');
        if (btn) { btn.classList.toggle('btn-primary', _missedFlatView); btn.classList.toggle('btn-secondary', !_missedFlatView); }
        _renderMissed(_missedMessages);
    }

    function _reRenderMissed() { _renderMissed(_missedMessages); }

    async function loadMissedMessages(append = false) {
        const content = document.getElementById('mon-missed-content');
        if (!append) {
            _missedOffset   = 0;
            _missedHasMore  = true;
            _missedMessages = [];
            // Clear multi-select state so dropdowns rebuild from fresh data
            ['missed-filter-bot-wrap', 'missed-filter-topic-wrap', 'missed-filter-channel-wrap'].forEach(w => {
                _getMonMs(w).clear();
                _updateMonMsBtn(w);
                const dd = document.getElementById(w.replace('-wrap', '-dd'));
                if (dd) dd.innerHTML = '';
            });
            if (content) content.innerHTML = '<p class="mon-empty">Loading…</p>';
        }
        const scrollY = window.scrollY;

        const search = document.getElementById('missed-search')?.value || '';

        let url = `/api/monitor/missed?limit=${_MISSED_PAGE_SIZE}&offset=${_missedOffset}`;
        if (search)           url += `&search=${encodeURIComponent(search)}`;
        if (_missedClearedAt) url += `&since=${encodeURIComponent(_missedClearedAt)}`;

        const data = await api(url);
        if (!data || data.status !== 'ok') return;

        const newMsgs = data.messages || [];
        const stats   = data.stats    || [];
        _missedHasMore = newMsgs.length === _MISSED_PAGE_SIZE;
        _missedMessages = _missedMessages.concat(newMsgs);
        _missedOffset  += newMsgs.length;

        // Populate bot/topic multi-selects on first load
        if (!append) {
            const bots   = [...new Set(_missedMessages.map(m => m.bot_name).filter(Boolean))].sort();
            const topics = [...new Set(_missedMessages.map(m => m.topic_name).filter(Boolean))].sort();
            populateMonMultiSelect('missed-filter-bot-wrap',   bots);
            populateMonMultiSelect('missed-filter-topic-wrap', topics);
        }

        // Update badge
        const totalMissed = stats.reduce((s, r) => s + (r.cnt || 0), 0);
        const badge = document.getElementById('mon-missed-badge');
        if (badge) { badge.textContent = totalMissed; badge.style.display = totalMissed > 0 ? 'inline-block' : 'none'; }

        // Render stats bar
        const statsEl = document.getElementById('mon-missed-stats');
        if (statsEl) {
            statsEl.innerHTML = stats.length
                ? `<div class="mon-uncl-stats-bar">${stats.map(s =>
                    `<span class="yt-filter-tag">${escapeHtml(s.bot_name || '?')} / ${escapeHtml(s.topic_name || '?')}: <strong>${s.cnt}</strong></span>`
                  ).join('')}</div>`
                : '';
        }

        _renderMissed(_missedMessages);
        window.scrollTo(0, scrollY);
    }

    function _renderMissed(messages) {
        const content = document.getElementById('mon-missed-content');
        if (!content) return;

        // Apply cleared-at filter
        const missedClearedAtMs = _missedClearedAt ? new Date(_missedClearedAt).getTime() : null;
        let visible = missedClearedAtMs
            ? messages.filter(m => m.timestamp && new Date(m.timestamp).getTime() > missedClearedAtMs)
            : messages;

        // Apply multi-select filters (bot, topic, channel)
        const missedSelBots   = getMonMsValues('missed-filter-bot-wrap');
        const missedSelTopics = getMonMsValues('missed-filter-topic-wrap');
        const missedSelCh     = getMonMsValues('missed-filter-channel-wrap');
        if (missedSelBots.size   > 0) visible = visible.filter(m => missedSelBots.has(m.bot_name || ''));
        if (missedSelTopics.size > 0) visible = visible.filter(m => missedSelTopics.has(m.topic_name || ''));
        if (missedSelCh.size     > 0) visible = visible.filter(m => missedSelCh.has(`@${m.channel_username}`));

        // Apply date filters
        const missedFromEl = document.getElementById('missed-filter-date-from');
        const missedToEl   = document.getElementById('missed-filter-date-to');
        const dateFrom = missedFromEl?.value || '';
        const dateTo   = missedToEl?.value   || '';
        if (dateFrom) visible = visible.filter(m => m.timestamp && m.timestamp.slice(0,10) >= dateFrom);
        if (dateTo)   visible = visible.filter(m => m.timestamp && m.timestamp.slice(0,10) <= dateTo);

        // Populate channel multi-select from loaded data
        const missedChValues = [...new Set(messages.map(m => m.channel_username ? `@${m.channel_username}` : null).filter(Boolean))].sort();
        populateMonMultiSelect('missed-filter-channel-wrap', missedChValues);

        if (!visible.length) {
            content.innerHTML = _missedClearedAt
                ? '<p class="mon-empty">No new missed messages since last clear. <button class="btn btn-sm btn-secondary" onclick="showAllMissedView()">Show all</button></p>'
                : '<p class="mon-empty">No missed messages found.</p>';
            return;
        }

        let html = '';

        if (_missedFlatView) {
            // Flat view: all messages sorted latest first
            const sorted = [...visible].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
            const rows = sorted.map(m => {
                const ts = _fmtLBN(m.timestamp);
                const ch = m.channel_username ? `@${m.channel_username}` : String(m.channel_id || '?');
                return `<tr>
                    <td style="white-space:nowrap;font-size:11px;">${ts}</td>
                    <td><span class="mon-tag">${escapeHtml(ch)}</span></td>
                    <td>${escapeHtml(m.bot_name || '—')}</td>
                    <td>${escapeHtml(m.topic_name || '—')}</td>
                    <td><span class="mon-tag cat">${escapeHtml(m.schedule_type || '—')}</span></td>
                    <td class="mon-ellipsis">${escapeHtml(m.preview || '—')}</td>
                </tr>`;
            }).join('');
            html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;padding:0 4px;">${sorted.length} message${sorted.length===1?'':'s'}</div>
                <div style="overflow-x:auto;">
                <table class="mon-table">
                    <thead><tr><th>Time</th><th>Source</th><th>Bot</th><th>Topic</th><th>Schedule</th><th>Preview</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table></div>`;
        } else {
            // Grouped view: bot › topic
            const groups = {};
            for (const m of visible) {
                const key = `${m.bot_name || '?'} › ${m.topic_name || '?'}`;
                if (!groups[key]) groups[key] = [];
                groups[key].push(m);
            }
            for (const [key, msgs] of Object.entries(groups)) {
                const rows = msgs.map(m => `
                    <tr>
                        <td style="white-space:nowrap;font-size:11px;">${_fmtLBN(m.timestamp)}</td>
                        <td><span class="mon-tag">${escapeHtml(m.channel_username || String(m.channel_id || '?'))}</span></td>
                        <td><span class="mon-tag cat">${escapeHtml(m.schedule_type || '—')}</span></td>
                        <td class="mon-ellipsis">${escapeHtml(m.preview || '—')}</td>
                    </tr>`).join('');
                html += `<div class="mon-ch-hdr">⏭ ${escapeHtml(key)} <span style="font-size:11px;color:var(--text-muted);font-weight:400;">(${msgs.length})</span></div>
                    <div style="overflow-x:auto;">
                    <table class="mon-table">
                        <thead><tr><th>Time</th><th>Source</th><th>Schedule</th><th>Preview</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table></div>`;
            }
        }

        content.innerHTML = html;

        if (_missedHasMore) {
            content.insertAdjacentHTML('beforeend', `<div style="text-align:center;padding:16px;">
                <button class="btn btn-secondary" onclick="loadMissedMessages(true)">Load more…</button>
                <span class="text-muted" style="margin-left:8px;font-size:12px;">${_missedMessages.length} loaded</span>
            </div>`);
        }
    }

    function clearMissedView() {
        _missedClearedAt = new Date().toISOString();
        localStorage.setItem('mon-missed-cleared-at', _missedClearedAt);
        document.getElementById('missed-showall-btn').style.display = '';
        // Reset badge immediately — background poll will fetch only new messages
        const badge = document.getElementById('mon-missed-badge');
        if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
        // Reset stats bar
        const statsEl = document.getElementById('mon-missed-stats');
        if (statsEl) statsEl.innerHTML = '';
        _renderMissed(_missedMessages);
    }

    function showAllMissedView() {
        _missedClearedAt = null;
        localStorage.removeItem('mon-missed-cleared-at');
        document.getElementById('missed-clear-btn').style.display   = '';
        document.getElementById('missed-showall-btn').style.display = 'none';
        _renderMissed(_missedMessages);
    }

    // ==================== Export to CSV ====================

    const _EXPORT_COLS = {
        summaries: [
            { key: 'time',    label: 'Time' },
            { key: 'bot',     label: 'Bot' },
            { key: 'topic',   label: 'Topic' },
            { key: 'type',    label: 'Type' },
            { key: 'msgs',    label: 'Messages Count' },
            { key: 'target',  label: 'Target' },
            { key: 'preview', label: 'Preview' },
        ],
        schedules_24h: [
            { key: 'time',    label: 'Fire Time' },
            { key: 'bot',     label: 'Bot' },
            { key: 'topic',   label: 'Topic' },
            { key: 'type',    label: 'Type' },
            { key: 'name',    label: 'Schedule Name' },
            { key: 'pending', label: 'Pending Messages' },
        ],
        mon_summaries: [
            { key: 'bot',     label: 'Bot' },
            { key: 'topic',   label: 'Topic' },
            { key: 'type',    label: 'Type' },
            { key: 'start',   label: 'Start Time' },
            { key: 'end',     label: 'End Time' },
            { key: 'repeats', label: 'Repeats' },
            { key: 'sent',    label: 'Sent Today' },
            { key: 'failed',  label: 'Failed Today' },
            { key: 'remain',  label: 'Remaining' },
            { key: 'total',   label: 'Total / Day' },
        ],
        history: [
            { key: 'time',    label: 'Time' },
            { key: 'bot',     label: 'Bot' },
            { key: 'topic',   label: 'Topic' },
            { key: 'type',    label: 'Type' },
            { key: 'status',  label: 'Status' },
            { key: 'msgs',    label: 'Messages' },
            { key: 'prompt',  label: 'Prompt' },
            { key: 'error',   label: 'Error' },
        ],
        messages: [
            { key: 'time',       label: 'Time' },
            { key: 'collection', label: 'Collection' },
            { key: 'channel',    label: 'Channel' },
            { key: 'topics',     label: 'Topics' },
            { key: 'categories', label: 'Categories' },
            { key: 'keywords',   label: 'Keywords' },
            { key: 'preview',    label: 'Preview' },
        ],
        unclassified: [
            { key: 'time',       label: 'Time' },
            { key: 'collection', label: 'Collection' },
            { key: 'channel',    label: 'Channel' },
            { key: 'bot',        label: 'Bot' },
            { key: 'preview',    label: 'Preview' },
        ],
        history_messages: [
            { key: 'time',     label: 'Time' },
            { key: 'source',   label: 'Source' },
            { key: 'topics',   label: 'Topics' },
            { key: 'keywords', label: 'Keywords' },
            { key: 'message',  label: 'Message' },
        ],
    };


    function applyMonUnclassFilters() { loadUnclassifiedMessages(); }
    function applyMonMissedFilters()  { loadMissedMessages(); }

    // ── Bridge functions (used by monitor-core + monitor-export) ──────────────
    window._monMessagesReady    = function () { return _allMessages.length > 0; };
    window._unclMessagesReady   = function () { return _unclMessages.length > 0; };
    window._missedMessagesReady = function () { return _missedMessages.length > 0; };
    window._getAllMessages       = function () { return _allMessages; };
    window._getUnclMessages     = function () { return _unclMessages; };
    window._getUnclClearedAt    = function () { return _unclClearedAt; };

    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window.loadMonitorMessages      = loadMonitorMessages;
    window.toggleMsgFlatView        = toggleMsgFlatView;
    window.applyMonMessageFilters   = applyMonMessageFilters;
    window._populateMonSelect       = _populateMonSelect;
    window.toggleUnclGroupView      = toggleUnclGroupView;
    window.toggleUnclFlatView       = toggleUnclFlatView;
    window._reRenderUnclassified    = _reRenderUnclassified;
    window.loadUnclassifiedMessages = loadUnclassifiedMessages;
    window.clearUnclassifiedView    = clearUnclassifiedView;
    window.showAllUnclassifiedView  = showAllUnclassifiedView;
    window.toggleMissedFlatView     = toggleMissedFlatView;
    window._reRenderMissed          = _reRenderMissed;
    window.loadMissedMessages       = loadMissedMessages;
    window.clearMissedView          = clearMissedView;
    window.showAllMissedView        = showAllMissedView;
    window.applyMonUnclassFilters   = applyMonUnclassFilters;
    window.applyMonMissedFilters    = applyMonMissedFilters;
})();
