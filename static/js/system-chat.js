// ==================== System Chat UI ====================

let _sysChatSessionId = null;
let _sysChatMessages = []; // {role, text, id, actions, loading, error}
let _sysChatStreaming = false;
let _sysChatAbortController = null;

// ==================== Init & Session ====================

async function sysChatInit() {
    // If already active (returning mid-stream or with messages), just re-render
    if (_sysChatSessionId) {
        _sysChatRenderMessages();
        _sysChatSetCancelVisible(_sysChatStreaming);
        if (!_sysChatStreaming) {
            document.getElementById('sc-input')?.focus();
        }
        return;
    }

    // Fresh start
    _sysChatRenderMessages();
    _sysChatSetStatus('connecting', 'Connecting…');
    const res = await api('/api/chatbot/system/start', {});
    if (res.status === 'ok') {
        _sysChatSessionId = res.session_id;
        _sysChatSetStatus('ready', 'Ready');
    } else {
        _sysChatSetStatus('error', 'Connection failed');
        ytToast('Failed to start system chat: ' + (res.message || ''), 'error');
    }
    document.getElementById('sc-input')?.focus();
}

function sysChatCancel() {
    if (_sysChatAbortController) {
        _sysChatAbortController.abort();
        _sysChatAbortController = null;
    }
}

function _sysChatSetCancelVisible(visible) {
    const btn = document.getElementById('sc-cancel-btn');
    const send = document.getElementById('sc-send-btn');
    if (btn) btn.style.display = visible ? '' : 'none';
    if (send) send.style.display = visible ? 'none' : '';
}

async function sysChatReset() {
    if (_sysChatAbortController) {
        _sysChatAbortController.abort();
        _sysChatAbortController = null;
    }
    _sysChatStreaming = false;
    _sysChatSetCancelVisible(false);

    if (_sysChatSessionId) {
        api('/api/chatbot/system/end', { session_id: _sysChatSessionId });
    }
    _sysChatSessionId = null;
    _sysChatMessages = [];
    _sysChatRenderMessages();
    _sysChatHideActions();

    // Show suggestions
    const sug = document.getElementById('sc-suggestions');
    if (sug) sug.style.display = '';

    _sysChatSetStatus('connecting', 'Connecting…');
    const res = await api('/api/chatbot/system/start', {});
    if (res.status === 'ok') {
        _sysChatSessionId = res.session_id;
        _sysChatSetStatus('ready', 'Ready');
        ytToast('New system chat started', 'info');
    }
    document.getElementById('sc-input')?.focus();
}


// ==================== Status ====================

function _sysChatSetStatus(state, label) {
    const el = document.getElementById('sc-status');
    if (!el) return;
    el.className = `sc-status sc-status-${state}`;
    el.innerHTML = `<span class="sc-status-dot"></span> ${label}`;
}


// ==================== Send & Receive ====================

