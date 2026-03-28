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
}

function renderProfilePage(u) {
    const isAdmin     = u.role === 'admin';
    const hasTelegram = !!u.telegram_phone || !!u.telegram_session;
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
      <div class="pf-flag ${u.agents_on ? 'pf-flag-on' : ''}">
        🤖 Agent Chat <strong>${u.agents_on ? 'ON' : 'OFF'}</strong>
      </div>
    </div>` : ''}
  </div>

  <!-- ── Telegram account ── -->
  <div class="card" style="margin-bottom:20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <h3 style="font-size:14px;font-weight:600;margin:0">📱 Telegram Account</h3>
      ${hasTelegram
        ? `<button class="btn btn-secondary btn-sm" onclick="startTgRelink()">Re-link</button>`
        : `<button class="btn btn-primary btn-sm" onclick="startTgRelink()">Link Telegram</button>`}
    </div>

    <div id="pf-tg-status">
      ${hasTelegram
        ? `<div style="display:flex;align-items:center;gap:10px">
             <span style="font-size:22px">✅</span>
             <div>
               ${u.telegram_phone ? `<div style="font-size:14px;font-weight:500">${escapeHtmlSys(u.telegram_phone)}</div>` : ''}
               <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Telegram account linked</div>
               ${u.telegram_session ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;max-width:300px">Session: ${u.telegram_session.substring(0, 40)}…</div>` : ''}
             </div>
           </div>`
        : `<div style="display:flex;align-items:center;gap:10px">
             <span style="font-size:22px">⚠️</span>
             <div>
               <div style="font-size:13px;color:var(--warning)">No Telegram account linked</div>
               <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Link your account to receive messages</div>
             </div>
           </div>`}
    </div>

    <!-- OTP re-link form (hidden by default) -->
    <div id="pf-tg-form" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border-color)">
      <!-- Step 1: Phone input -->
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

      <!-- Step 2: Code input -->
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
  </div>

  <!-- ── Update Session String ── -->
  <div class="card" style="margin-bottom:20px">
    <h3 style="font-size:14px;font-weight:600;margin:0 0 14px">🔑 Telegram Session String</h3>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
      Paste a <code>StringSession</code> directly (e.g. from <code>get_ss.py</code>). This replaces the OTP flow and works for all accounts including admin.
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;max-width:480px">
      <div>
        <label class="form-label">Phone number (optional)</label>
        <input id="pf-ss-phone" type="tel" class="input" style="margin-top:4px"
          placeholder="+1 234 567 8900" value="${escapeHtmlSys(u.telegram_phone || '')}">
      </div>
      <div>
        <label class="form-label">Session string</label>
        <textarea id="pf-ss-value" class="input" rows="4"
          style="margin-top:4px;resize:vertical;font-family:monospace;font-size:11px"
          placeholder="Paste your StringSession here…">${escapeHtmlSys(u.telegram_session || '')}</textarea>
      </div>
      <div id="pf-ss-msg" class="pf-err"></div>
      <button class="btn btn-primary" style="align-self:flex-start" onclick="pfUpdateSession()">
        Save Session
      </button>
    </div>
  </div>

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

    pfTgSuccess();
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

    pfTgSuccess();
}

function pfBackToPhone() {
    document.getElementById('pf-tg-step-code').style.display  = 'none';
    document.getElementById('pf-tg-step-phone').style.display = '';
    document.getElementById('pf-tg-phone-err').textContent    = '';
    _tgLinkPhone = null;
}

function pfTgSuccess() {
    // Update local user state and re-render status
    if (_profileUser) _profileUser.telegram_phone = _tgLinkPhone;

    document.getElementById('pf-tg-form').style.display = 'none';
    document.getElementById('pf-tg-status').innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:22px">✅</span>
        <div>
          <div style="font-size:14px;font-weight:500">${escapeHtmlSys(_tgLinkPhone)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Telegram account linked</div>
          ${_profileUser?.telegram_session ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;max-width:300px">Session: ${_profileUser.telegram_session.substring(0, 40)}…</div>` : ''}
        </div>
      </div>`;
    
    // Clear form
    document.getElementById('pf-tg-phone').value = '';
    document.getElementById('pf-tg-code').value = '';
    document.getElementById('pf-tg-2fa').value = '';
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
    msgEl.textContent = 'Session saved successfully!';
    
    // Update local user state
    if (_profileUser) {
        _profileUser.telegram_session = ssVal;
        if (phone) _profileUser.telegram_phone = phone;
        
        // Update status display without full reload
        const hasTelegram = !!_profileUser.telegram_phone || !!_profileUser.telegram_session;
        if (hasTelegram) {
            document.getElementById('pf-tg-status').innerHTML = `
              <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:22px">✅</span>
                <div>
                  ${_profileUser.telegram_phone ? `<div style="font-size:14px;font-weight:500">${escapeHtmlSys(_profileUser.telegram_phone)}</div>` : ''}
                  <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Telegram account linked</div>
                  ${_profileUser.telegram_session ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;max-width:300px">Session: ${_profileUser.telegram_session.substring(0, 40)}…</div>` : ''}
                </div>
              </div>`;
        }
    }
    
    // Clear form after 2 seconds
    setTimeout(() => { document.getElementById('pf-ss-value').value = ''; }, 2000);
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
