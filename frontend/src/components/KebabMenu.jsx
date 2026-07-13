/**
 * KebabMenu — Figma "⋮" row-action dropdown.
 *
 * <KebabMenu items={[{ label, icon?, danger?, onClick }, ...]} />
 * Items with `danger` render red. Closes on outside click / item click.
 */

import { useEffect, useRef, useState } from 'react';
import Icon from './icons';

export default function KebabMenu({ items = [], size = 16 }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  return (
    <div className="kebab-wrap" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        className="btn-icon kebab-btn"
        title="More actions"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="moreVertical" size={size} />
      </button>
      {open && (
        <div className="kebab-menu">
          {items.filter(Boolean).map((item, i) => (
            <button
              key={i}
              className={`kebab-item${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick?.();
              }}
            >
              {item.icon && <Icon name={item.icon} size={14} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
