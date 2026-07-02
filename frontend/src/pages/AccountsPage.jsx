/**
 * Access & Plans (admin) — port of static/js/accounts.js + index.html#accounts-page.
 *
 * Two tabs:
 *   1. Users — collapsible card per non-admin user with feature toggles, AI plan
 *      assignment, agent-bot usage limits, and three inheritance sections
 *      (Bot, Collection, YouTube).
 *   2. Plans — list of AI usage plans with inline edit (name/limit) for default
 *      and custom plans, plus a "Create Custom Plan" form.
 *
 * Backend endpoints used:
 *   GET  /api/admin/accounts
 *   POST /api/admin/accounts/{user_id}/update
 *   POST /api/admin/accounts/{user_id}/delete
 *   POST /api/admin/accounts/{user_id}/bots/{bot_id}
 *   POST /api/admin/accounts/{user_id}/bots/{bot_id}/delete
 *   POST /api/admin/accounts/{user_id}/bots/{bot_id}/topics/{topic_id}
 *   POST /api/admin/accounts/{user_id}/bots/{bot_id}/topics/{topic_id}/delete
 *   POST /api/admin/accounts/{user_id}/collections/{collection_name}
 *   POST /api/admin/accounts/{user_id}/collections/{collection_name}/delete
 *   POST /api/admin/accounts/{user_id}/youtube
 *   POST /api/admin/accounts/{user_id}/youtube/{inh_id}/update
 *   POST /api/admin/accounts/{user_id}/youtube/{inh_id}/delete
 *   POST /api/admin/plans
 *   POST /api/admin/plans/{plan_id}/update
 *   POST /api/admin/plans/{plan_id}/delete
 *   POST /api/auth/register   (create-user modal)
 *
 * The legacy file also resolved nav visibility for the entire app on first
 * load — that is handled by AuthContext + ProtectedRoute now and intentionally
 * NOT ported here.
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApiMutation } from '../lib/useApiMutation';
import { useDialogs } from '../dialogs/DialogsProvider';
import { useUrlString } from '../lib/useUrlState';
import PageHeader from '../components/PageHeader';

const ACCOUNTS_KEY = ['accounts'];
const VALID_ACCT_TABS = new Set(['users', 'plans']);

export default function AccountsPage() {
  const [tabParam, setTabParam] = useUrlString('tab', 'users');
  const tab = VALID_ACCT_TABS.has(tabParam) ? tabParam : 'users';
  // Push so the browser Back button returns to the previous tab.
  const setTab = (t) => setTabParam(t, { push: true });
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => api('/api/admin/accounts'),
  });

  const users = useMemo(
    () => (data?.users || []).filter((u) => u.role !== 'admin'),
    [data]
  );
  const plans = data?.ai_plans || [];
  const allBots = data?.available_bots || [];
  const allChans = data?.yt_channels || [];
  const allKws = data?.yt_keywords || [];
  const cats = data?.categories || [];
  const allColls = data?.available_collections || [];

  const errorMsg = data?.error || data?.detail;

  return (
    <div className="page active">
      <PageHeader
        title="Access & Plans"
        subtitle="Manage users, feature access, and AI usage plans"
      >
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setCreateOpen(true)}
        >
          + Create User
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          ↻ Refresh
        </button>
      </PageHeader>

      {isLoading && <p className="text-muted">Loading…</p>}

      {!isLoading && errorMsg && (
        <p style={{ color: 'var(--danger)' }}>{errorMsg}</p>
      )}

      {!isLoading && !errorMsg && data && (
        <>
          <div className="acct-tab-bar">
            <button
              type="button"
              className={`acct-tab ${tab === 'users' ? 'active' : ''}`}
              onClick={() => setTab('users')}
            >
              👥 Users{' '}
              <span className="ac-chip" style={{ marginLeft: 4 }}>
                {users.length}
              </span>
            </button>
            <button
              type="button"
              className={`acct-tab ${tab === 'plans' ? 'active' : ''}`}
              onClick={() => setTab('plans')}
            >
              📋 Plans{' '}
              <span className="ac-chip" style={{ marginLeft: 4 }}>
                {plans.length}
              </span>
            </button>
          </div>

          {tab === 'users' && (
            <UsersTab
              users={users}
              plans={plans}
              allBots={allBots}
              allChans={allChans}
              allKws={allKws}
              cats={cats}
              allColls={allColls}
            />
          )}

          {tab === 'plans' && <PlansTab plans={plans} />}
        </>
      )}

      {createOpen && <CreateUserModal onClose={() => setCreateOpen(false)} />}

      <AccountsStyles />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Users tab

function UsersTab({ users, plans, allBots, allChans, allKws, cats, allColls }) {
  if (!users.length) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px 20px' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>👥</div>
        <p className="text-muted">No registered users yet.</p>
        <p className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
          Use the <strong>+ Create User</strong> button above to add one.
        </p>
      </div>
    );
  }
  return (
    <>
      {users.map((u) => (
        <UserCard
          key={u.id}
          user={u}
          plans={plans}
          allBots={allBots}
          allChans={allChans}
          allKws={allKws}
          cats={cats}
          allColls={allColls}
        />
      ))}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// User card (collapsible)

function UserCard({ user, plans, allBots, allChans, allKws, cats, allColls }) {
  const [open, setOpen] = useState(false);
  const [sections, setSections] = useState({
    agents: false,
    sysbot: false,
    bots: false,
    colls: false,
    yt: false,
  });

  const pendingYt = (user.yt_inheritances || []).filter(
    (i) => i.status === 'pending'
  ).length;

  function toggleSection(key) {
    setSections((s) => ({ ...s, [key]: !s[key] }));
  }

  // Avoid toggling card when clicking interactive children.
  function onHeaderClick(e) {
    const t = e.target;
    if (
      t.closest('button') ||
      t.closest('label') ||
      t.closest('select') ||
      t.closest('input')
    ) {
      return;
    }
    setOpen((o) => !o);
  }

  const planPill = user.ai_plan_name ? (
    <span
      className={`ac-plan-pill ac-plan-${user.ai_plan_name
        .toLowerCase()
        .replace(/\s+/g, '-')}`}
    >
      {user.ai_plan_name}
    </span>
  ) : (
    <span className="ac-chip" style={{ fontStyle: 'italic' }}>
      No plan
    </span>
  );

  return (
    <div className="card acct-user-card" style={{ marginBottom: 12 }}>
      <div className="acct-card-hd" onClick={onHeaderClick}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flex: 1,
            minWidth: 0,
          }}
        >
          <div className="ac-avatar">
            {(user.username || '?')[0].toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{user.username}</div>
            <div
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                marginTop: 4,
              }}
            >
              {user.telegram_phone ? (
                <span className="ac-chip ac-chip-tg">
                  📱 {user.telegram_phone}
                </span>
              ) : (
                <span className="ac-chip ac-chip-warn">⚠ No Telegram</span>
              )}
              <span className="ac-chip">Joined {fmtDate(user.created_at)}</span>
              {planPill}
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <ActiveToggle user={user} />
          <DeleteUserButton user={user} />
          <span className="ac-chevron acct-user-chevron">
            {open ? '▼' : '▶'}
          </span>
        </div>
      </div>

      {open && (
        <div style={{ padding: '0 16px 14px' }}>
          {/* Plan selector */}
          <PlanSelector user={user} plans={plans} />

          {/* Top-level feature toggles */}
          <div className="ac-features">
            <FeatureRow user={user} flag="bots_on" label="📰 Summaries" />
            <FeatureRow user={user} flag="youtube_on" label="📺 YouTube Summaries" />
            <FeatureRow user={user} flag="yt_chat_on" label="💬 Video Chat" />
          </div>

          {/* Agent Bot */}
          <CollapsibleSection
            id={`agents-${user.id}`}
            open={sections.agents}
            onToggle={() => toggleSection('agents')}
            header={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <FeatureToggleStandalone
                  user={user}
                  flag="agents_on"
                />
                <span>🤖 Agent Bot</span>
                <EnabledChip on={!!user.agents_on} />
              </div>
            }
          >
            <AgentsLimitBody user={user} />
          </CollapsibleSection>

          {/* System Bot */}
          <CollapsibleSection
            id={`sysbot-${user.id}`}
            open={sections.sysbot}
            onToggle={() => toggleSection('sysbot')}
            header={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <FeatureToggleStandalone user={user} flag="sys_bot_on" />
                <span>🔧 System Bot</span>
                <EnabledChip on={!!user.sys_bot_on} />
              </div>
            }
          >
            <p
              style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                padding: '4px 0',
              }}
            >
              Grants access to the System Bot assistant panel (bottom-right
              FAB). The system bot can answer questions about the platform and
              help with configuration tasks.
            </p>
          </CollapsibleSection>

          {/* Bot Inheritance */}
          <CollapsibleSection
            id={`bots-${user.id}`}
            open={sections.bots}
            onToggle={() => toggleSection('bots')}
            header={
              <>
                <span>🤖 Bot Inheritance</span>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span className="ac-chip">
                    {(user.bot_inheritances || []).length} granted
                  </span>
                </div>
              </>
            }
          >
            <BotInheritancePanel user={user} allBots={allBots} cats={cats} />
          </CollapsibleSection>

          {/* Collection Inheritance */}
          <CollapsibleSection
            id={`colls-${user.id}`}
            open={sections.colls}
            onToggle={() => toggleSection('colls')}
            header={
              <>
                <span>📦 Collection Access</span>
                <span className="ac-chip">
                  {(user.collection_inheritances || []).length} granted
                </span>
              </>
            }
          >
            <CollectionInheritancePanel user={user} allColls={allColls} />
          </CollapsibleSection>

          {/* YouTube Inheritance */}
          <CollapsibleSection
            id={`yt-${user.id}`}
            open={sections.yt}
            onToggle={() => toggleSection('yt')}
            header={
              <>
                <span>📺 YouTube Inheritance</span>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  {pendingYt > 0 && (
                    <span className="ac-chip ac-chip-warn">
                      {pendingYt} pending
                    </span>
                  )}
                  <span className="ac-chip">
                    {(user.yt_inheritances || []).length} items
                  </span>
                </div>
              </>
            }
          >
            <YtInheritancePanel
              user={user}
              allChans={allChans}
              allKws={allKws}
            />
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({ open, onToggle, header, children }) {
  return (
    <div className="ac-section">
      <div
        className="ac-section-hd"
        onClick={onToggle}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        {header}
        <span className="ac-chevron" style={{ marginLeft: 'auto' }}>
          {open ? '▼' : '▶'}
        </span>
      </div>
      {open && <div className="ac-section-bd">{children}</div>}
    </div>
  );
}

