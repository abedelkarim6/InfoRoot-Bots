/**
 * YouTube Schedules — forecast + summary of the SEO search scheduler and the
 * channel monitoring status. Mirrors the Schedules Monitor page pattern.
 *
 *  - Forecast tab: the next 24h of SEO (keyword/word) searches projected from
 *    each word's budget-aware effective interval, with a live countdown, plus a
 *    channel-status panel (channels are push-based via WebSub, so they are shown
 *    as status — last video, videos today, subscription renewal — not forecast).
 *  - Summary tab: per-keyword sent vs remaining today, plus a channel summary.
 *
 * Backend: GET /api/youtube/schedules/forecast and /summary (admin only).
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import PageHeader from '../../components/PageHeader';
import { useUrlString } from '../../lib/useUrlState';
import { fmtBeirutTime, fmtBeirutDate, formatDuration } from '../monitor/shared';
import { timeAgo } from './shared';

const TABS = [
  { id: 'forecast', label: '🔮 Forecast (24h)' },
  { id: 'summary', label: '📊 Summary' }
];
const VALID_TABS = new Set(TABS.map((t) => t.id));

const HORIZON_MS = 24 * 3600 * 1000;
const PER_WORD_CAP = 48; // safety cap on projected fires per word
const TOTAL_ROW_CAP = 600; // safety cap on rendered timeline rows

export default function SchedulesPage() {
  const [tab, setTab] = useUrlString('tab', 'forecast');
  const activeTab = VALID_TABS.has(tab) ? tab : 'forecast';

  return (
    <div className="page active">
      <PageHeader
        title="YouTube Schedules"
        subtitle="Upcoming SEO searches and channel monitoring status"
      />
      <div className="mon-tab-bar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`mon-tab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id, { push: true })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'forecast' ? <ForecastTab /> : <SummaryTab />}
    </div>
  );
}

/* ───────────────────────── Forecast tab ───────────────────────── */

function buildForecastRows(words, anchorMs, nowMs) {
  const rows = [];
  const endMs = nowMs + HORIZON_MS;
  for (const w of words || []) {
    const effMin = w.effective_interval_min || w.configured_interval_min || 60;
    const eff = effMin * 60000;
    if (eff <= 0) continue;
    let t = anchorMs + (w.next_run_in_min || 0) * 60000;
    // If the fetch anchor is stale, fast-forward past "now".
    let guard = 0;
    while (t < nowMs && guard < 100000) {
      t += eff;
      guard += 1;
    }
    let count = 0;
    while (t <= endMs && count < PER_WORD_CAP) {
      rows.push({
        fireAtMs: t,
        keyword: w.keyword,
        word: w.word,
        isSub: w.is_sub,
        priority: w.priority,
        effMin
      });
      t += eff;
      count += 1;
    }
  }
  rows.sort((a, b) => a.fireAtMs - b.fireAtMs);
  return rows;
}

