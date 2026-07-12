/**
 * AI Usage — admin page.
 *
 * Ports static/js/ai-usage.js to React. Shows live Tier 1 quota meters
 * (TPM/RPM/RPD), 24h totals, an hourly activity table, and the most recent
 * 100 summaries with per-summary token counts.
 *
 * Auto-refresh: TanStack Query's refetchInterval keeps the data fresh every
 * 15s and stops automatically when the page unmounts (replaces the legacy
 * _stopAiUsagePoller pattern).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import PageHeader from '../../components/PageHeader';

export default function AiUsagePage() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['ai-usage-details'],
    queryFn: () => api('/api/system/ai-usage-details'),
    refetchInterval: 15000,
    refetchIntervalInBackground: false
  });

  const ok = data?.status === 'ok';
  const live = ok ? (data.live || {}) : {};
  const limits = ok ? (data.limits || {}) : {};
  const hourly = ok ? (data.hourly || []) : [];
  const recent = ok ? (data.recent || []) : [];

  const meters = buildMeters(live, limits);
  const warnings = buildWarnings(meters);

  const todaySummaries = hourly.reduce((s, r) => s + (r.summary_count || 0), 0);
  const todayTokens = hourly.reduce((s, r) => s + (r.total_tokens || 0), 0);
  const todayMsgs = hourly.reduce((s, r) => s + (r.total_messages || 0), 0);
  const avgTokens = todaySummaries > 0 ? Math.round(todayTokens / todaySummaries) : 0;

  return (
    <div className="page active">
      <PageHeader
        title="⚡ AI Usage"
        subtitle="Gemini API quota, per-summary token breakdown, and hourly activity."
      />

      {isLoading && (
        <p className="mon-empty" style={{ padding: 40 }}>Loading…</p>
      )}

      {!isLoading && !ok && (
        <p className="mon-empty" style={{ padding: 40 }}>
          Failed to load AI usage data.
        </p>
      )}

      {!isLoading && ok && (
        <>
          {/* Gemini model picker */}
          <GeminiModelCard />

          {/* Thinking toggle (Gemini 2.5 extended reasoning) */}
          <ThinkingToggleCard />

          {/* Section 1: Live quota */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card-header" style={{ gap: '.75rem' }}>
              <span style={{ fontSize: '1.1rem' }}>⚡</span>
              <strong>Live API Quota</strong>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
                  color: 'var(--text-muted)'
                }}
              >
                Tier 1 · auto-refreshes every 15s
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                ↻ Refresh
              </button>
            </div>
            <div
              className="card-body"
              id="aiu-meters-body"
              style={{ display: 'flex', flexWrap: 'wrap', gap: '1.75rem 2.5rem' }}
            >
              {meters.map((m) => (
                <Meter key={m.label} label={m.label} used={m.used} limit={m.limit} />
              ))}
            </div>
            <div
              id="aiu-warning-wrap"
              style={
                warnings.length
                  ? {
                      padding: '.5rem 1.25rem .75rem',
                      fontSize: 12,
                      color: 'var(--warning,#f59e0b)',
                      borderTop: '1px solid var(--border-color)'
                    }
                  : undefined
              }
            >
              {warnings.length > 0 && (
                <div className="aiu-warning">
                  {warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Section 2: 24h totals */}
          <div className="dash-stat-grid" style={{ marginBottom: '1.25rem' }}>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">📝</div>
              <div className="dash-stat-value">{todaySummaries}</div>
              <div className="dash-stat-label">Summaries sent (24h)</div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">🔢</div>
              <div className="dash-stat-value">{fmtNum(todayTokens)}</div>
              <div className="dash-stat-label">Tokens used (24h)</div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">📨</div>
              <div className="dash-stat-value">{todayMsgs}</div>
              <div className="dash-stat-label">Messages processed (24h)</div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">📊</div>
              <div className="dash-stat-value">
                {avgTokens > 0 ? fmtNum(avgTokens) : '—'}
              </div>
              <div className="dash-stat-label">Avg tokens / summary</div>
            </div>
          </div>

          {/* Section 2.5: Usage history (filters + graphs) */}
          <UsageHistoryCard />

          {/* Section 3: Hourly activity */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card-header">
              <strong>📅 Hourly Activity</strong>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                (last 24h · Lebanon time · {hourly.length} hour
                {hourly.length !== 1 ? 's' : ''} with activity)
              </span>
            </div>
            <div className="aiu-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="yt-table">
                <colgroup>
                  <col style={{ width: 110 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: '30%' }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Hour</th>
                    <th style={{ textAlign: 'center' }}>Summaries</th>
                    <th style={{ textAlign: 'center' }}>Tokens</th>
                    <th>Bots</th>
                    <th style={{ textAlign: 'left' }}>Topics</th>
                  </tr>
                </thead>
                <tbody>
                  {hourly.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        style={{
                          textAlign: 'center',
                          color: 'var(--text-muted)',
                          padding: 24
                        }}
                      >
                        No summaries in last 24 hours
                      </td>
                    </tr>
                  ) : (
                    hourly.map((row, i) => (
                      <tr key={i}>
                        <td
                          style={{
                            whiteSpace: 'nowrap',
                            fontVariantNumeric: 'tabular-nums',
                            color: 'var(--text-muted)',
                            fontSize: 12
                          }}
                        >
                          {fmtHour(row.hour_lbn)}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {row.summary_count}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {fmtNum(row.total_tokens || 0)}
                        </td>
                        <td>
                          {(row.bots || []).length === 0 ? (
                            <span style={{ color: 'var(--text-muted)' }}>—</span>
                          ) : (
                            (row.bots || []).map((b, j) => (
                              <span key={j} className="tag-blue" style={{ marginRight: 4 }}>
                                {b}
                              </span>
                            ))
                          )}
                        </td>
                        <td style={{ textAlign: 'left' }}>
                          {(row.topics || []).length === 0 ? (
                            <span style={{ color: 'var(--text-muted)' }}>—</span>
                          ) : (
                            (row.topics || []).map((t, j) => (
                              <span key={j} className="tag-green" style={{ marginRight: 4 }}>
                                {t}
                              </span>
                            ))
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 4: Recent summaries */}
          <RecentSummariesCard recent={recent} />
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Recent summaries — list + click-to-view-thinking modal
// ────────────────────────────────────────────────────────────────────────────

function RecentSummariesCard({ recent }) {
  const [openId, setOpenId] = useState(null);

  return (
    <>
      <div className="card">
        <div className="card-header">
          <strong>🕐 Recent Summaries</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(last 100)</span>
        </div>
        <div className="aiu-table-wrap" style={{ overflowX: 'auto' }}>
          <table className="yt-table">
            <colgroup>
              <col style={{ width: 110 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 70 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 50 }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>When</th>
                <th>Bot</th>
                <th>Topic</th>
                <th>Type</th>
                <th style={{ textAlign: 'center' }}>Msgs</th>
                <th style={{ textAlign: 'center' }}>Tokens</th>
                <th style={{ textAlign: 'center' }} title="Click to view Gemini's reasoning trace">🧠</th>
                <th style={{ textAlign: 'left' }}>Target</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      padding: 24
                    }}
                  >
                    No summaries yet
                  </td>
                </tr>
              ) : (
                recent.map((row, i) => {
                      const tokens = row.tokens_used || 0;
                      const tokStyle =
                        tokens > 5000
                          ? { color: '#ef4444', fontWeight: 700 }
                          : tokens > 2000
                          ? { color: '#f59e0b', fontWeight: 700 }
                          : { fontWeight: 600 };
                      return (
                        <tr key={row.id ?? i}>
                          <td
                            style={{
                              whiteSpace: 'nowrap',
                              color: 'var(--text-muted)',
                              fontSize: 12
                            }}
                          >
                            {relTime(row.timestamp)}
                          </td>
                          <td>
                            <span className="tag-blue">{row.bot_name || '—'}</span>
                          </td>
                          <td>
                            <span className="tag-green">{row.topic_name || '—'}</span>
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {row.summary_type || '—'}
                          </td>
                          <td style={{ textAlign: 'center' }}>{row.message_count || 0}</td>
                          <td style={{ textAlign: 'center', ...tokStyle }}>
                            {tokens > 0 ? fmtNum(tokens) : '—'}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {row.has_thoughts ? (
                              <button
                                className="btn-icon"
                                onClick={() => setOpenId(row.id)}
                                title="View Gemini's reasoning trace"
                                style={{ fontSize: 16, padding: 0 }}
                              >🧠</button>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>—</span>
                            )}
                          </td>
                          <td
                            style={{
                              fontSize: 12,
                              color: 'var(--text-muted)',
                              maxWidth: 180,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              textAlign: 'left'
                            }}
                            title={row.target_entity || ''}
                          >
                            {row.target_entity || '—'}
                          </td>
                        </tr>
                      );
                    })
                  )}
            </tbody>
          </table>
        </div>
      </div>

      {openId != null && (
        <ThoughtsModal id={openId} onClose={() => setOpenId(null)} />
      )}
    </>
  );
}

function ThoughtsModal({ id, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['summary-thoughts', id],
    queryFn: () => api(`/api/system/summary-thoughts?id=${id}`),
    staleTime: Infinity
  });

  const thoughts = data?.status === 'ok' ? (data.thoughts || '') : '';

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog" style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>🧠 Gemini Thinking Trace</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {isLoading && <p className="text-muted">Loading…</p>}
          {!isLoading && data?.status !== 'ok' && (
            <p style={{ color: 'var(--danger)' }}>
              {data?.message || 'Failed to load thoughts.'}
            </p>
          )}
          {!isLoading && data?.status === 'ok' && !thoughts && (
            <p className="text-muted">
              No reasoning trace was captured for this summary.
            </p>
          )}
          {!isLoading && thoughts && (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: 'inherit',
                color: 'var(--text-primary)',
                margin: 0
              }}
            >{thoughts}</pre>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Usage History — date/feature/user filters + Chart.js graphs
//
// Data comes from GET /api/system/ai-usage-history. Summaries usage is
// attributed to users via the owning bot's owner_id; YouTube usage has no
// per-user ownership, so it always counts under Admin (and is excluded when
// a specific non-admin user is selected).
// ────────────────────────────────────────────────────────────────────────────

const HIST_PERIODS = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_year', label: 'This year' },
  { value: 'custom', label: 'Custom range' }
];

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Resolve a period preset into {from, to, gran}. Custom ranges longer than
 *  ~3 months bucket by month so the chart stays readable. */
function histRange(period, customFrom, customTo) {
  const today = new Date();
  if (period === 'this_month') {
    return { from: isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDate(today), gran: 'day' };
  }
  if (period === 'last_month') {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const last = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: isoDate(first), to: isoDate(last), gran: 'day' };
  }
  if (period === 'this_year') {
    return { from: `${today.getFullYear()}-01-01`, to: isoDate(today), gran: 'month' };
  }
  const from = customFrom || isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  const to = customTo || isoDate(today);
  const spanDays = (new Date(to) - new Date(from)) / 86400000;
  return { from, to, gran: spanDays > 92 ? 'month' : 'day' };
}

/** Contiguous list of day/month bucket keys between two dates (inclusive) so
 *  the time chart has no gaps on days with zero usage. */
function buildBuckets(from, to, gran) {
  const out = [];
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  if (isNaN(d.getTime()) || isNaN(end.getTime())) return out;
  if (gran === 'month') d.setDate(1);
  let guard = 0;
  while (d <= end && guard++ < 500) {
    out.push(isoDate(d));
    if (gran === 'month') d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + 1);
  }
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtBucket(bucket, gran) {
  if (!bucket) return '';
  const [y, m, d] = bucket.split('-');
  if (gran === 'month') return `${MONTH_NAMES[+m - 1]} ${y.slice(2)}`;
  return `${d}/${m}`;
}

/* Theme-aware Chart.js styling — same pattern as DashboardPage: colors are
   read from the CSS custom properties at chart-creation time. */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function chartTheme() {
  const accentRgb = cssVar('--accent-primary-rgb', '107, 61, 181');
  return {
    accent: cssVar('--accent-primary', '#6b3db5'),
    accentRgb,
    surface: cssVar('--bg-card', '#ffffff'),
    tooltip: {
      backgroundColor: cssVar('--bg-card', '#ffffff'),
      borderColor: cssVar('--border-color', '#e0d5f0'),
      borderWidth: 1,
      titleColor: cssVar('--text-primary', '#3d1f8f'),
      bodyColor: cssVar('--text-secondary', '#5a4080'),
      padding: 10,
      cornerRadius: 8
    },
    grid: { color: `rgba(${accentRgb}, 0.08)`, drawBorder: false },
    ticks: { color: cssVar('--text-muted', '#9985bb'), font: { size: 11 } },
    legend: cssVar('--text-secondary', '#5a4080')
  };
}

/** Feature registry for the usage history — key order = chart stack order. */
const HIST_FEATURES = [
  { key: 'summaries', label: 'Summaries' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'chatbot', label: 'Chatbot' },
  { key: 'seo', label: 'SEO AI' }
];

/** Per-feature series colors — CVD-validated sets per theme. */
function histPalette() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return dark
    ? { summaries: '#8b5cf6', youtube: '#0891b2', chatbot: '#059669', seo: '#d97706' }
    : { summaries: '#6b3db5', youtube: '#06b6d4', chatbot: '#10b981', seo: '#f59e0b' };
}

function fmtUsd(x) {
  const n = Number(x) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}

const HIST_METRICS = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'runs', label: 'Runs' },
  { key: 'cost', label: 'Cost' }
];

