/**
 * History tab — every persisted schedule run with status + composition view.
 *
 * Features:
 *   - bot/topic/status multi-select filters
 *   - View Summary  → modal with the generated text (RTL)
 *   - View Error    → modal with friendly 429/499 labels + collapsible details
 *   - Click message count → drill into the summary's interim composition
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, escapeHtml, fmtLBN } from '../../lib/api';
import { useDialogs } from '../../dialogs/DialogsProvider';
import MultiSelect from './MultiSelect';
import ExportColumnsModal from './ExportColumnsModal';
import { downloadCsv } from './exportCsv';
import { useUrlInt, useUrlSet } from '../../lib/useUrlState';

const HIST_STYLES = `
  .hist-table { width:100%; border-collapse:collapse; font-size:12.5px; }
  .hist-table th { background:var(--bg-tertiary); color:var(--text-secondary);
      font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
      padding:8px 12px; text-align:left; position:sticky; top:0; z-index:1;
      border-bottom:1px solid var(--border-color); }
  .hist-table td { padding:6px 12px; border-bottom:1px solid var(--border-color); vertical-align:middle; }
  .hist-table tr:last-child td { border-bottom:none; }
  .hist-table tr:hover td { background:var(--bg-tertiary); }
  .hist-row-failed td { background:rgba(239,68,68,.04); }
  .hist-time { white-space:nowrap; color:var(--text-muted); font-size:11.5px; }
  .hist-badge-ok   { display:inline-block; font-size:11px; font-weight:700; padding:2px 8px;
      border-radius:20px; background:rgba(16,185,129,.15); color:#6ee7b7; }
  .hist-badge-fail { display:inline-block; font-size:11px; font-weight:700; padding:2px 8px;
      border-radius:20px; background:rgba(239,68,68,.15); color:#fca5a5; }
`;

export default function HistoryTab() {
  const { showAlert } = useDialogs();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['monitor', 'history'],
    queryFn: () => api('/api/monitor/schedule-history?limit=200')
  });

  const allRuns = data?.status === 'ok' ? data.runs || [] : [];

  const [selBots, setSelBots] = useUrlSet('hbot');
  const [selTopics, setSelTopics] = useUrlSet('htopic');
  const [selStatus, setSelStatus] = useUrlSet('hstatus');
  // ?summary=<id> opens the composition drill-down for that summary.
  const [summaryId, setSummaryId] = useUrlInt('summary', 0);
  const composition = summaryId > 0 ? { summaryId } : null;
  const [showExport, setShowExport] = useState(false);

  const allBots = useMemo(
    () => uniqueSorted(allRuns.map((r) => r.bot_name).filter(Boolean)),
    [allRuns]
  );
  const allTopics = useMemo(
    () => uniqueSorted(allRuns.map((r) => r.topic_name).filter(Boolean)),
    [allRuns]
  );
  const allStatuses = useMemo(
    () => uniqueSorted(allRuns.map((r) => r.status).filter(Boolean)),
    [allRuns]
  );

  const runs = useMemo(() => {
    let out = allRuns;
    if (selBots.size) out = out.filter((r) => selBots.has(r.bot_name || ''));
    if (selTopics.size) out = out.filter((r) => selTopics.has(r.topic_name || ''));
    if (selStatus.size) out = out.filter((r) => selStatus.has(r.status || ''));
    return out;
  }, [allRuns, selBots, selTopics, selStatus]);

  if (composition) {
    return (
      <CompositionPanel
        summaryId={composition.summaryId}
        onBack={() => setSummaryId(0)}
      />
    );
  }

  function viewSummary(text) {
    const safe = escapeHtml(text || '');
    showAlert(
      `<div style="direction:rtl;text-align:right;white-space:pre-wrap;` +
        `max-height:420px;overflow-y:auto;font-size:13px;` +
        `line-height:1.7;padding:4px 2px;">${safe}</div>`,
      { title: 'Summary Output', icon: '📄' }
    );
  }

  function viewError(rawErr) {
    const err = rawErr || '(no error text)';
    let label = 'Schedule Error';
    let isKnown = false;
    if (/429|resource.?exhausted/i.test(err)) {
      label = '429 Resource Exhausted — AI quota limit reached';
      isKnown = true;
    } else if (/499|cancelled/i.test(err)) {
      label = '499 Cancelled — the AI request was cancelled';
      isKnown = true;
    } else if (/500|internal/i.test(err)) {
      label = '500 Internal Server Error';
      isKnown = true;
    } else if (/503|unavailable/i.test(err)) {
      label = '503 Service Unavailable — AI backend is down';
      isKnown = true;
    } else if (/less than min_msgs/i.test(err)) {
      label = 'Not enough messages — below minimum threshold';
      isKnown = true;
    }
    const safeErr = escapeHtml(err);
    const safeLabel = escapeHtml(label);
    const explanation = /429|exhausted/i.test(err)
      ? 'The AI API rate limit was hit. The next scheduled run should succeed automatically once the quota resets.'
      : /499|cancel/i.test(err)
      ? 'The request was cancelled before the AI could respond — usually a timeout or network interruption. The next run will retry.'
      : /less than min_msgs/i.test(err)
      ? "The number of messages collected in the time window was below the bot's configured minimum_messages — no summary was generated."
      : 'An error occurred with the AI backend.';
    const html =
      `<div style="font-weight:600;color:var(--danger);margin-bottom:10px;">${safeLabel}</div>` +
      (isKnown
        ? `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">${escapeHtml(explanation)}</p>`
        : '') +
      `<details style="margin-top:8px;">` +
      `<summary style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none;">Show technical details</summary>` +
      `<pre style="margin-top:8px;font-size:11px;background:var(--bg-secondary,#f5f5f5);padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow-y:auto;">${safeErr}</pre>` +
      `</details>`;
    showAlert(html, { title: 'Schedule Run Error', icon: '⚠️' });
  }

  return (
    <>
      <style>{HIST_STYLES}</style>

      <div className="mon-filter-bar">
        <MultiSelect label="All Bots" values={allBots} selected={selBots} onChange={setSelBots} />
        <MultiSelect
          label="All Topics"
          values={allTopics}
          selected={selTopics}
          onChange={setSelTopics}
        />
        <MultiSelect
          label="All Statuses"
          values={allStatuses}
          selected={selStatus}
          onChange={setSelStatus}
        />
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setShowExport(true)}
          title="Export visible history rows to CSV"
        >
          ⬇ Export
        </button>
        <button
          className="btn btn-secondary btn-sm"
          style={{ whiteSpace: 'nowrap' }}
          onClick={() => refetch()}
          disabled={isFetching}
        >
          ↻ Refresh
        </button>
      </div>

      {isLoading ? (
        <p className="mon-empty">Loading…</p>
      ) : data?.status !== 'ok' ? (
        <p className="mon-empty">Error: {data?.message || ''}</p>
      ) : !runs.length ? (
        <p className="mon-empty" style={{ padding: 24 }}>
          No schedule runs recorded yet.
        </p>
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
          <table className="hist-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Bot</th>
                <th>Topic</th>
                <th>Type</th>
                <th>Status</th>
                <th>Msgs</th>
                <th>Summary</th>
                <th>Target</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <HistoryRow
                  key={r.id ?? i}
                  run={r}
                  onShowComposition={(id) => setSummaryId(id)}
                  onViewSummary={viewSummary}
                  onViewError={viewError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showExport && (
        <ExportColumnsModal
          tabName="history"
          onClose={() => setShowExport(false)}
          onConfirm={(keys) => {
            const res = downloadCsv('history', runs, keys);
            setShowExport(false);
            if (!res.ok) showAlert(res.reason, { title: 'Export', icon: '⚠️' });
          }}
        />
      )}
    </>
  );
}

function HistoryRow({ run, onShowComposition, onViewSummary, onViewError }) {
  const isOk = run.status === 'success';
  const rowCls = isOk ? '' : 'hist-row-failed';
  const typeCls = run.schedule_type || '';
  return (
    <tr className={rowCls}>
      <td className="hist-time">{fmtLBN(run.fired_at)}</td>
      <td>{run.bot_name || '—'}</td>
      <td>{run.topic_name || '—'}</td>
      <td>
        <span className={`mon-type-badge ${typeCls}`}>{run.schedule_type || '—'}</span>
      </td>
      <td>
        {isOk ? (
          <span className="hist-badge-ok">✓ Success</span>
        ) : (
          <span className="hist-badge-fail">✗ Failed</span>
        )}
      </td>
      <td style={{ textAlign: 'center' }}>
        {run.summary_id ? (
          <span
            className="mon-msgs-link"
            onClick={() => onShowComposition(run.summary_id)}
            style={{ cursor: 'pointer' }}
          >
            {run.message_count || 0}
          </span>
        ) : (
          run.message_count || 0
        )}
      </td>
      <td>
        {run.summary_text ? (
          <button
            className="btn btn-sm"
            style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={() => onViewSummary(run.summary_text)}
          >
            View
          </button>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </td>
      <td style={{ fontSize: 11, maxWidth: 160, wordBreak: 'break-all' }}>
        {run.target_entities ? (
          run.target_entities
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </td>
      <td>
        {!isOk && run.error_text ? (
          <button
            className="btn btn-sm"
            style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={() => onViewError(run.error_text)}
          >
            View Error
          </button>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Composition view (interims + remaining messages)
// ────────────────────────────────────────────────────────────────────────────

function CompositionPanel({ summaryId, onBack }) {
  const { showAlert } = useDialogs();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const res = await api(`/api/monitor/summary-composition?id=${summaryId}`);
      if (cancelled) return;
      if (res.status !== 'ok') {
        setError(res.message || 'Error loading composition.');
      } else {
        setData(res);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [summaryId]);

  const interims = data?.interims || [];
  const remaining = data?.remaining_messages || [];
  const lastIdx = interims.length - 1;

  // Flatten every source message (per interim + remaining) for CSV export.
  const exportRows = useMemo(() => {
    const out = [];
    interims.forEach((interim, idx) => {
      const num = interim.interim_number ?? idx + 1;
      (interim.messages || []).forEach((m) => out.push({ ...m, interimLabel: `Interim #${num}` }));
    });
    remaining.forEach((m) => out.push({ ...m, interimLabel: 'Remaining' }));
    return out;
  }, [interims, remaining]);

  return (
    <div className="sum-msg-page">
      <div className="sum-msg-page-header">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>
          ‹ Back to History
        </button>
        <h3 style={{ margin: 0, fontSize: 15 }}>Summary Composition</h3>
        <button
          className="btn btn-secondary btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowExport(true)}
          disabled={!exportRows.length}
          title="Export all source messages of this summary to CSV"
        >
          ⬇ Export
        </button>
      </div>

      {loading && <p className="mon-empty">Loading…</p>}
      {error && (
        <p className="mon-empty" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {!loading && !error && !interims.length && !remaining.length && (
        <p className="mon-empty">No linked messages found.</p>
      )}

      {!loading && !error && (interims.length > 0 || remaining.length > 0) && (
        <>
          {interims.map((interim, idx) => (
            <InterimCard
              key={interim.id ?? idx}
              interim={interim}
              isLast={idx === lastIdx}
              defaultIndex={idx + 1}
            />
          ))}
          {remaining.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  padding: '6px 0',
                  borderTop: '1px solid var(--border-color)',
                  marginBottom: 8
                }}
              >
                Remaining Messages ({remaining.length}) — not yet batched into an interim
              </div>
              <CompMessagesTable messages={remaining} />
            </div>
          )}
        </>
      )}

      {showExport && (
        <ExportColumnsModal
          tabName="comp_messages"
          onClose={() => setShowExport(false)}
          onConfirm={(keys) => {
            const res = downloadCsv('comp_messages', exportRows, keys);
            setShowExport(false);
            if (!res.ok) showAlert(res.reason, { title: 'Export', icon: '⚠️' });
          }}
        />
      )}
    </div>
  );
}

function InterimCard({ interim, isLast, defaultIndex }) {
  const [open, setOpen] = useState(isLast);
  const num = interim.interim_number ?? defaultIndex;
  const msgCnt = interim.message_count ?? interim.messages?.length ?? 0;
  const ts = interim.created_at ? fmtLBN(interim.created_at) : '—';
  return (
    <div
      className="sum-comp-card"
      style={{
        marginBottom: 10,
        border: `1px solid ${isLast ? '#10b981' : 'var(--border-color)'}`,
        borderRadius: 8,
        overflow: 'hidden'
      }}
    >
      <div
        className="sum-comp-card-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 14px',
          background: 'var(--bg-secondary)',
          cursor: 'pointer',
          userSelect: 'none'
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--accent-primary)' }}>
          Interim #{num}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {msgCnt} new message{msgCnt !== 1 ? 's' : ''}
        </span>
        {isLast ? (
          <span
            style={{
              background: 'rgba(16,185,129,.15)',
              color: '#10b981',
              padding: '2px 8px',
              borderRadius: 10,
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: 'nowrap'
            }}
          >
            ▶ Used in final
          </span>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            (rolled into #{num + 1})
          </span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{ts}</span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            transition: 'transform .2s',
            transform: open ? '' : 'rotate(-90deg)'
          }}
        >
          ▼
        </span>
      </div>
      {open && (
        <div style={{ padding: '12px 14px' }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: isLast ? '#10b981' : 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '.04em',
              marginBottom: 5
            }}
          >
            {isLast
              ? 'Rolling Output (cumulative — used in final summary)'
              : 'Rolling Output (rolled into next interim)'}
          </div>
          <div
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 13,
              background: 'var(--bg-tertiary)',
              borderRadius: 6,
              padding: '10px 12px',
              border: '1px solid var(--border-color)',
              marginBottom: 10,
              maxHeight: 200,
              overflowY: 'auto'
            }}
          >
            {interim.summary_text || ''}
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '.04em',
              marginBottom: 6
            }}
          >
            New Source Messages ({msgCnt})
          </div>
          <CompMessagesTable messages={interim.messages || []} />
        </div>
      )}
    </div>
  );
}

function CompMessagesTable({ messages }) {
  if (!messages.length) {
    return (
      <p className="mon-empty" style={{ padding: '4px 0', fontSize: 12 }}>
        No messages.
      </p>
    );
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="mon-table smp-table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>Date / Time</th>
            <th>Source</th>
            <th>Topics</th>
            <th>Keywords</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((m, i) => (
            <tr key={m.id ?? i}>
              <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{fmtLBN(m.timestamp)}</td>
              <td>{m.channel_username ? `@${m.channel_username}` : '—'}</td>
              <td>{m.topics || '—'}</td>
              <td>{m.keywords_found || '—'}</td>
              <td className="smp-msg-cell" title={m.preview || ''}>
                {m.preview || ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}
