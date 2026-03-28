'use strict';

// ── Global state ──────────────────────────────────────────────────────────────
let _acctData   = null;
let currentUser = null;

// ── Bootstrap: fetch current user role on page load ──────────────────────────
let _authReadyResolve;
const authReady = new Promise(res => { _authReadyResolve = res; });

(async function initCurrentUser() {
    try {
        const token = localStorage.getItem('auth_token');
        const r = await fetch('/api/auth/me', {
            headers: token ? { 'Authorization': 'Bearer ' + token } : {},
        });
        if (!r.ok) return;
        currentUser = await r.json();

        // Update profile nav label with username
        const navLbl = document.getElementById('profile-nav-username');
        if (navLbl) navLbl.textContent = currentUser.username;

        const isAdmin = currentUser.role === 'admin';

        // Show/hide nav sections based on role and feature flags
        const show = (id, visible) => {
            const el = document.getElementById(id);
            if (el) el.style.display = visible ? '' : 'none';
        };

        const hasBotAccess = isAdmin || !!currentUser.has_bot_access;

        show('admin-nav-section', isAdmin);
        // News Summaries: hidden for users with no bot inheritance
        show('news-nav-section', hasBotAccess);
        // YouTube Summaries: hidden for users without youtube_on
        show('yt-nav-section',   isAdmin || !!currentUser.youtube_on);
        // AI Tools: hidden for users without agents_on
        show('ai-nav-section',   isAdmin || !!currentUser.agents_on);

        // If the currently active page is now hidden, fall back to system
        const newsPages  = ['collections', 'bots', 'monitor', 'dashboard'];
        const ytPages    = ['yt-channels', 'yt-keywords', 'yt-videos', 'yt-chat'];
        const aiPages    = ['agent-chat', 'system-chat'];
        const adminPages = ['accounts'];
        const activePage = localStorage.getItem('activePage') || 'system';

        const pageHidden =
            (!hasBotAccess && newsPages.includes(activePage)) ||
            (!isAdmin && !currentUser.youtube_on && ytPages.includes(activePage)) ||
            (!isAdmin && !currentUser.agents_on  && aiPages.includes(activePage)) ||
            (!isAdmin && adminPages.includes(activePage));

        if (pageHidden) {
            localStorage.setItem('activePage', 'system');
        }
    } catch (_) {}
    _authReadyResolve();
})();

// ── API helper ────────────────────────────────────────────────────────────────
async function acctApi(method, path, body) {
    const token = localStorage.getItem('auth_token');
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
        },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(path, opts);
    try { return await r.json(); } catch { return { status: 'error' }; }
}

// ── Load & render ─────────────────────────────────────────────────────────────
async function loadAccountsData() {
    const el = document.getElementById('accounts-content');
    if (!el) return;
    el.innerHTML = '<p class="text-muted">Loading…</p>';

    const data = await acctApi('GET', '/api/admin/accounts');
    if (data.error || data.detail) {
        el.innerHTML = `<p style="color:var(--danger)">${data.error || data.detail}</p>`;
        return;
    }
    _acctData = data;
    renderAccounts(data, el);
}

function renderAccounts(data, container) {
    const users    = (data.users || []).filter(u => u.role !== 'admin');
    const allBots  = data.available_bots || [];
    const allChans = data.yt_channels    || [];
    const allKws   = data.yt_keywords    || [];
    const cats     = data.categories     || [];

    const badge = document.getElementById('accounts-count');
    if (badge) {
        badge.textContent   = users.length;
        badge.style.display = users.length ? '' : 'none';
    }

    if (!users.length) {
        container.innerHTML = `
          <div class="card" style="text-align:center;padding:40px 20px">
            <div style="font-size:32px;margin-bottom:12px">👥</div>
            <p class="text-muted">No registered users yet.</p>
            <p class="text-muted" style="font-size:12px;margin-top:6px">
              Users register at <a href="/register" style="color:var(--accent-primary)">/register</a>
            </p>
          </div>`;
        return;
    }

    container.innerHTML = users.map(u =>
        renderUserCard(u, allBots, allChans, allKws, cats)
    ).join('');
}

