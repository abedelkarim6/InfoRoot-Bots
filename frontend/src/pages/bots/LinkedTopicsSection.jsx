/**
 * LinkedTopicsSection — link a topic to other topics in the same bot so it
 * inherits their SEOs. Backend stores `linked_topics` on the topic; both
 * `add` and `remove` go through the unified `/api/topic/update` endpoint
 * (per the CLAUDE.md fix that documented this).
 *
 * Backend:  POST /api/topic/update  with { linked_topics: [...] }
 */

import { useState } from 'react';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useGlobalConfig } from '../../config/ConfigProvider';

export default function LinkedTopicsSection({
  botName,
  catName,
  topicName,
  topic
}) {
  const linked = topic.linked_topics || [];
  const [linkOpen, setLinkOpen] = useState(false);

  const update = useApiMutation('/api/topic/update', {
    invalidate: ['config'],
    successMsg: 'Topic linked',
    errorMsg: 'Failed to link topic'
  });
  const unlink = useApiMutation('/api/topic/update', {
    invalidate: ['config'],
    successMsg: 'Topic unlinked',
    errorMsg: 'Failed to unlink topic'
  });

  function removeAt(idx) {
    const next = linked.filter((_, i) => i !== idx);
    unlink.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      linked_topics: next
    });
  }

  return (
    <div className="form-group">
      <label className="form-label">Linked Topics (inherit SEOs)</label>
      <div className="tags-container">
        {linked.map((lt, idx) => (
          <span className="tag" key={`${lt}-${idx}`}>
            🔗 {lt}
            <span className="tag-remove" onClick={() => removeAt(idx)}>
              ×
            </span>
          </span>
        ))}
      </div>
      <button
        className="btn btn-secondary btn-sm mt-1"
        onClick={() => setLinkOpen(true)}
      >
        + Link Existing Topic
      </button>
      <small className="text-muted d-block mt-1">
        Link to other topics to inherit their SEOs
      </small>

      {linkOpen && (
        <LinkTopicModal
          botName={botName}
          catName={catName}
          topicName={topicName}
          existing={linked}
          onSubmit={(linkedName) => {
            update.mutate({
              bot_name: botName,
              category_name: catName,
              topic_name: topicName,
              linked_topics: [...linked, linkedName]
            });
            setLinkOpen(false);
          }}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </div>
  );
}

function LinkTopicModal({
  botName,
  catName,
  topicName,
  existing,
  onSubmit,
  onClose
}) {
  const { config } = useGlobalConfig();
  const bot = config?.bots?.[botName];
  const allOptions = [];
  Object.entries(bot?.categories || {}).forEach(([cn, c]) => {
    Object.keys(c.topics || {}).forEach((tn) => {
      if (tn !== topicName) allOptions.push(`${cn}/${tn}`);
    });
  });

  const [picked, setPicked] = useState('');
  const { showAlert } = useDialogs();

  function submit() {
    if (!picked) {
      showAlert('Please select a topic to link', { icon: '⚠️' });
      return;
    }
    const linkedName = picked.split('/')[1];
    if (existing.includes(linkedName)) {
      showAlert('This topic is already linked', { icon: '⚠️' });
      return;
    }
    onSubmit(linkedName);
  }

  return (
    <div
      className="modal-overlay"
      id="link-topic-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Link to Existing Topic</h3>
          <button className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Select Topic to Link</label>
            <select
              className="select"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
            >
              <option value="">-- Select a topic --</option>
              {allOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <small className="text-muted">
              This topic will inherit all SEOs from the linked topic
            </small>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit}>
            Link
          </button>
        </div>
      </div>
    </div>
  );
}
