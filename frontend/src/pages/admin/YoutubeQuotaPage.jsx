/**
 * YouTube API Quota — admin page.
 *
 * Mirrors AiUsagePage. YouTube Data API v3 charges "quota units" per call
 * against a daily budget (Google default: 10,000 units/day, resets midnight
 * Pacific). Searching one word costs 100 units; fetching video details costs
 * 1. This page shows today's burn vs the limit, an hourly breakdown, and the
 * most recent API calls so the admin can avoid exhausting the quota.
 *
 * Auto-refresh every 15s via TanStack Query (stops when the page unmounts).
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import PageHeader from '../../components/PageHeader';

export default function YoutubeQuotaPage() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['youtube-quota-details'],
    queryFn: () => api('/api/system/youtube-quota-details'),
    refetchInterval: 15000,
    refetchIntervalInBackground: false
  });

  const ok = data?.status === 'ok';
  const today = ok ? (data.today || {}) : {};
  const limit = ok ? (data.limit || 10000) : 10000;
  const hourly = ok ? (data.hourly || []) : [];
  const recent = ok ? (data.recent || []) : [];
  const costs = ok ? (data.costs || {}) : {};

  const used = today.units || 0;
  const remaining = Math.max(0, limit - used);
  const searchCost = costs['search.list'] || 100;
  // ~1 details call per search → cost of one word search ≈ searchCost + 1
  const searchesLeft = Math.floor(remaining / (searchCost + 1));
  const pct = limit > 0 ? (used / limit) * 100 : 0;

  return (
    <div className="page active">
      <PageHeader
        title="📺 YouTube Quota"
        subtitle="YouTube Data API quota burn, hourly breakdown, and recent API calls."
      />

      {isLoading && <p className="mon-empty" style={{ padding: 40 }}>Loading…</p>}

      {!isLoading && !ok && (
        <p className="mon-empty" style={{ padding: 40 }}>
          {data?.message || 'Failed to load YouTube quota data.'}
        </p>
      )}

      {!isLoading && ok && (
        <>
          {/* Section 1: Live daily quota */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card-header" style={{ gap: '.75rem' }}>
              <span style={{ fontSize: '1.1rem' }}>📊</span>
              <strong>Daily Quota</strong>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                resets midnight Pacific · auto-refreshes every 15s
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
              style={{ display: 'flex', flexWrap: 'wrap', gap: '1.75rem 2.5rem' }}
            >
              <Meter label="Units used today" used={used} limit={limit} />
            </div>
            {pct >= 60 && (
              <div
                style={{
                  padding: '.5rem 1.25rem .75rem',
                  fontSize: 12,
                  color: 'var(--warning,#f59e0b)',
                  borderTop: '1px solid var(--border-color)'
                }}
              >
                {pct >= 85
                  ? `⚠ Daily quota is at ${pct.toFixed(0)}% — searches will start failing when it hits 100%. Reduce the number of tracked words or raise the interval.`
                  : `ℹ Daily quota is at ${pct.toFixed(0)}%.`}
              </div>
            )}
          </div>

          {/* Section 2: Today totals */}
          <div className="dash-stat-grid" style={{ marginBottom: '1.25rem' }}>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">🔢</div>
              <div className="dash-stat-value">{fmtNum(used)}</div>
              <div className="dash-stat-label">Units used today</div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">🪫</div>
              <div className="dash-stat-value">{fmtNum(remaining)}</div>
              <div className="dash-stat-label">Units remaining</div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">🔎</div>
              <div className="dash-stat-value">{today.search_calls || 0}</div>
              <div className="dash-stat-label">Searches today (×{searchCost})</div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">⏳</div>
              <div className="dash-stat-value">{fmtNum(searchesLeft)}</div>
              <div className="dash-stat-label">Searches left today (est.)</div>
            </div>
          </div>

          {/* Section 3: Cost explainer */}
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <div className="card-header">
              <strong>💡 How the quota works</strong>
            </div>
            <div className="card-body" style={{ fontSize: 13, lineHeight: 1.6 }}>
              <p style={{ marginTop: 0 }}>
                Each YouTube API call spends quota units from a daily budget of{' '}
                <strong>{fmtNum(limit)}</strong> units (Google's default is 10,000).
                When the budget is gone, searches fail until midnight Pacific.
              </p>
              <table className="yt-table" style={{ maxWidth: 460 }}>
                <thead>
                  <tr>
                    <th>Call</th>
                    <th>What it does</th>
                    <th style={{ textAlign: 'center' }}>Units</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><span className="tag-blue">search.list</span></td>
                    <td>Search one word</td>
                    <td style={{ textAlign: 'center', fontWeight: 700 }}>{costs['search.list'] ?? 100}</td>
                  </tr>
                  <tr>
                    <td><span className="tag-green">videos.list</span></td>
                    <td>Fetch details (≤50 videos)</td>
                    <td style={{ textAlign: 'center', fontWeight: 700 }}>{costs['videos.list'] ?? 1}</td>
                  </tr>
                </tbody>
              </table>
              <p style={{ marginBottom: 0, color: 'var(--text-muted)' }}>
                So one word searched every hour ≈ {searchCost + 1} × 24 ≈{' '}
                <strong>{fmtNum((searchCost + 1) * 24)}</strong> units/day. At{' '}
                {fmtNum(limit)} units/day that's about{' '}
                <strong>{Math.floor(limit / ((searchCost + 1) * 24))}</strong> words at hourly cadence.
              </p>
            </div>
          </div>

          {/* Section 4: Hourly activity */}
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
                  <col style={{ width: 140 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 120 }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Hour</th>
                    <th style={{ textAlign: 'center' }}>Units</th>
                    <th style={{ textAlign: 'center' }}>Searches</th>
                    <th style={{ textAlign: 'center' }}>Detail calls</th>
                  </tr>
                </thead>
                <tbody>
                  {hourly.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>
                        No API calls in last 24 hours
                      </td>
                    </tr>
                  ) : (
                    hourly.map((row, i) => (
                      <tr key={i}>
                        <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', fontSize: 12 }}>
                          {fmtHour(row.hour_lbn)}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>{fmtNum(row.units || 0)}</td>
                        <td style={{ textAlign: 'center' }}>{row.search_calls || 0}</td>
                        <td style={{ textAlign: 'center' }}>{row.video_calls || 0}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 5: Recent API calls */}
          <div className="card">
            <div className="card-header">
              <strong>🕐 Recent API Calls</strong>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(last 100)</span>
            </div>
            <div className="aiu-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="yt-table">
                <colgroup>
                  <col style={{ width: 110 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 80 }} />
                  <col />
                  <col style={{ width: 130 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Call</th>
                    <th style={{ textAlign: 'center' }}>Units</th>
                    <th style={{ textAlign: 'left' }}>Context</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>
                        No API calls recorded yet
                      </td>
                    </tr>
                  ) : (
                    recent.map((row, i) => (
                      <tr key={row.id ?? i}>
                        <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 12 }}>
                          {relTime(row.created_at)}
                        </td>
                        <td>
                          <span className={row.call_type === 'search.list' ? 'tag-blue' : 'tag-green'}>
                            {row.call_type}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>{row.units}</td>
                        <td
                          style={{
                            fontSize: 12, color: 'var(--text-secondary)', maxWidth: 240,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left'
                          }}
                          title={row.context || ''}
                        >
                          {row.context || '—'}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{row.source || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Components & helpers (kept local — mirrors AiUsagePage)
// ────────────────────────────────────────────────────────────────────────────

function Meter({ label, used, limit }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const cls = pctClass(pct);
  const pctStr = pct.toFixed(1) + '%';
  return (
    <div className="aiu-meter" style={{ minWidth: 280 }}>
      <div className="aiu-meter-label">
        <span>{label}</span>
        <span className="aiu-meter-vals">{fmtNum(used)} / {fmtNum(limit)}</span>
      </div>
      <div className="aiu-bar-track">
        <div className={`aiu-bar-fill aiu-bar-${cls}`} style={{ width: pctStr }} />
      </div>
      <div className="aiu-bar-pct">{pctStr}</div>
    </div>
  );
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
  const m = String(isoHour).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})/);
  if (!m) return '—';
  return `${m[3]}/${m[2]} ${m[4]}:00`;
}
