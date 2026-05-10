/**
 * YouTube Activity (Videos queue + summaries) — Phase 3 / Wave 3 port.
 *
 * Mirrors `loadYtVideosData` and friends in static/js/youtube.js. This page
 * combines:
 *   - Stat cards (Pending / Processing / Done / Failed) — clickable filters
 *   - Daily budget bar
 *   - Manual video submission, prompt editor, default targets, fixed prefix
 *     (admin only)
 *   - Filterable, paginated video table with per-row actions
 *
 * Auto-refresh: replaces the legacy `_ytQueueInterval` setInterval pattern by
 * setting `refetchInterval` on the videos query (30s). A checkbox in the
 * header toggles it; the polling stops automatically when the page unmounts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, debounce, escapeHtml } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useAuth } from '../../auth/AuthContext';
import PageHeader from '../../components/PageHeader';
import { estimateCost, parseCommaSep, timeAgo, todayISODate } from './shared';

const PAGE_SIZE = 50;
const MAX_PROCESSING = 3;

export default function VideosPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const { showNotification } = useDialogs();

  // ── Filter state (kept locally; default date range = today) ──
  const [filters, setFilters] = useState(() => ({
    status: '',
    channel: '',
    source: '',
    dateFrom: todayISODate(),
    dateTo: todayISODate()
  }));
  const [page, setPage] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const processingCountRef = useRef(0);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [filters]);

  const queryUrl = useMemo(() => {
    const offset = page * PAGE_SIZE;
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    if (filters.status) params.set('status', filters.status);
    if (filters.channel) params.set('channel', filters.channel);
    if (filters.source) params.set('source', filters.source);
    if (filters.dateFrom) params.set('date_from', filters.dateFrom);
    if (filters.dateTo) params.set('date_to', filters.dateTo);
    return `/api/youtube/videos?${params.toString()}`;
  }, [page, filters]);

  const { data, isLoading } = useQuery({
    queryKey: ['yt-videos', queryUrl],
    queryFn: () => api(queryUrl),
    refetchInterval: autoRefresh ? 30000 : false,
    refetchIntervalInBackground: false
  });
  const ok = data?.status === 'ok';
  const items = ok ? data.items || [] : [];
  const stats = ok ? data.stats || {} : {};
  const daily = stats.daily || {};
  const total = ok ? data.total || items.length : 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const hasFilters =
    filters.status || filters.channel || filters.source || filters.dateFrom || filters.dateTo;

  // ── Mutations ────────────────────────────────────────────────
  const triggerProcess = useApiMutation('/api/youtube/queue/process', {
    invalidate: ['yt-videos'],
    successMsg: (res) => `Processed ${res?.processed ?? 0} item(s)`,
    errorMsg: 'Processing failed'
  });

  const resetStuck = useApiMutation('/api/youtube/queue/reset-stuck', {
    invalidate: ['yt-videos'],
    successMsg: (res) =>
      res?.reset > 0
        ? `Reset ${res.reset} stuck item(s) to Failed — you can now retry them`
        : 'No stuck items found',
    errorMsg: 'Reset failed'
  });

  // Clear All — chains queue/clear + summaries/clear
  async function doClearAll() {
    const r1 = await api('/api/youtube/queue/clear', {});
    const r2 = await api('/api/youtube/summaries/clear', {});
    const totalDeleted = (r1?.deleted || 0) + (r2?.deleted || 0);
    showNotification(`Cleared ${totalDeleted} item(s)`, 'success');
    qc.invalidateQueries({ queryKey: ['yt-videos'] });
  }
  const { showConfirm } = useDialogs();
  function clearAllConfirm() {
    showConfirm('Delete ALL videos and summaries? This cannot be undone.', doClearAll, {
      title: 'Clear All',
      confirmLabel: 'Delete All',
      confirmClass: 'btn-danger'
    });
  }

  const processingCount = stats.processing || 0;

  function clearFilters() {
    setFilters({ status: '', channel: '', source: '', dateFrom: '', dateTo: '' });
  }

  function setStatusFilter(status) {
    setFilters((f) => ({ ...f, status: f.status === status ? '' : status }));
  }

  return (
    <div className="page active">
      <PageHeader title="Activity" subtitle="Queue, processing & summaries">
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            color: 'var(--text-secondary)',
            cursor: 'pointer'
          }}
        >
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh
        </label>
        <button className="btn btn-danger btn-sm" onClick={clearAllConfirm}>
          🗑️ Clear All
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => triggerProcess.mutate({})}
          disabled={triggerProcess.isPending}
        >
          ▶ Process Now
        </button>
        <button
          className="btn btn-primary"
          onClick={() => qc.invalidateQueries({ queryKey: ['yt-videos'] })}
        >
          🔄 Refresh
        </button>
      </PageHeader>

      <div className="yt-top-cards-row">
        <ManualSubmitCard />
        <PromptCard />
        {isAdmin && <FixedPrefixCard />}
        <DefaultTargetsCard />
      </div>

      {/* Daily budget */}
      <div className="yt-daily-budget">
        <div className="yt-budget-row">
          <span className="yt-budget-title">Today's Activity</span>
          <span className="yt-budget-item">
            📥 <strong>{daily.queued || 0}</strong> queued
          </span>
          <span className="yt-budget-item">
            ✅ <strong>{daily.processed || 0}</strong> processed
          </span>
          <span className="yt-budget-item">
            ❌ <strong>{daily.failed || 0}</strong> failed
          </span>
          <span className="yt-budget-sep">|</span>
          <span className="yt-budget-item">
            📝 <strong>{daily.summaries || 0}</strong> summaries
          </span>
          <span className="yt-budget-item yt-budget-source">
            📄 {daily.transcript || 0} transcript
          </span>
          <span className="yt-budget-item yt-budget-source">
            🏷️ {daily.metadata || 0} metadata
          </span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="dash-stat-grid">
        <StatCard
          icon="⏳"
          label="Pending"
          value={stats.pending || 0}
          active={filters.status === 'pending'}
          onClick={() => setStatusFilter('pending')}
        />
        <div
          className={`dash-stat-card yt-stat-clickable${filters.status === 'processing' ? ' yt-stat-selected' : ''}`}
          onClick={() => setStatusFilter('processing')}
          style={{ position: 'relative' }}
        >
          <div className="dash-stat-icon">⚙️</div>
          <div className="dash-stat-value">{processingCount}</div>
          <div className="dash-stat-label">Processing</div>
          {processingCount > 0 && (
            <button
              className="btn btn-danger btn-sm"
              style={{
                display: '',
                position: 'absolute',
                bottom: 8,
                right: 8,
                fontSize: 11,
                padding: '2px 7px'
              }}
              onClick={(e) => {
                e.stopPropagation();
                resetStuck.mutate({});
              }}
              title="Reset stuck items to Failed"
              disabled={resetStuck.isPending}
            >
              ⚠️ Reset
            </button>
          )}
        </div>
        <StatCard
          icon="✅"
          label="Done"
          value={stats.done || 0}
          active={filters.status === 'done'}
          onClick={() => setStatusFilter('done')}
        />
        <StatCard
          icon="❌"
          label="Failed"
          value={stats.failed || 0}
          active={filters.status === 'failed'}
          onClick={() => setStatusFilter('failed')}
        />
      </div>

      {/* Filters */}
      <FilterBar
        filters={filters}
        onChange={setFilters}
        hasFilters={!!hasFilters}
        onClear={clearFilters}
      />

      {/* Table or empty */}
      {isLoading ? (
        <p className="mon-empty">Loading…</p>
      ) : !ok ? (
        <p className="mon-empty">Failed to load videos.</p>
      ) : items.length === 0 ? (
        <p className="mon-empty">No videos found.</p>
      ) : (
        <VideoTable
          items={items}
          isAdmin={isAdmin}
          processingCountRef={processingCountRef}
        />
      )}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="yt-pagination" style={{ display: 'flex' }}>
          <button
            className="btn btn-secondary btn-sm"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Prev
          </button>
          <span className="yt-page-info">
            Page {page + 1} of {totalPages} ({total} items)
          </span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, active, onClick }) {
  return (
    <div
      className={`dash-stat-card yt-stat-clickable${active ? ' yt-stat-selected' : ''}`}
      onClick={onClick}
    >
      <div className="dash-stat-icon">{icon}</div>
      <div className="dash-stat-value">{value}</div>
      <div className="dash-stat-label">{label}</div>
    </div>
  );
}

