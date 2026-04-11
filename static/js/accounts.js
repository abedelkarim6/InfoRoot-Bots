'use strict';

// ── Global state ──────────────────────────────────────────────────────────────
let _acctData   = null;
let _acctPlans  = [];
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

        const hasBotAccess = isAdmin || !!currentUser.bots_on || !!currentUser.has_bot_access;

        const hasYt       = isAdmin || !!currentUser.youtube_on;
        const hasYtChat   = isAdmin || !!currentUser.yt_chat_on;
        const hasAgents   = isAdmin || !!currentUser.agents_on;
        const hasSysBot   = isAdmin || !!currentUser.sys_bot_on;

        show('admin-nav-section', isAdmin);
        // News Summaries: hidden for users with no bot access
        show('news-nav-section', hasBotAccess);
        // YouTube Reader: hidden for users without youtube_on
        show('yt-nav-section',   hasYt);
        // AI Chatbots: visible when any chat feature is enabled
        show('ai-nav-section',   hasYtChat || hasAgents);
        // Per-item visibility inside AI Chatbots
        show('nav-yt-chat',      hasYtChat);
        show('nav-agent-chat',   hasAgents);
        show('sys-bot-fab',      hasSysBot);

        // If the currently active page is now hidden, fall back to system
        const newsPages  = ['collections', 'bots', 'monitor', 'dashboard'];
        const ytPages    = ['yt-channels', 'yt-keywords', 'yt-videos'];
        const aiPages    = ['agent-chat'];
        const adminPages = ['accounts'];
        const activePage = localStorage.getItem('activePage') || 'system';

        const pageHidden =
            (!hasBotAccess && newsPages.includes(activePage)) ||
            (!isAdmin && !currentUser.youtube_on  && ytPages.includes(activePage)) ||
            (!isAdmin && !currentUser.yt_chat_on  && activePage === 'yt-chat') ||
            (!isAdmin && !currentUser.agents_on   && aiPages.includes(activePage)) ||
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
    _acctData  = data;
    _acctPlans = data.ai_plans || [];
    renderAccounts(data, el);
}

function renderAccounts(data, container) {
    const users    = (data.users || []).filter(u => u.role !== 'admin');
    const allBots  = data.available_bots       || [];
    const allChans = data.yt_channels           || [];
    const allKws   = data.yt_keywords           || [];
    const cats     = data.categories            || [];
    const allColls = data.available_collections || [];
    const plans    = _acctPlans;

    const badge = document.getElementById('accounts-count');
    if (badge) {
        badge.textContent   = users.length;
        badge.style.display = users.length ? '' : 'none';
    }

    const usersHtml = users.length
        ? users.map(u => renderUserCard(u, allBots, allChans, allKws, cats, allColls)).join('')
        : `<div class="card" style="text-align:center;padding:40px 20px">
             <div style="font-size:32px;margin-bottom:12px">👥</div>
             <p class="text-muted">No registered users yet.</p>
             <p class="text-muted" style="font-size:12px;margin-top:6px">
               Use the <strong>+ Create User</strong> button above to add one.
             </p>
           </div>`;

    container.innerHTML = `
<div class="acct-tab-bar">
  <button class="acct-tab active" id="acct-tab-users-btn" onclick="switchAcctTab('users')">
    👥 Users <span class="ac-chip" style="margin-left:4px">${users.length}</span>
  </button>
  <button class="acct-tab" id="acct-tab-plans-btn" onclick="switchAcctTab('plans')">
    📋 Plans <span class="ac-chip" style="margin-left:4px">${plans.length}</span>
  </button>
</div>
<div id="acct-panel-users">${usersHtml}</div>
<div id="acct-panel-plans" style="display:none">${renderPlansTab(plans)}</div>`;
}

