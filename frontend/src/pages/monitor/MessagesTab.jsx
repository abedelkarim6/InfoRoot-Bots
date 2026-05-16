/**
 * Messages tab — recent received messages with collection→channel grouping
 * (default) or flat-table view (toggle).
 *
 * Pagination: load 50 at a time, accumulating into a single in-component list
 * so filters apply across all loaded pages. The text search is server-side —
 * it spans the whole DB and the matches are re-paginated, instead of just
 * hiding non-matching rows on the pages already loaded.
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

  // Filters — URL-backed
  const [selColls, setSelColls] = useUrlSet('coll');
  const [selChannels, setSelChannels] = useUrlSet('ch');
  const [selTopics, setSelTopics] = useUrlSet('topic');
  const [search, setSearch] = useUrlString('q', '');
  const [searchInput, setSearchInput] = useState(search);
  const [dateFrom, setDateFrom] = useUrlString('from', '');
  const [dateTo, setDateTo] = useUrlString('to', '');

  const debouncedSetSearch = useMemo(() => debounce((v) => setSearch(v), 220), []);

  // Keep the latest search term reachable from the interval callback (which is
  // set up once and would otherwise close over a stale value).
  const searchRef = useRef(search);
  searchRef.current = search;

  // Reload page 1 from the server whenever the (debounced) search term changes.
  // Search is server-side so it scans the whole DB and the matches re-paginate.
  useEffect(() => {
    loadPage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // 30s silent refresh of the first page.
  useEffect(() => {
    const id = setInterval(() => silentRefresh(), 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function messagesUrl(off) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off) });
    const q = searchRef.current.trim();
    if (q) params.set('search', q);
    return `/api/monitor/messages?${params.toString()}`;
  }

  async function loadPage(append) {
    setLoading(true);
    setError(null);
    const res = await api(messagesUrl(append ? offset : 0));
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
    const res = await api(messagesUrl(0));
    if (res?.status !== 'ok') return;
    const newMsgs = res.messages || [];
    if (!newMsgs.length) return;
    setMessages((prev) => {
      if (prev.length && newMsgs[0]?.id === prev[0]?.id) return prev;
      setOffset(newMsgs.length);
      setHasMore(newMsgs.length === PAGE_SIZE);
      return newMsgs;
    });
  }

  // Dynamic dropdown values from loaded messages.
  const allColls = useMemo(
    () => uniqueSorted(messages.map((m) => m.collection).filter(Boolean)),
    [messages]
  );
  const allChannels = useMemo(
    () =>
      uniqueSorted(
        messages
          .map((m) => (m.channel_username ? `@${m.channel_username}` : null))
          .filter(Boolean)
      ),
    [messages]
  );
  const allTopics = useMemo(
    () =>
      uniqueSorted(
        messages.flatMap((m) =>
          (m.topics || '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        )
      ),
    [messages]
  );

  const filtered = useMemo(() => {
    let out = messages;
    if (selColls.size) out = out.filter((m) => selColls.has(m.collection || ''));
    if (selChannels.size) out = out.filter((m) => selChannels.has(`@${m.channel_username}`));
    if (selTopics.size)
      out = out.filter((m) =>
        (m.topics || '')
          .split(',')
          .map((t) => t.trim())
          .some((t) => selTopics.has(t))
      );
    // Text search is applied server-side (see loadPage) so it spans the whole
    // DB — not just loaded pages — and is not re-filtered here.
    if (dateFrom) out = out.filter((m) => m.timestamp && m.timestamp.slice(0, 10) >= dateFrom);
    if (dateTo) out = out.filter((m) => m.timestamp && m.timestamp.slice(0, 10) <= dateTo);
    return out;
  }, [messages, selColls, selChannels, selTopics, dateFrom, dateTo]);

  return (
    <>
      <div className="mon-filter-bar">
        <MultiSelect
          label="All Collections"
          values={allColls}
          selected={selColls}
          onChange={setSelColls}
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

      {!error && !loading && !filtered.length && (
        <p className="mon-empty">
          {search.trim()
            ? 'No messages match your search.'
            : messages.length
            ? 'No messages match the filters.'
            : 'No messages in DB yet.'}
        </p>
      )}

      {!error && filtered.length > 0 && (
        <>
          {flatView ? (
            <FlatTable messages={filtered} />
          ) : (
            <GroupedView messages={filtered} />
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
            const res = downloadCsv('messages', filtered, keys);
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
                  <td className="mon-ellipsis" title={m.preview || ''}>
                    {m.preview || ''}
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
                        <td className="mon-ellipsis" title={m.preview || ''}>
                          {m.preview || ''}
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
