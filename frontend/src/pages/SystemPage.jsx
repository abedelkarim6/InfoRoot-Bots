/**
 * System (Main Dashboard) — port of legacy `renderSystemPage()` in
 * static/js/modern.js plus the system-page markup in static/index.html
 * (#system-page).
 *
 * Features ported:
 *   - Master System Control card with on/off toggle (admin only — disabled for
 *     regular users) and live status text.
 *   - News Summarizer Bots header + 4-stat overview grid (Bots / Collections /
 *     Categories / Topics) with active/inactive sublines. Hidden for users
 *     without bot access.
 *   - Per-bot detail cards with category breakdown (sys-cat-row) and a
 *     "Configure →" link to the bots page.
 *   - "Subscribed Channels" collapsible card for non-admin users (legacy
 *     renderUserChannelsCard) showing each collection and its source channels.
 *   - YouTube Monitor overview (renderYoutubeOverview): channels / SEOs /
 *     summaries / queue stats fetched live from /api/youtube/overview.
 *   - "Add New Bot" button (admin only) that navigates to /bots.
 *
 * Data flow:
 *   - The shared global config (/api/config) comes from useGlobalConfig() so
 *     this page reuses the cache rather than re-fetching.
 *   - The system on/off mutation invalidates ['config'] so the toggle, status
 *     text, and any other consumer (sidebar badges) refresh in place.
 *   - YouTube overview uses its own ['yt-overview'] query.
 *
 * Backend endpoints used:
 *   GET  /api/config            (via useGlobalConfig)
 *   POST /api/system/toggle     (admin only, system master switch)
 *   GET  /api/youtube/overview  (YouTube monitor live stats)
 *
 * Deviation: the legacy global "System Bot" floating drawer (#sys-bot-fab) is
 * a shell-level widget rendered on every page, not specific to the System
 * page, so it is intentionally NOT ported here. Wire it up at the AppShell
 * level if/when desired.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../lib/api';
import { useApiMutation } from '../lib/useApiMutation';
import { useGlobalConfig } from '../config/ConfigProvider';
import { useAuth } from '../auth/AuthContext';
import PageHeader from '../components/PageHeader';

export default function SystemPage() {
  const { config } = useGlobalConfig();
  const { user, isAdmin: isAdminCtx } = useAuth();

  // Match legacy: treat missing/loading user as admin (i.e. don't hide controls
  // before /api/auth/me resolves). Once user loads, defer to its role.
  const isAdmin = !user || user.role === 'admin' || isAdminCtx;
  const hasBotAccess = isAdmin || !!user?.has_bot_access;
  const hasYt = isAdmin || !!user?.youtube_on;

  const bots = config?.bots || {};
  const collections = config?.collections || {};
  const systemEnabled = config?.system?.enabled !== false;

  const stats = computeStats(bots, collections);

  const toggle = useApiMutation('/api/system/toggle', {
    invalidate: ['config'],
    successMsg: (res) => res?.message || 'System toggled',
    errorMsg: 'Failed to toggle system',
  });

  return (
    <div className="page active" id="system-page">
      <PageHeader
        title="System Overview"
        subtitle="Master control and bot monitoring"
      >
        {isAdmin && (
          <Link to="/bots" className="btn btn-primary" id="sys-add-bot-btn">
            <span>➕</span> Add New Bot
          </Link>
        )}
      </PageHeader>

      {/* Master switch */}
      <div className="system-control-card" id="sys-control-card">
        <div className="system-control-header">
          <h3>🔌 Master System Control</h3>
          <label className="toggle-switch toggle-large" id="sys-control-toggle-wrap">
            <input
              type="checkbox"
              id="system-toggle"
              checked={systemEnabled}
              disabled={!isAdmin || toggle.isPending}
              onChange={(e) => toggle.mutate({ enabled: e.target.checked })}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="text-muted mt-2" id="system-status-text">
          {systemEnabled
            ? '✅ System is online. All bots, collections, and YouTube monitors are operational.'
            : '⛔ System is offline. All bot operations and YouTube processing are suspended.'}
        </p>
      </div>

      {/* News Summarizer Bots */}
      {hasBotAccess && (
        <>
          <h3 className="section-title mt-4" id="sys-news-section-title">
            📰 News Summarizer Bots
          </h3>

          <div className="stats-grid" id="sys-news-stats" style={{ marginBottom: 16 }}>
            <StatCard
              icon="🤖"
              value={stats.totalBots}
              label="Bots"
              on={stats.activeBots}
              total={stats.totalBots}
            />
            <StatCard
              icon="📦"
              value={stats.totalColls}
              label="Collections"
              on={stats.enabledColls}
              total={stats.totalColls}
            />
            <StatCard
              icon="🗂️"
              value={stats.totalCats}
              label="Categories"
              on={stats.enabledCats}
              total={stats.totalCats}
            />
            <StatCard
              icon="📝"
              value={stats.totalTopics}
              label="Topics"
              on={stats.enabledTopics}
              total={stats.totalTopics}
            />
          </div>
        </>
      )}

      {/* Bot list / empty state */}
      <div id="system-bots-list">
        {!hasBotAccess && (
          <div className="card" style={{ textAlign: 'center', padding: '32px 20px' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🔒</div>
            <p className="text-muted">No bots have been shared with your account yet.</p>
            <p className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
              Contact the admin to request access.
            </p>
          </div>
        )}

        {hasBotAccess && Object.keys(bots).length === 0 && (
          <div className="create-bot-card">
            <h3>No bots configured yet</h3>
            <p className="text-muted">Create your first bot to get started</p>
            <Link to="/bots" className="btn btn-primary mt-2">
              <span>➕</span> Create First Bot
            </Link>
          </div>
        )}

        {hasBotAccess &&
          Object.entries(bots).map(([name, bot]) => (
            <BotDetailCard key={name} name={name} bot={bot} />
          ))}
      </div>

      {/* Subscribed channels card (non-admin) */}
      {!isAdmin && <UserChannelsCard collections={collections} />}

      {/* YouTube Monitor overview */}
      {hasYt && (
        <>
          <h3 className="section-title mt-4" id="sys-yt-section-title">
            📺 YouTube Monitor
          </h3>
          <YoutubeOverview />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat cards (4-tile overview grid)

function StatCard({ icon, value, label, on, total }) {
  const off = total - on;
  return (
    <div className="stat-card">
      <div className="stat-icon">{icon}</div>
      <div className="stat-content">
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
        <div className="stat-sub">
          {total === 0 ? (
            <span style={{ color: 'var(--text-muted)' }}>—</span>
          ) : off > 0 ? (
            <>
              <span style={{ color: 'var(--success)' }}>{on} on</span>
              {' / '}
              <span style={{ color: 'var(--danger)' }}>{off} off</span>
            </>
          ) : (
            <span style={{ color: 'var(--success)' }}>all enabled</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-bot detail card (legacy createBotDetailCard)

function BotDetailCard({ name, bot }) {
  const catEntries = Object.entries(bot.categories || {});
  const collectionsCount = (bot.collections || []).length;

  let totalCats = catEntries.length;
  let enabledCats = 0;
  let totalTopics = 0;
  let enabledTopics = 0;

  const catRows = catEntries.map(([catName, cat]) => {
    const catOn = cat.enabled !== false;
    if (catOn) enabledCats++;
    const topics = cat.topics || {};
    const tNames = Object.keys(topics);
    let tOn = 0;
    for (const tn of tNames) {
      if (topics[tn].enabled !== false) tOn++;
    }
    const tCount = tNames.length;
    totalTopics += tCount;
    enabledTopics += tOn;
    const tOff = tCount - tOn;
    return {
      catName,
      catOn,
      tOn,
      tOff,
      tCount,
    };
  });

  const disabledCats = totalCats - enabledCats;
  const disabledTopics = totalTopics - enabledTopics;

  return (
    <div className="bot-detail-card">
      <div className="bot-detail-header">
        <div className="flex-center">
          <h4>🤖 {name}</h4>
          <span
            className={`bot-status-badge ${bot.enabled !== false ? 'active' : 'inactive'}`}
          >
            {bot.enabled !== false ? '✓ Active' : '○ Inactive'}
          </span>
        </div>
        <Link
          to={`/bots?bot=${encodeURIComponent(name)}`}
          className="btn btn-primary btn-sm"
        >
          Configure →
        </Link>
      </div>
      <div className="bot-detail-stats">
        <div className="stat-item">
          <span className="stat-label">Collections:</span>
          <span className="stat-value">{collectionsCount}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Categories:</span>
          <span>
            {totalCats} total — <CountInline on={enabledCats} off={disabledCats} />
          </span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Topics:</span>
          <span>
            {totalTopics} total —{' '}
            <CountInline on={enabledTopics} off={disabledTopics} />
          </span>
        </div>
      </div>
      {catRows.length > 0 && (
        <div className="sys-cat-breakdown">
          {catRows.map((row) => (
            <div className="sys-cat-row" key={row.catName}>
              <span
                style={{
                  color: row.catOn ? 'var(--success)' : 'var(--danger)',
                  fontSize: 10,
                  flexShrink: 0,
                }}
              >
                ●
              </span>
              <span className="sys-cat-name">{row.catName}</span>
              <span className="sys-cat-topics">
                {row.tCount === 0 ? (
                  '—'
                ) : (
                  <>
                    {row.tOn} on
                    {row.tOff > 0 && (
                      <>
                        {' / '}
                        <span style={{ color: 'var(--danger)' }}>{row.tOff} off</span>
                      </>
                    )}
                  </>
                )}{' '}
                topics
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CountInline({ on, off }) {
  return (
    <>
      <span style={{ color: 'var(--success)', fontWeight: 600 }}>{on} on</span>
      {off > 0 && (
        <>
          {' / '}
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{off} off</span>
        </>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscribed channels (non-admin users) — collapsible

function UserChannelsCard({ collections }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(collections || {});

  if (entries.length === 0) {
    return (
      <div id="sys-user-channels">
        <div className="ch-val-card">
          <div className="ch-val-header">
            <div className="ch-val-title">
              <span style={{ fontSize: 20 }}>📡</span>
              <h3 style={{ margin: 0 }}>Subscribed Channels</h3>
            </div>
          </div>
          <div className="ch-val-body" style={{ display: 'block', padding: '12px 16px' }}>
            <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
              No channels have been shared with your account yet. Contact the admin to
              request access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  let totalChannels = 0;
  for (const [, coll] of entries) {
    totalChannels += (coll.source_channels || []).length;
  }
  const subtitle = `${totalChannels} source channel${totalChannels !== 1 ? 's' : ''} across ${entries.length} collection${entries.length !== 1 ? 's' : ''}`;

  return (
    <div id="sys-user-channels">
      <div className="ch-val-card">
        <div
          className="ch-val-header"
          style={{ cursor: 'pointer' }}
          onClick={() => setOpen((v) => !v)}
        >
          <div className="ch-val-title">
            <span className="ch-val-toggle-icon" id="user-ch-toggle-icon">
              {open ? '▼' : '▶'}
            </span>
            <h3>📡 Subscribed Channels</h3>
            <span
              className="text-muted"
              style={{ fontSize: '0.8rem', marginLeft: 8 }}
            >
              {subtitle}
            </span>
          </div>
        </div>
        {open && (
          <div className="ch-val-body" id="user-ch-body" style={{ display: 'block' }}>
            {entries.map(([collName, coll]) => {
              const sources = coll.source_channels || [];
              const enabled = coll.enabled !== false;
              return (
                <div className="ch-val-collection" key={collName}>
                  <div
                    className="ch-val-collection-name"
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    📦 {collName}{' '}
                    <span className={`ch-val-badge ${enabled ? 'ok' : 'warn'}`}>
                      ● {enabled ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <div
                    style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap' }}
                  >
                    {sources.length === 0 ? (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        No source channels
                      </span>
                    ) : (
                      sources.map((ch, i) => {
                        const display = formatChannel(ch);
                        return (
                          <span
                            key={`${ch}-${i}`}
                            className="ch-val-badge info"
                            style={{ margin: '2px 4px 2px 0' }}
                          >
                            {display}
                          </span>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatChannel(ch) {
  const s = String(ch);
  if (s.startsWith('@')) return s;
  if (s.startsWith('-')) return s;
  return `@${s}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTube Monitor overview (legacy renderYoutubeOverview)

function YoutubeOverview() {
  const { data, isLoading } = useQuery({
    queryKey: ['yt-overview'],
    queryFn: () => api('/api/youtube/overview'),
  });

  if (isLoading) {
    return (
      <div id="system-yt-overview">
        <p className="text-muted">Loading…</p>
      </div>
    );
  }

  if (!data || data.status !== 'ok') {
    return (
      <div id="system-yt-overview">
        <p className="text-muted">YouTube Monitor not available</p>
      </div>
    );
  }

  const ch = data.channels || {};
  const kw = data.keywords || {};
  const q = data.queue || {};
  const today = data.today || {};
  const totalSummaries = data.summaries_total || 0;

  return (
    <div id="system-yt-overview">
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <YtStat
          icon="📡"
          value={ch.total || 0}
          label="Channels"
          sub={<SubLine on={ch.active || 0} total={ch.total || 0} />}
        />
        <YtStat
          icon="🔑"
          value={kw.total || 0}
          label="SEOs"
          sub={<SubLine on={kw.active || 0} total={kw.total || 0} />}
        />
        <YtStat
          icon="📄"
          value={totalSummaries}
          label="Summaries"
          sub={`${today.done_today || 0} today`}
        />
        <YtStat
          icon="📥"
          value={q.done || 0}
          label="Queue Done"
          sub={<QueueSub q={q} />}
        />
      </div>
      <div style={{ textAlign: 'right' }}>
        <Link to="/yt-videos" className="btn btn-primary btn-sm">
          Open YouTube Monitor →
        </Link>
      </div>
    </div>
  );
}

function YtStat({ icon, value, label, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">{icon}</div>
      <div className="stat-content">
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
        <div className="stat-sub">{sub}</div>
      </div>
    </div>
  );
}

function SubLine({ on, total }) {
  const off = total - on;
  if (total === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  if (off > 0) {
    return (
      <>
        <span style={{ color: 'var(--success)' }}>{on} on</span>
        {' / '}
        <span style={{ color: 'var(--danger)' }}>{off} off</span>
      </>
    );
  }
  return <span style={{ color: 'var(--success)' }}>all active</span>;
}

function QueueSub({ q }) {
  const parts = [];
  if (q.pending) {
    parts.push(
      <span key="p" style={{ color: 'var(--warning)' }}>
        {q.pending} pending
      </span>
    );
  }
  if (q.processing) {
    parts.push(
      <span key="i" style={{ color: 'var(--info)' }}>
        {q.processing} in progress
      </span>
    );
  }
  if (q.failed) {
    parts.push(
      <span key="f" style={{ color: 'var(--danger)' }}>
        {q.failed} failed
      </span>
    );
  }
  if (parts.length === 0) {
    return <span style={{ color: 'var(--success)' }}>all clear</span>;
  }
  return (
    <>
      {parts.map((node, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {node}
        </span>
      ))}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats aggregator (legacy updateStats)

function computeStats(bots, collections) {
  const totalBots = Object.keys(bots).length;
  let activeBots = 0;
  for (const b of Object.values(bots)) if (b.enabled !== false) activeBots++;

  const totalColls = Object.keys(collections).length;
  let enabledColls = 0;
  for (const c of Object.values(collections)) if (c.enabled !== false) enabledColls++;

  let totalCats = 0;
  let enabledCats = 0;
  let totalTopics = 0;
  let enabledTopics = 0;
  for (const bot of Object.values(bots)) {
    const cats = bot.categories || {};
    for (const cat of Object.values(cats)) {
      totalCats++;
      if (cat.enabled !== false) enabledCats++;
      const topics = cat.topics || {};
      for (const t of Object.values(topics)) {
        totalTopics++;
        if (t.enabled !== false) enabledTopics++;
      }
    }
  }

  return {
    totalBots,
    activeBots,
    totalColls,
    enabledColls,
    totalCats,
    enabledCats,
    totalTopics,
    enabledTopics,
  };
}
