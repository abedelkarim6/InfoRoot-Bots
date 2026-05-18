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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, escapeHtml } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useAuth } from '../../auth/AuthContext';
import { useGlobalConfig } from '../../config/ConfigProvider';
import PageHeader from '../../components/PageHeader';
import { useUrlInt, useUrlString } from '../../lib/useUrlState';
import { estimateCost, timeAgo, todayISODate } from './shared';

const PAGE_SIZE = 50;

export default function VideosPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const { showNotification } = useDialogs();

  // ── Filter state — URL-backed so refresh and back-button preserve it.
  // First entry to the page (no params in URL) defaults the date range to
  // today; subsequent navigations honor whatever the URL says.
  const [filterStatus, setFilterStatus] = useUrlString('status', '');
  const [filterChannel, setFilterChannel] = useUrlString('ch', '');
  const [filterKeyword, setFilterKeyword] = useUrlString('kw', '');
  const [filterSource, setFilterSource] = useUrlString('src', '');
  const [filterDateFrom, setFilterDateFrom] = useUrlString('from', '');
  const [filterDateTo, setFilterDateTo] = useUrlString('to', '');
  const filters = {
    status: filterStatus,
    channel: filterChannel,
    keyword: filterKeyword,
    source: filterSource,
    dateFrom: filterDateFrom,
    dateTo: filterDateTo
  };
  const setFilters = useCallback(
    (next) => {
      const v = typeof next === 'function' ? next(filters) : next;
      setFilterStatus(v.status || '');
      setFilterChannel(v.channel || '');
      setFilterKeyword(v.keyword || '');
      setFilterSource(v.source || '');
      setFilterDateFrom(v.dateFrom || '');
      setFilterDateTo(v.dateTo || '');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterStatus, filterChannel, filterKeyword, filterSource, filterDateFrom, filterDateTo]
  );

  // Default the date range to today only on the very first visit (when no
  // date params are in the URL). After that the URL is the source of truth.
  const datesInitialized = useRef(false);
  useEffect(() => {
    if (datesInitialized.current) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.get('from') && !url.searchParams.get('to')) {
      const today = todayISODate();
      setFilterDateFrom(today);
      setFilterDateTo(today);
    }
    datesInitialized.current = true;
  }, [setFilterDateFrom, setFilterDateTo]);

  const [page, setPage] = useUrlInt('page', 0);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Reset page when filters change — uses a JSON-stringified key so we don't
  // depend on filters' object identity (rebuilt every render from URL state).
  const filterKey = `${filterStatus}|${filterChannel}|${filterKeyword}|${filterSource}|${filterDateFrom}|${filterDateTo}`;
  useEffect(() => {
    setPage(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const queryUrl = useMemo(() => {
    const offset = page * PAGE_SIZE;
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    if (filters.status) params.set('status', filters.status);
    if (filters.channel) params.set('channel', filters.channel);
    if (filters.keyword) params.set('keyword', filters.keyword);
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
    filters.status ||
    filters.channel ||
    filters.keyword ||
    filters.source ||
    filters.dateFrom ||
    filters.dateTo;

  // ── Mutations ────────────────────────────────────────────────
  const triggerProcess = useApiMutation('/api/youtube/queue/process', {
    invalidate: ['yt-videos'],
    successMsg: 'Queue processing started — refresh in a minute to see results',
    errorMsg: 'Failed to start queue processing'
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
    setFilters({
      status: '',
      channel: '',
      keyword: '',
      source: '',
      dateFrom: '',
      dateTo: ''
    });
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
        <DefaultTargetsCard />
      </div>

      {isAdmin && <YtThinkingCard />}

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
        <VideoTable items={items} isAdmin={isAdmin} />
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
  // Channel + tracker (keyword) dropdowns are populated from the configured
  // YouTube sources so the user picks rather than free-types.
  const { data: channelsRes } = useQuery({
    queryKey: ['yt-channels'],
    queryFn: () => api('/api/youtube/channels')
  });
  const { data: keywordsRes } = useQuery({
    queryKey: ['yt-keywords'],
    queryFn: () => api('/api/youtube/keywords')
  });
  const channels = channelsRes?.status === 'ok' ? channelsRes.channels || [] : [];
  const keywords = keywordsRes?.status === 'ok' ? keywordsRes.keywords || [] : [];

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
        <select
          className="select dash-filter-select"
          value={filters.channel}
          onChange={(e) => onChange((f) => ({ ...f, channel: e.target.value }))}
        >
          <option value="">All Channels</option>
          {channels.map((c) => (
            <option key={c.channel_id} value={c.channel_id}>
              {c.channel_name || c.channel_id}
            </option>
          ))}
        </select>
      </div>
      <div className="dash-filter-group">
        <span className="dash-filter-label">🔍 Tracker</span>
        <select
          className="select dash-filter-select"
          value={filters.keyword}
          onChange={(e) => onChange((f) => ({ ...f, keyword: e.target.value }))}
        >
          <option value="">All Trackers</option>
          {keywords.map((k) => (
            <option key={k.id} value={String(k.id)}>
              {k.keyword}
            </option>
          ))}
        </select>
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

// ─── YouTube Thinking Toggle ────────────────────────────────────────────────
//
// Gemini 2.5 extended reasoning for YouTube summarization. Independent of the
// summaries feature's toggle — backed by the `yt_gemini_thinking` setting.
// When ON, the reasoning trace is captured and stored on each yt_summaries row.

function YtThinkingCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['yt-gemini-thinking'],
    queryFn: () => api('/api/youtube/gemini-thinking')
  });

  // Optimistic local state — flips immediately, synced from server data.
  const [localEnabled, setLocalEnabled] = useState(false);
  const [localBudget, setLocalBudget] = useState(-1);
  useEffect(() => {
    if (data?.status === 'ok') {
      setLocalEnabled(!!data.enabled);
      setLocalBudget(Number.isFinite(data.budget) ? data.budget : -1);
    }
  }, [data?.status, data?.enabled, data?.budget]);

  const update = useApiMutation('/api/youtube/gemini-thinking', {
    invalidate: ['yt-gemini-thinking'],
    successMsg: 'Thinking setting updated',
    errorMsg: 'Failed to update thinking setting',
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
    setLocalEnabled(next);
    update.mutate({ enabled: next, budget });
  }
  function setBudget(next) {
    setLocalBudget(next);
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
          each video summary. Improves quality for complex prompts but increases token
          usage. The reasoning trace is saved with the summary (👁️ View summary).
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

// ─── Manual Submit Card ─────────────────────────────────────────────────────

function ManualSubmitCard() {
  const { showNotification } = useDialogs();
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [promptKey, setPromptKey] = useState('');

  // Pull the logged-in account's joined channels and keep only the
  // writable ones (creator or admin_rights). Same endpoint used by the
  // Bot/Collections channel pickers — see BotChannelsModal.jsx.
  const { data: dialogsRes, isLoading: dialogsLoading } = useQuery({
    queryKey: ['user-dialogs'],
    queryFn: () => api('/api/telegram/userbot/dialogs'),
    staleTime: 60_000
  });
  const writableChannels = useMemo(() => {
    if (dialogsRes?.status !== 'ok') return [];
    return (dialogsRes.channels || []).filter((c) => c.can_post);
  }, [dialogsRes]);
  const hasSession =
    dialogsRes?.status === 'ok' ||
    (dialogsRes && dialogsRes.status !== 'no_session' && dialogsRes.status !== 'unauthorized');

  // Global YouTube prompts — first key is the implicit default.
  const { prompts } = useGlobalConfig();
  const ytPrompts = (prompts && prompts.youtube) || {};
  const ytPromptKeys = Object.keys(ytPrompts);

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
      {
        url: u,
        telegram_target: target.trim() || null,
        prompt_key: promptKey || null
      },
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
        {hasSession === false ? (
          <input
            type="text"
            className="input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Telegram target (e.g. @channel)"
            style={{ flex: 1 }}
            title="No Telegram account linked — enter a target manually"
          />
        ) : (
          <select
            className="select"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{ flex: 1 }}
            disabled={dialogsLoading}
            title="Pick a channel where your account can post"
          >
            <option value="">
              {dialogsLoading
                ? 'Loading channels…'
                : writableChannels.length === 0
                ? 'No writable channels — use defaults'
                : 'Use default targets'}
            </option>
            {writableChannels.map((c) => {
              const value = c.username ? '@' + c.username : String(c.id);
              const label = c.username ? `${c.title} (@${c.username})` : c.title;
              return (
                <option key={c.id} value={value}>
                  {label}
                </option>
              );
            })}
          </select>
        )}
        <select
          className="select"
          value={promptKey}
          onChange={(e) => setPromptKey(e.target.value)}
          style={{ flex: 1 }}
          title="Pick which YouTube prompt to summarize this video with"
        >
          <option value="">
            {ytPromptKeys.length === 0 ? 'No prompts — use built-in default' : '(Default prompt)'}
          </option>
          {ytPromptKeys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
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
  const { showNotification } = useDialogs();
  const [targets, setTargets] = useState([]);
  const [customDraft, setCustomDraft] = useState('');

  // Same query key as ManualSubmitCard — React Query shares the cache, so
  // both cards on this page consume a single /api/telegram/userbot/dialogs
  // round-trip. Filter to writable channels (creator or admin_rights).
  const { data: dialogsRes, isLoading: dialogsLoading } = useQuery({
    queryKey: ['user-dialogs'],
    queryFn: () => api('/api/telegram/userbot/dialogs'),
    staleTime: 60_000
  });
  const writableChannels = useMemo(() => {
    if (dialogsRes?.status !== 'ok') return [];
    return (dialogsRes.channels || []).filter((c) => c.can_post);
  }, [dialogsRes]);
  const hasSession =
    dialogsRes?.status === 'ok' ||
    (dialogsRes && dialogsRes.status !== 'no_session' && dialogsRes.status !== 'unauthorized');

  useEffect(() => {
    let cancelled = false;
    api('/api/youtube/prompt').then((res) => {
      if (cancelled || res?.status !== 'ok') return;
      setTargets(Array.isArray(res.default_targets) ? res.default_targets : []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useApiMutation('/api/youtube/default-targets/save', {
    successMsg: 'Default targets saved',
    errorMsg: 'Failed to save targets'
  });

  function addTarget(raw) {
    const v = (raw || '').trim();
    if (!v) return;
    if (targets.includes(v)) {
      showNotification(`"${v}" is already in the list`, 'info');
      return;
    }
    setTargets((prev) => [...prev, v]);
  }

  function removeTarget(value) {
    setTargets((prev) => prev.filter((t) => t !== value));
  }

  function handlePickerChange(e) {
    const value = e.target.value;
    if (value) addTarget(value);
    e.target.value = ''; // reset so the same option can be re-picked after a remove
  }

  function handleCustomAdd() {
    addTarget(customDraft);
    setCustomDraft('');
  }

  // Hide channels already in the targets list from the picker.
  const availableChannels = writableChannels.filter((c) => {
    const value = c.username ? '@' + c.username : String(c.id);
    return !targets.includes(value);
  });

  return (
    <div className="yt-prompt-card" style={{ flex: '0 0 auto', minWidth: 260 }}>
      <div className="yt-prompt-header">
        <h3>📤 Default Targets</h3>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => save.mutate({ targets })}
          disabled={save.isPending}
        >
          Save
        </button>
      </div>
      <p className="text-muted" style={{ margin: '0 0 8px', fontSize: 13 }}>
        Fallback targets when a channel/tracker has none set.
      </p>

      {targets.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            marginBottom: 8
          }}
        >
          {targets.map((t) => (
            <span
              key={t}
              className="yt-filter-tag"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {t}
              <button
                onClick={() => removeTarget(t)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 14,
                  lineHeight: 1
                }}
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {hasSession !== false && (
        <select
          className="select"
          value=""
          onChange={handlePickerChange}
          disabled={dialogsLoading}
          style={{ width: '100%', marginBottom: 6 }}
          title="Pick a channel where your account can post"
        >
          <option value="">
            {dialogsLoading
              ? 'Loading channels…'
              : availableChannels.length === 0
              ? writableChannels.length === 0
                ? 'No writable channels found'
                : 'All your channels are already added'
              : '+ Add from your channels'}
          </option>
          {availableChannels.map((c) => {
            const value = c.username ? '@' + c.username : String(c.id);
            const label = c.username ? `${c.title} (@${c.username})` : c.title;
            return (
              <option key={c.id} value={value}>
                {label}
              </option>
            );
          })}
        </select>
      )}

      <div style={{ display: 'flex', gap: 4 }}>
        <input
          type="text"
          className="input"
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCustomAdd();
            }
          }}
          placeholder="Or type @channel"
          style={{ flex: 1 }}
        />
        <button
          className="btn btn-secondary btn-sm"
          onClick={handleCustomAdd}
          disabled={!customDraft.trim()}
        >
          Add
        </button>
      </div>
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

function VideoTable({ items, isAdmin }) {
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
            <VideoRow key={item.id} item={item} isAdmin={isAdmin} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VideoRow({ item, isAdmin }) {
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
    // The backend now dispatches the job in the background and returns
    // immediately, so we don't await the actual processing result here.
    // The row's status will flip to 'processing' on the next refetch and
    // to 'done'/'failed' once the worker finishes (auto-refresh: 30s).
    setLocalProcessing(true);
    try {
      const res = await api('/api/youtube/queue/process-one', { id: item.id });
      if (res?.status === 'ok') {
        showNotification('Processing started — status will update shortly', 'success');
      } else {
        showNotification(res?.message || 'Failed to start processing', 'error');
      }
    } finally {
      setLocalProcessing(false);
      qc.invalidateQueries({ queryKey: ['yt-videos'] });
    }
  }

  async function handleShowSummary() {
    const res = await api(`/api/youtube/summaries/${item.summary_id}`);
    if (res?.status !== 'ok') return showNotification('Failed to load summary.', 'error');
    const s = res.summary;
    const thoughtsBlock = s.thoughts
      ? `
      <details style="margin-top:14px;">
        <summary style="cursor:pointer;font-weight:600;">🧠 Thinking trace</summary>
        <div class="yt-summary-text" style="white-space:pre-wrap;margin-top:8px;max-height:40vh;overflow-y:auto;color:var(--text-muted);">${escapeHtml(s.thoughts)}</div>
      </details>`
      : '';
    const html = `
      <div class="yt-summary-meta" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <span>📺 ${escapeHtml(s.channel_name || '—')}</span>
        <span>🔧 ${escapeHtml(s.transcript_source || '—')}</span>
        <span>${s.telegram_sent ? '✅ Sent' : '⏳ Not sent'}${s.telegram_target ? ' → ' + escapeHtml(s.telegram_target) : ''}</span>
        <span>🔗 <a href="https://youtube.com/watch?v=${escapeHtml(s.video_id)}" target="_blank" rel="noopener">${escapeHtml(s.video_id)}</a></span>
      </div>
      <div class="yt-summary-text" style="white-space:pre-wrap;">${escapeHtml(s.summary_text || '')}</div>
      ${thoughtsBlock}
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
