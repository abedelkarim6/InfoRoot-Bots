/**
 * Messages tab — recent received messages with collection→channel grouping
 * (default) or flat-table view (toggle).
 *
 * All filters (bot, channel, topic, date range, text search) are applied
 * server-side. Each filter change reloads page 1 from the server and "Load
 * more" keeps paginating the *filtered* result set — so pagination always
 * covers the whole matching dataset, not just the pages already loaded.
 *
 * The filter dropdown options come from a one-shot /facets call so they list
 * every bot/channel/topic in the DB even though the visible rows are filtered.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, debounce, fmtLBN } from '../../lib/api';
import MultiSelect from './MultiSelect';
import ExportColumnsModal from './ExportColumnsModal';
import { splitTags } from './shared';
import { downloadCsv } from './exportCsv';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useUrlString, useUrlBool, useUrlSet } from '../../lib/useUrlState';

const PAGE_SIZE = 50;

export default function MessagesTab() {
  const { showAlert } = useDialogs();
  const [messages, setMessages] = useState([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [flatView, setFlatView] = useUrlBool('flat');
  const [showExport, setShowExport] = useState(false);
  const [facets, setFacets] = useState({ bots: [], channels: [], topics: [] });

  // Filters — URL-backed
  const [selBots, setSelBots] = useUrlSet('bot');
  const [selChannels, setSelChannels] = useUrlSet('ch');
  const [selTopics, setSelTopics] = useUrlSet('topic');
  const [search, setSearch] = useUrlString('q', '');
  const [searchInput, setSearchInput] = useState(search);
  const [dateFrom, setDateFrom] = useUrlString('from', '');
  const [dateTo, setDateTo] = useUrlString('to', '');

  const debouncedSetSearch = useMemo(() => debounce((v) => setSearch(v), 220), []);

  // Latest filters reachable from callbacks (the 30s interval and "Load more")
  // which would otherwise close over stale values.
  const filtersRef = useRef({});
  filtersRef.current = { search, selBots, selChannels, selTopics, dateFrom, dateTo };

  // Guards against out-of-order responses when filters change rapidly: only the
  // newest loadPage result is applied.
  const reqSeq = useRef(0);

  // Reload page 1 whenever any filter changes. Every filter is server-side now,
  // so the matches re-paginate across the whole DB instead of just hiding rows
  // on already-loaded pages.
  useEffect(() => {
    loadPage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selBots, selChannels, selTopics, dateFrom, dateTo]);

  // Filter dropdown options — fetched once so they list every bot/channel/topic
  // even though the visible rows are filtered server-side.
  useEffect(() => {
    (async () => {
      const res = await api('/api/monitor/messages/facets');
      if (res?.status === 'ok') {
        setFacets({
          bots: res.bots || [],
          channels: res.channels || [],
          topics: res.topics || []
        });
      }
    })();
  }, []);

  // 30s silent refresh of the first page (respecting the active filters).
  useEffect(() => {
    const id = setInterval(() => silentRefresh(), 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildUrl(off) {
    const f = filtersRef.current;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off) });
    const q = (f.search || '').trim();
    if (q) params.set('search', q);
    if (f.selBots.size) params.set('bots', [...f.selBots].join(','));
    if (f.selChannels.size) params.set('channels', [...f.selChannels].join(','));
    if (f.selTopics.size) params.set('topics', [...f.selTopics].join(','));
    if (f.dateFrom) params.set('date_from', f.dateFrom);
    if (f.dateTo) params.set('date_to', f.dateTo);
    return `/api/monitor/messages?${params.toString()}`;
  }

  async function loadPage(append) {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    const res = await api(buildUrl(append ? offset : 0));
    if (seq !== reqSeq.current) return; // superseded by a newer request
    if (res.status !== 'ok') {
      setError(res.message || 'Unknown error');
      setLoading(false);
      return;
    }
    const newMsgs = res.messages || [];
    const next = append ? [...messages, ...newMsgs] : newMsgs;
    setMessages(next);
    setOffset(next.length);
    setHasMore(newMsgs.length === PAGE_SIZE);
    setLoading(false);
  }

  async function silentRefresh() {
    const seq = reqSeq.current;
    const res = await api(buildUrl(0));
    if (res?.status !== 'ok') return;
    if (seq !== reqSeq.current) return; // a loadPage started after us — defer
    const newMsgs = res.messages || [];
    if (!newMsgs.length) return;
    setMessages((prev) => {
      if (prev.length && newMsgs[0]?.id === prev[0]?.id) return prev;
      setOffset(newMsgs.length);
      setHasMore(newMsgs.length === PAGE_SIZE);
      return newMsgs;
    });
  }

  // Dropdown options: full facet universe unioned with anything in the loaded
  // rows (covers brand-new values that appeared since the facets were fetched).
  // Bots come from facets only (which lists currently-existing bots). We don't
  // union loaded-row bot_names here because the messages table keeps rows from
  // since-deleted bots, which would otherwise reappear in the filter.
  const allBots = useMemo(() => uniqueSorted(facets.bots), [facets]);
  const allChannels = useMemo(
    () =>
      uniqueSorted([
        ...facets.channels.map((c) => `@${c}`),
        ...messages
          .map((m) => (m.channel_username ? `@${m.channel_username}` : null))
          .filter(Boolean)
      ]),
    [facets, messages]
  );
  const allTopics = useMemo(
    () =>
      uniqueSorted([
        ...facets.topics,
        ...messages.flatMap((m) =>
          (m.topics || '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        )
      ]),
    [facets, messages]
  );

  // All filtering is server-side now; the loaded rows are already the result set.
  const anyFilter =
    !!search.trim() ||
    selBots.size > 0 ||
    selChannels.size > 0 ||
    selTopics.size > 0 ||
    !!dateFrom ||
    !!dateTo;

  return (
    <>
      <div className="mon-filter-bar">
        <MultiSelect
          label="All Bots"
          values={allBots}
          selected={selBots}
          onChange={setSelBots}
        />
        <MultiSelect
          label="All Channels"
          values={allChannels}
          selected={selChannels}
          onChange={setSelChannels}
        />
        <MultiSelect
          label="All Topics"
          values={allTopics}
          selected={selTopics}
          onChange={setSelTopics}
        />
        <input
          type="text"
          className="input mon-filter-search"
          placeholder="🔍 Search preview…"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            debouncedSetSearch(e.target.value);
          }}
        />
        <input
          type="date"
          className="input"
          style={{ maxWidth: 145 }}
          title="From date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
        />
        <input
          type="date"
          className="input"
          style={{ maxWidth: 145 }}
          title="To date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
        />
        <button
          className={`btn btn-sm ${flatView ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setFlatView((v) => !v)}
          title="Show all messages flat (latest first), no grouping"
        >
          ≡ Flat
        </button>
        <button
          className="btn btn-secondary btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowExport(true)}
          title="Export visible rows to CSV"
        >
          ⬇ Export
        </button>
      </div>

      {error && (
        <p className="mon-empty" style={{ color: 'var(--danger)' }}>
          Error: {error}
        </p>
      )}
      {loading && !messages.length && <p className="mon-empty">Loading…</p>}

      {!error && !loading && !messages.length && (
        <p className="mon-empty">
          {anyFilter ? 'No messages match the filters.' : 'No messages in DB yet.'}
        </p>
      )}

      {!error && messages.length > 0 && (
        <>
          {flatView ? (
            <FlatTable messages={messages} />
          ) : (
            <GroupedView messages={messages} />
          )}

          {hasMore ? (
            <div style={{ textAlign: 'center', padding: 16 }}>
              <button
                className="btn btn-secondary"
                onClick={() => loadPage(true)}
                disabled={loading}
              >
                Load more messages…
              </button>
              <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>
                {messages.length} loaded
              </span>
            </div>
          ) : messages.length > PAGE_SIZE ? (
            <p
              className="text-muted"
              style={{ textAlign: 'center', padding: 8, fontSize: 12 }}
            >
              All {messages.length} messages loaded
            </p>
          ) : null}
        </>
      )}

      {showExport && (
        <ExportColumnsModal
          tabName="messages"
          onClose={() => setShowExport(false)}
          onConfirm={(keys) => {
            const res = downloadCsv('messages', messages, keys);
            setShowExport(false);
            if (!res.ok) showAlert(res.reason, { title: 'Export', icon: '⚠️' });
          }}
        />
      )}
    </>
  );
}

function FlatTable({ messages }) {
  const sorted = useMemo(
    () => [...messages].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')),
    [messages]
  );
  return (
    <>
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 8,
          padding: '0 4px'
        }}
      >
        {sorted.length} message{sorted.length === 1 ? '' : 's'}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="mon-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Source</th>
              <th>Collection</th>
              <th>Topics</th>
              <th>Categories</th>
              <th>Keywords</th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((m, i) => {
              const ch = m.channel_username ? `@${m.channel_username}` : `id:${m.channel_id}`;
              return (
                <tr key={m.id ?? i}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{fmtLBN(m.timestamp)}</td>
                  <td>{ch}</td>
                  <td>{m.collection || '—'}</td>
                  <td>
                    <Tags value={m.topics} cls="topic" />
                  </td>
                  <td>
                    <Tags value={m.categories} cls="cat" />
                  </td>
                  <td>
                    <Tags value={m.keywords_found} />
                  </td>
                  <td title={m.preview || ''}>
                    <div className="mon-ellipsis">{m.preview || ''}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GroupedView({ messages }) {
  const grouped = useMemo(() => {
    const out = {};
    for (const msg of messages) {
      const c = msg.collection || '—';
      const ch = msg.channel_username ? `@${msg.channel_username}` : `id:${msg.channel_id}`;
      if (!out[c]) out[c] = {};
      if (!out[c][ch]) out[c][ch] = [];
      out[c][ch].push(msg);
    }
    return out;
  }, [messages]);

  return (
    <>
      {Object.entries(grouped).map(([collName, channels]) => (
        <div key={collName}>
          <div className="mon-coll-hdr">📦 {collName}</div>
          {Object.entries(channels).map(([chName, msgs]) => (
            <div key={chName}>
              <div className="mon-ch-hdr">
                📢 {chName} <span className="text-muted">({msgs.length})</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="mon-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Topics</th>
                      <th>Categories</th>
                      <th>Keywords</th>
                      <th>Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {msgs.map((m, i) => (
                      <tr key={m.id ?? i}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>
                          {fmtLBN(m.timestamp)}
                        </td>
                        <td>
                          <Tags value={m.topics} cls="topic" />
                        </td>
                        <td>
                          <Tags value={m.categories} cls="cat" />
                        </td>
                        <td>
                          <Tags value={m.keywords_found} />
                        </td>
                        <td title={m.preview || ''}>
                          <div className="mon-ellipsis">{m.preview || ''}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function Tags({ value, cls }) {
  const tags = splitTags(value);
  if (!tags) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <>
      {tags.map((t, i) => (
        <span key={i} className={`mon-tag${cls ? ' ' + cls : ''}`}>
          {t}
        </span>
      ))}
    </>
  );
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}
