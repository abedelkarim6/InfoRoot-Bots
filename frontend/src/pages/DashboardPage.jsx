/**
 * Dashboard — analytics page.
 *
 * Ports static/js/dashboard.js to React. Charts are created via the global
 * window.Chart (Chart.js v4 UMD CDN) inside useEffect blocks that destroy the
 * previous instance before each re-render and on unmount.
 *
 * Filter changes are reflected in the queryKey so TanStack Query auto-refetches.
 * The Gemini live usage card uses refetchInterval (15s) — auto-stops on unmount.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/PageHeader';
import { useGlobalConfig } from '../config/ConfigProvider';
import { useAuth } from '../auth/AuthContext';
import { useUrlInt, useUrlSet, useUrlString } from '../lib/useUrlState';

/* ── Colour palette (violet-led, matches the Figma design system) ─ */
const PALETTE = [
  '#6b3db5', '#8541f1', '#10b981', '#f59e0b',
  '#ef4444', '#06b6d4', '#f97316', '#84cc16',
  '#ec4899', '#a78bfa', '#34d399', '#fb923c'
];

/* ── Theme-aware Chart.js styling ──────────────────
   Colors are read from the CSS custom properties at chart-creation time so
   charts follow the active light/dark theme instead of hardcoding one. */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function chartTheme() {
  const accent = cssVar('--accent-primary', '#6b3db5');
  const accentRgb = cssVar('--accent-primary-rgb', '107, 61, 181');
  return {
    accent,
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

const PERIOD_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' }
];

export default function DashboardPage() {
  const { config } = useGlobalConfig();
  const { isAdmin } = useAuth();

  const [days, setDays] = useUrlInt('days', 14);
  const [filterSources, setFilterSources] = useUrlSet('src');
  const [filterTopics, setFilterTopics] = useUrlSet('topic');
  const [filterChannels, setFilterChannels] = useUrlSet('ch');
  const [matrixSrcFilter, setMatrixSrcFilter] = useUrlString('mxsrc', '');

  // Build the URL — TanStack Query will refetch when any of these change.
  const queryUrl = useMemo(() => {
    let url = `/api/dashboard/stats?days=${days}`;
    if (filterSources.size) url += `&filter_source=${encodeURIComponent([...filterSources].join(','))}`;
    if (filterTopics.size) url += `&filter_topic=${encodeURIComponent([...filterTopics].join(','))}`;
    if (filterChannels.size) url += `&filter_channels=${encodeURIComponent([...filterChannels].join(','))}`;
    return url;
  }, [days, filterSources, filterTopics, filterChannels]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['dashboard-stats', days, [...filterSources].sort(), [...filterTopics].sort(), [...filterChannels].sort()],
    queryFn: () => api(queryUrl)
  });

  const ok = data?.status === 'ok';
  const errorMsg = !ok ? (data?.message || 'Failed to load dashboard data.') : null;

  // Source/topic/channel option lists — DB list + config-defined extras.
  const allSources = useMemo(() => buildAllSources(data, config), [data, config]);
  const allTopics = useMemo(() => buildAllTopics(data, config), [data, config]);

  const hasFilters = filterSources.size || filterTopics.size || filterChannels.size;

  function clearAllFilters() {
    setFilterSources(new Set());
    setFilterTopics(new Set());
    setFilterChannels(new Set());
  }

  return (
    <div className="page active">
      <PageHeader title="Dashboard" subtitle="Analytics & performance insights">
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          ↻ Refresh
        </button>
      </PageHeader>

      {/* Filter bar */}
      <div className="dash-filter-bar">
        <div className="dash-filter-group">
          <span className="dash-filter-label">📡 Source</span>
          <MultiSelect
            label="Sources"
            options={allSources}
            selected={filterSources}
            onChange={setFilterSources}
          />
        </div>
        <div className="dash-filter-group">
          <span className="dash-filter-label">🏷️ Topic</span>
          <MultiSelect
            label="Topics"
            options={allTopics}
            selected={filterTopics}
            onChange={setFilterTopics}
          />
        </div>
        <div className="dash-filter-group">
          <span className="dash-filter-label">📅 Period</span>
          <select
            className="select dash-filter-select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {PERIOD_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="dash-filter-group">
          <span className="dash-filter-label">📺 Channels</span>
          <MultiSelect
            label="Channels"
            options={allSources}
            selected={filterChannels}
            onChange={setFilterChannels}
          />
        </div>
        {hasFilters ? (
          <button
            className="dash-filter-clear"
            onClick={clearAllFilters}
          >
            ✕ Clear filters
          </button>
        ) : null}
      </div>

      {/* Subscribed channels card (admin: validator placeholder; user: their channels) */}
      <div id="dash-channels-wrap" style={{ marginBottom: 24 }}>
        {isAdmin ? <AdminChannelsCard /> : <UserSubscribedChannels />}
      </div>

      {errorMsg && (
        <p className="mon-empty" style={{ color: '#ef4444' }}>Error: {errorMsg}</p>
      )}

      {/* Stat cards */}
      <div className="dash-stat-grid">
        <div className="dash-stat-card">
          <div className="dash-stat-icon">📨</div>
          <div className="dash-stat-value">{statValue(data, 'total_messages', isLoading)}</div>
          <div className="dash-stat-label">Total Messages</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon">📅</div>
          <div className="dash-stat-value">{statValue(data, 'period_messages', isLoading)}</div>
          <div className="dash-stat-label">Messages ({days}d)</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon">📝</div>
          <div className="dash-stat-value">{statValue(data, 'total_summaries', isLoading)}</div>
          <div className="dash-stat-label">Total Summaries</div>
        </div>
        <div className="dash-stat-card">
          <div className="dash-stat-icon">📡</div>
          <div className="dash-stat-value">{statValue(data, 'active_sources', isLoading)}</div>
          <div className="dash-stat-label">Active Sources</div>
        </div>
      </div>

      {/* Gemini API usage widget (admin only — endpoint is admin-scoped) */}
      {/* Gemini API usage card removed — single source of truth lives on
          /ai-usage. The Dashboard focuses on summary analytics only. */}

      {/* Row 1: Daily line + Topic donut */}
      <div className="dash-chart-row">
        <div className="dash-chart-card dash-wide">
          <div className="dash-chart-header">
            <span className="dash-chart-title">Messages per Day</span>
          </div>
          <div className="dash-canvas-wrap">
            <DailyChart perDay={ok ? data.messages_per_day : []} days={days} />
          </div>
        </div>
        <div className="dash-chart-card">
          <div className="dash-chart-header">
            <span className="dash-chart-title">Topic Distribution</span>
          </div>
          <div className="dash-canvas-wrap">
            <TopicsDonut perTopic={ok ? data.messages_per_topic : []} />
          </div>
        </div>
      </div>

      {/* Row 2: Top sources + Topic trend */}
      <div className="dash-chart-row">
        <div className="dash-chart-card">
          <div className="dash-chart-header">
            <span className="dash-chart-title">Top Sources</span>
          </div>
          <div className="dash-canvas-wrap">
            <SourcesBar perSource={ok ? data.messages_per_source : []} />
          </div>
        </div>
        <div className="dash-chart-card dash-wide">
          <div className="dash-chart-header">
            <span className="dash-chart-title">Topic Trend</span>
            <span className="dash-chart-sub">Top 6 topics over time</span>
          </div>
          <div className="dash-canvas-wrap">
            <TrendChart
              trendData={ok ? data.topic_trend : []}
              perTopic={ok ? data.messages_per_topic : []}
            />
          </div>
        </div>
      </div>

      {/* Source × Topic matrix */}
      <div className="dash-matrix-card">
        <div className="dash-chart-header">
          <span className="dash-chart-title">Source × Topic Breakdown</span>
          <input
            type="text"
            className="input dash-filter-input"
            placeholder="Filter sources…"
            value={matrixSrcFilter}
            onChange={(e) => setMatrixSrcFilter(e.target.value)}
          />
        </div>
        <div className="dash-matrix-wrap">
          <SourceMatrix
            breakdown={ok ? data.source_topic_breakdown : []}
            perTopic={ok ? data.messages_per_topic : []}
            srcFilter={matrixSrcFilter}
            isLoading={isLoading}
          />
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// MultiSelect dropdown (mirrors .mon-multi-select markup from legacy CSS)
// ────────────────────────────────────────────────────────────────────────────

function MultiSelect({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function toggle(value) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  function toggleAll() {
    onChange(new Set());
  }

  let btnLabel;
  if (selected.size === 0) btnLabel = `All ${label}`;
  else if (selected.size <= 2) btnLabel = [...selected].join(', ');
  else btnLabel = `${selected.size} ${label.toLowerCase()}`;

  return (
    <div
      className={`mon-multi-select${open ? ' open' : ''}`}
      ref={wrapRef}
    >
      <button
        type="button"
        className="select mon-filter-sel mon-ms-btn"
        onClick={() => setOpen((o) => !o)}
      >
        {btnLabel} <span className="mon-ms-arrow">▾</span>
      </button>
      <div className="mon-ms-dropdown">
        <label className="mon-ms-item all-item">
          <input
            type="checkbox"
            checked={selected.size === 0}
            onChange={toggleAll}
          /> All {label}
        </label>
        {options.map((opt) => (
          <label className="mon-ms-item" key={opt}>
            <input
              type="checkbox"
              checked={selected.has(opt)}
              onChange={() => toggle(opt)}
            /> {opt}
          </label>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Charts (each gets a canvas ref + useEffect that destroys before recreating)
// ────────────────────────────────────────────────────────────────────────────

function DailyChart({ perDay, days }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (!ref.current || !window.Chart) return undefined;
    const filled = fillDays(perDay || [], days);
    const labels = filled.map((d) => d.day.slice(5));
    const values = filled.map((d) => d.count);
    const th = chartTheme();
    chartRef.current = new window.Chart(ref.current, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Messages',
          data: values,
          borderColor: th.accent,
          backgroundColor: `rgba(${th.accentRgb},0.08)`,
          pointBackgroundColor: th.accent,
          pointRadius: 3,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.35,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: th.tooltip },
        scales: {
          x: { grid: th.grid, ticks: th.ticks },
          y: { grid: th.grid, ticks: th.ticks, beginAtZero: true }
        }
      }
    });
    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    };
  }, [perDay, days]);
  return <canvas ref={ref} />;
}

function TopicsDonut({ perTopic }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (!ref.current || !window.Chart || !perTopic?.length) return undefined;
    const top = perTopic.slice(0, 10);
    const th = chartTheme();
    chartRef.current = new window.Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels: top.map((t) => t.topic),
        datasets: [{
          data: top.map((t) => t.count),
          backgroundColor: PALETTE.slice(0, top.length),
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
            position: 'right',
            labels: { color: th.legend, font: { size: 10 }, padding: 8, boxWidth: 10 }
          },
          tooltip: th.tooltip
        }
      }
    });
    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    };
  }, [perTopic]);
  return <canvas ref={ref} />;
}

