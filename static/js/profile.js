'use strict';

// ── Profile page ──────────────────────────────────────────────────────────────

let _profileUser = null;
let _tgLinkPhone = null;   // phone being verified in re-link flow

// Called by modern.js when the profile page is shown
async function loadProfileData() {
    const el = document.getElementById('profile-content');
    if (!el) return;
    el.innerHTML = '<p class="text-muted">Loading…</p>';

    const token = localStorage.getItem('auth_token');
    const r = await fetch('/api/auth/me', {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    });
    if (!r.ok) { el.innerHTML = '<p style="color:var(--danger)">Not authenticated.</p>'; return; }

    _profileUser = await r.json();

    // Update sidebar username label
    const navLbl = document.getElementById('profile-nav-username');
    if (navLbl) navLbl.textContent = _profileUser.username;

    el.innerHTML = renderProfilePage(_profileUser);
    if (_profileUser.role === 'admin') loadGeminiUsage();
}

// Called by modern.js when the Telegram Setup page is shown
async function loadTgSetupPage() {
    const el = document.getElementById('tg-setup-content');
    if (!el) return;
    el.innerHTML = '<p class="text-muted">Loading…</p>';

    const token = localStorage.getItem('auth_token');
    const r = await fetch('/api/auth/me', {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    });
    if (!r.ok) { el.innerHTML = '<p style="color:var(--danger)">Not authenticated.</p>'; return; }

    _profileUser = await r.json();
    el.innerHTML = renderTgSetupCard(_profileUser);

    if (_profileUser.telegram_session || _profileUser.telegram_phone) {
        loadTgProfile();
        if (_profileUser.role === 'admin') loadTgChannels();
    }
}

function renderProfilePage(u) {
    const isAdmin     = u.role === 'admin';
    const joinedDate  = u.created_at
        ? new Date(u.created_at).toLocaleDateString()
        : '—';

    return `
<div style="max-width:640px">

  <!-- ── User info card ── -->
  <div class="card" style="margin-bottom:20px">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
      <div class="pf-avatar">${u.username[0].toUpperCase()}</div>
      <div>
        <div style="font-size:18px;font-weight:600">${escapeHtmlSys(u.username)}</div>
        <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap">
          <span class="pf-badge ${isAdmin ? 'pf-badge-admin' : 'pf-badge-user'}">
            ${isAdmin ? '🔑 Admin' : '👤 User'}
          </span>
          ${u.is_active !== false
            ? `<span class="pf-badge pf-badge-active">● Active</span>`
            : `<span class="pf-badge pf-badge-inactive">○ Inactive</span>`}
          ${!isAdmin ? `<span class="pf-badge" style="opacity:.6">Joined ${joinedDate}</span>` : ''}
        </div>
      </div>
    </div>

    <!-- Feature flags (read-only for user, set by admin) -->
    ${!isAdmin ? `
    <div style="display:flex;gap:16px;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--border-color)">
      <div class="pf-flag ${u.youtube_on ? 'pf-flag-on' : ''}">
        📺 YouTube Summaries <strong>${u.youtube_on ? 'ON' : 'OFF'}</strong>
      </div>
      <div class="pf-flag ${u.yt_chat_on ? 'pf-flag-on' : ''}">
        💬 Video Chat <strong>${u.yt_chat_on ? 'ON' : 'OFF'}</strong>
      </div>
      <div class="pf-flag ${u.agents_on ? 'pf-flag-on' : ''}">
        🤖 Agent Bot <strong>${u.agents_on ? 'ON' : 'OFF'}</strong>
      </div>
      <div class="pf-flag ${u.sys_bot_on ? 'pf-flag-on' : ''}">
        🔧 System Bot <strong>${u.sys_bot_on ? 'ON' : 'OFF'}</strong>
      </div>
    </div>` : ''}

    <div style="padding-top:14px;border-top:1px solid var(--border-color);margin-top:14px">
      <a href="#tg-setup" onclick="showPage('tg-setup')" class="btn btn-secondary btn-sm">
        📱 Telegram Setup →
      </a>
    </div>
  </div>

  <!-- ── Gemini API usage (admin only) ── -->
  ${isAdmin ? `<div class="card" style="margin-bottom:20px" id="pf-gemini-card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h3 style="font-size:14px;font-weight:600;margin:0">✨ Gemini API Usage</h3>
      <button class="btn btn-secondary btn-sm" onclick="loadGeminiUsage()">↺ Refresh</button>
    </div>
    <div id="pf-gemini-usage"><p class="text-muted" style="font-size:13px">Loading…</p></div>
  </div>` : ''}

  <!-- ── Change password (DB users only) ── -->
  ${!isAdmin ? `
  <div class="card">
    <h3 style="font-size:14px;font-weight:600;margin:0 0 14px">🔒 Change Password</h3>
    <div style="display:flex;flex-direction:column;gap:10px;max-width:360px">
      <div>
        <label class="form-label">Current password</label>
        <input id="pf-pw-current" type="password" class="input" style="margin-top:4px"
          placeholder="Current password">
      </div>
      <div>
        <label class="form-label">New password</label>
        <input id="pf-pw-new" type="password" class="input" style="margin-top:4px"
          placeholder="New password (min 6 chars)">
      </div>
      <div>
        <label class="form-label">Confirm new password</label>
        <input id="pf-pw-confirm" type="password" class="input" style="margin-top:4px"
          placeholder="Repeat new password">
      </div>
      <div id="pf-pw-msg" class="pf-err"></div>
      <button class="btn btn-primary" style="align-self:flex-start" onclick="pfChangePassword()">
        Update Password
      </button>
    </div>
  </div>` : ''}

</div>`;
}

