/**
 * History tab — every persisted schedule run with status + composition view.
 *
 * Features:
 *   - bot/topic/status multi-select filters
 *   - View Summary  → modal with the generated text (RTL)
 *   - View Error    → modal with friendly 429/499 labels + collapsible details
 *   - Click message count → drill into the summary's interim composition
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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

const PAGE_SIZE = 200;

export default function HistoryTab() {
  const { showAlert } = useDialogs();

  // Server-side pagination: each "Load older" appends the next page of runs
  // (ordered newest→oldest) so we can page back arbitrarily far instead of
  // being capped at the most recent PAGE_SIZE rows.
  const [allRuns, setAllRuns] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(null);
  // Guards against out-of-order responses when reloading.
  const reqSeq = useRef(0);

  async function loadPage(append) {
    const seq = ++reqSeq.current;
    setIsFetching(true);
    if (!append) setIsLoading(true);
    const offset = append ? allRuns.length : 0;
    const res = await api(
      `/api/monitor/schedule-history?limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (seq !== reqSeq.current) return; // superseded by a newer request
    if (res?.status !== 'ok') {
      setLoadError(res?.message || 'Unknown error');
      setIsFetching(false);
      setIsLoading(false);
      return;
    }
    const newRuns = res.runs || [];
    setAllRuns((prev) => (append ? [...prev, ...newRuns] : newRuns));
    setHasMore(newRuns.length === PAGE_SIZE);
    setLoadError(null);
    setIsFetching(false);
    setIsLoading(false);
  }

  function refetch() {
    loadPage(false);
  }

  useEffect(() => {
    loadPage(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selBots, setSelBots] = useUrlSet('hbot');
  const [selTopics, setSelTopics] = useUrlSet('htopic');
  const [selStatus, setSelStatus] = useUrlSet('hstatus');
  // ?summary=<id> opens the composition drill-down for that summary.
  const [summaryId, setSummaryId] = useUrlInt('summary', 0);
  const composition = summaryId > 0 ? { summaryId } : null;
  const [showExport, setShowExport] = useState(false);
  const [exportingInterims, setExportingInterims] = useState(false);
  // The run whose summary popup is open (null = closed).
  const [viewRun, setViewRun] = useState(null);

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

  // Open the summary popup. When the run carries multiple model outputs
  // (an A/B test), the modal shows one tab per model; otherwise just the text.
  function viewSummary(run) {
    setViewRun(run);
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
          disabled={exportingInterims}
          onClick={async () => {
            setExportingInterims(true);
            const res = await exportHistoryWithInterims(runs);
            setExportingInterims(false);
            if (!res.ok) showAlert(res.reason, { title: 'Export', icon: '⚠️' });
          }}
          title="Export visible runs with their full interim composition and final summary"
        >
          {exportingInterims ? '… Exporting' : '⬇ Export with Interims'}
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
      ) : loadError ? (
        <p className="mon-empty">Error: {loadError}</p>
      ) : !runs.length ? (
        <p className="mon-empty" style={{ padding: 24 }}>
          {allRuns.length
            ? 'No runs match the filters.'
            : 'No schedule runs recorded yet.'}
        </p>
      ) : (
        <>
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
                    onShowComposition={(id) => setSummaryId(id, { push: true })}
                    onViewSummary={viewSummary}
                    onViewError={viewError}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {hasMore ? (
            <div style={{ textAlign: 'center', padding: 16 }}>
              <button
                className="btn btn-secondary"
                onClick={() => loadPage(true)}
                disabled={isFetching}
              >
                {isFetching ? '… Loading' : 'Load older runs…'}
              </button>
              <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>
                {allRuns.length} loaded
              </span>
            </div>
          ) : allRuns.length > PAGE_SIZE ? (
            <p
              className="text-muted"
              style={{ textAlign: 'center', padding: 8, fontSize: 12 }}
            >
              All {allRuns.length} runs loaded
            </p>
          ) : null}
        </>
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

      {viewRun && <SummaryModal run={viewRun} onClose={() => setViewRun(null)} />}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Summary popup. Shows the sent (primary) summary, plus a tab per compare model
// when an A/B test ran. The sent model's tab is flagged "· sent".
// ────────────────────────────────────────────────────────────────────────────
function SummaryModal({ run, onClose }) {
  // model_outputs is {model: text}; when present it already includes the
  // primary. Fall back to a single synthetic tab from summary_text otherwise.
  const outputs = run.model_outputs && Object.keys(run.model_outputs).length
    ? run.model_outputs
    : { [run.primary_model || 'summary']: run.summary_text || '' };

  const models = Object.keys(outputs);
  const primary = run.primary_model && outputs[run.primary_model] != null
    ? run.primary_model
    : models[0];
  const [active, setActive] = useState(primary);
  const multi = models.length > 1;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>📄 Summary Output</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>

        {multi && (
          <div
            style={{
              display: 'flex', gap: 6, flexWrap: 'wrap',
              padding: '10px 16px 0', borderBottom: '1px solid var(--border-color)'
            }}
          >
            {models.map((m) => (
              <button
                key={m}
                className="btn btn-sm"
                onClick={() => setActive(m)}
                style={{
                  fontSize: 11,
                  padding: '4px 10px',
                  borderBottom: active === m ? '2px solid var(--accent, #6366f1)' : '2px solid transparent',
                  fontWeight: active === m ? 700 : 400,
                  opacity: active === m ? 1 : 0.7
                }}
                title={m === primary ? 'This output was sent to Telegram' : 'Comparison only — not sent'}
              >
                {m}{m === primary ? ' · sent' : ''}
              </button>
            ))}
          </div>
        )}

        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <div
            style={{
              direction: 'rtl', textAlign: 'right', whiteSpace: 'pre-wrap',
              fontSize: 13, lineHeight: 1.7, padding: '4px 2px',
              color: 'var(--text-primary)'
            }}
          >
            {outputs[active] || '(empty)'}
          </div>
        </div>
      </div>
    </div>
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
            onClick={() => onViewSummary(run)}
          >
            {run.model_outputs && Object.keys(run.model_outputs).length > 1
              ? `View (${Object.keys(run.model_outputs).length})`
              : 'View'}
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

  // Flatten every interim (rolling output + source messages) and remaining
  // messages for CSV export. Each interim emits one "Output" row carrying its
  // rolling summary text, followed by its "Message" source rows.
  const exportRows = useMemo(() => {
    const out = [];
    interims.forEach((interim, idx) => {
      const num = interim.interim_number ?? idx + 1;
      const label = `Interim #${num}`;
      out.push({
        interimLabel: label,
        kind: 'Output',
        timestamp: interim.created_at || null,
        preview: interim.summary_text || ''
      });
      (interim.messages || []).forEach((m) =>
        out.push({ ...m, interimLabel: label, kind: 'Message' })
      );
    });
    remaining.forEach((m) => out.push({ ...m, interimLabel: 'Remaining', kind: 'Message' }));
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

// ────────────────────────────────────────────────────────────────────────────
// Composition CSV export
//
// Rows follow the way a summary is actually built up: all the source messages
// that fed an interim, then that interim's rolling output, then the next
// interim and its messages, … then any remaining (never-batched) messages, and
// finally the summary's final output. Uses the full `text` field — falls back
// to `preview` for older responses that don't carry it.
// ────────────────────────────────────────────────────────────────────────────

// Columns shared by the single-summary export and each run block of the
// History "with interims" export.
const COMP_BODY_HEADER = [
  'Section',
  'Message Time',
  'Source',
  'Topics',
  'Categories',
  'Keywords',
  'Content'
];

const csvCell = (v) => `"${(v == null ? '' : String(v)).replace(/"/g, '""')}"`;
const csvRow = (vals) => vals.map(csvCell).join(',');
const fullText = (m) => (m.text != null ? m.text : m.preview || '');

/**
 * Build the body rows (no header) for one summary's composition, in build
 * order: per interim → its messages then its rolling output, then remaining
 * messages, then the final summary output. Each row has COMP_BODY_HEADER shape.
 */
