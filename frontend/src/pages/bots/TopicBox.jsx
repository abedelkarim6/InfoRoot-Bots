/**
 * TopicBox — single topic row (Figma "Summaries Topic" anatomy):
 *
 *   ▾ | # | ⠿ | ● | name + sub … [⚿ N Keywords] [+ SEO Group] [⋮]
 *   (expanded)
 *   [Sort By ▾  (active-sort chip ×)]              [Catch All toggle + label]
 *   ── SEO Groups section (group rows w/ Edit in SEOs / Disable / 🗑)
 *   ── Keywords section  (count chip, ✨ Suggest With AI, Import, + Keywords, Mass Delete)
 *   ── Linked Topics section (Link Existing Topic / Mass Delete)
 *   ── Schedules section (+ Schedule; rows w/ icon tile, chips, toggle, ⋮)
 *
 * Body is mounted lazily on first open (legacy performance behaviour kept).
 *
 * Backend endpoints used here directly:
 *   POST /api/topic/toggle | /api/topic/rename | /api/topic/delete
 *   POST /api/seo/topic/groups/set   (attach groups via "+ SEO Group")
 */

import { useEffect, useState } from 'react';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import CatchAllToggle from './CatchAllToggle';
import SeosSection from './SeosSection';
import TopicSeoGroupsSection, { AttachGroupModal } from './TopicSeoGroupsSection';
import LinkedTopicsSection from './LinkedTopicsSection';
import SchedulesSection from './SchedulesSection';
import Icon from '../../components/icons';
import KebabMenu from '../../components/KebabMenu';

export default function TopicBox({
  botName,
  catName,
  topicName,
  topic,
  categoryEnabled,
  idx,
  forceOpen,
  inherited = false
}) {
  const [open, setOpen] = useState(false);
  // Once the topic has been opened, keep its body mounted (fast subsequent
  // toggles), but never mount it before the first open.
  const [bodyEverOpen, setBodyEverOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [sortMode, setSortMode] = useState(''); // '' | 'alpha' — keyword display order

  useEffect(() => {
    if (forceOpen) {
      setOpen(forceOpen.value);
      if (forceOpen.value) setBodyEverOpen(true);
    }
  }, [forceOpen]);

  const schedules = topic.schedules || [];
  const seoGroups = topic.seo_groups || [];
  const catchAll = !!topic.catch_all;
  const isDisabledByCategory = !categoryEnabled;
  const enabled = topic.enabled !== false;

  const seoHidden = topic._keyword_count != null;
  const kwCount =
    (seoHidden ? topic._keyword_count : (topic.keywords || []).length) +
    (topic.user_keywords || []).length;

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

  const attachGroups = useApiMutation('/api/seo/topic/groups/set', {
    invalidate: ['config'],
    successMsg: 'SEO groups updated',
    errorMsg: 'Failed to update SEO groups'
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
          <span className="collapsible-toggle cat-chevron">▼</span>
          {idx != null && <span className="cat-idx">{idx}</span>}
          <span className="cat-grip"><Icon name="gripVertical" size={14} /></span>
          <span
            className={`cat-dot ${enabled && !isDisabledByCategory ? 'on' : 'off'}`}
            title={enabled ? 'Enabled' : 'Disabled'}
          />
          <div className="cat-name-wrap topic-name-wrap">
            <strong>{topicName}</strong>
            <span className="cat-sub">
              {isDisabledByCategory
                ? 'Category disabled'
                : catchAll
                  ? 'Catch all — matches every message'
                  : `${schedules.length} schedule${schedules.length !== 1 ? 's' : ''}`}
            </span>
          </div>
          <span className="kw-count-chip" title="Keywords in this topic">
            <Icon name="key" size={12} />
            {kwCount} Keyword{kwCount !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="topic-controls" onClick={(e) => e.stopPropagation()}>
          {!inherited && (
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => setAttachOpen(true)}>
                <Icon name="plus" size={13} style={{ marginRight: 5 }} />
                SEO Group
              </button>
              <KebabMenu
                items={[
                  {
                    label: enabled ? 'Disable' : 'Enable',
                    icon: 'ban',
                    disabled: toggle.isPending,
                    onClick: () =>
                      toggle.mutate({
                        bot_name: botName,
                        category_name: catName,
                        topic_name: topicName,
                        enabled: !enabled
                      })
                  },
                  { label: 'Rename', icon: 'pencil', disabled: rename.isPending, onClick: onRename },
                  {
                    label: 'Delete',
                    icon: 'trash',
                    danger: true,
                    disabled: remove.isPending,
                    onClick: () =>
                      confirmDelete({
                        bot_name: botName,
                        category_name: catName,
                        topic_name: topicName
                      })
                  }
                ]}
              />
            </>
          )}
        </div>
      </div>

      {bodyEverOpen && (
        <div className="collapsible-content">
          <div className="collapsible-inner">
            <div className="topic-body">
              {/* Sort By + Catch All subbar (Figma) */}
              <div className="topic-subbar">
                <div className="topic-subbar-left">
                  <select
                    className="input tg-sort"
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value)}
                    title="Keyword display order"
                  >
                    <option value="">Sort By</option>
                    <option value="alpha">Alphabetical</option>
                    <option value="added">Added Date</option>
                  </select>
                  {sortMode && (
                    <span className="sort-chip">
                      {sortMode === 'alpha' ? 'Alphabetical' : 'Added Date'}
                      <span className="tag-remove" onClick={() => setSortMode('')}>×</span>
                    </span>
                  )}
                </div>
                {!inherited && (
                  <CatchAllToggle
                    botName={botName}
                    catName={catName}
                    topicName={topicName}
                    topic={topic}
                  />
                )}
              </div>

              {!inherited && (
                <TopicSeoGroupsSection
                  botName={botName}
                  catName={catName}
                  topicName={topicName}
                  topic={topic}
                  onAttach={() => setAttachOpen(true)}
                />
              )}
              <SeosSection
                botName={botName}
                catName={catName}
                topicName={topicName}
                topic={topic}
                inherited={inherited}
                sortMode={sortMode}
              />
              {!inherited && (
                <LinkedTopicsSection
                  botName={botName}
                  catName={catName}
                  topicName={topicName}
                  topic={topic}
                />
              )}
              <SchedulesSection
                botName={botName}
                catName={catName}
                topicName={topicName}
                topic={topic}
                inherited={inherited}
              />
            </div>
          </div>
        </div>
      )}

      {attachOpen && (
        <AttachGroupModal
          attachedIds={seoGroups.map((g) => g.id)}
          onSubmit={(ids) => {
            attachGroups.mutate({
              bot_name: botName,
              category_name: catName,
              topic_name: topicName,
              group_ids: ids
            });
            setAttachOpen(false);
          }}
          onClose={() => setAttachOpen(false)}
        />
      )}
    </div>
  );
}
