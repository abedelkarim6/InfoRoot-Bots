// ==================== Agent Chat UI ====================

let _agentChatSessionId = null;
let _agentChatMessages = []; // {role, text, id, selected, loading, error}
let _agentChatSuggestionsInfo = []; // AI-generated informative questions
let _agentChatSuggestionsAnalytical = []; // AI-generated analytical questions
let _agentChatYtChannels = []; // cached YouTube channels
let _agentChatYtKeywords = []; // cached YouTube keywords

// ==================== Init & Session ====================

async function agentChatInit() {
    // Restore saved telegram target
    const saved = localStorage.getItem('agent_chat_tg_target');
    const tgInput = document.getElementById('agent-chat-tg-target');
    if (saved && tgInput) tgInput.value = saved;

    // Render welcome screen
    _agentChatRenderMessages();

    // Create session if none exists
    if (!_agentChatSessionId) {
        _agentChatSetStatus('connecting', 'Connecting…');
        const res = await api('/api/chatbot/start', {});
        if (res.status === 'ok') {
            _agentChatSessionId = res.session_id;
            _agentChatSetStatus('ready', 'Ready');
        } else {
            _agentChatSetStatus('error', 'Connection failed');
            ytToast('Failed to start chat session: ' + (res.message || ''), 'error');
        }
    }
    document.getElementById('agent-chat-input')?.focus();

    // Fetch AI-generated suggestions in background (non-blocking)
    _agentChatLoadSuggestions();
}

async function agentChatReset() {
    if (_agentChatSessionId) {
        api('/api/chatbot/end', { session_id: _agentChatSessionId });
    }
    _agentChatSessionId = null;
    _agentChatMessages = [];

    _agentChatRenderMessages();
    _agentChatUpdateSelectedCount();

    // Clear context selector
    agentChatClearContext();

    // Clear composer
    const finalText = document.getElementById('agent-chat-final-text');
    if (finalText) finalText.value = '';

    // Create new session
    _agentChatSetStatus('connecting', 'Connecting…');
    const res = await api('/api/chatbot/start', {});
    if (res.status === 'ok') {
        _agentChatSessionId = res.session_id;
        _agentChatSetStatus('ready', 'Ready');
        ytToast('New conversation started', 'info');
    }
    document.getElementById('agent-chat-input')?.focus();
}

async function _agentChatLoadSuggestions() {
    try {
        const res = await api('/api/chatbot/suggestions');
        if (res.status === 'ok') {
            _agentChatSuggestionsInfo = res.informative || [];
            _agentChatSuggestionsAnalytical = res.analytical || [];
            if ((_agentChatSuggestionsInfo.length || _agentChatSuggestionsAnalytical.length)
                && !_agentChatMessages.length) {
                _agentChatRenderMessages();
            }
        }
    } catch (e) {
        // Silent fail — static cards are always available
    }
}

function agentChatToggleComposer() {
    const composer = document.getElementById('agent-chat-composer');
    if (composer) composer.classList.toggle('agent-chat-composer-hidden');
}


// ==================== Context Selector ====================

function agentChatContextTypeChanged() {
    const typeSelect = document.getElementById('ac-context-type');
    const valueSelect = document.getElementById('ac-context-value');
    const clearBtn = document.getElementById('ac-context-clear');
    const type = typeSelect.value;

    valueSelect.innerHTML = '';
    if (!type) {
        valueSelect.disabled = true;
        valueSelect.innerHTML = '<option value="">— select above first —</option>';
        if (clearBtn) clearBtn.style.display = 'none';
        return;
    }

    if (clearBtn) clearBtn.style.display = '';

    if (type === 'topic' || type === 'category') {
        _agentChatPopulateFromConfig(type, valueSelect);
    } else if (type === 'yt-channel') {
        _agentChatPopulateYtChannels(valueSelect);
    } else if (type === 'yt-keyword') {
        _agentChatPopulateYtKeywords(valueSelect);
    }
}

function _agentChatPopulateFromConfig(type, selectEl) {
    const bots = (globalConfig && globalConfig.bots) || {};
    const items = new Set();

    for (const bot of Object.values(bots)) {
        for (const [catName, cat] of Object.entries(bot.categories || {})) {
            if (type === 'category') {
                items.add(catName);
            } else if (type === 'topic') {
                for (const topicName of Object.keys(cat.topics || {})) {
                    items.add(topicName);
                }
            }
        }
    }

    if (!items.size) {
        selectEl.innerHTML = '<option value="">No items found</option>';
        selectEl.disabled = true;
        return;
    }

    selectEl.innerHTML = `<option value="">— choose ${type} —</option>`;
    for (const name of [...items].sort()) {
        selectEl.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
    }
    selectEl.disabled = false;
}