function compositionBodyRows(interims, remaining, finalSummary) {
  const rows = [];
  const lastIdx = interims.length - 1;

  interims.forEach((interim, idx) => {
    const num = interim.interim_number ?? idx + 1;
    (interim.messages || []).forEach((m) => {
      rows.push([
        `Interim #${num}`,
        m.timestamp ? fmtLBN(m.timestamp) : '',
        m.channel_username ? `@${m.channel_username}` : '',
        m.topics || '',
        m.categories || '',
        m.keywords_found || '',
        fullText(m)
      ]);
    });
    const status = idx === lastIdx ? 'used in final' : `rolled into #${num + 1}`;
    rows.push([
      `Interim #${num} Output (${status})`,
      interim.created_at ? fmtLBN(interim.created_at) : '',
      '',
      '',
      '',
      '',
      interim.summary_text || ''
    ]);
  });

  (remaining || []).forEach((m) => {
    rows.push([
      'Remaining (not batched)',
      m.timestamp ? fmtLBN(m.timestamp) : '',
      m.channel_username ? `@${m.channel_username}` : '',
      m.topics || '',
      m.categories || '',
      m.keywords_found || '',
      fullText(m)
    ]);
  });

  if (finalSummary) {
    rows.push(['Final Summary Output', '', '', '', '', '', finalSummary]);
  }

  return rows;
}

// UTF-8 BOM so Excel reads non-ASCII (Arabic / Hebrew / emoji) correctly.
function downloadCsvRows(rows, filename) {
  const csv = '﻿' + rows.map(csvRow).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * History export "with interims": for each visible run that produced a summary,
 * emit its full composition (the same build-order layout as the single export)
 * prefixed with the run's identity. Pulls every run's interims in one batch
 * call so we don't hit the per-summary endpoint once per row.
 */
async function exportHistoryWithInterims(runs) {
  const withSummary = runs.filter((r) => r.summary_id);
  if (!withSummary.length) {
    return { ok: false, reason: 'No runs with a generated summary to export.' };
  }
  const ids = withSummary.map((r) => r.summary_id).join(',');
  const res = await api(`/api/monitor/summary-composition-batch?ids=${ids}`);
  if (res?.status !== 'ok') {
    return { ok: false, reason: res?.message || 'Failed to load interim composition.' };
  }
  const comps = res.compositions || {};

  const header = ['Run Time', 'Bot', 'Topic', 'Type', 'Status', ...COMP_BODY_HEADER];
  const rows = [header];
  withSummary.forEach((r) => {
    const comp = comps[String(r.summary_id)] || {};
    const meta = [
      r.fired_at ? fmtLBN(r.fired_at) : '',
      r.bot_name || '',
      r.topic_name || '',
      r.schedule_type || '',
      r.status || ''
    ];
    // Prefer the run's own final summary text; fall back to the batch payload.
    const body = compositionBodyRows(
      comp.interims || [],
      comp.remaining_messages || [],
      r.summary_text || comp.summary_text || ''
    );
    if (!body.length) {
      rows.push([...meta, ...COMP_BODY_HEADER.map(() => '')]);
    } else {
      body.forEach((b) => rows.push([...meta, ...b]));
    }
  });

  downloadCsvRows(rows, `schedule_history_interims_${new Date().toISOString().slice(0, 10)}.csv`);
  return { ok: true };
}
