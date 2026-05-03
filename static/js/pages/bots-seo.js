// ==================== Bots — AI SEO Suggestions ====================
(function () {
    // ==================== AI SEO Suggestions ====================
    let _seoSuggestContext        = null;  // { b, c, t }
    let _seoGenerating            = false;
    let _seoFakeProgressInterval  = null;
    let _seoLoadingTextInterval   = null;

    const _SEO_LOADING_MSGS = [
        'Analyzing topic keywords…',
        'Generating suggestions…',
        'Finding relevant terms…',
        'Expanding keyword list…',
        'Almost done…',
    ];

    function _seoStartFakeProgress(startPct, endPct) {
        if (_seoFakeProgressInterval) clearInterval(_seoFakeProgressInterval);
        const ceiling = startPct + (endPct - startPct) * 0.88;
        let current = startPct;
        _seoFakeProgressInterval = setInterval(() => {
            const bar = document.getElementById('seo-progress-bar');
            if (!bar) return;
            current += (ceiling - current) * 0.04;   // ease-out: fast then slow
            bar.style.width = current.toFixed(2) + '%';
        }, 80);
    }

    function _seoStopFakeProgress(actualPct) {
        if (_seoFakeProgressInterval) { clearInterval(_seoFakeProgressInterval); _seoFakeProgressInterval = null; }
        const bar = document.getElementById('seo-progress-bar');
        if (bar) bar.style.width = actualPct + '%';
    }

    function _seoStartLoadingText() {
        let idx = 0;
        const el = document.getElementById('seo-loading-text');
        if (el) el.textContent = _SEO_LOADING_MSGS[0];
        _seoLoadingTextInterval = setInterval(() => {
            idx = (idx + 1) % _SEO_LOADING_MSGS.length;
            const e = document.getElementById('seo-loading-text');
            if (e) e.textContent = _SEO_LOADING_MSGS[idx];
        }, 2400);
    }

    function _seoStartProgressText() {
        let idx = 0;
        const update = () => {
            const e = document.getElementById('seo-progress-subtext');
            if (e) e.textContent = _SEO_LOADING_MSGS[idx % _SEO_LOADING_MSGS.length];
            idx++;
        };
        update();
        _seoLoadingTextInterval = setInterval(update, 2400);
    }

    function _seoStopLoadingText() {
        if (_seoLoadingTextInterval) { clearInterval(_seoLoadingTextInterval); _seoLoadingTextInterval = null; }
    }

    // Step 1 — open config modal
    function suggestSEOs(b, c, t) {
        _seoSuggestContext = { b, c, t };
        document.getElementById('seo-cfg-subtitle').textContent = t;
        document.getElementById('seo-cfg-count').value = 50;
        document.getElementById('seo-cfg-note').value = '';
        document.querySelectorAll('.seo-lang-cb').forEach(cb => { cb.checked = cb.value === 'Arabic'; });
        document.getElementById('seo-config-modal').style.display = 'flex';
    }

    function closeSeoConfigModal() {
        document.getElementById('seo-config-modal').style.display = 'none';
    }

    // Step 2 — "Generate" clicked in config modal; run batches
    async function startSeoSuggest() {
        if (!_seoSuggestContext || _seoGenerating) return;

        const total     = Math.max(10, Math.min(500, parseInt(document.getElementById('seo-cfg-count').value) || 50));
        const languages = [...document.querySelectorAll('.seo-lang-cb:checked')].map(cb => cb.value);
        const note      = document.getElementById('seo-cfg-note').value.trim();
        const { b, c, t } = _seoSuggestContext;

        if (!languages.length) { showNotification('Select at least one language', 'error'); return; }

        closeSeoConfigModal();
        _seoGenerating = true;

        // Reset results modal
        document.getElementById('seo-suggest-subtitle').textContent =
            `${t} — ${total} suggestion${total !== 1 ? 's' : ''}`;
        document.getElementById('seo-suggest-loading').style.display = 'block';
        document.getElementById('seo-suggest-chips').innerHTML = '';
        document.getElementById('seo-progress-wrap').style.display = 'none';
        document.getElementById('seo-progress-bar').style.width = '0%';
        document.getElementById('seo-approve-btn').disabled = true;
        document.getElementById('seo-approve-btn').innerHTML =
            'Approve Selected (<span id="seo-sel-count">0</span>)';
        document.getElementById('seo-suggest-modal').style.display = 'flex';

        _seoStartLoadingText();

        const batches    = Math.ceil(total / 50);
        const batchPct   = 100 / batches;
        let allSuggested = [];

        for (let i = 0; i < batches; i++) {
            const batchSize  = Math.min(50, total - i * 50);
            const fromPct    = i * batchPct;
            const toPct      = (i + 1) * batchPct;

            // Switch from dots spinner to progress bar on first batch
            document.getElementById('seo-suggest-loading').style.display = 'none';
            document.getElementById('seo-progress-wrap').style.display = 'block';
            _seoStopLoadingText();
            _seoStartProgressText();
            document.getElementById('seo-progress-label').textContent =
                batches === 1 ? 'Generating…' : `Pass ${i + 1} of ${batches}`;
            document.getElementById('seo-progress-count').textContent =
                `${allSuggested.length} / ${total}`;
            _seoStopFakeProgress(fromPct);
            _seoStartFakeProgress(fromPct, toPct);

            const result = await api('/api/topic/suggest-seos', {
                bot_name: b, category_name: c, topic_name: t,
                count: batchSize, languages, note,
                exclude: allSuggested,
            });

            _seoStopFakeProgress(toPct);

            if (result.status !== 'ok') {
                _seoAppendError(result.message || 'AI error');
                break;
            }

            allSuggested.push(...result.suggestions);
            _seoAppendChips(result.suggestions);
            document.getElementById('seo-progress-count').textContent =
                `${allSuggested.length} / ${total}`;

            if (allSuggested.length > 0) document.getElementById('seo-approve-btn').disabled = false;
        }

        _seoStopFakeProgress(100);
        _seoStopLoadingText();
        document.getElementById('seo-progress-label').textContent =
            allSuggested.length ? `✓ ${allSuggested.length} suggestions ready` : 'Done';
        const sub = document.getElementById('seo-progress-subtext');
        if (sub) sub.textContent = '';
        document.getElementById('seo-select-all-cb').checked = true;
        _seoUpdateCount();
        _seoGenerating = false;
    }

    function _seoAppendChips(suggestions) {
        const chips = document.getElementById('seo-suggest-chips');
        suggestions.forEach(s => {
            const lbl = document.createElement('label');
            lbl.className = 'seo-chip';
            lbl.innerHTML = `<input type="checkbox" class="seo-chip-cb" checked onchange="_seoUpdateCount()"><span>${escapeHtml(s)}</span>`;
            chips.appendChild(lbl);
        });
        _seoUpdateCount();
    }

    function _seoAppendError(msg) {
        const chips = document.getElementById('seo-suggest-chips');
        const div = document.createElement('div');
        div.style.cssText = 'color:var(--danger);font-size:13px;padding:8px 0;width:100%;';
        div.textContent = msg;
        chips.appendChild(div);
    }

    function _seoUpdateCount() {
        const checked = document.querySelectorAll('#seo-suggest-chips .seo-chip-cb:checked').length;
        const total   = document.querySelectorAll('#seo-suggest-chips .seo-chip-cb').length;
        const el = document.getElementById('seo-sel-count');
        if (el) el.textContent = checked;
        const allCb = document.getElementById('seo-select-all-cb');
        if (allCb) allCb.checked = total > 0 && checked === total;
    }

    function seoToggleAll(checked) {
        document.querySelectorAll('#seo-suggest-chips .seo-chip-cb').forEach(cb => { cb.checked = checked; });
        _seoUpdateCount();
    }

    async function _approveSuggestedSEOs() {
        if (!_seoSuggestContext) return;
        const { b, c, t } = _seoSuggestContext;

        const selected = [...document.querySelectorAll('#seo-suggest-chips .seo-chip-cb:checked')]
            .map(cb => cb.closest('.seo-chip').querySelector('span').textContent.trim())
            .filter(Boolean);

        if (!selected.length) { showNotification('No keywords selected', 'error'); return; }

        const btn = document.getElementById('seo-approve-btn');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        const result = await api('/api/topic/keyword/add-bulk', {
            bot_name: b, category_name: c, topic_name: t, keywords: selected,
        });

        btn.disabled = false;

        if (result.status === 'ok') {
            closeSeoSuggestModal();
            await loadAllData();
            renderBotsPage([`topic-${b}-${c}-${t}`, `categories-${b}`]);
            showNotification(`${result.inserted} SEO${result.inserted !== 1 ? 's' : ''} added`, 'success');
        } else {
            showNotification(result.message || 'Failed to save keywords', 'error');
            const n = document.querySelectorAll('#seo-suggest-chips .seo-chip-cb:checked').length;
            btn.innerHTML = `Approve Selected (<span id="seo-sel-count">${n}</span>)`;
        }
    }

    function closeSeoSuggestModal() {
        if (_seoGenerating) _seoGenerating = false;
        _seoStopFakeProgress(0);
        _seoStopLoadingText();
        document.getElementById('seo-suggest-modal').style.display = 'none';
        _seoSuggestContext = null;
    }

    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window.suggestSEOs           = suggestSEOs;
    window.closeSeoConfigModal   = closeSeoConfigModal;
    window.startSeoSuggest       = startSeoSuggest;
    window.seoToggleAll          = seoToggleAll;
    window._approveSuggestedSEOs = _approveSuggestedSEOs;
    window.closeSeoSuggestModal  = closeSeoSuggestModal;
})();
