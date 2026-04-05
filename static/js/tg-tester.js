'use strict';

// ── Telegram Tester page ──────────────────────────────────────────────────────

function tgTesterInit() {
    const el = document.getElementById('tg-tester-content');
    if (!el) return;

    el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">

        <!-- Session status card -->
        <div class="card">
            <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
                <span style="font-weight:600">📡 Session Status</span>
                <button class="btn btn-secondary btn-sm" onclick="tgTesterCheckSession()">Test Connection</button>
            </div>
            <div class="card-body" id="tgt-session-status">
                <span class="text-muted">Click "Test Connection" to check the userbot session.</span>
            </div>
        </div>

        <!-- Send test card -->
        <div class="card">
            <div class="card-header"><span style="font-weight:600">📤 Send Test</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
                    <div style="flex:1;min-width:160px">
                        <label class="form-label">Target channel / user</label>
                        <input class="input" id="tgt-send-target" placeholder="@channel, -100xxxx, or username" />
                    </div>
                    <div style="flex:2;min-width:200px">
                        <label class="form-label">Message</label>
                        <input class="input" id="tgt-send-msg" placeholder="Hello from the tester!" />
                    </div>
                    <button class="btn btn-primary" onclick="tgTesterSend()">▶ Send</button>
                </div>
                <div id="tgt-send-result" style="display:none"></div>
            </div>
        </div>

        <!-- Receive test card -->
        <div class="card">
            <div class="card-header"><span style="font-weight:600">📥 Receive Test</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
                    <div style="flex:2;min-width:160px">
                        <label class="form-label">Channel / chat to read from</label>
                        <input class="input" id="tgt-recv-target" placeholder="@channel or -100xxxx" />
                    </div>
                    <div style="width:90px">
                        <label class="form-label">Last N msgs</label>
                        <select class="select" id="tgt-recv-limit">
                            <option value="5">5</option>
                            <option value="10" selected>10</option>
                            <option value="20">20</option>
                            <option value="50">50</option>
                        </select>
                    </div>
                    <button class="btn btn-primary" onclick="tgTesterReceive()">▶ Fetch</button>
                </div>
                <div id="tgt-recv-result" style="display:none"></div>
            </div>
        </div>

        <!-- Connection logs card -->
        <div class="card" id="tgt-logs-card" style="display:none">
            <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
                <span style="font-weight:600">🗒 Connection Logs</span>
                <button class="btn btn-secondary btn-sm" onclick="document.getElementById('tgt-logs-card').style.display='none'">✕</button>
            </div>
            <div class="card-body">
                <pre id="tgt-logs" style="margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:300px;overflow-y:auto"></pre>
            </div>
        </div>

    </div>`;
}

// ── Session check ─────────────────────────────────────────────────────────────

async function tgTesterCheckSession() {
    const statusEl = document.getElementById('tgt-session-status');
    statusEl.innerHTML = '<span class="text-muted">Connecting…</span>';

    const res = await api('/api/telegram/session/test', {});

    // Show logs card
    const logsCard = document.getElementById('tgt-logs-card');
    const logsEl   = document.getElementById('tgt-logs');
    if (res.logs && res.logs.length) {
        logsCard.style.display = '';
        logsEl.textContent = res.logs.join('\n');
        logsEl.scrollTop = logsEl.scrollHeight;
    }

    if (res.status === 'ok') {
        statusEl.innerHTML = `<span style="color:var(--color-success)">✔ Connected as <strong>${escapeHtmlSys(res.me || '?')}</strong></span>`;
    } else {
        const msg = res.message || (res.logs && res.logs[res.logs.length - 1]) || 'Unknown error';
        statusEl.innerHTML = `<span style="color:var(--color-error)">✘ ${escapeHtmlSys(msg)}</span>`;
    }
}

// ── Send test ─────────────────────────────────────────────────────────────────

async function tgTesterSend() {
    const target  = (document.getElementById('tgt-send-target').value || '').trim();
    const message = (document.getElementById('tgt-send-msg').value || '').trim();
    const resultEl = document.getElementById('tgt-send-result');

    if (!target || !message) {
        resultEl.style.display = '';
        resultEl.innerHTML = `<span style="color:var(--color-error)">⚠ Please fill in both target and message.</span>`;
        return;
    }

    resultEl.style.display = '';
    resultEl.innerHTML = '<span class="text-muted">Sending…</span>';

    const res = await api('/api/telegram/test/send', { target, message });

    if (res.status === 'ok') {
        resultEl.innerHTML = `<span style="color:var(--color-success)">✔ ${escapeHtmlSys(res.message)}</span>`;
    } else {
        resultEl.innerHTML = `<span style="color:var(--color-error)">✘ ${escapeHtmlSys(res.message || 'Send failed')}</span>`;
    }
}

// ── Receive test ──────────────────────────────────────────────────────────────

async function tgTesterReceive() {
    const target  = (document.getElementById('tgt-recv-target').value || '').trim();
    const limit   = parseInt(document.getElementById('tgt-recv-limit').value, 10) || 10;
    const resultEl = document.getElementById('tgt-recv-result');

    if (!target) {
        resultEl.style.display = '';
        resultEl.innerHTML = `<span style="color:var(--color-error)">⚠ Please enter a target channel.</span>`;
        return;
    }

    resultEl.style.display = '';
    resultEl.innerHTML = '<span class="text-muted">Fetching…</span>';

    const res = await api('/api/telegram/test/receive', { target, limit });

    if (res.status !== 'ok') {
        resultEl.innerHTML = `<span style="color:var(--color-error)">✘ ${escapeHtmlSys(res.message || 'Fetch failed')}</span>`;
        return;
    }

    if (!res.messages || res.messages.length === 0) {
        resultEl.innerHTML = `<span class="text-muted">No messages found in <strong>${escapeHtmlSys(target)}</strong>.</span>`;
        return;
    }

    const rows = res.messages.map(m => {
        const date   = m.date ? new Date(m.date).toLocaleString() : '—';
        const sender = m.sender ? `<span style="color:var(--color-primary);font-weight:500">${escapeHtmlSys(m.sender)}</span> ` : '';
        const media  = m.media_type ? ` <span class="badge" style="font-size:10px">${m.media_type}</span>` : '';
        const text   = m.text ? escapeHtmlSys(m.text.slice(0, 300)) + (m.text.length > 300 ? '…' : '') : '<em style="color:var(--color-muted)">[no text]</em>';
        return `<div style="padding:8px 0;border-bottom:1px solid var(--border-color)">
            <div style="font-size:11px;color:var(--color-muted);margin-bottom:3px">${date} · #${m.id}${media}</div>
            <div>${sender}${text}</div>
        </div>`;
    }).join('');

    resultEl.innerHTML = `
        <div style="font-size:12px;color:var(--color-muted);margin-bottom:6px">Showing ${res.count} message(s) from <strong>${escapeHtmlSys(target)}</strong></div>
        <div style="max-height:400px;overflow-y:auto;font-size:13px">${rows}</div>`;
}
