/**
 * SchedulesSection — list of schedules for a single topic, with add / edit /
 * delete / enable-toggle controls per schedule. Mirrors the schedule list
 * inside legacy `_buildTopicBodyHtml`.
 *
 * Backend endpoints used:
 *   POST /api/topic/schedule/add      (via AddScheduleModal)
 *   POST /api/topic/schedule/update   (toggle enable + via EditScheduleModal)
 *   POST /api/topic/schedule/delete
 */

import { useState } from 'react';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { formatScheduleLong } from './shared';
import AddScheduleModal from './AddScheduleModal';
import EditScheduleModal from './EditScheduleModal';

export default function SchedulesSection({ botName, catName, topicName, topic }) {
  const schedules = topic.schedules || [];
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const toggleSch = useApiMutation('/api/topic/schedule/update', {
    invalidate: ['config'],
    successMsg: 'Schedule updated',
    errorMsg: 'Failed to update schedule'
  });

  const removeSch = useApiMutation('/api/topic/schedule/delete', {
    invalidate: ['config', 'recycle-bin'],
    successMsg: 'Schedule deleted',
    errorMsg: 'Failed to delete schedule'
  });

  const confirmDelete = useConfirmedMutation(removeSch, {
    message: 'Delete this schedule?',
    title: 'Delete Schedule',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function onToggle(sch, enabled) {
    toggleSch.mutate({
      schedule_id: sch.id,
      schedule: { enabled }
    });
  }

  return (
    <div className="topic-schedules-section">
      <div className="form-group">
        <label className="form-label">Schedules</label>
        {schedules.map((sch) => (
          <ScheduleRow
            key={sch.id}
            sch={sch}
            onToggle={(enabled) => onToggle(sch, enabled)}
            onEdit={() => setEditing(sch)}
            onDelete={() =>
              confirmDelete({
                schedule_id: sch.id,
                bot_name: botName,
                category_name: catName,
                topic_name: topicName
              })
            }
            disabled={toggleSch.isPending || removeSch.isPending}
          />
        ))}
        <button
          className="btn btn-secondary btn-sm mt-2"
          onClick={() => setAddOpen(true)}
        >
          + Add Schedule
        </button>
      </div>

      {addOpen && (
        <AddScheduleModal
          botName={botName}
          catName={catName}
          topicName={topicName}
          onClose={() => setAddOpen(false)}
        />
      )}
      {editing && (
        <EditScheduleModal
          botName={botName}
          catName={catName}
          topicName={topicName}
          schedule={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ScheduleRow({ sch, onToggle, onEdit, onDelete, disabled }) {
  return (
    <div className="summary-block">
      <div className="summary-header">
        <div className="summary-title">
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={!!sch.enabled}
              onChange={(e) => onToggle(e.target.checked)}
              disabled={disabled}
            />
            <span className="toggle-slider"></span>
          </label>
          <strong>{sch.name}</strong>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button className="btn-icon" title="Edit schedule" onClick={onEdit}>
            ✏️
          </button>
          <button
            className="btn-icon btn-danger"
            title="Delete schedule"
            onClick={onDelete}
            disabled={disabled}
          >
            🗑️
          </button>
        </div>
      </div>
      <div className="summary-details">
        <span>📅 {formatScheduleLong(sch)}</span>
        <span>
          📝 {sch.prompt_key}
          {sch.bullet_points && (
            <span
              style={{
                background: 'var(--accent-primary,#6366f1)',
                color: '#fff',
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 10,
                fontWeight: 500,
                marginLeft: 4
              }}
            >
              🔹 {sch.bullet_points_count}pt
            </span>
          )}
        </span>
        <span>
          📨 {sch.header || `*${sch.name}*`}
          {sch.header_datetime ? ' 🕐' : ''}
          {sch.header_datetime && sch.header_datetime_offset ? (
            <span
              className="text-muted"
              style={{ fontSize: 11, marginLeft: 4 }}
            >
              ({sch.header_datetime_offset > 0 ? '+' : ''}
              {sch.header_datetime_offset}min)
            </span>
          ) : null}
          {sch.telegram_targets?.length ? ` 📡 ${sch.telegram_targets.length}` : ''}
        </span>
      </div>
    </div>
  );
}