function renderTgSetupCard(u) {
    const isAdmin     = u.role === 'admin';
    const hasTelegram = !!u.telegram_phone || !!u.telegram_session;

    return `
  <!-- ── Telegram account ── -->
  <div class="card" style="margin-bottom:20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <h3 style="font-size:14px;font-weight:600;margin:0">📱 Telegram Account</h3>
      <div style="display:flex;gap:8px">
        ${isAdmin && hasTelegram ? `<button class="btn btn-secondary btn-sm" id="pf-tg-test-btn" onclick="pfTestTgConnection()">🔌 Test</button>` : ''}
        <button class="btn ${hasTelegram ? 'btn-secondary' : 'btn-primary'} btn-sm" onclick="startTgRelink()">
          ${hasTelegram ? '🔄 Re-link' : '🔗 Link Telegram'}
        </button>
        ${hasTelegram ? `<button class="btn btn-danger btn-sm" onclick="pfDisconnectTelegram()">✕ Disconnect</button>` : ''}
      </div>
    </div>

    <!-- Profile info — populated async by loadTgProfile() -->
    <div id="pf-tg-profile">
      ${hasTelegram
        ? `<div style="display:flex;align-items:center;gap:10px">
             <div style="width:40px;height:40px;border-radius:50%;background:var(--accent-primary);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;flex-shrink:0">
               ${(u.telegram_phone || '?')[0]}
             </div>
             <div>
               ${u.telegram_phone ? `<div style="font-size:14px;font-weight:500">${escapeHtmlSys(u.telegram_phone)}</div>` : ''}
               <span style="font-size:11px;color:var(--text-muted)">Checking connection…</span>
             </div>
           </div>`
        : `<div style="display:flex;align-items:center;gap:10px">
             <span style="font-size:20px">⚠️</span>
             <div>
               <div style="font-size:13px;color:var(--warning)">No Telegram account linked</div>
               <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Link your account to enable monitoring</div>
             </div>
           </div>`}
    </div>

    <!-- Test connection logs -->
    <div id="pf-tg-test-logs" style="display:none;margin-top:10px;background:var(--bg-secondary);border-radius:6px;padding:8px 10px;font-family:monospace;font-size:11px;max-height:120px;overflow-y:auto"></div>

    <!-- Subscribed channels — admin only, loaded async -->
    ${isAdmin ? `<div id="pf-tg-channels" style="margin-top:2px"></div>` : ''}

    <!-- OTP re-link form (hidden by default) -->
    <div id="pf-tg-form" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border-color)">
      <div style="font-size:13px;font-weight:500;margin-bottom:12px">Link a Telegram account via OTP</div>
      <!-- Step 1: Phone -->
      <div id="pf-tg-step-phone">
        <label class="form-label">Phone number (with country code)</label>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input id="pf-tg-phone" type="tel" class="input" placeholder="+1 234 567 8900"
            style="flex:1" onkeydown="if(event.key==='Enter') pfSendCode()">
          <button class="btn btn-primary" onclick="pfSendCode()">Send Code</button>
        </div>
        <div id="pf-tg-phone-err" class="pf-err"></div>
        <button class="btn btn-secondary btn-sm" style="margin-top:10px" onclick="cancelTgRelink()">Cancel</button>
      </div>
      <!-- Step 2: Code -->
      <div id="pf-tg-step-code" style="display:none">
        <label class="form-label">Verification code sent to Telegram</label>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input id="pf-tg-code" type="text" class="input" placeholder="12345"
            maxlength="8" style="flex:1;letter-spacing:.15em"
            onkeydown="if(event.key==='Enter') pfVerifyCode()">
          <button class="btn btn-primary" onclick="pfVerifyCode()">Verify</button>
        </div>
        <div id="pf-tg-code-err" class="pf-err"></div>
        <button class="btn btn-secondary btn-sm" style="margin-top:10px" onclick="pfBackToPhone()">← Change number</button>
      </div>
      <!-- Step 3: 2FA -->
      <div id="pf-tg-step-2fa" style="display:none">
        <label class="form-label">Two-factor authentication password</label>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input id="pf-tg-2fa" type="password" class="input" placeholder="Your 2FA password"
            style="flex:1" onkeydown="if(event.key==='Enter') pfVerify2FA()">
          <button class="btn btn-primary" onclick="pfVerify2FA()">Confirm</button>
        </div>
        <div id="pf-tg-2fa-err" class="pf-err"></div>
      </div>
    </div>

  </div>`;
}

