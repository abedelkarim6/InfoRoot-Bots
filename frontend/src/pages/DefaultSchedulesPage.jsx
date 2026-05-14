/**
 * Default Schedules — global list shared across every summaries bot.
 *
 * Replaces the legacy per-bot `bots.default_schedules` editor. Each entry is
 * a schedule template; when a new topic is created the bot applies the
 * matching templates from this global list.
 *
 * Endpoints: /api/default-schedules (GET / add / update / delete)
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApiMutation, useConfirmedMutation } from '../lib/useApiMutation';
import { useDialogs } from '../dialogs/DialogsProvider';
import { useGlobalConfig } from '../config/ConfigProvider';
import PageHeader from '../components/PageHeader';
import {
  buildScheduleFromForm,
  emptyScheduleForm,
  scheduleFormFromExisting,
  scheduleIcon,
  scheduleSpec
} from './bots/shared';
import {
  TypeSelect,
  TypeSpecificFields,
  HeaderDatetimeFields,
  TelegramTargetsField,
  PromptSelect
} from './bots/ScheduleFormFields';

export default function DefaultSchedulesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['default-schedules'],
    queryFn: () => api('/api/default-schedules')
  });
  const list = data?.status === 'ok' ? data.schedules || [] : [];
  const [editing, setEditing] = useState(null); // null | 'add' | { ...row }

  const add = useApiMutation('/api/default-schedules/add', {
    invalidate: ['default-schedules'],
    successMsg: 'Default schedule added',
    errorMsg: 'Failed to add default schedule',
    onSuccess: () => setEditing(null)
  });
  const update = useApiMutation('/api/default-schedules/update', {
    invalidate: ['default-schedules'],
    successMsg: 'Default schedule updated',
    errorMsg: 'Failed to update default schedule',
    onSuccess: () => setEditing(null)
  });
  const remove = useApiMutation('/api/default-schedules/delete', {
    invalidate: ['default-schedules'],
    successMsg: 'Default schedule removed',
    errorMsg: 'Failed to remove default schedule'
  });

  const confirmRemove = useConfirmedMutation(remove, (vars) => ({
    message: `Remove default schedule "${vars.name || ''}"?`,
    title: 'Remove Default Schedule',
    confirmLabel: 'Remove',
    confirmClass: 'btn-danger'
  }));

  function onSave(formObj) {
    const built = buildScheduleFromForm(formObj, { endHourBlankIsNull: true });
    if (editing === 'add') {
      add.mutate(built);
    } else if (editing?.id) {
      update.mutate({ ...built, id: editing.id });
    }
  }

  return (
    <div className="page active">
      <PageHeader
        title="Default Schedules"
        subtitle="Global schedule templates auto-applied to every new topic across every bot."
      >
        <button className="btn btn-primary" onClick={() => setEditing('add')}>
          + Add Default Schedule
        </button>
      </PageHeader>

      <div className="card" style={{ padding: 12 }}>
        {isLoading ? (
          <p className="text-muted">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-muted">No default schedules configured.</p>
        ) : (
          list.map((ds) => (
            <DefaultScheduleRow
              key={ds.id}
              ds={ds}
              onEdit={() => setEditing(ds)}
              onRemove={() => confirmRemove({ id: ds.id, name: ds.name })}
            />
          ))
        )}
      </div>

      {editing && (
        <DefaultScheduleModal
          isAdd={editing === 'add'}
          existing={editing === 'add' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={onSave}
          saving={add.isPending || update.isPending}
        />
      )}
    </div>
  );
}

function DefaultScheduleRow({ ds, onEdit, onRemove }) {
  const tgCount = (ds.telegram_targets || []).length;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 6,
        padding: '10px 14px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 14 }}>{scheduleIcon(ds)}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          {ds.name || ds.type}
        </span>
        {ds.prompt_key && (
          <span
            style={{
              fontSize: 10,
              padding: '1px 7px',
              borderRadius: 20,
              background: 'rgba(59,130,246,0.12)',
              color: '#93c5fd',
              fontWeight: 600
            }}
          >
            {ds.prompt_key}
          </span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{scheduleSpec(ds)}</span>
        {tgCount > 0 && (
          <span
            style={{
              fontSize: 10,
              padding: '1px 7px',
              borderRadius: 20,
              background: 'rgba(139,92,246,0.15)',
              color: '#a78bfa'
            }}
          >
            📡 {tgCount}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button className="btn-icon" style={{ fontSize: 13 }} onClick={onEdit} title="Edit">
          ✏️
        </button>
        <button
          className="btn-icon btn-danger"
          style={{ fontSize: 13 }}
          onClick={onRemove}
          title="Remove"
        >
          🗑️
        </button>
      </div>
    </div>
  );
}

function DefaultScheduleModal({ isAdd, existing, onClose, onSave, saving }) {
  const { prompts } = useGlobalConfig();
  const botPrompts = (prompts && prompts.summaries) || {};
  const { showAlert } = useDialogs();

  const [form, setForm] = useState(() => {
    if (existing) return scheduleFormFromExisting(existing);
    return {
      ...emptyScheduleForm('daily'),
      name: '{topic_name}',
      header: '*{topic_name}*'
    };
  });

  function submit() {
    if (!(form.name || '').trim()) {
      showAlert('Please enter a schedule name', { icon: '✏️' });
      return;
    }
    onSave(form);
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>{isAdd ? 'Add' : 'Edit'} Default Schedule</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <small className="text-muted d-block mb-2">
            This schedule template will be auto-created on every new topic across all bots. Use{' '}
            <code>{'{topic_name}'}</code> in name/header to insert the topic name.
          </small>
          <div className="form-group">
            <label className="form-label">Schedule Name</label>
            <input
              type="text"
              className="input"
              placeholder="{topic_name}"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <TypeSelect value={form.type} onChange={(v) => setForm((f) => ({ ...f, type: v }))} />
          <TypeSpecificFields form={form} setForm={setForm} />
          <PromptSelect form={form} setForm={setForm} botPrompts={botPrompts} />

          <div className="form-group">
            <label className="form-label">Header</label>
            <input
              type="text"
              className="input"
              placeholder="*{topic_name}*"
              value={form.header}
              onChange={(e) => setForm((f) => ({ ...f, header: e.target.value }))}
            />
          </div>

          <HeaderDatetimeFields form={form} setForm={setForm} />
          <TelegramTargetsField form={form} setForm={setForm} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : isAdd ? 'Add' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
