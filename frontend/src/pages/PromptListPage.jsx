/**
 * PromptListPage — shared component for the per-type prompts list page
 * (Summaries Prompts and YouTube Prompts). It hits the same `/api/prompts/*`
 * endpoints but filters/scopes everything to one prompt type.
 *
 * Used by:
 *   - SummariesPromptsPage  (type='summaries')
 *   - YoutubePromptsPage    (type='youtube')
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApiMutation, useConfirmedMutation } from '../lib/useApiMutation';
import { useDialogs } from '../dialogs/DialogsProvider';
import PageHeader from '../components/PageHeader';

export default function PromptListPage({ kind, title, subtitle }) {
  const { data: allPrompts } = useQuery({
    queryKey: ['prompts'],
    queryFn: () => api('/api/prompts')
  });
  const prompts = (allPrompts && allPrompts[kind]) || {};
  const keys = Object.keys(prompts);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="page active">
      <PageHeader title={title} subtitle={subtitle}>
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
          + Add Prompt
        </button>
      </PageHeader>

      <div className="card" style={{ padding: 12 }}>
        {keys.length === 0 ? (
          <p className="text-muted">
            No {kind} prompts yet. Click "Add Prompt" to create one.
          </p>
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
      </div>

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

  useEffect(() => { setText(initialText); }, [initialText]);

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
