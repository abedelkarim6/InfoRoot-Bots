/**
 * TopicBox — single topic card. Header always renders; body (catch-all,
 * SEOs, linked topics, schedules) is mounted lazily — the heavy components
 * mount only on first open. This mirrors the legacy `_buildTopicBodyHtml`
 * lazy lifecycle that was added for performance with many topics.
 *
 * Backend endpoints used here directly:
 *   POST /api/topic/toggle       (enable / disable)
 *   POST /api/topic/rename
 *   POST /api/topic/delete
 */

import { useState } from 'react';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import CatchAllToggle from './CatchAllToggle';
import SeosSection from './SeosSection';
import TopicSeoGroupsSection from './TopicSeoGroupsSection';
import LinkedTopicsSection from './LinkedTopicsSection';
import SchedulesSection from './SchedulesSection';

export default function TopicBox({
  botName,
  catName,
  topicName,
  topic,
  categoryEnabled
}) {
  const [open, setOpen] = useState(false);
  // Once the topic has been opened, keep its body mounted (fast subsequent
  // toggles), but never mount it before the first open. This matches the
  // legacy `_renderLazyTopicContent` behaviour exactly.
  const [bodyEverOpen, setBodyEverOpen] = useState(false);

  const schedules = topic.schedules || [];
  const linkedTopics = topic.linked_topics || [];
  const seoGroups = topic.seo_groups || [];
  const catchAll = !!topic.catch_all;
  const isDisabledByCategory = !categoryEnabled;

  const toggle = useApiMutation('/api/topic/toggle', {
    invalidate: ['config'],
    successMsg: (res, vars) => `Topic ${vars.enabled ? 'enabled' : 'disabled'}`,
    errorMsg: 'Failed to update topic'
  });

  const remove = useApiMutation('/api/topic/delete', {
    invalidate: ['config', 'recycle-bin'],
    successMsg: 'Topic deleted',
    errorMsg: 'Failed to delete topic'
  });

  const rename = useApiMutation('/api/topic/rename', {
    invalidate: ['config'],
    successMsg: 'Topic renamed',
    errorMsg: 'Failed to rename topic'
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete topic "${topicName}"?`,
    title: 'Delete Topic',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  const { showPrompt } = useDialogs();

  function onHeaderClick() {
    setOpen((cur) => {
      const next = !cur;
      if (next) setBodyEverOpen(true);
      return next;
    });
  }

  function onToggleEnabled(e) {
    toggle.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      enabled: e.target.checked
    });
  }

  function onDelete() {
    confirmDelete({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName
    });
  }

  function onRename() {
    showPrompt('Rename Topic', topicName, (newName) => {
      const trimmed = (newName || '').trim();
      if (!trimmed || trimmed === topicName) return;
      rename.mutate({
        bot_name: botName,
        category_name: catName,
        old_name: topicName,
        new_name: trimmed
      });
    });
  }

  return (
    <div
      className={`topic-box collapsible-section ${open ? 'open' : ''} ${
        isDisabledByCategory ? 'category-disabled' : ''
      }`}
      id={`topic-${botName}-${catName}-${topicName}`}
    >
      <div className="topic-header-row" onClick={onHeaderClick}>
        <div className="topic-title-group">
          <strong>📌 {topicName}</strong>
          {isDisabledByCategory && (
            <span className="disabled-badge">Category Disabled</span>
          )}
          {catchAll && (
            <span
              className="linked-badge"
              style={{
                background: 'var(--accent-primary,#6366f1)',
                color: '#fff'
              }}
            >
              🌐 Catch All
            </span>
          )}
          {linkedTopics.length > 0 && (
            <span className="linked-badge">🔗 {linkedTopics.length} linked</span>
          )}
          {seoGroups.length > 0 && (
            <span className="linked-badge">🏷️ {seoGroups.length} group{seoGroups.length !== 1 ? 's' : ''}</span>
          )}
          <span className="schedule-indicator">
            🕐 {schedules.length} schedule{schedules.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="topic-controls" onClick={(e) => e.stopPropagation()}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={!!topic.enabled}
              onChange={onToggleEnabled}
              disabled={toggle.isPending}
            />
            <span className="toggle-slider"></span>
          </label>
          <button
            className="btn-icon"
            title="Rename topic"
            onClick={onRename}
            disabled={rename.isPending}
          >
            ✏️
          </button>
          <button
            className="btn-icon btn-danger"
            title="Delete topic"
            onClick={onDelete}
            disabled={remove.isPending}
          >
            🗑️
          </button>
          <span className="collapsible-toggle">▼</span>
        </div>
      </div>

      {bodyEverOpen && (
        <div className="collapsible-content">
          <div className="collapsible-inner">
            <div className="topic-body">
              <CatchAllToggle
                botName={botName}
                catName={catName}
                topicName={topicName}
                topic={topic}
              />
              <SeosSection
                botName={botName}
                catName={catName}
                topicName={topicName}
                topic={topic}
              />
              <TopicSeoGroupsSection
                botName={botName}
                catName={catName}
                topicName={topicName}
                topic={topic}
              />
              <LinkedTopicsSection
                botName={botName}
                catName={catName}
                topicName={topicName}
                topic={topic}
              />
            </div>
            <SchedulesSection
              botName={botName}
              catName={catName}
              topicName={topicName}
              topic={topic}
            />
          </div>
        </div>
      )}
    </div>
  );
}