function switchAcctTab(tab) {
    const usersBtn   = document.getElementById('acct-tab-users-btn');
    const plansBtn   = document.getElementById('acct-tab-plans-btn');
    const usersPanel = document.getElementById('acct-panel-users');
    const plansPanel = document.getElementById('acct-panel-plans');
    if (!usersPanel || !plansPanel) return;
    if (tab === 'users') {
        usersBtn.classList.add('active');   plansBtn.classList.remove('active');
        usersPanel.style.display = '';      plansPanel.style.display = 'none';
    } else {
        plansBtn.classList.add('active');   usersBtn.classList.remove('active');
        plansPanel.style.display = '';      usersPanel.style.display = 'none';
    }
}

// ── User card ─────────────────────────────────────────────────────────────────
function renderUserCard(u, allBots, allChans, allKws, cats, allColls) {
    const pendingYt = (u.yt_inheritances || []).filter(i => i.status === 'pending').length;
    const planPill  = u.ai_plan_name
        ? `<span class="ac-plan-pill ac-plan-${u.ai_plan_name.toLowerCase().replace(/\s+/g,'-')}">${escapeHtmlSys(u.ai_plan_name)}</span>`
        : `<span class="ac-chip" style="font-style:italic">No plan</span>`;

    return `
<div class="card acct-user-card" id="acct-card-${u.id}" style="margin-bottom:12px">

  <!-- ── Collapsible Header ── -->
  <div class="acct-card-hd" onclick="toggleUserCard(${u.id}, event)">
    <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
      <div class="ac-avatar">${u.username[0].toUpperCase()}</div>
      <div style="min-width:0">
        <div style="font-size:15px;font-weight:600">${escapeHtmlSys(u.username)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          ${u.telegram_phone
            ? `<span class="ac-chip ac-chip-tg">📱 ${escapeHtmlSys(u.telegram_phone)}</span>`
            : `<span class="ac-chip ac-chip-warn">⚠ No Telegram</span>`}
          <span class="ac-chip">Joined ${fmtDate(u.created_at)}</span>
          ${planPill}
        </div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0" onclick="event.stopPropagation()">
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
      <span class="ac-chevron acct-user-chevron" id="chevron-user-${u.id}">▶</span>
    </div>
  </div>

  <!-- ── Collapsible body ── -->
  <div id="acct-body-${u.id}" style="display:none">

  <!-- ── Plan selector ── -->
  <div style="padding:10px 0 6px;border-top:1px solid var(--border-color);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="font-size:12px;color:var(--text-muted);white-space:nowrap">AI Plan:</span>
    <select class="select" style="font-size:12px;padding:4px 8px;height:28px;min-width:150px"
      onchange="assignPlan(${u.id}, this.value)">
      <option value="">— No plan —</option>
      ${_acctPlans.map(p =>
        `<option value="${p.id}" ${u.ai_plan_id === p.id ? 'selected' : ''}>${escapeHtmlSys(p.name)} (${p.monthly_limit} req/mo)</option>`
      ).join('')}
    </select>
    ${u.ai_plan_name ? `<span style="font-size:11px;color:var(--text-muted)">${u.ai_plan_monthly_limit} requests/month</span>` : ''}
  </div>

  <!-- ── Feature toggles ── -->
  <div class="ac-features">
    <div class="ac-feature-row">
      <label class="toggle-switch">
        <input type="checkbox" ${u.bots_on ? 'checked' : ''}
          onchange="setUserFlag(${u.id}, 'bots_on', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:13px">📰 Summaries</span>
    </div>

    <div class="ac-feature-row">
      <label class="toggle-switch">
        <input type="checkbox" ${u.youtube_on ? 'checked' : ''}
          onchange="setUserFlag(${u.id}, 'youtube_on', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:13px">📺 YouTube Summaries</span>
    </div>

    <div class="ac-feature-row">
      <label class="toggle-switch">
        <input type="checkbox" ${u.yt_chat_on ? 'checked' : ''}
          onchange="setUserFlag(${u.id}, 'yt_chat_on', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:13px">💬 Video Chat</span>
    </div>


  </div>

  <!-- ── Agent Bot Access ── -->
  <div class="ac-section">
    <div class="ac-section-hd" onclick="toggleAcctSection('agents-${u.id}')">
      <div style="display:flex;align-items:center;gap:10px">
        <label class="toggle-switch" onclick="event.stopPropagation()">
          <input type="checkbox" ${u.agents_on ? 'checked' : ''}
            onchange="setUserFlag(${u.id}, 'agents_on', this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <span>🤖 Agent Bot</span>
        ${u.agents_on ? `<span class="ac-chip" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.3)">Enabled</span>` : `<span class="ac-chip">Disabled</span>`}
      </div>
      <span class="ac-chevron" id="chevron-agents-${u.id}">▶</span>
    </div>
    <div class="ac-section-bd" id="agents-${u.id}" style="display:none">
      <div id="agents-limit-wrap-${u.id}">
        ${renderAgentsLimitBody(u)}
      </div>
    </div>
  </div>

  <!-- ── System Bot Access ── -->
  <div class="ac-section">
    <div class="ac-section-hd" onclick="toggleAcctSection('sysbot-${u.id}')">
      <div style="display:flex;align-items:center;gap:10px">
        <label class="toggle-switch" onclick="event.stopPropagation()">
          <input type="checkbox" ${u.sys_bot_on ? 'checked' : ''}
            onchange="setUserFlag(${u.id}, 'sys_bot_on', this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <span>🔧 System Bot</span>
        ${u.sys_bot_on ? `<span class="ac-chip" style="background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.3)">Enabled</span>` : `<span class="ac-chip">Disabled</span>`}
      </div>
      <span class="ac-chevron" id="chevron-sysbot-${u.id}">▶</span>
    </div>
    <div class="ac-section-bd" id="sysbot-${u.id}" style="display:none">
      <p style="font-size:12px;color:var(--text-muted);padding:4px 0">
        Grants access to the System Bot assistant panel (bottom-right FAB). The system bot can answer questions about the platform and help with configuration tasks.
      </p>
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

  <!-- ── Collection Inheritance ── -->
  <div class="ac-section">
    <div class="ac-section-hd" onclick="toggleAcctSection('colls-${u.id}')">
      <span>📦 Collection Access</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="ac-chip">${(u.collection_inheritances || []).length} granted</span>
        <span class="ac-chevron" id="chevron-colls-${u.id}">▶</span>
      </div>
    </div>
    <div class="ac-section-bd" id="colls-${u.id}" style="display:none">
      ${renderCollectionInheritance(u, allColls)}
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

  </div><!-- /acct-body -->