async function sysChatSend(text) {
    if (!_sysChatSessionId) {
        ytToast('No active session — click reset', 'error');
        return;
    }

    const input = document.getElementById('sc-input');
    const message = text || (input ? input.value.trim() : '');
    if (!message) return;

    if (!text && input) { input.value = ''; input.style.height = 'auto'; }

    const sug = document.getElementById('sc-suggestions');
    if (sug) sug.style.display = 'none';

    const msgId = Date.now();
    _sysChatMessages.push({ role: 'user', text: message, id: msgId });

    const replyId = msgId + 1;
    _sysChatMessages.push({ role: 'assistant', text: '', steps: [], id: replyId, loading: true, streaming: false, actions: [] });
    _sysChatRenderMessages();

    if (input) input.disabled = true;
    _sysChatStreaming = true;
    _sysChatSetCancelVisible(true);
    _sysChatSetStatus('thinking', 'Working…');
    _sysChatHideActions();

    _sysChatAbortController = new AbortController();

    try {
        const response = await fetch('/api/chatbot/system/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: _sysChatSessionId, message }),
            signal: _sysChatAbortController.signal,
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let started = false;
        let lastActions = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let evt;
                try { evt = JSON.parse(line.slice(6)); } catch { continue; }

                const msg = _sysChatMessages.find(m => m.id === replyId);
                if (!msg) continue;

                if (!started) {
                    started = true;
                    msg.loading = false;
                    msg.streaming = true;
                }

                if (evt.type === 'step') {
                    msg.steps.push(evt);
                    _sysChatUpdateBubble(replyId);
                } else if (evt.type === 'delta') {
                    msg.text += evt.content;
                    _sysChatUpdateBubble(replyId);
                } else if (evt.type === 'done') {
                    msg.text = evt.content || msg.text;
                    msg.streaming = false;
                    msg.actions = evt.actions || [];
                    lastActions = msg.actions;
                    _sysChatUpdateBubble(replyId);
                } else if (evt.type === 'error') {
                    _sysChatMessages = _sysChatMessages.filter(m => m.id !== replyId);
                    ytToast(evt.message || 'Agent error', 'error');
                    _sysChatRenderMessages();
                }
            }
        }

        if (lastActions.length) _sysChatShowActions(lastActions);

    } catch (e) {
        if (e.name === 'AbortError') {
            const msg = _sysChatMessages.find(m => m.id === replyId);
            if (msg) {
                msg.loading = false;
                msg.streaming = false;
                if (!msg.text) {
                    _sysChatMessages = _sysChatMessages.filter(m => m.id !== replyId);
                }
            }
            _sysChatRenderMessages();
        } else {
            _sysChatMessages = _sysChatMessages.filter(m => m.id !== replyId);
            ytToast('Connection error. Please try again.', 'error');
            _sysChatRenderMessages();
        }
    }

    _sysChatStreaming = false;
    _sysChatAbortController = null;
    _sysChatSetCancelVisible(false);
    if (input) input.disabled = false;
    if (input) input.focus();
    _sysChatSetStatus('ready', 'Ready');
}

function _sysChatUpdateBubble(msgId) {
    const msg = _sysChatMessages.find(m => m.id === msgId);
    if (!msg) return;
    const el = document.querySelector(`[data-sc-msg-id="${msgId}"]`);
    if (!el) { _sysChatRenderMessages(); return; }

    const labelEl = el.querySelector('.sc-msg-label');
    if (labelEl) {
        labelEl.textContent = msg.loading || msg.streaming ? 'Working…' : 'System Agent';
    }

    const bubble = el.querySelector('.sc-msg-bubble-ai');
    if (bubble) bubble.innerHTML = _sysChatBubbleInner(msg);

    const container = document.getElementById('sc-messages');
    if (container) container.scrollTop = container.scrollHeight;
}

function _sysChatBubbleInner(msg) {
    if (msg.loading) return _sysChatSkeletonHTML();
    let html = '';
    if (msg.steps && msg.steps.length) {
        html += '<div class="ac-steps">';
        html += msg.steps.map(s =>
            `<div class="ac-step"><span class="ac-step-icon">${s.icon}</span><span class="ac-step-label">${escapeHtml(s.label)}</span></div>`
        ).join('');
        html += '</div>';
    }
    if (msg.text) {
        html += `<div class="ac-content${msg.streaming ? ' ac-content-streaming' : ''}">${_sysChatFormatText(msg.text)}</div>`;
    } else if (msg.streaming && (!msg.steps || !msg.steps.length)) {
        html += _sysChatSkeletonHTML();
    }
    if (!msg.loading && !msg.streaming && msg.actions && msg.actions.length) {
        html += _sysChatInlineActions(msg.actions);
    }
    return html;
}


// ==================== Render Messages ====================

