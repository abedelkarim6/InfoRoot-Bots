/**
 * Per-bot Telegram Sources / Destinations modal.
 *
 * Replaces the legacy Collections page workflow. Each bot has its own
 * auto-collection (named after the bot). This modal edits one half of that
 * collection (`source_channels` or `target_channels`).
 *
 * Backend: POST /api/collection/save with the full collection payload. The
 * collection is created on first save if it doesn't exist.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';

// LocalStorage cache of channel-value → title. Lets the modal show friendly
// titles instantly on every open instead of flashing raw ids while the
// dialogs API roundtrips.
const TITLE_CACHE_KEY = 'tg-channel-titles';
function loadTitleCache() {
  try {
    return JSON.parse(localStorage.getItem(TITLE_CACHE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveTitleCache(map) {
  try {
    localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(map));
  } catch { /* ignore quota / disabled storage */ }
}
function ingestDialogsIntoCache(dialogs) {
  if (!Array.isArray(dialogs) || dialogs.length === 0) return loadTitleCache();
  const cache = loadTitleCache();
  for (const d of dialogs) {
    if (!d?.title) continue;
    if (d.username) cache['@' + d.username.toLowerCase()] = d.title;
    if (d.id != null) cache[String(d.id)] = d.title;
  }
  saveTitleCache(cache);
  return cache;
}

