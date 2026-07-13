/**
 * Bots — Rules tab.
 *
 * Mirrors the legacy `createRulesSection` + add/delete/save helpers from
 * `static/js/pages/bots-detail.js`.
 *
 * Two rule types:
 *   - Remove: discard a message if it contains any of these words.
 *   - Replace: find/replace text BEFORE categorisation & summarisation.
 *
 * Save strategy: legacy code rebuilt the entire rules object and POSTed the
 * full bot payload to /api/bot/save on every input blur. We mirror that —
 * rules are saved on blur, not on every keystroke, to avoid hammering the
 * API.
 *
 * Backend endpoints used:
 *   POST /api/bot/save   (rules are stored as part of the bot config blob)
 */

import { useEffect, useState } from 'react';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { buildFullBotSavePayload } from './shared';
import BotReplaceGroupsSection from './BotReplaceGroupsSection';
import Icon from '../../components/icons';

/**
 * `section` prop (Figma tab layout):
 *   'blocked'  → only the Blocked SEOs (remove-word) editor
 *   'replace'  → only the Replace Terms editor + replace groups
 *   undefined  → legacy combined collapsible (kept for compat)
 */
export default function Rules({ botName, bot, section }) {
  // Hydrate local state from the canonical bot config every time the bot
  // changes (route change / cache update). Rules are kept locally so a stale
  // input value doesn't fight a re-render mid-edit.
  const [removeRules, setRemoveRules] = useState(() => bot.rules?.remove || []);
  const [replaceRules, setReplaceRules] = useState(() => bot.rules?.replace || []);

  useEffect(() => {
    setRemoveRules(bot.rules?.remove || []);
    setReplaceRules(bot.rules?.replace || []);
  }, [bot.rules]);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const { showConfirm } = useDialogs();

  const replaceGroups = bot.replace_groups || [];
  const total = removeRules.length + replaceRules.length + replaceGroups.length;

  const save = useApiMutation('/api/bot/save', {
    invalidate: ['config'],
    successMsg: 'Rules saved',
    errorMsg: 'Failed to save rules'
  });

  function persist(nextRemove, nextReplace) {
    const cleanRemove = nextRemove.map((s) => s.trim()).filter(Boolean);
    const cleanReplace = nextReplace
      .map((r) => ({ match: (r.match || '').trim(), replace_with: (r.replace_with || '').trim() }))
      .filter((r) => r.match);
    save.mutate(
      buildFullBotSavePayload(botName, bot, {
        rules: { remove: cleanRemove, replace: cleanReplace }
      })
    );
  }

  function updateRemove(idx, value) {
    const next = [...removeRules];
    next[idx] = value;
    setRemoveRules(next);
  }

  function commitRemove(idx) {
    const next = removeRules.filter((s, i) => i !== idx ? Boolean(s.trim()) : true);
    setRemoveRules(next);
    persist(next, replaceRules);
  }

  function deleteRemoveRow(idx) {
    const next = removeRules.filter((_, i) => i !== idx);
    setRemoveRules(next);
    persist(next, replaceRules);
  }

  function updateReplace(idx, field, value) {
    const next = [...replaceRules];
    next[idx] = { ...next[idx], [field]: value };
    setReplaceRules(next);
  }

  function commitReplace() {
    persist(removeRules, replaceRules);
  }

  function deleteReplaceRow(idx) {
    const next = replaceRules.filter((_, i) => i !== idx);
    setReplaceRules(next);
    persist(removeRules, next);
  }

  function addRemove() {
    setRemoveRules((prev) => [...prev, '']);
  }

  function addReplace() {
    setReplaceRules((prev) => [...prev, { match: '', replace_with: '' }]);
  }

  // ── Section fragments (shared by tabbed + legacy layouts) ────────────────
  const blockedSection = (
    <div className="form-group">
      <label className="form-label">Blocked SEOs</label>
      <small className="text-muted d-block mb-1">
        Message is discarded for this bot if it contains any of these words
      </small>
      <div id={`rules-remove-${botName}`}>
        {removeRules.map((kw, idx) => (
          <div className="rules-row" key={idx}>
            <input
              type="text"
              className="input rules-input"
              value={kw}
              placeholder="word or phrase…"
              onChange={(e) => updateRemove(idx, e.target.value)}
              onBlur={() => commitRemove(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.target.blur();
              }}
            />
            <button
              className="btn-icon btn-icon-danger"
              onClick={() => deleteRemoveRow(idx)}
              disabled={save.isPending}
            >
              🗑️
            </button>
          </div>
        ))}
      </div>
      <button className="btn btn-primary btn-sm mt-1" onClick={addRemove}>
        + Pattern
      </button>
    </div>
  );

  // ── Replace pane display order (Figma: search + Sort by toolbar) ─────────
  const q = search.trim().toLowerCase();
  const displayReplace = replaceRules
    .map((rule, idx) => ({ rule, idx }))
    .filter(({ rule }) =>
      !q ||
      (rule.match || '').toLowerCase().includes(q) ||
      (rule.replace_with || '').toLowerCase().includes(q)
    );
  if (sortMode === 'from') {
    displayReplace.sort((a, b) => (a.rule.match || '').localeCompare(b.rule.match || ''));
  }

  function onMassDeleteReplace() {
    if (!replaceRules.length) return;
    showConfirm(
      `Delete all ${replaceRules.length} replace pattern${replaceRules.length !== 1 ? 's' : ''}?`,
      () => {
        setReplaceRules([]);
        persist(removeRules, []);
      },
      { title: 'Mass Delete Replace Terms', confirmLabel: 'Delete All', confirmClass: 'btn-danger' }
    );
  }

  function onImportReplace(pairs) {
    const next = [...replaceRules, ...pairs];
    setReplaceRules(next);
    persist(removeRules, next);
    setImportOpen(false);
  }

  const replaceSection = (
    <>
      <div className="tg-tab-head">
        <h4 className="tg-tab-title">Replaced Terms</h4>
        <p className="tg-tab-subtitle">Find and replace text in messages before forwarding.</p>
      </div>

      <div className="tg-toolbar">
        <div className="tg-search" style={{ flex: 1 }}>
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="input tg-sort"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value)}
        >
          <option value="">Sort by</option>
          <option value="from">From (A–Z)</option>
        </select>
      </div>

      <BotReplaceGroupsSection botName={botName} bot={bot} search={search} />

      <div className="tsec open">
        <div className="tsec-head" style={{ cursor: 'default' }}>
          <span className="tsec-icon"><Icon name="key" size={16} /></span>
          <span className="tsec-title">Replace Terms</span>
          <div className="tsec-actions">
            <button
              className="btn btn-secondary btn-sm btn-outline-danger"
              onClick={onMassDeleteReplace}
              disabled={!replaceRules.length || save.isPending}
            >
              <Icon name="trash" size={13} style={{ marginRight: 5 }} />
              Mass Delete
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setImportOpen(true)}>
              <Icon name="importBox" size={13} style={{ marginRight: 5 }} />
              Import
            </button>
            <button className="btn btn-primary btn-sm" onClick={addReplace}>
              <Icon name="plus" size={13} style={{ marginRight: 5 }} />
              Pattern
            </button>
          </div>
        </div>
        <div className="tsec-body">
          <div className="rt-table-wrap" id={`rules-replace-${botName}`}>
            <div className="rt-head">
              <span>From</span>
              <span>To</span>
            </div>
            {displayReplace.map(({ rule, idx }) => (
              <div className="rt-row" key={idx}>
                <input
                  type="text"
                  className="input"
                  value={rule.match || ''}
                  placeholder="From"
                  onChange={(e) => updateReplace(idx, 'match', e.target.value)}
                  onBlur={commitReplace}
                />
                <input
                  type="text"
                  className="input"
                  value={rule.replace_with || ''}
                  placeholder="To"
                  onChange={(e) => updateReplace(idx, 'replace_with', e.target.value)}
                  onBlur={commitReplace}
                />
                <button
                  className="btn-icon btn-icon-danger"
                  onClick={() => deleteReplaceRow(idx)}
                  disabled={save.isPending}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            {displayReplace.length === 0 && replaceRules.length > 0 && (
              <p className="tsec-empty" style={{ padding: '10px 2px' }}>No patterns match your search.</p>
            )}
          </div>
          <button className="btn btn-primary btn-sm mt-1" onClick={addReplace}>
            <Icon name="plus" size={13} style={{ marginRight: 5 }} />
            Row
          </button>
        </div>
      </div>

      {importOpen && (
        <ImportReplaceModal onSubmit={onImportReplace} onClose={() => setImportOpen(false)} />
      )}
    </>
  );

  // Tabbed layouts (Figma): plain section inside the tab pane, no collapsible.
  if (section === 'blocked') {
    return <div className="rules-tab-pane">{blockedSection}</div>;
  }
  if (section === 'replace') {
    return <div className="rules-tab-pane">{replaceSection}</div>;
  }

  return (
    <div className={`collapsible-section ${open ? 'open' : ''}`} id={`rules-${botName}`}>
      <div className="collapsible-header" onClick={() => setOpen((v) => !v)}>
        <div className="collapsible-title">
          <span className="icon">🔧</span>
          <span>Rules ({total})</span>
        </div>
        <span className="collapsible-toggle">▼</span>
      </div>
      <div className="collapsible-content">
        <div className="collapsible-body">
          {blockedSection}
          <div style={{ marginTop: 16 }}>{replaceSection}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * ImportReplaceModal — bulk-add replace patterns. One pair per line:
 *   from -> to     |     from | to     |     from<TAB>to
 * Lines with no separator become a remove-style pair (to = empty).
 */
function ImportReplaceModal({ onSubmit, onClose }) {
  const [text, setText] = useState('');

  function parse() {
    const pairs = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let from = line;
      let to = '';
      for (const sep of ['->', '=>', '|', '\t']) {
        const i = line.indexOf(sep);
        if (i !== -1) {
          from = line.slice(0, i).trim();
          to = line.slice(i + sep.length).trim();
          break;
        }
      }
      if (from) pairs.push({ match: from, replace_with: to });
    }
    return pairs;
  }

  const count = parse().length;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-dialog" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>Import Replace Terms</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            One pattern per line — <code>from -&gt; to</code>, <code>from | to</code>, or tab-separated.
          </p>
          <textarea
            className="input"
            rows={10}
            autoFocus
            placeholder={'iran -> leb\nexample text | replacement text'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
          />
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!count} onClick={() => onSubmit(parse())}>
            Import {count > 0 ? `(${count})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