</div>`;
}

function renderAgentsLimitBody(u) {
    if (!u.agents_on) {
        return `<p style="font-size:12px;color:var(--text-muted);padding:4px 0">Enable Agent Bot above to configure usage limits.</p>`;
    }
    const lim   = u.agents_limit || {};
    const type  = lim.type  || 'calls';
    const value = lim.value != null ? lim.value : '';
    const label = lim.type === 'money'
        ? `$${lim.value}`
        : lim.value != null ? `${lim.value} calls` : 'No limit';
    return `
<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Usage limit — leave blank for unlimited.</div>
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

        // Build per-topic settings map: {topic_id -> {include_schedules, include_prompts, keyword_pct}}
        const tsMap = {};
        for (const ts of (g.topic_settings || [])) {
            tsMap[ts.topic_id] = ts;
        }

        // Bot-level flags: rules + messages_db only (keywords/prompts are now per-topic)
        const featureChecks = ['rules', 'messages_db'].map(f => `
          <label class="ac-check">
            <input type="checkbox" ${g['inherit_' + f] ? 'checked' : ''}
              onchange="updateBotFlag(${u.id}, ${g.bot_id}, 'inherit_${f}', this.checked)">
            ${f === 'messages_db' ? 'Share messages DB' : 'Rules'}
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
                    const ts = tsMap[t.id] || {};
                    const inclSched = ts.include_schedules !== false;
                    const inclProm  = ts.include_prompts  !== false;
                    const kwPct     = ts.keyword_pct != null ? ts.keyword_pct : 100;
                    const seoVis    = ts.seo_visible !== false;
                    return `
                      <div class="ac-topic-row">
                        <label class="ac-check">
                          <input type="checkbox" data-topic-id="${t.id}"
                            ${topOn ? 'checked' : ''}
                            onchange="updateBotTopics(${u.id}, ${g.bot_id}, this)">
                          🏷 ${escapeHtmlSys(t.name)}
                        </label>
                        <div class="ac-topic-settings" style="${topOn ? '' : 'display:none'}">
                          <label class="ac-check ac-check-sm">
                            <input type="checkbox" ${inclSched ? 'checked' : ''}
                              onchange="updateTopicSetting(${u.id},${g.bot_id},${t.id},'include_schedules',this.checked)">
                            📅 Schedules
                          </label>
                          <label class="ac-check ac-check-sm">
                            <input type="checkbox" ${inclProm ? 'checked' : ''}
                              onchange="updateTopicSetting(${u.id},${g.bot_id},${t.id},'include_prompts',this.checked)">
                            💬 Prompts
                          </label>
                          <label class="ac-check ac-check-sm">
                            <input type="checkbox" ${seoVis ? 'checked' : ''}
                              onchange="updateTopicSetting(${u.id},${g.bot_id},${t.id},'seo_visible',this.checked)">
                            🔎 SEO visible
                          </label>
                          <div class="ac-kw-pct">
                            <span class="ac-check-sm">🔑 Keywords</span>
                            <input type="number" min="0" max="100" value="${kwPct}"
                              class="ac-num-inp ac-num-pct"
                              onblur="updateTopicSetting(${u.id},${g.bot_id},${t.id},'keyword_pct',Math.min(100,Math.max(0,parseInt(this.value)||0)))">
                            <span class="ac-check-sm">%</span>
                          </div>
                        </div>
                      </div>`;
                }).join('');
                return `
                <div style="margin-bottom:8px">
                  <label class="ac-check" style="font-weight:500">
                    <input type="checkbox" data-cat-id="${c.category_id}"
                      ${catOn ? 'checked' : ''}
                      onchange="updateBotCategories(${u.id}, ${g.bot_id}, this)">
                    📁 ${escapeHtmlSys(c.category_name)}
                  </label>
                  ${topicRows ? `<div style="margin-left:22px;margin-top:6px">${topicRows}</div>` : ''}
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

    const available = allBots.filter(b => !grantedIds.has(b.id) && b.owner_id !== u.id);
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

// ── Collection inheritance panel ──────────────────────────────────────────────
function renderCollectionInheritance(u, allColls) {
    const granted    = u.collection_inheritances || [];
    const grantedSet = new Set(granted);

    const grantedRows = granted.map(name => `
<div class="ac-inh-row" id="inh-coll-${u.id}-${escapeHtmlSys(name)}">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
    <span style="font-size:13px;font-weight:500">📦 ${escapeHtmlSys(name)}</span>
    <button class="btn btn-danger" style="padding:3px 9px;font-size:11px"
      onclick="revokeCollection(${u.id}, '${escapeHtmlSys(name)}')">Revoke</button>
  </div>
</div>`).join('');

    const available = allColls.filter(n => !grantedSet.has(n));
    const grantRow  = available.length ? `
<div class="ac-add-row">
  <select class="select" style="font-size:12px;padding:4px 8px;height:28px"
    id="grant-coll-sel-${u.id}">
    <option value="">— Select collection to grant —</option>
    ${available.map(n => `<option value="${escapeHtmlSys(n)}">${escapeHtmlSys(n)}</option>`).join('')}
  </select>
  <button class="btn btn-primary btn-sm" onclick="grantCollection(${u.id})">Grant Access</button>
</div>`
    : !allColls.length
        ? `<p style="font-size:12px;color:var(--text-muted);margin-top:6px">No collections configured yet.</p>`
        : `<p style="font-size:12px;color:var(--text-muted);margin-top:6px">All collections already granted.</p>`;

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
    <div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">SEO Trackers</div>
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
            // Refresh limit body
            const wrap = document.getElementById(`agents-limit-wrap-${userId}`);
            if (wrap) wrap.innerHTML = renderAgentsLimitBody(userData);
            // Refresh enabled chip in header
            _refreshAccessChip(userId, 'agents', value);
        }
    } else if (flag === 'sys_bot_on') {
        _refreshAccessChip(userId, 'sysbot', value);
    } else if (flag === 'is_active') {
        const lbl = document.getElementById(`active-label-${userId}`);
        if (lbl) lbl.textContent = value ? 'Active' : 'Inactive';
    }
}