function UsageHistoryCard() {
  const [period, setPeriod] = useState('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [feature, setFeature] = useState('all');
  const [user, setUser] = useState('all');
  const [metric, setMetric] = useState('cost'); // 'tokens' | 'runs' | 'cost'

  const { from, to, gran } = histRange(period, customFrom, customTo);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['ai-usage-history', from, to, gran, feature, user],
    queryFn: () =>
      api(
        `/api/system/ai-usage-history?date_from=${from}&date_to=${to}` +
          `&granularity=${gran}&feature=${feature}&user=${encodeURIComponent(user)}`
      ),
    placeholderData: (prev) => prev
  });

  const ok = data?.status === 'ok';
  const features = ok ? data.features || {} : {};
  const byUser = ok ? data.by_user || [] : [];
  const byBot = ok ? data.by_bot || [] : [];
  const byModel = ok ? data.by_model || [] : [];
  const users = ok ? data.users || [] : [];

  const includedFeatures = HIST_FEATURES.filter((f) => features[f.key]);

  const buckets = useMemo(() => buildBuckets(from, to, gran), [from, to, gran]);
  // Per-feature bucket→{runs,tokens,cost} lookup for the time chart.
  const featMaps = useMemo(() => {
    const out = {};
    for (const f of Object.keys(features)) {
      out[f] = Object.fromEntries((features[f].series || []).map((r) => [r.bucket, r]));
    }
    return out;
  }, [features]);

  const totals = useMemo(() => {
    const t = { runs: 0, tokens: 0, cost: 0 };
    for (const f of Object.keys(features)) {
      const ft = features[f].total || {};
      t.runs += ft.runs || 0;
      t.tokens += ft.tokens || 0;
      t.cost += ft.cost || 0;
    }
    return t;
  }, [features]);

  const userIsSpecific = user !== 'all' && user !== 'admin';
  const noData = totals.runs === 0;

  const selStyle = { width: 'auto', minWidth: 130 };
  const lblStyle = { fontSize: 12, color: 'var(--text-muted)' };

  return (
    <>
      {/* Filter bar */}
      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="card-header" style={{ gap: '.75rem' }}>
          <span style={{ fontSize: '1.1rem' }}>📜</span>
          <strong>Usage History</strong>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
            {from} → {to} · by {gran}
            {isFetching ? ' · updating…' : ''}
          </span>
        </div>
        <div
          className="card-body"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, padding: '.9rem 1.25rem' }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={lblStyle}>📅 Period</span>
            <select className="select" style={selStyle} value={period} onChange={(e) => setPeriod(e.target.value)}>
              {HIST_PERIODS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>

          {period === 'custom' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={lblStyle}>From</span>
                <input type="date" className="input" style={{ width: 'auto' }} value={customFrom} max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={lblStyle}>To</span>
                <input type="date" className="input" style={{ width: 'auto' }} value={customTo} min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)} />
              </label>
            </>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={lblStyle}>🧩 Feature</span>
            <select className="select" style={selStyle} value={feature} onChange={(e) => setFeature(e.target.value)}>
              <option value="all">All features</option>
              {HIST_FEATURES.map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={lblStyle}>👤 User</span>
            <select className="select" style={selStyle} value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="all">All users</option>
              <option value="admin">Admin</option>
              {users.map((u) => (
                <option key={u.id} value={String(u.id)}>{u.username}</option>
              ))}
            </select>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginLeft: 'auto' }}>
            {HIST_METRICS.map((m, i) => (
              <button
                key={m.key}
                className={`btn btn-sm ${metric === m.key ? 'btn-primary' : 'btn-secondary'}`}
                style={{
                  borderRadius:
                    i === 0 ? '8px 0 0 8px' : i === HIST_METRICS.length - 1 ? '0 8px 8px 0' : 0
                }}
                onClick={() => setMetric(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {(feature === 'all' || feature === 'youtube') && userIsSpecific && (
          <div style={{ padding: '0 1.25rem .75rem', fontSize: 12, color: 'var(--text-muted)' }}>
            ℹ YouTube usage is not owned by individual users — it is excluded while a specific user is selected.
          </div>
        )}
      </div>

      {/* Period totals */}
      <div className="dash-stat-grid" style={{ marginBottom: '1.25rem' }}>
        <div className="dash-stat-card">
          <div className="dash-stat-icon">🤖</div>
          <div className="dash-stat-value">{fmtNum(totals.runs)}</div>
          <div className="dash-stat-label">AI runs in period</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon">🔢</div>
          <div className="dash-stat-value">{fmtNum(totals.tokens)}</div>
          <div className="dash-stat-label">Tokens in period</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon">💲</div>
          <div className="dash-stat-value">{fmtUsd(totals.cost)}</div>
          <div className="dash-stat-label">Est. cost in period</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon">📊</div>
          <div className="dash-stat-value">
            {totals.runs > 0 ? fmtUsd(totals.cost / totals.runs) : '—'}
          </div>
          <div className="dash-stat-label">Avg cost / run</div>
        </div>
      </div>

      {isLoading && (
        <p className="mon-empty" style={{ padding: 24 }}>Loading history…</p>
      )}
      {!isLoading && !ok && (
        <p className="mon-empty" style={{ padding: 24 }}>Failed to load usage history.</p>
      )}
      {!isLoading && ok && noData && (
        <p className="mon-empty" style={{ padding: 24 }}>No AI usage in this period.</p>
      )}

      {!isLoading && ok && !noData && (
        <>
          {/* Row 1: time series + by-feature donut */}
          <div className="dash-chart-row" style={{ gridTemplateColumns: includedFeatures.length > 1 ? '2fr 1fr' : '1fr' }}>
            <div className="dash-chart-card">
              <div className="dash-chart-header">
                <span className="dash-chart-title">
                  {metric === 'cost' ? 'Cost' : metric === 'tokens' ? 'Tokens' : 'AI runs'} over time
                </span>
                <span className="dash-chart-sub">
                  per {gran}{metric === 'cost' ? ' · pre-tracking summaries rows are blended estimates' : ''}
                </span>
              </div>
              <div className="dash-canvas-wrap">
                <HistTimeChart
                  buckets={buckets}
                  gran={gran}
                  featMaps={featMaps}
                  includedFeatures={includedFeatures}
                  metric={metric}
                />
              </div>
            </div>
            {includedFeatures.length > 1 && (
              <div className="dash-chart-card">
                <div className="dash-chart-header">
                  <span className="dash-chart-title">
                    {metric === 'cost' ? 'Cost' : metric === 'tokens' ? 'Tokens' : 'Runs'} by feature
                  </span>
                </div>
                <div className="dash-canvas-wrap">
                  <HistFeatureDonut features={features} includedFeatures={includedFeatures} metric={metric} />
                </div>
              </div>
            )}
          </div>

          {/* Row 2: by-user chart + user × feature cost matrix */}
          <div className="dash-chart-row" style={{ gridTemplateColumns: '1fr 2fr' }}>
            <div className="dash-chart-card">
              <div className="dash-chart-header">
                <span className="dash-chart-title">
                  {metric === 'cost' ? 'Cost' : metric === 'tokens' ? 'Tokens' : 'Runs'} by user
                </span>
              </div>
              <div className="dash-canvas-wrap">
                <HistUsersBar rows={byUser} metric={metric} />
              </div>
            </div>
            <div className="dash-chart-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="dash-chart-header" style={{ padding: '16px 20px 8px' }}>
                <span className="dash-chart-title">Cost by user × feature</span>
                <span className="dash-chart-sub">caps are monthly ($)</span>
              </div>
              <HistUserMatrix rows={byUser} includedFeatures={includedFeatures} />
            </div>
          </div>

          {/* Row 3: by-model cost breakdown + breakdown tables */}
          <div className="dash-chart-row" style={{ gridTemplateColumns: '1fr' }}>
            <div className="dash-chart-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="dash-chart-header" style={{ padding: '16px 20px 8px' }}>
                <span className="dash-chart-title">Cost by model</span>
                <span className="dash-chart-sub">current $/1M rates · edit in Model Pricing below</span>
              </div>
              <HistModelTable rows={byModel} />
            </div>
          </div>
          <div className="dash-chart-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="dash-chart-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="dash-chart-header" style={{ padding: '16px 20px 8px' }}>
                <span className="dash-chart-title">By user</span>
              </div>
              <HistBreakdownTable
                rows={byUser.map((r) => ({
                  label: r.username,
                  runs: r.total.runs,
                  tokens: r.total.tokens,
                  cost: r.total.cost
                }))}
              />
            </div>
            <div className="dash-chart-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="dash-chart-header" style={{ padding: '16px 20px 8px' }}>
                <span className="dash-chart-title">Top bots (summaries)</span>
              </div>
              <HistBreakdownTable
                rows={byBot.map((r) => ({
                  label: r.bot_name,
                  runs: +r.runs || 0,
                  tokens: +r.tokens || 0,
                  cost: +r.cost || 0
                }))}
              />
            </div>
          </div>
        </>
      )}

      {/* Model pricing editor */}
      <PricingCard />
    </>
  );
}

function HistBreakdownTable({ rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="yt-table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th style={{ textAlign: 'center' }}>Runs</th>
            <th style={{ textAlign: 'right' }}>Tokens</th>
            <th style={{ textAlign: 'right', paddingRight: 20 }}>Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>—</td>
            </tr>
          ) : (
            rows.slice(0, 10).map((r, i) => (
              <tr key={i}>
                <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.label}
                </td>
                <td style={{ textAlign: 'center' }}>{fmtNum(r.runs)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {r.tokens > 0 ? r.tokens.toLocaleString() : '—'}
                </td>
                <td style={{ textAlign: 'right', paddingRight: 20, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {fmtUsd(r.cost)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function HistModelTable({ rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="yt-table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>Model</th>
            <th style={{ textAlign: 'center' }}>Runs</th>
            <th style={{ textAlign: 'right' }}>Tokens</th>
            <th style={{ textAlign: 'right' }}>Input $/1M</th>
            <th style={{ textAlign: 'right' }}>Output $/1M</th>
            <th style={{ textAlign: 'right', paddingRight: 20 }}>Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>—</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.model}>
                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.model}</td>
                <td style={{ textAlign: 'center' }}>{fmtNum(r.runs)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {(r.tokens || 0).toLocaleString()}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>${r.rate_input}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>${r.rate_output}</td>
                <td style={{ textAlign: 'right', paddingRight: 20, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                  {fmtUsd(r.cost)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function HistUserMatrix({ rows, includedFeatures }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="yt-table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>User</th>
            {includedFeatures.map((f) => (
              <th key={f.key} style={{ textAlign: 'right' }}>{f.label}</th>
            ))}
            <th style={{ textAlign: 'right' }}>Total</th>
            <th style={{ textAlign: 'right', paddingRight: 20 }}>Monthly cap</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={includedFeatures.length + 3}
                  style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>—</td>
            </tr>
          ) : (
            rows.map((r, i) => {
              const caps = r.cost_caps || {};
              const totalCap = caps.total;
              const capPct = totalCap > 0 ? (r.total.cost / totalCap) * 100 : null;
              return (
                <tr key={r.user_id ?? `u${i}`}>
                  <td style={{ fontWeight: 600 }}>{r.username}</td>
                  {includedFeatures.map((f) => {
                    const cell = r.features?.[f.key] || {};
                    const cap = caps[f.key];
                    return (
                      <td key={f.key} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                          title={`${fmtNum(cell.runs || 0)} runs · ${fmtNum(cell.tokens || 0)} tokens`}>
                        {cell.cost > 0 ? fmtUsd(cell.cost) : '—'}
                        {cap != null && (
                          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}> / {fmtUsd(cap)}</span>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtUsd(r.total.cost)}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: 20, fontVariantNumeric: 'tabular-nums' }}>
                    {totalCap != null ? (
                      <span style={capPct >= 100 ? { color: '#ef4444', fontWeight: 700 }
                        : capPct >= 80 ? { color: '#f59e0b', fontWeight: 700 } : undefined}>
                        {fmtUsd(totalCap)}{capPct != null ? ` (${Math.min(999, Math.round(capPct))}%)` : ''}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>no cap</span>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function HistTimeChart({ buckets, gran, featMaps, includedFeatures, metric }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (!ref.current || !window.Chart) return undefined;
    const th = chartTheme();
    const pal = histPalette();
    const labels = buckets.map((b) => fmtBucket(b, gran));
    const datasets = includedFeatures.map((f) => ({
      label: f.label,
      data: buckets.map((b) => +(featMaps[f.key]?.[b]?.[metric]) || 0),
      backgroundColor: pal[f.key],
      borderColor: th.surface,
      borderWidth: 1,
      borderRadius: 4
    }));
    const isCost = metric === 'cost';
    chartRef.current = new window.Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: datasets.length > 1
            ? { position: 'top', labels: { color: th.legend, boxWidth: 10, font: { size: 11 } } }
            : { display: false },
          tooltip: {
            ...th.tooltip,
            callbacks: isCost
              ? { label: (ctx) => `${ctx.dataset.label}: ${fmtUsd(ctx.parsed.y)}` }
              : undefined
          }
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { ...th.ticks, maxTicksLimit: 16 } },
          y: {
            stacked: true, grid: th.grid, beginAtZero: true,
            ticks: isCost ? { ...th.ticks, callback: (v) => fmtUsd(v) } : th.ticks
          }
        }
      }
    });
    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    };
  }, [buckets, gran, featMaps, includedFeatures, metric]);
  return <canvas ref={ref} />;
}

function HistFeatureDonut({ features, includedFeatures, metric }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (!ref.current || !window.Chart) return undefined;
    const th = chartTheme();
    const pal = histPalette();
    const isCost = metric === 'cost';
    chartRef.current = new window.Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels: includedFeatures.map((f) => f.label),
        datasets: [{
          data: includedFeatures.map((f) => +(features[f.key]?.total?.[metric]) || 0),
          backgroundColor: includedFeatures.map((f) => pal[f.key]),
          borderColor: th.surface,
          borderWidth: 2,
          hoverBorderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: th.legend, font: { size: 11 }, padding: 10, boxWidth: 10 }
          },
          tooltip: {
            ...th.tooltip,
            callbacks: isCost
              ? { label: (ctx) => `${ctx.label}: ${fmtUsd(ctx.parsed)}` }
              : undefined
          }
        }
      }
    });
    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    };
  }, [features, includedFeatures, metric]);
  return <canvas ref={ref} />;
}

function HistUsersBar({ rows, metric }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (!ref.current || !window.Chart || !rows?.length) return undefined;
    const th = chartTheme();
    const top = rows.slice(0, 10);
    const isCost = metric === 'cost';
    chartRef.current = new window.Chart(ref.current, {
      type: 'bar',
      data: {
        labels: top.map((r) => r.username),
        datasets: [{
          label: metric,
          data: top.map((r) => +(r.total?.[metric]) || 0),
          backgroundColor: `rgba(${th.accentRgb},0.65)`,
          borderColor: th.accent,
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...th.tooltip,
            callbacks: isCost
              ? { label: (ctx) => fmtUsd(ctx.parsed.x) }
              : undefined
          }
        },
        scales: {
          x: {
            grid: th.grid, beginAtZero: true,
            ticks: isCost ? { ...th.ticks, callback: (v) => fmtUsd(v) } : th.ticks
          },
          y: { grid: { display: false }, ticks: { ...th.ticks, font: { size: 10 } } }
        }
      }
    });
    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    };
  }, [rows, metric]);
  return <canvas ref={ref} />;
}

// ────────────────────────────────────────────────────────────────────────────
// Model pricing editor — $/1M token rates per model + blended input ratio.
// Rates feed every cost figure on this page and the monthly $ caps.
// ────────────────────────────────────────────────────────────────────────────

function PricingCard() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['ai-pricing'],
    queryFn: () => api('/api/system/ai-pricing')
  });

  const [models, setModels] = useState({});
  const [ratio, setRatio] = useState('0.85');
  useEffect(() => {
    if (data?.status === 'ok') {
      setModels(data.models || {});
      setRatio(String(data.input_ratio ?? 0.85));
    }
  }, [data]);

  const save = useApiMutation('/api/system/ai-pricing', {
    invalidate: ['ai-pricing', 'ai-usage-history'],
    successMsg: 'Pricing saved',
    errorMsg: 'Failed to save pricing'
  });

  function setRate(model, field, value) {
    setModels((cur) => ({
      ...cur,
      [model]: { ...cur[model], [field]: value }
    }));
  }

  function onSave() {
    const cleaned = {};
    for (const [m, r] of Object.entries(models)) {
      const inp = parseFloat(r.input);
      const out = parseFloat(r.output);
      if (Number.isFinite(inp) && Number.isFinite(out) && inp >= 0 && out >= 0) {
        cleaned[m] = { input: inp, output: out };
      }
    }
    const num = parseFloat(ratio);
    save.mutate({
      models: cleaned,
      input_ratio: Number.isFinite(num) && num >= 0 && num <= 1 ? num : undefined
    });
  }

  return (
    <div className="card" style={{ marginTop: '1.25rem' }}>
      <div
        className="card-header"
        style={{ gap: '.75rem', cursor: 'pointer' }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ fontSize: '1.1rem' }}>💲</span>
        <strong>Model Pricing</strong>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
          $ per 1M tokens · drives all cost figures {open ? '▲' : '▼'}
        </span>
      </div>
      {open && (
        <div className="card-body" style={{ padding: '1rem 1.25rem' }}>
          {isLoading ? (
            <p className="text-muted">Loading…</p>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="yt-table" style={{ fontSize: 12, maxWidth: 560 }}>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th style={{ textAlign: 'right' }}>Input $/1M</th>
                      <th style={{ textAlign: 'right' }}>Output $/1M</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(models).sort().map((m) => (
                      <tr key={m}>
                        <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{m}</td>
                        <td style={{ textAlign: 'right' }}>
                          <input type="number" className="input" min="0" step="0.01"
                            style={{ width: 90, textAlign: 'right' }}
                            value={models[m]?.input ?? ''}
                            onChange={(e) => setRate(m, 'input', e.target.value)} />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <input type="number" className="input" min="0" step="0.01"
                            style={{ width: 90, textAlign: 'right' }}
                            value={models[m]?.output ?? ''}
                            onChange={(e) => setRate(m, 'output', e.target.value)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Blended input ratio (summaries estimate):
                </span>
                <input type="number" className="input" min="0" max="1" step="0.05"
                  style={{ width: 80 }}
                  value={ratio}
                  onChange={(e) => setRatio(e.target.value)} />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Share of a combined token total priced as input when no split was recorded.
                </span>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={onSave}
                  disabled={save.isPending}
                >
                  {save.isPending ? 'Saving…' : 'Save pricing'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Components
// ────────────────────────────────────────────────────────────────────────────

function Meter({ label, used, limit }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const cls = pctClass(pct);
  const pctStr = pct.toFixed(1) + '%';
  return (
    <div className="aiu-meter">
      <div className="aiu-meter-label">
        <span>{label}</span>
        <span className="aiu-meter-vals">
          {fmtNum(used)} / {fmtNum(limit)}
        </span>
      </div>
      <div className="aiu-bar-track">
        <div
          className={`aiu-bar-fill aiu-bar-${cls}`}
          style={{ width: pctStr }}
        />
      </div>
      <div className="aiu-bar-pct">{pctStr}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function buildMeters(live, limits) {
  const tpm = live.tpm || {};
  const rpm = live.rpm || {};
  const rpd = live.rpd || {};
  return [
    {
      label: 'Tokens / min',
      used: tpm.used || 0,
      limit: tpm.limit || limits.tpm || 2_000_000
    },
    {
      label: 'Requests / min',
      used: rpm.used || 0,
      limit: rpm.limit || limits.rpm || 30_000
    },
    {
      label: 'Requests today',
      used: rpd.used || 0,
      limit: rpd.limit || limits.rpd || 100_000
    }
  ];
}

function buildWarnings(meters) {
  const out = [];
  for (const m of meters) {
    const pct = m.limit > 0 ? (m.used / m.limit) * 100 : 0;
    if (pct >= 85) {
      out.push(
        `⚠ ${m.label} is at ${pct.toFixed(0)}% — consider pausing heavy schedules.`
      );
    } else if (pct >= 60) {
      out.push(`ℹ ${m.label} is at ${pct.toFixed(0)}%.`);
    }
  }
  return out;
}

function pctClass(pct) {
  if (pct >= 85) return 'danger';
  if (pct >= 60) return 'warn';
  return 'ok';
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function relTime(iso) {
  if (!iso) return '—';
  const d0 = new Date(iso);
  if (isNaN(d0.getTime())) return '—';
  const diff = Math.floor((Date.now() - d0.getTime()) / 1000);
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function fmtHour(isoHour) {
  if (!isoHour) return '—';
  // Accept both 'T' and ' ' separators — psycopg2 may return either depending on tz config.
  const m = String(isoHour).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})/);
  if (!m) return '—';
  return `${m[3]}/${m[2]} ${m[4]}:00`;
}

// ────────────────────────────────────────────────────────────────────────────
// Gemini "thinking" toggle (Gemini 2.5 extended reasoning)
//
// When ON, the model is allowed to spend extra tokens reasoning before it
// answers. Backend reads the system setting and passes a ThinkingConfig to
// every Gemini call from the summarizer.
// ────────────────────────────────────────────────────────────────────────────

function ThinkingToggleCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['gemini-thinking'],
    queryFn: () => api('/api/system/gemini-thinking')
  });

  // Optimistic local state — flips immediately on click instead of waiting
  // for the POST + refetch roundtrip. Synced from server data when it arrives.
  const [localEnabled, setLocalEnabled] = useState(false);
  const [localBudget, setLocalBudget] = useState(-1);
  useEffect(() => {
    if (data?.status === 'ok') {
      setLocalEnabled(!!data.enabled);
      setLocalBudget(Number.isFinite(data.budget) ? data.budget : -1);
    }
  }, [data?.status, data?.enabled, data?.budget]);

  const update = useApiMutation('/api/system/gemini-thinking', {
    invalidate: ['gemini-thinking'],
    successMsg: 'Thinking setting updated',
    errorMsg: 'Failed to update thinking setting',
    // On error, snap back to whatever the server actually has.
    onError: () => {
      if (data?.status === 'ok') {
        setLocalEnabled(!!data.enabled);
        setLocalBudget(Number.isFinite(data.budget) ? data.budget : -1);
      }
    }
  });

  const enabled = localEnabled;
  const budget = localBudget;

  function setEnabled(next) {
    setLocalEnabled(next);                    // optimistic
    update.mutate({ enabled: next, budget });
  }

  function setBudget(next) {
    setLocalBudget(next);                     // optimistic
    update.mutate({ enabled, budget: next });
  }

  return (
    <div className="card" style={{ marginBottom: '1.25rem' }}>
      <div className="card-header" style={{ gap: '.75rem' }}>
        <span style={{ fontSize: '1.1rem' }}>🧠</span>
        <strong>Extended Thinking</strong>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
          Gemini 2.5 reasoning mode
        </span>
      </div>
      <div className="card-body" style={{ padding: '1rem 1.25rem' }}>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
          When on, Gemini may spend extra tokens internally reasoning before producing
          each summary. Improves quality for complex prompts but increases token usage.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={isLoading || update.isPending}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
          <strong style={{ fontSize: 13 }}>
            {enabled ? 'Thinking enabled' : 'Thinking disabled'}
          </strong>
        </div>

        {enabled && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Budget:</span>
            <select
              className="select"
              value={budget === -1 ? 'dynamic' : budget === 0 ? 'off' : 'custom'}
              disabled={update.isPending}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'dynamic') setBudget(-1);
                else if (v === 'off') setBudget(0);
                else setBudget(Math.max(1, budget > 0 ? budget : 1024));
              }}
              style={{ width: 200 }}
            >
              <option value="dynamic">Dynamic (model decides)</option>
              <option value="off">Off (no thinking tokens)</option>
              <option value="custom">Custom cap</option>
            </select>
            {budget > 0 && (
              <input
                type="number"
                className="input"
                min="1"
                step="128"
                value={budget}
                disabled={update.isPending}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0) setBudget(n);
                }}
                style={{ width: 130 }}
                title="Max thinking tokens per call"
              />
            )}
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {budget === -1 && '−1 = model self-regulates how much to think.'}
              {budget === 0 && '0 = thinking is suppressed (same as toggle off).'}
              {budget > 0 && 'Hard cap on thinking tokens per request.'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Gemini model picker
//
// Picks the PRIMARY model (sent to Telegram + used everywhere a single model is
// needed) and an optional set of COMPARE models. When compare models are set,
// the scheduler also runs each of them on the same input as an A/B test — those
// outputs are stored and viewable in the History popup / export, never sent.
// Stored as a system setting; overrides config.yaml at runtime — no redeploy.
// ────────────────────────────────────────────────────────────────────────────

function GeminiModelCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['gemini-model'],
    queryFn: () => api('/api/system/gemini-model')
  });

  // Optimistic local state so the controls reflect the click immediately.
  const [primary, setPrimaryState] = useState('');
  const [compare, setCompareState] = useState([]);
  useEffect(() => {
    if (data?.status === 'ok') {
      if (data.primary) setPrimaryState(data.primary);
      setCompareState(Array.isArray(data.compare) ? data.compare : []);
    }
  }, [data?.status, data?.primary, data?.compare]);

  const update = useApiMutation('/api/system/gemini-model', {
    invalidate: ['gemini-model'],
    successMsg: 'Gemini model updated',
    errorMsg: 'Failed to update Gemini model',
    onError: () => {
      if (data?.status === 'ok') {
        setPrimaryState(data.primary || '');
        setCompareState(Array.isArray(data.compare) ? data.compare : []);
      }
    }
  });

  const options = (data?.status === 'ok' && Array.isArray(data.options)) ? data.options : [];
  const busy = isLoading || update.isPending || !options.length;

  function save(nextPrimary, nextCompare) {
    // A model can't be both primary and a compare target.
    const cleaned = nextCompare.filter((m) => m !== nextPrimary);
    setPrimaryState(nextPrimary);                 // optimistic
    setCompareState(cleaned);
    update.mutate({ primary: nextPrimary, compare: cleaned });
  }

  function setPrimary(next) {
    save(next, compare);
  }

  function toggleCompare(m) {
    const next = compare.includes(m)
      ? compare.filter((x) => x !== m)
      : [...compare, m];
    save(primary, next);
  }

  return (
    <div className="card" style={{ marginBottom: '1.25rem' }}>
      <div className="card-header" style={{ gap: '.75rem' }}>
        <span style={{ fontSize: '1.1rem' }}>🤖</span>
        <strong>Gemini Model</strong>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
          Applies to summaries, chatbots & YouTube
        </span>
      </div>
      <div className="card-body" style={{ padding: '1rem 1.25rem' }}>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
          The <strong>primary</strong> model is what gets sent to Telegram and used
          for all single-model calls. (Fast helper calls like chatbot search
          expansion always use flash-lite.)
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 120 }}>Primary (sent):</span>
          <select
            className="select"
            value={primary}
            disabled={busy}
            onChange={(e) => setPrimary(e.target.value)}
            style={{ width: 240 }}
          >
            {!options.includes(primary) && primary && <option value={primary}>{primary}</option>}
            {options.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 120, paddingTop: 4 }}>
            Also compare:
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {options.filter((m) => m !== primary).map((m) => (
              <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={compare.includes(m)}
                  disabled={busy}
                  onChange={() => toggleCompare(m)}
                />
                {m}
              </label>
            ))}
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {compare.length
                ? `⚠ Each scheduled summary runs ${compare.length + 1} models — ~${compare.length + 1}× the tokens. Alternates are viewable in History → View, not sent.`
                : 'None — single-model mode (no extra cost).'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

