/**
 * SEOs — unified SEO keyword library for all summaries.
 *
 * ⚠️ FRONTEND-ONLY (no backend yet).
 * This page is a self-contained UI prototype. All data lives in the in-memory
 * `seoApi` store below, seeded with mock rows. It is intentionally written so
 * the backend can be plugged in later WITHOUT touching this component:
 *
 *   → When the real (cross-platform) SEO API arrives, replace the body of each
 *     `seoApi.*` method with an `api('/api/seos/...')` call. The method
 *     signatures and return shapes already match a typical REST contract:
 *
 *       seoApi.list()                       GET    /api/seos
 *       seoApi.create(seo)                  POST   /api/seos
 *       seoApi.bulkCreate(keywords[])       POST   /api/seos/bulk
 *       seoApi.update(id, patch)            PATCH  /api/seos/:id
 *       seoApi.remove(id)                   DELETE /api/seos/:id
 *       seoApi.bulkRemove(ids[])            POST   /api/seos/bulk-delete
 *
 *   The component never touches the store directly — it only calls seoApi.
 *
 * An SEO record:
 *   { id, keyword, group, language, status, notes, updated_at }
 */

import { useEffect, useMemo, useState } from 'react';
import { useDialogs } from '../dialogs/DialogsProvider';
import { useUrlString } from '../lib/useUrlState';
import PageHeader from '../components/PageHeader';

// ───────────────────────────────────────────────────────────────────────────
// Data layer — swap the bodies for real API calls when the backend is ready.
// ───────────────────────────────────────────────────────────────────────────