// ─── Filter Bar ─────────────────────────────────────────────────────────────

function FilterBar({ filters, onChange, hasFilters, onClear }) {
  // Channel field is debounced — keep its draft locally
  const [channelDraft, setChannelDraft] = useState(filters.channel);

  // Keep draft in sync when external state changes (e.g. clearFilters)
  useEffect(() => {
    setChannelDraft(filters.channel);
  }, [filters.channel]);

  // Debounced handler propagates to parent state
  const debouncedChange = useMemo(
    () =>
      debounce((v) => {
        onChange((f) => ({ ...f, channel: v }));
      }, 400),
    [onChange]
  );

  return (
    <div className="dash-filter-bar">
      <div className="dash-filter-group">
        <span className="dash-filter-label">📅 Date</span>
        <input
          type="date"
          className="input dash-filter-select"
          style={{ width: 140 }}
          value={filters.dateFrom}
          onChange={(e) => onChange((f) => ({ ...f, dateFrom: e.target.value }))}
        />
        <span className="text-muted">to</span>
        <input
          type="date"
          className="input dash-filter-select"
          style={{ width: 140 }}
          value={filters.dateTo}
          onChange={(e) => onChange((f) => ({ ...f, dateTo: e.target.value }))}
        />
      </div>
      <div className="dash-filter-group">
        <span className="dash-filter-label">📊 Status</span>
        <select
          className="select dash-filter-select"
          value={filters.status}
          onChange={(e) => onChange((f) => ({ ...f, status: e.target.value }))}
        >
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      <div className="dash-filter-group">
        <span className="dash-filter-label">📺 Channel</span>
        <input
          type="text"
          className="input dash-filter-select"
          style={{ width: 140 }}
          placeholder="Filter…"
          value={channelDraft}
          onChange={(e) => {
            const v = e.target.value;
            setChannelDraft(v);
            debouncedChange(v);
          }}
        />
      </div>
      <div className="dash-filter-group">
        <span className="dash-filter-label">🔧 Source</span>
        <select
          className="select dash-filter-select"
          value={filters.source}
          onChange={(e) => onChange((f) => ({ ...f, source: e.target.value }))}
        >
          <option value="">All Sources</option>
          <option value="transcript_api">Transcript</option>
          <option value="metadata">Metadata</option>
        </select>
      </div>
      {hasFilters && (
        <button className="btn btn-secondary btn-sm yt-filter-clear-btn" onClick={onClear}>
          ✕ Clear
        </button>
      )}
    </div>
  );
}

