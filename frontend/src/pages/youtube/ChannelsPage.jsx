/**
 * YouTube Channels — Phase 3 / Wave 3 port.
 *
 * Mirrors `loadYtChannelsData` and friends in static/js/youtube.js. Renders a
 * grid of channel cards with toggle/edit/delete actions, plus a collapsible
 * "Blocked Keywords" panel (global title-blocklist).
 *
 * Data: TanStack Query keys
 *   - ['yt-channels']         → /api/youtube/channels
 *   - ['yt-blocked-keywords'] → /api/youtube/blocked-keywords (loaded eagerly
 *                               so the count badge is correct on first paint)
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, escapeHtml } from '../../lib/api';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useGlobalConfig } from '../../config/ConfigProvider';
import PageHeader from '../../components/PageHeader';
import { LANG_OPTIONS, parseCommaSep, timeAgo } from './shared';

export default function ChannelsPage() {
  const { showNotification } = useDialogs();
  const [modalChannel, setModalChannel] = useState(null); // { mode: 'add' } | { mode: 'edit', channel }

  const { data, isLoading } = useQuery({
    queryKey: ['yt-channels'],
    queryFn: () => api('/api/youtube/channels')
  });
  const channels = data?.status === 'ok' ? data.channels || [] : [];

  const toggleAll = useApiMutation('/api/youtube/channels/toggle-all', {
    invalidate: ['yt-channels'],
    successMsg: (_r, vars) => (vars.active ? 'All channels enabled' : 'All channels disabled'),
    errorMsg: 'Failed to toggle channels'
  });

  const allActive = channels.length > 0 && channels.every((c) => c.active);

  return (
    <div className="page active">
      <PageHeader title="YouTube Channels" subtitle="WebSub-monitored channel subscriptions">
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
              disabled={toggleAll.isPending || channels.length === 0}
              onChange={(e) => toggleAll.mutate({ active: e.target.checked })}
            />
            <span className="toggle-slider"></span>
          </label>
        </label>
        <button className="btn btn-primary" onClick={() => setModalChannel({ mode: 'add' })}>
          <span>➕</span> Add Channel
        </button>
      </PageHeader>

      <BlockedKeywordsCard />

      {isLoading ? (
        <p className="mon-empty">Loading…</p>
      ) : channels.length === 0 ? (
        <p className="mon-empty">
          No channels configured. Click "Add Channel" to get started.
        </p>
      ) : (
        <div className="yt-cards-grid">
          {channels.map((ch) => (
            <ChannelCard
              key={ch.channel_id}
              ch={ch}
              onEdit={() => setModalChannel({ mode: 'edit', channel: ch })}
              onNotify={showNotification}
            />
          ))}
        </div>
      )}

      {modalChannel && (
        <ChannelModal
          mode={modalChannel.mode}
          channel={modalChannel.channel}
          onClose={() => setModalChannel(null)}
        />
      )}
    </div>
  );
}

// ─── Channel Card ───────────────────────────────────────────────────────────

function ChannelCard({ ch, onEdit }) {
  const toggle = useApiMutation('/api/youtube/channels/toggle', {
    invalidate: ['yt-channels'],
    successMsg: (_r, vars) => (vars.active ? 'Channel enabled' : 'Channel disabled'),
    errorMsg: 'Failed to toggle channel'
  });

  const subscribe = useApiMutation('/api/youtube/channels/subscribe', {
    invalidate: ['yt-channels'],
    successMsg: (res) => (res?.subscribed ? 'WebSub subscription sent' : null),
    errorMsg: 'Subscription request failed'
  });

  const remove = useApiMutation('/api/youtube/channels/delete', {
    invalidate: ['yt-channels', 'recycle-bin'],
    successMsg: 'Channel deleted',
    errorMsg: 'Failed to delete channel'
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete channel <strong>${escapeHtml(ch.channel_id)}</strong>?`,
    title: 'Delete Channel',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  const isSubscribed = !!ch.websub_subscribed_at;
  const exp = ch.websub_expires_at ? new Date(ch.websub_expires_at).toLocaleDateString() : '?';

  const filters = [];
  if (ch.min_duration_seconds) filters.push(`Min ${Math.round(ch.min_duration_seconds / 60)}min`);
  if (ch.max_duration_seconds) filters.push(`Max ${Math.round(ch.max_duration_seconds / 60)}min`);
  if (ch.min_view_count > 0) filters.push(`≥${ch.min_view_count} views`);
  if (ch.language) filters.push(`Lang: ${ch.language}`);
  if (ch.upload_type) filters.push(`Type: ${ch.upload_type}`);
  if ((ch.title_must_include || []).length) filters.push(`+${ch.title_must_include.length} title terms`);
  if ((ch.title_must_exclude || []).length) filters.push(`-${ch.title_must_exclude.length} excluded`);

  const targets = ch.telegram_targets || [];

  return (
    <div className="yt-channel-card">
      <div className="yt-ch-header">
        <div>
          <div className="yt-ch-name">{ch.channel_name || ch.channel_id}</div>
          <div className="yt-ch-id text-muted">{ch.channel_id}</div>
        </div>
        <span className={`yt-status-badge ${ch.active ? 'yt-status-active' : 'yt-status-inactive'}`}>
          {ch.active ? 'Active' : 'Inactive'}
        </span>
      </div>
      <div className="yt-ch-detail">
        {isSubscribed ? (
          <span className="yt-status-badge yt-status-active">Subscribed (exp {exp})</span>
        ) : (
          <span className="yt-status-badge yt-status-pending">Not subscribed</span>
        )}
      </div>
      <div className={'yt-ch-detail' + (targets.length ? '' : ' text-muted')}>
        📤{' '}
        {targets.length
          ? targets.map((t, i) => (
              <span key={i} className="yt-filter-tag" style={{ marginRight: 4 }}>
                {t}
              </span>
            ))
          : 'No Telegram targets'}
      </div>
      {filters.length > 0 && (
        <div className="yt-kw-filters">
          {filters.map((f, i) => (
            <span key={i} className="yt-filter-tag">{f}</span>
          ))}
        </div>
      )}
      {ch.last_video ? (
        <div className="yt-ch-detail">
          Last: <strong>{ch.last_video.title || ch.last_video.video_id}</strong>{' '}
          <span className="text-muted">({timeAgo(ch.last_video.discovered_at)})</span>
        </div>
      ) : (
        <div className="yt-ch-detail text-muted">No videos received yet</div>
      )}
      <div className="yt-ch-actions">
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={!!ch.active}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate({ channel_id: ch.channel_id, active: e.target.checked })}
          />
          <span className="toggle-slider"></span>
        </label>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => subscribe.mutate({ channel_id: ch.channel_id })}
          disabled={subscribe.isPending}
          title="Re-subscribe WebSub"
        >
          🔔 {isSubscribed ? 'Re-subscribe' : 'Subscribe'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onEdit}>
          ✏️
        </button>
        <button
          className="btn btn-danger btn-sm"
          onClick={() => confirmDelete({ channel_id: ch.channel_id })}
          disabled={remove.isPending}
        >
          🗑️
        </button>
      </div>
    </div>
  );
}

// ─── Blocked Keywords (collapsible card on Channels page) ───────────────────

function BlockedKeywordsCard() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const { data } = useQuery({
    queryKey: ['yt-blocked-keywords'],
    queryFn: () => api('/api/youtube/blocked-keywords')
  });
  const keywords = data?.status === 'ok' ? data.keywords || [] : [];

  const add = useApiMutation('/api/youtube/blocked-keywords/add', {
    invalidate: ['yt-blocked-keywords'],
    successMsg: 'Keyword blocked',
    errorMsg: 'Failed to add blocked keyword'
  });
  const remove = useApiMutation('/api/youtube/blocked-keywords/delete', {
    invalidate: ['yt-blocked-keywords'],
    successMsg: 'Keyword unblocked',
    errorMsg: 'Failed to remove blocked keyword'
  });

  function handleAdd() {
    const kw = draft.trim();
    if (!kw) return;
    add.mutate({ keyword: kw });
    setDraft('');
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
        <strong>🚫 Blocked Keywords</strong>
        <span className="text-muted" style={{ marginLeft: 4 }}>
          {keywords.length ? `(${keywords.length})` : ''}
        </span>
      </div>
      {open && (
        <div style={{ display: 'block', padding: '12px 16px' }}>
          <p className="text-muted" style={{ margin: '0 0 10px' }}>
            Videos with titles containing these keywords are excluded from <em>all</em> channel notifications.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
              }}
              placeholder="Keyword to block"
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={add.isPending}>
              Add
            </button>
          </div>
          {keywords.length === 0 ? (
            <p className="text-muted">No blocked keywords.</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {keywords.map((kw) => (
                <span
                  key={kw.id}
                  className="yt-filter-tag"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  {kw.keyword}
                  <span
                    style={{ cursor: 'pointer', opacity: 0.6, fontSize: 14 }}
                    onClick={() => remove.mutate({ id: kw.id })}
                    title="Remove"
                  >
                    ✕
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Channel Add/Edit Modal ─────────────────────────────────────────────────

function ChannelModal({ mode, channel, onClose }) {
  const isEdit = mode === 'edit';
  const { showNotification } = useDialogs();

  const { prompts } = useGlobalConfig();
  const ytPrompts = (prompts && prompts.youtube) || {};
  const ytPromptKeys = Object.keys(ytPrompts);

  const [form, setForm] = useState(() => ({
    channel_id: channel?.channel_id || '',
    channel_name: channel?.channel_name || '',
    telegram_targets: (channel?.telegram_targets || []).join(', '),
    min_dur_min: channel?.min_duration_seconds ? Math.round(channel.min_duration_seconds / 60) : '',
    max_dur_min: channel?.max_duration_seconds ? Math.round(channel.max_duration_seconds / 60) : '',
    min_view_count: channel?.min_view_count || 0,
    language: channel?.language || '',
    upload_type: channel?.upload_type || '',
    must_include: (channel?.title_must_include || []).join(', '),
    must_exclude: (channel?.title_must_exclude || []).join(', '),
    prompt_key: channel?.prompt_key || ''
  }));
  const setF = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  const save = useApiMutation(isEdit ? '/api/youtube/channels/update' : '/api/youtube/channels/add', {
    invalidate: ['yt-channels'],
    successMsg: (res) =>
      isEdit ? 'Channel updated' : `Channel added${res?.subscribed ? ' & subscribed' : ''}`,
    errorMsg: 'Failed to save channel',
    onSuccess: () => onClose()
  });

  function handleSubmit() {
    const channelId = form.channel_id.trim();
    if (!channelId) {
      showNotification('Channel ID is required.', 'error');
      return;
    }
    const payload = {
      channel_id: channelId,
      channel_name: form.channel_name.trim() || null,
      telegram_targets: parseCommaSep(form.telegram_targets),
      prompt_key: form.prompt_key || null,
      min_duration_seconds: form.min_dur_min ? parseInt(form.min_dur_min, 10) * 60 : null,
      max_duration_seconds: form.max_dur_min ? parseInt(form.max_dur_min, 10) * 60 : null,
      min_view_count: parseInt(form.min_view_count, 10) || 0,
      language: form.language || null,
      upload_type: form.upload_type || null,
      title_must_include: parseCommaSep(form.must_include),
      title_must_exclude: parseCommaSep(form.must_exclude)
    };
    save.mutate(payload);
  }

  return (
    <div className="dialog-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog-box yt-keyword-modal">
        <div className="dialog-title">{isEdit ? 'Edit' : 'Add'} YouTube Channel</div>
        <div className="yt-kw-form">
          <div className="yt-kw-form-field">
            <label className="input-label">Channel ID or URL *</label>
            <input
              type="text"
              className="input"
              value={form.channel_id}
              onChange={(e) => setF('channel_id', e.target.value)}
              placeholder="UCxxxx or youtube.com/channel/UCxxxx"
              readOnly={isEdit}
              style={isEdit ? { opacity: 0.6 } : undefined}
            />
          </div>
          <div className="yt-kw-form-row">
            <div className="yt-kw-form-field">
              <label className="input-label">Display Name</label>
              <input
                type="text"
                className="input"
                value={form.channel_name}
                onChange={(e) => setF('channel_name', e.target.value)}
                placeholder="Channel name"
              />
            </div>
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
                <option value="">Any</option>
                <option value="video">Video</option>
                <option value="live">Live</option>
                <option value="completed">Completed</option>
              </select>
            </div>
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
              Prompt <span className="text-muted">(leave empty to use the default — first prompt in the YouTube tab)</span>
            </label>
            <select
              className="select"
              value={form.prompt_key}
              onChange={(e) => setF('prompt_key', e.target.value)}
            >
              <option value="">(Default)</option>
              {ytPromptKeys.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            {ytPromptKeys.length === 0 && (
              <small className="text-muted" style={{ display: 'block', marginTop: 4 }}>
                No YouTube prompts defined yet — add one on the Prompts page.
              </small>
            )}
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
