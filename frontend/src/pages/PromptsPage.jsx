/**
 * Prompts — unified, global prompts page.
 *
 * Two tabs: Summaries / YouTube. Each shows the list of prompts (key + text)
 * with add / edit / rename / delete. Prompts are global across all bots — when
 * a summary schedule (or a YouTube channel/keyword) references a prompt by
 * key, it picks the entry stored here.
 *
 * Admin-only "fixed" prompts (system prompt, fixed prefix, bullet points
 * suffix) live on the Summaries tab; YouTube fixed-prefix editors live on the
 * YouTube tab.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApiMutation, useConfirmedMutation } from '../lib/useApiMutation';
import { useDialogs } from '../dialogs/DialogsProvider';
import { useAuth } from '../auth/AuthContext';
import PageHeader from '../components/PageHeader';

const TABS = [
  { id: 'summaries', label: '📝 Summaries' },
  { id: 'youtube',   label: '🎬 YouTube'   }
];

export default function PromptsPage() {
  const [tab, setTab] = useState('summaries');
  const { user } = useAuth();
  const isAdmin = !user || user.role === 'admin';

  return (
    <div className="page active" id="prompts-page">
      <PageHeader
        title="Prompts"
        subtitle="Global prompt library — shared across all bots (summaries) and channels/keywords (YouTube)"
      />

      <div className="bot-config-card">
        <div className="bot-tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`bot-tab-btn ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="bot-config-body">
          {tab === 'summaries' && <PromptsTab kind="summaries" isAdmin={isAdmin} />}
          {tab === 'youtube'   && <PromptsTab kind="youtube"   isAdmin={isAdmin} />}
        </div>
      </div>
    </div>
  );
}

// ─── Per-tab body ──────────────────────────────────────────────────────────

function PromptsTab({ kind, isAdmin }) {
  const { data: allPrompts } = useQuery({
    queryKey: ['prompts'],
    queryFn: () => api('/api/prompts')
  });
  const prompts = (allPrompts && allPrompts[kind]) || {};
  const keys = Object.keys(prompts);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div style={{ padding: 12 }}>
      <p className="text-muted" style={{ marginTop: 0 }}>
        {kind === 'summaries'
          ? 'Used by all summary schedules. Pick a prompt per schedule on the Bot detail page.'
          : 'Used by YouTube channels & keyword trackers. Pick one per channel/keyword on those pages. The first prompt is the default.'}
      </p>

      {isAdmin && kind === 'summaries' && <SummariesFixedAdmin />}
      {isAdmin && kind === 'youtube'   && <YoutubeFixedAdmin />}

      {keys.length === 0 ? (
        <p className="text-muted">No {kind} prompts yet. Click "Add Prompt" to create one.</p>
      ) : (
        keys.map((k) => (
          <PromptCard
            key={k}
            kind={kind}
            promptKey={k}
            value={prompts[k]}
            isFirst={k === keys[0]}
          />
        ))
      )}

      <button className="btn btn-secondary btn-sm mt-2" onClick={() => setAddOpen(true)}>
        + Add Prompt
      </button>

      {addOpen && (
        <AddPromptModal
          kind={kind}
          existingKeys={keys}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Single prompt card (rename / edit / delete) ───────────────────────────

function PromptCard({ kind, promptKey, value, isFirst }) {
  const initialText = value && typeof value === 'object' ? value.text || '' : value || '';
  const [text, setText] = useState(initialText);
  const { showAlert, showPrompt } = useDialogs();
  const qc = useQueryClient();

  useEffect(() => {
    setText(initialText);
  }, [initialText]);

  const update = useApiMutation('/api/prompts/update', {
    invalidate: ['prompts'],
    successMsg: 'Prompt updated',
    errorMsg: 'Failed to update prompt'
  });

  const remove = useApiMutation('/api/prompts/delete', {
    invalidate: ['prompts'],
    successMsg: 'Prompt deleted',
    errorMsg: 'Failed to delete prompt',
    onError: (res) => {
      if (res?.message) showAlert(res.message, { title: 'Cannot Delete', icon: '⛔' });
    }
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete prompt "${promptKey}"?`,
    title: 'Delete Prompt',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function onCommit() {
    if (text === initialText) return;
    update.mutate({ key: promptKey, text, type: kind });
  }

  async function onRename() {
    showPrompt('Rename Prompt', promptKey, async (newName) => {
      const trimmed = (newName || '').trim();
      if (!trimmed || trimmed === promptKey) return;

      const all = qc.getQueryData(['prompts']);
      const existing = (all && all[kind]) || {};
      if (existing[trimmed]) {
        showAlert(`Prompt "${trimmed}" already exists`, { icon: '⚠️' });
        return;
      }

      // 3-step rename: create new, rewire references, delete old.
      const add = await api('/api/prompts/update', { key: trimmed, text, type: kind });
      if (add?.status !== 'ok') {
        showAlert(add?.message || 'Failed to rename', { icon: '⚠️' });
        return;
      }
      await api('/api/prompts/rename-cascade', {
        old_key: promptKey,
        new_key: trimmed,
        type: kind
      });
      const del = await api('/api/prompts/delete', { key: promptKey, type: kind });
      if (del?.status !== 'ok') {
        showAlert(del?.message || 'Renamed, but old prompt could not be deleted.', { icon: '⚠️' });
      }
      qc.invalidateQueries({ queryKey: ['prompts'] });
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['yt-channels'] });
    });
  }

  return (
    <div className="prompt-card">
      <div className="prompt-card-header">
        <h4 className="prompt-card-title">
          {promptKey}
          {kind === 'youtube' && isFirst && (
            <span className="admin-badge" style={{ marginLeft: 8 }}>default</span>
          )}
        </h4>
        <div className="prompt-card-actions">
          <button className="btn-icon" onClick={onRename} title="Rename">✏️</button>
          <button
            className="btn-icon btn-danger"
            onClick={() => confirmDelete({ key: promptKey, type: kind })}
            title="Delete"
            disabled={remove.isPending}
          >🗑️</button>
        </div>
      </div>
      <textarea
        className="textarea"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={onCommit}
        placeholder="Enter prompt text…"
        disabled={update.isPending}
      />
    </div>
  );
}

// ─── Add Prompt Modal ──────────────────────────────────────────────────────

function AddPromptModal({ kind, existingKeys, onClose }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const { showAlert, showConfirm } = useDialogs();

  const save = useApiMutation('/api/prompts/update', {
    invalidate: ['prompts'],
    successMsg: 'Prompt added',
    errorMsg: 'Failed to add prompt',
    onSuccess: onClose
  });

  function onSubmit() {
    const trimmed = name.trim();
    if (!trimmed) {
      showAlert('Please enter a prompt name', { icon: '✏️' });
      return;
    }
    if (existingKeys.includes(trimmed)) {
      showConfirm(
        `Prompt "${trimmed}" already exists. Overwrite?`,
        () => save.mutate({ key: trimmed, text, type: kind }),
        { title: 'Overwrite Prompt', confirmLabel: 'Overwrite', confirmClass: 'btn-primary' }
      );
      return;
    }
    save.mutate({ key: trimmed, text, type: kind });
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Add {kind === 'youtube' ? 'YouTube' : 'Summaries'} Prompt</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Prompt Name</label>
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'youtube' ? 'e.g., interview, tech_review' : 'e.g., brief_update'}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">Prompt Text</label>
            <textarea
              className="textarea"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Enter the prompt text…"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={save.isPending}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Admin Fixed (system/prefix/suffix) for Summaries ──────────────────────

function SummariesFixedAdmin() {
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'fixed-prefix'],
    queryFn: () => api('/api/system/fixed-prefix')
  });
  if (isLoading || !data || data.status === 'error') return null;

  return (
    <>
      <FixedCard
        title="System Prompt"
        field="system_prompt"
        rows={2}
        invalidate={[['system', 'fixed-prefix']]}
        endpoint="/api/system/fixed-prefix/save"
        initial={data.system_prompt ?? data.default_system_prompt ?? ''}
        defaultValue={data.default_system_prompt ?? ''}
      />
      <FixedCard
        title="Fixed Prefix"
        field="fixed_prefix"
        rows={5}
        invalidate={[['system', 'fixed-prefix']]}
        endpoint="/api/system/fixed-prefix/save"
        helper="Injected before every user prompt. Supports: {topic_name}, {messages}, {final_interim}, {b}."
        monospace
        initial={data.fixed_prefix ?? data.default_fixed_prefix ?? ''}
        defaultValue={data.default_fixed_prefix ?? ''}
      />
      <FixedCard
        title="Bullet Points Suffix"
        field="bullet_points_suffix"
        rows={3}
        invalidate={[['system', 'fixed-prefix']]}
        endpoint="/api/system/fixed-prefix/save"
        helper="Appended after the user prompt when a schedule has Bullet Points enabled. Use {b} for the count."
        monospace
        initial={data.bullet_points_suffix ?? data.default_bullet_points_suffix ?? ''}
        defaultValue={data.default_bullet_points_suffix ?? ''}
      />
    </>
  );
}

// ─── Admin Fixed prefixes for YouTube ──────────────────────────────────────

function YoutubeFixedAdmin() {
  const { data, isLoading } = useQuery({
    queryKey: ['yt', 'fixed-prefix'],
    queryFn: () => api('/api/youtube/fixed-prefix')
  });
  if (isLoading || !data || data.status === 'error') return null;

  return (
    <>
      <FixedCard
        title="YouTube Fixed Prefix — Video (URL strategy)"
        field="prefix_video"
        rows={5}
        invalidate={[['yt', 'fixed-prefix']]}
        endpoint="/api/youtube/fixed-prefix/save"
        helper="Injected before the user prompt when Gemini analyzes the video URL directly. Supports {title}, {channel_name}, {link}, {guest}."
        monospace
        initial={data.prefix_video ?? data.default_prefix_video ?? ''}
        defaultValue={data.default_prefix_video ?? ''}
      />
      <FixedCard
        title="YouTube Fixed Prefix — Transcript strategy"
        field="prefix_transcript"
        rows={5}
        invalidate={[['yt', 'fixed-prefix']]}
        endpoint="/api/youtube/fixed-prefix/save"
        helper="Used when a transcript is available. Supports {transcript}, {title}, {channel_name}, {link}, {guest}."
        monospace
        initial={data.prefix_transcript ?? data.default_prefix_transcript ?? ''}
        defaultValue={data.default_prefix_transcript ?? ''}
      />
    </>
  );
}

function FixedCard({
  title, field, rows = 3, helper, monospace, initial, defaultValue,
  endpoint, invalidate
}) {
  const [text, setText] = useState(initial || '');
  const { showAlert } = useDialogs();

  useEffect(() => { setText(initial || ''); }, [initial]);

  const save = useApiMutation(endpoint, {
    invalidate,
    onSuccess: () => showAlert('Saved successfully.'),
    onError:   () => showAlert('Failed to save.')
  });

  return (
    <div className="prompt-card prompt-card-fixed">
      <div className="prompt-card-header">
        <h4 className="prompt-card-title">
          🔒 {title} <span className="admin-badge">Admin</span>
        </h4>
        <div className="prompt-card-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setText(defaultValue || '')}
            title="Reset to default"
          >Reset</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => save.mutate({ [field]: text })}
            disabled={save.isPending}
          >Save</button>
        </div>
      </div>
      {helper && (
        <p className="text-muted" style={{ margin: '0 0 4px', fontSize: 11 }}>{helper}</p>
      )}
      <textarea
        className="textarea"
        rows={rows}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={monospace ? { fontFamily: 'monospace', fontSize: 12 } : undefined}
      />
    </div>
  );
}
