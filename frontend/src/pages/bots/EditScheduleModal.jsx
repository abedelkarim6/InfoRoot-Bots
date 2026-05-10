/**
 * Edit Schedule modal — for editing an existing schedule under a topic.
 *
 * Backend:  POST /api/topic/schedule/update   (with full schedule body)
 */

import { useState } from 'react';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useGlobalConfig } from '../../config/ConfigProvider';
import { buildScheduleFromForm, scheduleFormFromExisting } from './shared';
import {
  TypeSelect,
  TypeSpecificFields,
  HeaderDatetimeFields,
  BulletPointsFields,
  TelegramTargetsField,
  PromptSelect
} from './ScheduleFormFields';

export default function EditScheduleModal({
  botName,
  catName,
  topicName,
  schedule,
  onClose
}) {
  const { prompts } = useGlobalConfig();
  const botPrompts = (prompts && prompts[botName]) || {};
  const [form, setForm] = useState(() => scheduleFormFromExisting(schedule));
  const { showAlert } = useDialogs();

  const update = useApiMutation('/api/topic/schedule/update', {
    invalidate: ['config'],
    successMsg: 'Schedule updated',
    errorMsg: 'Failed to update schedule',
    onSuccess: onClose
  });

  function onSubmit() {
    if (!(form.name || '').trim()) {
      showAlert('Please enter a schedule name', { icon: '✏️' });
      return;
    }
    const built = buildScheduleFromForm(form, { endHourBlankIsNull: true });
    update.mutate({
      schedule_id: schedule.id,
      schedule: built
    });
  }

  return (
    <div
      className="modal-overlay"
      id="topic-schedule-edit-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Edit Schedule — {schedule.name}</h3>
          <button className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Schedule Name</label>
            <input
              type="text"
              className="input"
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
              value={form.header}
              onChange={(e) =>
                setForm((f) => ({ ...f, header: e.target.value }))
              }
            />
            <small className="text-muted">
              Leave empty to send without header.
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
            disabled={update.isPending}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={update.isPending}
          >
            {update.isPending ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