function _refreshAccessChip(userId, sectionKey, enabled) {
    const hd = document.querySelector(`#${sectionKey}-${userId}`)?.previousElementSibling;
    if (!hd) return;
    const chip = hd.querySelector('.ac-chip');
    if (!chip) return;
    if (enabled) {
        chip.style.cssText = 'background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.3)';
        chip.textContent = 'Enabled';
    } else {
        chip.style.cssText = '';
        chip.textContent = 'Disabled';
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

async function updateBotCategories(userId, botId, changedCb) {
    const row = document.getElementById(`inh-bot-${userId}-${botId}`);
    if (!row) return;

    // Cascade to child topics of this category
    if (changedCb) {
        const catContainer = changedCb.closest('div[style*="margin-bottom"]') || changedCb.closest('div');
        const topicCbs = Array.from(catContainer.querySelectorAll('input[data-topic-id]'));
        topicCbs.forEach(tcb => {
            tcb.checked = changedCb.checked;
            const settingsDiv = tcb.closest('.ac-topic-row')?.querySelector('.ac-topic-settings');
            if (settingsDiv) settingsDiv.style.display = changedCb.checked ? '' : 'none';
        });
        // Sync topic settings records
        await Promise.all(topicCbs.map(tcb => {
            const tid = parseInt(tcb.dataset.topicId);
            return changedCb.checked
                ? acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}/topics/${tid}`, {})
                : acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}/topics/${tid}/delete`);
        }));
    }

    const catChecks = Array.from(row.querySelectorAll('input[data-cat-id]'));
    const checkedCats = catChecks.filter(c => c.checked).map(c => parseInt(c.dataset.catId));
    const topChecks = Array.from(row.querySelectorAll('input[data-topic-id]'));
    const checkedTops = topChecks.filter(c => c.checked).map(c => parseInt(c.dataset.topicId));

    await Promise.all([
        acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}`,
            { inherit_categories: checkedCats.length === catChecks.length ? [] : checkedCats }),
        acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}`,
            { inherit_topics: checkedTops.length === topChecks.length ? [] : checkedTops }),
    ]);
}

