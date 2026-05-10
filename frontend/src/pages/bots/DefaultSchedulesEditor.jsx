/**
 * DefaultSchedulesEditor — bot-level default schedules. These are templates
 * auto-applied to every newly-created topic. Stored on `bot.default_schedules`
 * and persisted via /api/bot/save (the entire bot payload).
 *
 * Mirrors legacy `openDefaultScheduleModal` / `editDefaultSchedule` /
 * `removeDefaultSchedule` / `saveDefaultSchedule` / `saveEditedDefaultSchedule`
 * from `static/js/pages/bots-schedules.js`.
 *
 * Backend:  POST /api/bot/save
 */

import { useState } from 'react';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useGlobalConfig } from '../../config/ConfigProvider';
import {
  buildFullBotSavePayload,
  buildScheduleFromForm,
  emptyScheduleForm,
  scheduleFormFromExisting,
  scheduleIcon,
  scheduleSpec
} from './shared';
import {
  TypeSelect,
  TypeSpecificFields,
  HeaderDatetimeFields,
  TelegramTargetsField,
  PromptSelect
} from './ScheduleFormFields';

export default function DefaultSchedulesEditor({ botName, bot }) {
  const list = bot.default_schedules || [];
  const [editingIdx, setEditingIdx] = useState(null); // null = closed, -1 = adding new, >=0 = editing

  const save = useApiMutation('/api/bot/save', {
    invalidate: ['config'],
    successMsg: 'Default schedules updated',
    errorMsg: 'Failed to update default schedules'
  });

  const confirmRemove = useConfirmedMutation(save, {
    message: 'Remove this default schedule?',
    title: 'Remove Default Schedule',
    confirmLabel: 'Remove',
    confirmClass: 'btn-danger'
  });

  function persist(nextList) {
    save.mutate(
      buildFullBotSavePayload(botName, bot, { default_schedules: nextList })
    );
  }

  function onSaveModal(formObj) {
    // For default schedules, end_hour blank → null (matches legacy
    // saveEditedDefaultSchedule which always wrote end_hour as null when
    // blank). Add mode actually omits the field, but persisting end_hour:null
    // is safe; the bot.py reader only acts when both are non-null.
    const built = buildScheduleFromForm(formObj, { endHourBlankIsNull: true });
    // Default schedules don't carry bullet_points in legacy code; we keep
    // the field but it's harmless if always false.
    const next = [...list];
    if (editingIdx === -1) next.push(built);
    else next[editingIdx] = built;
    persist(next);
    setEditingIdx(null);
  }

  function onRemove(idx) {
    confirmRemove(
      buildFullBotSavePayload(botName, bot, {
        default_schedules: list.filter((_, i) => i !== idx)
      })
    );
  }

  return (
    <div className="form-group">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6
        }}
      >
        <label className="form-label" style={{ margin: 0 }}>
          Default Schedules for New Topics
        </label>
        <button
          className="btn btn-secondary btn-sm"
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={() => setEditingIdx(-1)}
        >
          + Add
        </button>
      </div>
      <small className="text-muted d-block mb-2">
        These schedules are automatically created when a new topic is added. Use{' '}
        <code>{'{topic_name}'}</code> in name/header.
      </small>
      <div id={`default-schedules-${botName}`}>
        {list.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 12 }}>
            No default schedules configured.
          </p>
        ) : (
          list.map((ds, idx) => (
            <DefaultScheduleRow
              key={idx}
              ds={ds}
              onEdit={() => setEditingIdx(idx)}
              onRemove={() => onRemove(idx)}
              disabled={save.isPending}
            />
          ))
        )}
      </div>

      {editingIdx !== null && (
        <DefaultScheduleModal
          botName={botName}
          isAdd={editingIdx === -1}
          existing={editingIdx >= 0 ? list[editingIdx] : null}
          onClose={() => setEditingIdx(null)}
          onSave={onSaveModal}
        />
      )}
    </div>
  );
}

function DefaultScheduleRow({ ds, onEdit, onRemove, disabled }) {
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          minWidth: 0
        }}
      >
        <span style={{ fontSize: 14 }}>{scheduleIcon(ds)}</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-primary)'
          }}
        >
          {ds.name || ds.type}
        </span>
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
          {ds.prompt_key || ''}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {scheduleSpec(ds)}
        </span>
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
        <button
          className="btn-icon"
          style={{ fontSize: 12 }}
          onClick={onEdit}
          title="Edit"
        >
          ✏️
        </button>
        <button
          className="btn-icon btn-danger"
          style={{ fontSize: 12 }}
          onClick={onRemove}
          title="Remove"
          disabled={disabled}
        >
          🗑️
        </button>
      </div>
    </div>
  );
}

// ─── Default Schedule Modal (Add or Edit) ───────────────────────────────────

function DefaultScheduleModal({ botName, isAdd, existing, onClose, onSave }) {
  const { prompts } = useGlobalConfig();
  const botPrompts = (prompts && prompts[botName]) || {};
  const { showAlert } = useDialogs();

  const [form, setForm] = useState(() => {
    if (existing) return scheduleFormFromExisting(existing);
    // Default-schedule defaults: name = '{topic_name}', header = '*{topic_name}*'
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
      id="default-schedule-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>{isAdd ? 'Add' : 'Edit'} Default Schedule</h3>
          <button className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <small className="text-muted d-block mb-2">
            This schedule template will be auto-created on every new topic. Use{' '}
            <code>{'{topic_name}'}</code> in name/header to insert the topic name.
          </small>
          <div className="form-group">
            <label className="form-label">Schedule Name</label>
            <input
              type="text"
              className="input"
              placeholder="{topic_name}"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
            />
          </div>

          <TypeSelect
            value={form.type}
            onChange={(v) => setForm((f) => ({ ...f, type: v }))}
          />

          <TypeSpecificFields form={form} setForm={setForm} />

          <PromptSelect form={form} setForm={setForm} botPrompts={botPrompts} />

          <div className="form-group">
            <label className="form-label">Header</label>
            <input
              type="text"
              className="input"
              placeholder="*{topic_name}*"
              value={form.header}
              onChange={(e) =>
                setForm((f) => ({ ...f, header: e.target.value }))
              }
            />
          </div>

          <HeaderDatetimeFields form={form} setForm={setForm} />
          <TelegramTargetsField form={form} setForm={setForm} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {isAdd ? 'Add' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