export default function BotChannelsModal({ botName, kind, bot, onClose }) {
  const isSource = kind === 'source';
  const title = isSource ? '📡 Telegram Sources' : '📤 Telegram Destinations';
  const subtitle = isSource
    ? 'Channels this bot will read messages from.'
    : 'Channels this bot will send summaries to.';

  // Resolve the bot's auto-collection name. We always use the bot's name as
  // the collection name. If a legacy bot has multiple collections, we union
  // their channels for display, then collapse on save.
  const collectionName = botName;
  const { showNotification } = useDialogs();

  // Hydrate channels from the bot's collection(s).
  const initial = useInitialChannels(bot, isSource);
  const [channels, setChannels] = useState(initial);

  // The OTHER axis — channels already used as the opposite kind in this same
  // bot. A channel can be a source OR a destination, never both. We use a
  // normalized Set for O(1) lookups (lowercase, leading-@ stripped).
  const otherChannels = useUnionFromBot(bot, !isSource);
  const blockedSet = new Set(otherChannels.map(normalizeChannel));
  function isBlocked(value) {
    return blockedSet.has(normalizeChannel(value));
  }
  function isBlockedDialog(d) {
    if (d.username && blockedSet.has(d.username.toLowerCase())) return true;
    if (d.id != null && blockedSet.has(String(d.id))) return true;
    return false;
  }
  const [tagInput, setTagInput] = useState('');
  const [validation, setValidation] = useState({}); // ch → 'ok'|'warn'|'pending'
  const [allDialogs, setAllDialogs] = useState([]); // browse picker source
  const [titleCache, setTitleCache] = useState(() => loadTitleCache());
  const [browseQuery, setBrowseQuery] = useState('');
  const [browseOpen, setBrowseOpen] = useState(false);
  const inputRef = useRef(null);

  // Pre-validate existing channels + preload the dialogs list for the picker.
  useEffect(() => {
    initial.forEach(validateOne);
    api('/api/telegram/userbot/dialogs').then((res) => {
      if (res?.status === 'ok') {
        const list = res.channels || [];
        setAllDialogs(list);
        // Update the localStorage cache so the next open shows titles
        // instantly without waiting for this API call.
        setTitleCache(ingestDialogsIntoCache(list));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function validateOne(ch) {
    setValidation((v) => ({ ...v, [ch]: 'pending' }));
    const res = await api('/api/telegram/check_channel', { channel: ch });
    setValidation((v) => ({ ...v, [ch]: res?.joined ? 'ok' : 'warn' }));
  }

  function addTag(raw) {
    const v = (raw || '').trim().replace(/,/g, '');
    if (!v) return;
    if (channels.includes(v)) return;
    if (isBlocked(v)) {
      const otherLabel = isSource ? 'destination' : 'source';
      showNotification(
        `"${titleFor(v)}" is already a ${otherLabel} for this bot. ` +
        `A channel can only be one or the other.`,
        'error'
      );
      return;
    }
    setChannels((prev) => [...prev, v]);
    validateOne(v);
  }

  function removeTag(ch) {
    setChannels((prev) => prev.filter((c) => c !== ch));
    setValidation((v) => {
      const out = { ...v };
      delete out[ch];
      return out;
    });
  }

  function isSelected(ch) {
    return channels.some((c) => {
      const s = c.replace(/^@/, '').toLowerCase();
      return (ch.username && s === ch.username.toLowerCase()) || s === String(ch.id);
    });
  }

  // Map a stored channel value (e.g. "@foo" or "12345") back to its friendly
  // title. Order: localStorage cache → freshly-loaded dialogs → raw value.
  // Caching ensures the title is shown instantly on re-open instead of
  // flashing raw ids while /api/telegram/userbot/dialogs roundtrips.
  function titleFor(value) {
    if (!value) return value;
    const v = String(value);
    const cacheKey = v.startsWith('@') ? v.toLowerCase() : v;
    if (titleCache[cacheKey]) return titleCache[cacheKey];

    const stripped = v.replace(/^@/, '').toLowerCase();
    const match = allDialogs.find((d) =>
      (d.username && d.username.toLowerCase() === stripped) || String(d.id) === stripped
    );
    return match?.title || value;
  }

  function togglePickerChannel(ch) {
    const value = ch.username ? '@' + ch.username : String(ch.id);
    if (isSelected(ch)) removeTag(value);
    else addTag(value);
  }

  function addAllVisible() {
    const list = filteredDialogs();
    let skipped = 0;
    list.forEach((ch) => {
      if (isSelected(ch)) return;
      if (isBlockedDialog(ch)) {
        skipped++;
        return;
      }
      const value = ch.username ? '@' + ch.username : String(ch.id);
      // Inline (skip the toast in addTag — we'll surface a single summary).
      setChannels((prev) => (prev.includes(value) ? prev : [...prev, value]));
      validateOne(value);
    });
    if (skipped > 0) {
      const otherLabel = isSource ? 'destinations' : 'sources';
      showNotification(
        `Skipped ${skipped} channel${skipped === 1 ? '' : 's'} already used as ${otherLabel}.`,
        'info'
      );
    }
  }

  function filteredDialogs() {
    const base = isSource ? allDialogs : allDialogs.filter((c) => c.can_post);
    const q = (browseQuery || '').toLowerCase();
    return q
      ? base.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            (c.username && c.username.toLowerCase().includes(q))
        )
      : base;
  }

  // Save: persist the full collection (sources + targets), then make sure
  // the bot's `collections` array references it.
  const saveCollection = useApiMutation('/api/collection/save', {
    invalidate: ['config'],
    successMsg: isSource ? 'Sources updated' : 'Destinations updated',
    errorMsg: 'Failed to save'
  });

  async function onSave() {
    // Build the full new collection payload — preserving the OTHER axis from
    // whatever the bot already has. Defensive: a channel can't be on both
    // axes, so drop anything in `channels` that's already in `otherValue`.
    const otherValue = useUnionFromBot(bot, !isSource);
    const otherSet = new Set(otherValue.map(normalizeChannel));
    const cleaned = channels.filter((c) => !otherSet.has(normalizeChannel(c)));

    const payload = {
      collection_name: collectionName,
      enabled: true,
      source_channels: isSource ? cleaned : otherValue,
      target_channels: isSource ? otherValue : cleaned
    };

    // Save the collection.
    const res = await new Promise((resolve) => {
      saveCollection.mutate(payload, { onSuccess: resolve, onError: resolve });
    });

    if (res?.status === 'error') return;

    // If the bot doesn't yet reference this collection, attach it.
    const currentCols = Array.isArray(bot?.collections) ? bot.collections : [];
    if (!currentCols.includes(collectionName)) {
      const updated = await api('/api/bot/save', {
        name: botName,
        enabled: !!bot.enabled,
        collections: [collectionName],
        minimum_messages: bot.minimum_messages ?? 5,
        rules: bot.rules || { remove: [], replace: [] },
        default_schedules: bot.default_schedules || [],
        categories: bot.categories || {}
      });
      if (updated?.status === 'error') {
        showNotification(updated.message || 'Failed to attach collection to bot', 'error');
        return;
      }
    }

    onClose();
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            <small style={{ color: 'var(--text-muted)', fontSize: 12 }}>{subtitle}</small>
          </div>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Channels ({channels.length})</span>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                style={{ marginLeft: 'auto' }}
                onClick={() => setBrowseOpen((o) => !o)}
              >
                {browseOpen ? '× Close browse' : '🔍 Browse channels'}
              </button>
            </label>

            <div
              className="ch-tags"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                padding: 10,
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                minHeight: 50,
                background: 'var(--bg-tertiary)'
              }}
            >
              {channels.map((ch) => (
                <span
                  key={ch}
                  className={`ch-tag ch-tag-${validation[ch] || 'pending'}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 4,
                    fontSize: 13
                  }}
                  title={
                    validation[ch] === 'ok'
                      ? `${ch} — userbot is joined`
                      : validation[ch] === 'warn'
                      ? `${ch} — userbot is NOT joined; check spelling / membership`
                      : `${ch} — validating…`
                  }
                >
                  <span>
                    {validation[ch] === 'ok' ? '✓' : validation[ch] === 'warn' ? '⚠' : '⏳'}
                  </span>
                  <span>{titleFor(ch)}</span>
                  <button
                    type="button"
                    className="btn-icon"
                    style={{ padding: 0, fontSize: 14, lineHeight: 1 }}
                    onClick={() => removeTag(ch)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                type="text"
                placeholder={channels.length ? 'Add another (Enter or comma)' : '@channel or numeric id (Enter / comma)'}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onBlur={() => {
                  if (tagInput.trim()) {
                    addTag(tagInput);
                    setTagInput('');
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addTag(tagInput);
                    setTagInput('');
                  } else if (e.key === 'Backspace' && !tagInput && channels.length) {
                    removeTag(channels[channels.length - 1]);
                  }
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: 'var(--text-primary)',
                  flex: '1 1 200px',
                  minWidth: 200,
                  fontSize: 13,
                  padding: '4px 6px'
                }}
              />
            </div>
          </div>

          {browseOpen && (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-tertiary)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <input
                  type="text"
                  className="input"
                  placeholder="Search joined channels…"
                  value={browseQuery}
                  onChange={(e) => setBrowseQuery(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={addAllVisible}
                >
                  Add all {isSource ? 'readable' : 'writable'}
                </button>
              </div>
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {filteredDialogs().length === 0 ? (
                  <p className="text-muted" style={{ padding: 12, textAlign: 'center' }}>
                    No channels found. Make sure the bot is running.
                  </p>
                ) : (
                  filteredDialogs().map((ch) => {
                    const selected = isSelected(ch);
                    const blocked = !selected && isBlockedDialog(ch);
                    const display = ch.username ? '@' + ch.username : '#' + ch.id;
                    const otherLabel = isSource ? 'destination' : 'source';
                    return (
                      <div
                        key={ch.id}
                        onClick={() => {
                          if (blocked) {
                            showNotification(
                              `"${ch.title}" is already a ${otherLabel} for this bot.`,
                              'error'
                            );
                            return;
                          }
                          togglePickerChannel(ch);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '6px 8px',
                          cursor: blocked ? 'not-allowed' : 'pointer',
                          borderRadius: 4,
                          opacity: blocked ? 0.45 : 1,
                          background: selected ? 'rgba(99,102,241,.12)' : 'transparent'
                        }}
                        title={blocked ? `Already used as a ${otherLabel} — remove it from there first` : undefined}
                      >
                        <span style={{ width: 16, textAlign: 'center' }}>
                          {selected ? '✓' : blocked ? '🚫' : ''}
                        </span>
                        <span style={{ flex: 1, fontSize: 13 }}>{ch.title}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{display}</span>
                        <span style={{ fontSize: 13 }}>{ch.is_broadcast ? '📢' : '👥'}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={saveCollection.isPending}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={saveCollection.isPending}>
            {saveCollection.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function useInitialChannels(bot, isSource) {
  return useUnionFromBot(bot, isSource);
}

function useUnionFromBot(bot, isSource) {
  // Bot config doesn't carry the channel arrays directly — those live on the
  // collection objects returned by /api/config under `collections`. The
  // BotChannelsModal can't read collections directly without props, so we
  // accept either a bot.<axis>_channels override OR rely on the parent to
  // pre-resolve. For simplicity, we look at `bot.source_channels` /
  // `bot.target_channels` first (passed in from the parent), then fall back
  // to an empty list.
  const key = isSource ? 'source_channels' : 'target_channels';
  if (Array.isArray(bot?.[key])) return [...bot[key]];
  return [];
}

// Normalize a channel value for cross-axis comparison: strip a leading "@"
// and lowercase. "@Foo", "@foo", and "foo" all collide. Numeric ids are kept
// as-is (lowercased no-ops on digits).
function normalizeChannel(v) {
  if (v == null) return '';
  return String(v).replace(/^@/, '').toLowerCase();
}
