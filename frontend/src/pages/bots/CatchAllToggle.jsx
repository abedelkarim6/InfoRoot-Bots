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
    <div className="catchall-inline">
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={catchAll}
          disabled={update.isPending}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="toggle-slider"></span>
      </label>
      <div className="catchall-text">
        <span className="catchall-title">Catch All Messages</span>
        <small className="catchall-sub">
          Matches every incoming message no keywords required
        </small>
      </div>
    </div>
  );
}
