/**
 * TelegramChannelsTab — Figma "Telegram Sources" / "Telegram Destinations"
 * tab on the bot detail page. Replaces the old BotChannelsModal flow with a
 * full table view:
 *
 *   [All | Channels | Groups | Super Groups]      [Search] [Sort by ▾] [Filter]
 *   Source | Type | Members Count | Status | Action           (sources)
 *   Source | Type | Telegram Sources | Footer Settings | Status | Action  (dest)
 *
 * Every dialog the userbot can see is a row. Rows already configured on this
 * axis show a green status + trash action; rows configured on the OTHER axis
 * show an amber "Enabled as …" status (a channel can't be both); everything
 * else shows a violet "+" to add it. Add/remove persists immediately via
 * POST /api/collection/save (the bot's auto-collection, named after the bot).
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import Icon from '../../components/icons';

const PAGE_SIZE = 10;

const TYPE_TABS = [
  { id: 'all', label: 'All' },
  { id: 'channel', label: 'Channels' },
  { id: 'group', label: 'Groups' },
  { id: 'supergroup', label: 'Super Groups' }
];

function dialogType(d) {
  if (d.is_broadcast) return 'channel';
  if (d.is_megagroup) return 'supergroup';
  return 'group';
}

const TYPE_LABEL = { channel: 'Channel', group: 'Group', supergroup: 'Super Group' };

function normalize(v) {
  return String(v ?? '').replace(/^@/, '').toLowerCase();
}

function dialogValue(d) {
  return d.username ? '@' + d.username : String(d.id);
}

function dialogMatches(d, set) {
  return (d.username && set.has(d.username.toLowerCase())) || set.has(String(d.id));
}

function fmtCount(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

export default function TelegramChannelsTab({ botName, bot, kind, sources, targets }) {
  const isSource = kind === 'source';
  const { showNotification } = useDialogs();

  const [dialogs, setDialogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [typeTab, setTypeTab] = useState('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    let alive = true;
    api('/api/telegram/userbot/dialogs').then((res) => {
      if (!alive) return;
      setLoading(false);
      if (res?.status === 'ok') setDialogs(res.channels || []);
      else if (res?.status === 'no_session') setLoadError('No Telegram session linked — connect Telegram in your Profile first.');
      else setLoadError(res?.message || 'Failed to load Telegram channels');
    });
    return () => { alive = false; };
  }, []);

  // Membership sets for this axis and the other axis.
  const mineSet = useMemo(
    () => new Set((isSource ? sources : targets).map(normalize)),
    [isSource, sources, targets]
  );
  const otherSet = useMemo(
    () => new Set((isSource ? targets : sources).map(normalize)),
    [isSource, sources, targets]
  );

  const saveCollection = useApiMutation('/api/collection/save', {
    invalidate: ['config'],
    errorMsg: 'Failed to save'
  });

  async function persist(nextMine) {
    const other = isSource ? targets : sources;
    const payload = {
      collection_name: botName,
      enabled: true,
      source_channels: isSource ? nextMine : other,
      target_channels: isSource ? other : nextMine
    };
    const res = await new Promise((resolve) => {
      saveCollection.mutate(payload, { onSuccess: resolve, onError: resolve });
    });
    if (res?.status === 'error') return false;
    // Make sure the bot references its auto-collection.
    const currentCols = Array.isArray(bot?.collections) ? bot.collections : [];
    if (!currentCols.includes(botName)) {
      await api('/api/bot/save', {
        name: botName,
        enabled: !!bot.enabled,
        collections: [botName],
        minimum_messages: bot.minimum_messages ?? 5,
        rules: bot.rules || { remove: [], replace: [] },
        default_schedules: bot.default_schedules || [],
        categories: bot.categories || {}
      }).catch(() => {});
    }
    return true;
  }

  async function addDialog(d) {
    const mine = isSource ? sources : targets;
    const value = dialogValue(d);
    if (mine.some((c) => normalize(c) === normalize(value))) return;
    const ok = await persist([...mine, value]);
    if (ok) showNotification(`"${d.title}" added`, 'success');
  }

  async function removeDialog(d) {
    const mine = isSource ? sources : targets;
    const next = mine.filter((c) => normalize(c) !== normalize(dialogValue(d)) &&
      !(d.username && normalize(c) === d.username.toLowerCase()) &&
      normalize(c) !== String(d.id));
    const ok = await persist(next);
    if (ok) showNotification(`"${d.title}" removed`, 'success');
  }

  // Manually-configured channels (e.g. by @username) that aren't among the
  // userbot's dialogs still need a row so they can be removed.
  const orphanRows = useMemo(() => {
    const mine = isSource ? sources : targets;
    return mine
      .filter((c) => !dialogs.some((d) => dialogMatches(d, new Set([normalize(c)]))))
      .filter((c) => !dialogs.some((d) =>
        (d.username && d.username.toLowerCase() === normalize(c)) || String(d.id) === normalize(c)))
      .map((c) => ({
        id: `manual:${c}`,
        title: c,
        username: null,
        manual: true,
        participants_count: null
      }));
  }, [dialogs, isSource, sources, targets]);

  // Destinations only list dialogs the userbot can post to.
  const baseRows = useMemo(() => {
    const base = isSource ? dialogs : dialogs.filter((d) => d.can_post);
    return [...orphanRows, ...base];
  }, [dialogs, isSource, orphanRows]);

  const filtered = useMemo(() => {
    let rows = baseRows;
    if (typeTab !== 'all') rows = rows.filter((d) => !d.manual && dialogType(d) === typeTab);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          (d.username && d.username.toLowerCase().includes(q))
      );
    }
    // Configured rows first (matches the Figma ordering), then by sort key.
    const status = (d) => (d.manual || dialogMatches(d, mineSet) ? 0 : dialogMatches(d, otherSet) ? 1 : 2);
    rows = [...rows].sort((a, b) => {
      const s = status(a) - status(b);
      if (s !== 0) return s;
      if (sortBy === 'name') return a.title.localeCompare(b.title);
      if (sortBy === 'members') return (b.participants_count || 0) - (a.participants_count || 0);
      return 0;
    });
    return rows;
  }, [baseRows, typeTab, search, sortBy, mineSet, otherSet]);

  // Clamp page when the filter shrinks the set.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [typeTab, search, sortBy]);

  const title = isSource ? 'Telegram Sources' : 'Telegram Destinations';
  const subtitle = isSource
    ? 'Your Telegram groups and channels, add them as sources to start forwarding messages'
    : 'Channels this bot sends its summaries to';

  return (
    <div className="tg-tab">
      <div className="tg-tab-head">
        <h4 className="tg-tab-title">{title}</h4>
        <p className="tg-tab-subtitle">{subtitle}</p>
      </div>

      <div className="tg-toolbar">
        <div className="tg-type-tabs">
          {TYPE_TABS.map((t) => (
            <button
              key={t.id}
              className={`tg-type-tab${typeTab === t.id ? ' active' : ''}`}
              onClick={() => setTypeTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="tg-toolbar-right">
          <div className="tg-search">
            <Icon name="search" size={14} />
            <input
              type="text"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="input tg-sort"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="">Sort by</option>
            <option value="name">Name</option>
            <option value="members">Members</option>
          </select>
        </div>
      </div>

      {loading && <p className="text-muted" style={{ padding: 20 }}>Loading Telegram channels…</p>}
      {loadError && <p className="text-muted" style={{ padding: 20 }}>{loadError}</p>}

      {!loading && !loadError && (
        <>
          <div className="tg-table-wrap">
            <table className="tg-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Type</th>
                  {isSource ? (
                    <th>Members Count</th>
                  ) : (
                    <>
                      <th>Telegram Sources</th>
                      <th>Footer Settings</th>
                    </>
                  )}
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={isSource ? 5 : 6} className="text-muted" style={{ textAlign: 'center', padding: 24 }}>
                      No channels match.
                    </td>
                  </tr>
                )}
                {pageRows.map((d) => {
                  const inMine = d.manual || dialogMatches(d, mineSet);
                  const inOther = !inMine && dialogMatches(d, otherSet);
                  const type = d.manual ? null : dialogType(d);
                  return (
                    <tr key={d.id}>
                      <td>
                        <div className="tg-source-cell">
                          <span className="tg-source-title">{d.title}</span>
                          <span className="tg-source-user">{d.username ? '@' + d.username : d.manual ? 'manual entry' : '#' + d.id}</span>
                        </div>
                      </td>
                      <td>
                        {type ? (
                          <span className={`type-badge type-${type}`}>{TYPE_LABEL[type]}</span>
                        ) : (
                          <span className="type-badge">—</span>
                        )}
                      </td>
                      {isSource ? (
                        <td>{fmtCount(d.participants_count)}</td>
                      ) : (
                        <>
                          <td className="text-muted" style={{ fontSize: 13 }}>All Sources</td>
                          <td className="text-muted" style={{ fontSize: 13 }}>Using Defaults</td>
                        </>
                      )}
                      <td>
                        {inMine ? (
                          <span className="status-chip status-ok">{isSource ? 'Active' : 'Enabled'}</span>
                        ) : inOther ? (
                          <span className="status-chip status-warn">
                            Enabled as {isSource ? 'Destination' : 'Source'}
                          </span>
                        ) : (
                          <span className="status-chip status-neutral">Disabled</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {inMine ? (
                          <button
                            className="btn-icon btn-icon-danger"
                            title={`Remove from ${isSource ? 'sources' : 'destinations'}`}
                            disabled={saveCollection.isPending}
                            onClick={() => removeDialog(d)}
                          >
                            <Icon name="trash" size={15} />
                          </button>
                        ) : inOther ? null : (
                          <button
                            className="tg-add-btn"
                            title={`Add as ${isSource ? 'source' : 'destination'}`}
                            disabled={saveCollection.isPending}
                            onClick={() => addDialog(d)}
                          >
                            <Icon name="plus" size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />
          )}
        </>
      )}
    </div>
  );
}

function Pagination({ page, pageCount, onPage }) {
  // Figma: [‹ Previous]  1 2 3 4 5 … N  [Next ›]
  const nums = [];
  for (let i = 1; i <= pageCount; i++) {
    if (i <= 5 || i === pageCount || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return (
    <div className="tg-pagination">
      <button
        className="btn btn-secondary btn-sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <Icon name="chevronLeft" size={13} style={{ marginRight: 4 }} />
        Previous
      </button>
      <div className="tg-page-nums">
        {nums.map((n, i) =>
          n === '…' ? (
            <span key={`e${i}`} className="tg-page-ellipsis">…</span>
          ) : (
            <button
              key={n}
              className={`tg-page-num${n === page ? ' active' : ''}`}
              onClick={() => onPage(n)}
            >
              {n}
            </button>
          )
        )}
      </div>
      <button
        className="btn btn-secondary btn-sm"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        Next
        <Icon name="chevronRight" size={13} style={{ marginLeft: 4 }} />
      </button>
    </div>
  );
}
