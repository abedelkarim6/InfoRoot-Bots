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

import { useEffect, useState } from 'react';
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