function EnabledChip({ on }) {
  if (on) {
    return (
      <span
        className="ac-chip"
        style={{
          background: 'rgba(16,185,129,.15)',
          color: '#6ee7b7',
          border: '1px solid rgba(16,185,129,.3)',
        }}
      >
        Enabled
      </span>
    );
  }
  return <span className="ac-chip">Disabled</span>;
}

// ──────────────────────────────────────────────────────────────────────────
// Active / feature toggles

function ActiveToggle({ user }) {
  const update = useApiMutation(`/api/admin/accounts/${user.id}/update`, {
    invalidate: [ACCOUNTS_KEY],
    errorMsg: 'Update failed',
  });
  const checked = !!user.is_active;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => update.mutate({ is_active: e.target.checked })}
        />
        <span className="toggle-slider"></span>
      </label>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {checked ? 'Active' : 'Inactive'}
      </span>
    </div>
  );
}

function FeatureRow({ user, flag, label }) {
  const update = useApiMutation(`/api/admin/accounts/${user.id}/update`, {
    invalidate: [ACCOUNTS_KEY],
    errorMsg: 'Update failed',
  });
  return (
    <div className="ac-feature-row">
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={!!user[flag]}
          onChange={(e) => update.mutate({ [flag]: e.target.checked })}
        />
        <span className="toggle-slider"></span>
      </label>
      <span style={{ fontSize: 13 }}>{label}</span>
    </div>
  );
}