// ── User card ─────────────────────────────────────────────────────────────────
function renderUserCard(u, allBots, allChans, allKws, cats) {
    const pendingYt = (u.yt_inheritances || []).filter(i => i.status === 'pending').length;

    return `
<div class="card" id="acct-card-${u.id}" style="margin-bottom:16px">

  <!-- ── Header ── -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px;flex-wrap:wrap">
    <div style="display:flex;align-items:center;gap:12px">
      <div class="ac-avatar">${u.username[0].toUpperCase()}</div>
      <div>
        <div style="font-size:15px;font-weight:600">${escapeHtmlSys(u.username)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          ${u.telegram_phone
            ? `<span class="ac-chip ac-chip-tg">📱 ${escapeHtmlSys(u.telegram_phone)}</span>`
            : `<span class="ac-chip ac-chip-warn">⚠ No Telegram</span>`}
          <span class="ac-chip">Joined ${fmtDate(u.created_at)}</span>
        </div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:7px">
        <label class="toggle-switch">
          <input type="checkbox" ${u.is_active ? 'checked' : ''}
            onchange="setUserFlag(${u.id}, 'is_active', this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <span id="active-label-${u.id}" style="font-size:12px;color:var(--text-muted)">
          ${u.is_active ? 'Active' : 'Inactive'}
        </span>
      </div>
      <button class="btn btn-danger btn-sm"
        onclick="deleteUser(${u.id}, '${escapeHtmlSys(u.username)}')">Delete</button>
    </div>
  </div>

  <!-- ── Feature toggles ── -->
  <div class="ac-features">
    <div class="ac-feature-row">
      <label class="toggle-switch">
        <input type="checkbox" ${u.youtube_on ? 'checked' : ''}
          onchange="setUserFlag(${u.id}, 'youtube_on', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:13px">📺 YouTube Summaries</span>
    </div>

    <div class="ac-feature-row" id="agents-feature-row-${u.id}">
      <label class="toggle-switch">
        <input type="checkbox" ${u.agents_on ? 'checked' : ''}
          onchange="setUserFlag(${u.id}, 'agents_on', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:13px">🤖 Agent Chat</span>
      ${renderAgentsLimit(u)}
    </div>
  </div>

  <!-- ── Bot Inheritance ── -->
  <div class="ac-section">
    <div class="ac-section-hd" onclick="toggleAcctSection('bots-${u.id}')">
      <span>🤖 Bot Inheritance</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="ac-chip">${(u.bot_inheritances || []).length} granted</span>
        <span class="ac-chevron" id="chevron-bots-${u.id}">▶</span>
      </div>
    </div>
    <div class="ac-section-bd" id="bots-${u.id}" style="display:none">
      ${renderBotInheritance(u, allBots, cats)}
    </div>
  </div>

  <!-- ── YouTube Inheritance ── -->
  <div class="ac-section">
    <div class="ac-section-hd" onclick="toggleAcctSection('yt-${u.id}')">
      <span>📺 YouTube Inheritance</span>
      <div style="display:flex;align-items:center;gap:8px">
        ${pendingYt ? `<span class="ac-chip ac-chip-warn">${pendingYt} pending</span>` : ''}
        <span class="ac-chip">${(u.yt_inheritances || []).length} items</span>
        <span class="ac-chevron" id="chevron-yt-${u.id}">▶</span>
      </div>
    </div>
    <div class="ac-section-bd" id="yt-${u.id}" style="display:none">
      ${renderYtInheritance(u, allChans, allKws)}
    </div>
  </div>

</div>`;
}

function renderAgentsLimit(u) {
    if (!u.agents_on) return '';
    const lim   = u.agents_limit || {};
    const type  = lim.type  || 'calls';
    const value = lim.value != null ? lim.value : '';
    const label = lim.type === 'money'
        ? `$${lim.value}`
        : lim.value != null ? `${lim.value} calls` : 'No limit';
    return `
<div class="ac-limit-row" id="agents-limit-${u.id}">
  <select class="select" style="font-size:12px;padding:4px 8px;height:28px"
    onchange="setAgentsLimitType(${u.id}, this.value)">
    <option value="calls" ${type === 'calls' ? 'selected' : ''}>Call limit</option>
    <option value="money" ${type === 'money' ? 'selected' : ''}>$ limit</option>
  </select>
  <input type="number" class="ac-num-inp"
    placeholder="∞" value="${value}"
    onblur="setAgentsLimitValue(${u.id}, this)"
    min="0" step="0.01">
  <span id="limit-display-${u.id}" style="font-size:11px;color:var(--text-muted)">${label}</span>
</div>`;
}

