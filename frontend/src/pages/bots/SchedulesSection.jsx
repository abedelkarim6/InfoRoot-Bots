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
import Icon from '../../components/icons';
import KebabMenu from '../../components/KebabMenu';

export default function SchedulesSection({ botName, catName, topicName, topic, inherited = false }) {
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
    <div className="topic-schedules-section tsec open">
      <div className="tsec-head" style={{ cursor: 'default' }}>
        <span className="tsec-icon"><Icon name="calendarClock" size={16} /></span>
        <span className="tsec-title">Schedules</span>
        <div className="tsec-actions">
          {!inherited && (
            <button className="btn btn-secondary btn-sm" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={13} style={{ marginRight: 5 }} />
              Schedule
            </button>
          )}
        </div>
      </div>
      <div className="tsec-body">
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
            readOnly={inherited}
          />
        ))}
        {schedules.length === 0 && (
          <span className="tsec-empty">No schedules yet{!inherited ? ' — click "+ Schedule" to add one' : ''}</span>
        )}
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

function ScheduleRow({ sch, onToggle, onEdit, onDelete, disabled, readOnly = false }) {
  return (
    <div className="sched-row">
      <span className="sched-icon-tile"><Icon name="calendarClock" size={17} /></span>
      <div className="sched-main">
        <strong className="sched-name">{sch.name}</strong>
        <div className="sched-chips">
          <span className="count-pill">{formatScheduleLong(sch)}</span>
          <span className="count-pill">{sch.prompt_key}</span>
          {sch.bullet_points && (
            <span className="count-pill">{sch.bullet_points_count} bullet points</span>
          )}
          {sch.header_datetime && (
            <span className="count-pill">
              🕐 header time
              {sch.header_datetime_offset
                ? ` (${sch.header_datetime_offset > 0 ? '+' : ''}${sch.header_datetime_offset}min)`
                : ''}
            </span>
          )}
          {sch.telegram_targets?.length > 0 && (
            <span className="count-pill">{sch.telegram_targets.length} target{sch.telegram_targets.length !== 1 ? 's' : ''}</span>
          )}
        </div>
      </div>
      {!readOnly && (
        <div className="sched-controls" onClick={(e) => e.stopPropagation()}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={!!sch.enabled}
              onChange={(e) => onToggle(e.target.checked)}
              disabled={disabled}
            />
            <span className="toggle-slider"></span>
          </label>
          <KebabMenu
            items={[
              { label: 'Edit', icon: 'pencil', onClick: onEdit },
              { label: 'Delete', icon: 'trash', danger: true, disabled, onClick: onDelete }
            ]}
          />
        </div>
      )}
    </div>
  );
}
