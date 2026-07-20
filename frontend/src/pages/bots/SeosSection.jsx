/**
 * SeosSection — Figma "Keywords" section inside a topic:
 *
 *   ▾ ⚿ Keywords  [⚿ 180 Keywords]   [✨ Suggest With AI] [⬇ Import] [+ Keywords] [🗑 Mass Delete] [⋮]
 *   [Title ×] [Title ×] [Title ×] …
 *
 * Also handles the admin-hidden-keywords case (`topic._keyword_count` set,
 * raw keywords absent) — user-added keywords are tracked locally so they
 * remain removable in the same session.
 *
 * Backend endpoints used:
 *   POST /api/topic/keyword/add      (single insert, used for hidden-mode)
 *   POST /api/topic/keyword/delete   (delete by keyword text — hidden-mode)
 *   POST /api/topic/update           (overwrites the full keywords array — open mode)
 *   POST /api/topic/suggest-seos     (via SeoSuggestModal)
 *   POST /api/topic/keyword/add-bulk (via SeoSuggestModal / AddKeywordsModal)
 */

import { useState } from 'react';
import { api } from '../../lib/api';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useQueryClient } from '@tanstack/react-query';
import SeoSuggestModal from './SeoSuggestModal';
import AddKeywordsModal from './AddKeywordsModal';
import Icon from '../../components/icons';

// Local (per-session) tracking of user-added keywords when admin has hidden
// the master list — keyed by 'bot|cat|topic'.
const _userAddedKeywords = {};

export default function SeosSection({ botName, catName, topicName, topic, inherited = false, sortMode = '' }) {
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

  const [open, setOpen] = useState(true);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const { showNotification } = useDialogs();
  const qc = useQueryClient();

  const updateTopic = useApiMutation('/api/topic/update', {
    invalidate: ['config'],
    errorMsg: 'Failed to update keywords'
  });

  // Display order — the "Sort By" subbar only affects presentation; deletes
  // always map back to the canonical index.
  const displayKeywords = keywords.map((kw, idx) => ({ kw, idx }));
  if (sortMode === 'alpha') displayKeywords.sort((a, b) => a.kw.localeCompare(b.kw));

  // ── Delete a single keyword (open mode: index-based) ──────────────────────
  function removeKeyword(idx) {
    const next = keywords.filter((_, i) => i !== idx);
    updateTopic.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      keywords: next
    });
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

  const deleteAll = useConfirmedMutation(updateTopic, {
    message: `Delete all ${keywords.length} keywords from this topic?`,
    title: 'Mass Delete Keywords',
    confirmLabel: 'Delete All',
    confirmClass: 'btn-danger'
  });

  function onMassDelete() {
    if (!keywords.length) return;
    deleteAll({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      keywords: []
    });
  }

  const canEdit = !seoHidden && !inherited;

  return (
    <div
      className={`tsec ${open ? 'open' : ''}`}
      style={catchAll ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
    >
      <div className="tsec-head" onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-toggle cat-chevron">▼</span>
        <span className="tsec-icon"><Icon name="key" size={16} /></span>
        <span className="tsec-title">Keywords</span>
        <span className="kw-count-chip">
          <Icon name="key" size={12} />
          {seoCount} Keyword{seoCount !== 1 ? 's' : ''}
        </span>
        <div className="tsec-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn-ai-suggest" onClick={() => setSuggestOpen(true)}>
            <span className="btn-ai-shine"></span>✨ Suggest With AI
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setAddOpen(true)}>
            <Icon name="importBox" size={13} style={{ marginRight: 5 }} />
            Import
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={13} style={{ marginRight: 5 }} />
            Keywords
          </button>
          {canEdit && (
            <button
              className="btn btn-secondary btn-sm btn-outline-danger"
              onClick={onMassDelete}
              disabled={!keywords.length}
            >
              <Icon name="trash" size={13} style={{ marginRight: 5 }} />
              Mass Delete
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="tsec-body">
          <div
            className="tags-container tags-scrollable"
            id={`kw-tags-${botName}-${catName}-${topicName}`}
          >
            {seoHidden ? (
              <>
                <span className="tag tag-readonly" style={{ borderStyle: 'dashed', cursor: 'default' }}>
                  🔒 {topic._keyword_count} SEO{topic._keyword_count !== 1 ? 's' : ''} active —{' '}
                  {inherited ? 'inherited group (keywords managed by admin)' : 'details hidden by admin'}
                </span>
                {userKws.map((kw) => (
                  <span className="tag tag-user-kw" key={kw}>
                    {kw}
                    <span className="tag-remove" onClick={() => removeUserKeyword(kw)}>×</span>
                  </span>
                ))}
              </>
            ) : (
              <>
                {displayKeywords.map(({ kw, idx }) => (
                  <span className="tag" key={`${kw}-${idx}`}>
                    {kw}
                    {canEdit && (
                      <span className="tag-remove" onClick={() => removeKeyword(idx)}>×</span>
                    )}
                  </span>
                ))}
                {keywords.length === 0 && (
                  <span className="tsec-empty">
                    No keywords yet — click "+ Keywords" or "Import" to add some
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}

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
