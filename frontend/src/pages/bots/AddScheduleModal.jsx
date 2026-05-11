/**
 * Add Schedule modal — for adding a new schedule under a topic. Includes the
 * "Load from default schedule" picker (CLAUDE.md feature) when the bot has
 * any default schedules configured.
 *
 * Backend:  POST /api/topic/schedule/add
 */

import { useState } from 'react';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useGlobalConfig } from '../../config/ConfigProvider';
import {
  applyDefaultToForm,
  buildScheduleFromForm,
  emptyScheduleForm
} from './shared';
import {
  TypeSelect,
  TypeSpecificFields,
  HeaderDatetimeFields,
  BulletPointsFields,
  TelegramTargetsField,
  PromptSelect
} from './ScheduleFormFields';

export default function AddScheduleModal({
  botName,
  catName,
  topicName,
  onClose
}) {
  const { config, prompts } = useGlobalConfig();
  const bot = config?.bots?.[botName];
  // Prompts are global; the summaries-tab prompts apply to every bot.
  const botPrompts = (prompts && prompts.summaries) || {};
  const defaultSchedules = bot?.default_schedules || [];

  const [form, setForm] = useState(() => emptyScheduleForm('hourly'));
  const [pickedDefaultIdx, setPickedDefaultIdx] = useState('');
  const { showAlert } = useDialogs();

  const add = useApiMutation('/api/topic/schedule/add', {
    invalidate: ['config'],
    successMsg: 'Schedule added',
    errorMsg: 'Failed to add schedule',
    onSuccess: onClose
  });

  function applyPickedDefault() {
    if (pickedDefaultIdx === '') return;
    const ds = defaultSchedules[Number(pickedDefaultIdx)];
    if (!ds) return;
    setForm(applyDefaultToForm(ds));
  }

  function onSubmit() {
    if (!(form.name || '').trim()) {
      showAlert('Please enter a schedule name', { icon: '✏️' });
      return;
    }
    const schedule = buildScheduleFromForm(form, { endHourBlankIsNull: false });
    add.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      schedule
    });
  }

  return (
    <div
      className="modal-overlay"
      id="topic-schedule-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Add Schedule to {topicName}</h3>
          <button className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {defaultSchedules.length > 0 && (
            <div
              className="form-group"
              style={{
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px'
              }}
            >
              <label className="form-label" style={{ marginBottom: 6 }}>
                Load from default schedule
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  className="select"
                  style={{ flex: 1 }}
                  value={pickedDefaultIdx}
                  onChange={(e) => setPickedDefaultIdx(e.target.value)}
                >
                  <option value="">— pick a default —</option>
                  {defaultSchedules.map((ds, i) => (
                    <option key={i} value={i}>
                      {ds.name || ds.type}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={applyPickedDefault}
                >
                  Apply
                </button>
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Schedule Name</label>
            <input
              type="text"
              className="input"
              placeholder="e.g., Hourly Updates"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              autoFocus
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
              placeholder="**Schedule Name**"
              value={form.header}
              onChange={(e) =>
                setForm((f) => ({ ...f, header: e.target.value }))
              }
            />
            <small className="text-muted">
              Leave empty to use *schedule name* as header. Clear completely to send without header.
            </small>
          </div>

          <HeaderDatetimeFields form={form} setForm={setForm} />
          <BulletPointsFields form={form} setForm={setForm} />
          <TelegramTargetsField form={form} setForm={setForm} />
        </div>
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={add.isPending}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={add.isPending}
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
