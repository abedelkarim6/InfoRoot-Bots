/**
 * AddKeywordsModal — paste a newline-separated list of keywords and add them
 * all in one batch via /api/topic/keyword/add-bulk. Replaces the legacy inline
 * "+ Add SEOs (comma-separated)" tag-input.
 *
 * For seoHidden topics (admin-hidden master list), inserted keywords are also
 * pushed into the parent's local `_userAddedKeywords` via `onAddedHidden`, so
 * the user-keyword pills update without needing a config refetch.
 */

import { useEffect, useRef, useState } from 'react';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';

export default function AddKeywordsModal({
  botName,
  catName,
  topicName,
  seoHidden,
  onAddedHidden,
  onClose
}) {
  const [text, setText] = useState('');
  const taRef = useRef(null);
  const { showNotification } = useDialogs();

  useEffect(() => {
    const t = setTimeout(() => taRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const addBulk = useApiMutation('/api/topic/keyword/add-bulk', {
    invalidate: ['config'],
    errorMsg: 'Failed to add keywords',
    onSuccess: (res, vars) => {
      const inserted = res?.inserted || 0;
      const submitted = vars?.keywords?.length || 0;
      const skipped = Math.max(0, submitted - inserted);
      if (seoHidden && inserted > 0 && onAddedHidden) {
        onAddedHidden(vars.keywords);
      }
      let msg = `${inserted} SEO${inserted !== 1 ? 's' : ''} added`;
      if (skipped > 0) msg += ` · ${skipped} skipped (duplicates)`;
      showNotification(msg, inserted > 0 ? 'success' : 'info');
      onClose();
    }
  });

  function onSubmit() {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      showNotification('Enter at least one keyword', 'error');
      return;
    }
    const seen = new Set();
    const unique = [];
    for (const kw of lines) {
      if (!seen.has(kw)) {
        seen.add(kw);
        unique.push(kw);
      }
    }
    addBulk.mutate({
      bot_name: botName,
      category_name: catName,
      topic_name: topicName,
      keywords: unique
    });
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
            <h3 style={{ fontSize: 16, margin: 0 }}>➕ Add Keywords</h3>
            <small style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {botName} › {catName} › {topicName}
            </small>
          </div>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '18px 22px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Paste keywords — one per line</label>
            <textarea
              ref={taRef}
              className="input"
              rows={12}
              placeholder={'keyword 1\nkeyword 2\nkeyword 3\n…'}
              style={{
                resize: 'vertical',
                minHeight: 240,
                width: '100%',
                fontFamily: 'inherit',
                lineHeight: 1.5
              }}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <small className="text-muted" style={{ display: 'block', marginTop: 6 }}>
              Each non-empty line becomes one SEO. Duplicates are skipped automatically.
            </small>
          </div>
        </div>
        <div className="modal-footer" style={{ padding: '14px 22px' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={addBulk.isPending}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={addBulk.isPending}
          >
            {addBulk.isPending ? 'Adding…' : '➕ Add Keywords'}
          </button>
        </div>
      </div>
    </div>
  );
}
