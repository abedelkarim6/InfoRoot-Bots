/**
 * SeoGroupBox — one SEO group: a named, reusable keyword set. Header shows the
 * enabled dot, name, keyword count, and (for admins) Import / + Keywords /
 * Disable / rename / delete. The body (lazy on first open) lists keyword tags
 * with select + delete, plus an AI-suggest action. A "USED" row shows which
 * topics currently attach this group.
 *
 * Keyword edits overwrite the whole set via /api/seo/group/keywords/set
 * (mirrors how a topic's SeosSection edits in open mode).
 *
 * Backend:
 *   POST /api/seo/group/keywords/set | keyword/add-bulk | toggle | rename | delete
 */

import { useState } from 'react';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import SeoGroupAddKeywordsModal from './SeoGroupAddKeywordsModal';
import SeoGroupSuggestModal from './SeoGroupSuggestModal';

export default function SeoGroupBox({ group, isAdmin }) {
  const keywords = group.keywords || [];
  const usedBy = group.used_by || [];
  const enabled = group.enabled !== false;

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const { showPrompt } = useDialogs();

  const setKeywords = useApiMutation('/api/seo/group/keywords/set', {
    invalidate: ['seo-library', 'config'],
    errorMsg: 'Failed to update keywords'
  });

  const toggle = useApiMutation('/api/seo/group/toggle', {
    invalidate: ['seo-library', 'config'],
    successMsg: (res, vars) => `Group ${vars.enabled ? 'enabled' : 'disabled'}`,
    errorMsg: 'Failed to update group'
  });

  const rename = useApiMutation('/api/seo/group/rename', {
    invalidate: ['seo-library'],
    successMsg: 'Group renamed',
    errorMsg: 'Failed to rename group'
  });

  const remove = useApiMutation('/api/seo/group/delete', {
    invalidate: ['seo-library', 'config'],
    successMsg: 'Group deleted',
    errorMsg: 'Failed to delete group'
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete SEO group "${group.name}"${usedBy.length ? ` — it's used by ${usedBy.length} topic(s)` : ''}?`,
    title: 'Delete SEO Group',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function stop(e) { e.stopPropagation(); }

  function removeKeyword(idx) {
    setKeywords.mutate({ group_id: group.id, keywords: keywords.filter((_, i) => i !== idx) });
    setSelected(new Set());
  }

  function toggleSelected(idx) {
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === keywords.length) setSelected(new Set());
    else setSelected(new Set(keywords.map((_, i) => i)));
  }

  const deleteSelected = useConfirmedMutation(setKeywords, {
    message: `Delete ${selected.size} selected keyword${selected.size > 1 ? 's' : ''}?`,
    title: 'Delete Keywords',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function onDeleteSelected() {
    if (!selected.size) return;
    deleteSelected({ group_id: group.id, keywords: keywords.filter((_, i) => !selected.has(i)) });
    setSelected(new Set());
  }

  const deleteAll = useConfirmedMutation(setKeywords, {
    message: `Delete all ${keywords.length} keywords from "${group.name}"?`,
    title: 'Delete All Keywords',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function onRename(e) {
    stop(e);
    showPrompt('Rename SEO Group', group.name, (v) => {
      const name = (v || '').trim();
      if (name && name !== group.name) rename.mutate({ id: group.id, name });
    });
  }

  return (
    <div
      className={`topic-box collapsible-section ${open ? 'open' : ''}`}
      style={{ opacity: enabled ? 1 : 0.6 }}
    >
      <div className="topic-header-row" onClick={() => setOpen((v) => !v)}>
        <div className="topic-title-group">
          <span
            title={enabled ? 'Enabled' : 'Disabled'}
            style={{
              width: 9, height: 9, borderRadius: '50%', display: 'inline-block', marginRight: 8,
              background: enabled ? 'var(--success,#22c55e)' : 'var(--text-muted,#888)'
            }}
          />
          <strong>{group.name}</strong>
          <span className="linked-badge" style={{ marginLeft: 8 }}>{keywords.length} kw</span>
          {usedBy.length > 0 && (
            <span className="schedule-indicator">🔗 used by {usedBy.length}</span>
          )}
        </div>
        {isAdmin && (
          <div className="topic-controls" onClick={stop}>
            <button className="btn btn-secondary btn-sm" onClick={() => setAddOpen(true)}>⬆ Import</button>
            <button className="btn btn-secondary btn-sm" onClick={() => { setOpen(true); }}>+ Keywords</button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => toggle.mutate({ id: group.id, enabled: !enabled })}
              disabled={toggle.isPending}
            >
              {enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn-icon" title="Rename group" onClick={onRename}>✏️</button>
            <button className="btn-icon btn-danger" title="Delete group" onClick={(e) => { stop(e); confirmDelete({ id: group.id }); }}>🗑️</button>
            <span className="collapsible-toggle">▼</span>
          </div>
        )}
        {!isAdmin && <span className="collapsible-toggle">▼</span>}
      </div>

      {usedBy.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '0 14px 8px' }}>
          <span className="text-muted" style={{ fontSize: 11, fontWeight: 600 }}>USED:</span>
          {usedBy.map((u, i) => (
            <span
              key={`${u.bot_name}-${u.category_name}-${u.topic_name}-${i}`}
              className="tag"
              style={{ cursor: 'default' }}
              title={`${u.bot_name} › ${u.category_name} › ${u.topic_name}`}
            >
              {u.topic_name}
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="collapsible-content">
          <div className="collapsible-inner">
            <div className="topic-body">
              <div className="form-group">
                <div
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginBottom: 8, gap: 10, flexWrap: 'wrap'
                  }}
                >
                  <label className="form-label" style={{ margin: 0 }}>Keywords ({keywords.length})</label>
                  {isAdmin && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button className="btn-kw-action kw-add" onClick={() => setAddOpen(true)}>➕ Add Keywords</button>
                      {keywords.length > 0 && (
                        <>
                          <button className="btn-kw-action kw-neutral" onClick={toggleSelectAll}>☑ Select All</button>
                          {selected.size > 0 && (
                            <button className="btn-kw-action kw-danger" onClick={onDeleteSelected}>🗑 Delete Selected</button>
                          )}
                          <button
                            className="btn-kw-action kw-danger"
                            onClick={() => deleteAll({ group_id: group.id, keywords: [] })}
                          >
                            🗑 Delete All
                          </button>
                        </>
                      )}
                      <button className="btn-ai-suggest" onClick={() => setSuggestOpen(true)}>
                        <span className="btn-ai-shine"></span>✨ Suggest with AI
                      </button>
                    </div>
                  )}
                </div>

                <div className="tags-container tags-scrollable">
                  {keywords.map((kw, idx) => (
                    <span className="tag kw-selectable" key={`${kw}-${idx}`}>
                      {isAdmin && (
                        <input
                          type="checkbox"
                          className="kw-cb"
                          style={{ margin: '0 4px 0 0', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                          checked={selected.has(idx)}
                          onChange={() => toggleSelected(idx)}
                        />
                      )}
                      {kw}
                      {isAdmin && (
                        <span className="tag-remove" onClick={() => removeKeyword(idx)}>×</span>
                      )}
                    </span>
                  ))}
                  {keywords.length === 0 && (
                    <span
                      className="tag"
                      style={{
                        background: 'transparent', color: 'var(--text-muted)',
                        border: '1px dashed var(--border-color)', cursor: 'default', pointerEvents: 'none'
                      }}
                    >
                      No keywords yet{isAdmin ? ' — click ➕ Add Keywords or ⬆ Import' : ''}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {addOpen && (
        <SeoGroupAddKeywordsModal
          groupId={group.id}
          groupName={group.name}
          onClose={() => setAddOpen(false)}
        />
      )}
      {suggestOpen && (
        <SeoGroupSuggestModal
          groupId={group.id}
          groupName={group.name}
          onClose={() => setSuggestOpen(false)}
        />
      )}
    </div>
  );
}
