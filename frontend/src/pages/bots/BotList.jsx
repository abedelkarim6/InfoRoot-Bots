/**
 * Bots — list view.
 *
 * Mirrors the legacy `_renderBotsListView` + create/duplicate/toggle helpers
 * from `static/js/pages/bots-list.js`. Includes:
 *   - "Create New Bot" card at top with a name input + button
 *   - Per-bot row card with icon, name, category/topic counts, duplicate
 *     button, enable toggle, and a click-anywhere-to-open arrow
 *   - Duplicate modal with granular include checkboxes (basic / rules /
 *     prompts / categories → seos + schedules)
 *
 * Backend endpoints used:
 *   POST /api/bot/save         (create new bot — create_only flag)
 *   POST /api/bot/save         (toggle enabled)
 *   POST /api/bot/duplicate    (duplicate with options)
 *
 * Renaming and deletion are exposed on the detail view, not the list — this
 * matches the legacy UX where the list is read-only except for toggle/dup.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGlobalConfig } from '../../config/ConfigProvider';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import PageHeader from '../../components/PageHeader';

export default function BotList() {
  const { config } = useGlobalConfig();
  const bots = config?.bots || {};
  const [duplicateState, setDuplicateState] = useState(null); // { sourceName }
  const navigate = useNavigate();

  return (
    <div className="page active" id="bots-page">
      <PageHeader title="Bot Management" subtitle="Configure and manage your bots">
        <button
          className="btn btn-secondary"
          onClick={() => navigate('/summaries-prompts')}
          title="Manage the global summaries prompt library"
        >
          📝 Prompts
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => navigate('/default-schedules')}
          title="Manage default schedule templates applied to every new topic"
        >
          📅 Default Schedules
        </button>
      </PageHeader>

      <CreateBotCard />

      <h3 className="section-title mt-4">Your Bots</h3>
      <div id="bots-container">
        {Object.keys(bots).length === 0 ? (
          <p className="text-muted" style={{ padding: '12px 0' }}>
            No bots yet. Create one above.
          </p>
        ) : (
          Object.entries(bots).map(([name, bot]) => (
            <BotListCard
              key={name}
              name={name}
              bot={bot}
              onDuplicate={() => setDuplicateState({ sourceName: name })}
            />
          ))
        )}
      </div>

      {duplicateState && (
        <DuplicateBotModal
          sourceName={duplicateState.sourceName}
          onClose={() => setDuplicateState(null)}
        />
      )}
    </div>
  );
}

// ─── Create Bot ─────────────────────────────────────────────────────────────

function CreateBotCard() {
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const { showAlert } = useDialogs();

  const create = useApiMutation('/api/bot/save', {
    invalidate: ['config', 'prompts'],
    successMsg: 'Bot created successfully',
    // The backend uses status: "updated" on success for save — useApiMutation
    // checks for "ok"; we handle this manually below.
    errorMsg: 'Failed to create bot'
  });

  async function onCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      showAlert('Please enter a bot name', { icon: '✏️' });
      return;
    }
    // 1. Create the bot. /api/bot/save returns {status: "updated"} on success.
    const result = await create.mutateAsync({
      name: trimmed,
      enabled: false,
      // Reference the auto-collection that we'll create next. This collection
      // holds the bot's source + target channels (managed via the per-bot
      // "Telegram Sources / Destinations" buttons).
      collections: [trimmed],
      minimum_messages: 5,
      summaries: [],
      categories: {},
      create_only: true
    });
    if (result?.status !== 'updated' && result?.status !== 'ok') return;

    // 2. Create the empty auto-collection so the bot has somewhere to put
    //    channels. Failure here isn't fatal — the modal will create it on
    //    first save anyway — but doing it now keeps things consistent.
    await api('/api/collection/save', {
      collection_name: trimmed,
      enabled: true,
      source_channels: [],
      target_channels: []
    }).catch(() => {});

    setName('');
    setTimeout(() => navigate(`/bots/${encodeURIComponent(trimmed)}`), 200);
  }

  return (
    <div className="create-bot-card" id="bots-create-card">
      <h3>➕ Create New Bot</h3>
      <div className="create-bot-form">
        <input
          type="text"
          id="new-bot-name"
          placeholder="Bot name (e.g., News Bot, Tech Alerts)"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
        <button className="btn btn-primary" onClick={onCreate} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create Bot'}
        </button>
      </div>
    </div>
  );
}

// ─── Bot List Card ──────────────────────────────────────────────────────────

function BotListCard({ name, bot, onDuplicate }) {
  const navigate = useNavigate();
  const categories = Object.keys(bot.categories || {});
  const topicCount = categories.reduce(
    (acc, c) => acc + Object.keys(bot.categories[c].topics || {}).length,
    0
  );

  // Toggle uses the standard /api/bot/save endpoint (legacy parity).
  const save = useApiMutation('/api/bot/save', {
    invalidate: ['config'],
    successMsg: (res, vars) => `Bot ${vars.enabled ? 'enabled' : 'disabled'}`,
    errorMsg: 'Failed to update bot'
  });

  function toggleEnabled(e) {
    e.stopPropagation();
    const enabled = e.target.checked;
    save.mutate({
      name,
      enabled,
      collections: bot.collections || [],
      minimum_messages: bot.minimum_messages ?? 5,
      rules: bot.rules || { remove: [], replace: [] },
      default_schedules: bot.default_schedules || [],
      categories: bot.categories || {}
    });
  }

  return (
    <div className="bot-list-card">
      <div
        className="bot-list-main"
        onClick={() => navigate(`/bots/${encodeURIComponent(name)}`)}
      >
        <div className="bot-list-info">
          <span className="bot-list-icon">🤖</span>
          <div>
            <div className="bot-list-name">{name}</div>
            <div className="bot-list-meta">
              {categories.length} categor{categories.length === 1 ? 'y' : 'ies'} ·{' '}
              {topicCount} topic{topicCount === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div className="bot-list-right" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn btn-secondary btn-xs"
            title="Duplicate bot"
            onClick={onDuplicate}
          >
            ⧉
          </button>
          <label className="toggle-switch toggle-sm">
            <input
              type="checkbox"
              checked={!!bot.enabled}
              disabled={save.isPending}
              onChange={toggleEnabled}
            />
            <span className="toggle-slider"></span>
          </label>
          <span className="bot-list-arrow">›</span>
        </div>
      </div>
    </div>
  );
}

// ─── Duplicate Bot Modal ────────────────────────────────────────────────────

function DuplicateBotModal({ sourceName, onClose }) {
  const navigate = useNavigate();
  const [newName, setNewName] = useState(`Copy_of_${sourceName}`);
  const [includeBasic, setIncludeBasic] = useState(true);
  const [includeRules, setIncludeRules] = useState(true);
  const [includePrompts, setIncludePrompts] = useState(true);
  const [includeCats, setIncludeCats] = useState(true);
  const [includeSeos, setIncludeSeos] = useState(true);
  const [includeSchedules, setIncludeSchedules] = useState(true);

  const dup = useApiMutation('/api/bot/duplicate', {
    invalidate: ['config', 'prompts'],
    successMsg: () => `Bot duplicated as "${newName}"`,
    errorMsg: 'Failed to duplicate bot',
    onSuccess: () => {
      onClose();
      // Drop the user on the freshly duplicated bot so they can pick up editing.
      setTimeout(() => navigate(`/bots/${encodeURIComponent(newName)}`), 200);
    }
  });

  function onSubmit() {
    if (!newName.trim()) return;
    dup.mutate({
      source_name: sourceName,
      new_name: newName.trim(),
      options: {
        include_basic: includeBasic,
        include_rules: includeRules,
        include_prompts: includePrompts,
        include_categories: includeCats,
        include_seos: includeCats && includeSeos,
        include_schedules: includeCats && includeSchedules
      }
    });
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>Duplicate Bot</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className="text-muted" style={{ fontSize: 13, marginBottom: 14 }}>
            Creates an independent copy of <strong>{sourceName}</strong>. The duplicate
            starts <strong>disabled</strong>. Choose what to include:
          </p>
          <div className="form-group" style={{ marginBottom: 14 }}>
            <label className="form-label">New Bot Name</label>
            <input
              type="text"
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmit();
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 6 }}>
            <DupOption
              checked={includeBasic}
              onChange={setIncludeBasic}
              label={<><strong>Basic settings</strong> <span className="text-muted" style={{ fontSize: 12 }}>(min messages, collections, default schedules)</span></>}
            />
            <DupOption
              checked={includeRules}
              onChange={setIncludeRules}
              label={<><strong>Rules</strong> <span className="text-muted" style={{ fontSize: 12 }}>(remove / replace patterns)</span></>}
            />
            <DupOption
              checked={includePrompts}
              onChange={setIncludePrompts}
              label={<strong>Prompts</strong>}
            />
            <DupOption
              checked={includeCats}
              onChange={setIncludeCats}
              label={<strong>Categories &amp; Topics</strong>}
            />
            <div
              style={{
                marginLeft: 24,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                opacity: includeCats ? 1 : 0.4
              }}
            >
              <DupOption
                checked={includeSeos}
                onChange={setIncludeSeos}
                label={<span>Include SEOs (keywords)</span>}
                disabled={!includeCats}
                small
              />
              <DupOption
                checked={includeSchedules}
                onChange={setIncludeSchedules}
                label={<span>Include Schedules</span>}
                disabled={!includeCats}
                small
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={dup.isPending}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={dup.isPending}>
            {dup.isPending ? 'Duplicating…' : '⧉ Duplicate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DupOption({ checked, onChange, label, disabled, small }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'default' : 'pointer',
        fontSize: small ? 13 : 14
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