// ─── Manual Submit Card ─────────────────────────────────────────────────────

function ManualSubmitCard() {
  const { showNotification } = useDialogs();
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');

  const add = useApiMutation('/api/youtube/videos/add', {
    invalidate: ['yt-videos'],
    successMsg: (res) => `Video ${res?.video_id ?? ''} queued`,
    errorMsg: 'Failed to add video'
  });

  function handleAdd() {
    const u = url.trim();
    if (!u) {
      showNotification('Please enter a YouTube URL or video ID.', 'error');
      return;
    }
    add.mutate(
      { url: u, telegram_target: target.trim() || null },
      {
        onSuccess: (res) => {
          if (res?.status === 'ok') setUrl('');
        }
      }
    );
  }

  return (
    <div className="yt-manual-card">
      <h3>🔗 Add Video Manually</h3>
      <div className="yt-manual-form">
        <input
          type="text"
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="YouTube URL or video ID"
          style={{ flex: 2 }}
        />
        <input
          type="text"
          className="input"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Telegram target (e.g. @channel)"
          style={{ flex: 1 }}
        />
        <button className="btn btn-primary" onClick={handleAdd} disabled={add.isPending}>
          Add & Queue
        </button>
      </div>
    </div>
  );
}

// ─── Prompt Editor ──────────────────────────────────────────────────────────

