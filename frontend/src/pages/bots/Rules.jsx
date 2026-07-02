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
import { buildFullBotSavePayload } from './shared';
import BotReplaceGroupsSection from './BotReplaceGroupsSection';

export default function Rules({ botName, bot }) {
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
          <div className="form-group">
            <label className="form-label">🚫 Remove Message</label>
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
                    className="btn-icon btn-danger"
                    onClick={() => deleteRemoveRow(idx)}
                    disabled={save.isPending}
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
            <button className="btn btn-secondary btn-sm mt-1" onClick={addRemove}>
              + Add Word
            </button>
          </div>

          <div className="form-group" style={{ marginTop: 16 }}>
            <label className="form-label">🔄 Replace in Message</label>
            <small className="text-muted d-block mb-1">
              Replaces matching words before categorisation &amp; summary
            </small>
            <div id={`rules-replace-${botName}`}>
              {replaceRules.map((rule, idx) => (
                <div className="rules-row" key={idx}>
                  <input
                    type="text"
                    className="input rules-input"
                    value={rule.match || ''}
                    placeholder="Find…"
                    onChange={(e) => updateReplace(idx, 'match', e.target.value)}
                    onBlur={commitReplace}
                  />
                  <span className="rules-arrow">→</span>
                  <input
                    type="text"
                    className="input rules-input"
                    value={rule.replace_with || ''}
                    placeholder="Replace with…"
                    onChange={(e) => updateReplace(idx, 'replace_with', e.target.value)}
                    onBlur={commitReplace}
                  />
                  <button
                    className="btn-icon btn-danger"
                    onClick={() => deleteReplaceRow(idx)}
                    disabled={save.isPending}
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
            <button className="btn btn-secondary btn-sm mt-1" onClick={addReplace}>
              + Add Rule
            </button>
          </div>

          <BotReplaceGroupsSection botName={botName} bot={bot} />
        </div>
      </div>
    </div>
  );
}