function SourcesBar({ perSource }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (!ref.current || !window.Chart || !perSource?.length) return undefined;
    const top = perSource.slice(0, 15);
    const th = chartTheme();
    chartRef.current = new window.Chart(ref.current, {
      type: 'bar',
      data: {
        labels: top.map((s) => s.source),
        datasets: [{
          label: 'Messages',
          data: top.map((s) => s.count),
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
        plugins: { legend: { display: false }, tooltip: th.tooltip },
        scales: {
          x: { grid: th.grid, ticks: th.ticks, beginAtZero: true },
          y: { grid: { display: false }, ticks: { ...th.ticks, font: { size: 10 } } }
        }
      }
    });
    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    };
  }, [perSource]);
  return <canvas ref={ref} />;
}

function TrendChart({ trendData, perTopic }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (!ref.current || !window.Chart || !trendData?.length) return undefined;
    const allDays = [...new Set(trendData.map((d) => d.day))].sort();
    const labels = allDays.map((d) => d.slice(5));
    const topTopics = (perTopic || []).slice(0, 6).map((t) => t.topic);
    const datasets = topTopics.map((topic, i) => {
      const dayMap = {};
      trendData.filter((d) => d.topic === topic).forEach((d) => { dayMap[d.day] = d.count; });
      return {
        label: topic,
        data: allDays.map((d) => dayMap[d] || 0),
        borderColor: PALETTE[i],
        backgroundColor: PALETTE[i] + '18',
        pointRadius: 2,
        pointHoverRadius: 4,
        fill: false,
        tension: 0.3,
        borderWidth: 1.8
      };
    });
    const th = chartTheme();
    chartRef.current = new window.Chart(ref.current, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: th.legend, font: { size: 10 }, padding: 10, boxWidth: 10 }
          },
          tooltip: { ...th.tooltip, mode: 'index', intersect: false }
        },
        scales: {
          x: { grid: th.grid, ticks: th.ticks },
          y: { grid: th.grid, ticks: th.ticks, beginAtZero: true }
        }
      }
    });
    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    };
  }, [trendData, perTopic]);
  return <canvas ref={ref} />;
}

