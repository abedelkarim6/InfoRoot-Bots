/**
 * Sources Collections — Phase 3 / Wave 2 port.
 *
 * Mirrors the legacy `static/js/pages/collections.js` page:
 *   - Channel Membership Validator card (.ch-val-card) at the top, collapsible
 *   - Collection cards with enable/disable toggle, edit, delete (soft delete)
 *   - Add / Edit modal with channel tag inputs and a "Browse joined" picker
 *
 * State conventions:
 *   - Collections data lives in the global `['config']` query (config.collections).
 *     Mutations invalidate ['config'] so the sidebar badges + bots page refresh.
 *   - Joined-channels list (for the validator + picker) is its own query so it
 *     can be refetched independently of config.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, fmtLBN } from '../lib/api';
import { useApiMutation, useConfirmedMutation } from '../lib/useApiMutation';
import { useDialogs } from '../dialogs/DialogsProvider';
import { useGlobalConfig } from '../config/ConfigProvider';
import PageHeader from '../components/PageHeader';

export default function CollectionsPage() {
  const { config } = useGlobalConfig();
  const collections = config?.collections || {};

  const [modalState, setModalState] = useState(null); // { mode: 'add' | 'edit', existingName?: string }

  return (
    <div className="page active">
      <PageHeader title="Collections" subtitle="Manage channel collections">
        <button className="btn btn-primary" onClick={() => setModalState({ mode: 'add' })}>
          <span>➕</span> Add Collection
        </button>
      </PageHeader>

      <ChannelValidatorCard collections={collections} />

      <div id="collections-container">
        {Object.keys(collections).length === 0 ? (
          <div className="create-bot-card">
            <h3>No collections yet</h3>
            <p className="text-muted">Create a collection to group source and target channels</p>
            <button className="btn btn-primary mt-2" onClick={() => setModalState({ mode: 'add' })}>
              <span>➕</span> Create First Collection
            </button>
          </div>
        ) : (
          Object.entries(collections).map(([name, coll]) => (
            <CollectionCard
              key={name}
              name={name}
              collection={coll}
              onEdit={() => setModalState({ mode: 'edit', existingName: name })}
            />
          ))
        )}
      </div>

      {modalState && (
        <CollectionModal
          mode={modalState.mode}
          existingName={modalState.existingName}
          collections={collections}
          onClose={() => setModalState(null)}
        />
      )}
    </div>
  );
}

// ─── Collection Card ────────────────────────────────────────────────────────

function CollectionCard({ name, collection, onEdit }) {
  const toggle = useApiMutation('/api/collection/toggle', {
    invalidate: ['config'],
    successMsg: 'Collection updated',
    errorMsg: 'Failed to update collection'
  });

  const remove = useApiMutation('/api/collection/delete', {
    invalidate: ['config', 'recycle-bin'],
    successMsg: 'Collection deleted',
    errorMsg: 'Failed to delete collection'
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete collection "${name}"?`,
    title: 'Delete Collection',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  const sources = (collection.source_channels || []).join(', ') || 'None';
  const targets =
    (collection.target_channels || (collection.target_channel ? [collection.target_channel] : []))
      .filter(Boolean)
      .join(', ') || 'Not set';

  return (
    <div className="collection-card">
      <div className="collection-header">
        <div className="flex-center">
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={!!collection.enabled}
              disabled={toggle.isPending}
              onChange={(e) =>
                toggle.mutate({ collection_name: name, enabled: e.target.checked })
              }
            />
            <span className="toggle-slider"></span>
          </label>
          <h3>{name}</h3>
        </div>
        <div className="collection-actions">
          <button className="btn btn-secondary btn-sm" onClick={onEdit}>
            ✏️ Edit
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={() => confirmDelete({ collection_name: name })}
            disabled={remove.isPending}
          >
            🗑️ Delete
          </button>
        </div>
      </div>
      <div className="collection-body">
        <div className="collection-info">
          <div className="info-row">
            <span className="info-label">📥 Sources:</span>
            <span className="info-value">{sources}</span>
          </div>
          <div className="info-row">
            <span className="info-label">📤 Targets:</span>
            <span className="info-value">{targets}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Channel Membership Validator ───────────────────────────────────────────

function ChannelValidatorCard({ collections }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function runValidate(e) {
    if (e) e.stopPropagation();
    if (!open) setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const res = await api('/api/telegram/admin_channels');
      if (!res || res.status === 'error') {
        setError(res?.message || 'Failed to load');
        setData(null);
      } else {
        setData(res);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ch-val-card">
      <div
        className="ch-val-header"
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: 'pointer' }}
      >
        <div className="ch-val-title">
          <span className="ch-val-toggle-icon">{open ? '▼' : '▶'}</span>
          <h3>📡 Channel Membership Validator</h3>
          <span
            className="text-muted"
            style={{ fontSize: '0.8rem', marginLeft: 8 }}
          >
            Verify which channels the userbot has joined
          </span>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={runValidate}
          disabled={loading}
          style={{ whiteSpace: 'nowrap' }}
        >
          {loading ? '⏳ Loading…' : '🔍 Validate'}
        </button>
      </div>
      {open && (
        <div className="ch-val-body" style={{ display: 'block' }}>
          {loading && <p className="mon-empty">Loading cached channel data…</p>}
          {!loading && error && (
            <p className="mon-empty" style={{ color: '#ef4444' }}>
              Error: {error}
            </p>
          )}
          {!loading && !error && !data && (
            <p className="mon-empty">Click "Validate" to check channel membership.</p>
          )}
          {!loading && !error && data && (
            <ValidatorBody data={data} collections={collections} />
          )}
        </div>
      )}
    </div>
  );
}

function ValidatorBody({ data, collections }) {
  const joined = useMemo(() => {
    const map = {};
    (data.channels || []).forEach((ch) => {
      if (ch.username) map[ch.username.toLowerCase()] = ch;
      map['id:' + ch.id] = ch;
    });
    return map;
  }, [data]);

  function resolveJoined(raw) {
    const stripped = raw.replace(/^@/, '').trim();
    if (/^-?\d+$/.test(stripped)) {
      const num = parseInt(stripped, 10);
      if (num < 0) {
        const s = String(-num);
        const entityId = s.startsWith('100') ? parseInt(s.slice(3), 10) : -num;
        return joined['id:' + entityId] || null;
      }
      return joined['id:' + num] || null;
    }
    return joined[stripped.toLowerCase()] || null;
  }

  const allConfiguredKeys = new Set();
  let totalConfigured = 0;
  let totalJoined = 0;

  const collEntries = Object.entries(collections || {});
  const sections = collEntries.map(([collName, coll]) => {
    const channelMap = {};
    const addCh = (raw, role) => {
      const key = raw.replace(/^@/, '').trim().toLowerCase();
      allConfiguredKeys.add(key);
      if (!channelMap[key]) channelMap[key] = { raw, roles: [], ch: resolveJoined(raw) };
      if (!channelMap[key].roles.includes(role)) channelMap[key].roles.push(role);
    };
    (coll.source_channels || []).forEach((ch) => addCh(ch, 'source'));
    const targets = coll.target_channels || (coll.target_channel ? [coll.target_channel] : []);
    targets.forEach((ch) => addCh(ch, 'target'));

    const rows = Object.values(channelMap).map(({ raw, roles, ch }, i) => {
      const isJoined = !!ch;
      const isNumeric = /^-?\d+$/.test(raw.replace(/^@/, '').trim());
      totalConfigured++;
      if (isJoined) totalJoined++;
      const displayName = ch?.username ? `@${ch.username}` : raw;
      return (
        <div className="ch-val-row" key={`${collName}-${raw}-${i}`}>
          <div className="ch-val-name">
            <span className="ch-val-at">{displayName}</span>
            {ch?.title && <span className="ch-val-title-text">{ch.title}</span>}
          </div>
          <div className="ch-val-meta">
            {roles.map((r) =>
              r === 'source' ? (
                <span className="ch-val-role source" key="src">📥 Reads from</span>
              ) : (
                <span className="ch-val-role target" key="tgt">📤 Posts to</span>
              )
            )}
            {isJoined ? (
              <span className="ch-val-badge ok">✓ Joined</span>
            ) : isNumeric ? (
              <span className="ch-val-badge warn">⚠ Not found (numeric ID)</span>
            ) : (
              <span className="ch-val-badge warn">✗ Not Joined</span>
            )}
          </div>
        </div>
      );
    });

    return (
      <div className="ch-val-collection" key={collName}>
        <div className="ch-val-collection-name">📁 {collName}</div>
        {rows.length > 0 ? (
          rows
        ) : (
          <p className="mon-empty" style={{ padding: '4px 0' }}>
            No channels configured
          </p>
        )}
      </div>
    );
  });

  const extraChannels = (data.channels || []).filter(
    (ch) => ch.username && !allConfiguredKeys.has(ch.username.toLowerCase())
  );

  const summaryClass = totalJoined < totalConfigured ? 'ch-val-sum-warn' : 'ch-val-sum-ok';
  const updatedAt = data.updated_at ? fmtLBN(data.updated_at) : null;

  return (
    <>
      <div className={`ch-val-summary ${summaryClass}`}>
        <span>
          {totalJoined === totalConfigured
            ? `✅ All ${totalConfigured} configured channels joined`
            : `⚠️ ${totalJoined} of ${totalConfigured} configured channels joined`}
        </span>
        {updatedAt && <span className="ch-val-updated">cached {updatedAt}</span>}
      </div>
      <div className="ch-val-section">
        <div className="ch-val-section-title">Configured channels</div>
        {sections.length > 0 ? sections : <p className="mon-empty">No collections configured yet.</p>}
      </div>
      <div className="ch-val-section">
        <div className="ch-val-section-title">
          Other joined channels <span className="ch-val-count">{extraChannels.length}</span>
        </div>
        {extraChannels.length > 0 ? (
          extraChannels.map((ch) => (
            <div className="ch-val-row extra" key={ch.id}>
              <div className="ch-val-name">
                <span className="ch-val-at">@{ch.username}</span>
                <span className="ch-val-title-text">{ch.title}</span>
              </div>
              <div className="ch-val-meta">
                {ch.is_broadcast ? (
                  <span className="ch-val-role channel">Channel</span>
                ) : (
                  <span className="ch-val-role group">Group</span>
                )}
                <span className="ch-val-badge info">Not in Config</span>
              </div>
            </div>
          ))
        ) : (
          <p className="mon-empty" style={{ padding: '8px 0' }}>None</p>
        )}
      </div>
    </>
  );
}

// ─── Add / Edit Collection Modal ────────────────────────────────────────────

function CollectionModal({ mode, existingName, collections, onClose }) {
  const qc = useQueryClient();
  const { showAlert, showNotification } = useDialogs();
  const existing = mode === 'edit' && existingName ? collections[existingName] : null;

  const [name, setName] = useState(existingName || '');
  const [sources, setSources] = useState(() =>
    existing ? [...(existing.source_channels || [])] : []
  );
  const [targets, setTargets] = useState(() =>
    existing
      ? [...(existing.target_channels || (existing.target_channel ? [existing.target_channel] : []))]
      : []
  );
  // map: channel string → 'pending' | 'ok' | 'warn'
  const [validation, setValidation] = useState({});
  const [saving, setSaving] = useState(false);

  // Picker state — when set, dropdown is open
  const [pickerType, setPickerType] = useState(null); // 'source' | 'target' | null
  const [pickerAnchor, setPickerAnchor] = useState(null); // bounding rect
  const [pickerChannels, setPickerChannels] = useState([]);
  const [pickerQuery, setPickerQuery] = useState('');

  // Pre-validate any existing channels in the background, and preload picker list
  useEffect(() => {
    [...sources, ...targets].forEach((ch) => {
      const type = sources.includes(ch) ? 'source' : 'target';
      validateOne(ch, type);
    });
    api('/api/telegram/userbot/dialogs').then((res) => {
      if (res && res.status === 'ok') setPickerChannels(res.channels || []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function validateOne(ch, type) {
    setValidation((v) => ({ ...v, [ch]: 'pending' }));
    const res = await api('/api/telegram/check_channel', { channel: ch });
    setValidation((v) => ({ ...v, [ch]: res && res.joined ? 'ok' : 'warn' }));
  }

  function setArr(type, fn) {
    if (type === 'source') setSources(fn);
    else setTargets(fn);
  }

  function addTag(value, type) {
    const v = value.trim().replace(/,/g, '');
    if (!v) return;
    const arr = type === 'source' ? sources : targets;
    if (arr.includes(v)) return;
    setArr(type, (prev) => [...prev, v]);
    validateOne(v, type);
  }

  function removeTag(channel, type) {
    setArr(type, (prev) => prev.filter((c) => c !== channel));
    setValidation((v) => {
      const out = { ...v };
      delete out[channel];
      return out;
    });
  }

  function isInArr(arr, ch) {
    return arr.some((c) => {
      const s = c.replace(/^@/, '').toLowerCase();
      return (ch.username && s === ch.username.toLowerCase()) || s === String(ch.id);
    });
  }

  function togglePickerChannel(ch) {
    const arr = pickerType === 'source' ? sources : targets;
    const value = ch.username ? '@' + ch.username : String(ch.id);
    if (isInArr(arr, ch)) {
      // remove
      setArr(pickerType, (prev) =>
        prev.filter((c) => {
          const s = c.replace(/^@/, '').toLowerCase();
          return !((ch.username && s === ch.username.toLowerCase()) || s === String(ch.id));
        })
      );
      setValidation((v) => {
        const out = { ...v };
        for (const k of Object.keys(out)) {
          const s = k.replace(/^@/, '').toLowerCase();
          if ((ch.username && s === ch.username.toLowerCase()) || s === String(ch.id)) delete out[k];
        }
        return out;
      });
    } else {
      setArr(pickerType, (prev) => [...prev, value]);
      validateOne(value, pickerType);
    }
  }

  function pickerChannelsForType(type) {
    return type === 'source' ? pickerChannels : pickerChannels.filter((ch) => ch.can_post);
  }

  function addAllFromPicker() {
    const all = pickerChannelsForType(pickerType);
    const q = (pickerQuery || '').toLowerCase();
    const filtered = q
      ? all.filter(
          (ch) =>
            ch.title.toLowerCase().includes(q) ||
            (ch.username && ch.username.toLowerCase().includes(q))
        )
      : all;
    const arr = pickerType === 'source' ? sources : targets;
    const toAdd = [];
    for (const ch of filtered) {
      if (!isInArr(arr, ch)) {
        const value = ch.username ? '@' + ch.username : String(ch.id);
        toAdd.push(value);
      }
    }
    if (toAdd.length === 0) return;
    setArr(pickerType, (prev) => [...prev, ...toAdd]);
    toAdd.forEach((v) => validateOne(v, pickerType));
  }

  async function onSave() {
    const newName = name.trim();
    const finalName = newName || existingName;

    const finalSources = [...new Set(sources)];
    const finalTargets = [...new Set(targets)];

    if (!finalName || !finalTargets.length) {
      showAlert('Collection name and at least one target channel are required', { icon: '⚠️' });
      return;
    }

    const allNames = Object.keys(collections || {});
    if (newName && newName !== existingName && allNames.includes(newName)) {
      showAlert(`A collection named "${newName}" already exists.`, { icon: '⚠️' });
      return;
    }

    setSaving(true);
    try {
      if (existingName && newName && newName !== existingName) {
        const r = await api('/api/collection/rename', {
          old_name: existingName,
          new_name: newName
        });
        if (r.status !== 'ok') {
          showAlert(r.message || 'Failed to rename collection', { icon: '⚠️' });
          return;
        }
      }
      const result = await api('/api/collection/save', {
        collection_name: finalName,
        source_channels: finalSources,
        target_channels: finalTargets,
        enabled: true
      });
      if (result.status === 'ok') {
        await qc.invalidateQueries({ queryKey: ['config'] });
        showNotification('Collection saved', 'success');
        onClose();
      } else {
        showNotification(result.message || 'Failed to save collection', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>{existing ? 'Edit Collection' : 'Add Collection'}</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Collection Name</label>
            <input
              type="text"
              className="input"
              placeholder="e.g., News Sources"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <ChannelTagField
            type="source"
            label="Source Channels"
            placeholder="+ @channel to read from"
            hint="Choose from joined channels or type @channel and press Enter."
            browseLabel="📋 Browse joined"
            tags={sources}
            validation={validation}
            onAdd={(v) => addTag(v, 'source')}
            onRemove={(v) => removeTag(v, 'source')}
            onBrowseClick={(rect) => {
              if (pickerType === 'source') {
                setPickerType(null);
              } else {
                setPickerType('source');
                setPickerAnchor(rect);
                setPickerQuery('');
              }
            }}
          />

          <ChannelTagField
            type="target"
            label="Target Channels"
            placeholder="+ @channel to post into"
            hint="Only channels where the userbot has write access are shown in Browse."
            browseLabel="📋 Browse writable"
            tags={targets}
            validation={validation}
            onAdd={(v) => addTag(v, 'target')}
            onRemove={(v) => removeTag(v, 'target')}
            onBrowseClick={(rect) => {
              if (pickerType === 'target') {
                setPickerType(null);
              } else {
                setPickerType('target');
                setPickerAnchor(rect);
                setPickerQuery('');
              }
            }}
          />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {pickerType && pickerAnchor && (
        <ChannelPicker
          type={pickerType}
          anchor={pickerAnchor}
          channels={pickerChannelsForType(pickerType)}
          currentArr={pickerType === 'source' ? sources : targets}
          query={pickerQuery}
          onQueryChange={setPickerQuery}
          onToggle={togglePickerChannel}
          onAddAll={addAllFromPicker}
          onClose={() => setPickerType(null)}
        />
      )}
    </div>
  );
}

// ─── Channel Tag Input ──────────────────────────────────────────────────────

function ChannelTagField({
  type,
  label,
  placeholder,
  hint,
  browseLabel,
  tags,
  validation,
  onAdd,
  onRemove,
  onBrowseClick
}) {
  const [draft, setDraft] = useState('');
  const browseRef = useRef(null);

  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = e.target.value.trim().replace(/,/g, '');
      if (v) {
        onAdd(v);
        setDraft('');
      }
    }
  }

  function onBlur(e) {
    const v = e.target.value.trim().replace(/,/g, '');
    if (v) {
      onAdd(v);
      setDraft('');
    }
  }

  return (
    <div className="form-group">
      <div className="form-label-row">
        <label className="form-label">{label}</label>
        <button
          ref={browseRef}
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onBrowseClick({
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height
            });
          }}
        >
          {browseLabel}
        </button>
      </div>
      <div className="tags-container" id={`${type}-tags`}>
        {tags.map((ch) => {
          const state = validation[ch];
          return (
            <span className="tag" key={ch}>
              {ch}
              {state === 'ok' && (
                <span className="tag-status ok" title="Userbot is a member ✓">✓</span>
              )}
              {state === 'warn' && (
                <span className="tag-status warn" title="Userbot is NOT a member">✗</span>
              )}
              {state === 'pending' && (
                <span className="tag-status pending" title="Checking…">⏳</span>
              )}{' '}
              <span className="tag-remove" onClick={() => onRemove(ch)}>
                ×
              </span>
            </span>
          );
        })}
        <input
          type="text"
          className="tag-input"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
      </div>
      <small className="form-hint">{hint}</small>
    </div>
  );
}

// ─── Channel Picker Dropdown ────────────────────────────────────────────────

function ChannelPicker({
  type,
  anchor,
  channels,
  currentArr,
  query,
  onQueryChange,
  onToggle,
  onAddAll,
  onClose
}) {
  const pickerRef = useRef(null);
  const searchRef = useRef(null);
  const [pos, setPos] = useState(() => ({
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - 318)),
    top: anchor.bottom + 6
  }));

  // Close on outside click
  useEffect(() => {
    function onDocClick(e) {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        onClose();
      }
    }
    const id = setTimeout(() => document.addEventListener('click', onDocClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('click', onDocClick);
    };
  }, [onClose]);

  // Auto-flip above if it overflows the viewport
  useEffect(() => {
    if (!pickerRef.current) return;
    const r = pickerRef.current.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 16) {
      setPos((p) => ({ ...p, top: anchor.top - r.height - 6 }));
    }
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = (query || '').toLowerCase();
  const filtered = q
    ? channels.filter(
        (ch) =>
          ch.title.toLowerCase().includes(q) ||
          (ch.username && ch.username.toLowerCase().includes(q))
      )
    : channels;

  function isSelected(ch) {
    return currentArr.some((c) => {
      const s = c.replace(/^@/, '').toLowerCase();
      return (ch.username && s === ch.username.toLowerCase()) || s === String(ch.id);
    });
  }

  const label = type === 'source' ? 'all readable' : 'all writable';

  return (
    <div
      ref={pickerRef}
      className="ch-picker"
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ch-picker-header">
        <input
          ref={searchRef}
          className="ch-picker-search"
          type="text"
          placeholder="Search channels…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>
      <div className="ch-picker-list">
        {filtered.length > 0 ? (
          filtered.map((ch) => {
            const selected = isSelected(ch);
            const display = ch.username ? '@' + ch.username : '#' + ch.id;
            const icon = ch.is_broadcast ? '📢' : '👥';
            return (
              <div
                key={ch.id}
                className={`ch-picker-item${selected ? ' selected' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(ch);
                }}
              >
                <div className="ch-picker-check">{selected ? '✓' : ''}</div>
                <div className="ch-picker-info">
                  <div className="ch-picker-title">{ch.title}</div>
                  <div className="ch-picker-sub">
                    {display} {icon}
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <p className="ch-picker-empty">
            No channels found.<br />Make sure the bot is running.
          </p>
        )}
      </div>
      <div className="ch-picker-footer">
        <span>
          {filtered.length} channel{filtered.length !== 1 ? 's' : ''}
        </span>
        <button className="btn btn-xs btn-secondary" onClick={onAddAll}>
          Add {label}
        </button>
      </div>
    </div>
  );
}