async function _agentChatPopulateYtChannels(selectEl) {
    selectEl.innerHTML = '<option value="">Loading…</option>';
    selectEl.disabled = true;
    if (!_agentChatYtChannels.length) {
        try {
            const res = await api('/api/youtube/channels');
            _agentChatYtChannels = (res.status === 'ok' ? res.channels : []) || [];
        } catch (e) { _agentChatYtChannels = []; }
    }
    if (!_agentChatYtChannels.length) {
        selectEl.innerHTML = '<option value="">No channels found</option>';
        return;
    }
    selectEl.innerHTML = '<option value="">— choose channel —</option>';
    for (const ch of _agentChatYtChannels) {
        const label = ch.channel_name || ch.channel_id;
        selectEl.innerHTML += `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
    }
    selectEl.disabled = false;
}

async function _agentChatPopulateYtKeywords(selectEl) {
    selectEl.innerHTML = '<option value="">Loading…</option>';
    selectEl.disabled = true;
    if (!_agentChatYtKeywords.length) {
        try {
            const res = await api('/api/youtube/keywords');
            _agentChatYtKeywords = (res.status === 'ok' ? res.keywords : []) || [];
        } catch (e) { _agentChatYtKeywords = []; }
    }
    if (!_agentChatYtKeywords.length) {
        selectEl.innerHTML = '<option value="">No keywords found</option>';
        return;
    }
    selectEl.innerHTML = '<option value="">— choose keyword —</option>';
    for (const kw of _agentChatYtKeywords) {
        const label = kw.keyword || kw.query;
        selectEl.innerHTML += `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
    }
    selectEl.disabled = false;
}

function agentChatClearContext() {
    document.getElementById('ac-context-type').value = '';
    agentChatContextTypeChanged();
}

function _agentChatGetContext() {
    const type = document.getElementById('ac-context-type')?.value || '';
    const value = document.getElementById('ac-context-value')?.value || '';
    if (!type || !value) return null;
    return { type, value };
}


// ==================== Status ====================

function _agentChatSetStatus(state, label) {
    const el = document.getElementById('agent-chat-status');
    if (!el) return;
    el.className = `agent-chat-status agent-chat-status-${state}`;
    el.innerHTML = `<span class="agent-chat-status-dot"></span> ${label}`;
}


// ==================== Send & Receive ====================

async function agentChatSend(text) {
    if (!_agentChatSessionId) {
        ytToast('No active session — click New Chat', 'error');
        return;
    }

    const input = document.getElementById('agent-chat-input');
    const message = text || (input ? input.value.trim() : '');
    if (!message) return;

    if (!text && input) { input.value = ''; input.style.height = 'auto'; }

    const msgId = Date.now();
    _agentChatMessages.push({ role: 'user', text: message, id: msgId, selected: false });

    // Add placeholder for AI response
    const replyId = msgId + 1;
    _agentChatMessages.push({ role: 'assistant', text: '', id: replyId, selected: false, loading: true });
    _agentChatRenderMessages();

    // Disable input while waiting
    const sendBtn = document.getElementById('agent-chat-send-btn');
    if (input) input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    _agentChatSetStatus('thinking', 'Thinking…');

    const payload = { session_id: _agentChatSessionId, message };
    const ctx = _agentChatGetContext();
    if (ctx) payload.context = ctx;
    const res = await api('/api/chatbot/send', payload);

    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
    _agentChatSetStatus('ready', 'Ready');

    // Update placeholder with actual reply
    const placeholder = _agentChatMessages.find(m => m.id === replyId);
    if (placeholder) {
        placeholder.loading = false;
        if (res.status === 'ok') {
            placeholder.text = res.reply;
        } else {
            // Remove the failed placeholder and show error as toast
            _agentChatMessages = _agentChatMessages.filter(m => m.id !== replyId);
            ytToast('Failed to get response. Please try again.', 'error');
        }
    }
    _agentChatRenderMessages();
}


// ==================== Render ====================