function ForecastTab() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ['yt-sched-forecast'],
    queryFn: async () => {
      const res = await api('/api/youtube/schedules/forecast');
      if (res?.status !== 'ok') throw new Error(res?.message || 'Failed to load forecast.');
      return res;
    },
    refetchInterval: 60000
  });

  // Live 1s tick for countdowns.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const seoWords = data?.seo_words || [];
  const channels = data?.channels || [];
  const budget = data?.budget || {};

  const allRows = useMemo(
    () => buildForecastRows(seoWords, dataUpdatedAt || Date.now(), nowMs),
    [seoWords, dataUpdatedAt, nowMs]
  );
  const rows = allRows.slice(0, TOTAL_ROW_CAP);
  const truncated = allRows.length > rows.length;

  if (isLoading) return <div className="mon-empty">Loading forecast…</div>;
  if (isError) return <div className="mon-empty">⚠️ {String(error?.message || error)}</div>;

  return (
    <>
      <BudgetBar budget={budget} />

      <h3 className="yt-sched-h">📅 Upcoming SEO searches — next 24h</h3>
      {budget.paused && (
        <div className="mon-empty" style={{ color: 'var(--danger)' }}>
          ⏸ Daily quota budget reached — searches are paused until it resets.
        </div>
      )}
      {rows.length === 0 ? (
        <div className="mon-empty">No SEO searches scheduled in the next 24 hours.</div>
      ) : (
        <table className="mon-table sch-timeline-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>In</th>
              <th>Keyword</th>
              <th>Search term</th>
              <th>Priority</th>
              <th>Every</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const prevDay = i > 0 ? fmtBeirutDate(rows[i - 1].fireAtMs) : null;
              const day = fmtBeirutDate(r.fireAtMs);
              const showSep = day !== prevDay;
              const countdown = r.fireAtMs - nowMs;
              return (
                <FragmentRow
                  key={`${r.keyword}|${r.word}|${r.fireAtMs}`}
                  showSep={showSep}
                  day={day}
                  r={r}
                  countdown={countdown}
                />
              );
            })}
          </tbody>
        </table>
      )}
      {truncated && (
        <div className="mon-empty">
          Showing the first {TOTAL_ROW_CAP} searches; more are scheduled beyond this.
        </div>
      )}

      <h3 className="yt-sched-h">📺 Channel monitoring (push via WebSub)</h3>
      <div className="mon-empty" style={{ textAlign: 'left', margin: '4px 0 8px' }}>
        Channels are notified in real time when they publish — there is no fixed
        search interval to forecast. Status shown below.
      </div>
      <ChannelTable channels={channels} mode="forecast" />
    </>
  );
}

function FragmentRow({ showSep, day, r, countdown }) {
  return (
    <>
      {showSep && (
        <tr className="sch-date-sep">
          <td colSpan={6}>{day}</td>
        </tr>
      )}
      <tr>
        <td>{fmtBeirutTime(r.fireAtMs)}</td>
        <td className="text-muted">
          {countdown <= 0 ? 'now' : formatDuration(countdown)}
        </td>
        <td>{r.keyword}</td>
        <td>
          {r.word}
          {r.isSub && <span className="yt-filter-tag" style={{ marginLeft: 6 }}>sub</span>}
        </td>
        <td>
          <PriorityBadge priority={r.priority} />
        </td>
        <td className="text-muted">{fmtEvery(r.effMin)}</td>
      </tr>
    </>
  );
}

/* ───────────────────────── Summary tab ───────────────────────── */