// ── Bot inheritance panel ─────────────────────────────────────────────────────
function renderBotInheritance(u, allBots, cats) {
    const granted    = u.bot_inheritances || [];
    const grantedIds = new Set(granted.map(g => g.bot_id));

    const grantedRows = granted.map(g => {
        const botCats = cats.filter(c => c.bot_id === g.bot_id);
        const selCats = (g.inherit_categories && g.inherit_categories.length)
            ? new Set(g.inherit_categories) : null;
        const selTops = (g.inherit_topics && g.inherit_topics.length)
            ? new Set(g.inherit_topics) : null;

        const featureChecks = ['keywords','rules','prompts','messages_db'].map(f => `
          <label class="ac-check">
            <input type="checkbox" ${g['inherit_' + f] ? 'checked' : ''}
              onchange="updateBotFlag(${u.id}, ${g.bot_id}, 'inherit_${f}', this.checked)">
            ${f === 'messages_db' ? 'Share messages DB' : f.charAt(0).toUpperCase() + f.slice(1)}
          </label>`).join('');

        const treeHtml = botCats.length ? `
          <div class="ac-tree">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
              Category / Topic access &nbsp;<span style="opacity:.6">(all checked = full access)</span>
            </div>
            ${botCats.map(c => {
                const catOn = selCats === null || selCats.has(c.category_id);
                const topicRows = (c.topics || []).map(t => {
                    const topOn = selTops === null || selTops.has(t.id);
                    return `<label class="ac-check">
                        <input type="checkbox" data-topic-id="${t.id}"
                          ${topOn ? 'checked' : ''}
                          onchange="updateBotTopics(${u.id}, ${g.bot_id})">
                        🏷 ${escapeHtmlSys(t.name)}
                      </label>`;
                }).join('');
                return `
                <div style="margin-bottom:8px">
                  <label class="ac-check" style="font-weight:500">
                    <input type="checkbox" data-cat-id="${c.category_id}"
                      ${catOn ? 'checked' : ''}
                      onchange="updateBotCategories(${u.id}, ${g.bot_id})">
                    📁 ${escapeHtmlSys(c.category_name)}
                  </label>
                  ${topicRows ? `<div style="margin-left:22px;display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${topicRows}</div>` : ''}
                </div>`;
            }).join('')}
          </div>` : '';

        return `
<div class="ac-inh-row" id="inh-bot-${u.id}-${g.bot_id}">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
    <span style="font-size:13px;font-weight:500">🤖 ${escapeHtmlSys(g.bot_name)}</span>
    <button class="btn btn-danger" style="padding:3px 9px;font-size:11px"
      onclick="revokeBot(${u.id}, ${g.bot_id})">Revoke</button>
  </div>
  <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
    <div style="display:flex;flex-wrap:wrap;gap:10px">${featureChecks}</div>
    ${treeHtml}
  </div>
</div>`;
    }).join('');

    const available = allBots.filter(b => !grantedIds.has(b.id));
    const grantRow  = available.length ? `
<div class="ac-add-row">
  <select class="select" style="font-size:12px;padding:4px 8px;height:28px"
    id="grant-bot-sel-${u.id}">
    <option value="">— Select bot to grant —</option>
    ${available.map(b =>
        `<option value="${b.id}">${escapeHtmlSys(b.name)}</option>`).join('')}
  </select>
  <button class="btn btn-primary btn-sm" onclick="grantBot(${u.id})">Grant Access</button>
</div>`
    : `<p style="font-size:12px;color:var(--text-muted);margin-top:6px">All bots already granted.</p>`;

    return (grantedRows || '') + grantRow;
}

