/**
 * YouTube SEOs (Keyword trackers) — Phase 3 / Wave 3 port.
 *
 * Mirrors `loadYtKeywordsData` and friends in static/js/youtube.js. Renders a
 * grid of keyword tracker cards with per-tracker schedule, filters, run/edit/
 * delete actions, plus a collapsible "Blocked Channels" panel.
 *
 * The endpoint also returns `seo_visible: false` for non-admin users whose
 * SEO list is hidden — we render only a count placeholder in that case.
 *
 * Data: TanStack Query keys
 *   - ['yt-keywords']         → /api/youtube/keywords
 *   - ['yt-blocked-channels'] → /api/youtube/blocked-channels (count badge)
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, escapeHtml } from '../../lib/api';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useUrlString } from '../../lib/useUrlState';
import PageHeader from '../../components/PageHeader';
import {
  LANG_OPTIONS,
  parseCommaSep,
  timeAgo,
  kwScheduleToFields,
  kwFieldsToIntervalMinutes
} from './shared';

export default function KeywordsPage() {
  const { showNotification } = useDialogs();
  const [search, setSearch] = useUrlString('q', '');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [modalKw, setModalKw] = useState(null); // null | { mode: 'add' } | { mode: 'edit', kw }

  const { data, isLoading } = useQuery({
    queryKey: ['yt-keywords'],
    queryFn: () => api('/api/youtube/keywords')
  });

  const ok = data?.status === 'ok';
  const seoVisible = ok ? data.seo_visible !== false : true;
  const seoCount = ok ? data.seo_count || 0 : 0;
  const allKeywords = ok ? data.keywords || [] : [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allKeywords;
    return allKeywords.filter((k) => (k.keyword || '').toLowerCase().includes(q));
  }, [allKeywords, search]);

  const allActive = allKeywords.length > 0 && allKeywords.every((k) => k.active);

  const toggleAll = useApiMutation('/api/youtube/keywords/toggle-all', {
    invalidate: ['yt-keywords'],
    successMsg: (_r, vars) => (vars.active ? 'All trackers enabled' : 'All trackers disabled'),
    errorMsg: 'Failed to toggle trackers'
  });

  const runAll = useApiMutation('/api/youtube/keywords/run-all', {
    invalidate: ['yt-keywords', 'yt-videos'],
    successMsg: (res) => `All searches done: ${res?.enqueued ?? 0} video(s) enqueued`,
    errorMsg: 'Search failed'
  });

  function toggleSelected(id, checked) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function runSelected() {
    const ids = [...selectedIds];
    if (!ids.length) return showNotification('No trackers selected.', 'error');
    showNotification(`Running ${ids.length} tracker(s)…`, 'info');
    let totalEnqueued = 0;
    let errors = 0;
    for (const id of ids) {
      const res = await api('/api/youtube/keywords/run', { id });
      if (res?.status === 'ok') totalEnqueued += res.enqueued || 0;
      else errors++;
    }
    if (errors) {
      showNotification(`Done: ${totalEnqueued} video(s) enqueued, ${errors} failed`, 'error');
    } else {
      showNotification(`Done: ${totalEnqueued} video(s) enqueued from ${ids.length} tracker(s)`, 'success');
    }
    setSelectedIds(new Set());
  }

  // Non-admin user with seo_visible=false: count-only placeholder, no controls
  if (!isLoading && ok && !seoVisible) {
    return (
      <div className="page active">
        <PageHeader title="SEOs" subtitle="SEO keyword search configs with filtering rules" />
        <p className="mon-empty" style={{ color: 'var(--text-muted)' }}>
          🔎 {seoCount} SEO tracker{seoCount !== 1 ? 's' : ''} assigned — details hidden by admin.
        </p>
      </div>
    );
  }

  return (
    <div className="page active">
      <PageHeader title="SEOs" subtitle="SEO keyword search configs with filtering rules">
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
          <span>{allActive ? 'All Active' : 'All Paused'}</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={allActive}
              disabled={toggleAll.isPending || allKeywords.length === 0}
              onChange={(e) => toggleAll.mutate({ active: e.target.checked })}
            />
            <span className="toggle-slider"></span>
          </label>
        </label>
        <input
          type="text"
          className="input"
          placeholder="Search trackers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 180 }}
        />
        {selectedIds.size > 0 && (
          <button className="btn btn-secondary" onClick={runSelected}>
            ▶ Run Selected ({selectedIds.size})
          </button>
        )}
        <button className="btn btn-secondary" onClick={() => runAll.mutate({})} disabled={runAll.isPending}>
          ▶ Run All
        </button>
        <button className="btn btn-primary" onClick={() => setModalKw({ mode: 'add' })}>
          <span>➕</span> Add Tracker
        </button>
      </PageHeader>

      <BlockedChannelsCard />

      {isLoading ? (
        <p className="mon-empty">Loading…</p>
      ) : !ok ? (
        <p className="mon-empty">Failed to load keywords.</p>
      ) : allKeywords.length === 0 ? (
        <p className="mon-empty">No keyword configs. Click "Add Tracker" to get started.</p>
      ) : (
        <div className="yt-cards-grid">
          {filtered.map((kw) => (
            <KeywordCard
              key={kw.id}
              kw={kw}
              selected={selectedIds.has(kw.id)}
              onToggleSelect={(checked) => toggleSelected(kw.id, checked)}
              onEdit={() => setModalKw({ mode: 'edit', kw })}
            />
          ))}
        </div>
      )}

      {modalKw && (
        <KeywordModal
          mode={modalKw.mode}
          kw={modalKw.kw}
          onClose={() => setModalKw(null)}
        />
      )}
    </div>
  );
}

// ─── Keyword Card ───────────────────────────────────────────────────────────

function KeywordCard({ kw, selected, onToggleSelect, onEdit }) {
  const toggle = useApiMutation('/api/youtube/keywords/toggle', {
    invalidate: ['yt-keywords'],
    successMsg: (_r, vars) => (vars.active ? 'Keyword enabled' : 'Keyword disabled'),
    errorMsg: 'Failed to toggle keyword'
  });

  const remove = useApiMutation('/api/youtube/keywords/delete', {
    invalidate: ['yt-keywords', 'recycle-bin'],
    successMsg: 'Keyword deleted',
    errorMsg: 'Failed to delete keyword'
  });

  const run = useApiMutation('/api/youtube/keywords/run', {
    invalidate: ['yt-keywords', 'yt-videos'],
    successMsg: (res) => `Search complete: ${res?.enqueued ?? 0} video(s) enqueued`,
    errorMsg: 'Search failed'
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: 'Delete this keyword config?',
    title: 'Delete Tracker',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  const filters = [];
  if (kw.min_duration_seconds) filters.push(`Min ${Math.round(kw.min_duration_seconds / 60)}min`);
  if (kw.max_duration_seconds) filters.push(`Max ${Math.round(kw.max_duration_seconds / 60)}min`);
  if (kw.min_view_count > 0) filters.push(`≥${kw.min_view_count} views`);
  if (kw.language) filters.push(`Lang: ${kw.language}`);
  if ((kw.channel_allowlist || []).length) filters.push(`${kw.channel_allowlist.length} allowed ch`);
  if ((kw.channel_blocklist || []).length) filters.push(`${kw.channel_blocklist.length} blocked ch`);
  if ((kw.title_must_include || []).length) filters.push(`+${kw.title_must_include.length} title terms`);
  if ((kw.title_must_exclude || []).length) filters.push(`-${kw.title_must_exclude.length} excluded`);

  const targets = kw.telegram_targets || [];
  const subKws = kw.sub_keywords || [];

  let scheduleInfo;
  if (kw.schedule_interval_minutes) {
    const sf = kwScheduleToFields(kw.schedule_interval_minutes);
    const lastRun = kw.last_run_at ? timeAgo(kw.last_run_at) : 'never';
    scheduleInfo = (
      <div className="yt-ch-detail" style={{ marginTop: 4 }}>
        ⏰ Every <strong>{`${sf.val} ${sf.unit}`}</strong>{' '}
        <span className="text-muted">· Last run: {lastRun}</span>
      </div>
    );
  } else {
    scheduleInfo = (
      <div className="yt-ch-detail text-muted" style={{ marginTop: 4 }}>
        ⏰ No schedule (manual only)
      </div>
    );
  }

  return (
    <div className={`yt-keyword-card${selected ? ' yt-kw-card-selected' : ''}`}>
      <div className="yt-kw-header">
        <label className="yt-kw-select-label" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="yt-kw-select"
            checked={selected}
            onChange={(e) => onToggleSelect(e.target.checked)}
          />
        </label>
        <div className="yt-kw-name">"{kw.keyword}"</div>
        <span className={`yt-status-badge ${kw.active ? 'yt-status-active' : 'yt-status-inactive'}`}>
          {kw.active ? 'Active' : 'Inactive'}
        </span>
      </div>
      {subKws.length > 0 && (
        <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {subKws.map((sk, i) => (
            <span key={i} className="yt-filter-tag" style={{ fontSize: 12 }}>
              {sk}
            </span>
          ))}
        </div>
      )}
      <div className="text-muted" style={{ fontSize: 12 }}>
        Window: {kw.date_window_days} day(s) · Type: {kw.upload_type || 'video'}
      </div>
      <div
        className={'yt-ch-detail' + (targets.length ? '' : ' text-muted')}
        style={{ marginTop: 6 }}
      >
        📤{' '}
        {targets.length
          ? targets.map((t, i) => (
              <span key={i} className="yt-filter-tag" style={{ marginRight: 4 }}>
                {t}
              </span>
            ))
          : 'No Telegram targets'}
      </div>
      {scheduleInfo}
      {filters.length > 0 && (
        <div className="yt-kw-filters">
          {filters.map((f, i) => (
            <span key={i} className="yt-filter-tag">{f}</span>
          ))}
        </div>
      )}
      <div className="yt-kw-actions">
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={!!kw.active}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate({ id: kw.id, active: e.target.checked })}
          />
          <span className="toggle-slider"></span>
        </label>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => run.mutate({ id: kw.id })}
          disabled={run.isPending}
        >
          ▶ Run
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onEdit}>
          ✏️
        </button>
        <button
          className="btn btn-danger btn-sm"
          onClick={() => confirmDelete({ id: kw.id })}
          disabled={remove.isPending}
        >
          🗑️
        </button>
      </div>
    </div>
  );
}

// ─── Blocked Channels (collapsible card on Keywords page) ───────────────────

function BlockedChannelsCard() {
  const [open, setOpen] = useState(false);
  const [chId, setChId] = useState('');
  const [chName, setChName] = useState('');

  const { data } = useQuery({
    queryKey: ['yt-blocked-channels'],
    queryFn: () => api('/api/youtube/blocked-channels')
  });
  const channels = data?.status === 'ok' ? data.channels || [] : [];

  const add = useApiMutation('/api/youtube/blocked-channels/add', {
    invalidate: ['yt-blocked-channels'],
    successMsg: 'Channel blocked',
    errorMsg: 'Failed to block channel'
  });
  const remove = useApiMutation('/api/youtube/blocked-channels/delete', {
    invalidate: ['yt-blocked-channels'],
    successMsg: 'Channel unblocked',
    errorMsg: 'Failed to unblock channel'
  });

  const confirmRemove = useConfirmedMutation(remove, (vars) => ({
    message: `Unblock channel <strong>${escapeHtml(vars.channel_id)}</strong>?`,
    title: 'Unblock Channel',
    confirmLabel: 'Unblock',
    confirmClass: 'btn-primary'
  }));

  function handleAdd() {
    const id = chId.trim();
    if (!id) return;
    add.mutate({ channel_id: id, channel_name: chName.trim() || null });
    setChId('');
    setChName('');
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div
        className="card-header"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : '', transition: 'transform .2s' }}>
          ▶
        </span>
        <strong>🚫 Blocked Channels</strong>
        <span className="text-muted" style={{ marginLeft: 4 }}>
          {channels.length ? `(${channels.length})` : ''}
        </span>
      </div>
      {open && (
        <div style={{ display: 'block', padding: '12px 16px' }}>
          <p className="text-muted" style={{ margin: '0 0 10px' }}>
            Videos from these channels are excluded from <em>all</em> keyword searches.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              className="input"
              value={chId}
              onChange={(e) => setChId(e.target.value)}
              placeholder="Channel ID (UCxxxx)"
              style={{ flex: 1 }}
            />
            <input
              type="text"
              className="input"
              value={chName}
              onChange={(e) => setChName(e.target.value)}
              placeholder="Name (optional)"
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={add.isPending}>
              Add
            </button>
          </div>
          {channels.length === 0 ? (
            <p className="text-muted">No blocked channels.</p>
          ) : (
            channels.map((ch) => (
              <div
                key={ch.channel_id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border)'
                }}
              >
                <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }}>{ch.channel_id}</span>
                <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{ch.channel_name || ''}</span>
                <span className="text-muted" style={{ fontSize: 12 }}>
                  {ch.created_at ? timeAgo(ch.created_at) : ''}
                </span>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => confirmRemove({ channel_id: ch.channel_id })}
                  title="Unblock"
                  disabled={remove.isPending}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Keyword Add/Edit Modal ─────────────────────────────────────────────────

function KeywordModal({ mode, kw, onClose }) {
  const isEdit = mode === 'edit';
  const { showNotification } = useDialogs();

  const initialSched = kwScheduleToFields(kw?.schedule_interval_minutes);

  const [form, setForm] = useState(() => ({
    keyword: kw?.keyword || '',
    window: kw?.date_window_days || 1,
    sub_keywords: (kw?.sub_keywords || []).join(', '),
    telegram_targets: (kw?.telegram_targets || []).join(', '),
    min_dur_min: kw?.min_duration_seconds ? Math.round(kw.min_duration_seconds / 60) : '',
    max_dur_min: kw?.max_duration_seconds ? Math.round(kw.max_duration_seconds / 60) : '',
    min_view_count: kw?.min_view_count || 0,
    language: kw?.language || '',
    upload_type: kw?.upload_type || 'video',
    sched_val: initialSched.val || '',
    sched_unit: initialSched.unit || 'hours',
    allowlist: (kw?.channel_allowlist || []).join(', '),
    blocklist: (kw?.channel_blocklist || []).join(', '),
    must_include: (kw?.title_must_include || []).join(', '),
    must_exclude: (kw?.title_must_exclude || []).join(', '),
    prompt: kw?.prompt || ''
  }));
  const setF = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  const save = useApiMutation(isEdit ? '/api/youtube/keywords/update' : '/api/youtube/keywords/add', {
    invalidate: ['yt-keywords'],
    successMsg: isEdit ? 'Keyword updated' : 'Keyword added',
    errorMsg: 'Failed to save keyword',
    onSuccess: () => onClose()
  });

  function handleSubmit() {
    const keyword = form.keyword.trim();
    if (!keyword) {
      showNotification('Keyword is required.', 'error');
      return;
    }
    const payload = {
      keyword,
      sub_keywords: parseCommaSep(form.sub_keywords),
      telegram_targets: parseCommaSep(form.telegram_targets),
      prompt: form.prompt.trim() || null,
      date_window_days: parseInt(form.window, 10) || 1,
      active: kw ? kw.active : true,
      min_duration_seconds: form.min_dur_min ? parseInt(form.min_dur_min, 10) * 60 : null,
      max_duration_seconds: form.max_dur_min ? parseInt(form.max_dur_min, 10) * 60 : null,
      min_view_count: parseInt(form.min_view_count, 10) || 0,
      language: form.language || null,
      upload_type: form.upload_type || 'video',
      channel_allowlist: parseCommaSep(form.allowlist),
      channel_blocklist: parseCommaSep(form.blocklist),
      title_must_include: parseCommaSep(form.must_include),
      title_must_exclude: parseCommaSep(form.must_exclude),
      schedule_interval_minutes: kwFieldsToIntervalMinutes(form.sched_val, form.sched_unit)
    };
    if (isEdit) payload.id = kw.id;
    save.mutate(payload);
  }

  return (
    <div className="dialog-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog-box yt-keyword-modal">
        <div className="dialog-title">{isEdit ? 'Edit' : 'Add'} Keyword Config</div>
        <div className="yt-kw-form">
          <div className="yt-kw-form-row">
            <div className="yt-kw-form-field">
              <label className="input-label">Keyword *</label>
              <input
                type="text"
                className="input"
                value={form.keyword}
                onChange={(e) => setF('keyword', e.target.value)}
                placeholder="Main search term"
              />
            </div>
            <div className="yt-kw-form-field" style={{ maxWidth: 100 }}>
              <label className="input-label">Window (days)</label>
              <input
                type="number"
                className="input"
                value={form.window}
                onChange={(e) => setF('window', e.target.value)}
                min="1"
                max="30"
              />
            </div>
          </div>
          <div className="yt-kw-form-field">
            <label className="input-label">
              Sub-keywords{' '}
              <span className="text-muted">(comma-separated variations — same config, separate searches)</span>
            </label>
            <input
              type="text"
              className="input"
              value={form.sub_keywords}
              onChange={(e) => setF('sub_keywords', e.target.value)}
              placeholder="variation1, variation2, …"
            />
          </div>
          <div className="yt-kw-form-field">
            <label className="input-label">
              Telegram Targets <span className="text-muted">(comma-separated: @ch1, @ch2)</span>
            </label>
            <input
              type="text"
              className="input"
              value={form.telegram_targets}
              onChange={(e) => setF('telegram_targets', e.target.value)}
              placeholder="@channel1, @channel2"
            />
          </div>
          <div className="yt-kw-form-row">
            <div className="yt-kw-form-field">
              <label className="input-label">Min minutes</label>
              <input
                type="number"
                className="input"
                value={form.min_dur_min}
                onChange={(e) => setF('min_dur_min', e.target.value)}
                placeholder="No min"
              />
            </div>
            <div className="yt-kw-form-field">
              <label className="input-label">Max minutes</label>
              <input
                type="number"
                className="input"
                value={form.max_dur_min}
                onChange={(e) => setF('max_dur_min', e.target.value)}
                placeholder="No max"
              />
            </div>
            <div className="yt-kw-form-field">
              <label className="input-label">Min views</label>
              <input
                type="number"
                className="input"
                value={form.min_view_count}
                onChange={(e) => setF('min_view_count', e.target.value)}
                min="0"
              />
            </div>
          </div>
          <div className="yt-kw-form-row">
            <div className="yt-kw-form-field">
              <label className="input-label">Language</label>
              <select
                className="select"
                value={form.language}
                onChange={(e) => setF('language', e.target.value)}
              >
                {LANG_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="yt-kw-form-field">
              <label className="input-label">Upload type</label>
              <select
                className="select"
                value={form.upload_type}
                onChange={(e) => setF('upload_type', e.target.value)}
              >
                <option value="video">Video</option>
                <option value="any">Any</option>
                <option value="live">Live</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>
          <div className="yt-kw-form-row">
            <div className="yt-kw-form-field">
              <label className="input-label">
                Schedule interval <span className="text-muted">(how often to auto-run)</span>
              </label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="number"
                  className="input"
                  value={form.sched_val}
                  onChange={(e) => setF('sched_val', e.target.value)}
                  min="1"
                  placeholder="Off"
                  style={{ width: 80 }}
                />
                <select
                  className="select"
                  value={form.sched_unit}
                  onChange={(e) => setF('sched_unit', e.target.value)}
                  style={{ width: 110 }}
                >
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                  <option value="days">Days</option>
                </select>
              </div>
            </div>
          </div>
          <div className="yt-kw-form-field">
            <label className="input-label">
              Channel allowlist{' '}
              <span className="text-muted">(comma-separated IDs, empty = accept all)</span>
            </label>
            <input
              type="text"
              className="input"
              value={form.allowlist}
              onChange={(e) => setF('allowlist', e.target.value)}
              placeholder="UCxxxx, UCyyyy"
            />
          </div>
          <div className="yt-kw-form-field">
            <label className="input-label">
              Channel blocklist <span className="text-muted">(comma-separated IDs)</span>
            </label>
            <input
              type="text"
              className="input"
              value={form.blocklist}
              onChange={(e) => setF('blocklist', e.target.value)}
              placeholder="UCxxxx, UCyyyy"
            />
          </div>
          <div className="yt-kw-form-field">
            <label className="input-label">
              Title must include{' '}
              <span className="text-muted">(comma-separated, empty = no requirement)</span>
            </label>
            <input
              type="text"
              className="input"
              value={form.must_include}
              onChange={(e) => setF('must_include', e.target.value)}
              placeholder="term1, term2"
            />
          </div>
          <div className="yt-kw-form-field">
            <label className="input-label">
              Title must exclude <span className="text-muted">(comma-separated)</span>
            </label>
            <input
              type="text"
              className="input"
              value={form.must_exclude}
              onChange={(e) => setF('must_exclude', e.target.value)}
              placeholder="term1, term2"
            />
          </div>
          <div className="yt-kw-form-field">
            <label className="input-label">
              Custom Prompt <span className="text-muted">(leave empty for global default)</span>
            </label>
            <textarea
              className="input yt-prompt-textarea"
              rows={3}
              value={form.prompt}
              onChange={(e) => setF('prompt', e.target.value)}
              placeholder="Custom summarization prompt…"
            />
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
