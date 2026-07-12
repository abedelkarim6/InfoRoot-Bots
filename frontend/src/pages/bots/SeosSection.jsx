/**
 * SeosSection — keyword tag list for a topic, with select-all / delete-selected
 * / delete-all and AI suggest. Also handles the admin-hidden-keywords case
 * (`topic._keyword_count` set, raw keywords absent) — user-added keywords are
 * tracked locally so they remain removable in the same session.
 *
 * Backend endpoints used:
 *   POST /api/topic/keyword/add      (single insert, used for hidden-mode)
 *   POST /api/topic/keyword/delete   (delete by keyword text — hidden-mode)
 *   POST /api/topic/update           (overwrites the full keywords array — open mode)
 *   POST /api/topic/suggest-seos     (via SeoSuggestModal)
 *   POST /api/topic/keyword/add-bulk (via SeoSuggestModal)
 */

import { useState } from 'react';
import { api } from '../../lib/api';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useQueryClient } from '@tanstack/react-query';
import SeoSuggestModal from './SeoSuggestModal';
import AddKeywordsModal from './AddKeywordsModal';

// Local (per-session) tracking of user-added keywords when admin has hidden
// the master list — keyed by 'bot|cat|topic'.
const _userAddedKeywords = {};

export default function SeosSection({ botName, catName, topicName, topic, inherited = false }) {
  const seoHidden = topic._keyword_count != null;
  const keywords = topic.keywords || [];
  const ukKey = `${botName}|${catName}|${topicName}`;
  // User-scoped overlay keywords on an inherited bot: persisted by the backend
  // (topic.user_keywords) + any added this session before the config refetch.
  const serverUserKws = topic.user_keywords || [];
  const localUserKws = _userAddedKeywords[ukKey] || [];
  const userKws = (inherited || seoHidden)
    ? [...serverUserKws, ...localUserKws.filter((k) => !serverUserKws.includes(k))]
    : [];
  const seoCount = (seoHidden ? topic._keyword_count : keywords.length) + userKws.length;
  const catchAll = !!topic.catch_all;

  const [selected, setSelected] = useState(new Set());
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const { showNotification } = useDialogs();
  const qc = useQueryClient();

  const updateTopic = useApiMutation('/api/topic/update', {
    invalidate: ['config'],
    errorMsg: 'Failed to update keywords'
  });

  const removeAll = useApiMutation('/api/topic/update', {
    invalidate: ['config'],
    errorMsg: 'Failed to delete keywords'
  });

  // ── Delete a single keyword (open mode: index-based) ──────────────────────
  function removeKeyword(idx) {
    const next = keywords.filter((_, i) => i !== idx);
    updateTopic.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      keywords: next
    });
    setSelected(new Set());
  }

  // ── Hidden-mode user-added single keyword removal ─────────────────────────
  async function removeUserKeyword(kw) {
    const res = await api('/api/topic/keyword/delete', {
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      keyword: kw
    });
    if (res?.status !== 'ok') {
      showNotification('Failed to remove SEO', 'error');
      return;
    }
    if (_userAddedKeywords[ukKey]) {
      _userAddedKeywords[ukKey] = _userAddedKeywords[ukKey].filter((k) => k !== kw);
    }
    qc.invalidateQueries({ queryKey: ['config'] });
    showNotification('SEO removed', 'success');
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  function toggleSelected(idx) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === keywords.length) setSelected(new Set());
    else setSelected(new Set(keywords.map((_, i) => i)));
  }

  const deleteSelected = useConfirmedMutation(updateTopic, {
    message: `Delete ${selected.size} selected keyword${selected.size > 1 ? 's' : ''}?`,
    title: 'Delete Keywords',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function onDeleteSelected() {
    if (!selected.size) return;
    const next = keywords.filter((_, i) => !selected.has(i));
    deleteSelected({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      keywords: next
    });
    setSelected(new Set());
  }

  const deleteAll = useConfirmedMutation(removeAll, {
    message: `Delete all ${keywords.length} keywords from this topic?`,
    title: 'Delete All Keywords',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function onDeleteAll() {
    if (!keywords.length) return;
    deleteAll({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      keywords: []
    });
    setSelected(new Set());
  }

  return (
    <div
      className="form-group"
      style={catchAll ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          gap: 10,
          flexWrap: 'wrap'
        }}
      >
        <label className="form-label" style={{ margin: 0 }}>
          SEOs ({seoCount})
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-kw-action kw-add" onClick={() => setAddOpen(true)}>
            ➕ Add Keywords
          </button>
          {!seoHidden && !inherited && keywords.length > 0 && (
            <>
              <button className="btn-kw-action kw-neutral" onClick={toggleSelectAll}>
                ☑ Select All
              </button>
              {selected.size > 0 && (
                <button className="btn-kw-action kw-danger" onClick={onDeleteSelected}>
                  🗑 Delete Selected
                </button>
              )}
              <button className="btn-kw-action kw-danger" onClick={onDeleteAll}>
                🗑 Delete All
              </button>
            </>
          )}
          <button className="btn-ai-suggest" onClick={() => setSuggestOpen(true)}>
            <span className="btn-ai-shine"></span>✨ Suggest with AI
          </button>
        </div>
      </div>

      <div
        className="tags-container tags-scrollable"
        id={`kw-tags-${botName}-${catName}-${topicName}`}
      >
        {seoHidden ? (
          <>
            <span
              className="tag"
              style={{
                background: 'rgba(99,102,241,.12)',
                color: 'var(--text-muted)',
                border: '1px dashed var(--border-color)',
                cursor: 'default',
                pointerEvents: 'none'
              }}
            >
              🔒 {topic._keyword_count} SEO{topic._keyword_count !== 1 ? 's' : ''} active —{' '}
              {inherited ? 'inherited group (keywords managed by admin)' : 'details hidden by admin'}
            </span>
            {userKws.map((kw) => (
              <span className="tag tag-user-kw" key={kw}>
                {kw}
                <span
                  className="tag-remove"
                  onClick={() => removeUserKeyword(kw)}
                >
                  ×
                </span>
              </span>
            ))}
          </>
        ) : (
          <>
            {keywords.map((kw, idx) => (
              <span className="tag kw-selectable" key={`${kw}-${idx}`}>
                <input
                  type="checkbox"
                  className="kw-cb"
                  style={{
                    margin: '0 4px 0 0',
                    accentColor: 'var(--accent-primary)',
                    cursor: 'pointer'
                  }}
                  checked={selected.has(idx)}
                  onChange={() => toggleSelected(idx)}
                />
                {kw}
                <span className="tag-remove" onClick={() => removeKeyword(idx)}>
                  ×
                </span>
              </span>
            ))}
            {keywords.length === 0 && (
              <span
                className="tag"
                style={{
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px dashed var(--border-color)',
                  cursor: 'default',
                  pointerEvents: 'none'
                }}
              >
                No SEOs yet — click ➕ Add Keywords to add some
              </span>
            )}
          </>
        )}
      </div>

      {suggestOpen && (
        <SeoSuggestModal
          botName={botName}
          catName={catName}
          topicName={topicName}
          onClose={() => setSuggestOpen(false)}
        />
      )}

      {addOpen && (
        <AddKeywordsModal
          botName={botName}
          catName={catName}
          topicName={topicName}
          seoHidden={seoHidden || inherited}
          onAddedHidden={(kws) => {
            if (!_userAddedKeywords[ukKey]) _userAddedKeywords[ukKey] = [];
            kws.forEach((kw) => {
              if (!_userAddedKeywords[ukKey].includes(kw)) _userAddedKeywords[ukKey].push(kw);
            });
          }}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}
