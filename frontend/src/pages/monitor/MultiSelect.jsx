/**
 * Reusable multi-select dropdown for the Monitor page.
 *
 * Mirrors the legacy `mon-multi-select` markup so existing CSS (in
 * modern-injected.css) applies unchanged. Selected = empty Set means "All".
 *
 *   <MultiSelect
 *     label="All Bots"
 *     values={['bot1','bot2']}
 *     selected={selBots}
 *     onChange={setSelBots}
 *   />
 *
 * - `selected` is a Set passed in by the parent — owning component holds state.
 * - `values` is the list of options (strings).
 * - Empty `selected` is rendered with the "All" item checked.
 */

import { useEffect, useRef, useState } from 'react';

export default function MultiSelect({ label = 'All', values, selected, onChange, style }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close dropdown when clicking outside.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    // Defer attach so the click that opened the dropdown isn't immediately captured.
    const id = setTimeout(() => document.addEventListener('click', onDocClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('click', onDocClick);
    };
  }, [open]);

  // Prune selected set if the value list has shrunk (legacy behaviour).
  // Skip while the option list is still empty — that means options haven't
  // loaded yet (async facets / first page), not that the selection is stale.
  // Without this guard a filter restored from the URL would be wiped on mount.
  useEffect(() => {
    if (!values.length) return;
    let mutated = false;
    const next = new Set();
    for (const v of selected) {
      if (values.includes(v)) next.add(v);
      else mutated = true;
    }
    if (mutated) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  function toggle(v) {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next);
  }

  function selectAll() {
    onChange(new Set());
  }

  let btnText;
  if (selected.size === 0) btnText = label;
  else if (selected.size <= 2) btnText = [...selected].join(', ');
  else btnText = `${selected.size} selected`;

  return (
    <div
      ref={wrapRef}
      className={`mon-multi-select${open ? ' open' : ''}`}
      style={style}
      data-label={label}
    >
      <button
        type="button"
        className="select mon-filter-sel mon-ms-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {btnText} <span className="mon-ms-arrow">▾</span>
      </button>
      <div className="mon-ms-dropdown">
        <label className="mon-ms-item all-item">
          <input
            type="checkbox"
            checked={selected.size === 0}
            onChange={() => selectAll()}
          />{' '}
          {label}
        </label>
        {values.map((v) => (
          <label className="mon-ms-item" key={v}>
            <input
              type="checkbox"
              checked={selected.has(v)}
              onChange={() => toggle(v)}
            />{' '}
            {v}
          </label>
        ))}
      </div>
    </div>
  );
}
