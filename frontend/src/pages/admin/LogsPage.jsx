/**
 * Logs Page (admin) — port of static/js/pages/logs.js + index.html#logs-page.
 *
 * Two tabs:
 *   1. System Logs   — buffered server logs with level/tag/search filters,
 *                      auto-refresh (5s), error count badge, download + clear.
 *   2. Summary Failures — persistent schedule-run failure history with bot
 *                         + days filters and rate-snapshot columns.
 *
 * Backend endpoints used:
 *   GET  /api/logs?limit=500&level=&search=
 *   POST /api/logs/clear
 *   GET  /api/monitor/schedule-history?status=failed&limit=500&bot=
 *   GET  /api/config            (for the failure tab's bot dropdown)
 */
import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, debounce, fmtLBN } from '../../lib/api';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useGlobalConfig } from '../../config/ConfigProvider';
import { useUrlString } from '../../lib/useUrlState';
import PageHeader from '../../components/PageHeader';

const LOG_LEVEL_CLS = {
  ERROR: 'log-level-error',
  WARNING: 'log-level-warn',
  INFO: 'log-level-info',
  DEBUG: 'log-level-debug'
};

const TAG_OPTIONS = [
  '[YT-WORKER]',
  '[WEBSUB]',
  '[WEBSUB-RENEW]',
  '[YT-CHAT]',
  '[CATEG]',
  '[SAVED]',
  '[CATCH_ALL]',
  '[BOT]',
  '[AUTH]',
  '[DIALOGS]',
  '[TG-TEST]',
  '[TESTER-SUMMARY]',
  '[TESTER-SEND]',
  '[RECYCLE-BIN]',
  '[KEYWORDS]',
  '[MIGRATE]'
];

// CSS injected once for the logs table (mirrors legacy _injectLogStyles).
// Column widths are controlled by the <colgroup> + react-overrides.css so
// the table always fills the available horizontal space, with the Message
// column absorbing every extra pixel.
const LOG_STYLES = `
  #logs-table-wrap table { width:100%; border-collapse:collapse; font-size:12.5px; }
  #logs-table-wrap th { background:var(--bg-tertiary); color:var(--text-secondary);
      font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
      padding:8px 12px; text-align:left; position:sticky; top:0; z-index:1;
      border-bottom:1px solid var(--border-color); }
  #logs-table-wrap td { padding:6px 12px; border-bottom:1px solid var(--border-color);
      vertical-align:top; }
  #logs-table-wrap tr:last-child td { border-bottom:none; }
  #logs-table-wrap tr:hover td { background:var(--bg-tertiary); }
  .log-time  { white-space:nowrap; color:var(--text-muted); font-size:11.5px; }
  .log-name  { white-space:nowrap; color:var(--text-muted); font-size:11.5px;
               overflow:hidden; text-overflow:ellipsis; }
  .log-level { font-weight:700; font-size:11px; white-space:nowrap; }
  .log-msg   { word-break:break-word; color:var(--text-primary); width:100%; }
  .log-level-error   { color:#ef4444; }
  .log-level-warn    { color:#f59e0b; }
  .log-level-info    { color:var(--accent-primary); }
  .log-level-debug   { color:var(--text-muted); }
  tr.log-row-error td { background:rgba(239,68,68,.04); }
  tr.log-row-warn  td { background:rgba(245,158,11,.04); }
  .log-tag { display:inline-block; font-weight:700; font-size:11px;
             background:rgba(var(--accent-primary-rgb),.12); color:var(--accent-primary);
             border-radius:3px; padding:0 3px; margin-right:2px; font-family:monospace; }
`;

const VALID_LOG_TABS = new Set(['system', 'failures']);