const LANGUAGES = [
  { value: '', label: 'Any' },
  { value: 'ar', label: 'Arabic' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' }
];

function nowIso() {
  return new Date().toISOString();
}

// Mock seed data — represents SEO keywords shared across all summaries bots.
let _store = [
  { id: 's1', keyword: 'الذكاء الاصطناعي', group: 'Technology', language: 'ar', status: 'active', notes: 'High-priority trending term', updated_at: nowIso() },
  { id: 's2', keyword: 'artificial intelligence', group: 'Technology', language: 'en', status: 'active', notes: '', updated_at: nowIso() },
  { id: 's3', keyword: 'الاقتصاد العالمي', group: 'Economy', language: 'ar', status: 'active', notes: '', updated_at: nowIso() },
  { id: 's4', keyword: 'stock market', group: 'Economy', language: 'en', status: 'paused', notes: 'Paused — too noisy', updated_at: nowIso() },
  { id: 's5', keyword: 'كرة القدم', group: 'Sports', language: 'ar', status: 'active', notes: '', updated_at: nowIso() },
  { id: 's6', keyword: 'climate change', group: 'Environment', language: 'en', status: 'active', notes: '', updated_at: nowIso() }
];

let _seq = 100;
const newId = () => `s${++_seq}`;
// Simulate network latency so loading/empty states are exercised realistically.
const delay = (ms = 220) => new Promise((r) => setTimeout(r, ms));

const seoApi = {
  // GET /api/seos
  async list() {
    await delay();
    return _store.map((s) => ({ ...s }));
  },

  // POST /api/seos
  async create(seo) {
    await delay();
    const row = {
      id: newId(),
      keyword: seo.keyword.trim(),
      group: (seo.group || '').trim(),
      language: seo.language || '',
      status: seo.status || 'active',
      notes: (seo.notes || '').trim(),
      updated_at: nowIso()
    };
    _store = [row, ..._store];
    return row;
  },

  // POST /api/seos/bulk — returns { inserted, skipped }
  async bulkCreate(keywords, shared = {}) {
    await delay();
    const existing = new Set(_store.map((s) => s.keyword.toLowerCase()));
    let inserted = 0;
    let skipped = 0;
    for (const raw of keywords) {
      const keyword = raw.trim();
      if (!keyword) continue;
      if (existing.has(keyword.toLowerCase())) {
        skipped++;
        continue;
      }
      existing.add(keyword.toLowerCase());
      _store = [
        {
          id: newId(),
          keyword,
          group: (shared.group || '').trim(),
          language: shared.language || '',
          status: 'active',
          notes: '',
          updated_at: nowIso()
        },
        ..._store
      ];
      inserted++;
    }
    return { inserted, skipped };
  },

  // PATCH /api/seos/:id
  async update(id, patch) {
    await delay();
    _store = _store.map((s) =>
      s.id === id ? { ...s, ...patch, updated_at: nowIso() } : s
    );
    return _store.find((s) => s.id === id);
  },

  // DELETE /api/seos/:id
  async remove(id) {
    await delay();
    _store = _store.filter((s) => s.id !== id);
    return { ok: true };
  },

  // POST /api/seos/bulk-delete
  async bulkRemove(ids) {
    await delay();
    const set = new Set(ids);
    _store = _store.filter((s) => !set.has(s.id));
    return { deleted: ids.length };
  }
};

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export default function SeosPage() {
  const { showNotification, showConfirm } = useDialogs();

  const [seos, setSeos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [search, setSearch] = useUrlString('q', '');
  const [groupFilter, setGroupFilter] = useUrlString('group', '');
  const [langFilter, setLangFilter] = useUrlString('lang', '');
  const [statusFilter, setStatusFilter] = useUrlString('status', '');

  const [selected, setSelected] = useState(new Set());
  const [modal, setModal] = useState(null); // null | {mode:'add'} | {mode:'edit',seo} | {mode:'bulk'}

  // Initial load.
  useEffect(() => {
    let alive = true;
    seoApi.list().then((rows) => {
      if (!alive) return;
      setSeos(rows);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function reload() {
    setSeos(await seoApi.list());
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const groups = useMemo(
    () => [...new Set(seos.map((s) => s.group).filter(Boolean))].sort(),
    [seos]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return seos.filter((s) => {
      if (q && !s.keyword.toLowerCase().includes(q) && !s.notes.toLowerCase().includes(q))
        return false;
      if (groupFilter && s.group !== groupFilter) return false;
      if (langFilter && s.language !== langFilter) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      return true;
    });
  }, [seos, search, groupFilter, langFilter, statusFilter]);

  const stats = useMemo(
    () => ({
      total: seos.length,
      active: seos.filter((s) => s.status === 'active').length,
      paused: seos.filter((s) => s.status === 'paused').length
    }),
    [seos]
  );

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selected.has(s.id));

  // ── Mutations ─────────────────────────────────────────────────────────────
  async function handleSave(form) {
    setBusy(true);
    try {
      if (modal?.mode === 'edit') {
        await seoApi.update(modal.seo.id, form);
        showNotification('SEO updated', 'success');
      } else {
        await seoApi.create(form);
        showNotification('SEO added', 'success');
      }
      await reload();
      setModal(null);
    } catch {
      showNotification('Failed to save SEO', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkAdd(keywords, shared) {
    setBusy(true);
    try {
      const { inserted, skipped } = await seoApi.bulkCreate(keywords, shared);
      await reload();
      setModal(null);
      showNotification(
        `${inserted} added · ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped`,
        inserted ? 'success' : 'error'
      );
    } catch {
      showNotification('Failed to add SEOs', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(seo) {
    const next = seo.status === 'active' ? 'paused' : 'active';
    await seoApi.update(seo.id, { status: next });
    await reload();
  }

  function deleteOne(seo) {
    showConfirm(
      `Delete the SEO "${seo.keyword}"?`,
      async () => {
        await seoApi.remove(seo.id);
        setSelected((cur) => {
          const n = new Set(cur);
          n.delete(seo.id);
          return n;
        });
        await reload();
        showNotification('SEO deleted', 'success');
      },
      { title: 'Delete SEO', confirmLabel: 'Delete', confirmClass: 'btn-danger' }
    );
  }

  function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    showConfirm(
      `Delete ${ids.length} selected SEO${ids.length === 1 ? '' : 's'}?`,
      async () => {
        await seoApi.bulkRemove(ids);
        setSelected(new Set());
        await reload();
        showNotification(`${ids.length} SEOs deleted`, 'success');
      },
      { title: 'Delete SEOs', confirmLabel: 'Delete', confirmClass: 'btn-danger' }
    );
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  function toggleSelect(id) {
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleSelectAll() {
    setSelected((cur) => {
      if (allFilteredSelected) {
        const n = new Set(cur);
        filtered.forEach((s) => n.delete(s.id));
        return n;
      }
      const n = new Set(cur);
      filtered.forEach((s) => n.add(s.id));
      return n;
    });
  }

  function clearFilters() {
    setSearch('');
    setGroupFilter('');
    setLangFilter('');
    setStatusFilter('');
  }

  const hasFilters = search || groupFilter || langFilter || statusFilter;

  return (
    <div className="page active">
      <PageHeader
        title="SEOs"
        subtitle="Unified SEO keyword library shared across all summaries"
      >
        <input
          type="text"
          className="input"
          placeholder="Search keywords…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 200 }}
        />
        {selected.size > 0 && (
          <button className="btn btn-danger" onClick={deleteSelected}>
            🗑 Delete Selected ({selected.size})
          </button>
        )}
        <button className="btn btn-secondary" onClick={() => setModal({ mode: 'bulk' })}>
          ➕ Bulk Add
        </button>
        <button className="btn btn-primary" onClick={() => setModal({ mode: 'add' })}>
          ➕ Add SEO
        </button>
      </PageHeader>

      {/* Frontend-only notice — remove once the backend API is wired in. */}
      <div
        className="card"
        style={{
          marginBottom: 16,
          padding: '10px 14px',
          borderLeft: '3px solid var(--accent-primary)',
          fontSize: 13,
          color: 'var(--text-secondary)'
        }}
      >
        ℹ️ This page is a UI prototype — data is stored in the browser only and
        resets on reload. It will be connected to the shared cross-platform SEO
        API later.
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatBox label="Total SEOs" value={stats.total} />
        <StatBox label="Active" value={stats.active} />
        <StatBox label="Paused" value={stats.paused} />
      </div>

      {/* Filters */}
      <div
        className="card"
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          marginBottom: 16,
          padding: '12px 16px'
        }}
      >
        <FilterSelect
          label="Group"
          value={groupFilter}
          onChange={setGroupFilter}
          options={[{ value: '', label: 'All groups' }, ...groups.map((g) => ({ value: g, label: g }))]}
        />
        <FilterSelect
          label="Language"
          value={langFilter}
          onChange={setLangFilter}
          options={[{ value: '', label: 'All languages' }, ...LANGUAGES.filter((l) => l.value)]}
        />
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: '', label: 'All statuses' },
            { value: 'active', label: 'Active' },
            { value: 'paused', label: 'Paused' }
          ]}
        />
        {hasFilters && (
          <button className="btn btn-secondary btn-sm" onClick={clearFilters}>
            ✕ Clear filters
          </button>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 13 }}>
          Showing {filtered.length} of {seos.length}
        </span>
      </div>

      {/* Table */}
      {loading ? (
        <p className="mon-empty">Loading…</p>
      ) : seos.length === 0 ? (
        <p className="mon-empty">No SEOs yet — click "Add SEO" to create one.</p>
      ) : filtered.length === 0 ? (
        <p className="mon-empty">No SEOs match the current filters.</p>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="yt-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    style={{ cursor: 'pointer' }}
                  />
                </th>
                <th>Keyword</th>
                <th>Group</th>
                <th>Language</th>
                <th>Status</th>
                <th>Notes</th>
                <th>Updated</th>
                <th style={{ width: 110 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggleSelect(s.id)}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ fontWeight: 600 }}>{s.keyword}</td>
                  <td>{s.group ? <span className="tag">{s.group}</span> : <span className="text-muted">—</span>}</td>
                  <td>{langLabel(s.language)}</td>
                  <td>
                    <button
                      className={`yt-status-badge ${
                        s.status === 'active' ? 'yt-status-active' : 'yt-status-inactive'
                      }`}
                      style={{ cursor: 'pointer', border: 'none' }}
                      onClick={() => toggleStatus(s)}
                      title="Click to toggle"
                    >
                      {s.status === 'active' ? 'Active' : 'Paused'}
                    </button>
                  </td>
                  <td style={{ color: 'var(--text-secondary)', maxWidth: 240 }}>
                    {s.notes || <span className="text-muted">—</span>}
                  </td>
                  <td className="text-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {fmtDate(s.updated_at)}
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setModal({ mode: 'edit', seo: s })}
                    >
                      ✏️
                    </button>{' '}
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => deleteOne(s)}
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal?.mode === 'bulk' && (
        <BulkAddModal busy={busy} onSubmit={handleBulkAdd} onClose={() => setModal(null)} />
      )}
      {(modal?.mode === 'add' || modal?.mode === 'edit') && (
        <SeoModal
          mode={modal.mode}
          seo={modal.seo}
          groups={groups}
          busy={busy}
          onSubmit={handleSave}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────────────────

function StatBox({ label, value }) {
  return (
    <div className="card" style={{ padding: '12px 18px', minWidth: 120 }}>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div className="text-muted" style={{ fontSize: 12 }}>{label}</div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label className="input-label" style={{ margin: 0 }}>{label}</label>
      <select
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ minWidth: 150 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function SeoModal({ mode, seo, groups, busy, onSubmit, onClose }) {
  const isEdit = mode === 'edit';
  const { showNotification } = useDialogs();
  const [form, setForm] = useState(() => ({
    keyword: seo?.keyword || '',
    group: seo?.group || '',
    language: seo?.language || '',
    status: seo?.status || 'active',
    notes: seo?.notes || ''
  }));
  const setF = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  function submit() {
    if (!form.keyword.trim()) {
      showNotification('Keyword is required.', 'error');
      return;
    }
    onSubmit({ ...form, keyword: form.keyword.trim() });
  }

  return (
    <div className="dialog-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog-box" style={{ maxWidth: 460 }}>
        <div className="dialog-title">{isEdit ? 'Edit SEO' : 'Add SEO'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
          <div>
            <label className="input-label">Keyword *</label>
            <input
              type="text"
              className="input"
              value={form.keyword}
              onChange={(e) => setF('keyword', e.target.value)}
              placeholder="SEO keyword or phrase"
              autoFocus
            />
          </div>
          <div>
            <label className="input-label">Group</label>
            <input
              type="text"
              className="input"
              list="seo-groups"
              value={form.group}
              onChange={(e) => setF('group', e.target.value)}
              placeholder="e.g. Technology (optional)"
            />
            <datalist id="seo-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="input-label">Language</label>
              <select
                className="select"
                value={form.language}
                onChange={(e) => setF('language', e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="input-label">Status</label>
              <select
                className="select"
                value={form.status}
                onChange={(e) => setF('status', e.target.value)}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </select>
            </div>
          </div>
          <div>
            <label className="input-label">Notes</label>
            <textarea
              className="input"
              rows={2}
              value={form.notes}
              onChange={(e) => setF('notes', e.target.value)}
              placeholder="Optional notes"
            />
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkAddModal({ busy, onSubmit, onClose }) {
  const { showNotification } = useDialogs();
  const [text, setText] = useState('');
  const [group, setGroup] = useState('');
  const [language, setLanguage] = useState('');

  const lines = useMemo(
    () => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))],
    [text]
  );

  function submit() {
    if (!lines.length) {
      showNotification('Enter at least one keyword.', 'error');
      return;
    }
    onSubmit(lines, { group, language });
  }

  return (
    <div className="dialog-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog-box" style={{ maxWidth: 460 }}>
        <div className="dialog-title">Bulk Add SEOs</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
          <div>
            <label className="input-label">
              Keywords <span className="text-muted">(one per line — duplicates skipped)</span>
            </label>
            <textarea
              className="input"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'keyword one\nkeyword two\nkeyword three'}
              autoFocus
            />
            <small className="text-muted">{lines.length} unique keyword(s)</small>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="input-label">Group (applied to all)</label>
              <input
                type="text"
                className="input"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="input-label">Language (applied to all)</label>
              <select
                className="select"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Adding…' : `Add ${lines.length || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function langLabel(code) {
  const l = LANGUAGES.find((x) => x.value === code);
  return l && l.value ? l.label : '—';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
