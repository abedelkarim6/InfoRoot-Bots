/**
 * SeoGroupAddKeywordsModal — bulk Import / Add Keywords for an SEO group. Paste
 * keywords (one per line, or comma/CSV-separated) and add them all at once via
 * /api/seo/group/keyword/add-bulk. Mirrors the topic AddKeywordsModal.
 */

import { useEffect, useRef, useState } from 'react';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';

export default function SeoGroupAddKeywordsModal({ groupId, groupName, onClose }) {
  const [text, setText] = useState('');
  const taRef = useRef(null);
  const { showNotification } = useDialogs();

  useEffect(() => {
    const t = setTimeout(() => taRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const addBulk = useApiMutation('/api/seo/group/keyword/add-bulk', {
    invalidate: ['seo-library', 'config'],
    errorMsg: 'Failed to add keywords',
    onSuccess: (res, vars) => {
      const inserted = res?.inserted || 0;
      const submitted = vars?.keywords?.length || 0;
      const skipped = Math.max(0, submitted - inserted);
      let msg = `${inserted} keyword${inserted !== 1 ? 's' : ''} added`;
      if (skipped > 0) msg += ` · ${skipped} skipped (duplicates)`;
      showNotification(msg, inserted > 0 ? 'success' : 'info');
      onClose();
    }
  });

  function onSubmit() {
    // Accept newline, comma, or CSV separated input.
    const parts = text
      .split(/\r?\n|,/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!parts.length) {
      showNotification('Enter at least one keyword', 'error');
      return;
    }
    const seen = new Set();
    const unique = [];
    for (const kw of parts) {
      if (!seen.has(kw)) {
        seen.add(kw);
        unique.push(kw);
      }
    }
    addBulk.mutate({ group_id: groupId, keywords: unique });
  }

  return (
    <div
      className="modal-overlay"
      style={{ display: 'flex' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog" style={{ maxWidth: 540 }}>
        <div className="modal-header" style={{ padding: '18px 22px' }}>
          <div>
            <h3 style={{ fontSize: 16, margin: 0 }}>⬆ Import Keywords</h3>
            <small style={{ color: 'var(--text-muted)', fontSize: 12 }}>{groupName}</small>
          </div>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '18px 22px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Paste keywords — one per line (or comma-separated)</label>
            <textarea
              ref={taRef}
              className="input"
              rows={12}
              placeholder={'keyword 1\nkeyword 2\nkeyword 3\n…'}
              style={{ resize: 'vertical', minHeight: 240, width: '100%', fontFamily: 'inherit', lineHeight: 1.5 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <small className="text-muted" style={{ display: 'block', marginTop: 6 }}>
              Each entry becomes one keyword. Duplicates are skipped automatically.
            </small>
          </div>
        </div>
        <div className="modal-footer" style={{ padding: '14px 22px' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={addBulk.isPending}>Cancel</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={addBulk.isPending}>
            {addBulk.isPending ? 'Adding…' : '⬆ Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
