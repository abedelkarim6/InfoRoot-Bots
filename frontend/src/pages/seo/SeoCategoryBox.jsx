/**
 * SeoCategoryBox — one category card in the SEO library, containing its SEO
 * groups. Collapsible (default open). Admins get rename / delete and an inline
 * "+ SEO Group" creator.
 *
 * Backend:
 *   POST /api/seo/category/rename | delete
 *   POST /api/seo/group/add
 */

import { useRef, useState } from 'react';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import SeoGroupBox from './SeoGroupBox';

export default function SeoCategoryBox({ category, isAdmin }) {
  const [open, setOpen] = useState(true);
  const [newGroup, setNewGroup] = useState('');
  const newGroupRef = useRef(null);
  const groups = category.groups || [];
  // The synthetic "Uncategorized" bucket has no external id — it's read-only
  // (you can't rename/delete it or create groups directly under it).
  const isSynthetic = !category.id;
  const canEdit = isAdmin && !isSynthetic;
  const { showPrompt } = useDialogs();

  const rename = useApiMutation('/api/seo/category/rename', {
    invalidate: ['seo-library'],
    successMsg: 'Category renamed',
    errorMsg: 'Failed to rename category'
  });

  const remove = useApiMutation('/api/seo/category/delete', {
    invalidate: ['seo-library', 'config'],
    successMsg: 'Category deleted',
    errorMsg: 'Failed to delete category'
  });

  const addGroup = useApiMutation('/api/seo/group/add', {
    invalidate: ['seo-library'],
    successMsg: 'SEO group added',
    errorMsg: 'Failed to add group',
    onSuccess: () => setNewGroup('')
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete category "${category.name}" and all ${groups.length} of its SEO groups?`,
    title: 'Delete Category',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function onRename(e) {
    e.stopPropagation();
    showPrompt('Rename Category', category.name, (v) => {
      const name = (v || '').trim();
      if (name && name !== category.name) rename.mutate({ id: category.id, name });
    });
  }

  function onAddGroup() {
    const name = newGroup.trim();
    if (!name) return;
    addGroup.mutate({ category_id: category.id, name });
  }

  function onClickAddGroup(e) {
    e.stopPropagation();
    if (!open) setOpen(true);
    setTimeout(() => newGroupRef.current?.focus(), 0);
  }

  return (
    <div className={`category-box collapsible-section ${open ? 'open' : ''}`}>
      <div className="category-header-row" onClick={() => setOpen((v) => !v)}>
        <div className="category-title-group">
          <h4>🗂️ {category.name}</h4>
          <span className="text-muted" style={{ marginLeft: 8 }}>
            ({groups.length} SEO group{groups.length !== 1 ? 's' : ''})
          </span>
        </div>
        {canEdit && (
          <div className="category-controls" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-secondary btn-sm" onClick={onClickAddGroup}>
              + SEO Group
            </button>
            <button className="btn-icon" title="Rename category" onClick={onRename}>✏️</button>
            <button
              className="btn-icon btn-danger"
              title="Delete category"
              onClick={(e) => { e.stopPropagation(); confirmDelete({ id: category.id }); }}
            >
              🗑️
            </button>
            <span className="collapsible-toggle">▼</span>
          </div>
        )}
        {!canEdit && <span className="collapsible-toggle">▼</span>}
      </div>

      {open && (
        <div className="collapsible-content">
          <div className="collapsible-inner" style={{ padding: '8px 0' }}>
            {groups.length === 0 && (
              <div className="text-muted" style={{ padding: '8px 12px' }}>
                No SEO groups in this category yet.
              </div>
            )}
            {groups.map((g) => (
              <SeoGroupBox key={g.id} group={g} isAdmin={isAdmin} />
            ))}

            {canEdit && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', flexWrap: 'wrap' }}>
                <input
                  ref={newGroupRef}
                  className="input"
                  style={{ flex: '1 1 220px', minWidth: 180 }}
                  placeholder="New SEO group name…"
                  value={newGroup}
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && onAddGroup()}
                />
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={onAddGroup}
                  disabled={addGroup.isPending || !newGroup.trim()}
                >
                  + Add Group
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