async function updateBotTopics(userId, botId, changedCb) {
    const row = document.getElementById(`inh-bot-${userId}-${botId}`);
    if (!row) return;
    const checks  = Array.from(row.querySelectorAll('input[data-topic-id]'));
    const checked = checks.filter(c => c.checked).map(c => parseInt(c.dataset.topicId));

    // Toggle per-topic settings visibility for the changed checkbox
    if (changedCb) {
        const settingsDiv = changedCb.closest('.ac-topic-row')?.querySelector('.ac-topic-settings');
        if (settingsDiv) settingsDiv.style.display = changedCb.checked ? '' : 'none';

        // Init default settings when topic is first checked
        const topicId = parseInt(changedCb.dataset.topicId);
        if (changedCb.checked) {
            acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}/topics/${topicId}`, {});
        } else {
            acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}/topics/${topicId}/delete`);
        }
    }

    await acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}`,
        { inherit_topics: checked.length === checks.length ? [] : checked });
}

async function updateTopicSetting(userId, botId, topicId, field, value) {
    await acctApi('POST', `/api/admin/accounts/${userId}/bots/${botId}/topics/${topicId}`,
        { [field]: value });
}

// ── Collection inheritance actions ───────────────────────────────────────────

async function grantCollection(userId) {
    const sel = document.getElementById(`grant-coll-sel-${userId}`);
    if (!sel || !sel.value) return;
    await acctApi('POST', `/api/admin/accounts/${userId}/collections/${encodeURIComponent(sel.value)}`);
    loadAccountsData();
}

async function revokeCollection(userId, collectionName) {
    await acctApi('POST', `/api/admin/accounts/${userId}/collections/${encodeURIComponent(collectionName)}/delete`);
    loadAccountsData();
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

// ── User card collapse ────────────────────────────────────────────────────────

function toggleUserCard(userId, event) {
    if (event) {
        const t = event.target;
        if (t.closest('button') || t.closest('label') || t.closest('select') || t.closest('input')) return;
    }
    const body    = document.getElementById(`acct-body-${userId}`);
    const chevron = document.getElementById(`chevron-user-${userId}`);
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    if (chevron) chevron.textContent = open ? '▶' : '▼';
}

// ── Plan assignment ───────────────────────────────────────────────────────────

async function assignPlan(userId, planId) {
    await acctApi('POST', `/api/admin/accounts/${userId}/update`,
        { ai_plan_id: planId ? parseInt(planId) : null });
    // Update local state so plan pill refreshes on next render without full reload
    const u = (_acctData?.users || []).find(u => u.id === userId);
    if (u && _acctPlans) {
        const plan = _acctPlans.find(p => p.id === parseInt(planId));
        u.ai_plan_id            = plan ? plan.id : null;
        u.ai_plan_name          = plan ? plan.name : null;
        u.ai_plan_monthly_limit = plan ? plan.monthly_limit : null;
        // Refresh plan pill in card header
        const card = document.getElementById(`acct-card-${userId}`);
        if (card) {
            const pill = card.querySelector('.ac-plan-pill, .ac-chip[style*="font-style"]');
            if (pill && plan) {
                pill.className = `ac-plan-pill ac-plan-${plan.name.toLowerCase().replace(/\s+/g,'-')}`;
                pill.textContent = plan.name;
            } else if (pill) {
                pill.textContent = 'No plan';
            }
        }
    }
}

// ── Plans tab rendering ───────────────────────────────────────────────────────

function renderPlansTab(plans) {
    const defaultPlans = plans.filter(p => p.is_default);
    const customPlans  = plans.filter(p => !p.is_default);

    const planCard = (p) => `
