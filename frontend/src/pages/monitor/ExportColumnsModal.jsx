/**
 * Column-picker modal shared by every Monitor tab that has a CSV export.
 * Mirrors the legacy `#export-col-modal` flow but as a state-driven dialog.
 */

import { useEffect, useMemo, useState } from 'react';
import { EXPORT_COLS, TAB_LABELS } from './exportCsv';

export default function ExportColumnsModal({ tabName, onConfirm, onClose }) {
  const cols = useMemo(() => EXPORT_COLS[tabName] || [], [tabName]);
  const [selected, setSelected] = useState(() => new Set(cols.map((c) => c.key)));

  useEffect(() => {
    setSelected(new Set(cols.map((c) => c.key)));
  }, [cols]);

  const allChecked = selected.size === cols.length;

  function toggle(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll(checked) {
    if (checked) setSelected(new Set(cols.map((c) => c.key)));
    else setSelected(new Set());
  }

  function confirm() {
    if (!selected.size) return;
    onConfirm(cols.filter((c) => selected.has(c.key)).map((c) => c.key));
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ display: 'flex' }}
    >
      <div className="modal-dialog" style={{ maxWidth: 460 }}>
        <div className="modal-header">
          <h3>Export {TAB_LABELS[tabName] || tabName} — Select Columns</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <label className="export-col-item export-col-all">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) => toggleAll(e.target.checked)}
            />
            <span>Select all</span>
          </label>
          {cols.map((c) => (
            <label className="export-col-item" key={c.key}>
              <input
                type="checkbox"
                checked={selected.has(c.key)}
                onChange={() => toggle(c.key)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={confirm} disabled={!selected.size}>
            Export CSV
          </button>
        </div>
      </div>
    </div>
  );
}