// Same as FeatureRow but used inside the section header — needs to stop click
// propagation so the section doesn't toggle when the user clicks the toggle.
function FeatureToggleStandalone({ user, flag }) {
  const update = useApiMutation(`/api/admin/accounts/${user.id}/update`, {
    invalidate: [ACCOUNTS_KEY],
    errorMsg: 'Update failed',
  });
  return (
    <label
      className="toggle-switch"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={!!user[flag]}
        onChange={(e) => update.mutate({ [flag]: e.target.checked })}
      />
      <span className="toggle-slider"></span>
    </label>
  );
}

function DeleteUserButton({ user }) {
  const { showConfirm } = useDialogs();
  const del = useApiMutation(`/api/admin/accounts/${user.id}/delete`, {
    invalidate: [ACCOUNTS_KEY],
    successMsg: `Deleted user "${user.username}"`,
    errorMsg: 'Delete failed',
  });

  function onClick() {
    showConfirm(
      `Delete user "${user.username}"? This cannot be undone.`,
      () => del.mutate({}),
      {
        title: 'Delete User',
        confirmLabel: 'Delete',
        confirmClass: 'btn-danger',
      }
    );
  }

  return (
    <button
      className="btn btn-danger btn-sm"
      onClick={onClick}
      disabled={del.isPending}
    >
      Delete
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// AI Plan selector + Agent limit body

function PlanSelector({ user, plans }) {
  const update = useApiMutation(`/api/admin/accounts/${user.id}/update`, {
    invalidate: [ACCOUNTS_KEY],
    errorMsg: 'Update failed',
  });
  return (
    <div
      style={{
        padding: '10px 0 6px',
        borderTop: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          whiteSpace: 'nowrap',
        }}
      >
        AI Plan:
      </span>
      <select
        className="select"
        style={{ fontSize: 12, padding: '4px 8px', height: 28, minWidth: 150 }}
        value={user.ai_plan_id || ''}
        onChange={(e) =>
          update.mutate({
            ai_plan_id: e.target.value ? parseInt(e.target.value) : null,
          })
        }
      >
        <option value="">— No plan —</option>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.monthly_limit} req/mo)
          </option>
        ))}
      </select>
      {user.ai_plan_name && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {user.ai_plan_monthly_limit} requests/month
        </span>
      )}
    </div>
  );
}