<div class="card" id="plan-card-${p.id}" style="margin-bottom:12px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="ac-plan-pill ac-plan-${p.name.toLowerCase().replace(/\s+/g,'-')}">${escapeHtmlSys(p.name)}</span>
        ${p.is_default ? `<span class="ac-chip" style="font-size:10px">Default</span>` : `<span class="ac-chip" style="font-size:10px;color:#a78bfa;border-color:rgba(167,139,250,.3)">Custom</span>`}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${escapeHtmlSys(p.description || '')}</div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:12px;color:var(--text-muted)">Monthly limit:</span>
          <input type="number" class="ac-num-inp" id="plan-limit-${p.id}"
            value="${p.monthly_limit}" min="1"
            style="width:80px"
            onblur="savePlanLimit(${p.id}, this.value)">
          <span style="font-size:12px;color:var(--text-muted)">requests</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:12px;color:var(--text-muted)">Name:</span>
          <input type="text" class="ac-num-inp" id="plan-name-${p.id}"
            value="${escapeHtmlSys(p.name)}"
            style="width:120px;font-size:12px"
            ${p.is_default ? 'disabled title="Default plan names cannot be changed"' : ''}
            onblur="savePlanName(${p.id}, this.value)">
        </div>
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
      ${!p.is_default ? `<button class="btn btn-danger btn-sm" onclick="deletePlan(${p.id}, '${escapeHtmlSys(p.name)}')">Delete</button>` : ''}
    </div>
  </div>