// ────────────────────────────────────────────────────────────────────────────
// Source × Topic matrix
// ────────────────────────────────────────────────────────────────────────────

function SourceMatrix({ breakdown, perTopic, srcFilter, isLoading }) {
  if (isLoading) {
    return <p className="mon-empty">Loading…</p>;
  }
  if (!breakdown?.length) {
    return <p className="mon-empty">No data for this period.</p>;
  }

  const topicOrder = (perTopic || []).slice(0, 10).map((t) => t.topic);
  const topics = topicOrder.filter((t) => breakdown.some((r) => r.topic === t));
  const sources = [...new Set(breakdown.map((r) => r.source))];
  const lut = {};
  breakdown.forEach((r) => { lut[`${r.source}|${r.topic}`] = r.count; });
  const maxVal = Math.max(...breakdown.map((r) => r.count), 1);
  const q = (srcFilter || '').toLowerCase();

  return (
    <table className="dash-matrix-table">
      <thead>
        <tr>
          <th>Source</th>
          {topics.map((t) => (
            <th key={t} title={t}>{t}</th>
          ))}
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {sources.map((src) => {
          const rowTotal = topics.reduce((s, t) => s + (lut[`${src}|${t}`] || 0), 0);
          if (rowTotal === 0) return null;
          const hidden = q && !src.toLowerCase().includes(q);
          return (
            <tr
              key={src}
              data-source={src}
              style={hidden ? { display: 'none' } : undefined}
            >
              <td className="dash-matrix-src" title={src}>{src}</td>
              {topics.map((t) => {
                const val = lut[`${src}|${t}`] || 0;
                const alpha = val > 0 ? (val / maxVal * 0.55).toFixed(2) : '0';
                const style = val > 0 ? { background: `rgba(var(--accent-primary-rgb),${alpha})` } : undefined;
                return (
                  <td className="dash-matrix-cell" style={style} key={t}>
                    {val > 0 ? val : <span style={{ opacity: 0.2 }}>—</span>}
                  </td>
                );
              })}
              <td className="dash-matrix-total">{fmt(rowTotal)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Channels cards
// ────────────────────────────────────────────────────────────────────────────

function AdminChannelsCard() {
  // The admin Channel Membership Validator card. Lives on Collections page in
  // the legacy app; on Dashboard for admins it's a placeholder hook so the
  // markup is preserved. We don't run validation here — admins use Collections.
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  async function validate(e) {
    if (e) e.stopPropagation();
    setLoading(true);
    try {
      const r = await api('/api/telegram/userbot/dialogs');
      setData(r);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ch-val-card">
      <div
        className="ch-val-header"
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer' }}
      >
        <div className="ch-val-title">
          <span className="ch-val-toggle-icon">{open ? '▼' : '▶'}</span>
          <h3>📡 Subscribed Channels</h3>
          <span className="text-muted" style={{ fontSize: '0.8rem', marginLeft: 8 }}>
            Verify which channels the userbot has joined
          </span>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={validate}
          disabled={loading}
          style={{ whiteSpace: 'nowrap' }}
        >
          {loading ? '…' : '🔍 Validate'}
        </button>
      </div>
      {open && (
        <div className="ch-val-body" style={{ display: 'block' }}>
          {!data && <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>Click Validate to fetch joined channels.</p>}
          {data && data.status === 'ok' && data.channels?.length > 0 && (
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {data.channels.map((ch, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 8px',
                    borderRadius: 6,
                    background: 'var(--bg-secondary)',
                    fontSize: 12,
                    marginBottom: 4
                  }}
                >
                  <span>{ch.is_group ? '👥' : '📢'}</span>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ch.title || ch.username || 'Unknown'}
                    </div>
                    {ch.username && (
                      <div style={{ color: 'var(--text-muted)' }}>@{ch.username}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {data && (data.status !== 'ok' || !data.channels?.length) && (
            <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
              {data.status === 'no_session' || data.status === 'unauthorized'
                ? 'No Telegram account linked.'
                : 'No subscribed channels found.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function UserSubscribedChannels() {
  const { data, isLoading } = useQuery({
    queryKey: ['user-dialogs'],
    queryFn: () => api('/api/telegram/userbot/dialogs')
  });
  const [open, setOpen] = useState(true);

  if (isLoading) {
    return (
      <div className="ch-val-card">
        <div className="ch-val-header">
          <div className="ch-val-title">
            <span style={{ fontSize: 20 }}>📡</span>
            <h3 style={{ margin: 0 }}>Subscribed Channels</h3>
          </div>
        </div>
        <div className="ch-val-body" style={{ display: 'block', padding: '12px 16px' }}>
          <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>Loading…</p>
        </div>
      </div>
    );
  }

  if (!data || data.status !== 'ok' || !data.channels?.length) {
    return (
      <div className="ch-val-card">
        <div className="ch-val-header">
          <div className="ch-val-title">
            <span style={{ fontSize: 20 }}>📡</span>
            <h3 style={{ margin: 0 }}>Subscribed Channels</h3>
          </div>
        </div>
        <div className="ch-val-body" style={{ display: 'block', padding: '12px 16px' }}>
          <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
            {data?.status === 'no_session' || data?.status === 'unauthorized'
              ? 'No Telegram account linked. Link your account in Profile to see subscribed channels.'
              : 'No subscribed channels found.'}
          </p>
        </div>
      </div>
    );
  }

  const channels = data.channels;
  return (
    <div className="ch-val-card">
      <div
        className="ch-val-header"
        style={{ cursor: 'pointer' }}
        onClick={() => setOpen((o) => !o)}
      >
        <div className="ch-val-title">
          <span className="ch-dash-toggle">{open ? '▼' : '▶'}</span>
          <h3>📡 Subscribed Channels</h3>
          <span className="text-muted" style={{ fontSize: '0.8rem', marginLeft: 8 }}>
            {channels.length} channel{channels.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
      {open && (
        <div className="ch-val-body" style={{ display: 'block' }}>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {channels.map((ch, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  borderRadius: 6,
                  background: 'var(--bg-secondary)',
                  fontSize: 12,
                  marginBottom: 4
                }}
              >
                <span>{ch.is_group ? '👥' : '📢'}</span>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ch.title || ch.username || 'Unknown'}
                  </div>
                  {ch.username && (
                    <div style={{ color: 'var(--text-muted)' }}>@{ch.username}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {data.updated_at && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
              Last refreshed: {new Date(data.updated_at).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function statValue(data, key, isLoading) {
  if (isLoading) return '…';
  if (data?.status !== 'ok') return '—';
  return fmt(data[key]);
}

function fillDays(perDay, days) {
  const map = {};
  (perDay || []).forEach((d) => { map[d.day] = d.count; });
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map[key] || 0 });
  }
  return out;
}

function buildAllSources(data, config) {
  const dbSources = data?.all_sources || [];
  const cfgSources = [];
  const cfg = config?.status === 'ok' ? config : config;
  const collections = cfg?.collections || {};
  for (const coll of Object.values(collections)) {
    for (const ch of (coll.source_channels || [])) {
      const clean = String(ch).replace(/^@/, '');
      if (!dbSources.includes(ch) && !dbSources.includes(clean)) cfgSources.push(ch);
    }
  }
  return [...dbSources, ...cfgSources];
}

function buildAllTopics(data, config) {
  const dbTopics = data?.all_topics || [];
  const cfgTopics = [];
  const cfg = config?.status === 'ok' ? config : config;
  const bots = cfg?.bots || {};
  for (const bot of Object.values(bots)) {
    for (const cat of Object.values(bot.categories || {})) {
      for (const topicName of Object.keys(cat.topics || {})) {
        if (!dbTopics.includes(topicName)) cfgTopics.push(topicName);
      }
    }
  }
  return [...dbTopics, ...cfgTopics];
}
