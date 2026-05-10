/**
 * CatchAllToggle — when ON, the topic matches every incoming message
 * regardless of keywords. Lives at the top of every topic body. Mirrors
 * the legacy `setTopicCatchAll` POST.
 *
 * Backend:  POST /api/topic/catch_all
 */

import { useApiMutation } from '../../lib/useApiMutation';

export default function CatchAllToggle({
  botName,
  catName,
  topicName,
  topic
}) {
  const catchAll = !!topic.catch_all;

  const update = useApiMutation('/api/topic/catch_all', {
    invalidate: ['config'],
    successMsg: (res, vars) =>
      vars.catch_all ? 'Catch All enabled' : 'Catch All disabled',
    errorMsg: 'Failed to update Catch All'
  });

  function onToggle(enabled) {
    update.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      catch_all: enabled
    });
  }

  return (
    <div
      className="form-group"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        background: 'var(--bg-secondary,#1e1e2e)',
        borderRadius: 6,
        marginBottom: 8
      }}
    >
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={catchAll}
          disabled={update.isPending}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="toggle-slider"></span>
      </label>
      <div>
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          🌐 Catch All Messages
        </span>
        <small
          className="text-muted d-block"
          style={{ fontSize: 11 }}
        >
          Matches every incoming message — no keywords required
        </small>
      </div>
    </div>
  );
}