function _sysChatRenderMessages() {
    const container = document.getElementById('sc-messages');
    if (!container) return;

    if (!_sysChatMessages.length) {
        container.innerHTML = _sysChatWelcomeHTML();
        return;
    }

    let html = '';
    for (const msg of _sysChatMessages) {
        if (msg.role === 'user') {
            html += `<div class="sc-msg sc-msg-user">
                <div class="sc-msg-bubble sc-msg-bubble-user">${escapeHtml(msg.text)}</div>
            </div>`;
        } else {
            const scLabel = msg.loading || msg.streaming ? 'Working…' : 'System Agent';
            html += `<div class="sc-msg sc-msg-ai" data-sc-msg-id="${msg.id}">
                <div class="sc-msg-avatar">SYS</div>
                <div class="sc-msg-body">
                    <div class="sc-msg-label">${scLabel}</div>
                    <div class="sc-msg-bubble sc-msg-bubble-ai">
                        ${_sysChatBubbleInner(msg)}
                    </div>
                </div>
            </div>`;
        }
    }
    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

function _sysChatWelcomeHTML() {
    return `
        <div class="sc-welcome">
            <div class="sc-welcome-avatar">SYS</div>
            <h2 class="sc-welcome-title">System Control</h2>
            <p class="sc-welcome-sub">I can toggle features, manage keywords, and configure your monitoring system.</p>
            <div class="sc-welcome-examples">
                <div class="sc-example" onclick="sysChatSend('Turn off the system')">Turn off the system</div>
                <div class="sc-example" onclick="sysChatSend('Disable the YouTube keyword tracker for AI news')">Disable a YouTube keyword</div>
                <div class="sc-example" onclick="sysChatSend('Add a new YouTube keyword: machine learning')">Add a new YT keyword</div>
                <div class="sc-example" onclick="sysChatSend('Show all collections and their status')">Show collections status</div>
            </div>
        </div>`;
}

function _sysChatSkeletonHTML() {
    return `<div class="ac-skeleton">
        <div class="ac-skeleton-line" style="width:85%"></div>
        <div class="ac-skeleton-line" style="width:65%"></div>
    </div>`;
}

function _sysChatFormatText(text) {
    if (!text) return '';
    const normalized = text.replace(/\n{3,}/g, '\n\n');
    return marked.parse(normalized, { gfm: true, breaks: false });
}


// ==================== Action Cards ====================

const _scActionConfig = {
    toggle:  { icon: '🔄', label: 'Toggled' },
    add:     { icon: '➕', label: 'Added' },
    delete:  { icon: '🗑️', label: 'Deleted' },
    run:     { icon: '▶️', label: 'Triggered' },
    update:  { icon: '✏️', label: 'Updated' },
};

function _sysChatInlineActions(actions) {
    if (!actions || !actions.length) return '';
    const cards = actions.map(a => _sysChatActionCardHTML(a)).join('');
    return `<div class="sc-inline-actions">${cards}</div>`;
}

function _sysChatActionCardHTML(action) {
    const cfg = _scActionConfig[action.type] || { icon: '📌', label: action.type };
    const isSuccess = action.status === 'success';
    const statusClass = isSuccess ? 'sc-action-success' : 'sc-action-error';
    const statusIcon = isSuccess ? '✓' : '✗';

    let detail = '';
    if (action.type === 'toggle') {
        const oldLabel = action.old_value ? 'ON' : 'OFF';
        const newLabel = action.new_value ? 'ON' : 'OFF';
        const arrowClass = action.new_value ? 'sc-arrow-on' : 'sc-arrow-off';
        detail = `<div class="sc-action-toggle">
            <span class="sc-toggle-old">${oldLabel}</span>
            <span class="sc-toggle-arrow ${arrowClass}">→</span>
            <span class="sc-toggle-new ${action.new_value ? 'sc-toggle-on' : 'sc-toggle-off'}">${newLabel}</span>
        </div>`;
    } else if (action.detail) {
        detail = `<div class="sc-action-detail">${escapeHtml(action.detail)}</div>`;
    }

    return `<div class="sc-action-card ${statusClass}">
        <div class="sc-action-icon">${cfg.icon}</div>
        <div class="sc-action-body">
            <div class="sc-action-header">
                <span class="sc-action-label">${cfg.label}</span>
                <span class="sc-action-entity">${escapeHtml(action.entity || '')}</span>
                <span class="sc-action-status">${statusIcon}</span>
            </div>
            <div class="sc-action-name">${escapeHtml(action.name || '')}</div>
            ${detail}
        </div>
    </div>`;
}

function _sysChatShowActions(actions) {
    const strip = document.getElementById('sc-actions-strip');
    if (!strip) return;
    strip.innerHTML = actions.map(a => _sysChatActionCardHTML(a)).join('');
    strip.style.display = '';
    // Auto-hide after 8 seconds
    setTimeout(() => { strip.style.display = 'none'; }, 8000);
}

function _sysChatHideActions() {
    const strip = document.getElementById('sc-actions-strip');
    if (strip) strip.style.display = 'none';
}