function AgentsLimitBody({ user }) {
  const update = useApiMutation(`/api/admin/accounts/${user.id}/update`, {
    invalidate: [ACCOUNTS_KEY],
    errorMsg: 'Update failed',
  });
  const initialLim = user.agents_limit || {};
  const [type, setType] = useState(initialLim.type || 'calls');
  const [value, setValue] = useState(
    initialLim.value != null ? String(initialLim.value) : ''
  );

  if (!user.agents_on) {
    return (
      <p
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          padding: '4px 0',
        }}
      >
        Enable Agent Bot above to configure usage limits.
      </p>
    );
  }

  function commit(nextType, nextValue) {
    const numericValue = parseFloat(nextValue) || 0;
    update.mutate({
      agents_limit: { type: nextType, value: numericValue },
    });
  }

  function onTypeChange(e) {
    setType(e.target.value);
    commit(e.target.value, value);
  }

  function onValueBlur() {
    commit(type, value);
  }

  const numericValue = parseFloat(value) || 0;
  const display =
    type === 'money'
      ? `$${numericValue}`
      : value !== ''
        ? `${numericValue} calls`
        : 'No limit';

  return (
    <>
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        Usage limit — leave blank for unlimited.
      </div>
      <div className="ac-limit-row">
        <select
          className="select"
          style={{ fontSize: 12, padding: '4px 8px', height: 28 }}
          value={type}
          onChange={onTypeChange}
        >
          <option value="calls">Call limit</option>
          <option value="money">$ limit</option>
        </select>
        <input
          type="number"
          className="ac-num-inp"
          placeholder="∞"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={onValueBlur}
          min="0"
          step="0.01"
        />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {display}
        </span>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Bot inheritance

function BotInheritancePanel({ user, allBots, cats }) {
  const granted = user.bot_inheritances || [];
  const grantedIds = new Set(granted.map((g) => g.bot_id));
  const available = allBots.filter(
    (b) => !grantedIds.has(b.id) && b.owner_id !== user.id
  );

  return (
    <>
      {granted.map((g) => (
        <BotInheritanceRow
          key={g.bot_id}
          user={user}
          grant={g}
          cats={cats.filter((c) => c.bot_id === g.bot_id)}
        />
      ))}
      <BotGrantRow user={user} available={available} />
    </>
  );
}

function BotInheritanceRow({ user, grant, cats }) {
  const update = useApiMutation(
    `/api/admin/accounts/${user.id}/bots/${grant.bot_id}`,
    { invalidate: [ACCOUNTS_KEY], errorMsg: 'Update failed' }
  );
  const revoke = useApiMutation(
    `/api/admin/accounts/${user.id}/bots/${grant.bot_id}/delete`,
    {
      invalidate: [ACCOUNTS_KEY],
      successMsg: `Revoked "${grant.bot_name}"`,
      errorMsg: 'Revoke failed',
    }
  );

  const selCats =
    grant.inherit_categories && grant.inherit_categories.length
      ? new Set(grant.inherit_categories)
      : null;
  const selTops =
    grant.inherit_topics && grant.inherit_topics.length
      ? new Set(grant.inherit_topics)
      : null;

  const tsMap = useMemo(() => {
    const m = {};
    for (const ts of grant.topic_settings || []) m[ts.topic_id] = ts;
    return m;
  }, [grant.topic_settings]);

  // Compute new lists for an updated category check.
  function onCategoryToggle(catId, checked) {
    // Cascade to that category's topic checkboxes via state, but since we
    // immediately invalidate the query we just send the resulting ids.
    const allCatIds = cats.map((c) => c.category_id);
    const allTopicIds = cats.flatMap((c) => (c.topics || []).map((t) => t.id));
    const currentCats = selCats ? new Set(selCats) : new Set(allCatIds);
    const currentTops = selTops ? new Set(selTops) : new Set(allTopicIds);

    if (checked) currentCats.add(catId);
    else currentCats.delete(catId);

    // Cascade topics: select/deselect all topics under this category
    const cat = cats.find((c) => c.category_id === catId);
    for (const t of cat?.topics || []) {
      if (checked) currentTops.add(t.id);
      else currentTops.delete(t.id);
    }

    const inheritCats =
      currentCats.size === allCatIds.length ? [] : Array.from(currentCats);
    const inheritTops =
      currentTops.size === allTopicIds.length ? [] : Array.from(currentTops);

    update.mutate({
      inherit_categories: inheritCats,
      inherit_topics: inheritTops,
    });

    // Cascade per-topic inheritance side-effects (init/delete records)
    for (const t of cat?.topics || []) {
      if (checked) {
        api(
          `/api/admin/accounts/${user.id}/bots/${grant.bot_id}/topics/${t.id}`,
          {}
        );
      } else {
        api(
          `/api/admin/accounts/${user.id}/bots/${grant.bot_id}/topics/${t.id}/delete`,
          {}
        );
      }
    }
  }

  function onTopicToggle(topicId, checked) {
    const allTopicIds = cats.flatMap((c) => (c.topics || []).map((t) => t.id));
    const current = selTops ? new Set(selTops) : new Set(allTopicIds);
    if (checked) current.add(topicId);
    else current.delete(topicId);
    const inheritTops =
      current.size === allTopicIds.length ? [] : Array.from(current);
    update.mutate({ inherit_topics: inheritTops });

    // Init / delete topic-settings record
    if (checked) {
      api(
        `/api/admin/accounts/${user.id}/bots/${grant.bot_id}/topics/${topicId}`,
        {}
      );
    } else {
      api(
        `/api/admin/accounts/${user.id}/bots/${grant.bot_id}/topics/${topicId}/delete`,
        {}
      );
    }
  }

  return (
    <div className="ac-inh-row">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          🤖 {grant.bot_name}
        </span>
        <button
          className="btn btn-danger"
          style={{ padding: '3px 9px', fontSize: 11 }}
          onClick={() => revoke.mutate({})}
          disabled={revoke.isPending}
        >
          Revoke
        </button>
      </div>
      <div
        style={{
          marginTop: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <BotFlagCheck
            grant={grant}
            field="rules"
            label="Rules"
            update={update}
          />
          <BotFlagCheck
            grant={grant}
            field="messages_db"
            label="Share messages DB"
            update={update}
          />
        </div>
        {cats.length > 0 && (
          <div className="ac-tree">
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginBottom: 8,
              }}
            >
              Category / Topic access &nbsp;
              <span style={{ opacity: 0.6 }}>(all checked = full access)</span>
            </div>
            {cats.map((c) => {
              const catOn = selCats === null || selCats.has(c.category_id);
              return (
                <div key={c.category_id} style={{ marginBottom: 8 }}>
                  <label
                    className="ac-check"
                    style={{ fontWeight: 500 }}
                  >
                    <input
                      type="checkbox"
                      checked={catOn}
                      onChange={(e) =>
                        onCategoryToggle(c.category_id, e.target.checked)
                      }
                    />
                    📁 {c.category_name}
                  </label>
                  {(c.topics || []).length > 0 && (
                    <div style={{ marginLeft: 22, marginTop: 6 }}>
                      {(c.topics || []).map((t) => {
                        const topOn = selTops === null || selTops.has(t.id);
                        const ts = tsMap[t.id] || {};
                        return (
                          <BotTopicRow
                            key={t.id}
                            user={user}
                            botId={grant.bot_id}
                            topic={t}
                            on={topOn}
                            ts={ts}
                            onTopicToggle={onTopicToggle}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function BotFlagCheck({ grant, field, label, update }) {
  return (
    <label className="ac-check">
      <input
        type="checkbox"
        checked={!!grant['inherit_' + field]}
        onChange={(e) =>
          update.mutate({ ['inherit_' + field]: e.target.checked })
        }
      />
      {label}
    </label>
  );
}

function BotTopicRow({ user, botId, topic, on, ts, onTopicToggle }) {
  const setTopicSetting = useApiMutation(
    `/api/admin/accounts/${user.id}/bots/${botId}/topics/${topic.id}`,
    { invalidate: [ACCOUNTS_KEY], errorMsg: 'Update failed' }
  );

  const inclSched = ts.include_schedules !== false;
  const inclProm = ts.include_prompts !== false;
  const seoVis = ts.seo_visible !== false;
  const kwPct = ts.keyword_pct != null ? ts.keyword_pct : 100;
  const [pctValue, setPctValue] = useState(String(kwPct));

  return (
    <div className="ac-topic-row">
      <label className="ac-check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onTopicToggle(topic.id, e.target.checked)}
        />
        🏷 {topic.name}
      </label>
      {on && (
        <div className="ac-topic-settings">
          <label className="ac-check ac-check-sm">
            <input
              type="checkbox"
              checked={inclSched}
              onChange={(e) =>
                setTopicSetting.mutate({ include_schedules: e.target.checked })
              }
            />
            📅 Schedules
          </label>
          <label className="ac-check ac-check-sm">
            <input
              type="checkbox"
              checked={inclProm}
              onChange={(e) =>
                setTopicSetting.mutate({ include_prompts: e.target.checked })
              }
            />
            💬 Prompts
          </label>
          <label className="ac-check ac-check-sm">
            <input
              type="checkbox"
              checked={seoVis}
              onChange={(e) =>
                setTopicSetting.mutate({ seo_visible: e.target.checked })
              }
            />
            🔎 SEO visible
          </label>
          <div className="ac-kw-pct">
            <span className="ac-check-sm">🔑 Keywords</span>
            <input
              type="number"
              min="0"
              max="100"
              value={pctValue}
              onChange={(e) => setPctValue(e.target.value)}
              onBlur={() => {
                const v = Math.min(
                  100,
                  Math.max(0, parseInt(pctValue) || 0)
                );
                setPctValue(String(v));
                setTopicSetting.mutate({ keyword_pct: v });
              }}
              className="ac-num-inp ac-num-pct"
            />
            <span className="ac-check-sm">%</span>
          </div>
        </div>
      )}
    </div>
  );
}

function BotGrantRow({ user, available }) {
  const [selected, setSelected] = useState('');
  const grant = useApiMutation(
    `/api/admin/accounts/${user.id}/bots/${selected || 0}`,
    {
      invalidate: [ACCOUNTS_KEY],
      successMsg: 'Bot access granted',
      errorMsg: 'Grant failed',
      onSuccess: () => setSelected(''),
    }
  );

  if (!available.length) {
    return (
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
        All bots already granted.
      </p>
    );
  }

  return (
    <div className="ac-add-row">
      <select
        className="select"
        style={{ fontSize: 12, padding: '4px 8px', height: 28 }}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">— Select bot to grant —</option>
        {available.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <button
        className="btn btn-primary btn-sm"
        onClick={() => {
          if (!selected) return;
          grant.mutate({});
        }}
        disabled={!selected || grant.isPending}
      >
        Grant Access
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Collection inheritance

function CollectionInheritancePanel({ user, allColls }) {
  const granted = user.collection_inheritances || [];
  const grantedSet = new Set(granted);
  const available = allColls.filter((n) => !grantedSet.has(n));

  return (
    <>
      {granted.map((name) => (
        <CollectionRow key={name} user={user} name={name} />
      ))}
      <CollectionGrantRow user={user} available={available} all={allColls} />
    </>
  );
}

function CollectionRow({ user, name }) {
  const revoke = useApiMutation(
    `/api/admin/accounts/${user.id}/collections/${encodeURIComponent(name)}/delete`,
    {
      invalidate: [ACCOUNTS_KEY],
      successMsg: `Revoked "${name}"`,
      errorMsg: 'Revoke failed',
    }
  );
  return (
    <div className="ac-inh-row">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500 }}>📦 {name}</span>
        <button
          className="btn btn-danger"
          style={{ padding: '3px 9px', fontSize: 11 }}
          onClick={() => revoke.mutate({})}
          disabled={revoke.isPending}
        >
          Revoke
        </button>
      </div>
    </div>
  );
}

function CollectionGrantRow({ user, available, all }) {
  const [selected, setSelected] = useState('');
  const grant = useApiMutation(
    `/api/admin/accounts/${user.id}/collections/${encodeURIComponent(selected || ' ')}`,
    {
      invalidate: [ACCOUNTS_KEY],
      successMsg: 'Collection access granted',
      errorMsg: 'Grant failed',
      onSuccess: () => setSelected(''),
    }
  );

  if (!available.length) {
    return (
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
        {all.length === 0
          ? 'No collections configured yet.'
          : 'All collections already granted.'}
      </p>
    );
  }

  return (
    <div className="ac-add-row">
      <select
        className="select"
        style={{ fontSize: 12, padding: '4px 8px', height: 28 }}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">— Select collection to grant —</option>
        {available.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <button
        className="btn btn-primary btn-sm"
        onClick={() => {
          if (!selected) return;
          grant.mutate({});
        }}
        disabled={!selected || grant.isPending}
      >
        Grant Access
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// YouTube inheritance

function YtInheritancePanel({ user, allChans, allKws }) {
  const items = user.yt_inheritances || [];
  const pushed = new Set(items.map((i) => `${i.source_type}:${i.source_id}`));
  const availChans = allChans.filter((c) => !pushed.has(`channel:${c.id}`));
  const availKws = allKws.filter((k) => !pushed.has(`keyword:${k.id}`));

  return (
    <>
      {items.map((i) => (
        <YtItemRow key={i.id} user={user} item={i} />
      ))}
      <YtPushPanel
        user={user}
        availChans={availChans}
        availKws={availKws}
        hasItems={items.length > 0}
      />
    </>
  );
}

function YtItemRow({ user, item }) {
  const updateCont = useApiMutation(
    `/api/admin/accounts/${user.id}/youtube/${item.id}/update`,
    { invalidate: [ACCOUNTS_KEY], errorMsg: 'Update failed' }
  );
  const remove = useApiMutation(
    `/api/admin/accounts/${user.id}/youtube/${item.id}/delete`,
    {
      invalidate: [ACCOUNTS_KEY],
      successMsg: 'YouTube source removed',
      errorMsg: 'Remove failed',
    }
  );

  return (
    <div className="ac-inh-row">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span>
          {item.source_type === 'channel' ? '📺' : '🔎'}{' '}
          <strong>{item.source_name || String(item.source_id)}</strong>
        </span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <YtStatusBadge status={item.status} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label className="toggle-switch toggle-sm">
              <input
                type="checkbox"
                checked={!!item.continuous}
                onChange={(e) =>
                  updateCont.mutate({ continuous: e.target.checked })
                }
              />
              <span className="toggle-slider"></span>
            </label>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Continuous
            </span>
          </div>
          <button
            className="btn btn-danger"
            style={{ padding: '3px 8px', fontSize: 11 }}
            onClick={() => remove.mutate({})}
            disabled={remove.isPending}
          >
            ✕
          </button>
        </div>
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          marginTop: 4,
        }}
      >
        Pushed {fmtDate(item.pushed_at)}
        {item.responded_at ? ` · Responded ${fmtDate(item.responded_at)}` : ''}
      </div>
    </div>
  );
}

function YtStatusBadge({ status }) {
  if (status === 'confirmed') {
    return (
      <span
        className="badge"
        style={{
          background: 'rgba(16,185,129,.15)',
          color: '#6ee7b7',
          border: '1px solid rgba(16,185,129,.3)',
        }}
      >
        ✓ Confirmed
      </span>
    );
  }
  if (status === 'rejected') {
    return (
      <span
        className="badge"
        style={{
          background: 'rgba(239,68,68,.1)',
          color: '#fca5a5',
          border: '1px solid rgba(239,68,68,.25)',
        }}
      >
        ✗ Rejected
      </span>
    );
  }
  return (
    <span
      className="badge"
      style={{
        background: 'rgba(245,158,11,.1)',
        color: '#fcd34d',
        border: '1px solid rgba(245,158,11,.25)',
      }}
    >
      ⏳ Pending
    </span>
  );
}

function YtPushPanel({ user, availChans, availKws, hasItems }) {
  const qc = useQueryClient();
  const { showNotification } = useDialogs();
  const [picked, setPicked] = useState({}); // { "channel:1": true, "keyword:5": true }
  const [continuous, setContinuous] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!availChans.length && !availKws.length) {
    if (!hasItems) {
      return (
        <p
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginTop: 8,
          }}
        >
          No YouTube channels or trackers configured yet.
        </p>
      );
    }
    return (
      <p
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginTop: 8,
        }}
      >
        All available sources already pushed.
      </p>
    );
  }

  function toggle(key) {
    setPicked((p) => ({ ...p, [key]: !p[key] }));
  }

  async function pushSelected() {
    const entries = Object.entries(picked).filter(([, v]) => v);
    if (!entries.length) return;
    setBusy(true);
    const reqs = entries.map(([key]) => {
      const [source_type, idStr] = key.split(':');
      const source_id = parseInt(idStr);
      let source_name = '';
      if (source_type === 'channel') {
        const c = availChans.find((x) => x.id === source_id);
        source_name = c ? c.channel_name || c.channel_id || '' : '';
      } else {
        const k = availKws.find((x) => x.id === source_id);
        source_name = k ? k.keyword || '' : '';
      }
      return api(`/api/admin/accounts/${user.id}/youtube`, {
        source_type,
        source_id,
        source_name,
        continuous,
      });
    });
    const results = await Promise.all(reqs);
    setBusy(false);
    setPicked({});
    setContinuous(false);
    qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    const failed = results.filter((r) => r?.status !== 'ok').length;
    if (failed > 0) {
      showNotification(`Pushed ${results.length - failed}/${results.length}; ${failed} failed`, 'error');
    } else {
      showNotification(`Pushed ${results.length} source(s)`, 'success');
    }
  }

  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px solid var(--border-color)',
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        Select sources to push to this user:
      </div>
      {availChans.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: '.04em',
            }}
          >
            Channels
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {availChans.map((c) => {
              const key = `channel:${c.id}`;
              const name = c.channel_name || c.channel_id || '';
              return (
                <label key={key} className="ac-check">
                  <input
                    type="checkbox"
                    checked={!!picked[key]}
                    onChange={() => toggle(key)}
                  />
                  📺 {name}
                </label>
              );
            })}
          </div>
        </div>
      )}
      {availKws.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: '.04em',
            }}
          >
            SEO Trackers
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {availKws.map((k) => {
              const key = `keyword:${k.id}`;
              return (
                <label key={key} className="ac-check">
                  <input
                    type="checkbox"
                    checked={!!picked[key]}
                    onChange={() => toggle(key)}
                  />
                  🔎 {k.keyword}
                </label>
              );
            })}
          </div>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 4,
        }}
      >
        <label className="ac-check">
          <input
            type="checkbox"
            checked={continuous}
            onChange={(e) => setContinuous(e.target.checked)}
          />
          Continuous for all selected
        </label>
        <button
          className="btn btn-primary btn-sm"
          onClick={pushSelected}
          disabled={busy}
        >
          {busy ? 'Pushing…' : 'Push Selected'}
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Plans tab

function PlansTab({ plans }) {
  const defaultPlans = plans.filter((p) => p.is_default);
  const customPlans = plans.filter((p) => !p.is_default);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 10,
        }}
      >
        Assign plans to users in the <strong>Users</strong> tab. Edit limits and
        names here dynamically — changes apply immediately to all assigned
        users.
      </div>

      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          marginBottom: 8,
          color: 'var(--text-secondary)',
        }}
      >
        Default Plans
      </div>
      {defaultPlans.length > 0 ? (
        defaultPlans.map((p) => <PlanCard key={p.id} plan={p} />)
      ) : (
        <p className="text-muted" style={{ fontSize: 12 }}>
          No default plans.
        </p>
      )}

      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          margin: '16px 0 8px',
          color: 'var(--text-secondary)',
        }}
      >
        Custom Plans
      </div>
      {customPlans.length > 0 ? (
        customPlans.map((p) => <PlanCard key={p.id} plan={p} />)
      ) : (
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          No custom plans yet.
        </p>
      )}

      <CreatePlanCard />
    </div>
  );
}

