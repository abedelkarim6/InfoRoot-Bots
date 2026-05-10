/**
 * System Bot — floating action button + slide-in drawer.
 *
 * This is a shell-level widget (mounted in AppShell) so the FAB and chat
 * stay accessible from every page. Visibility: admin always sees it, regular
 * users only see it when their `sys_bot_on` flag is true (legacy parity —
 * accounts.js line 38: `const hasSysBot = isAdmin || !!currentUser.sys_bot_on`).
 *
 * Backend:
 *   POST /api/chatbot/system/start  → { session_id }
 *   POST /api/chatbot/system/end    → end session
 *   POST /api/chatbot/system/stream → SSE: step / delta / done / error
 *
 * Behaviour mirrors the legacy static/js/system-chat.js: streaming chat with
 * step cards, action cards strip (auto-hides after 8s), reset/new-conversation
 * button, suggestion chips on empty state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { useDialogs } from '../../dialogs/DialogsProvider';
import useChatStream from '../../pages/chat/useChatStream';
import { formatMarkdown } from '../../pages/chat/chatHelpers';

const SUGGESTIONS = [
  { icon: '📋', label: 'System status',     text: 'Show me the full system status' },
  { icon: '🔎', label: 'YT keywords',       text: 'List all YouTube keyword trackers' },
  { icon: '🏷️', label: 'Topics overview',   text: 'Show all topics and their status' },
  { icon: '📺', label: 'YT channels',       text: 'List all YouTube channels' }
];

const ACTION_CONFIG = {
  toggle: { icon: '🔄', label: 'Toggled' },
  add:    { icon: '➕', label: 'Added' },
  delete: { icon: '🗑️', label: 'Deleted' },
  run:    { icon: '▶️', label: 'Triggered' },
  update: { icon: '✏️', label: 'Updated' }
};

export default function SysBotDrawer() {
  const { user, isAdmin } = useAuth();
  if (!isAdmin && !user?.sys_bot_on) return null;
  return <SysBotDrawerInner />;
}

function SysBotDrawerInner() {
  const { showNotification } = useDialogs();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState({ state: 'connecting', label: 'Connecting…' });
  const [messages, setMessages] = useState([]);   // { id, role, text, steps, loading, streaming, actions }
  const [actionStrip, setActionStrip] = useState(null); // last set of actions, auto-hides
  const [input, setInput] = useState('');
  const inputRef = useRef(null);
  const messagesRef = useRef(null);
  const stripTimerRef = useRef(null);

  const stream = useChatStream({
    url: '/api/chatbot/system/stream',
    onEvent: (evt) => handleEvent(evt)
  });

  // Start a session the first time the drawer opens.
  useEffect(() => {
    if (!open || sessionId) return;
    setStatus({ state: 'connecting', label: 'Connecting…' });
    api('/api/chatbot/system/start', {}).then((res) => {
      if (res?.status === 'ok') {
        setSessionId(res.session_id);
        setStatus({ state: 'ready', label: 'Ready' });
      } else {
        setStatus({ state: 'error', label: 'Connection failed' });
        showNotification('Failed to start system chat: ' + (res?.message || ''), 'error');
      }
    });
  }, [open, sessionId, showNotification]);

  // End the session on unmount (e.g. logout).
  useEffect(() => {
    return () => {
      if (sessionId) {
        api('/api/chatbot/system/end', { session_id: sessionId }).catch(() => {});
      }
      if (stripTimerRef.current) clearTimeout(stripTimerRef.current);
    };
  }, [sessionId]);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages, actionStrip]);

  // Focus input when the drawer opens (and once we're ready).
  useEffect(() => {
    if (open && status.state === 'ready' && !stream.streaming) {
      inputRef.current?.focus();
    }
  }, [open, status.state, stream.streaming]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') closeDrawer();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const closeDrawer = useCallback(() => {
    stream.cancel();
    setOpen(false);
  }, [stream]);

  const handleEvent = useCallback((evt) => {
    setMessages((prev) => {
      // Latest assistant message is the streaming target.
      const idx = prev.findIndex((m) => m.role === 'assistant' && (m.streaming || m.loading));
      if (idx === -1) return prev;

      const updated = [...prev];
      const msg = { ...updated[idx] };

      if (msg.loading) {
        msg.loading = false;
        msg.streaming = true;
      }

      if (evt.type === 'step') {
        msg.steps = [...(msg.steps || []), evt];
      } else if (evt.type === 'delta') {
        msg.text = (msg.text || '') + (evt.content || '');
      } else if (evt.type === 'done') {
        msg.text = evt.content || msg.text;
        msg.streaming = false;
        msg.actions = evt.actions || [];
        if (msg.actions.length) showActionStrip(msg.actions);
      } else if (evt.type === 'error') {
        showNotification(evt.message || 'Agent error', 'error');
        updated.splice(idx, 1);
        return updated;
      }

      updated[idx] = msg;
      return updated;
    });
  }, [showNotification]);

  function showActionStrip(actions) {
    if (stripTimerRef.current) clearTimeout(stripTimerRef.current);
    setActionStrip(actions);
    stripTimerRef.current = setTimeout(() => setActionStrip(null), 8000);
  }

  async function send(text) {
    const message = (text ?? input).trim();
    if (!message || !sessionId || stream.streaming) return;
    setInput('');

    const userId = Date.now();
    const replyId = userId + 1;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text: message },
      { id: replyId, role: 'assistant', text: '', steps: [], loading: true, streaming: false, actions: [] }
    ]);

    setStatus({ state: 'thinking', label: 'Working…' });
    setActionStrip(null);

    const result = await stream.send({ session_id: sessionId, message });

    setStatus({ state: 'ready', label: 'Ready' });

    if (result.aborted) {
      // Drop the empty placeholder if no content arrived; keep partial otherwise.
      setMessages((prev) =>
        prev
          .map((m) => (m.id === replyId ? { ...m, loading: false, streaming: false } : m))
          .filter((m) => !(m.id === replyId && !m.text && (!m.steps || !m.steps.length)))
      );
    } else if (!result.ok) {
      setMessages((prev) => prev.filter((m) => m.id !== replyId));
      showNotification('Connection error. Please try again.', 'error');
    }
  }

  async function reset() {
    stream.cancel();
    if (sessionId) {
      api('/api/chatbot/system/end', { session_id: sessionId }).catch(() => {});
    }
    setSessionId(null);
    setMessages([]);
    setActionStrip(null);
    setStatus({ state: 'connecting', label: 'Connecting…' });
    const res = await api('/api/chatbot/system/start', {});
    if (res?.status === 'ok') {
      setSessionId(res.session_id);
      setStatus({ state: 'ready', label: 'Ready' });
      showNotification('New system chat started', 'info');
    }
    inputRef.current?.focus();
  }

  function onInputKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      {/* FAB */}
      <button
        className="sys-bot-fab"
        onClick={() => setOpen(true)}
        title="System Bot"
        style={{ display: open ? 'none' : '' }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          <line x1="12" y1="3" x2="12" y2="3.01" />
          <circle cx="9" cy="16" r="1" fill="currentColor" />
          <circle cx="15" cy="16" r="1" fill="currentColor" />
        </svg>
      </button>

      {/* Overlay */}
      {open && <div className="sys-bot-overlay" onClick={closeDrawer} style={{ display: 'block' }} />}

      {/* Drawer */}
      <div className={`sys-bot-drawer${open ? ' open' : ''}`} style={{ display: open ? '' : 'none' }}>
        <div className="sc-panel">
          <div className="sc-header">
            <div className="sc-header-left">
              <div className="sc-avatar">SYS</div>
              <div>
                <h3>System Bot</h3>
                <span className={`sc-status sc-status-${status.state}`}>
                  <span className="sc-status-dot" /> {status.label}
                </span>
              </div>
            </div>
            <div className="sc-header-actions">
              <button className="agent-chat-icon-btn" onClick={reset} title="New conversation">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
              </button>
              <button className="agent-chat-icon-btn" onClick={closeDrawer} title="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          <div className="sc-messages" ref={messagesRef}>
            {messages.length === 0 ? (
              <Welcome onSelect={(t) => send(t)} />
            ) : (
              messages.map((m) => <Message key={m.id} msg={m} />)
            )}
          </div>

          {actionStrip && (
            <div className="sc-actions-strip" style={{ display: '' }}>
              {actionStrip.map((a, i) => <ActionCard key={i} action={a} />)}
            </div>
          )}

          <div className="sc-input-bar">
            {messages.length === 0 && (
              <div className="sc-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.text}
                    className="sc-suggestion"
                    onClick={() => send(s.text)}
                    disabled={!sessionId || stream.streaming}
                  >
                    <span className="sc-suggestion-icon">{s.icon}</span> {s.label}
                  </button>
                ))}
              </div>
            )}
            <div className="sc-compose">
              <textarea
                ref={inputRef}
                className="input sc-textarea"
                rows={1}
                placeholder="Tell me what to change…"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                }}
                onKeyDown={onInputKeyDown}
                disabled={stream.streaming}
              />
              {stream.streaming ? (
                <button className="chat-cancel-btn" onClick={() => stream.cancel()} title="Stop generating">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                </button>
              ) : (
                <button className="agent-chat-send-btn" onClick={() => send()} title="Send" disabled={!sessionId || !input.trim()}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Welcome({ onSelect }) {
  const examples = [
    'Turn off the system',
    'Disable the YouTube keyword tracker for AI news',
    'Add a new YouTube keyword: machine learning',
    'Show all collections and their status'
  ];
  return (
    <div className="sc-welcome">
      <div className="sc-welcome-avatar">SYS</div>
      <h2 className="sc-welcome-title">System Control</h2>
      <p className="sc-welcome-sub">
        I can toggle features, manage keywords, and configure your monitoring system.
      </p>
      <div className="sc-welcome-examples">
        {examples.map((t) => (
          <div key={t} className="sc-example" onClick={() => onSelect(t)}>{t}</div>
        ))}
      </div>
    </div>
  );
}

function Message({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className="sc-msg sc-msg-user">
        <div className="sc-msg-bubble sc-msg-bubble-user">{msg.text}</div>
      </div>
    );
  }
  const label = msg.loading || msg.streaming ? 'Working…' : 'System Agent';
  return (
    <div className="sc-msg sc-msg-ai">
      <div className="sc-msg-avatar">SYS</div>
      <div className="sc-msg-body">
        <div className="sc-msg-label">{label}</div>
        <div className="sc-msg-bubble sc-msg-bubble-ai">
          <BubbleInner msg={msg} />
        </div>
      </div>
    </div>
  );
}

function BubbleInner({ msg }) {
  if (msg.loading) return <Skeleton />;
  return (
    <>
      {msg.steps && msg.steps.length > 0 && (
        <div className="ac-steps">
          {msg.steps.map((s, i) => (
            <div key={i} className="ac-step">
              <span className="ac-step-icon">{s.icon}</span>
              <span className="ac-step-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}
      {msg.text ? (
        <div
          className={`ac-content${msg.streaming ? ' ac-content-streaming' : ''}`}
          dangerouslySetInnerHTML={{ __html: formatMarkdown(msg.text) }}
        />
      ) : msg.streaming && (!msg.steps || msg.steps.length === 0) ? (
        <Skeleton />
      ) : null}
      {!msg.loading && !msg.streaming && msg.actions && msg.actions.length > 0 && (
        <div className="sc-inline-actions">
          {msg.actions.map((a, i) => <ActionCard key={i} action={a} />)}
        </div>
      )}
    </>
  );
}

function Skeleton() {
  return (
    <div className="ac-skeleton">
      <div className="ac-skeleton-line" style={{ width: '85%' }} />
      <div className="ac-skeleton-line" style={{ width: '65%' }} />
    </div>
  );
}

function ActionCard({ action }) {
  const cfg = ACTION_CONFIG[action.type] || { icon: '📌', label: action.type };
  const isSuccess = action.status === 'success';
  const statusClass = isSuccess ? 'sc-action-success' : 'sc-action-error';
  return (
    <div className={`sc-action-card ${statusClass}`}>
      <div className="sc-action-icon">{cfg.icon}</div>
      <div className="sc-action-body">
        <div className="sc-action-header">
          <span className="sc-action-label">{cfg.label}</span>
          <span className="sc-action-entity">{action.entity || ''}</span>
          <span className="sc-action-status">{isSuccess ? '✓' : '✗'}</span>
        </div>
        <div className="sc-action-name">{action.name || ''}</div>
        {action.type === 'toggle' ? (
          <div className="sc-action-toggle">
            <span className="sc-toggle-old">{action.old_value ? 'ON' : 'OFF'}</span>
            <span className={`sc-toggle-arrow ${action.new_value ? 'sc-arrow-on' : 'sc-arrow-off'}`}>→</span>
            <span className={`sc-toggle-new ${action.new_value ? 'sc-toggle-on' : 'sc-toggle-off'}`}>
              {action.new_value ? 'ON' : 'OFF'}
            </span>
          </div>
        ) : action.detail ? (
          <div className="sc-action-detail">{action.detail}</div>
        ) : null}
      </div>
    </div>
  );
}
