/**
 * TopicSeoGroupsSection — attach reusable SEO groups (from the 🏷️ SEOs library)
 * to a topic. The attached groups' keywords merge into this topic's matching,
 * exactly like the topic's own SEOs. Mirrors LinkedTopicsSection's shape.
 *
 * The topic config already carries `topic.seo_groups` (attached group meta), and
 * the full library is fetched from /api/seo/library so the user can pick more.
 *
 * Backend:  POST /api/seo/topic/groups/set  with { group_ids: [...] }
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';

export default function TopicSeoGroupsSection({ botName, catName, topicName, topic }) {
  const attached = topic.seo_groups || [];
  const attachedIds = attached.map((g) => g.id);
  const [pickOpen, setPickOpen] = useState(false);

  const save = useApiMutation('/api/seo/topic/groups/set', {
    invalidate: ['config'],
    successMsg: 'SEO groups updated',
    errorMsg: 'Failed to update SEO groups'
  });

  function setGroups(group_ids) {
    save.mutate({ bot_name: botName, category_name: catName, topic_name: topicName, group_ids });
  }

  function removeId(id) {
    setGroups(attachedIds.filter((g) => g !== id));
  }

  return (
    <div className="form-group">
      <label className="form-label">SEO Groups (shared library)</label>
      <div className="tags-container">
        {attached.map((g) => (
          <span
            className="tag"
            key={g.id}
            title={g.enabled === false ? 'This group is disabled — contributes no keywords' : `${g.category} › ${g.name}`}
            style={g.enabled === false ? { opacity: 0.55 } : undefined}
          >
            🏷️ {g.name}
            {g.enabled === false && ' (disabled)'}
            <span className="tag-remove" onClick={() => removeId(g.id)}>×</span>
          </span>
        ))}
        {attached.length === 0 && (
          <span
            className="tag"
            style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px dashed var(--border-color)', cursor: 'default', pointerEvents: 'none' }}
          >
            No SEO groups attached
          </span>
        )}
      </div>
      <button className="btn btn-secondary btn-sm mt-1" onClick={() => setPickOpen(true)} disabled={save.isPending}>
        + Attach SEO Group
      </button>
      <small className="text-muted d-block mt-1">
        Attach groups from the 🏷️ SEOs library — their keywords match for this topic too.
      </small>

      {pickOpen && (
        <AttachGroupModal
          attachedIds={attachedIds}
          onSubmit={(ids) => { setGroups(ids); setPickOpen(false); }}
          onClose={() => setPickOpen(false)}
        />
      )}
    </div>
  );
}

function AttachGroupModal({ attachedIds, onSubmit, onClose }) {
  const { showAlert } = useDialogs();
  const { data, isLoading } = useQuery({
    // Fast local-mirror read (group names + keyword counts only) — no external
    // platform call or re-sync, so the picker opens near-instantly. Distinct key
    // from ['seo-library'] (the full library page) to avoid cache-shape clashes.
    queryKey: ['seo-library-mirror'],
    queryFn: () => api('/api/seo/library/mirror'),
    staleTime: 60_000
  });
  const [selected, setSelected] = useState(new Set(attachedIds));

  const categories = data?.status === 'ok' ? data.categories || [] : [];
  const hasAny = categories.some((c) => (c.groups || []).length > 0);

  function toggle(id) {
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleCategory(cat, checked) {
    const ids = (cat.groups || []).map((g) => g.id);
    setSelected((cur) => {
      const next = new Set(cur);
      ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
      return next;
    });
  }

  function submit() {
    onSubmit([...selected]);
  }

  return (
    <div className="modal-overlay" style={{ display: 'flex' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-dialog" style={{ maxWidth: 540 }}>
        <div className="modal-header" style={{ padding: '18px 22px' }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>🏷️ Attach SEO Groups</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '12px 22px', maxHeight: '60vh', overflowY: 'auto' }}>
          {isLoading && <div className="text-muted">Loading library…</div>}
          {!isLoading && !hasAny && (
            <div className="text-muted">
              No SEO groups exist yet. Create some on the 🏷️ SEOs page first.
            </div>
          )}
          {categories.map((cat) => {
            const catGroups = cat.groups || [];
            if (!catGroups.length) return null;
            const selCount = catGroups.filter((g) => selected.has(g.id)).length;
            const allSel = selCount === catGroups.length;
            return (
              <div key={cat.id ?? 'uncategorized'} style={{ marginBottom: 14 }}>
                <label
                  className="form-label"
                  style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={allSel}
                    ref={(el) => { if (el) el.indeterminate = selCount > 0 && !allSel; }}
                    onChange={(e) => toggleCategory(cat, e.target.checked)}
                  />
                  {cat.name}
                  <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
                    ({selCount}/{catGroups.length})
                  </span>
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {catGroups.map((g) => (
                    <label key={g.id} className="seo-lang-pill" style={{ opacity: g.enabled === false ? 0.6 : 1 }}>
                      <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggle(g.id)} />
                      <span>
                        {g.name}{' '}
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                          ({g.keyword_count ?? g.keywords?.length ?? 0} kw{g.enabled === false ? ', disabled' : ''})
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="modal-footer" style={{ padding: '14px 22px' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit}>
            Save ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
