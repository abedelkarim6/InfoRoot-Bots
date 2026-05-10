/**
 * Schedules tab — 24h timeline of upcoming schedule fires.
 *
 * Sources the same /api/monitor/data payload as the Summaries tab. Countdowns
 * tick once per second locally (no refetch); full data refreshes every 60s
 * via the parent's TanStack Query polling.
 *
 * Clicking the "pending" cell drills into pending messages — handled by the
 * parent (SchedulesTab → onShowPending(...)) so the parent can swap the
 * panel without needing global state in this component.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, fmtLBN } from '../../lib/api';
import MultiSelect from './MultiSelect';
import ExportColumnsModal from './ExportColumnsModal';
import {
  fmtBeirutDate,
  fmtBeirutTime,
  formatDuration,
  getUpcomingFires24h
} from './shared';
import { buildScheduleFireRows, downloadCsv } from './exportCsv';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useUrlString, useUrlSet } from '../../lib/useUrlState';

export default function SchedulesTab({ data, isLoading }) {
  const { showAlert } = useDialogs();
  const [selBots, setSelBots] = useUrlSet('sbot');
  const [selTopics, setSelTopics] = useUrlSet('stopic');
  const [selPrompts, setSelPrompts] = useUrlSet('sprompt');
  const [selTypes, setSelTypes] = useUrlSet('stype');
  // Pending drill-down is encoded as ?pending=bot::topic::type
  // The matching schedule object is looked up from `flat` at render time.
  const [pendingKey, setPendingKey] = useUrlString('pending', '');
  const [showExport, setShowExport] = useState(false);

  // Tick once per second so countdowns stay live without refetching the API.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Build the flat schedule list — recompute when the underlying data changes.
  const flat = useMemo(() => buildFlatSchedules(data?.bots || {}), [data]);

  const allBots = useMemo(() => uniqueSorted(flat.map((r) => r.botName)), [flat]);
  const allTopics = useMemo(() => uniqueSorted(flat.map((r) => r.topicName)), [flat]);
  const allPrompts = useMemo(
    () => uniqueSorted(flat.map((r) => r.sch.prompt_key).filter(Boolean)),
    [flat]
  );
  const allTypes = useMemo(
    () => uniqueSorted(flat.map((r) => r.sch.type).filter(Boolean)),
    [flat]
  );

  const enabledItems = useMemo(() => {
    let items = flat.filter(
      (r) => r.botEnabled !== false && r.topicEnabled !== false && r.sch.enabled !== false
    );
    if (selBots.size) items = items.filter((r) => selBots.has(r.botName));
    if (selTopics.size) items = items.filter((r) => selTopics.has(r.topicName));
    if (selPrompts.size) items = items.filter((r) => selPrompts.has(r.sch.prompt_key || ''));
    if (selTypes.size) items = items.filter((r) => selTypes.has(r.sch.type || ''));
    return items;
  }, [flat, selBots, selTopics, selPrompts, selTypes]);

  const fires = useMemo(() => {
    const out = [];
    for (const item of enabledItems) {
      getUpcomingFires24h(item.sch, nowMs).forEach((fireAt, idx) => {
        out.push({ fireAt, ...item, pending: idx === 0 ? item.pending : 0 });
      });
    }
    out.sort((a, b) => a.fireAt - b.fireAt);
    return out;
  }, [enabledItems, nowMs]);

  // If the user has drilled into pending messages, render that instead.
  // pendingKey shape: "botName::topicName::schedType". The full schedule
  // object is looked up from `flat` so refreshing the URL works (sch is
  // not stored in URL — only the keys to find it).
  let pending = null;
  if (pendingKey) {
    const [botName, topicName, schedType] = pendingKey.split('::');
    const match = flat.find(
      (r) =>
        r.botName === botName &&
        r.topicName === topicName &&
        r.sch.type === schedType
    );
    if (match) pending = { botName, topicName, schedType, sch: match.sch };
  }
  if (pending) {
    return (
      <PendingMessagesPanel
        botName={pending.botName}
        topicName={pending.topicName}
        schedType={pending.schedType}
        sch={pending.sch}
        onBack={() => setPendingKey('')}
      />
    );
  }
  // If pendingKey is set but no match (data not yet loaded, or schedule was
  // removed since the URL was bookmarked), fall through to the normal view.
  // We don't auto-clear the URL so a slow data fetch can still resolve it.

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
          label="All Topics"
          values={allTopics}
          selected={selTopics}
          onChange={setSelTopics}
        />
        <MultiSelect
          label="All Prompts"
          values={allPrompts}
          selected={selPrompts}
          onChange={setSelPrompts}
        />
        <MultiSelect
          label="All Types"
          values={allTypes}
          selected={selTypes}
          onChange={setSelTypes}
        />
        <button
          className="btn btn-secondary btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowExport(true)}
          title="Export next 24h schedule fires to CSV"
        >
          ⬇ Export
        </button>
      </div>

      {isLoading && !data ? (
        <p className="mon-empty">Loading…</p>
      ) : !enabledItems.length ? (
        <p className="mon-empty">No enabled schedules match the filter.</p>
      ) : !fires.length ? (
        <p className="mon-empty">No upcoming fires in the next 24 hours.</p>
      ) : (
        <ScheduleTimeline
          fires={fires}
          nowMs={nowMs}
          onShowPending={(p) => setPendingKey(`${p.botName}::${p.topicName}::${p.schedType}`)}
        />
      )}

      {showExport && (
        <ExportColumnsModal
          tabName="schedules_24h"
          onClose={() => setShowExport(false)}
          onConfirm={(keys) => {
            const rows = buildScheduleFireRows(enabledItems, nowMs);
            const res = downloadCsv('schedules_24h', rows, keys);
            setShowExport(false);
            if (!res.ok) showAlert(res.reason, { title: 'Export', icon: '⚠️' });
          }}
        />
      )}
    </>
  );
}

function ScheduleTimeline({ fires, nowMs, onShowPending }) {
  let lastDate = '';
  return (
    <div style={{ overflowX: 'auto', maxHeight: '75vh', overflowY: 'auto' }}>
      <table className="mon-table sch-timeline-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>In</th>
            <th>Bot</th>
            <th>Topic</th>
            <th>Type</th>
            <th>Schedule</th>
            <th>Pending</th>
          </tr>
        </thead>
        <tbody>
          {fires.map((row, i) => {
            const dateLabel = fmtBeirutDate(row.fireAt);
            const showSeparator = dateLabel !== lastDate;
            if (showSeparator) lastDate = dateLabel;
            const diff = row.fireAt - nowMs;
            const inText = diff <= 0 ? 'now' : formatDuration(diff);
            const inColor =
              diff <= 0
                ? 'var(--success,#22c55e)'
                : diff < 300000
                ? 'var(--danger)'
                : 'var(--text-muted)';
            const typeCls = row.sch.type || 'hourly';
            const hasPending = row.pending > 0;
            return (
              <Fragmentish key={`${row.fireAt}-${i}`}>
                {showSeparator && (
                  <tr className="sch-date-sep">
                    <td colSpan={7}>{dateLabel}</td>
                  </tr>
                )}
                <tr>
                  <td style={{ whiteSpace: 'nowrap', fontWeight: 600, fontSize: 13 }}>
                    {fmtBeirutTime(row.fireAt)}
                  </td>
                  <td
                    className="sch-in-cell"
                    style={{ whiteSpace: 'nowrap', fontSize: 12, color: inColor }}
                  >
                    {inText}
                  </td>
                  <td>{row.botName}</td>
                  <td>{row.topicName}</td>
                  <td>
                    <span className={`mon-type-badge ${typeCls}`}>{row.sch.type}</span>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {row.sch.name || '—'}
                  </td>
                  <td>
                    <span
                      className={`mon-pending ${hasPending ? 'has' : 'none'}`}
                      style={hasPending ? { cursor: 'pointer' } : undefined}
                      onClick={
                        hasPending
                          ? () =>
                              onShowPending({
                                botName: row.botName,
                                topicName: row.topicName,
                                schedType: row.sch.type,
                                sch: row.sch
                              })
                          : undefined
                      }
                    >
                      {hasPending ? `${row.pending} pending` : 'none'}
                    </span>
                  </td>
                </tr>
              </Fragmentish>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Tiny helper so we can return a separator + row from the .map() without
// needing to wrap each pair in a fragment that drops the key.
function Fragmentish({ children }) {
  return <>{children}</>;
}

// ────────────────────────────────────────────────────────────────────────────
// Pending Messages drill-down
// ────────────────────────────────────────────────────────────────────────────

function PendingMessagesPanel({ botName, topicName, schedType, sch, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        bot: botName,
        topic: topicName,
        schedule_type: schedType
      });
      const s = sch || {};
      if (s.minute != null) params.set('sch_minute', String(s.minute));
      if (s.hour != null) params.set('sch_hour', String(s.hour));
      if (s.hours != null) params.set('sch_hours', String(s.hours));
      if (s.minutes != null) params.set('sch_minutes', String(s.minutes));
      if (s.start_hour != null) params.set('sch_start_hour', String(s.start_hour));
      if (s.start_minute != null) params.set('sch_start_minute', String(s.start_minute));
      if (s.end_hour != null) params.set('sch_end_hour', String(s.end_hour));
      if (s.end_minute != null) params.set('sch_end_minute', String(s.end_minute));
      const res = await api(`/api/monitor/pending-messages?${params.toString()}`);
      if (cancelled) return;
      if (res.status !== 'ok') {
        setError(res.message || 'Error loading pending messages.');
        setData(null);
      } else {
        setData(res.messages || []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [botName, topicName, schedType, sch]);

  return (
    <div className="sum-msg-page">
      <div className="sum-msg-page-header">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>
          ‹ Back to Schedules
        </button>
        <h3 style={{ margin: 0, fontSize: 15 }}>
          Pending Messages — {botName} › {topicName} › {schedType}
        </h3>
      </div>
      {loading ? (
        <p className="mon-empty">Loading…</p>
      ) : error ? (
        <p className="mon-empty" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : !data?.length ? (
        <p className="mon-empty">No pending messages found.</p>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            {data.length} pending message{data.length === 1 ? '' : 's'}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="mon-table smp-table">
              <thead>
                <tr>
                  <th>Date / Time</th>
                  <th>Source</th>
                  <th>Collection</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {data.map((m, i) => (
                  <tr key={m.id ?? i}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{fmtLBN(m.timestamp)}</td>
                    <td>{m.channel_username ? `@${m.channel_username}` : '—'}</td>
                    <td>{m.collection_name || '—'}</td>
                    <td className="smp-msg-cell" title={m.preview || ''}>
                      {m.preview || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function buildFlatSchedules(bots) {
  const out = [];
  for (const botName in bots) {
    const botData = bots[botName];
    const cats = botData.categories || {};
    for (const catName in cats) {
      const catData = cats[catName];
      const topics = catData.topics || {};
      for (const topicName in topics) {
        const topicData = topics[topicName];
        const schedules = topicData.schedules || [];
        const p = topicData.pending || {};
        const topicEnabled = topicData.enabled !== false;
        for (const sch of schedules) {
          out.push({
            botName,
            catName,
            topicName,
            botEnabled: botData.enabled,
            topicEnabled,
            sch,
            pending: p[sch.type] || 0
          });
        }
      }
    }
  }
  return out;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}
