'use strict';

// ── Telegram Tester page ──────────────────────────────────────────────────────

function tgTesterInit() {
    const el = document.getElementById('tg-tester-content');
    if (!el) return;

    el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">

        <!-- Tab bar -->
        <div class="tgt-tabs" style="display:flex;gap:0;border-bottom:2px solid var(--border-color);margin-bottom:4px">
            <button class="tgt-tab tgt-tab--active" data-tab="telegram" onclick="tgTesterSwitchTab('telegram')">📡 Telegram</button>
            <button class="tgt-tab" data-tab="summaries" onclick="tgTesterSwitchTab('summaries')">📝 Summaries</button>
        </div>

        <!-- ── Telegram tab ── -->
        <div id="tgt-panel-telegram" class="tgt-panel" style="display:flex;flex-direction:column;gap:16px">

            <!-- Session status -->
            <div class="card">
                <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
                    <span style="font-weight:600">📡 Session Status</span>
                    <button class="btn btn-secondary btn-sm" onclick="tgTesterCheckSession()">Test Connection</button>
                </div>
                <div class="card-body" id="tgt-session-status">
                    <span class="text-muted">Click "Test Connection" to check the userbot session.</span>
                </div>
            </div>

            <!-- Send test -->
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

            <!-- Receive test -->
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

            <!-- Connection logs -->
            <div class="card" id="tgt-logs-card" style="display:none">
                <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
                    <span style="font-weight:600">🗒 Connection Logs</span>
                    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('tgt-logs-card').style.display='none'">✕</button>
                </div>
                <div class="card-body">
                    <pre id="tgt-logs" style="margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:300px;overflow-y:auto"></pre>
                </div>
            </div>

        </div>

        <!-- ── Summaries tab ── -->
        <div id="tgt-panel-summaries" class="tgt-panel" style="display:none;flex-direction:column;gap:16px">

            <!-- Generator test -->
            <div class="card">
                <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
                    <span style="font-weight:600">🧪 Summary Generator Test</span>
                    <span style="font-size:12px;color:var(--color-muted)">Generates without sending to Telegram</span>
                </div>
                <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
                    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
                        <div style="flex:1;min-width:140px">
                            <label class="form-label">Bot</label>
                            <select class="select" id="tgt-sum-bot" onchange="tgSumBotChanged()">
                                <option value="">— select bot —</option>
                            </select>
                        </div>
                        <div style="flex:1;min-width:140px">
                            <label class="form-label">Topic</label>
                            <select class="select" id="tgt-sum-topic" onchange="tgSumTopicChanged()">
                                <option value="">— select topic —</option>
                            </select>
                        </div>
                        <div style="flex:1;min-width:130px">
                            <label class="form-label">Schedule type</label>
                            <select class="select" id="tgt-sum-sched">
                                <option value="">— select —</option>
                            </select>
                        </div>
                        <button class="btn btn-primary" onclick="tgSumGenerate()">▶ Generate</button>
                    </div>
                    <div id="tgt-sum-result" style="display:none"></div>
                </div>
            </div>

            <!-- Recent summaries -->
            <div class="card">
                <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
                    <span style="font-weight:600">📋 Recent Summaries</span>
                    <button class="btn btn-secondary btn-sm" onclick="tgSumLoadRecent()">↻ Refresh</button>
                </div>
                <div class="card-body" id="tgt-sum-recent">
                    <span class="text-muted">Click Refresh to load recent summaries.</span>
                </div>
            </div>

        </div>

    </div>`;

    // Inject tab styles once
    if (!document.getElementById('tgt-tab-styles')) {
        const s = document.createElement('style');
        s.id = 'tgt-tab-styles';
        s.textContent = `
            .tgt-tab {
                padding: 8px 20px;
                font-size: 13px;
                font-weight: 500;
                background: none;
                border: none;
                border-bottom: 2px solid transparent;
                margin-bottom: -2px;
                cursor: pointer;
                color: var(--color-muted);
                transition: color .15s, border-color .15s;
            }
            .tgt-tab:hover { color: var(--color-text); }
            .tgt-tab--active { color: var(--color-primary); border-bottom-color: var(--color-primary); }
        `;
        document.head.appendChild(s);
    }

    tgSumLoadBots();
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function tgTesterSwitchTab(tab) {
    document.querySelectorAll('.tgt-tab').forEach(b => b.classList.toggle('tgt-tab--active', b.dataset.tab === tab));
    document.querySelectorAll('.tgt-panel').forEach(p => p.style.display = 'none');
    const panel = document.getElementById(`tgt-panel-${tab}`);
    if (panel) panel.style.display = 'flex';
}

// ── Session check ─────────────────────────────────────────────────────────────

async function tgTesterCheckSession() {
    const statusEl = document.getElementById('tgt-session-status');
    statusEl.innerHTML = '<span class="text-muted">Connecting…</span>';

    const res = await api('/api/telegram/session/test', {});

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
    const target   = (document.getElementById('tgt-send-target').value || '').trim();
    const message  = (document.getElementById('tgt-send-msg').value || '').trim();
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
    const target   = (document.getElementById('tgt-recv-target').value || '').trim();
    const limit    = parseInt(document.getElementById('tgt-recv-limit').value, 10) || 10;
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

// ── Summary tester: load bots ─────────────────────────────────────────────────

let _tgtBotsConfig = null;

async function tgSumLoadBots() {
    const res = await api('/api/monitor/data');
    if (res.status !== 'ok') return;
    _tgtBotsConfig = res.bots || {};

    const botSel = document.getElementById('tgt-sum-bot');
    if (!botSel) return;
    botSel.innerHTML = '<option value="">— select bot —</option>' +
        Object.keys(_tgtBotsConfig).map(b => `<option value="${escapeHtmlSys(b)}">${escapeHtmlSys(b)}</option>`).join('');
}

function tgSumBotChanged() {
    const botName = document.getElementById('tgt-sum-bot').value;
    const topicSel = document.getElementById('tgt-sum-topic');
    const schedSel = document.getElementById('tgt-sum-sched');

    topicSel.innerHTML = '<option value="">— select topic —</option>';
    schedSel.innerHTML = '<option value="">— select —</option>';

    if (!botName || !_tgtBotsConfig) return;

    const bot = _tgtBotsConfig[botName];
    const topics = new Set();
    for (const cat of Object.values(bot.categories || {})) {
        for (const tName of Object.keys(cat.topics || {})) {
            topics.add(tName);
        }
    }
    topicSel.innerHTML = '<option value="">— select topic —</option>' +
        [...topics].map(t => `<option value="${escapeHtmlSys(t)}">${escapeHtmlSys(t)}</option>`).join('');
}

function tgSumTopicChanged() {
    const botName   = document.getElementById('tgt-sum-bot').value;
    const topicName = document.getElementById('tgt-sum-topic').value;
    const schedSel  = document.getElementById('tgt-sum-sched');

    schedSel.innerHTML = '<option value="">— select —</option>';

    if (!botName || !topicName || !_tgtBotsConfig) return;

    const schedTypes = new Set();
    const bot = _tgtBotsConfig[botName];
    for (const cat of Object.values(bot.categories || {})) {
        const topicCfg = (cat.topics || {})[topicName];
        if (topicCfg) {
            for (const s of (topicCfg.schedules || [])) {
                if (s.type) schedTypes.add(s.type);
            }
        }
    }

    // If no schedule info available, offer the common types
    const types = schedTypes.size ? [...schedTypes] : ['hourly', 'daily', 'minute', 'interval'];
    schedSel.innerHTML = '<option value="">— select —</option>' +
        types.map(t => `<option value="${escapeHtmlSys(t)}">${escapeHtmlSys(t)}</option>`).join('');
}

// ── Summary tester: generate ──────────────────────────────────────────────────

async function tgSumGenerate() {
    const bot_name      = document.getElementById('tgt-sum-bot').value;
    const topic_name    = document.getElementById('tgt-sum-topic').value;
    const schedule_type = document.getElementById('tgt-sum-sched').value;
    const resultEl      = document.getElementById('tgt-sum-result');

    if (!bot_name || !topic_name || !schedule_type) {
        resultEl.style.display = '';
        resultEl.innerHTML = `<span style="color:var(--color-error)">⚠ Please select bot, topic and schedule type.</span>`;
        return;
    }

    resultEl.style.display = '';
    resultEl.innerHTML = `<span class="text-muted">Generating… (this may take a few seconds)</span>`;

    const res = await api('/api/telegram/tester/summary/generate', { bot_name, topic_name, schedule_type });

    if (res.status === 'ok' && res.warning) {
        resultEl.innerHTML = `<span style="color:var(--color-warning,#f59e0b)">⚠ ${escapeHtmlSys(res.warning)}</span>`;
        return;
    }

    if (res.status === 'error') {
        const stage = res.stage ? ` <span style="font-size:11px;color:var(--color-muted)">[stage: ${escapeHtmlSys(res.stage)}]</span>` : '';
        resultEl.innerHTML = `
            <div style="color:var(--color-error);font-weight:500;margin-bottom:6px">✘ Generation failed${stage}</div>
            <pre style="background:var(--bg-secondary,#f8f9fa);padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap;margin:0;color:var(--color-error)">${escapeHtmlSys(res.message || 'Unknown error')}</pre>`;
        return;
    }

    resultEl.innerHTML = `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--color-muted)">
            <span>Messages used: <strong>${res.message_count}</strong></span>
            <span>Prompt key: <strong>${escapeHtmlSys(res.prompt_key || '—')}</strong></span>
            <span style="color:var(--color-success);font-weight:600">✔ Generated successfully</span>
        </div>
        <pre style="background:var(--bg-secondary,#f8f9fa);padding:12px;border-radius:6px;font-size:13px;line-height:1.6;white-space:pre-wrap;margin:0;max-height:400px;overflow-y:auto">${escapeHtmlSys(res.summary)}</pre>`;
}

// ── Recent summaries ──────────────────────────────────────────────────────────

async function tgSumLoadRecent() {
    const el = document.getElementById('tgt-sum-recent');
    el.innerHTML = '<span class="text-muted">Loading…</span>';

    const res = await api('/api/monitor/data');
    if (res.status !== 'ok') {
        el.innerHTML = `<span style="color:var(--color-error)">✘ ${escapeHtmlSys(res.message || 'Failed to load')}</span>`;
        return;
    }

    const summaries = res.recent_summaries || [];
    if (!summaries.length) {
        el.innerHTML = `<span class="text-muted">No summaries found in the database yet.</span>`;
        return;
    }

    const rows = summaries.slice(0, 20).map(s => {
        const date = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
        const bot  = escapeHtmlSys(s.bot_name || '—');
        const topic = escapeHtmlSys(s.topic_name || '—');
        const type = escapeHtmlSys(s.summary_type || '—');
        const target = escapeHtmlSys(s.target_entity || '—');
        const preview = escapeHtmlSys((s.preview || '').slice(0, 200)) + ((s.preview || '').length > 200 ? '…' : '');
        return `<div style="padding:10px 0;border-bottom:1px solid var(--border-color)">
            <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--color-muted);margin-bottom:5px">
                <span>${date}</span>
                <span>·</span>
                <span style="color:var(--color-primary);font-weight:500">${bot}</span>
                <span>/</span>
                <span>${topic}</span>
                <span>·</span>
                <span class="badge" style="font-size:10px">${type}</span>
                <span>· ${s.message_count || 0} msgs</span>
                <span>→ ${target}</span>
            </div>
            <div style="font-size:12px;line-height:1.5;color:var(--color-text)">${preview || '<em style="color:var(--color-muted)">[empty]</em>'}</div>
        </div>`;
    }).join('');

    el.innerHTML = `
        <div style="font-size:12px;color:var(--color-muted);margin-bottom:8px">Showing last ${Math.min(summaries.length, 20)} of ${summaries.length} summaries</div>
        <div style="max-height:500px;overflow-y:auto">${rows}</div>`;
}