export default function LogsPage() {
  const [tabParam, setTabParam] = useUrlString('tab', 'system');
  const activeTab = VALID_LOG_TABS.has(tabParam) ? tabParam : 'system';
  // Push so the browser Back button returns to the previous tab.
  const setActiveTab = (t) => setTabParam(t, { push: true });

  return (
    <div className="page active" id="logs-page">
      <style>{LOG_STYLES}</style>

      <PageHeader
        title="📋 System Logs"
        subtitle="Live server logs and persistent summary failure history."
      />

      {/* Tab bar */}
      <div className="mon-tab-bar" style={{ marginBottom: 16 }}>
        <button
          className={`mon-tab ${activeTab === 'system' ? 'active' : ''}`}
          onClick={() => setActiveTab('system')}
        >
          📋 System Logs
        </button>
        <button
          className={`mon-tab ${activeTab === 'failures' ? 'active' : ''}`}
          onClick={() => setActiveTab('failures')}
        >
          ❌ Summary Failures
          <FailuresBadge active={activeTab === 'failures'} />
        </button>
      </div>

      <div style={{ display: activeTab === 'system' ? '' : 'none' }}>
        <SystemLogsPanel />
      </div>
      <div style={{ display: activeTab === 'failures' ? '' : 'none' }}>
        {activeTab === 'failures' && <SummaryFailuresPanel />}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// System Logs
// ────────────────────────────────────────────────────────────────────────────

function SystemLogsPanel() {
  const [level, setLevel] = useUrlString('level', '');
  const [tag, setTag] = useUrlString('tag', '');
  const [search, setSearch] = useUrlString('q', '');
  const [searchInput, setSearchInput] = useState(search);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // 220ms-debounced commit of search input → URL (mirrors legacy
  // `_dApplyLogFilters` debounce in shared/api.js).
  const debouncedSetSearch = useMemo(
    () => debounce((v) => setSearch(v), 220),
    [setSearch]
  );

  const params = new URLSearchParams({ limit: '500' });
  if (level) params.set('level', level);
  if (search) params.set('search', search);
  const url = `/api/logs?${params.toString()}`;

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['logs', { level, search }],
    queryFn: () => api(url),
    refetchInterval: autoRefresh ? 5000 : false,
    refetchIntervalInBackground: false
  });

  const allLogs = data?.status === 'ok' ? data.logs || [] : [];
  const filteredLogs = tag ? allLogs.filter((r) => (r.message || '').includes(tag)) : allLogs;
  const errCount = allLogs.filter((r) => r.level === 'ERROR').length;

  const clear = useApiMutation('/api/logs/clear', {
    invalidate: ['logs'],
    successMsg: 'Log buffer cleared',
    errorMsg: 'Clear failed'
  });

  const confirmClear = useConfirmedMutation(clear, {
    message: 'Clear all log records from memory?',
    title: 'Clear Logs',
    confirmLabel: 'Clear',
    confirmClass: 'btn-danger'
  });

  function handleDownload() {
    const lines = allLogs
      .map(
        (r) =>
          `${r.time || ''} | ${(r.level || '').padEnd(7)} | ${r.name || ''} | ${r.message || ''}`
      )
      .join('\n');
    // BOM + utf-8 to keep Arabic/special chars correct in Notepad et al.
    const blob = new Blob(['﻿' + lines], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `logs_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      {/* Filter bar */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <select
            className="select"
            style={{ width: 130 }}
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          >
            <option value="">All Levels</option>
            <option value="ERROR">ERROR</option>
            <option value="WARNING">WARNING</option>
            <option value="INFO">INFO</option>
            <option value="DEBUG">DEBUG</option>
          </select>

          <select
            className="select"
            style={{ width: 170 }}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option value="">All Tags</option>
            {TAG_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <input
            type="text"
            className="input"
            placeholder="Search logs…"
            style={{ flex: 1, minWidth: 180, maxWidth: 320 }}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              debouncedSetSearch(e.target.value);
            }}
          />

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              cursor: 'pointer',
              color: 'var(--text-secondary)'
            }}
          >
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (5s)
          </label>

          <button
            className="btn btn-secondary btn-sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            ↻ Refresh
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleDownload}>
            ⬇ Download
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={() => confirmClear({})}
            disabled={clear.isPending}
            style={{ marginLeft: 'auto' }}
          >
            🗑 Clear
            {errCount > 0 && (
              <span
                className="badge badge-error"
                id="logs-error-badge"
                style={{ marginLeft: 6 }}
              >
                {errCount > 99 ? '99+' : errCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          id="logs-table-wrap"
          style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}
        >
          {isLoading ? (
            <p className="mon-empty" style={{ padding: 24 }}>
              Loading…
            </p>
          ) : data?.status !== 'ok' ? (
            <p className="mon-empty" style={{ padding: 24 }}>
              Error: {data?.message || ''}
            </p>
          ) : filteredLogs.length === 0 ? (
            <p className="mon-empty" style={{ padding: 24 }}>
              No log records.
            </p>
          ) : (
            <table>
              <colgroup>
                <col className="col-time" />
                <col className="col-logger" />
                <col className="col-level" />
                <col className="col-msg" />
              </colgroup>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Logger</th>
                  <th>Level</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((r, i) => (
                  <LogRow key={i} record={r} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function LogRow({ record }) {
  const lvlCls = LOG_LEVEL_CLS[record.level] || '';
  const rowCls =
    record.level === 'ERROR' ? 'log-row-error' : record.level === 'WARNING' ? 'log-row-warn' : '';
  return (
    <tr className={rowCls}>
      <td className="log-time">{record.time || ''}</td>
      <td className="log-name" title={record.name || ''}>
        {record.name || ''}
      </td>
      <td className={`log-level ${lvlCls}`}>{record.level || ''}</td>
      <td className="log-msg">{renderTaggedMessage(record.message || '')}</td>
    </tr>
  );
}

// Splits a log message and wraps `[TAG-NAME]` segments in <span class="log-tag">
// without using innerHTML. Mirrors the legacy regex highlight.
function renderTaggedMessage(msg) {
  const re = /(\[[A-Z][A-Z0-9_-]+\])/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = re.exec(msg)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Fragment key={key++}>{msg.slice(lastIndex, match.index)}</Fragment>);
    }
    parts.push(
      <span key={key++} className="log-tag">
        {match[0]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < msg.length) {
    parts.push(<Fragment key={key++}>{msg.slice(lastIndex)}</Fragment>);
  }
  return parts;
}

// ────────────────────────────────────────────────────────────────────────────
// Summary Failures
// ────────────────────────────────────────────────────────────────────────────

function SummaryFailuresPanel() {
  const [botFilter, setBotFilter] = useUrlString('bot', '');
  const [daysFilter, setDaysFilter] = useUrlString('days', '7');

  const { config } = useGlobalConfig();
  const knownBots = useMemo(() => {
    const bots = config?.bots || {};
    return Object.keys(bots).sort();
  }, [config]);

  const params = new URLSearchParams({ status: 'failed', limit: '500' });
  if (botFilter) params.set('bot', botFilter);
  const url = `/api/monitor/schedule-history?${params.toString()}`;

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['logs-failures', { botFilter }],
    queryFn: () => api(url)
  });

  const allRuns = data?.status === 'ok' ? data.runs || [] : [];
  const runs = useMemo(() => {
    if (!daysFilter || daysFilter === '0') return allRuns;
    const cutoff = Date.now() - parseInt(daysFilter, 10) * 86400000;
    return allRuns.filter((r) => {
      if (!r.fired_at) return false;
      const iso = r.fired_at.endsWith('Z') ? r.fired_at : r.fired_at + 'Z';
      return new Date(iso).getTime() >= cutoff;
    });
  }, [allRuns, daysFilter]);

  return (
    <>
      <div className="card" style={{ padding: '14px 18px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <select
            className="select"
            style={{ width: 180 }}
            value={botFilter}
            onChange={(e) => setBotFilter(e.target.value)}
          >
            <option value="">All Bots</option>
            {knownBots.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <select
            className="select"
            style={{ width: 140 }}
            value={daysFilter}
            onChange={(e) => setDaysFilter(e.target.value)}
          >
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="0">All time</option>
          </select>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          id="failures-table-wrap"
          className="aiu-table-wrap"
          style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}
        >
          {isLoading ? (
            <p className="mon-empty" style={{ padding: 24 }}>
              Loading…
            </p>
          ) : data?.status !== 'ok' ? (
            <p className="mon-empty" style={{ padding: 24 }}>
              Failed to load failures.
            </p>
          ) : runs.length === 0 ? (
            <p className="mon-empty" style={{ padding: 24 }}>
              No failures in this period.
            </p>
          ) : (
            <table className="yt-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Bot</th>
                  <th>Topic</th>
                  <th>Type</th>
                  <th style={{ textAlign: 'center' }}>RPM</th>
                  <th style={{ textAlign: 'center' }}>TPM</th>
                  <th style={{ textAlign: 'center' }}>RPD today</th>
                  <th style={{ textAlign: 'left' }}>Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <FailureRow key={i} run={r} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function FailureRow({ run }) {
  const errShort = (run.error_text || '').slice(0, 120);
  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-muted)' }}>
        {fmtLBN(run.fired_at)}
      </td>
      <td>
        <span className="tag-blue">{run.bot_name || '—'}</span>
      </td>
      <td>
        <span className="tag-green">{run.topic_name || '—'}</span>
      </td>
      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{run.schedule_type || '—'}</td>
      <td style={{ textAlign: 'center', fontSize: 12 }}>
        <RateCell value={run.rpm_at_failure} dangerAt={25000} />
      </td>
      <td style={{ textAlign: 'center', fontSize: 12 }}>
        <RateCell value={run.tpm_at_failure} dangerAt={1700000} />
      </td>
      <td style={{ textAlign: 'center', fontSize: 12 }}>
        <RateCell value={run.rpd_at_failure} warnAt={85000} />
      </td>
      <td style={{ minWidth: 220, textAlign: 'left' }}>
        {run.error_text ? (
          <details style={{ cursor: 'pointer' }}>
            <summary style={{ color: '#ef4444', fontSize: 12 }}>
              {errShort}
              {run.error_text.length > 120 ? '…' : ''}
            </summary>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: 11,
                marginTop: 4,
                color: 'var(--text-secondary)'
              }}
            >
              {run.error_text}
            </pre>
          </details>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </td>
    </tr>
  );
}

function RateCell({ value, dangerAt, warnAt }) {
  if (value == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const formatted = fmtRateVal(value);
  let style = {};
  if (dangerAt != null && value > dangerAt) style = { color: '#ef4444', fontWeight: 700 };
  else if (warnAt != null && value > warnAt) style = { color: '#f59e0b', fontWeight: 700 };
  return <span style={style}>{formatted}</span>;
}

function fmtRateVal(v) {
  if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return String(v);
}

// ────────────────────────────────────────────────────────────────────────────
// Cross-tab failure count badge (shown on the Failures tab pill in real time
// from a lightweight standalone fetch — it's also kept in sync by the
// in-panel updater when the failures panel is mounted).
// ────────────────────────────────────────────────────────────────────────────

function FailuresBadge({ active }) {
  // Always-on background fetch so the pill badge reflects current failure
  // count even when the System Logs tab is the visible one. Runs once per
  // mount; refreshes whenever the user clicks the failures tab via the
  // shared cache.
  const { data } = useQuery({
    queryKey: ['logs-failures-count'],
    queryFn: () => api('/api/monitor/schedule-history?status=failed&limit=500'),
    refetchInterval: active ? false : 60000
  });
  const runs = data?.status === 'ok' ? data.runs || [] : [];
  // Default cutoff: 7 days (matches the panel's default selection).
  const cutoff = Date.now() - 7 * 86400000;
  const recent = runs.filter((r) => {
    if (!r.fired_at) return false;
    const iso = r.fired_at.endsWith('Z') ? r.fired_at : r.fired_at + 'Z';
    return new Date(iso).getTime() >= cutoff;
  });
  if (recent.length === 0) return null;
  return (
    <span className="badge badge-error" style={{ marginLeft: 4 }}>
      {recent.length > 99 ? '99+' : recent.length}
    </span>
  );
}

