/**
 * Bots — Prompts tab.
 *
 * Mirrors the legacy `createPromptsSection` + helpers from
 * `static/js/pages/bots-detail.js`. Includes:
 *   - Admin-only "fixed" prompts: System Prompt, Fixed Prefix, Bullet Points
 *     Suffix. Each is independently saved/reset against /api/system/fixed-prefix.
 *   - Per-bot custom prompt list — add / edit / rename / delete.
 *   - Delete cascades through /api/prompts/delete which 409s if the prompt is
 *     bound to a schedule; the surfaced message is shown in an alert.
 *   - Rename uses the legacy 3-step dance: create new key, delete old, cascade
 *     to schedules referencing the old key.
 *
 * Backend endpoints used:
 *   GET  /api/system/fixed-prefix           (admin only)
 *   POST /api/system/fixed-prefix/save      (admin only)
 *   POST /api/prompts/update                (per-bot prompt save / create)
 *   POST /api/prompts/delete                (per-bot prompt delete)
 *   POST /api/prompts/rename-cascade        (rename a prompt key)
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useGlobalConfig } from '../../config/ConfigProvider';
import { useAuth } from '../../auth/AuthContext';

export default function Prompts({ botName }) {
  const { prompts: globalPrompts } = useGlobalConfig();
  const botPrompts = (globalPrompts && globalPrompts[botName]) || {};
  const { user } = useAuth();
  const isAdmin = !user || user.role === 'admin';

  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const promptCount = Object.keys(botPrompts).length;

  return (
    <div className={`collapsible-section ${open ? 'open' : ''}`} id={`prompts-${botName}`}>
      <div className="collapsible-header" onClick={() => setOpen((v) => !v)}>
        <div className="collapsible-title">
          <span className="icon">📝</span>
          <span>Custom Prompts ({promptCount})</span>
        </div>
        <span className="collapsible-toggle">▼</span>
      </div>
      <div className="collapsible-content">
        <div className="collapsible-body">
          <p className="text-muted mb-2">Manage prompts for this bot</p>

          {isAdmin && <FixedPromptsAdmin botName={botName} />}

          {Object.entries(botPrompts).map(([key, value]) => (
            <PromptCard key={key} botName={botName} promptKey={key} value={value} />
          ))}

          <button className="btn btn-secondary btn-sm mt-2" onClick={() => setAddOpen(true)}>
            + Add Prompt
          </button>
        </div>
      </div>

      {addOpen && (
        <AddPromptModal
          botName={botName}
          existingKeys={Object.keys(botPrompts)}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Fixed Prompts (admin only) ─────────────────────────────────────────────

function FixedPromptsAdmin({ botName }) {
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'fixed-prefix'],
    queryFn: () => api('/api/system/fixed-prefix')
  });

  if (isLoading || !data || data.status === 'error') {
    return null;
  }

  return (
    <>
      <FixedPromptCard
        botName={botName}
        idSuffix="sysprompt"
        title="System Prompt"
        field="system_prompt"
        rows={2}
        initial={data.system_prompt ?? data.default_system_prompt ?? ''}
        defaultValue={data.default_system_prompt ?? ''}
      />
      <FixedPromptCard
        botName={botName}
        idSuffix="prefix"
        title="Fixed Prefix"
        field="fixed_prefix"
        rows={5}
        helper="Injected before every user prompt. Supports: {topic_name}, {messages}, {final_interim}, {b}."
        monospace
        initial={data.fixed_prefix ?? data.default_fixed_prefix ?? ''}
        defaultValue={data.default_fixed_prefix ?? ''}
      />
      <FixedPromptCard
        botName={botName}
        idSuffix="bp-suffix"
        title="Bullet Points Suffix"
        field="bullet_points_suffix"
        rows={3}
        helper="Appended after the user prompt when a schedule has Bullet Points enabled. Use {b} for the count."
        monospace
        initial={data.bullet_points_suffix ?? data.default_bullet_points_suffix ?? ''}
        defaultValue={data.default_bullet_points_suffix ?? ''}
      />
    </>
  );
}

function FixedPromptCard({
  botName,
  idSuffix,
  title,
  field,
  rows = 3,
  helper,
  monospace,
  initial,
  defaultValue
}) {
  const [text, setText] = useState(initial || '');
  const { showAlert } = useDialogs();

  // Reset local draft when the underlying value (re)loads.
  useEffect(() => {
    setText(initial || '');
  }, [initial]);

  const save = useApiMutation('/api/system/fixed-prefix/save', {
    invalidate: [['system', 'fixed-prefix']],
    onSuccess: () => showAlert('Saved successfully.'),
    onError: () => showAlert('Failed to save.')
  });

  return (
    <div className="prompt-card prompt-card-fixed" id={`fixed-${idSuffix}-card-${botName}`}>
      <div className="prompt-card-header">
        <h4 className="prompt-card-title">
          🔒 {title} <span className="admin-badge">Admin</span>
        </h4>
        <div className="prompt-card-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setText(defaultValue || '')}
            title="Reset to default"
          >
            Reset
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => save.mutate({ [field]: text })}
            disabled={save.isPending}
          >
            Save
          </button>
        </div>
      </div>
      {helper && (
        <p className="text-muted" style={{ margin: '0 0 4px', fontSize: 11 }}>
          {helper}
        </p>
      )}
      <textarea
        className="textarea"
        id={`fixed-${idSuffix}-${botName}`}
        rows={rows}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={monospace ? { fontFamily: 'monospace', fontSize: 12 } : undefined}
      />
    </div>
  );
}

// ─── Per-bot prompt card ────────────────────────────────────────────────────

function PromptCard({ botName, promptKey, value }) {
  const initialText = value && typeof value === 'object' ? value.text || '' : value || '';
  const [text, setText] = useState(initialText);
  const { showAlert, showPrompt } = useDialogs();
  const { prompts: globalPrompts } = useGlobalConfig();
  const qc = useQueryClient();

  // Resync the editor when the upstream value changes.
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
      // Backend returns a structured "blocked" error when a schedule still
      // references the prompt. Surface that as an alert.
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
    update.mutate({ bot_name: botName, key: promptKey, text });
  }

  async function onRename() {
    showPrompt('Rename Prompt', promptKey, async (newName) => {
      const trimmed = (newName || '').trim();
      if (!trimmed || trimmed === promptKey) return;

      const allBotPrompts = (globalPrompts && globalPrompts[botName]) || {};
      if (allBotPrompts[trimmed]) {
        showAlert(`Prompt "${trimmed}" already exists`, { icon: '⚠️' });
        return;
      }

      const oldVal = allBotPrompts[promptKey];
      const oldText =
        oldVal && typeof oldVal === 'object' ? oldVal.text || '' : oldVal || '';

      // 3-step rename: create new, REWIRE schedules to the new key, then delete old.
      // Order matters: deleting the old key first is rejected by the backend whenever
      // a schedule still references it — the cascade has to happen first.
      const add = await api('/api/prompts/update', {
        bot_name: botName,
        key: trimmed,
        text: oldText
      });
      if (add?.status !== 'ok') {
        showAlert(add?.message || 'Failed to rename', { icon: '⚠️' });
        return;
      }
      await api('/api/prompts/rename-cascade', {
        bot_name: botName,
        old_key: promptKey,
        new_key: trimmed
      });
      const del = await api('/api/prompts/delete', { bot_name: botName, key: promptKey });
      if (del?.status !== 'ok') {
        showAlert(del?.message || 'Renamed, but old prompt could not be deleted.', {
          icon: '⚠️'
        });
      }
      qc.invalidateQueries({ queryKey: ['prompts'] });
      qc.invalidateQueries({ queryKey: ['config'] });
    });
  }

  return (
    <div className="prompt-card">
      <div className="prompt-card-header">
        <h4 className="prompt-card-title">{promptKey}</h4>
        <div className="prompt-card-actions">
          <button className="btn-icon" onClick={onRename} title="Rename">
            ✏️
          </button>
          <button
            className="btn-icon btn-danger"
            onClick={() => confirmDelete({ bot_name: botName, key: promptKey })}
            title="Delete"
            disabled={remove.isPending}
          >
            🗑️
          </button>
        </div>
      </div>
      <textarea
        className="textarea"
        id={`prompt-${botName}-${promptKey}`}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={onCommit}
        placeholder="Enter prompt text..."
        disabled={update.isPending}
      />
    </div>
  );
}

// ─── Add Prompt Modal ───────────────────────────────────────────────────────

function AddPromptModal({ botName, existingKeys, onClose }) {
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
        () => save.mutate({ bot_name: botName, key: trimmed, text }),
        {
          title: 'Overwrite Prompt',
          confirmLabel: 'Overwrite',
          confirmClass: 'btn-primary'
        }
      );
      return;
    }
    save.mutate({ bot_name: botName, key: trimmed, text });
  }

  return (
    <div
      className="modal-overlay"
      id="add-prompt-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Add Custom Prompt</h3>
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
              placeholder="e.g., brief_update, detailed_summary"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">Prompt Text</label>
            <textarea
              className="textarea"
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Enter the prompt text..."
            />
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={save.isPending}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={save.isPending}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