// ── YouTube inheritance panel ─────────────────────────────────────────────────
function renderYtInheritance(u, allChans, allKws) {
    const items   = u.yt_inheritances || [];
    const pushed  = new Set(items.map(i => `${i.source_type}:${i.source_id}`));

    const statusBadge = s =>
        s === 'confirmed' ? `<span class="badge" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.3)">✓ Confirmed</span>`
        : s === 'rejected' ? `<span class="badge" style="background:rgba(239,68,68,.1);color:#fca5a5;border:1px solid rgba(239,68,68,.25)">✗ Rejected</span>`
        : `<span class="badge" style="background:rgba(245,158,11,.1);color:#fcd34d;border:1px solid rgba(245,158,11,.25)">⏳ Pending</span>`;

    // Existing pushed items
    const rows = items.map(i => `
<div class="ac-inh-row">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
    <span>${i.source_type === 'channel' ? '📺' : '🔎'}
      <strong>${escapeHtmlSys(i.source_name || String(i.source_id))}</strong>
    </span>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      ${statusBadge(i.status)}
      <div style="display:flex;align-items:center;gap:6px">
        <label class="toggle-switch toggle-sm">
          <input type="checkbox" ${i.continuous ? 'checked' : ''}
            onchange="updateYtContinuous(${u.id}, ${i.id}, this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <span style="font-size:11px;color:var(--text-muted)">Continuous</span>
      </div>
      <button class="btn btn-danger" style="padding:3px 8px;font-size:11px"
        onclick="removeYtInheritance(${u.id}, ${i.id})">✕</button>
    </div>
  </div>
  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
    Pushed ${fmtDate(i.pushed_at)}
    ${i.responded_at ? ` · Responded ${fmtDate(i.responded_at)}` : ''}
  </div>
</div>`).join('');

    // Multi-select push UI
    const availChans = allChans.filter(c => !pushed.has(`channel:${c.id}`));
    const availKws   = allKws.filter(k   => !pushed.has(`keyword:${k.id}`));

    let pushHtml = '';
    if (availChans.length || availKws.length) {
        const chanList = availChans.map(c => {
            const n = escapeHtmlSys(c.channel_name || c.channel_id);
            return `<label class="ac-check">
              <input type="checkbox" class="yt-push-cb"
                data-type="channel" data-id="${c.id}" data-name="${n}">
              📺 ${n}
            </label>`;
        }).join('');
        const kwList = availKws.map(k => {
            const n = escapeHtmlSys(k.keyword);
            return `<label class="ac-check">
              <input type="checkbox" class="yt-push-cb"
                data-type="keyword" data-id="${k.id}" data-name="${n}">
              🔎 ${n}
            </label>`;
        }).join('');

        pushHtml = `
<div id="yt-push-panel-${u.id}" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-color)">
  <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
    Select sources to push to this user:
  </div>
  ${availChans.length ? `
  <div style="margin-bottom:8px">
    <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">Channels</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${chanList}</div>
  </div>` : ''}
  ${availKws.length ? `
  <div style="margin-bottom:10px">
    <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">Keyword Trackers</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${kwList}</div>
  </div>` : ''}
  <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
    <label class="ac-check">
      <input type="checkbox" id="push-yt-cont-${u.id}"> Continuous for all selected
    </label>
    <button class="btn btn-primary btn-sm" onclick="pushYt(${u.id})">
      Push Selected
    </button>
  </div>
</div>`;
    } else if (!items.length) {
        pushHtml = `<p style="font-size:12px;color:var(--text-muted);margin-top:8px">No YouTube channels or trackers configured yet.</p>`;
    } else {
        pushHtml = `<p style="font-size:12px;color:var(--text-muted);margin-top:8px">All available sources already pushed.</p>`;
    }

    return (rows || '') + pushHtml;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function setUserFlag(userId, flag, value) {
    await acctApi('POST', `/api/admin/accounts/${userId}/update`, { [flag]: value });

    if (flag === 'agents_on') {
        const userData = (_acctData?.users || []).find(u => u.id === userId);
        if (userData) {
            userData.agents_on = value;
            const existing = document.getElementById(`agents-limit-${userId}`);
            if (existing) existing.remove();
            if (value) {
                const row = document.getElementById(`agents-feature-row-${userId}`);
                if (row) row.insertAdjacentHTML('beforeend', renderAgentsLimit(userData));
            }
        }
    } else if (flag === 'is_active') {
        const lbl = document.getElementById(`active-label-${userId}`);
        if (lbl) lbl.textContent = value ? 'Active' : 'Inactive';
    }
}

async function setAgentsLimitType(userId, type) {
    const row   = document.getElementById(`agents-limit-${userId}`);
    const valEl = row ? row.querySelector('input[type=number]') : null;
    const value = valEl ? parseFloat(valEl.value) || 0 : 0;
    await acctApi('POST', `/api/admin/accounts/${userId}/update`,
        { agents_limit: { type, value } });
    const disp = document.getElementById(`limit-display-${userId}`);
    if (disp) disp.textContent = type === 'money' ? `$${value}` : `${value} calls`;
}

async function setAgentsLimitValue(userId, inp) {
    const row    = inp.closest('.ac-limit-row');
    const typeEl = row ? row.querySelector('select') : null;
    const type   = typeEl ? typeEl.value : 'calls';
    const value  = parseFloat(inp.value) || 0;
    await acctApi('POST', `/api/admin/accounts/${userId}/update`,
        { agents_limit: { type, value } });
    const disp = document.getElementById(`limit-display-${userId}`);
    if (disp) disp.textContent = type === 'money' ? `$${value}` : `${value} calls`;
}

async function deleteUser(userId, username) {
    showConfirm(
        `Delete user "${username}"? This cannot be undone.`,
        async () => {
            await acctApi('POST', `/api/admin/accounts/${userId}/delete`);
            loadAccountsData();
        },
        { confirmLabel: 'Delete', confirmClass: 'btn-danger' }
    );
}

// ── Bot inheritance actions ───────────────────────────────────────────────────

async function grantBot(userId) {
    const sel = document.getElementById(`grant-bot-sel-${userId}`);
    if (!sel || !sel.value) return;
    await acctApi('POST', `/api/admin/accounts/${userId}/bots/${parseInt(sel.value)}`, {});
    loadAccountsData();
}

async function revokeBot(userId, botId) {
    await acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}/delete`);
    loadAccountsData();
}

async function updateBotFlag(userId, botId, flag, value) {
    await acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}`, { [flag]: value });
}

