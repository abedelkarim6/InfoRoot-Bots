// ==================== Global Search ====================
(function () {
    let _searchDebounceTimer = null;
    let _searchResults       = [];
    let _searchSelectedIndex = -1;

    function buildSearchIndex() {
        const index = [];
        if (!globalConfig) return index;

        const bots = globalConfig.bots || {};
        for (const [botName, bot] of Object.entries(bots)) {
            const cats     = bot.categories || {};
            const catCount = Object.keys(cats).length;
            index.push({ type: 'bot', label: botName, subtitle: `Bot · ${catCount} categor${catCount === 1 ? 'y' : 'ies'}`, icon: '🤖', page: 'bots', botName, openIds: [] });

            for (const [catName, cat] of Object.entries(cats)) {
                const catId      = `category-${botName}-${catName}`;
                const topicCount = Object.keys(cat.topics || {}).length;
                index.push({ type: 'category', label: catName, subtitle: `Category in ${botName} · ${topicCount} topic${topicCount === 1 ? '' : 's'}`, icon: '🗂️', page: 'bots', botName, openIds: [catId] });

                for (const [topicName, topic] of Object.entries(cat.topics || {})) {
                    const topicId = `topic-${botName}-${catName}-${topicName}`;
                    index.push({ type: 'topic', label: topicName, subtitle: `Topic in ${catName} › ${botName}`, icon: '📌', page: 'bots', botName, openIds: [catId, topicId] });

                    for (const kw of (topic.keywords || [])) {
                        index.push({ type: 'keyword', label: kw, subtitle: `SEO in ${topicName} › ${catName}`, icon: '🔎', page: 'bots', botName, openIds: [catId, topicId] });
                    }
                }
            }
        }

        const collections = globalConfig.collections || {};
        for (const [collName, coll] of Object.entries(collections)) {
            const safeId   = 'coll-card-' + collName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const srcCount = (coll.source_channels || []).length;
            index.push({ type: 'collection', label: collName, subtitle: `Collection · ${srcCount} source${srcCount === 1 ? '' : 's'}`, icon: '📦', page: 'collections', scrollTo: safeId });

            for (const src of (coll.source_channels || [])) {
                index.push({ type: 'source', label: src, subtitle: `Source channel in ${collName}`, icon: '📡', page: 'collections', scrollTo: safeId });
            }
            const targets = [coll.target_channel, ...(coll.target_channels || [])].filter(Boolean);
            for (const tgt of [...new Set(targets)]) {
                index.push({ type: 'target', label: tgt, subtitle: `Target channel in ${collName}`, icon: '📤', page: 'collections', scrollTo: safeId });
            }
        }

        return index;
    }

    function handleSearchInput(query) {
        clearTimeout(_searchDebounceTimer);
        const clearBtn = document.getElementById('global-search-clear');
        if (clearBtn) clearBtn.style.display = query ? '' : 'none';
        if (!query.trim()) { hideSearchResults(); return; }
        _searchDebounceTimer = setTimeout(() => performSearch(query.trim()), 150);
    }

    function performSearch(query) {
        const index = buildSearchIndex();
        const q     = query.toLowerCase();
        _searchResults = index.filter(item =>
            item.label.toLowerCase().includes(q) || item.subtitle.toLowerCase().includes(q)
        ).slice(0, 25);
        renderSearchResults(_searchResults, query);
    }

    function _highlightMatch(text, query) {
        const q   = query.toLowerCase();
        const idx = text.toLowerCase().indexOf(q);
        if (idx === -1) return text;
        return text.slice(0, idx) + '<mark class="search-highlight">' + text.slice(idx, idx + query.length) + '</mark>' + text.slice(idx + query.length);
    }

    function renderSearchResults(results, query) {
        const dropdown = document.getElementById('global-search-results');
        if (!dropdown) return;
        _searchSelectedIndex = -1;

        const input = document.getElementById('global-search-input');
        if (input) {
            const rect = input.closest('.sidebar-search').getBoundingClientRect();
            dropdown.style.top   = (rect.bottom + 4) + 'px';
            dropdown.style.left  = rect.left + 'px';
            dropdown.style.width = Math.max(rect.width, 280) + 'px';
        }

        if (results.length === 0) {
            dropdown.innerHTML = `<div class="search-no-results">No results for "<strong>${escapeHtmlSys(query)}</strong>"</div>`;
            dropdown.style.display = '';
            return;
        }

        const typeOrder  = ['bot', 'category', 'topic', 'keyword', 'collection', 'source', 'target'];
        const typeLabels = { bot: 'Bots', category: 'Categories', topic: 'Topics', keyword: 'SEOs', collection: 'Collections', source: 'Sources', target: 'Targets' };
        const grouped    = {};
        for (const item of results) {
            if (!grouped[item.type]) grouped[item.type] = [];
            grouped[item.type].push(item);
        }

        let html       = '';
        let globalIdx  = 0;
        for (const type of typeOrder) {
            if (!grouped[type]) continue;
            html += `<div class="search-result-group-label">${typeLabels[type]}</div>`;
            for (const item of grouped[type]) {
                const highlighted = _highlightMatch(escapeHtmlSys(item.label), query);
                html += `<div class="search-result-item" data-idx="${globalIdx}" onclick="selectSearchResult(${globalIdx})">
                    <span class="search-result-icon">${item.icon}</span>
                    <div class="search-result-text">
                        <div class="search-result-label">${highlighted}</div>
                        <div class="search-result-subtitle">${escapeHtmlSys(item.subtitle)}</div>
                    </div>
                </div>`;
                globalIdx++;
            }
        }

        dropdown.innerHTML     = html;
        dropdown.style.display = '';
    }

    function handleSearchKeydown(event) {
        const dropdown = document.getElementById('global-search-results');
        if (!dropdown || dropdown.style.display === 'none') {
            if (event.key === 'Escape') clearSearch();
            return;
        }
        const items = dropdown.querySelectorAll('.search-result-item');
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            _searchSelectedIndex = Math.min(_searchSelectedIndex + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('selected', i === _searchSelectedIndex));
            if (items[_searchSelectedIndex]) items[_searchSelectedIndex].scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            _searchSelectedIndex = Math.max(_searchSelectedIndex - 1, 0);
            items.forEach((el, i) => el.classList.toggle('selected', i === _searchSelectedIndex));
            if (items[_searchSelectedIndex]) items[_searchSelectedIndex].scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (_searchSelectedIndex >= 0 && _searchSelectedIndex < _searchResults.length) {
                selectSearchResult(_searchSelectedIndex);
            }
        } else if (event.key === 'Escape') {
            clearSearch();
        }
    }

    function selectSearchResult(idx) {
        const result = _searchResults[idx];
        if (!result) return;
        clearSearch();

        if (result.page === 'bots') {
            showPage('bots');
            if (result.botName) {
                openBotDetail(result.botName);
                if (result.openIds && result.openIds.length > 0) {
                    setTimeout(() => {
                        if (result.type !== 'bot') switchBotTab(result.botName, 'categories');
                        result.openIds.forEach(id => {
                            const el = document.getElementById(id);
                            if (el && !el.classList.contains('open')) el.classList.add('open');
                        });
                        const target = document.getElementById(result.openIds[result.openIds.length - 1]);
                        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }, 120);
                }
            }
        } else if (result.page === 'collections') {
            showPage('collections');
            if (result.scrollTo) {
                setTimeout(() => {
                    const el = document.getElementById(result.scrollTo);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 80);
            }
        }
    }

    function hideSearchResults() {
        const dropdown = document.getElementById('global-search-results');
        if (dropdown) dropdown.style.display = 'none';
        _searchResults       = [];
        _searchSelectedIndex = -1;
    }

    function clearSearch() {
        const input    = document.getElementById('global-search-input');
        const clearBtn = document.getElementById('global-search-clear');
        if (input)    input.value = '';
        if (clearBtn) clearBtn.style.display = 'none';
        hideSearchResults();
    }

    // ── Exports ────────────────────────────────────────────────────────────────
    window.buildSearchIndex    = buildSearchIndex;
    window.handleSearchInput   = handleSearchInput;
    window.handleSearchKeydown = handleSearchKeydown;
    window.selectSearchResult  = selectSearchResult;
    window.hideSearchResults   = hideSearchResults;
    window.clearSearch         = clearSearch;
})();