function PlanCard({ plan }) {
  const { showConfirm } = useDialogs();
  const [name, setName] = useState(plan.name);
  const [limit, setLimit] = useState(String(plan.monthly_limit));

  const update = useApiMutation(`/api/admin/plans/${plan.id}/update`, {
    invalidate: [ACCOUNTS_KEY],
    errorMsg: 'Update failed',
  });
  const del = useApiMutation(`/api/admin/plans/${plan.id}/delete`, {
    invalidate: [ACCOUNTS_KEY],
    successMsg: `Deleted plan "${plan.name}"`,
    errorMsg: 'Delete failed',
  });

  function onLimitBlur() {
    const v = parseInt(limit);
    if (!v || v < 1) {
      setLimit(String(plan.monthly_limit));
      return;
    }
    if (v !== plan.monthly_limit) update.mutate({ monthly_limit: v });
  }

  function onNameBlur() {
    const v = name.trim();
    if (!v) {
      setName(plan.name);
      return;
    }
    if (v !== plan.name) update.mutate({ name: v });
  }

  function onDelete() {
    showConfirm(
      `Delete plan "${plan.name}"? Users assigned to it will have their plan cleared.`,
      () => del.mutate({}),
      {
        title: 'Delete Plan',
        confirmLabel: 'Delete',
        confirmClass: 'btn-danger',
      }
    );
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 4,
            }}
          >
            <span
              className={`ac-plan-pill ac-plan-${plan.name
                .toLowerCase()
                .replace(/\s+/g, '-')}`}
            >
              {plan.name}
            </span>
            {plan.is_default ? (
              <span className="ac-chip" style={{ fontSize: 10 }}>
                Default
              </span>
            ) : (
              <span
                className="ac-chip"
                style={{
                  fontSize: 10,
                  color: '#a78bfa',
                  borderColor: 'rgba(167,139,250,.3)',
                }}
              >
                Custom
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              marginBottom: 8,
            }}
          >
            {plan.description || ''}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span
                style={{ fontSize: 12, color: 'var(--text-muted)' }}
              >
                Monthly limit:
              </span>
              <input
                type="number"
                className="ac-num-inp"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                onBlur={onLimitBlur}
                min="1"
                style={{ width: 80 }}
              />
              <span
                style={{ fontSize: 12, color: 'var(--text-muted)' }}
              >
                requests
              </span>
            </div>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span
                style={{ fontSize: 12, color: 'var(--text-muted)' }}
              >
                Name:
              </span>
              <input
                type="text"
                className="ac-num-inp"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={onNameBlur}
                style={{ width: 120, fontSize: 12 }}
                disabled={!!plan.is_default}
                title={
                  plan.is_default
                    ? 'Default plan names cannot be changed'
                    : ''
                }
              />
            </div>
          </div>
        </div>
        {!plan.is_default && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <button
              className="btn btn-danger btn-sm"
              onClick={onDelete}
              disabled={del.isPending}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CreatePlanCard() {
  const { showAlert } = useDialogs();
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('');
  const [desc, setDesc] = useState('');

  const create = useApiMutation('/api/admin/plans', {
    invalidate: [ACCOUNTS_KEY],
    successMsg: 'Plan created',
    errorMsg: 'Failed to create plan',
    onSuccess: () => {
      setName('');
      setLimit('');
      setDesc('');
    },
  });

  function onCreate() {
    if (!name.trim()) {
      showAlert('Plan name is required.');
      return;
    }
    const lim = parseInt(limit);
    if (!lim || lim < 1) {
      showAlert('Monthly limit must be a positive number.');
      return;
    }
    create.mutate({
      name: name.trim(),
      monthly_limit: lim,
      description: desc.trim(),
    });
  }

  return (
    <div className="card" style={{ border: '1px dashed var(--border-color)' }}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>
        Create Custom Plan
      </div>
      <div
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginBottom: 4,
            }}
          >
            Plan name
          </div>
          <input
            type="text"
            className="input"
            placeholder="e.g. Enterprise"
            style={{
              fontSize: 12,
              padding: '5px 10px',
              height: 32,
              width: 150,
            }}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginBottom: 4,
            }}
          >
            Monthly limit
          </div>
          <input
            type="number"
            className="ac-num-inp"
            placeholder="500"
            min="1"
            style={{ width: 90 }}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginBottom: 4,
            }}
          >
            Description (optional)
          </div>
          <input
            type="text"
            className="input"
            placeholder="Brief description"
            style={{
              fontSize: 12,
              padding: '5px 10px',
              height: 32,
              width: '100%',
            }}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={onCreate}
          style={{ height: 32 }}
          disabled={create.isPending}
        >
          + Create Plan
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Create User modal

