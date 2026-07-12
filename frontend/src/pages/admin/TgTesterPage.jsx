/**
 * Telegram Tester (admin) — Phase 3 port of static/js/tg-tester.js.
 *
 * Three tabs:
 *   1. Telegram     — session test + raw send/receive via the userbot.
 *   2. Summaries    — bot/topic/schedule generator test + recent summaries.
 *   3. Manual Test  — paste arbitrary messages, generate, optionally send.
 *
 * Data fetching: useQuery(['monitor-data']) feeds the bots config and the
 * recent-summaries list. All write actions go through useApiMutation so
 * notifications are handled centrally.
 *
 * No DOM mutation — every visible state lives in React state. The tiny
 * `.tgt-tab` styles the legacy injected at runtime are rendered as a
 * sibling <style> tag.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useUrlString } from '../../lib/useUrlState';
import PageHeader from '../../components/PageHeader';

const TAB_STYLES = `
  .tgt-tab {
    padding: 8px 20px;
    font-size: 13px;
    font-weight: 500;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    cursor: pointer;
    color: var(--color-muted);
    transition: color .15s, border-color .15s;
  }
  .tgt-tab:hover { color: var(--color-text); }
  .tgt-tab--active { color: var(--color-primary); border-bottom-color: var(--color-primary); }
`;

const VALID_TGT_TABS = new Set(['telegram', 'summaries', 'manual']);

export default function TgTesterPage() {
  const [tabParam, setTabParam] = useUrlString('tab', 'telegram');
  const tab = VALID_TGT_TABS.has(tabParam) ? tabParam : 'telegram';
  // Push so the browser Back button returns to the previous tab.
  const setTab = (t) => setTabParam(t, { push: true });

  // Single source of truth for the bot config + recent summaries.
  const monitorQuery = useQuery({
    queryKey: ['monitor-data'],
    queryFn: () => api('/api/monitor/data'),
  });

  const botsConfig = monitorQuery.data?.status === 'ok' ? (monitorQuery.data.bots || {}) : {};
  const recentSummaries = monitorQuery.data?.status === 'ok' ? (monitorQuery.data.recent_summaries || []) : [];

  return (
    <div className="page active">
      <style>{TAB_STYLES}</style>
      <PageHeader
        title="Telegram Tester"
        subtitle="Diagnose send/receive issues and test summary generation"
      >
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => monitorQuery.refetch()}
          disabled={monitorQuery.isFetching}
        >
          ↻ Refresh
        </button>
      </PageHeader>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div
          className="tgt-tabs"
          style={{ display: 'flex', gap: 0, borderBottom: '2px solid var(--border-color)', marginBottom: 4 }}
        >
          <TabButton active={tab === 'telegram'} onClick={() => setTab('telegram')}>📡 Telegram</TabButton>
          <TabButton active={tab === 'summaries'} onClick={() => setTab('summaries')}>📝 Summaries</TabButton>
          <TabButton active={tab === 'manual'} onClick={() => setTab('manual')}>✏️ Manual Test</TabButton>
        </div>

        {tab === 'telegram' && <TelegramPanel />}
        {tab === 'summaries' && (
          <SummariesPanel
            botsConfig={botsConfig}
            recentSummaries={recentSummaries}
            onRefreshRecent={() => monitorQuery.refetch()}
            isLoadingRecent={monitorQuery.isFetching}
          />
        )}
        {tab === 'manual' && <ManualPanel botsConfig={botsConfig} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab button
// ─────────────────────────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }) {
  return (
    <button className={`tgt-tab${active ? ' tgt-tab--active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram panel — session check + raw send/receive + connection logs
// ─────────────────────────────────────────────────────────────────────────────

function TelegramPanel() {
  const [sendTarget, setSendTarget] = useState('');
  const [sendMessage, setSendMessage] = useState('');
  const [recvTarget, setRecvTarget] = useState('');
  const [recvLimit, setRecvLimit] = useState(10);

  const [sessionResult, setSessionResult] = useState(null); // {status, me?, message?}
  const [sessionLogs, setSessionLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);

  const [sendResult, setSendResult] = useState(null); // {status, message}
  const [recvResult, setRecvResult] = useState(null); // {status, ...}

  const sessionTest = useApiMutation('/api/telegram/session/test', {
    onSuccess: (res) => {
      if (res.logs?.length) {
        setSessionLogs(res.logs);
        setShowLogs(true);
      }
      setSessionResult({
        status: 'ok',
        me: res.me || '?',
      });
    },
    onError: (res) => {
      // useApiMutation's onError fires for both network errors and {status:'error'}.
      // For a parsed error response, res is the whole result object.
      const logs = res?.logs;
      if (logs?.length) {
        setSessionLogs(logs);
        setShowLogs(true);
      }
      const msg = res?.message || (logs && logs[logs.length - 1]) || 'Unknown error';
      setSessionResult({ status: 'error', message: msg });
    },
  });

  const sendMutation = useApiMutation('/api/telegram/test/send', {
    onSuccess: (res) => setSendResult({ status: 'ok', message: res.message }),
    onError: (res) => setSendResult({ status: 'error', message: res?.message || 'Send failed' }),
  });

  const recvMutation = useApiMutation('/api/telegram/test/receive', {
    onSuccess: (res) => setRecvResult({ status: 'ok', ...res, target: recvTarget }),
    onError: (res) => setRecvResult({ status: 'error', message: res?.message || 'Fetch failed' }),
  });

  function onSend() {
    const target = sendTarget.trim();
    const message = sendMessage.trim();
    if (!target || !message) {
      setSendResult({ status: 'error', message: '⚠ Please fill in both target and message.' });
      return;
    }
    setSendResult({ status: 'pending' });
    sendMutation.mutate({ target, message });
  }

  function onReceive() {
    const target = recvTarget.trim();
    if (!target) {
      setRecvResult({ status: 'error', message: '⚠ Please enter a target channel.' });
      return;
    }
    setRecvResult({ status: 'pending' });
    recvMutation.mutate({ target, limit: parseInt(recvLimit, 10) || 10 });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Session status */}
      <div className="card">
        <div
          className="card-header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span style={{ fontWeight: 600 }}>📡 Session Status</span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setSessionResult({ status: 'pending' });
              sessionTest.mutate({});
            }}
            disabled={sessionTest.isPending}
          >
            Test Connection
          </button>
        </div>
        <div className="card-body" id="tgt-session-status">
          {sessionResult == null && (
            <span className="text-muted">Click "Test Connection" to check the userbot session.</span>
          )}
          {sessionResult?.status === 'pending' && <span className="text-muted">Connecting…</span>}
          {sessionResult?.status === 'ok' && (
            <span style={{ color: 'var(--color-success)' }}>
              ✔ Connected as <strong>{sessionResult.me}</strong>
            </span>
          )}
          {sessionResult?.status === 'error' && (
            <span style={{ color: 'var(--color-error)' }}>✘ {sessionResult.message}</span>
          )}
        </div>
      </div>

      {/* Send test */}
      <div className="card">
        <div className="card-header">
          <span style={{ fontWeight: 600 }}>📤 Send Test</span>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label className="form-label">Target channel / user</label>
              <input
                className="input"
                placeholder="@channel, -100xxxx, or username"
                value={sendTarget}
                onChange={(e) => setSendTarget(e.target.value)}
              />
            </div>
            <div style={{ flex: 2, minWidth: 200 }}>
              <label className="form-label">Message</label>
              <input
                className="input"
                placeholder="Hello from the tester!"
                value={sendMessage}
                onChange={(e) => setSendMessage(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" onClick={onSend} disabled={sendMutation.isPending}>
              ▶ Send
            </button>
          </div>
          {sendResult && (
            <div>
              {sendResult.status === 'pending' && <span className="text-muted">Sending…</span>}
              {sendResult.status === 'ok' && (
                <span style={{ color: 'var(--color-success)' }}>✔ {sendResult.message}</span>
              )}
              {sendResult.status === 'error' && (
                <span style={{ color: 'var(--color-error)' }}>✘ {sendResult.message}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Receive test */}
      <div className="card">
        <div className="card-header">
          <span style={{ fontWeight: 600 }}>📥 Receive Test</span>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 2, minWidth: 160 }}>
              <label className="form-label">Channel / chat to read from</label>
              <input
                className="input"
                placeholder="@channel or -100xxxx"
                value={recvTarget}
                onChange={(e) => setRecvTarget(e.target.value)}
              />
            </div>
            <div style={{ width: 90 }}>
              <label className="form-label">Last N msgs</label>
              <select
                className="select"
                value={recvLimit}
                onChange={(e) => setRecvLimit(e.target.value)}
              >
                <option value="5">5</option>
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
              </select>
            </div>
            <button className="btn btn-primary" onClick={onReceive} disabled={recvMutation.isPending}>
              ▶ Fetch
            </button>
          </div>
          {recvResult && <ReceiveResult result={recvResult} />}
        </div>
      </div>

      {/* Connection logs (only visible when there are logs) */}
      {showLogs && sessionLogs.length > 0 && (
        <div className="card">
          <div
            className="card-header"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span style={{ fontWeight: 600 }}>🗒 Connection Logs</span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowLogs(false)}
            >
              ✕
            </button>
          </div>
          <div className="card-body">
            <pre
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                maxHeight: 300,
                overflowY: 'auto',
              }}
            >
              {sessionLogs.join('\n')}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ReceiveResult({ result }) {
  if (result.status === 'pending') return <span className="text-muted">Fetching…</span>;
  if (result.status === 'error') {
    return <span style={{ color: 'var(--color-error)' }}>✘ {result.message}</span>;
  }
  const messages = result.messages || [];
  if (!messages.length) {
    return (
      <span className="text-muted">
        No messages found in <strong>{result.target}</strong>.
      </span>
    );
  }
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 6 }}>
        Showing {result.count} message(s) from <strong>{result.target}</strong>
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto', fontSize: 13 }}>
        {messages.map((m) => (
          <div
            key={m.id}
            style={{ padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}
          >
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 3 }}>
              {m.date ? new Date(m.date).toLocaleString() : '—'} · #{m.id}
              {m.media_type && (
                <>
                  {' '}
                  <span className="badge" style={{ fontSize: 10 }}>{m.media_type}</span>
                </>
              )}
            </div>
            <div>
              {m.sender && (
                <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>{m.sender} </span>
              )}
              {m.text
                ? truncate(m.text, 300)
                : <em style={{ color: 'var(--color-muted)' }}>[no text]</em>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summaries panel — bot/topic/schedule generator + recent summaries
// ─────────────────────────────────────────────────────────────────────────────

function SummariesPanel({ botsConfig, recentSummaries, onRefreshRecent, isLoadingRecent }) {
  const [botName, setBotName] = useState('');
  const [topicName, setTopicName] = useState('');
  const [schedType, setSchedType] = useState('');
  const [genResult, setGenResult] = useState(null);

  const botNames = useMemo(() => Object.keys(botsConfig), [botsConfig]);
  const topicNames = useMemo(() => collectTopicNames(botsConfig, botName), [botsConfig, botName]);
  const schedTypes = useMemo(
    () => collectScheduleTypes(botsConfig, botName, topicName),
    [botsConfig, botName, topicName],
  );

  // Reset dependent fields when parent changes.
  function onBotChange(v) {
    setBotName(v);
    setTopicName('');
    setSchedType('');
  }
  function onTopicChange(v) {
    setTopicName(v);
    setSchedType('');
  }

  const generate = useApiMutation('/api/telegram/tester/summary/generate', {
    onSuccess: (res) => setGenResult(res),
    onError: (res) => setGenResult({ status: 'error', ...(res || {}) }),
  });

  function onGenerate() {
    if (!botName || !topicName || !schedType) {
      setGenResult({ status: 'error', message: '⚠ Please select bot, topic and schedule type.' });
      return;
    }
    setGenResult({ status: 'pending' });
    generate.mutate({ bot_name: botName, topic_name: topicName, schedule_type: schedType });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Generator */}
      <div className="card">
        <div
          className="card-header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span style={{ fontWeight: 600 }}>🧪 Summary Generator Test</span>
          <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
            Generates without sending to Telegram
          </span>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label className="form-label">Bot</label>
              <select
                className="select"
                value={botName}
                onChange={(e) => onBotChange(e.target.value)}
              >
                <option value="">— select bot —</option>
                {botNames.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label className="form-label">Topic</label>
              <select
                className="select"
                value={topicName}
                onChange={(e) => onTopicChange(e.target.value)}
              >
                <option value="">— select topic —</option>
                {topicNames.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 130 }}>
              <label className="form-label">Schedule type</label>
              <select
                className="select"
                value={schedType}
                onChange={(e) => setSchedType(e.target.value)}
              >
                <option value="">— select —</option>
                {schedTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <button
              className="btn btn-primary"
              onClick={onGenerate}
              disabled={generate.isPending}
            >
              ▶ Generate
            </button>
          </div>
          {genResult && <GenerateResult result={genResult} />}
        </div>
      </div>

      {/* Recent summaries */}
      <div className="card">
        <div
          className="card-header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span style={{ fontWeight: 600 }}>📋 Recent Summaries</span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={onRefreshRecent}
            disabled={isLoadingRecent}
          >
            ↻ Refresh
          </button>
        </div>
        <div className="card-body">
          <RecentSummariesList summaries={recentSummaries} loading={isLoadingRecent} />
        </div>
      </div>
    </div>
  );
}

function GenerateResult({ result }) {
  if (result.status === 'pending') {
    return (
      <span className="text-muted">Generating… (this may take a few seconds)</span>
    );
  }
  if (result.status === 'ok' && result.warning) {
    return (
      <span style={{ color: 'var(--color-warning, #f59e0b)' }}>⚠ {result.warning}</span>
    );
  }
  if (result.status === 'error') {
    return (
      <>
        <div style={{ color: 'var(--color-error)', fontWeight: 500, marginBottom: 6 }}>
          ✘ Generation failed
          {result.stage && (
            <span style={{ fontSize: 11, color: 'var(--color-muted)' }}> [stage: {result.stage}]</span>
          )}
        </div>
        <pre
          style={{
            background: 'var(--bg-secondary, #f8f9fa)',
            padding: 10,
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            margin: 0,
            color: 'var(--color-error)',
          }}
        >
          {result.message || 'Unknown error'}
        </pre>
      </>
    );
  }
  // Success with summary text
  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 10,
          fontSize: 12,
          color: 'var(--color-muted)',
        }}
      >
        <span>Messages used: <strong>{result.message_count}</strong></span>
        <span>Prompt key: <strong>{result.prompt_key || '—'}</strong></span>
        <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>✔ Generated successfully</span>
      </div>
      <pre
        style={{
          background: 'var(--bg-secondary, #f8f9fa)',
          padding: 12,
          borderRadius: 6,
          fontSize: 13,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          margin: 0,
          maxHeight: 400,
          overflowY: 'auto',
        }}
      >
        {result.summary}
      </pre>
    </>
  );
}

function RecentSummariesList({ summaries, loading }) {
  if (loading && (!summaries || !summaries.length)) {
    return <span className="text-muted">Loading…</span>;
  }
  if (!summaries || !summaries.length) {
    return <span className="text-muted">No summaries found in the database yet.</span>;
  }
  const visible = summaries.slice(0, 20);
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 8 }}>
        Showing last {visible.length} of {summaries.length} summaries
      </div>
      <div style={{ maxHeight: 500, overflowY: 'auto' }}>
        {visible.map((s, idx) => {
          const date = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
          const previewText = (s.preview || '');
          return (
            <div
              key={s.id ?? idx}
              style={{ padding: '10px 0', borderBottom: '1px solid var(--border-color)' }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  fontSize: 11,
                  color: 'var(--color-muted)',
                  marginBottom: 5,
                }}
              >
                <span>{date}</span>
                <span>·</span>
                <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>
                  {s.bot_name || '—'}
                </span>
                <span>/</span>
                <span>{s.topic_name || '—'}</span>
                <span>·</span>
                <span className="badge" style={{ fontSize: 10 }}>{s.summary_type || '—'}</span>
                <span>· {s.message_count || 0} msgs</span>
                <span>→ {s.target_entity || '—'}</span>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-text)' }}>
                {previewText
                  ? truncate(previewText, 200)
                  : <em style={{ color: 'var(--color-muted)' }}>[empty]</em>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual panel — paste messages, generate, send
// ─────────────────────────────────────────────────────────────────────────────

function ManualPanel({ botsConfig }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [botName, setBotName] = useState('');
  const [topicName, setTopicName] = useState('');
  const [promptKey, setPromptKey] = useState('default');
  const [genStatus, setGenStatus] = useState(null);
  const [genResult, setGenResult] = useState(null);
  const [resultText, setResultText] = useState('');
  const [resultMeta, setResultMeta] = useState('');
  const [showResult, setShowResult] = useState(false);
  const [sendTarget, setSendTarget] = useState('');
  const [sendStatus, setSendStatus] = useState(null);

  const botNames = useMemo(() => Object.keys(botsConfig), [botsConfig]);
  const topicNames = useMemo(() => collectTopicNames(botsConfig, botName), [botsConfig, botName]);

  function addMessage() {
    const txt = draft.trim();
    if (!txt) return;
    setMessages((arr) => [...arr, txt]);
    setDraft('');
  }
  function removeMessage(idx) {
    setMessages((arr) => arr.filter((_, i) => i !== idx));
  }
  function clearMessages() {
    setMessages([]);
  }

  function onBotChange(v) {
    setBotName(v);
    setTopicName('');
    setPromptKey('default');
  }
  function onTopicChange(v) {
    setTopicName(v);
    // Auto-fill prompt_key from the first schedule's prompt_key
    if (v && botName) {
      const bot = botsConfig[botName];
      for (const cat of Object.values(bot?.categories || {})) {
        const topicCfg = (cat.topics || {})[v];
        if (topicCfg) {
          const firstKey = ((topicCfg.schedules || [])[0] || {}).prompt_key;
          if (firstKey) setPromptKey(firstKey);
          break;
        }
      }
    }
  }

  const generate = useApiMutation('/api/telegram/tester/summary/manual', {
    onSuccess: (res) => {
      setGenStatus({
        status: 'ok',
        message: `✔ Generated from ${res.message_count} message(s) · prompt: ${res.prompt_key}`,
      });
      setGenResult(res);
      setResultText(res.summary || '');
      setResultMeta(`${res.message_count} msg(s) · key: ${res.prompt_key}`);
      setShowResult(true);
      setSendStatus(null);
    },
    onError: (res) => {
      const stage = res?.stage ? ` [${res.stage}]` : '';
      setGenStatus({
        status: 'error',
        message: `✘ ${res?.message || 'Generation failed'}${stage}`,
      });
    },
  });

  const sendMutation = useApiMutation('/api/telegram/tester/summary/send', {
    onSuccess: (res) => setSendStatus({ status: 'ok', message: `✔ ${res.message}` }),
    onError: (res) => setSendStatus({ status: 'error', message: `✘ ${res?.message || 'Send failed'}` }),
  });

  function onGenerate() {
    if (!messages.length) {
      setGenStatus({ status: 'error', message: '⚠ Add at least one message first.' });
      return;
    }
    setGenStatus({ status: 'pending', message: 'Generating… this may take a few seconds' });
    setShowResult(false);
    generate.mutate({
      texts: messages,
      bot_name: botName,
      topic_name: topicName,
      prompt_key: (promptKey || 'default').trim(),
    });
  }

  function onSend() {
    const target = sendTarget.trim();
    const text = (resultText || '').trim();
    if (!target) {
      setSendStatus({ status: 'error', message: '⚠ Enter a target channel.' });
      return;
    }
    if (!text) {
      setSendStatus({ status: 'error', message: '⚠ Summary is empty.' });
      return;
    }
    setSendStatus({ status: 'pending', message: 'Sending…' });
    sendMutation.mutate({ target, message: text });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Step 1: messages */}
      <div className="card">
        <div
          className="card-header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span style={{ fontWeight: 600 }}>1️⃣ Messages</span>
          <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
            {messages.length} message(s)
          </span>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              className="input"
              rows={3}
              style={{ flex: 1, resize: 'vertical', fontSize: 13, lineHeight: 1.5 }}
              placeholder="Type a message here and click Add… (Ctrl+Enter to add)"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.ctrlKey && e.key === 'Enter') {
                  e.preventDefault();
                  addMessage();
                }
              }}
            />
            <button
              className="btn btn-secondary"
              style={{ alignSelf: 'flex-end' }}
              onClick={addMessage}
            >
              + Add
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {messages.length === 0 ? (
              <span className="text-muted" style={{ fontSize: 12 }}>
                No messages added yet.
              </span>
            ) : (
              messages.map((txt, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    background: 'var(--bg-secondary, #f8f9fa)',
                    borderRadius: 6,
                    padding: '8px 10px',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <span style={{ color: 'var(--color-muted)', minWidth: 22, paddingTop: 1 }}>
                    #{i + 1}
                  </span>
                  <span
                    style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  >
                    {txt}
                  </span>
                  <button
                    onClick={() => removeMessage(i)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--color-muted)',
                      fontSize: 14,
                      padding: '0 2px',
                      lineHeight: 1,
                    }}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={clearMessages}
              disabled={!messages.length}
            >
              ✕ Clear all
            </button>
          </div>
        </div>
      </div>

      {/* Step 2: summary config */}
      <div className="card">
        <div className="card-header">
          <span style={{ fontWeight: 600 }}>2️⃣ Summary Config</span>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label className="form-label">
                Bot{' '}
                <span style={{ color: 'var(--color-muted)', fontWeight: 400 }}>(optional)</span>
              </label>
              <select
                className="select"
                value={botName}
                onChange={(e) => onBotChange(e.target.value)}
              >
                <option value="">— none / manual —</option>
                {botNames.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label className="form-label">
                Topic{' '}
                <span style={{ color: 'var(--color-muted)', fontWeight: 400 }}>(optional)</span>
              </label>
              <select
                className="select"
                value={topicName}
                onChange={(e) => onTopicChange(e.target.value)}
              >
                <option value="">— none —</option>
                {topicNames.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 130 }}>
              <label className="form-label">Prompt key</label>
              <input
                className="input"
                value={promptKey}
                onChange={(e) => setPromptKey(e.target.value)}
                placeholder="default"
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={onGenerate}
              disabled={generate.isPending}
            >
              ▶ Generate Summary
            </button>
          </div>
          {genStatus && <ManualStatusLine status={genStatus} />}
        </div>
      </div>

      {/* Step 3: result + send */}
      {showResult && (
        <div className="card">
          <div
            className="card-header"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span style={{ fontWeight: 600 }}>3️⃣ Summary Result</span>
            <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>{resultMeta}</span>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <textarea
              className="input"
              rows={8}
              style={{
                resize: 'vertical',
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
              }}
              placeholder="Generated summary will appear here…"
              value={resultText}
              onChange={(e) => setResultText(e.target.value)}
            />
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-end',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 180 }}>
                <label className="form-label">Send to channel / user</label>
                <input
                  className="input"
                  placeholder="@channel or -100xxxx"
                  value={sendTarget}
                  onChange={(e) => setSendTarget(e.target.value)}
                />
              </div>
              <button
                className="btn btn-primary"
                onClick={onSend}
                disabled={sendMutation.isPending}
              >
                📤 Send to Telegram
              </button>
            </div>
            {sendStatus && <ManualStatusLine status={sendStatus} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ManualStatusLine({ status }) {
  if (status.status === 'pending') {
    return <span className="text-muted">{status.message}</span>;
  }
  if (status.status === 'ok') {
    return <span style={{ color: 'var(--color-success)' }}>{status.message}</span>;
  }
  return <span style={{ color: 'var(--color-error)' }}>{status.message}</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function collectTopicNames(botsConfig, botName) {
  if (!botName || !botsConfig[botName]) return [];
  const bot = botsConfig[botName];
  const topics = new Set();
  for (const cat of Object.values(bot.categories || {})) {
    for (const tName of Object.keys(cat.topics || {})) {
      topics.add(tName);
    }
  }
  return [...topics];
}

function collectScheduleTypes(botsConfig, botName, topicName) {
  if (!botName || !topicName || !botsConfig[botName]) return [];
  const bot = botsConfig[botName];
  const types = new Set();
  for (const cat of Object.values(bot.categories || {})) {
    const topicCfg = (cat.topics || {})[topicName];
    if (topicCfg) {
      for (const s of topicCfg.schedules || []) {
        if (s.type) types.add(s.type);
      }
    }
  }
  // If no schedule info available, offer the common types (mirrors legacy behavior)
  if (!types.size) return ['hourly', 'daily', 'minute', 'interval_hourly'];
  return [...types];
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}