async function updateBotCategories(userId, botId) {
    const row    = document.getElementById(`inh-bot-${userId}-${botId}`);
    if (!row) return;
    const checks  = Array.from(row.querySelectorAll('input[data-cat-id]'));
    const checked = checks.filter(c => c.checked).map(c => parseInt(c.dataset.catId));
    await acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}`,
        { inherit_categories: checked.length === checks.length ? [] : checked });
}

async function updateBotTopics(userId, botId) {
    const row    = document.getElementById(`inh-bot-${userId}-${botId}`);
    if (!row) return;
    const checks  = Array.from(row.querySelectorAll('input[data-topic-id]'));
    const checked = checks.filter(c => c.checked).map(c => parseInt(c.dataset.topicId));
    await acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}`,
        { inherit_topics: checked.length === checks.length ? [] : checked });
}

// ── YouTube inheritance actions ───────────────────────────────────────────────

async function pushYt(userId) {
    const panel = document.getElementById(`yt-push-panel-${userId}`);
    if (!panel) return;
    const checked = Array.from(panel.querySelectorAll('.yt-push-cb:checked'));
    if (!checked.length) return;
    const cont = document.getElementById(`push-yt-cont-${userId}`);
    const continuous = cont ? cont.checked : false;

    // Push all checked items in parallel
    await Promise.all(checked.map(cb =>
        acctApi('POST', `/api/admin/accounts/${userId}/youtube`, {
            source_type: cb.dataset.type,
            source_id:   parseInt(cb.dataset.id),
            source_name: cb.dataset.name,
            continuous,
        })
    ));
    loadAccountsData();
}

async function updateYtContinuous(userId, inhId, value) {
    await acctApi('POST', `/api/admin/accounts/${userId}/youtube/${inhId}/update`,
        { continuous: value });
}