function CreateUserModal({ onClose }) {
  const qc = useQueryClient();
  const { showNotification } = useDialogs();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError('');
    if (!username || username.trim().length < 3) {
      setError('Username must be at least 3 characters.');
      return;
    }
    if (!password || password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setBusy(true);
    const res = await api('/api/auth/register', {
      username: username.trim(),
      password,
    });
    setBusy(false);
    if (res?.error) {
      setError(res.error);
      return;
    }
    qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    showNotification('User created', 'success');
    onClose();
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') onSubmit();
    if (e.key === 'Escape') onClose();
  }

  return (
    <div className="modal-overlay" onKeyDown={onKeyDown}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Create New User</h3>
          <button className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">Username</label>
            <input
              className="input"
              type="text"
              placeholder="e.g. john_doe"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              className="input"
              type="password"
              placeholder="Min. 6 characters"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <div
              style={{
                color: 'var(--danger)',
                fontSize: 13,
                marginTop: 10,
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={busy}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers + injected styles (mirrors legacy injectAccountsStyles)

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function AccountsStyles() {
  // The legacy file injected these once on load; here they're mounted with
  // the page so they're tied to the route's lifetime.
  return (
    <style>{`
    .ac-avatar {
        width:42px; height:42px; border-radius:50%; background:var(--accent-primary);
        color:#fff; display:flex; align-items:center; justify-content:center;
        font-size:18px; font-weight:700; flex-shrink:0;
    }
    .ac-chip {
        font-size:11px; padding:2px 7px; border-radius:10px;
        background:rgba(255,255,255,0.06); border:1px solid var(--border-color);
        color:var(--text-muted); white-space:nowrap;
    }
    .ac-chip-tg   { border-color:rgba(39,170,225,.3) !important; color:#27aae1 !important; }
    .ac-chip-warn { border-color:rgba(245,158,11,.3)  !important; color:var(--warning) !important; }
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
    .ac-inh-row {
        background:rgba(255,255,255,.03); border:1px solid var(--border-color);
        border-radius:var(--radius-sm); padding:10px 12px; margin-bottom:8px;
    }
    .ac-inh-row:last-of-type { margin-bottom:0; }
    .ac-check {
        display:inline-flex; align-items:center; gap:5px;
        font-size:12px; color:var(--text-secondary); cursor:pointer; user-select:none;
    }
    .ac-check input { accent-color:var(--accent-primary); cursor:pointer; }
    .ac-tree {
        border-top:1px solid var(--border-color); padding-top:10px; margin-top:4px;
    }
    .ac-add-row {
        display:flex; align-items:center; gap:8px; flex-wrap:wrap;
        padding-top:10px; margin-top:4px; border-top:1px solid var(--border-color);
    }
    .toggle-switch.toggle-sm { width:34px; height:18px; }
    .toggle-switch.toggle-sm .toggle-slider:before {
        height:12px; width:12px; left:3px; bottom:3px;
    }
    .toggle-switch.toggle-sm input:checked + .toggle-slider:before {
        transform:translateX(16px);
    }
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
    .acct-user-card { padding:0; }
    .acct-card-hd {
        display:flex; justify-content:space-between; align-items:center;
        gap:12px; padding:14px 16px; cursor:pointer; user-select:none;
        transition:background .15s; flex-wrap:wrap;
    }
    .acct-card-hd:hover { background:rgba(255,255,255,.025); }
    .acct-user-chevron  { font-size:11px; color:var(--text-muted); }
    `}</style>
  );
}