function SummaryTab() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['yt-sched-summary'],
    queryFn: async () => {
      const res = await api('/api/youtube/schedules/summary');
      if (res?.status !== 'ok') throw new Error(res?.message || 'Failed to load summary.');
      return res;
    },
    refetchInterval: 60000
  });

  if (isLoading) return <div className="mon-empty">Loading summary…</div>;
  if (isError) return <div className="mon-empty">⚠️ {String(error?.message || error)}</div>;

  const keywords = data?.keywords || [];
  const channels = data?.channels || [];

  return (
    <>
      <BudgetBar budget={data} />

      <h3 className="yt-sched-h">🔎 SEO keywords — sent &amp; remaining today</h3>
      {keywords.length === 0 ? (
        <div className="mon-empty">No active keywords.</div>
      ) : (
        <table className="mon-table">
          <thead>
            <tr>
              <th>Keyword</th>
              <th>Priority</th>
              <th>Words</th>
              <th>Interval</th>
              <th>Status</th>
              <th>Done today</th>
              <th>Remaining</th>
              <th>Expected</th>
              <th>Yield (7d)</th>
            </tr>
          </thead>
          <tbody>
            {keywords.map((k) => (
              <tr key={k.keyword_id}>
                <td>{k.keyword}</td>
                <td>
                  <PriorityBadge priority={k.priority} />
                </td>
                <td className="text-muted">{k.word_count}</td>
                <td className="text-muted">
                  {fmtEvery(k.configured_interval_min)}
                  {k.status === 'rotated' && (
                    <> → {fmtEvery(Math.round(k.effective_interval_min))}</>
                  )}
                </td>
                <td>
                  <span
                    className={`mon-type-badge ${k.status === 'rotated' ? 'daily' : 'hourly'}`}
                  >
                    {k.status === 'rotated' ? 'rotated' : 'on-time'}
                  </span>
                </td>
                <td>{k.searches_today}</td>
                <td>
                  <span className={`mon-pending ${k.remaining_today > 0 ? 'has' : 'none'}`}>
                    {k.remaining_today}
                  </span>
                </td>
                <td className="text-muted">{k.expected_today}</td>
                <td className="text-muted">
                  {k.yield_per_search} ({k.found_7d}/{k.searches_7d})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="yt-sched-h">📺 Channels — videos today</h3>
      <ChannelTable channels={channels} mode="summary" />
    </>
  );
}

/* ───────────────────────── shared bits ───────────────────────── */

function ChannelTable({ channels, mode }) {
  if (!channels || channels.length === 0) {
    return <div className="mon-empty">No channels configured.</div>;
  }
  return (
    <table className="mon-table">
      <thead>
        <tr>
          <th>Channel</th>
          <th>Active</th>
          <th>Videos today</th>
          <th>Last video</th>
          <th>{mode === 'forecast' ? 'WebSub renews' : 'WebSub expires'}</th>
        </tr>
      </thead>
      <tbody>
        {channels.map((c) => (
          <tr key={c.channel_id}>
            <td>{c.channel_name}</td>
            <td>
              {c.active ? (
                <span className="mon-type-badge hourly">active</span>
              ) : (
                <span className="text-muted">paused</span>
              )}
            </td>
            <td>
              <span className={`mon-pending ${c.videos_today > 0 ? 'has' : 'none'}`}>
                {c.videos_today}
              </span>
            </td>
            <td className="text-muted">
              {c.last_video_at ? timeAgo(c.last_video_at) : '—'}
            </td>
            <td className="text-muted">{fmtWebsub(c.websub_expires_at, mode)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BudgetBar({ budget }) {
  if (!budget || !budget.usable_units) return null;
  const used = budget.used_today || 0;
  const usable = budget.usable_units || 1;
  const pct = Math.min(100, Math.round((used / usable) * 100));
  const demand = budget.total_demand_units;
  const demandPct = demand != null ? Math.round((demand / usable) * 100) : null;
  return (
    <div className="yt-sched-budget">
      <span className="text-muted">
        Spent today: <strong>{used.toLocaleString()}</strong> /{' '}
        {usable.toLocaleString()} usable units ({pct}%)
        {budget.limit_units ? ` · daily limit ${budget.limit_units.toLocaleString()}` : ''}
      </span>
      <div className="yt-sched-budget-track">
        <div
          className="yt-sched-budget-fill"
          style={{ width: `${pct}%`, background: pct >= 95 ? 'var(--danger)' : 'var(--accent-primary)' }}
        />
      </div>
      {demand != null && (
        <span className="text-muted" style={{ display: 'block', marginTop: 6 }}>
          Planned demand: <strong>{demand.toLocaleString()}</strong> units/day{' '}
          {budget.over_budget ? (
            <span style={{ color: 'var(--danger)' }}>
              ({demandPct}% of budget — auto-rotating to stay within quota)
            </span>
          ) : (
            <span>({demandPct}% of budget — fits)</span>
          )}
        </span>
      )}
    </div>
  );
}

function PriorityBadge({ priority }) {
  const p = priority || 3;
  return <span className={`mon-type-badge ${p <= 2 ? 'daily' : 'hourly'}`}>P{p}</span>;
}

function fmtEvery(min) {
  if (!min || min <= 0) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  if (min % 60 === 0) return `${min / 60}h`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${m}m`;
}

function fmtWebsub(iso, mode) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  if (mode === 'forecast') {
    // Renewal happens ~2 days before expiry (renewal job runs every 9 days).
    const renewMs = ms - 2 * 24 * 3600 * 1000;
    if (renewMs <= Date.now()) return 'due';
    return `in ${formatDuration(renewMs - Date.now())}`;
  }
  return `${fmtBeirutDate(ms)} ${fmtBeirutTime(ms)}`;
}
