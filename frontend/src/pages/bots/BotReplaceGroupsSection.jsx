/**
 * BotReplaceGroupsSection — Figma "Replace Groups" section on the bot's
 * Replace Terms tab:
 *
 *   ▾ 🔍 Replace Groups                                [+ Replace Group]
 *     ▾ ● SEO Category - Replace Group 1  [✏ Edit in SEOs] [⊘ Disable] [🗑]
 *        From          | To
 *        iran          | leb
 *        example text  | replacement text
 *     ▸ ● SEO Category - Replace Group 2  …
 *
 * Attached groups come from the bot config (`bot.replace_groups` — id/name/
 * enabled only); each expanded row lazily reads the group's From→To pairs
 * from the full replace library (shared react-query cache).
 *
 * Backend:
 *   POST /api/seo/bot/replace-groups/set   { bot_name, group_ids }  (attach/detach)
 *   POST /api/seo/replace-group/toggle     { id, enabled }          (disable/enable)
 *   GET  /api/seo/replace-library          (pairs for expanded rows)
 *   GET  /api/seo/replace-library/mirror   (fast picker)
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import Icon from '../../components/icons';

export default function BotReplaceGroupsSection({ botName, bot, search = '' }) {
  const attached = bot.replace_groups || [];
  const attachedIds = attached.map((g) => g.id);
  const [open, setOpen] = useState(true);
  const [pickOpen, setPickOpen] = useState(false);

  const save = useApiMutation('/api/seo/bot/replace-groups/set', {
    invalidate: ['config'],
    successMsg: 'Replace groups updated',
    errorMsg: 'Failed to update replace groups'
  });

  const toggleGroup = useApiMutation('/api/seo/replace-group/toggle', {
    invalidate: ['config', 'seo-replace-library', 'seo-replace-library-mirror'],
    successMsg: (res, vars) => `Group ${vars.enabled ? 'enabled' : 'disabled'}`,
    errorMsg: 'Failed to update group'
  });

  function setGroups(group_ids) {
    save.mutate({ bot_name: botName, group_ids });
  }

  const q = search.trim().toLowerCase();
  const visible = q
    ? attached.filter((g) => (g.name || '').toLowerCase().includes(q))
    : attached;

  return (
    <div className={`tsec ${open ? 'open' : ''}`}>
      <div className="tsec-head" onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-toggle cat-chevron">▼</span>
        <span className="tsec-icon"><Icon name="seo" size={16} /></span>
        <span className="tsec-title">Replace Groups</span>
        <div className="tsec-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-primary btn-sm" onClick={() => setPickOpen(true)} disabled={save.isPending}>
            <Icon name="plus" size={13} style={{ marginRight: 5 }} />
            Replace Group
          </button>
        </div>
      </div>

      {open && (
        <div className="tsec-body">
          {visible.length === 0 && (
            <p className="tsec-empty">
              {attached.length === 0
                ? 'No replace groups attached — click "+ Replace Group".'
                : 'No groups match your search.'}
            </p>
          )}
          {visible.map((g) => (
            <ReplaceGroupRow
              key={g.id}
              group={g}
              onDetach={() => setGroups(attachedIds.filter((id) => id !== g.id))}
              onToggle={() => toggleGroup.mutate({ id: g.id, enabled: g.enabled === false })}
              busy={save.isPending || toggleGroup.isPending}
            />
          ))}
        </div>
      )}

      {pickOpen && (
        <AttachReplaceGroupModal
          attachedIds={attachedIds}
          onSubmit={(ids) => { setGroups(ids); setPickOpen(false); }}
          onClose={() => setPickOpen(false)}
        />
      )}
    </div>
  );
}

function ReplaceGroupRow({ group, onDetach, onToggle, busy }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const enabled = group.enabled !== false;

  // Pairs aren't in the bot config — read them from the full replace library
  // (one shared fetch for every expanded row on the page).
  const { data, isLoading } = useQuery({
    queryKey: ['seo-replace-library'],
    queryFn: () => api('/api/seo/replace-library'),
    staleTime: 60_000,
    enabled: open
  });

  const { pairs, catName } = useMemo(() => {
    const cats = data?.status === 'ok' ? data.categories || [] : [];
    for (const c of cats) {
      for (const g of c.groups || []) {
        if (g.id === group.id) return { pairs: g.pairs || [], catName: c.name };
      }
    }
    return { pairs: null, catName: null };
  }, [data, group.id]);

  const label = catName ? `${catName} - ${group.name}` : group.name;

  return (
    <div className={`seo-group-row ${open ? 'open' : ''}`}>
      <div className="seo-group-head" onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-toggle cat-chevron">▼</span>
        <span className={`cat-dot ${enabled ? 'on' : 'off'}`} />
        <span className="seo-group-name">{label}</span>
        <div className="tsec-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-secondary btn-sm"
            title="Open the SEOs library (Replace Terms Groups) to edit this group's pairs"
            onClick={() => navigate('/seos?tab=replace')}
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
            title="Detach group from this bot"
            onClick={onDetach}
            disabled={busy}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      {open && (
        <div className="rt-table-wrap">
          <div className="rt-head">
            <span>From</span>
            <span>To</span>
          </div>
          {isLoading && <p className="tsec-empty" style={{ padding: '10px 14px' }}>Loading pairs…</p>}
          {!isLoading && pairs && pairs.length === 0 && (
            <p className="tsec-empty" style={{ padding: '10px 14px' }}>No pairs in this group yet.</p>
          )}
          {!isLoading && pairs == null && (
            <p className="tsec-empty" style={{ padding: '10px 14px' }}>
              Pairs unavailable — open the SEOs library to view this group.
            </p>
          )}
          {(pairs || []).map((p, i) => (
            <div className="rt-row rt-row-plain" key={i} style={p.enabled === false ? { opacity: 0.5 } : undefined}>
              <span>{p.from ?? p.match ?? ''}</span>
              <span>{p.to ?? p.replace_with ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AttachReplaceGroupModal({ attachedIds, onSubmit, onClose }) {
  const { data, isLoading } = useQuery({
    // Fast local-mirror read (group names + pair counts only) — no external
    // platform call or re-sync, so the picker opens near-instantly.
    queryKey: ['seo-replace-library-mirror'],
    queryFn: () => api('/api/seo/replace-library/mirror'),
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
          <h3 style={{ fontSize: 16, margin: 0 }}>Attach Replace Groups</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '12px 22px', maxHeight: '60vh', overflowY: 'auto' }}>
          {isLoading && <div className="text-muted">Loading library…</div>}
          {!isLoading && !hasAny && (
            <div className="text-muted">
              No replace groups exist yet. Create some on the SEOs page (Replace Terms Groups tab) first.
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
                          ({(() => { const n = g.pair_count ?? g.pairs?.length ?? 0; return `${n} pair${n !== 1 ? 's' : ''}`; })()}{g.enabled === false ? ', disabled' : ''})
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
