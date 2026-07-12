/**
 * Bots — detail view (single-bot config card).
 *
 * Mirrors the legacy `_renderBotDetailView` + `createBotConfigCard` from
 * `static/js/pages/bots-detail.js`. Renders:
 *   - A header strip with "‹ All Bots", the bot name, an enable toggle,
 *     a "✏️ Rename" button (modal, see BasicSettings for the inline rename),
 *     and a "🗑️ Delete" button (soft-delete to recycle bin).
 *   - A 4-tab card: Basic, Rules, Prompts, Categories & Topics.
 *
 * The Categories & Topics tab is intentionally a placeholder. Agent B will
 * fill in TopicsSection / SchedulesSection / SeosSection — see
 * topicsSection.placeholder.jsx for the prop signature.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGlobalConfig } from '../../config/ConfigProvider';
import { api } from '../../lib/api';
import { useApiMutation, useConfirmedMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useUrlString } from '../../lib/useUrlState';
import BasicSettings from './BasicSettings';
import Rules from './Rules';
import TopicsSection from './TopicsSection';
import BotChannelsModal from './BotChannelsModal';
import Icon from '../../components/icons';

// Prompts are global now — managed on the top-level /prompts page.
const TABS = [
  { id: 'basic',      label: 'Basic Settings' },
  { id: 'rules',      label: 'Rules' },
  { id: 'categories', label: 'Categories & Topics' }
];
const VALID_TABS = new Set(TABS.map((t) => t.id));

export default function BotDetail({ botName }) {
  const { config } = useGlobalConfig();
  const bot = (config?.bots || {})[botName];
  const navigate = useNavigate();
  // ?tab=basic|rules|categories — falls back to categories.
  const [tabParam, setTabParam] = useUrlString('tab', 'categories');
  const activeTab = VALID_TABS.has(tabParam) ? tabParam : 'categories';
  // Push so the browser Back button returns to the previous tab.
  const setActiveTab = (t) => setTabParam(t, { push: true });

  // Resolve the bot's current source / target channels from the union of all
  // collections it references. This is what the per-bot Sources/Destinations
  // modals start from (read-side); on save, the modal collapses everything
  // into a single auto-collection named after the bot.
  const collections = config?.collections || {};
  const sources = unionChannels(bot?.collections, collections, 'source_channels');
  const targets = unionChannels(bot?.collections, collections, 'target_channels');

  if (!bot) {
    return (
      <div className="page active" id="bots-page">
        <p className="text-muted" style={{ padding: 20 }}>Loading bot…</p>
      </div>
    );
  }

  return (
    <div className="page active" id="bots-page">
      <BotDetailHeader
        bot={bot}
        botName={botName}
        sources={sources}
        targets={targets}
        onBack={() => navigate('/bots')}
      />

      <div className="bot-config-card" id={`bot-${botName}`}>
        <div className="bot-tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`bot-tab-btn ${activeTab === t.id ? 'active' : ''}`}
              data-tab={t.id}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="bot-config-body">
          <div className={`bot-tab-pane ${activeTab === 'basic' ? 'active' : ''}`} data-tab="basic">
            {activeTab === 'basic' && <BasicSettings botName={botName} bot={bot} />}
          </div>
          <div className={`bot-tab-pane ${activeTab === 'rules' ? 'active' : ''}`} data-tab="rules">
            {activeTab === 'rules' && <Rules botName={botName} bot={bot} />}
          </div>
          <div className={`bot-tab-pane ${activeTab === 'categories' ? 'active' : ''}`} data-tab="categories">
            {activeTab === 'categories' && (
              <TopicsSection botName={botName} bot={bot} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Detail Header ──────────────────────────────────────────────────────────

function BotDetailHeader({ botName, bot, sources, targets, onBack }) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [channelsModal, setChannelsModal] = useState(null); // 'source' | 'target' | null

  const save = useApiMutation('/api/bot/save', {
    invalidate: ['config'],
    successMsg: (res, vars) => `Bot ${vars.enabled ? 'enabled' : 'disabled'}`,
    errorMsg: 'Failed to update bot'
  });

  const remove = useApiMutation('/api/bot/delete', {
    invalidate: ['config', 'recycle-bin', 'prompts'],
    successMsg: 'Bot deleted',
    errorMsg: 'Failed to delete bot',
    onSuccess: onBack
  });

  const confirmDelete = useConfirmedMutation(remove, {
    message: `Delete bot "${botName}"? This cannot be undone.`,
    title: 'Delete Bot',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  function toggleEnabled(e) {
    save.mutate({
      name: botName,
      enabled: e.target.checked,
      collections: bot.collections || [],
      minimum_messages: bot.minimum_messages ?? 5,
      rules: bot.rules || { remove: [], replace: [] },
      default_schedules: bot.default_schedules || [],
      categories: bot.categories || {}
    });
  }

  const inherited = !!bot.inherited;

  return (
    <>
      {/* Breadcrumb row (Figma: "Summaries Bots / <bot>") */}
      <nav className="breadcrumbs">
        <button className="breadcrumb-link" onClick={onBack}>
          <Icon name="bot" size={14} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          Summaries Bots
        </button>
        <span className="breadcrumb-sep">/</span>
        <span className="breadcrumb-current">{botName}</span>
      </nav>

      <div className="bot-detail-header" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <h2 className="page-title" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {botName}
          {inherited && (
            <span
              className="linked-badge"
              title="Shared bot managed by the admin — you can add your own SEO keywords; structure is read-only"
            >
              🔗 Inherited
            </span>
          )}
          {!inherited && (
            <button
              className="btn-icon"
              style={{ fontSize: 16 }}
              title="Rename bot"
              onClick={() => setRenameOpen(true)}
            >✏️</button>
          )}
        </h2>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setChannelsModal('source')}
            title="Channels this bot reads from"
          >
            Sources <span style={{ opacity: 0.7 }}>({sources.length})</span>
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setChannelsModal('target')}
            title="Channels this bot sends summaries to"
          >
            Destinations <span style={{ opacity: 0.7 }}>({targets.length})</span>
          </button>
          {!inherited && (
            <>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={!!bot.enabled}
                  disabled={save.isPending}
                  onChange={toggleEnabled}
                />
                <span className="toggle-slider"></span>
              </label>
              <button
                className="btn-icon btn-icon-danger"
                title="Delete bot"
                onClick={() => confirmDelete({ name: botName })}
                disabled={remove.isPending}
              ><Icon name="trash" size={15} /></button>
            </>
          )}
        </div>
      </div>

      {renameOpen && (
        <RenameBotModal
          oldName={botName}
          onClose={() => setRenameOpen(false)}
        />
      )}

      {channelsModal && (
        <BotChannelsModal
          botName={botName}
          kind={channelsModal}
          bot={{ ...bot, source_channels: sources, target_channels: targets }}
          onClose={() => setChannelsModal(null)}
        />
      )}
    </>
  );
}