function _agentChatRenderMessages() {
    const container = document.getElementById('agent-chat-messages');
    if (!container) return;

    if (!_agentChatMessages.length) {
        container.innerHTML = _agentChatWelcomeHTML();
        return;
    }

    let html = '';
    for (const msg of _agentChatMessages) {
        if (msg.role === 'user') {
            html += `<div class="ac-msg ac-msg-user">
                <div class="ac-msg-bubble ac-msg-bubble-user">${escapeHtml(msg.text)}</div>
            </div>`;
        } else {
            const checkable = !msg.loading && !msg.error;
            const selectedClass = msg.selected ? 'ac-msg-selected' : '';
            html += `<div class="ac-msg ac-msg-ai ${selectedClass}">
                <div class="ac-msg-avatar">AI</div>
                <div class="ac-msg-body">
                    <div class="ac-msg-meta">
                        ${checkable ? `<label class="ac-msg-check">
                            <input type="checkbox" ${msg.selected ? 'checked' : ''} onchange="agentChatToggleSelect(${msg.id}, this.checked)">
                        </label>` : ''}
                        <span class="ac-msg-agent-label">${msg.loading ? 'Thinking…' : 'Agent'}</span>
                    </div>
                    <div class="ac-msg-bubble ac-msg-bubble-ai ${msg.error ? 'ac-msg-bubble-error' : ''}">
                        ${msg.loading ? _agentChatSkeletonHTML() : _agentChatFormatText(msg.text)}
                    </div>
                </div>
            </div>`;
        }
    }
    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

function _agentChatWelcomeHTML() {
    const hasAI = _agentChatSuggestionsInfo.length || _agentChatSuggestionsAnalytical.length;

    function _renderGroup(label, icon, questions) {
        if (!questions.length) return '';
        const items = questions.map(q =>
            `<button class="ac-ai-suggestion" onclick="agentChatSend(this.textContent.trim())">${escapeHtml(q)}</button>`
        ).join('');
        return `<div class="ac-ai-group">
            <div class="ac-ai-suggestions-label">${icon} ${label}</div>
            <div class="ac-ai-suggestions-list">${items}</div>
        </div>`;
    }

    let aiSuggestionsHTML = '';
    if (hasAI) {
        aiSuggestionsHTML = `<div class="ac-ai-suggestions">
            ${_renderGroup('Informative', 'ℹ️', _agentChatSuggestionsInfo)}
            ${_renderGroup('Analytical', '📊', _agentChatSuggestionsAnalytical)}
        </div>`;
    } else {
        aiSuggestionsHTML = `<div class="ac-ai-suggestions">
            <div class="ac-ai-suggestions-list">
                <div class="ac-ai-suggestion-skeleton"></div>
                <div class="ac-ai-suggestion-skeleton" style="width:70%"></div>
                <div class="ac-ai-suggestion-skeleton" style="width:60%"></div>
            </div>
        </div>`;
    }

    return `
        <div class="ac-welcome">
            <div class="ac-welcome-avatar">AI</div>
            <h2 class="ac-welcome-title">What can I help you with?</h2>
            <p class="ac-welcome-sub">I have access to your news data, summaries, and YouTube analytics.</p>
            ${aiSuggestionsHTML}
            <div class="ac-welcome-cards">
                <div class="ac-welcome-card" onclick="agentChatSend('What are the latest news summaries?')">
                    <div class="ac-welcome-card-icon">📰</div>
                    <div class="ac-welcome-card-title">News Summaries</div>
                    <div class="ac-welcome-card-desc">Browse and analyze recent summary reports</div>
                </div>
                <div class="ac-welcome-card" onclick="agentChatSend('Show topic trends for the last 7 days')">
                    <div class="ac-welcome-card-icon">📈</div>
                    <div class="ac-welcome-card-title">Topic Trends</div>
                    <div class="ac-welcome-card-desc">Track message volumes and topic activity</div>
                </div>
                <div class="ac-welcome-card" onclick="agentChatSend('What YouTube videos were processed today?')">
                    <div class="ac-welcome-card-icon">🎬</div>
                    <div class="ac-welcome-card-title">YouTube Analysis</div>
                    <div class="ac-welcome-card-desc">Video summaries from tracked keywords</div>
                </div>
                <div class="ac-welcome-card" onclick="agentChatSend('Search messages about the latest events from the past 3 days')">
                    <div class="ac-welcome-card-icon">🔍</div>
                    <div class="ac-welcome-card-title">Search Messages</div>
                    <div class="ac-welcome-card-desc">Find specific messages by topic or source</div>
                </div>
            </div>
        </div>`;
}

function _agentChatSkeletonHTML() {
    return `<div class="ac-skeleton">
        <div class="ac-skeleton-line" style="width:90%"></div>
        <div class="ac-skeleton-line" style="width:75%"></div>
        <div class="ac-skeleton-line" style="width:60%"></div>
    </div>`;
}

function _agentChatFormatText(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    // Code blocks (triple backtick)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="ac-code-block"><code>$2</code></pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="ac-inline-code">$1</code>');
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4 class="ac-md-h">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 class="ac-md-h">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2 class="ac-md-h">$1</h2>');
    // Bold & italic
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Numbered lists
    html = html.replace(/^\d+\.\s+(.*)$/gm, '<li class="ac-ol-item">$1</li>');
    // Bullet lists
    html = html.replace(/^[\-•]\s+(.*)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li[^>]*>.*?<\/li>\s*)+)/g, '<ul class="ac-list">$1</ul>');
    // Line breaks (but not inside pre/code)
    html = html.replace(/\n/g, '<br>');
    // Clean up double <br> after block elements
    html = html.replace(/(<\/h[234]>)<br>/g, '$1');
    html = html.replace(/(<\/pre>)<br>/g, '$1');
    html = html.replace(/(<\/ul>)<br>/g, '$1');
    return html;
}


