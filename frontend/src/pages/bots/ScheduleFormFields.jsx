/**
 * Shared schedule form fields. Used by AddScheduleModal, EditScheduleModal,
 * and DefaultSchedulesEditor — all three legacy modals (`#topic-schedule-modal`,
 * `#topic-schedule-edit-modal`, `#default-schedule-modal`) had near-identical
 * fields, so we render them from a single component and keep field state in
 * the parent.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

const TYPE_OPTIONS = [
  { value: 'minute',           label: 'Every Minute' },
  { value: 'hourly',           label: 'Hourly' },
  { value: 'interval_minutes', label: 'Every X Minutes' },
  { value: 'interval_hourly',  label: 'Every X Hours' },
  { value: 'daily',            label: 'Daily' },
  { value: 'speeches_interval', label: 'Speeches Interval' }
];

export function TypeSelect({ value, onChange }) {
  return (
    <div className="form-group">
      <label className="form-label">Schedule Type</label>
      <select
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {TYPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TypeSpecificFields({ form, setForm }) {
  function set(field, val) {
    setForm((f) => ({ ...f, [field]: val }));
  }

  if (form.type === 'minute') {
    return (
      <div className="form-group">
        <label className="form-label">Every N Minutes</label>
        <input
          type="number"
          className="input"
          min="1"
          max="59"
          value={form.minute ?? 1}
          onChange={(e) => set('minute', e.target.value)}
        />
      </div>
    );
  }
  if (form.type === 'hourly') {
    return (
      <div className="form-group">
        <label className="form-label">Minute</label>
        <input
          type="number"
          className="input"
          min="0"
          max="59"
          value={form.minute ?? 0}
          onChange={(e) => set('minute', e.target.value)}
        />
      </div>
    );
  }
  if (form.type === 'interval_minutes') {
    return (
      <div className="form-group">
        <label className="form-label">Every X Minutes</label>
        <input
          type="number"
          className="input"
          min="1"
          max="1440"
          value={form.minutes ?? 30}
          onChange={(e) => set('minutes', e.target.value)}
        />
        <label className="form-label mt-1">Starts at (HH : MM)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number"
            className="input"
            min="0"
            max="23"
            placeholder="HH"
            style={{ width: 80 }}
            value={form.start_hour ?? 0}
            onChange={(e) => set('start_hour', e.target.value)}
          />
          <input
            type="number"
            className="input"
            min="0"
            max="59"
            placeholder="MM"
            style={{ width: 80 }}
            value={form.start_minute ?? 0}
            onChange={(e) => set('start_minute', e.target.value)}
          />
        </div>
        <label className="form-label mt-1">
          Ends at (HH : MM) — leave blank to run indefinitely
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number"
            className="input"
            min="0"
            max="23"
            placeholder="HH"
            style={{ width: 80 }}
            value={form.end_hour ?? ''}
            onChange={(e) => set('end_hour', e.target.value)}
          />
          <input
            type="number"
            className="input"
            min="0"
            max="59"
            placeholder="MM"
            style={{ width: 80 }}
            value={form.end_minute ?? ''}
            onChange={(e) => set('end_minute', e.target.value)}
          />
        </div>
        <small className="text-muted">
          Fires every X minutes within the window. If end &lt; start (e.g. 08:00 → 02:00), runs overnight until end time next day.
        </small>
      </div>
    );
  }
  if (form.type === 'interval_hourly') {
    return (
      <div className="form-group">
        <label className="form-label">Every X Hours</label>
        <input
          type="number"
          className="input"
          min="1"
          max="24"
          value={form.hours ?? 2}
          onChange={(e) => set('hours', e.target.value)}
        />
        <label className="form-label mt-1">Starts at (HH : MM)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number"
            className="input"
            min="0"
            max="23"
            placeholder="HH"
            style={{ width: 80 }}
            value={form.start_hour ?? 0}
            onChange={(e) => set('start_hour', e.target.value)}
          />
          <input
            type="number"
            className="input"
            min="0"
            max="59"
            placeholder="MM"
            style={{ width: 80 }}
            value={form.start_minute ?? 0}
            onChange={(e) => set('start_minute', e.target.value)}
          />
        </div>
        <label className="form-label mt-1">
          Ends at (HH : MM) — leave blank to run indefinitely
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number"
            className="input"
            min="0"
            max="23"
            placeholder="HH"
            style={{ width: 80 }}
            value={form.end_hour ?? ''}
            onChange={(e) => set('end_hour', e.target.value)}
          />
          <input
            type="number"
            className="input"
            min="0"
            max="59"
            placeholder="MM"
            style={{ width: 80 }}
            value={form.end_minute ?? ''}
            onChange={(e) => set('end_minute', e.target.value)}
          />
        </div>
        <small className="text-muted">
          Fires every X hours within the window. If end &lt; start (e.g. 08:00 → 02:00), runs overnight until end time next day.
        </small>
      </div>
    );
  }
  if (form.type === 'daily') {
    return (
      <div className="form-group">
        <label className="form-label">Hour</label>
        <input
          type="number"
          className="input"
          min="0"
          max="23"
          value={form.hour ?? 18}
          onChange={(e) => set('hour', e.target.value)}
        />
        <label className="form-label mt-1">Minute</label>
        <input
          type="number"
          className="input"
          min="0"
          max="59"
          value={form.minute ?? 0}
          onChange={(e) => set('minute', e.target.value)}
        />
      </div>
    );
  }
  if (form.type === 'speeches_interval') {
    return (
      <div className="form-group">
        <label className="form-label">Wait Time (mins) — send buckets when idle</label>
        <input
          type="number"
          className="input"
          min="1"
          value={form.wait_time ?? 5}
          onChange={(e) => set('wait_time', e.target.value)}
        />
        <small className="text-muted">
          Checks every minute. Sends each bucket as a separate message after this many idle minutes. Separate LLM response sections with <code>---</code>.
        </small>
      </div>
    );
  }
  return null;
}

export function HeaderDatetimeFields({ form, setForm }) {
  function set(field, val) {
    setForm((f) => ({ ...f, [field]: val }));
  }
  return (
    <>
      <div
        className="form-group"
        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
      >
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={!!form.header_datetime}
            onChange={(e) => set('header_datetime', e.target.checked)}
          />
          <span className="toggle-slider"></span>
        </label>
        <span className="form-label" style={{ margin: 0 }}>
          Show date &amp; time in header
        </span>
      </div>
      {form.header_datetime && (
        <div style={{ paddingLeft: 16 }}>
          <div
            className="form-group"
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={!!form.header_date_arabic}
                onChange={(e) => set('header_date_arabic', e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
            <span className="form-label" style={{ margin: 0 }}>
              Date in Arabic numerals (٢٠٢٦/٠٣/٢١)
            </span>
          </div>
          <div
            className="form-group"
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={!!form.header_time_arabic}
                onChange={(e) => set('header_time_arabic', e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
            <span className="form-label" style={{ margin: 0 }}>
              Time in Arabic numerals (٠٣:٠٩ م)
            </span>
          </div>
          <div className="form-group" style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label
                className="form-label"
                style={{ margin: 0, width: 110, flexShrink: 0 }}
              >
                Time offset
              </label>
              <input
                type="number"
                className="input"
                style={{ width: 90 }}
                value={form.header_datetime_offset ?? 0}
                onChange={(e) => set('header_datetime_offset', e.target.value)}
              />
              <span className="text-muted" style={{ fontSize: 12 }}>
                min (+ = later, − = earlier)
              </span>
            </div>
            <small className="text-muted">
              Shift the displayed time in the header by this many minutes.
            </small>
          </div>
        </div>
      )}
    </>
  );
}

export function BulletPointsFields({ form, setForm }) {
  function set(field, val) {
    setForm((f) => ({ ...f, [field]: val }));
  }
  return (
    <div
      className="form-group"
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          cursor: 'pointer',
          fontWeight: 500
        }}
      >
        <input
          type="checkbox"
          checked={!!form.bullet_points}
          onChange={(e) => set('bullet_points', e.target.checked)}
        />
        Bullet Points
      </label>
      {form.bullet_points && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            type="number"
            className="input"
            min="1"
            max="25"
            style={{ width: 64, padding: '4px 8px' }}
            value={form.bullet_points_count ?? 10}
            onChange={(e) => set('bullet_points_count', e.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            points (interim batch auto-set to 26 − N)
          </span>
        </span>
      )}
    </div>
  );
}

export function TelegramTargetsField({ form, setForm }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const targets = form.telegram_targets || [];

  // Pull the logged-in account's joined writable channels — same source as
  // the per-bot Destinations picker.
  const { data: dialogsRes, isLoading: dialogsLoading } = useQuery({
    queryKey: ['user-dialogs'],
    queryFn: () => api('/api/telegram/userbot/dialogs'),
    staleTime: 60_000
  });
  const writableChannels = useMemo(() => {
    if (dialogsRes?.status !== 'ok') return [];
    return (dialogsRes.channels || []).filter((c) => c.can_post);
  }, [dialogsRes]);
  const hasSession =
    dialogsRes?.status === 'ok' ||
    (dialogsRes && dialogsRes.status !== 'no_session' && dialogsRes.status !== 'unauthorized');

  function add(val) {
    const v = (val ?? draft).trim();
    if (!v) return;
    if (targets.includes(v)) {
      setDraft('');
      return;
    }
    setForm((f) => ({
      ...f,
      telegram_targets: [...(f.telegram_targets || []), v]
    }));
    setDraft('');
  }

  function remove(t) {
    setForm((f) => ({
      ...f,
      telegram_targets: (f.telegram_targets || []).filter((x) => x !== t)
    }));
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    }
  }

  function titleFor(value) {
    if (!value) return value;
    const stripped = String(value).replace(/^@/, '').toLowerCase();
    const match = writableChannels.find(
      (d) => (d.username && d.username.toLowerCase() === stripped) || String(d.id) === stripped
    );
    return match?.title || value;
  }

  function isSelected(d) {
    return targets.some((c) => {
      const s = c.replace(/^@/, '').toLowerCase();
      return (d.username && s === d.username.toLowerCase()) || s === String(d.id);
    });
  }

  function toggleDialog(d) {
    const value = d.username ? '@' + d.username : String(d.id);
    if (isSelected(d)) remove(value);
    else add(value);
  }

  const filteredDialogs = useMemo(() => {
    const q = query.toLowerCase().trim();
    return q
      ? writableChannels.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            (c.username && c.username.toLowerCase().includes(q))
        )
      : writableChannels;
  }, [writableChannels, query]);

  return (
    <div className="form-group">
      <label className="form-label">Telegram Targets (optional)</label>

      {/* Selected chips — only shown when there's at least one */}
      {targets.length > 0 && (
        <div className="tags-container" style={{ marginBottom: 6 }}>
          {targets.map((t) => (
            <span className="tag" key={t}>
              {titleFor(t)}
              <span className="tag-remove" onClick={() => remove(t)}>
                ×
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Inline browse + search (always visible when the account has a session) */}
      {hasSession !== false && (
        <div
          style={{
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-tertiary)',
            overflow: 'hidden'
          }}
        >
          <input
            type="text"
            className="input"
            placeholder={
              dialogsLoading
                ? 'Loading your channels…'
                : `🔍 Search ${writableChannels.length} writable channel${writableChannels.length === 1 ? '' : 's'}…`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              border: 'none',
              borderBottom: '1px solid var(--border-color)',
              borderRadius: 0,
              background: 'transparent'
            }}
          />
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {dialogsLoading ? (
              <p className="text-muted" style={{ padding: 12, textAlign: 'center', margin: 0 }}>
                Loading…
              </p>
            ) : filteredDialogs.length === 0 ? (
              <p className="text-muted" style={{ padding: 12, textAlign: 'center', margin: 0 }}>
                {writableChannels.length === 0
                  ? 'No writable channels found on this account.'
                  : 'No channels match your search.'}
              </p>
            ) : (
              filteredDialogs.map((d) => {
                const selected = isSelected(d);
                const display = d.username ? '@' + d.username : '#' + d.id;
                return (
                  <div
                    key={d.id}
                    onClick={() => toggleDialog(d)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '7px 10px',
                      cursor: 'pointer',
                      borderTop: '1px solid var(--border-color)',
                      background: selected ? 'rgba(99,102,241,.12)' : 'transparent'
                    }}
                    onMouseOver={(e) => {
                      if (!selected) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.04))';
                    }}
                    onMouseOut={(e) => {
                      if (!selected) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      readOnly
                      style={{ pointerEvents: 'none', margin: 0 }}
                    />
                    <span style={{ flex: 1, fontSize: 13 }}>{d.title}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{display}</span>
                    <span style={{ fontSize: 13 }} title={d.is_broadcast ? 'Channel' : 'Group'}>
                      {d.is_broadcast ? '📢' : '👥'}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Manual entry for channels NOT in the joined list (chat IDs, externals) */}
      <input
        type="text"
        className="input mt-1"
        placeholder="Or paste @channel / chat ID and press Enter"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add()}
      />

      <small
        className="text-muted sch-tg-hint"
        style={targets.length ? { color: 'var(--warning)' } : undefined}
      >
        {targets.length ? (
          <>
            ⚠️ These targets <b>override</b> the collection target channels your bot is subscribed to.
          </>
        ) : (
          'Leave empty to use collection targets.'
        )}
      </small>
    </div>
  );
}

export function PromptSelect({ form, setForm, botPrompts }) {
  const keys = Object.keys(botPrompts || {});
  return (
    <div className="form-group">
      <label className="form-label">Prompt</label>
      <select
        className="select"
        value={form.prompt_key || ''}
        onChange={(e) =>
          setForm((f) => ({ ...f, prompt_key: e.target.value }))
        }
      >
        {keys.length === 0 && <option value="">No prompts defined</option>}
        {keys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </div>
  );
}