// ── Gemini usage ──────────────────────────────────────────────────────────────

async function loadGeminiUsage() {
    const el = document.getElementById('pf-gemini-usage');
    if (!el) return;
    const token = localStorage.getItem('auth_token');
    const r = await fetch('/api/system/gemini-usage', {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    });
    if (!r.ok) { el.innerHTML = '<p style="color:var(--danger);font-size:13px">Failed to load usage.</p>'; return; }
    const data = await r.json();

    function meter(label, desc, used, limit, usedOverride, limOverride) {
        const pct = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
        const color = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--success)';
        const usedFmt = usedOverride ?? (used >= 1_000_000 ? (used / 1_000_000).toFixed(2) + 'M' : used.toLocaleString());
        const limFmt  = limOverride  ?? (limit >= 1_000_000 ? (limit / 1_000_000).toFixed(0) + 'M' : limit.toLocaleString());
        return `
          <div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
              <span style="font-size:13px;font-weight:500">${label}</span>
              <span style="font-size:12px;color:var(--text-muted)">${desc}</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <div style="flex:1;background:var(--border);border-radius:4px;height:6px;overflow:hidden">
                <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width .4s"></div>
              </div>
              <span style="font-size:12px;min-width:90px;text-align:right;color:var(--text-muted)">
                <strong style="color:var(--text-primary)">${usedFmt}</strong> / ${limFmt}
              </span>
            </div>
          </div>`;
    }

    // Format video hours
    const vidUsedH  = (data.video.used  / 3600).toFixed(2);
    const vidLimH   = (data.video.limit / 3600).toFixed(0);

    el.innerHTML =
        meter('RPM',   'Requests per minute',            data.rpm.used,   data.rpm.limit) +
        meter('TPM',   'Total tokens per minute (in+out)', data.tpm.used, data.tpm.limit) +
        meter('RPD',   'Requests per day',               data.rpd.used,   data.rpd.limit) +
        meter('Video', 'Native video hours per day',     data.video.used, data.video.limit,
              `${vidUsedH}h`, `${vidLimH}h`) +
        `<p style="font-size:11px;color:var(--text-muted);margin-top:4px">
           RPM &amp; TPM reset every 60 s · RPD &amp; Video reset at midnight
         </p>`;
}

// ── Telegram profile & channels (async loaders) ──────────────────────────────