function PromptCard() {
  const { showNotification } = useDialogs();
  const [prompt, setPrompt] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');

  useEffect(() => {
    let cancelled = false;
    api('/api/youtube/prompt').then((res) => {
      if (cancelled || res?.status !== 'ok') return;
      setDefaultPrompt(res.default_prompt || '');
      setPrompt(res.prompt || res.default_prompt || '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useApiMutation('/api/youtube/prompt/save', {
    successMsg: 'Default prompt saved',
    errorMsg: 'Failed to save prompt'
  });

  return (
    <div className="yt-prompt-card">
      <div className="yt-prompt-header">
        <h3>📝 Summarization Prompt</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              if (defaultPrompt) setPrompt(defaultPrompt);
              showNotification('Reset to default prompt', 'info');
            }}
          >
            Reset Default
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => save.mutate({ prompt })}
            disabled={save.isPending}
          >
            Save
          </button>
        </div>
      </div>
      <textarea
        className="input yt-prompt-textarea"
        rows={4}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Loading prompt…"
      />
    </div>
  );
}

// ─── Fixed Prefix (admin only) ──────────────────────────────────────────────

function FixedPrefixCard() {
  const { showNotification } = useDialogs();
  const [tab, setTab] = useState('video');
  const [defaults, setDefaults] = useState({ video: '', transcript: '' });
  const [values, setValues] = useState({ video: '', transcript: '' });

  useEffect(() => {
    let cancelled = false;
    api('/api/youtube/fixed-prefix').then((res) => {
      if (cancelled || res?.status !== 'ok') return;
      setDefaults({
        video: res.default_prefix_video || '',
        transcript: res.default_prefix_transcript || ''
      });
      setValues({
        video: res.prefix_video || '',
        transcript: res.prefix_transcript || ''
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = values[tab] || defaults[tab] || '';

  const save = useApiMutation('/api/youtube/fixed-prefix/save', {
    successMsg: 'Fixed prefix saved',
    errorMsg: 'Failed to save'
  });

  function handleSave() {
    const body = tab === 'video' ? { prefix_video: current } : { prefix_transcript: current };
    save.mutate(body);
  }

  function handleReset() {
    setValues((v) => ({ ...v, [tab]: defaults[tab] || '' }));
    showNotification('Reset to default', 'info');
  }

  return (
    <div className="yt-prompt-card yt-fixed-prefix-card">
      <div className="yt-prompt-header">
        <h3>
          🔒 Fixed System Prefix <span className="admin-badge">Admin</span>
        </h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            className="input"
            value={tab}
            onChange={(e) => setTab(e.target.value)}
            style={{ fontSize: 12, padding: '4px 8px', height: 'auto' }}
          >
            <option value="video">Video Strategy</option>
            <option value="transcript">Transcript Strategy</option>
          </select>
          <button className="btn btn-secondary btn-sm" onClick={handleReset}>
            Reset
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={save.isPending}>
            Save
          </button>
        </div>
      </div>
      <p className="text-muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
        Prepended before the Summarization Prompt above. Supports placeholders: {'{title}'},
        {' {channel_name}'}, {'{link}'}, {'{guest}'}, {'{transcript}'} (transcript only).
      </p>
      <textarea
        className="input yt-prompt-textarea"
        rows={6}
        value={current}
        onChange={(e) => setValues((v) => ({ ...v, [tab]: e.target.value }))}
        placeholder="Loading…"
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
    </div>
  );
}

// ─── Default Targets ────────────────────────────────────────────────────────

function DefaultTargetsCard() {
  const [targets, setTargets] = useState('');

  useEffect(() => {
    let cancelled = false;
    api('/api/youtube/prompt').then((res) => {
      if (cancelled || res?.status !== 'ok') return;
      setTargets((res.default_targets || []).join(', '));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useApiMutation('/api/youtube/default-targets/save', {
    successMsg: 'Default targets saved',
    errorMsg: 'Failed to save targets'
  });

  return (
    <div className="yt-prompt-card" style={{ flex: '0 0 auto', minWidth: 260 }}>
      <div className="yt-prompt-header">
        <h3>📤 Default Targets</h3>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => save.mutate({ targets: parseCommaSep(targets) })}
          disabled={save.isPending}
        >
          Save
        </button>
      </div>
      <p className="text-muted" style={{ margin: '0 0 8px', fontSize: 13 }}>
        Fallback targets when a channel/tracker has none set.
      </p>
      <input
        type="text"
        className="input"
        value={targets}
        onChange={(e) => setTargets(e.target.value)}
        placeholder="@channel1, @channel2"
        style={{ width: '100%' }}
      />
    </div>
  );
}

// ─── Video Table ────────────────────────────────────────────────────────────

const STATUS_BADGE_CLASS = {
  pending: 'yt-status-pending',
  processing: 'yt-status-processing',
  done: 'yt-status-active',
  failed: 'yt-status-inactive'
};

const SOURCE_LABEL = {
  gemini_video: 'Video',
  transcript_api: 'Transcript',
  metadata: 'Metadata'
};

function VideoTable({ items, isAdmin, processingCountRef }) {
  return (
    <div id="yt-videos-container">
      <table className="yt-table">
        <thead>
          <tr>
            <th>Video</th>
            <th>Channel</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Source</th>
            {isAdmin && <th>Cost</th>}
            <th>Target</th>
            <th>Sent</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <VideoRow
              key={item.id}
              item={item}
              isAdmin={isAdmin}
              processingCountRef={processingCountRef}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VideoRow({ item, isAdmin, processingCountRef }) {
  const { showNotification, showAlert, showConfirm } = useDialogs();
  const qc = useQueryClient();
  const [localProcessing, setLocalProcessing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const processOne = useApiMutation('/api/youtube/queue/process-one', {
    invalidate: ['yt-videos']
  });

  // Delete is a chained mutation (queue/delete + summaries/delete). We bypass
  // useApiMutation here because the legacy implementation explicitly fires
  // both endpoints in sequence regardless of the first's result.
  function handleDelete() {
    showConfirm(
      'Delete this video and its summary?',
      async () => {
        setDeleting(true);
        try {
          await api('/api/youtube/queue/delete', { id: item.id });
          if (item.summary_id) {
            await api('/api/youtube/summaries/delete', { id: item.summary_id });
          }
          showNotification('Video deleted', 'success');
          qc.invalidateQueries({ queryKey: ['yt-videos'] });
        } finally {
          setDeleting(false);
        }
      },
      {
        title: 'Delete Video',
        confirmLabel: 'Delete',
        confirmClass: 'btn-danger'
      }
    );
  }

  const title = item.title || item.video_id;
  const truncTitle = title.length > 50 ? title.substring(0, 50) + '…' : title;
  const sourceLabel = item.transcript_source
    ? SOURCE_LABEL[item.transcript_source] || item.transcript_source
    : '';
  const statusClass = STATUS_BADGE_CLASS[item.status] || '';
  const cost = isAdmin ? estimateCost(item) : null;

  async function handleProcessOne() {
    if (processingCountRef.current >= MAX_PROCESSING) {
      showNotification(`Max ${MAX_PROCESSING} items processing at once — please wait`, 'error');
      return;
    }
    processingCountRef.current += 1;
    setLocalProcessing(true);
    try {
      const res = await api('/api/youtube/queue/process-one', { id: item.id });
      if (res?.status === 'ok') {
        showNotification(
          res.success ? 'Item processed successfully' : 'Processing failed',
          res.success ? 'success' : 'error'
        );
      } else {
        showNotification(res?.message || 'Processing failed', 'error');
      }
    } finally {
      processingCountRef.current -= 1;
      setLocalProcessing(false);
      qc.invalidateQueries({ queryKey: ['yt-videos'] });
    }
  }

  async function handleShowSummary() {
    const res = await api(`/api/youtube/summaries/${item.summary_id}`);
    if (res?.status !== 'ok') return showNotification('Failed to load summary.', 'error');
    const s = res.summary;
    const html = `
      <div class="yt-summary-meta" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <span>📺 ${escapeHtml(s.channel_name || '—')}</span>
        <span>🔧 ${escapeHtml(s.transcript_source || '—')}</span>
        <span>${s.telegram_sent ? '✅ Sent' : '⏳ Not sent'}${s.telegram_target ? ' → ' + escapeHtml(s.telegram_target) : ''}</span>
        <span>🔗 <a href="https://youtube.com/watch?v=${escapeHtml(s.video_id)}" target="_blank" rel="noopener">${escapeHtml(s.video_id)}</a></span>
      </div>
      <div class="yt-summary-text" style="white-space:pre-wrap;">${escapeHtml(s.summary_text || '')}</div>
    `;
    showAlert(html, { title: s.title || 'Summary', icon: '👁️' });
  }

  async function handleShowError() {
    const res = await api(`/api/youtube/queue/${item.id}`);
    if (res?.status !== 'ok') return showNotification('Failed to load details.', 'error');
    const it = res.item;
    const html = `
      <div class="yt-summary-meta" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <span>📊 ${escapeHtml(it.status)} (${it.attempts} attempts)</span>
        <span>🔗 <a href="https://youtube.com/watch?v=${escapeHtml(it.video_id)}" target="_blank" rel="noopener">${escapeHtml(it.video_id)}</a></span>
      </div>
      <div><strong>Error:</strong>
        <div class="yt-summary-text" style="max-height:40vh;color:var(--error);white-space:pre-wrap;">${escapeHtml(it.error_log || 'No error details')}</div>
      </div>
    `;
    showAlert(html, { title: it.video_title || it.video_id, icon: '⚠️' });
  }

  // Origin badge
  let originBadge;
  if (item.source_keyword_id) {
    const kwName = item.source_keyword_name || `#${item.source_keyword_id}`;
    originBadge = (
      <span className="yt-origin-badge yt-origin-tracker" title={`Tracked via keyword: ${kwName}`}>
        🔎 {kwName}
      </span>
    );
  } else if (item.source_channel_id) {
    originBadge = (
      <span className="yt-origin-badge yt-origin-channel" title="Channel subscription">
        📺 Channel
      </span>
    );
  } else {
    originBadge = (
      <span className="yt-origin-badge yt-origin-manual" title="Added manually">
        ➕ Manual
      </span>
    );
  }

  return (
    <tr>
      <td>
        <a
          href={`https://youtube.com/watch?v=${item.video_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="yt-vid-link"
          title={title}
        >
          {truncTitle}
        </a>
      </td>
      <td>{item.channel_name || '—'}</td>
      <td>{originBadge}</td>
      <td>
        {localProcessing ? (
          <span className="yt-status-badge yt-status-processing">processing</span>
        ) : (
          <span className={`yt-status-badge ${statusClass}`}>{item.status}</span>
        )}
      </td>
      <td>
        {sourceLabel ? (
          <span className="yt-filter-tag">{sourceLabel}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      {isAdmin && (
        <td>
          {cost ? (
            <span className="yt-cost-badge" title={cost.tip}>
              {cost.costStr}
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
      )}
      <td>
        {item.telegram_target ? (
          <span className="yt-filter-tag">{item.telegram_target}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td>
        {item.status === 'done' ? (
          item.telegram_sent ? (
            <span className="yt-status-badge yt-status-active">Sent</span>
          ) : (
            <span className="yt-status-badge yt-status-pending">Not sent</span>
          )
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="text-muted">{timeAgo(item.created_at)}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div className="yt-actions-cell">
          {item.summary_id && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleShowSummary}
              title="View summary"
            >
              👁️
            </button>
          )}
          {(item.status === 'pending' || item.status === 'failed') && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleProcessOne}
              disabled={localProcessing || processOne.isPending}
              title="Process now"
            >
              {localProcessing ? <span className="yt-spin">⟳</span> : '▶'}
            </button>
          )}
          {item.error_log && (
            <button className="btn btn-secondary btn-sm" onClick={handleShowError} title="View error">
              ⚠️
            </button>
          )}
          <button
            className="btn btn-danger btn-sm"
            onClick={handleDelete}
            disabled={deleting}
            title="Delete"
          >
            🗑️
          </button>
        </div>
      </td>
    </tr>
  );
}