// ==================== Selection & Composer ====================

function agentChatToggleSelect(msgId, checked) {
    const msg = _agentChatMessages.find(m => m.id === msgId);
    if (msg) msg.selected = checked;
    _agentChatRenderMessages();
    _agentChatUpdateSelectedCount();
}

function agentChatSelectAll() {
    _agentChatMessages.filter(m => m.role === 'assistant' && !m.loading && !m.error)
        .forEach(m => m.selected = true);
    _agentChatRenderMessages();
    _agentChatUpdateSelectedCount();
}

function agentChatDeselectAll() {
    _agentChatMessages.forEach(m => m.selected = false);
    _agentChatRenderMessages();
    _agentChatUpdateSelectedCount();
}

function _agentChatUpdateSelectedCount() {
    const count = _agentChatMessages.filter(m => m.selected).length;
    const el = document.getElementById('agent-chat-selected-count');
    if (el) el.textContent = `${count} selected`;
}

function agentChatMerge() {
    const selected = _agentChatMessages.filter(m => m.selected && m.role === 'assistant');
    if (!selected.length) return ytToast('Select at least one response to merge.', 'error');

    // Show composer if hidden
    const composer = document.getElementById('agent-chat-composer');
    if (composer) composer.classList.remove('agent-chat-composer-hidden');

    const merged = selected.map(m => m.text).join('\n\n---\n\n');
    document.getElementById('agent-chat-final-text').value = merged;
    ytToast(`Merged ${selected.length} response(s)`, 'success');
}

function agentChatCopyFinal() {
    const text = document.getElementById('agent-chat-final-text').value;
    if (!text) return ytToast('Nothing to copy', 'error');
    navigator.clipboard.writeText(text).then(() => ytToast('Copied to clipboard', 'success'));
}

function agentChatClearFinal() {
    document.getElementById('agent-chat-final-text').value = '';
}

async function agentChatRefine() {
    const textarea = document.getElementById('agent-chat-final-text');
    const text = textarea.value.trim();
    if (!text) return ytToast('Nothing to refine — merge some responses first.', 'error');

    ytToast('Refining…', 'info');
    const res = await api('/api/chatbot/refine', { text });
    if (res.status === 'ok') {
        textarea.value = res.result;
        ytToast('Message refined', 'success');
    } else {
        ytToast(res.message || 'Refine failed', 'error');
    }
}

async function agentChatSendTelegram() {
    const text = document.getElementById('agent-chat-final-text').value.trim();
    const target = document.getElementById('agent-chat-tg-target').value.trim();
    if (!text) return ytToast('Nothing to send — compose a message first.', 'error');
    if (!target) return ytToast('Enter a Telegram target (@channel or chat ID).', 'error');

    localStorage.setItem('agent_chat_tg_target', target);

    const res = await api('/api/chatbot/send-telegram', { text, target });
    if (res.status === 'ok') {
        ytToast(`Sent to ${target}`, 'success');
    } else {
        ytToast(res.message || 'Failed to send', 'error');
    }
}