async function removeYtInheritance(userId, inhId) {
    await acctApi('POST', `/api/admin/accounts/${userId}/youtube/${inhId}/delete`);
    loadAccountsData();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function toggleAcctSection(sectionId) {
    const body    = document.getElementById(sectionId);
    const chevron = document.getElementById('chevron-' + sectionId);
    if (!body) return;
    const isOpen  = body.style.display === 'block';
    body.style.display   = isOpen ? 'none' : 'block';
    if (chevron) chevron.textContent = isOpen ? '▶' : '▼';
}

function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

// ── Injected styles ───────────────────────────────────────────────────────────
(function injectAccountsStyles() {
    if (document.getElementById('acct-styles')) return;
    const s = document.createElement('style');
    s.id = 'acct-styles';
    s.textContent = `
    /* Avatar */
    .ac-avatar {
        width:42px; height:42px; border-radius:50%; background:var(--accent-primary);
        color:#fff; display:flex; align-items:center; justify-content:center;
        font-size:18px; font-weight:700; flex-shrink:0;
    }
    /* Chips */
    .ac-chip {
        font-size:11px; padding:2px 7px; border-radius:10px;
        background:rgba(255,255,255,0.06); border:1px solid var(--border-color);
        color:var(--text-muted); white-space:nowrap;
    }
    .ac-chip-tg   { border-color:rgba(39,170,225,.3) !important; color:#27aae1 !important; }
    .ac-chip-warn { border-color:rgba(245,158,11,.3)  !important; color:var(--warning) !important; }

    /* Feature section */
    .ac-features {
        display:flex; flex-wrap:wrap; gap:14px;
        padding:12px 0; margin-bottom:12px;
        border-top:1px solid var(--border-color);
        border-bottom:1px solid var(--border-color);
        align-items:flex-start;
    }
    .ac-feature-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .ac-limit-row   { display:flex; align-items:center; gap:6px; margin-left:4px; flex-wrap:wrap; }
    .ac-num-inp {
        font-size:12px; padding:4px 8px; height:28px; width:76px;
        background:var(--bg-secondary); border:1px solid var(--border-color);
        border-radius:var(--radius-sm); color:var(--text-primary); outline:none;
    }
    .ac-num-inp:focus { border-color:var(--accent-primary); }

    /* Collapsible sections */
    .ac-section {
        margin-bottom:8px; border:1px solid var(--border-color);
        border-radius:var(--radius-md); overflow:hidden;
    }
    .ac-section-hd {
        display:flex; justify-content:space-between; align-items:center;
        padding:10px 14px; cursor:pointer; user-select:none;
        background:rgba(255,255,255,.02); font-size:13px; font-weight:500;
        transition:background .15s;
    }
    .ac-section-hd:hover { background:rgba(255,255,255,.04); }
    .ac-chevron { font-size:10px; color:var(--text-muted); }
    .ac-section-bd { padding:12px 14px; background:var(--bg-secondary); }

    /* Inheritance rows */
    .ac-inh-row {
        background:rgba(255,255,255,.03); border:1px solid var(--border-color);
        border-radius:var(--radius-sm); padding:10px 12px; margin-bottom:8px;
    }
    .ac-inh-row:last-of-type { margin-bottom:0; }

    /* Checkboxes */
    .ac-check {
        display:inline-flex; align-items:center; gap:5px;
        font-size:12px; color:var(--text-secondary); cursor:pointer; user-select:none;
    }
    .ac-check input { accent-color:var(--accent-primary); cursor:pointer; }

    /* Category tree */
    .ac-tree {
        border-top:1px solid var(--border-color); padding-top:10px; margin-top:4px;
    }

    /* Add row */
    .ac-add-row {
        display:flex; align-items:center; gap:8px; flex-wrap:wrap;
        padding-top:10px; margin-top:4px; border-top:1px solid var(--border-color);
    }

    /* Small toggle (continuous) */
    .toggle-switch.toggle-sm { width:34px; height:18px; }
    .toggle-switch.toggle-sm .toggle-slider:before {
        height:12px; width:12px; left:3px; bottom:3px;
    }
    .toggle-switch.toggle-sm input:checked + .toggle-slider:before {
        transform:translateX(16px);
    }
    `;
    document.head.appendChild(s);
})();
