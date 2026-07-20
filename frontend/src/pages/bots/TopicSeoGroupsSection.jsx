/**
 * TopicSeoGroupsSection — Figma "SEO Groups" section inside a topic:
 *
 *   ▾ 🔍 SEO Groups
 *     ▾ ● SEO Category - SEO Group 1   [✏️ Edit in SEOs] [⊘ Disable] [🗑]
 *        [Title] [Title] [Title] …      (read-only keyword chips)
 *     ▸ ● SEO Category - SEO Group 2   …
 *
 * Attach flow ("+ SEO Group" in the topic header) lives in TopicBox and uses
 * the exported AttachGroupModal below.
 *
 * Backend:
 *   POST /api/seo/topic/groups/set   { group_ids: [...] }   (detach)
 *   POST /api/seo/group/toggle       { id, enabled }        (disable/enable)
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import Icon from '../../components/icons';

export default function TopicSeoGroupsSection({ botName, catName, topicName, topic }) {
  const attached = topic.seo_groups || [];
  const attachedIds = attached.map((g) => g.id);
  const [open, setOpen] = useState(true);

  const save = useApiMutation('/api/seo/topic/groups/set', {
    invalidate: ['config'],
    successMsg: 'SEO groups updated',
    errorMsg: 'Failed to update SEO groups'
  });

  const toggleGroup = useApiMutation('/api/seo/group/toggle', {
    invalidate: ['config', 'seo-library', 'seo-library-mirror'],
    successMsg: (res, vars) => `Group ${vars.enabled ? 'enabled' : 'disabled'}`,
    errorMsg: 'Failed to update group'
  });

  function removeId(id) {
    save.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      group_ids: attachedIds.filter((g) => g !== id)
    });
  }

  return (
    <div className={`tsec ${open ? 'open' : ''}`}>
      <div className="tsec-head" onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-toggle cat-chevron">▼</span>
        <span className="tsec-icon"><Icon name="seo" size={16} /></span>
        <span className="tsec-title">SEO Groups</span>
      </div>

      {open && (
        <div className="tsec-body">
          {attached.length === 0 && (
            <p className="tsec-empty">No SEO groups attached — use "+ SEO Group" above.</p>
          )}
          {attached.map((g) => (
            <SeoGroupRow
              key={g.id}
              group={g}
              onDetach={() => removeId(g.id)}
              onToggle={() => toggleGroup.mutate({ id: g.id, enabled: g.enabled === false })}
              busy={save.isPending || toggleGroup.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SeoGroupRow({ group, onDetach, onToggle, busy }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const enabled = group.enabled !== false;
  const keywords = group.keywords || [];
  const kwCount = group.keyword_count ?? keywords.length;
  const label = group.category ? `${group.category} - ${group.name}` : group.name;

  return (
    <div className={`seo-group-row ${open ? 'open' : ''}`}>
      <div className="seo-group-head" onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-toggle cat-chevron">▼</span>
        <span className={`cat-dot ${enabled ? 'on' : 'off'}`} />
        <span className="seo-group-name">{label}</span>
        {!keywords.length && kwCount > 0 && (
          <span className="count-pill">{kwCount} kw</span>
        )}
        <div className="tsec-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-secondary btn-sm"
            title="Open the SEOs library to edit this group's keywords"
            onClick={() => navigate('/seos')}
          >
            <Icon name="pencil" size={13} style={{ marginRight: 5 }} />
            Edit in SEOs
          </button>
          <button className="btn btn-secondary btn-sm" onClick={onToggle} disabled={busy}>
            <Icon name="ban" size={13} style={{ marginRight: 5 }} />
            {enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            className="btn-icon btn-icon-danger"
            title="Detach group from this topic"
            onClick={onDetach}
            disabled={busy}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      {open && (
        <div className="seo-group-chips">
          {keywords.length > 0 ? (
            keywords.map((kw, i) => (
              <span className="tag tag-readonly" key={`${kw}-${i}`}>{kw}</span>
            ))
          ) : (
            <span className="tsec-empty">
              {kwCount > 0
                ? `${kwCount} keyword${kwCount !== 1 ? 's' : ''} — manage them in the SEOs library`
                : 'No keywords in this group yet'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Attach modal (used by TopicBox "+ SEO Group") ──────────────────────────

export function AttachGroupModal({ attachedIds, onSubmit, onClose }) {
  const { data, isLoading } = useQuery({
    // Fast local-mirror read (group names + keyword counts only) — no external
    // platform call or re-sync, so the picker opens near-instantly.
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

  return (
    <div className="modal-overlay" style={{ display: 'flex' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-dialog" style={{ maxWidth: 540 }}>
        <div className="modal-header" style={{ padding: '18px 22px' }}>
          <h3 style={{ fontSize: 16, margin: 0 }}>Attach SEO Groups</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '12px 22px', maxHeight: '60vh', overflowY: 'auto' }}>
          {isLoading && <div className="text-muted">Loading library…</div>}
          {!isLoading && !hasAny && (
            <div className="text-muted">
              No SEO groups exist yet. Create some on the SEOs page first.
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
          <button className="btn btn-primary" onClick={() => onSubmit([...selected])}>
            Save ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