</div>`;

    return `
<div style="margin-bottom:16px">
  <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
    Assign plans to users in the <strong>Users</strong> tab. Edit limits and names here dynamically — changes apply immediately to all assigned users.
  </div>

  <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">Default Plans</div>
  ${defaultPlans.map(planCard).join('') || '<p class="text-muted" style="font-size:12px">No default plans.</p>'}

  <div style="font-size:13px;font-weight:600;margin:16px 0 8px;color:var(--text-secondary)">Custom Plans</div>
  ${customPlans.map(planCard).join('') || '<p class="text-muted" style="font-size:12px;margin-bottom:12px">No custom plans yet.</p>'}

  <!-- Create custom plan -->
  <div class="card" style="border:1px dashed var(--border-color)">
    <div style="font-size:13px;font-weight:500;margin-bottom:12px">Create Custom Plan</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Plan name</div>
        <input type="text" class="input" id="new-plan-name" placeholder="e.g. Enterprise"
          style="font-size:12px;padding:5px 10px;height:32px;width:150px">
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Monthly limit</div>
        <input type="number" class="ac-num-inp" id="new-plan-limit"
          placeholder="500" min="1" style="width:90px">
      </div>
      <div style="flex:1;min-width:160px">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Description (optional)</div>
        <input type="text" class="input" id="new-plan-desc" placeholder="Brief description"
          style="font-size:12px;padding:5px 10px;height:32px;width:100%">
      </div>
      <button class="btn btn-primary btn-sm" onclick="createPlan()" style="height:32px">
        + Create Plan
      </button>
    </div>
  </div>
</div>`;
}

async function savePlanLimit(planId, val) {
    const limit = parseInt(val);
    if (!limit || limit < 1) return;
    await acctApi('POST', `/api/admin/plans/${planId}/update`, { monthly_limit: limit });
    const p = _acctPlans.find(p => p.id === planId);
    if (p) p.monthly_limit = limit;
}

async function savePlanName(planId, val) {
    const name = val.trim();
    if (!name) return;
    await acctApi('POST', `/api/admin/plans/${planId}/update`, { name });
    const p = _acctPlans.find(p => p.id === planId);
    if (p) p.name = name;
}

async function createPlan() {
    const nameEl  = document.getElementById('new-plan-name');
    const limitEl = document.getElementById('new-plan-limit');
    const descEl  = document.getElementById('new-plan-desc');
    const name    = nameEl?.value.trim();
    const limit   = parseInt(limitEl?.value);
    const desc    = descEl?.value.trim() || '';
    if (!name)  { showAlert('Plan name is required.'); return; }
    if (!limit) { showAlert('Monthly limit must be a positive number.'); return; }
    const res = await acctApi('POST', '/api/admin/plans', { name, monthly_limit: limit, description: desc });
    if (res.status === 'ok') {
        loadAccountsData();
    } else {
        showAlert(res.error || res.detail || 'Failed to create plan');
    }
}

async function deletePlan(planId, planName) {
    showConfirm(
        `Delete plan "${planName}"? Users assigned to it will have their plan cleared.`,
        async () => {
            const res = await acctApi('POST', `/api/admin/plans/${planId}/delete`);
            if (res.status === 'ok') loadAccountsData();
            else showAlert(res.error || res.detail || 'Failed to delete plan');
        },
        { confirmLabel: 'Delete', confirmClass: 'btn-danger' }
    );
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

    /* Per-topic row */
    .ac-topic-row { margin-bottom:6px; }
    .ac-topic-settings {
        display:flex; align-items:center; flex-wrap:wrap; gap:10px;
        margin-top:5px; margin-left:22px;
        padding:6px 10px;
        background:rgba(255,255,255,.03);
        border-left:2px solid var(--accent-primary);
        border-radius:0 var(--radius-sm) var(--radius-sm) 0;
    }
    .ac-check-sm {
        display:inline-flex; align-items:center; gap:4px;
        font-size:11px; color:var(--text-muted); cursor:pointer; user-select:none;
    }
    .ac-check-sm input { accent-color:var(--accent-primary); cursor:pointer; }
    .ac-kw-pct { display:flex; align-items:center; gap:4px; }
    .ac-num-pct { width:52px !important; height:24px !important; font-size:11px !important; padding:2px 6px !important; }

    /* Tab bar */
    .acct-tab-bar {
        display:flex; gap:4px; margin-bottom:16px;
        border-bottom:1px solid var(--border-color); padding-bottom:0;
    }
    .acct-tab {
        padding:8px 18px; font-size:13px; font-weight:500; cursor:pointer;
        background:none; border:none; border-bottom:2px solid transparent;
        color:var(--text-muted); border-radius:var(--radius-sm) var(--radius-sm) 0 0;
        transition:color .15s, border-color .15s;
        display:flex; align-items:center; gap:6px;
    }
    .acct-tab:hover  { color:var(--text-primary); }
    .acct-tab.active { color:var(--accent-primary); border-bottom-color:var(--accent-primary); }

    /* Collapsible user card header */
    .acct-user-card { padding:0; }
    .acct-card-hd {
        display:flex; justify-content:space-between; align-items:center;
        gap:12px; padding:14px 16px; cursor:pointer; user-select:none;
        transition:background .15s; flex-wrap:wrap;
    }
    .acct-card-hd:hover { background:rgba(255,255,255,.025); }
    .acct-user-chevron  { font-size:11px; color:var(--text-muted); }
    .acct-user-card > div[id^="acct-body-"] { padding:0 16px 14px; }

    `;
    document.head.appendChild(s);
})();

