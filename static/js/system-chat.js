// ==================== System Chat UI ====================

let _sysChatSessionId = null;
let _sysChatMessages = []; // {role, text, id, actions, loading, error}

// ==================== Init & Session ====================

async function sysChatInit() {
    _sysChatRenderMessages();

    if (!_sysChatSessionId) {
        _sysChatSetStatus('connecting', 'Connecting…');
        const res = await api('/api/chatbot/system/start', {});
        if (res.status === 'ok') {
            _sysChatSessionId = res.session_id;
            _sysChatSetStatus('ready', 'Ready');
        } else {
            _sysChatSetStatus('error', 'Connection failed');
            ytToast('Failed to start system chat: ' + (res.message || ''), 'error');
        }
    }
    document.getElementById('sc-input')?.focus();
}

async function sysChatReset() {
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

    // Hide suggestions after first message
    const sug = document.getElementById('sc-suggestions');
    if (sug) sug.style.display = 'none';

    const msgId = Date.now();
    _sysChatMessages.push({ role: 'user', text: message, id: msgId });

    const replyId = msgId + 1;
    _sysChatMessages.push({ role: 'assistant', text: '', id: replyId, loading: true, actions: [] });
    _sysChatRenderMessages();

    const sendBtn = document.getElementById('sc-send-btn');
    if (input) input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    _sysChatSetStatus('thinking', 'Working…');

    const res = await api('/api/chatbot/system/send', { session_id: _sysChatSessionId, message });

    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
    _sysChatSetStatus('ready', 'Ready');

    const placeholder = _sysChatMessages.find(m => m.id === replyId);
    if (placeholder) {
        placeholder.loading = false;
        if (res.status === 'ok') {
            placeholder.text = res.reply;
            placeholder.actions = res.actions || [];
        } else {
            _sysChatMessages = _sysChatMessages.filter(m => m.id !== replyId);
            ytToast('Failed to get response. Please try again.', 'error');
        }
    }
    _sysChatRenderMessages();

    // Show action cards if any
    if (res.status === 'ok' && res.actions && res.actions.length) {
        _sysChatShowActions(res.actions);
    } else {
        _sysChatHideActions();
    }
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
            html += `<div class="sc-msg sc-msg-ai">
                <div class="sc-msg-avatar">SYS</div>
                <div class="sc-msg-body">
                    <div class="sc-msg-label">${msg.loading ? 'Working…' : 'System Agent'}</div>
                    <div class="sc-msg-bubble sc-msg-bubble-ai">
                        ${msg.loading ? _sysChatSkeletonHTML() : _sysChatFormatText(msg.text)}
                    </div>
                    ${(!msg.loading && msg.actions && msg.actions.length) ? _sysChatInlineActions(msg.actions) : ''}
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
    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="ac-code-block"><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code class="ac-inline-code">$1</code>');
    html = html.replace(/^### (.+)$/gm, '<h4 class="ac-md-h">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 class="ac-md-h">$1</h3>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/^\d+\.\s+(.*)$/gm, '<li class="ac-ol-item">$1</li>');
    html = html.replace(/^[\-•]\s+(.*)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li[^>]*>.*?<\/li>\s*)+)/g, '<ul class="ac-list">$1</ul>');
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/(<\/h[234]>)<br>/g, '$1');
    html = html.replace(/(<\/pre>)<br>/g, '$1');
    html = html.replace(/(<\/ul>)<br>/g, '$1');
    return html;
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