async function loadTgProfile() {
    const el = document.getElementById('pf-tg-profile');
    if (!el) return;
    const token = localStorage.getItem('auth_token');
    const data = await fetch('/api/telegram/userbot/me', {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    }).then(r => r.json()).catch(() => ({}));

    if (data.status === 'ok') {
        const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
        const initial = (data.first_name || data.username || '?')[0].toUpperCase();
        el.innerHTML = `
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:44px;height:44px;border-radius:50%;background:var(--accent-primary);
                        display:flex;align-items:center;justify-content:center;
                        font-size:18px;font-weight:700;color:#fff;flex-shrink:0">${initial}</div>
            <div>
              <div style="font-size:15px;font-weight:600">${escapeHtmlSys(name || 'Unknown')}</div>
              ${data.username ? `<div style="font-size:12px;color:var(--text-muted)">@${escapeHtmlSys(data.username)}</div>` : ''}
              ${data.phone ? `<div style="font-size:12px;color:var(--text-muted)">+${escapeHtmlSys(data.phone)}</div>` : ''}
              <span style="font-size:11px;padding:2px 7px;border-radius:8px;
                           background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);
                           color:#6ee7b7;margin-top:5px;display:inline-block">✅ Connected</span>
            </div>
          </div>`;
    } else if (data.status === 'unauthorized') {
        el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:var(--warning);font-size:13px">
          <span>⚠️</span><span>Session expired — please re-link your account</span></div>`;
    } else if (data.status === 'no_session') {
        el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:13px">
          <span>📵</span><span>No session configured</span></div>`;
    } else {
        el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:var(--warning);font-size:13px">
          <span>⚠️</span><span>Could not verify: ${escapeHtmlSys(data.message || 'unknown error')}</span></div>`;
    }
}

async function loadTgChannels() {
    const el = document.getElementById('pf-tg-channels');
    if (!el) return;
    el.innerHTML = '';
    const token = localStorage.getItem('auth_token');
    const data = await fetch('/api/telegram/userbot/dialogs', {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    }).then(r => r.json()).catch(() => ({}));

    if (data.status !== 'ok' || !data.channels?.length) return;

    const channels = data.channels;
    el.innerHTML = `
      <div style="border-top:1px solid var(--border-color);margin-top:14px;padding-top:14px">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">
          📡 Subscribed Channels (${channels.length})
        </div>
        <div style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">
          ${channels.map(ch => `
            <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;
                        background:var(--bg-secondary);font-size:12px">
              <span>${ch.is_group ? '👥' : '📢'}</span>
              <div style="flex:1;overflow:hidden">
                <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${escapeHtmlSys(ch.title || ch.username || 'Unknown')}
                </div>
                ${ch.username ? `<div style="color:var(--text-muted)">@${escapeHtmlSys(ch.username)}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
        ${data.updated_at ? `<div style="font-size:10px;color:var(--text-muted);margin-top:6px">
          Last refreshed: ${new Date(data.updated_at).toLocaleString()}</div>` : ''}
      </div>`;
}

async function pfTestTgConnection() {
    const btn = document.getElementById('pf-tg-test-btn');
    const logsEl = document.getElementById('pf-tg-test-logs');
    if (!logsEl) return;
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    logsEl.style.display = '';
    logsEl.innerHTML = '<span style="color:var(--text-muted)">Connecting…</span>';

    const token = localStorage.getItem('auth_token');
    const data = await fetch('/api/telegram/session/test', {
        method: 'POST',
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    }).then(r => r.json()).catch(() => ({ logs: ['[ERROR] Request failed'] }));

    const logs = data.logs || [];
    logsEl.innerHTML = logs.map(l => {
        const color = l.includes('[ERROR]') ? 'var(--danger)' : l.includes('[SUCCESS]') ? 'var(--success)' : 'var(--text-muted)';
        return `<div style="color:${color}">${escapeHtmlSys(l)}</div>`;
    }).join('');

    if (btn) { btn.disabled = false; btn.textContent = '🔌 Test'; }
    // Refresh profile after test
    if (data.status === 'ok') loadTgProfile();
}

// ── Telegram re-link flow ─────────────────────────────────────────────────────

function startTgRelink() {
    document.getElementById('pf-tg-form').style.display = '';
    document.getElementById('pf-tg-step-phone').style.display = '';
    document.getElementById('pf-tg-step-code').style.display  = 'none';
    document.getElementById('pf-tg-step-2fa').style.display   = 'none';
    document.getElementById('pf-tg-phone-err').textContent    = '';
    const ph = document.getElementById('pf-tg-phone');
    if (ph) { ph.value = ''; ph.focus(); }
}

function cancelTgRelink() {
    document.getElementById('pf-tg-form').style.display = 'none';
}

async function pfSendCode() {
    const ph = document.getElementById('pf-tg-phone').value
        .replace(/[\s\-().]/g, '').replace(/^00/, '+');
    const errEl = document.getElementById('pf-tg-phone-err');
    errEl.textContent = '';
    if (!ph) { errEl.textContent = 'Enter a phone number.'; return; }

    const btn = document.querySelector('#pf-tg-step-phone .btn-primary');
    btn.disabled = true; btn.textContent = 'Sending…';

    const token = localStorage.getItem('auth_token');
    const r = await fetch('/api/auth/telegram/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ phone: ph }),
    });
    const data = await r.json();
    btn.disabled = false; btn.textContent = 'Send Code';

    if (data.error) { errEl.textContent = data.error; return; }

    _tgLinkPhone = ph;
    document.getElementById('pf-tg-step-phone').style.display = 'none';
    document.getElementById('pf-tg-step-code').style.display  = '';
    document.getElementById('pf-tg-code-err').textContent     = '';
    const codeEl = document.getElementById('pf-tg-code');
    if (codeEl) { codeEl.value = ''; codeEl.focus(); }
}

async function pfVerifyCode() {
    const code  = document.getElementById('pf-tg-code').value.trim();
    const errEl = document.getElementById('pf-tg-code-err');
    errEl.textContent = '';
    if (!code) { errEl.textContent = 'Enter the code.'; return; }

    const btn = document.querySelector('#pf-tg-step-code .btn-primary');
    btn.disabled = true; btn.textContent = 'Verifying…';

    const token = localStorage.getItem('auth_token');
    const r = await fetch('/api/auth/telegram/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ phone: _tgLinkPhone, code }),
    });
    const data = await r.json();
    btn.disabled = false; btn.textContent = 'Verify';

    if (data.status === 'needs_2fa') {
        document.getElementById('pf-tg-step-code').style.display = 'none';
        document.getElementById('pf-tg-step-2fa').style.display  = '';
        document.getElementById('pf-tg-2fa-err').textContent     = '';
        const el = document.getElementById('pf-tg-2fa');
        if (el) { el.value = ''; el.focus(); }
        return;
    }

    if (data.error) { errEl.textContent = data.error; return; }

    pfTgSuccess(data.session_string);
}

async function pfVerify2FA() {
    const pw    = document.getElementById('pf-tg-2fa').value;
    const errEl = document.getElementById('pf-tg-2fa-err');
    errEl.textContent = '';
    if (!pw) { errEl.textContent = 'Enter your 2FA password.'; return; }

    const btn = document.querySelector('#pf-tg-step-2fa .btn-primary');
    btn.disabled = true; btn.textContent = 'Confirming…';

    const token = localStorage.getItem('auth_token');
    const r = await fetch('/api/auth/telegram/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ phone: _tgLinkPhone, password: pw }),
    });
    const data = await r.json();
    btn.disabled = false; btn.textContent = 'Confirm';

    if (data.error) { errEl.textContent = data.error; return; }

    pfTgSuccess(data.session_string);
}

function pfBackToPhone() {
    document.getElementById('pf-tg-step-code').style.display  = 'none';
    document.getElementById('pf-tg-step-phone').style.display = '';
    document.getElementById('pf-tg-phone-err').textContent    = '';
    _tgLinkPhone = null;
}

function pfTgSuccess(sessionString) {
    if (_profileUser) {
        _profileUser.telegram_phone = _tgLinkPhone;
        if (sessionString) _profileUser.telegram_session = sessionString;
    }
    document.getElementById('pf-tg-form').style.display = 'none';
    // Clear form inputs
    ['pf-tg-phone', 'pf-tg-code', 'pf-tg-2fa'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    // Refresh the Telegram Setup display with real data from Telegram
    loadTgProfile();
    if (_profileUser?.role === 'admin') loadTgChannels();
}

function _reloadTgSetup() {
    if (_profileUser) {
        loadTgSetupPage();
    }
}

// ── Change password ───────────────────────────────────────────────────────────

async function pfChangePassword() {
    const current  = document.getElementById('pf-pw-current').value;
    const newPw    = document.getElementById('pf-pw-new').value;
    const confirm  = document.getElementById('pf-pw-confirm').value;
    const msgEl    = document.getElementById('pf-pw-msg');
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = '';

    if (!current)          { msgEl.textContent = 'Enter your current password.'; return; }
    if (newPw.length < 6)  { msgEl.textContent = 'New password must be at least 6 characters.'; return; }
    if (newPw !== confirm)  { msgEl.textContent = 'Passwords do not match.'; return; }

    const btn = document.querySelector('.card:last-child .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const token = localStorage.getItem('auth_token');
    const r = await fetch('/api/auth/profile/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ current_password: current, new_password: newPw }),
    });
    const data = await r.json();
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }

    if (data.error) { msgEl.textContent = data.error; return; }

    msgEl.style.color  = 'var(--success, #10b981)';
    msgEl.textContent  = 'Password updated successfully.';
    document.getElementById('pf-pw-current').value = '';
    document.getElementById('pf-pw-new').value     = '';
    document.getElementById('pf-pw-confirm').value = '';
}

// ── Update session string ─────────────────────────────────────────────────────

async function pfUpdateSession() {
    const ssVal  = (document.getElementById('pf-ss-value').value || '').trim();
    const phone  = (document.getElementById('pf-ss-phone').value || '').trim();
    const msgEl  = document.getElementById('pf-ss-msg');
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = '';

    if (!ssVal) { msgEl.textContent = 'Session string cannot be empty.'; return; }

    const btn = document.querySelector('#pf-ss-msg ~ button');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const token = localStorage.getItem('auth_token');
    const r = await fetch('/api/auth/profile/update-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ session_string: ssVal, phone }),
    });
    const data = await r.json();
    if (btn) { btn.disabled = false; btn.textContent = 'Save Session'; }

    if (data.error) { msgEl.textContent = data.error; return; }

    msgEl.style.color = 'var(--success, #10b981)';
    msgEl.textContent = 'Session saved!';
    if (_profileUser) {
        _profileUser.telegram_session = ssVal;
        if (phone) _profileUser.telegram_phone = phone;
    }
    // Refresh the live Telegram Setup display
    loadTgProfile();
    if (_profileUser?.role === 'admin') loadTgChannels();
    setTimeout(() => {
        msgEl.textContent = '';
        const ssEl = document.getElementById('pf-ss-value');
        if (ssEl) ssEl.value = '';
    }, 2500);
}

// ── Injected styles ───────────────────────────────────────────────────────────
(function injectProfileStyles() {
    if (document.getElementById('pf-styles')) return;
    const s = document.createElement('style');
    s.id = 'pf-styles';
    s.textContent = `
    .pf-avatar {
        width:52px; height:52px; border-radius:50%; background:var(--accent-primary);
        color:#fff; display:flex; align-items:center; justify-content:center;
        font-size:22px; font-weight:700; flex-shrink:0;
    }
    .pf-badge {
        font-size:11px; padding:3px 8px; border-radius:10px;
        background:rgba(255,255,255,0.07); border:1px solid var(--border-color);
        color:var(--text-muted);
    }
    .pf-badge-admin  { background:rgba(139,92,246,.15); border-color:rgba(139,92,246,.35); color:#c4b5fd; }
    .pf-badge-user   { background:rgba(99,179,237,.12); border-color:rgba(99,179,237,.3);  color:#93c5fd; }
    .pf-badge-active { background:rgba(16,185,129,.12); border-color:rgba(16,185,129,.3);  color:#6ee7b7; }
    .pf-badge-inactive { background:rgba(239,68,68,.1); border-color:rgba(239,68,68,.25); color:#fca5a5; }
    .pf-flag {
        font-size:12px; padding:6px 12px; border-radius:8px;
        background:rgba(255,255,255,.04); border:1px solid var(--border-color);
        color:var(--text-muted);
    }
    .pf-flag-on {
        background:rgba(16,185,129,.08); border-color:rgba(16,185,129,.25); color:#6ee7b7;
    }
    .pf-err {
        font-size:12px; color:var(--danger); margin-top:6px; min-height:16px;
    }
    `;
    document.head.appendChild(s);
})();

// ── Disconnect Telegram ───────────────────────────────────────────────────────

function pfDisconnectTelegram() {
    showConfirm(
        'Disconnect your Telegram account? You will no longer receive channel updates until you re-link.',
        async () => {
            const token = localStorage.getItem('auth_token');
            try {
                const res = await fetch('/api/auth/profile/disconnect-telegram', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token },
                });
                const data = await res.json();
                if (data.status === 'ok') {
                    showNotification('Telegram account disconnected', 'success');
                    loadTgSetupPage();
                } else {
                    showNotification(data.error || 'Disconnect failed', 'error');
                }
            } catch (e) {
                showNotification('Connection error', 'error');
            }
        },
        { title: 'Disconnect Telegram', icon: '🔌', confirmLabel: 'Disconnect', confirmClass: 'btn-danger' }
    );
}