// ── Create User (admin only) ──────────────────────────────────────────────────
function showCreateUserModal() {
    const existing = document.getElementById('create-user-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'create-user-modal';
    modal.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-header">
                <h3>Create New User</h3>
                <button class="btn-icon" onclick="document.getElementById('create-user-modal').remove()">×</button>
            </div>
            <div class="modal-body">
                <div class="form-group" style="margin-bottom:12px">
                    <label class="form-label">Username</label>
                    <input id="cu-username" class="input" type="text" placeholder="e.g. john_doe" autocomplete="off">
                </div>
                <div class="form-group">
                    <label class="form-label">Password</label>
                    <input id="cu-password" class="input" type="password" placeholder="Min. 6 characters" autocomplete="new-password">
                </div>
                <div id="cu-error" style="color:var(--danger);font-size:13px;margin-top:10px;display:none;"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="document.getElementById('create-user-modal').remove()">Cancel</button>
                <button class="btn btn-primary" onclick="submitCreateUser()">Create</button>
            </div>
        </div>`;

    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('cu-username')?.focus(), 50);
    document.getElementById('cu-password').addEventListener('keydown', e => {
        if (e.key === 'Enter') submitCreateUser();
    });
}

async function submitCreateUser() {
    const username = document.getElementById('cu-username')?.value.trim();
    const password = document.getElementById('cu-password')?.value;
    const errEl    = document.getElementById('cu-error');

    if (!username || username.length < 3) {
        errEl.textContent = 'Username must be at least 3 characters.';
        errEl.style.display = '';
        return;
    }
    if (!password || password.length < 6) {
        errEl.textContent = 'Password must be at least 6 characters.';
        errEl.style.display = '';
        return;
    }

    const data = await acctApi('POST', '/api/auth/register', { username, password });
    if (data.error) {
        errEl.textContent = data.error;
        errEl.style.display = '';
        return;
    }

    document.getElementById('create-user-modal')?.remove();
    await loadAccountsData();
}
