/**
 * Unclassified tab — messages that arrived but matched no keyword.
 *
 * 3 view modes (mutually exclusive):
 *   - by-channel  (default): collection → channel → messages
 *   - by-words:   "Group by words" — extract common words, group accordingly
 *   - flat:       latest-first table, no grouping
 *
 * Plus a per-tab "Clear view" feature: stores `mon-uncl-cleared-at` in
 * localStorage; messages older than that timestamp are hidden from the view
 * (the row is still in the DB and the badge respects the cutoff via `since`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtLBN } from '../../lib/api';
import MultiSelect from './MultiSelect';
import ExportColumnsModal from './ExportColumnsModal';
import { extractCommonWords } from './shared';
import { downloadCsv } from './exportCsv';
import { useDialogs } from '../../dialogs/DialogsProvider';

const PAGE_SIZE = 50;
const STORAGE_KEY = 'mon-uncl-cleared-at';

export default function UnclassifiedTab() {
  const { showAlert } = useDialogs();
  const [messages, setMessages] = useState([]);
  const [stats, setStats] = useState([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [view, setView] = useState('channel'); // 'channel' | 'words' | 'flat'
  const [showExport, setShowExport] = useState(false);

  // Filters
  const [selBots, setSelBots] = useState(() => new Set());
  const [selColls, setSelColls] = useState(() => new Set());
  const [selChannels, setSelChannels] = useState(() => new Set());
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [clearedAt, setClearedAt] = useState(() => localStorage.getItem(STORAGE_KEY) || null);
  const initialized = useRef(false);

  useEffect(() => {
    loadPage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, clearedAt]);

  async function loadPage(append) {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(append ? offset : 0)
    });
    if (search.trim()) params.set('search', search.trim());
    if (clearedAt) params.set('since', clearedAt);
    const res = await api(`/api/monitor/unclassified?${params.toString()}`);
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
    setStats(res.stats || []);

    if (!append) {
      // Reset filters that should match new data only on first load.
      if (!initialized.current) {
        initialized.current = true;
      }
    }
    setLoading(false);
  }

  // Initial bot/collection filter values come from the stats payload (matches
  // legacy behaviour). Channels come from currently loaded messages.
  const allBots = useMemo(
    () => uniqueSorted((stats || []).map((s) => s.bot_name).filter(Boolean)),
    [stats]
  );
  const allColls = useMemo(
    () => uniqueSorted((stats || []).map((s) => s.collection_name).filter(Boolean)),
    [stats]
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

  const filtered = useMemo(() => {
    const cutMs = clearedAt ? new Date(clearedAt).getTime() : null;
    let out = cutMs
      ? messages.filter((m) => m.timestamp && new Date(m.timestamp).getTime() > cutMs)
      : messages;
    if (selBots.size) out = out.filter((m) => selBots.has(m.bot_name || ''));
    if (selColls.size) out = out.filter((m) => selColls.has(m.collection_name || ''));
    if (selChannels.size)
      out = out.filter((m) => selChannels.has(`@${m.channel_username}`));
    if (dateFrom) out = out.filter((m) => m.timestamp && m.timestamp.slice(0, 10) >= dateFrom);
    if (dateTo) out = out.filter((m) => m.timestamp && m.timestamp.slice(0, 10) <= dateTo);
    return out;
  }, [messages, clearedAt, selBots, selColls, selChannels, dateFrom, dateTo]);

  function clearView() {
    const ts = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, ts);
    setClearedAt(ts);
  }

  function showAll() {
    localStorage.removeItem(STORAGE_KEY);
    setClearedAt(null);
  }

  return (
    <>
      <div className="mon-filter-bar">
        <MultiSelect label="All Bots" values={allBots} selected={selBots} onChange={setSelBots} />
        <MultiSelect
          label="All Collections"
          values={allColls}
          selected={selColls}
          onChange={setSelColls}
        />
        <MultiSelect
          label="All Sources"
          values={allChannels}
          selected={selChannels}
          onChange={setSelChannels}
        />
        <input
          type="text"
          className="input mon-filter-search"
          placeholder="🔍 Search text…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSearch(searchInput);
          }}
        />
        <button className="btn btn-secondary btn-sm" onClick={() => setSearch(searchInput)}>
          Search
        </button>
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
          className={`btn btn-sm ${view === 'flat' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView(view === 'flat' ? 'channel' : 'flat')}
          title="Show all messages flat (latest first), no grouping"
        >
          ≡ Flat
        </button>
        <button
          className={`btn btn-sm ${view === 'words' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setView(view === 'words' ? 'channel' : 'words')}
        >
          🔤 Group by words
        </button>
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => setShowExport(true)}
          title="Export visible rows to CSV"
        >
          ⬇ Export
        </button>
        <button
          className="btn btn-sm btn-secondary"
          onClick={clearView}
          style={{ marginLeft: 'auto' }}
          title="Hide current messages from view (still in DB)"
        >
          ✕ Clear view
        </button>
        {clearedAt && (
          <button
            className="btn btn-sm btn-secondary"
            onClick={showAll}
            title="Show previously cleared messages"
          >
            ↩ Show all
          </button>
        )}
      </div>

      {stats.length > 0 && (
        <div className="mon-uncl-stats-bar">
          {stats.map((s, i) => (
            <span key={i} className="yt-filter-tag">
              {s.bot_name || '?'} / {s.collection_name || '?'}: <strong>{s.cnt}</strong>
            </span>
          ))}
        </div>
      )}

      {error && (
        <p className="mon-empty" style={{ color: 'var(--danger)' }}>
          Error: {error}
        </p>
      )}
      {loading && !messages.length && <p className="mon-empty">Loading…</p>}

      {!error && !loading && !filtered.length && (
        <p className="mon-empty">
          {clearedAt ? (
            <>
              No new unclassified messages since last clear.{' '}
              <button className="btn btn-sm btn-secondary" onClick={showAll}>
                Show all
              </button>
            </>
          ) : (
            'No unclassified messages found.'
          )}
        </p>
      )}

      {!error && filtered.length > 0 && (
        <>
          {view === 'flat' && <UnclFlat messages={filtered} />}
          {view === 'channel' && <UnclByChannel messages={filtered} />}
          {view === 'words' && <UnclByWords messages={filtered} />}

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
          tabName="unclassified"
          onClose={() => setShowExport(false)}
          onConfirm={(keys) => {
            const res = downloadCsv('unclassified', filtered, keys);
            setShowExport(false);
            if (!res.ok) showAlert(res.reason, { title: 'Export', icon: '⚠️' });
          }}
        />
      )}
    </>
  );
}

function UnclFlat({ messages }) {
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
              <th>Bot</th>
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
                  <td>{m.collection_name || '—'}</td>
                  <td>
                    {m.bot_name ? <span className="mon-tag cat">{m.bot_name}</span> : '—'}
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

function UnclByChannel({ messages }) {
  const grouped = useMemo(() => {
    const out = {};
    for (const msg of messages) {
      const c = msg.collection_name || '—';
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
                      <th>Bot</th>
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
                          {m.bot_name ? (
                            <span className="mon-tag cat">{m.bot_name}</span>
                          ) : (
                            '—'
                          )}
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

function UnclByWords({ messages }) {
  const { groups, unassigned } = useMemo(() => {
    const commonWords = extractCommonWords(messages);
    const wordGroups = {};
    const assigned = new Set();
    for (const [word] of commonWords) wordGroups[word] = [];
    for (const m of messages) {
      const text = (m.preview || '').toLowerCase();
      for (const [word] of commonWords) {
        if (text.includes(word)) {
          wordGroups[word].push(m);
          assigned.add(m.id);
          break;
        }
      }
    }
    const groupsArr = commonWords
      .filter(([w]) => wordGroups[w].length > 0)
      .map(([word]) => ({ word, msgs: wordGroups[word] }));
    const unassignedMsgs = messages.filter((m) => !assigned.has(m.id));
    return { groups: groupsArr, unassigned: unassignedMsgs };
  }, [messages]);

  if (!groups.length && !unassigned.length) {
    return <p className="mon-empty">No common words found across messages.</p>;
  }

  return (
    <div className="uncl-word-groups">
      {groups.map(({ word, msgs }) => (
        <WordGroup key={word} word={word} messages={msgs} highlightWord={word} />
      ))}
      {unassigned.length > 0 && (
        <WordGroup word={null} messages={unassigned} highlightWord={null} />
      )}
    </div>
  );
}

function WordGroup({ word, messages, highlightWord }) {
  const [open, setOpen] = useState(true);
  const re = highlightWord
    ? new RegExp(`(${highlightWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    : null;
  return (
    <div className="uncl-word-group">
      <div className="uncl-word-hdr" onClick={() => setOpen((v) => !v)}>
        <span
          className="uncl-word-label"
          style={word == null ? { color: 'var(--text-muted)' } : undefined}
        >
          {word == null ? 'Other (no common word)' : `"${word}"`}
        </span>
        <span className="uncl-word-count">{messages.length} messages</span>
      </div>
      {open && (
        <div style={{ overflowX: 'auto' }}>
          <table className="mon-table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>Time</th>
                <th style={{ width: 120 }}>Channel</th>
                <th>Message Preview</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m, i) => (
                <tr key={m.id ?? i}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{fmtLBN(m.timestamp)}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>
                    {m.channel_username ? `@${m.channel_username}` : ''}
                  </td>
                  <td className="mon-ellipsis" title={m.preview || ''}>
                    {re ? <Highlighted text={m.preview || ''} re={re} /> : m.preview || ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Highlighted({ text, re }) {
  const parts = [];
  let last = 0;
  let m;
  let key = 0;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    parts.push(<mark key={key++}>{m[0]}</mark>);
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++; // avoid infinite loop on empty matches
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return parts;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}
