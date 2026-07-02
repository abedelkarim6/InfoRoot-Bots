/**
 * ReplaceGroupsTab — the "Replace Terms Groups" tab of the 🏷️ SEOs page.
 * Same shared categories as the SEO Groups tab, but each group holds from→to
 * replace pairs (used by bot "Replace in message" rules) instead of keywords.
 *
 * Backend:
 *   GET  /api/seo/replace-library
 *   POST /api/seo/replace-group/add
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import ReplaceGroupBox from './ReplaceGroupBox';
import ReplacePairsEditor from './ReplacePairsEditor';

export default function ReplaceGroupsTab({ isAdmin }) {
  const { data, isLoading } = useQuery({
    queryKey: ['seo-replace-library'],
    queryFn: () => api('/api/seo/replace-library')
  });

  const categories = data?.status === 'ok' ? data.categories || [] : [];

  if (isLoading) return <div className="text-muted" style={{ padding: 20 }}>Loading…</div>;
  if (categories.length === 0) {
    return (
      <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
        No categories yet.{isAdmin ? ' Create one above to get started.' : ''}
      </div>
    );
  }

  return (
    <>
      {categories.map((cat) => (
        <ReplaceCategoryBox key={cat.id ?? 'uncategorized'} category={cat} isAdmin={isAdmin} />
      ))}
    </>
  );
}

function ReplaceCategoryBox({ category, isAdmin }) {
  const [open, setOpen] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const groups = category.groups || [];
  const isSynthetic = !category.id;
  const canEdit = isAdmin && !isSynthetic;

  return (
    <div className={`category-box collapsible-section ${open ? 'open' : ''}`}>
      <div className="category-header-row" onClick={() => setOpen((v) => !v)}>
        <div className="category-title-group">
          <h4>🗂️ {category.name}</h4>
          <span className="text-muted" style={{ marginLeft: 8 }}>
            ({groups.length} replace group{groups.length !== 1 ? 's' : ''})
          </span>
        </div>
        {canEdit && (
          <div className="category-controls" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-secondary btn-sm" onClick={() => { setOpen(true); setAddOpen(true); }}>
              + Replace Group
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
                No replace groups in this category yet.
              </div>
            )}
            {groups.map((g) => (
              <ReplaceGroupBox key={g.id} group={g} isAdmin={isAdmin} />
            ))}
          </div>
        </div>
      )}

      {addOpen && (
        <AddReplaceGroupModal categoryId={category.id} onClose={() => setAddOpen(false)} />
      )}
    </div>
  );
}

function AddReplaceGroupModal({ categoryId, onClose }) {
  const [name, setName] = useState('');
  const [pairs, setPairs] = useState([{ from: '', to: '', enabled: true }]);
  const { showNotification } = useDialogs();

  const add = useApiMutation('/api/seo/replace-group/add', {
    invalidate: ['seo-replace-library'],
    successMsg: 'Replace group added',
    errorMsg: 'Failed to add group',
    onSuccess: onClose
  });

  function submit() {
    const nm = name.trim();
    if (!nm) {
      showNotification('Enter a group name', 'error');
      return;
    }
    const clean = pairs
      .map((p) => ({ from: (p.from || '').trim(), to: p.to ?? '', enabled: p.enabled !== false }))
      .filter((p) => p.from);
    if (!clean.length) {
      showNotification('Add at least one pair with a "From" value', 'error');
      return;
    }
    add.mutate({ category_id: categoryId, name: nm, pairs: clean });
  }

  return (
    <div className="modal-overlay" style={{ display: 'flex' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-dialog" style={{ maxWidth: 600 }}>
        <div className="modal-header" style={{ padding: '18px 22px' }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>🔁 Add Replace Group</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '18px 22px', maxHeight: '62vh', overflowY: 'auto' }}>
          <div className="form-group">
            <label className="form-label">Group name</label>
            <input
              className="input"
              style={{ width: '100%' }}
              placeholder="e.g. تصحيح المصطلحات"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Pairs (at least one)</label>
            <ReplacePairsEditor value={pairs} onChange={setPairs} disabled={add.isPending} />
          </div>
        </div>
        <div className="modal-footer" style={{ padding: '14px 22px' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={add.isPending}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={add.isPending}>
            {add.isPending ? 'Adding…' : '+ Add Group'}
          </button>
        </div>
      </div>
    </div>
  );
}