// ─── Modal: Rename Bot (header / dropdown rename, distinct from the inline
//   Rename in BasicSettings — this is the legacy `renameBot()`)
// ──────────────────────────────────────────────────────────────────────────

function RenameBotModal({ oldName, onClose }) {
  const navigate = useNavigate();
  const [newName, setNewName] = useState(oldName);

  const rename = useApiMutation('/api/bot/rename', {
    invalidate: ['config', 'prompts'],
    successMsg: 'Bot renamed',
    errorMsg: 'Failed to rename bot',
    onSuccess: async (res) => {
      onClose();
      const target = res?.new_name || newName;
      if (target && target !== oldName) {
        // Also rename the bot's auto-collection. Best-effort.
        await api('/api/collection/rename', { old_name: oldName, new_name: target }).catch(() => {});
        navigate(`/bots/${encodeURIComponent(target)}`, { replace: true });
      }
    }
  });

  function onSubmit() {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) {
      onClose();
      return;
    }
    rename.mutate({ old_name: oldName, new_name: trimmed });
  }

  return (
    <div
      className="modal-overlay"
      id="rename-bot-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Rename Bot</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">New Bot Name</label>
            <input
              type="text"
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmit();
              }}
              autoFocus
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={rename.isPending}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={rename.isPending}>
            {rename.isPending ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function unionChannels(botCollections, allCollections, axisKey) {
  // Compute the de-duped union of the named axis (`source_channels` or
  // `target_channels`) across every collection this bot references. Used to
  // hydrate the per-bot channel picker so legacy bots with multiple
  // collections still display all their channels.
  const out = [];
  const seen = new Set();
  for (const name of (botCollections || [])) {
    const coll = allCollections?.[name];
    if (!coll) continue;
    for (const ch of (coll[axisKey] || [])) {
      const key = String(ch).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ch);
    }
  }
  return out;
}
