/**
 * Bots — Basic Settings tab.
 *
 * Includes:
 *   - Inline rename input + "✏️ Rename" button.
 *   - Minimum Messages number input.
 *
 * Default Schedules used to live here but are now global — managed on the
 * "📅 Default Schedules" button at the top of the Bots list page.
 *
 * Source/target channels for the bot live behind the
 * "📡 Telegram Sources" / "📤 Telegram Destinations" buttons in the
 * BotDetail header — see BotChannelsModal.jsx.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { buildFullBotSavePayload } from './shared';

export default function BasicSettings({ botName, bot }) {
  const [open, setOpen] = useState(true);

  return (
    <div className={`collapsible-section ${open ? 'open' : ''}`} id={`basic-${botName}`}>
      <div className="collapsible-header" onClick={() => setOpen((v) => !v)}>
        <div className="collapsible-title">
          <span className="icon">⚙️</span>
          <span>Basic Settings</span>
        </div>
        <span className="collapsible-toggle">▼</span>
      </div>
      <div className="collapsible-content">
        <div className="collapsible-body">
          <InlineRename botName={botName} />
          <MinMessagesField botName={botName} bot={bot} />
          <p className="text-muted" style={{ fontSize: 12, marginTop: 12 }}>
            Source &amp; target channels are managed via the
            <strong> 📡 Telegram Sources</strong> and
            <strong> 📤 Telegram Destinations</strong> buttons at the top of the page.
            Default schedules are global — manage them on the
            <strong> 📅 Default Schedules</strong> page (button at the top of the Bots list).
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Inline Rename ──────────────────────────────────────────────────────────

function InlineRename({ botName }) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(botName);

  // Reset the draft whenever the bot changes (route navigation, rename redirect).
  useEffect(() => {
    setDraft(botName);
  }, [botName]);

  const rename = useApiMutation('/api/bot/rename', {
    invalidate: ['config', 'prompts'],
    successMsg: 'Bot renamed',
    errorMsg: 'Failed to rename bot',
    onSuccess: async (res) => {
      const target = res?.new_name || draft;
      // Also rename the bot's auto-collection so the channels stay attached.
      // Best-effort: ignore failure (the collection may not yet exist for older bots).
      if (target && target !== botName) {
        await api('/api/collection/rename', { old_name: botName, new_name: target }).catch(() => {});
        navigate(`/bots/${encodeURIComponent(target)}`, { replace: true });
      }
    }
  });

  function onSubmit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === botName) return;
    rename.mutate({ old_name: botName, new_name: trimmed });
  }

  return (
    <div className="form-group">
      <label className="form-label">Bot Name</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="text"
          className="input"
          id={`bot-name-input-${botName}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
        />
        <button
          className="btn btn-secondary btn-sm"
          onClick={onSubmit}
          disabled={rename.isPending || draft.trim() === botName}
        >
          ✏️ Rename
        </button>
      </div>
      <small className="text-muted">
        Renaming preserves all settings, categories, topics and schedules.
      </small>
    </div>
  );
}

// ─── Collections Multi-Select ───────────────────────────────────────────────

// ─── Minimum Messages ───────────────────────────────────────────────────────

function MinMessagesField({ botName, bot }) {
  const [draft, setDraft] = useState(String(bot.minimum_messages ?? 5));
  useEffect(() => {
    setDraft(String(bot.minimum_messages ?? 5));
  }, [bot.minimum_messages]);

  const save = useApiMutation('/api/bot/save', {
    invalidate: ['config'],
    successMsg: 'Setting updated',
    errorMsg: 'Failed to update setting'
  });

  function onCommit() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n === bot.minimum_messages) return;
    save.mutate(buildFullBotSavePayload(botName, bot, { minimum_messages: n }));
  }

  return (
    <div className="form-group">
      <label className="form-label">Minimum Messages for Summary</label>
      <input
        type="number"
        className="input input-number-sm"
        id={`min-messages-${botName}`}
        value={draft}
        min="1"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
        }}
        disabled={save.isPending}
      />
      <small className="text-muted">
        Number of messages required before generating a summary
      </small>
    </div>
  );
}

