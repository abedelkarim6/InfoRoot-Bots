/**
 * ReplaceGroupBox — one replace-terms group: a named set of from→to pairs.
 * Header shows enabled dot, name, pair count, and (for admins) Disable / rename
 * / delete. The body (lazy on first open) is a pairs editor with a Save button.
 *
 * Pairs are saved as a full replacement via /api/seo/replace-group/pairs/set
 * (the platform's PATCH {pairs:[...]} replaces the whole set).
 *
 * Backend:
 *   POST /api/seo/replace-group/pairs/set | toggle | rename | delete
 */

import { useState } from 'react';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import ReplacePairsEditor from './ReplacePairsEditor';

export default function ReplaceGroupBox({ group, isAdmin }) {
  const enabled = group.enabled !== false;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(group.pairs || []);
  const { showPrompt, showNotification } = useDialogs();

  // Re-seed the draft from the server whenever the group's pairs change
  // (e.g. after a successful save invalidates the query and refetches).
  const serverKey = JSON.stringify(group.pairs || []);
  const [seededKey, setSeededKey] = useState(serverKey);
  if (serverKey !== seededKey && !open) {
    setSeededKey(serverKey);
    setDraft(group.pairs || []);
  }

  const savePairs = useApiMutation('/api/seo/replace-group/pairs/set', {
    invalidate: ['seo-replace-library'],
    successMsg: 'Pairs saved',
    errorMsg: 'Failed to save pairs',
    onSuccess: () => setSeededKey('')  // force re-seed from refetched data
  });

  const toggle = useApiMutation('/api/seo/replace-group/toggle', {
    invalidate: ['seo-replace-library'],
    successMsg: (res, vars) => `Group ${vars.enabled ? 'enabled' : 'disabled'}`,
    errorMsg: 'Failed to update group'
  });

  const rename = useApiMutation('/api/seo/replace-group/rename', {
    invalidate: ['seo-replace-library'],
    successMsg: 'Group renamed',
    errorMsg: 'Failed to rename group'
  });

  const remove = useApiMutation('/api/seo/replace-group/delete', {
    invalidate: ['seo-replace-library'],
    successMsg: 'Group deleted',
    errorMsg: 'Failed to delete group'
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete replace group "${group.name}"?`,
    title: 'Delete Replace Group',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function stop(e) { e.stopPropagation(); }

  function onRename(e) {
    stop(e);
    showPrompt('Rename Replace Group', group.name, (v) => {
      const name = (v || '').trim();
      if (name && name !== group.name) rename.mutate({ id: group.id, name });
    });
  }

  function onSave() {
    const clean = draft
      .map((p) => ({ from: (p.from || '').trim(), to: p.to ?? '', enabled: p.enabled !== false }))
      .filter((p) => p.from);
    if (!clean.length) {
      showNotification('Add at least one pair with a "From" value', 'error');
      return;
    }
    savePairs.mutate({ id: group.id, pairs: clean });
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(group.pairs || []);

  return (
    <div className={`topic-box collapsible-section ${open ? 'open' : ''}`} style={{ opacity: enabled ? 1 : 0.6 }}>
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
          <span className="linked-badge" style={{ marginLeft: 8 }}>
            {(group.pairs?.length || 0)} pair{(group.pairs?.length || 0) !== 1 ? 's' : ''}
          </span>
        </div>
        {isAdmin && (
          <div className="topic-controls" onClick={stop}>
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

      {open && (
        <div className="collapsible-content">
          <div className="collapsible-inner">
            <div className="topic-body">
              <div className="form-group">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <label className="form-label" style={{ margin: 0 }}>Replace Pairs</label>
                  {isAdmin && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={onSave}
                      disabled={savePairs.isPending || !dirty}
                    >
                      {savePairs.isPending ? 'Saving…' : dirty ? '💾 Save Pairs' : 'Saved'}
                    </button>
                  )}
                </div>
                <ReplacePairsEditor value={draft} onChange={setDraft} disabled={!isAdmin || savePairs.isPending} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
