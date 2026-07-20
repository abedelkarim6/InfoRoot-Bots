/**
 * CategoryBox — single category card containing topic boxes. Default open.
 * Header has + Add Topic button, enable toggle, and delete (soft-delete).
 *
 * Backend endpoints used:
 *   POST /api/category/toggle
 *   POST /api/category/delete
 *   POST /api/topic/add  (used by the inline new-topic input at the bottom)
 */

import { useEffect, useRef, useState } from 'react';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import TopicBox from './TopicBox';
import Icon from '../../components/icons';
import KebabMenu from '../../components/KebabMenu';

export default function CategoryBox({ botName, catName, cat, idx, forceOpen, inherited = false }) {
  const [open, setOpen] = useState(false);
  const topics = Object.entries(cat.topics || {});
  const newTopicInputRef = useRef(null);

  // Toolbar "Expand All / Collapse All" — seq bumps on every click so this
  // fires even when the target state matches a previous forceOpen.
  useEffect(() => {
    if (forceOpen) setOpen(forceOpen.value);
  }, [forceOpen]);

  const toggle = useApiMutation('/api/category/toggle', {
    invalidate: ['config'],
    successMsg: (res, vars) =>
      vars.enabled
        ? 'Category enabled (all topics restored)'
        : 'Category disabled',
    errorMsg: 'Failed to update category'
  });

  const remove = useApiMutation('/api/category/delete', {
    invalidate: ['config', 'recycle-bin'],
    successMsg: 'Category deleted',
    errorMsg: 'Failed to delete category'
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete category "${catName}" and all its topics?`,
    title: 'Delete Category',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function onDelete() {
    confirmDelete({ bot_name: botName, category_name: catName });
  }

  function onClickAddTopic(e) {
    e.stopPropagation();
    if (!open) setOpen(true);
    // Defer focus to next paint when the body mounts.
    setTimeout(() => {
      newTopicInputRef.current?.focus();
    }, 0);
  }

  return (
    <div
      className={`category-box collapsible-section ${open ? 'open' : ''}`}
      id={`category-${botName}-${catName}`}
    >
      <div className="category-header-row" onClick={() => setOpen((v) => !v)}>
        <div className="category-title-group">
          <span className="collapsible-toggle cat-chevron">▼</span>
          {idx != null && <span className="cat-idx">{idx}</span>}
          <span className="cat-grip"><Icon name="gripVertical" size={15} /></span>
          <span
            className={`cat-dot ${cat.enabled !== false ? 'on' : 'off'}`}
            title={cat.enabled !== false ? 'Enabled' : 'Disabled'}
          />
          <div className="cat-name-wrap">
            <h4>{catName}</h4>
            <span className="cat-sub">
              {topics.length} topic{topics.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        <div className="category-controls" onClick={(e) => e.stopPropagation()}>
          {!inherited && (
            <>
              <button className="btn btn-primary btn-sm" onClick={onClickAddTopic}>
                <Icon name="plus" size={13} style={{ marginRight: 5 }} />
                Summaries Topic
              </button>
              <KebabMenu
                items={[
                  {
                    label: cat.enabled !== false ? 'Disable' : 'Enable',
                    icon: 'ban',
                    disabled: toggle.isPending,
                    onClick: () =>
                      toggle.mutate({
                        bot_name: botName,
                        category_name: catName,
                        enabled: cat.enabled === false
                      })
                  },
                  {
                    label: 'Delete',
                    icon: 'trash',
                    danger: true,
                    disabled: remove.isPending,
                    onClick: onDelete
                  }
                ]}
              />
            </>
          )}
        </div>
      </div>

      {open && (
        <div className="collapsible-content">
          <div className="topics-container">
            {topics.map(([topicName, topic], i) => (
              <TopicBox
                key={topicName}
                botName={botName}
                catName={catName}
                topicName={topicName}
                topic={topic}
                categoryEnabled={cat.enabled !== false}
                idx={i + 1}
                inherited={inherited}
              />
            ))}
            {!inherited && (
              <AddTopicInline
                botName={botName}
                catName={catName}
                inputRef={newTopicInputRef}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AddTopicInline({ botName, catName, inputRef }) {
  const [name, setName] = useState('');
  const { showAlert } = useDialogs();

  const add = useApiMutation('/api/topic/add', {
    invalidate: ['config'],
    successMsg: 'Topic added',
    errorMsg: 'Failed to add topic',
    onSuccess: () => setName('')
  });

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      showAlert('Please enter a topic name', { icon: '✏️' });
      return;
    }
    add.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: trimmed
    });
  }

  return (
    <div style={{ marginTop: 16 }}>
      <input
        ref={inputRef}
        type="text"
        className="input"
        placeholder="New topic name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            submit();
          }
        }}
        style={{
          display: 'inline-block',
          width: 'auto',
          marginRight: 8
        }}
        disabled={add.isPending}
      />
      <button
        className="btn btn-secondary btn-sm"
        onClick={submit}
        disabled={add.isPending}
      >
        Add
      </button>
    </div>
  );
}
