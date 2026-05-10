/**
 * Agent Chat page (`/agent-chat`).
 * Port of static/js/chatbot.js + #agent-chat-page in index.html.
 *
 * Backend endpoints:
 *   POST /api/chatbot/start          — create session
 *   GET  /api/chatbot/suggestions    — AI-generated welcome questions
 *   POST /api/chatbot/stream         — SSE: events of {type: step|delta|done|error}
 *   POST /api/chatbot/end            — terminate session
 *   POST /api/chatbot/refine         — AI-polish merged composer text
 *   POST /api/chatbot/send-telegram  — push composed text to Telegram
 *
 * SSE handling lives in `useChatStream`. The hook's cleanup aborts the
 * controller, so leaving the page mid-stream cleanly closes the connection.
 *
 * UI parity notes:
 *   - "Thinking…" block collapses after stream completes; user can re-open.
 *   - Trailing 2-6 list items in a done response render as clickable chips.
 *   - Selecting checkboxes on assistant messages enables "Merge Selected" in
 *     the right-side composer panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { useGlobalConfig } from '../../config/ConfigProvider';
import { formatMarkdown, parseTrailingChips } from './chatHelpers';
import useChatStream from './useChatStream';
import PlanBadge from './PlanBadge';

const CONTEXT_TYPES = [
  { value: '', label: 'Context: All data' },
  { value: 'topic', label: 'Topic' },
  { value: 'category', label: 'Category' },
  { value: 'yt-channel', label: 'YouTube Channel' },
  { value: 'yt-keyword', label: 'YouTube Keyword' },
];

export default function AgentChatPage() {
  const { showNotification } = useDialogs();
  const planBadgeRef = useRef(null);

  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState({ state: 'connecting', label: 'Connecting…' });
  const [messages, setMessages] = useState([]); // {role, text, id, selected, loading, streaming, steps, error}
  const [thinkingExpanded, setThinkingExpanded] = useState({}); // {msgId: bool}
  const [composerHidden, setComposerHidden] = useState(false);
  const [contextType, setContextType] = useState('');
  const [contextValue, setContextValue] = useState('');
  const [input, setInput] = useState('');
  const [final, setFinal] = useState('');
  const [tgTarget, setTgTarget] = useState(() => localStorage.getItem('agent_chat_tg_target') || '');

  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  // Mutable mirror of `messages` so the streaming-event callback can read the
  // latest state without re-creating the stream's onEvent every render.
  const messagesStateRef = useRef([]);
  useEffect(() => { messagesStateRef.current = messages; }, [messages]);

  // ── Suggestions (fetched once on mount, non-blocking) ──────────────────────
  const { data: suggestionsData } = useQuery({
    queryKey: ['agent-chat-suggestions'],
    queryFn: () => api('/api/chatbot/suggestions'),
    staleTime: 5 * 60 * 1000,
  });
  const suggestionsInfo = suggestionsData?.status === 'ok' ? suggestionsData.informative || [] : [];
  const suggestionsAnalytical = suggestionsData?.status === 'ok' ? suggestionsData.analytical || [] : [];

  // ── Session boot ───────────────────────────────────────────────────────────
  const startSession = useCallback(async (notify = false) => {
    setStatus({ state: 'connecting', label: 'Connecting…' });
    const res = await api('/api/chatbot/start', {});
    if (res.status === 'ok') {
      setSessionId(res.session_id);
      setStatus({ state: 'ready', label: 'Ready' });
      if (notify) showNotification('New conversation started', 'info');
    } else {
      setStatus({ state: 'error', label: 'Connection failed' });
      showNotification('Failed to start chat session: ' + (res.message || ''), 'error');
    }
  }, [showNotification]);

  useEffect(() => {
    startSession(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // End session on unmount
  useEffect(() => {
    return () => {
      // closure captures latest sessionId via state ref pattern
      if (sessionIdRef.current) {
        api('/api/chatbot/end', { session_id: sessionIdRef.current });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sessionIdRef = useRef(null);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // Auto-scroll on new content
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  // ── SSE stream wiring ──────────────────────────────────────────────────────
  const onEvent = useCallback((evt) => {
    setMessages((prev) => {
      const replyId = streamingReplyIdRef.current;
      if (replyId == null) return prev;
      const idx = prev.findIndex((m) => m.id === replyId);
      if (idx < 0) return prev;

      const next = prev.slice();
      const m = { ...next[idx] };

      if (m.loading) {
        m.loading = false;
        m.streaming = true;
      }

      if (evt.type === 'step') {
        m.steps = [...(m.steps || []), evt];
      } else if (evt.type === 'delta') {
        m.text = (m.text || '') + (evt.content || '');
      } else if (evt.type === 'done') {
        m.text = evt.content || m.text;
        m.streaming = false;
      } else if (evt.type === 'error') {
        // Drop the placeholder message — caller side will toast / banner
        if (evt.limit_reached) {
          planBadgeRef.current?.showLimit(evt.message);
        } else {
          showNotification(evt.message || 'Agent error', 'error');
        }
        return prev.filter((x) => x.id !== replyId);
      } else {
        return prev;
      }

      next[idx] = m;
      return next;
    });
  }, [showNotification]);

  const { send: sendStream, cancel, streaming } = useChatStream({
    url: '/api/chatbot/stream',
    onEvent,
  });

  const streamingReplyIdRef = useRef(null);

  const handleSend = useCallback(async (text) => {
    if (!sessionId) {
      showNotification('No active session — click New Chat', 'error');
      return;
    }
    const message = (text ?? input).trim();
    if (!message) return;
    if (!text) {
      setInput('');
      // reset textarea height (we do it via the ref)
      if (inputRef.current) inputRef.current.style.height = 'auto';
    }

    const msgId = Date.now();
    const replyId = msgId + 1;
    streamingReplyIdRef.current = replyId;
    setMessages((m) => [
      ...m,
      { role: 'user', text: message, id: msgId, selected: false },
      { role: 'assistant', text: '', steps: [], id: replyId, selected: false, loading: true, streaming: false },
    ]);

    setStatus({ state: 'thinking', label: 'Thinking…' });

    const payload = { session_id: sessionId, message };
    if (contextType && contextValue) {
      payload.context = { type: contextType, value: contextValue };
    }

    const result = await sendStream(payload);

    streamingReplyIdRef.current = null;
    setStatus({ state: 'ready', label: 'Ready' });

    if (result.aborted) {
      // User cancelled — keep partial content; drop placeholder if empty
      setMessages((prev) => {
        const m = prev.find((x) => x.id === replyId);
        if (!m) return prev;
        if (!m.text) return prev.filter((x) => x.id !== replyId);
        return prev.map((x) => (x.id === replyId ? { ...x, loading: false, streaming: false } : x));
      });
    } else if (!result.ok) {
      setMessages((prev) => prev.filter((x) => x.id !== replyId));
      showNotification('Connection error. Please try again.', 'error');
    } else {
      // Successful stream — bump usage counter
      planBadgeRef.current?.decrement();
    }

    setTimeout(() => inputRef.current?.focus(), 0);
  }, [sessionId, input, contextType, contextValue, sendStream, showNotification]);

  const handleReset = async () => {
    cancel(); // abort active stream if any
    if (sessionId) {
      api('/api/chatbot/end', { session_id: sessionId });
    }
    setSessionId(null);
    setMessages([]);
    setThinkingExpanded({});
    setContextType('');
    setContextValue('');
    setFinal('');
    await startSession(true);
  };

  const toggleThinking = (msgId) => {
    setThinkingExpanded((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  // ── Composer / selection ───────────────────────────────────────────────────
  const toggleSelect = (id, checked) => {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, selected: checked } : x)));
  };
  const selectAll = () => {
    setMessages((m) => m.map((x) => (
      x.role === 'assistant' && !x.loading && !x.error && !x.streaming
        ? { ...x, selected: true } : x
    )));
  };
  const deselectAll = () => {
    setMessages((m) => m.map((x) => ({ ...x, selected: false })));
  };
  const merge = () => {
    const selected = messages.filter((m) => m.selected && m.role === 'assistant');
    if (!selected.length) return showNotification('Select at least one response to merge.', 'error');
    setComposerHidden(false);
    setFinal(selected.map((m) => m.text).join('\n\n---\n\n'));
    showNotification(`Merged ${selected.length} response(s)`, 'success');
  };

  const copyFinal = () => {
    if (!final) return showNotification('Nothing to copy', 'error');
    navigator.clipboard.writeText(final).then(
      () => showNotification('Copied to clipboard', 'success'),
      () => showNotification('Copy failed', 'error')
    );
  };

  const refine = async () => {
    const t = final.trim();
    if (!t) return showNotification('Nothing to refine — merge some responses first.', 'error');
    showNotification('Refining…', 'info');
    const res = await api('/api/chatbot/refine', { text: t });
    if (res.status === 'ok') {
      setFinal(res.result);
      showNotification('Message refined', 'success');
    } else {
      showNotification(res.message || 'Refine failed', 'error');
    }
  };

  const sendTelegram = async () => {
    const text = final.trim();
    const target = tgTarget.trim();
    if (!text) return showNotification('Nothing to send — compose a message first.', 'error');
    if (!target) return showNotification('Enter a Telegram target (@channel or chat ID).', 'error');
    localStorage.setItem('agent_chat_tg_target', target);
    const res = await api('/api/chatbot/send-telegram', { text, target });
    if (res.status === 'ok') {
      showNotification(`Sent to ${target}`, 'success');
    } else {
      showNotification(res.message || 'Failed to send', 'error');
    }
  };

  const selectedCount = messages.filter((m) => m.selected).length;

  return (
    <div className="page active">
      <div className="agent-chat-layout">
        {/* Left: Chat panel */}
        <div className="agent-chat-panel">
          <div className="agent-chat-header">
            <div className="agent-chat-header-left">
              <div className="agent-chat-avatar-sm">AI</div>
              <div>
                <h3>Agent Chat</h3>
                <span className={`agent-chat-status agent-chat-status-${status.state}`}>
                  <span className="agent-chat-status-dot" /> {status.label}
                </span>
              </div>
            </div>
            <div><PlanBadge ref={planBadgeRef} /></div>
            <div className="agent-chat-header-actions">
              <button
                className="agent-chat-icon-btn"
                onClick={() => setComposerHidden((h) => !h)}
                title="Toggle composer"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>
              <button
                className="agent-chat-icon-btn"
                onClick={handleReset}
                title="New conversation"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
              </button>
            </div>
          </div>

          <div className="agent-chat-messages" ref={messagesRef}>
            {messages.length === 0 ? (
              <Welcome
                infoQs={suggestionsInfo}
                analyticalQs={suggestionsAnalytical}
                onPick={handleSend}
              />
            ) : (
              messages.map((m) => (
                <AgentMessage
                  key={m.id}
                  msg={m}
                  thinkingOpen={!!thinkingExpanded[m.id]}
                  onToggleThinking={() => toggleThinking(m.id)}
                  onToggleSelect={toggleSelect}
                  onChipClick={handleSend}
                  onWriteOwn={() => inputRef.current?.focus()}
                />
              ))
            )}
          </div>

          <div className="agent-chat-input-bar">
            <ContextBar
              type={contextType}
              value={contextValue}
              setType={(t) => { setContextType(t); setContextValue(''); }}
              setValue={setContextValue}
            />
            <div className="agent-chat-compose">
              <textarea
                ref={inputRef}
                className="input agent-chat-textarea"
                rows={1}
                placeholder="Message Agent Chat…"
                value={input}
                disabled={streaming}
                onChange={(e) => setInput(e.target.value)}
                onInput={(e) => {
                  e.currentTarget.style.height = 'auto';
                  e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 120) + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              {!streaming && (
                <button
                  className="agent-chat-send-btn"
                  onClick={() => handleSend()}
                  title="Send message"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              )}
              {streaming && (
                <button
                  className="chat-cancel-btn"
                  onClick={cancel}
                  title="Stop generating"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right: Composer panel */}
        <div className={`agent-chat-composer${composerHidden ? ' agent-chat-composer-hidden' : ''}`}>
          <div className="agent-chat-composer-header">
            <h3>Message Composer</h3>
            <span className="text-muted agent-chat-selected-count">{selectedCount} selected</span>
          </div>
          <div className="agent-chat-composer-actions">
            <button className="btn btn-secondary btn-sm" onClick={selectAll}>Select All</button>
            <button className="btn btn-secondary btn-sm" onClick={deselectAll}>Deselect All</button>
            <button className="btn btn-primary btn-sm" onClick={merge}>Merge Selected</button>
          </div>
          <div className="agent-chat-composer-body">
            <textarea
              className="input agent-chat-final-textarea"
              rows={12}
              placeholder="Select chat responses and click 'Merge Selected' to build your message here…"
              value={final}
              onChange={(e) => setFinal(e.target.value)}
            />
          </div>
          <div className="agent-chat-tg-bar">
            <input
              type="text"
              className="input"
              placeholder="@channel or chat ID"
              style={{ flex: 1, fontSize: 13 }}
              value={tgTarget}
              onChange={(e) => setTgTarget(e.target.value)}
            />
            <button className="btn btn-primary btn-sm" onClick={sendTelegram}>📤 Send to Telegram</button>
          </div>
          <div className="agent-chat-composer-footer">
            <button className="btn btn-secondary btn-sm" onClick={copyFinal}>📋 Copy</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setFinal('')}>🗑️ Clear</button>
            <button className="btn btn-primary btn-sm" onClick={refine}>✨ Refine with AI</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome / suggestions
// ─────────────────────────────────────────────────────────────────────────────

function Welcome({ infoQs, analyticalQs, onPick }) {
  const hasAI = infoQs.length || analyticalQs.length;
  return (
    <div className="ac-welcome">
      <div className="ac-welcome-avatar">AI</div>
      <h2 className="ac-welcome-title">What can I help you with?</h2>
      <p className="ac-welcome-sub">I have access to your news data, summaries, and YouTube analytics.</p>
      {hasAI ? (
        <div className="ac-ai-suggestions">
          <SuggestionGroup label="Informative" icon="ℹ️" questions={infoQs} onPick={onPick} />
          <SuggestionGroup label="Analytical" icon="📊" questions={analyticalQs} onPick={onPick} />
        </div>
      ) : (
        <div className="ac-ai-suggestions">
          <div className="ac-ai-suggestions-list">
            <div className="ac-ai-suggestion-skeleton" />
            <div className="ac-ai-suggestion-skeleton" style={{ width: '70%' }} />
            <div className="ac-ai-suggestion-skeleton" style={{ width: '60%' }} />
          </div>
        </div>
      )}
      <div className="ac-welcome-cards">
        <WelcomeCard icon="📰" title="News Summaries"  desc="Browse and analyze recent summary reports"  onClick={() => onPick('What are the latest news summaries?')} />
        <WelcomeCard icon="📈" title="Topic Trends"    desc="Track message volumes and topic activity"    onClick={() => onPick('Show topic trends for the last 7 days')} />
        <WelcomeCard icon="🎬" title="YouTube Analysis" desc="Video summaries from tracked keywords"      onClick={() => onPick('What YouTube videos were processed today?')} />
        <WelcomeCard icon="🔍" title="Search Messages" desc="Find specific messages by topic or source"   onClick={() => onPick('Search messages about the latest events from the past 3 days')} />
      </div>
    </div>
  );
}

function SuggestionGroup({ label, icon, questions, onPick }) {
  if (!questions.length) return null;
  return (
    <div className="ac-ai-group">
      <div className="ac-ai-suggestions-label">{icon} {label}</div>
      <div className="ac-ai-suggestions-list">
        {questions.map((q, i) => (
          <button key={i} className="ac-ai-suggestion" onClick={() => onPick(q)}>{q}</button>
        ))}
      </div>
    </div>
  );
}

function WelcomeCard({ icon, title, desc, onClick }) {
  return (
    <div className="ac-welcome-card" onClick={onClick}>
      <div className="ac-welcome-card-icon">{icon}</div>
      <div className="ac-welcome-card-title">{title}</div>
      <div className="ac-welcome-card-desc">{desc}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Context selector
// ─────────────────────────────────────────────────────────────────────────────

function ContextBar({ type, value, setType, setValue }) {
  const options = useContextOptions(type);
  return (
    <div className="ac-context-bar">
      <select
        className="input ac-context-select"
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        {CONTEXT_TYPES.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <select
        className="input ac-context-select ac-context-value-select"
        value={value}
        disabled={!type || options.disabled}
        onChange={(e) => setValue(e.target.value)}
      >
        {!type && <option value="">— select above first —</option>}
        {type && options.placeholder && <option value="">{options.placeholder}</option>}
        {type && options.items.map((it) => (
          <option key={it} value={it}>{it}</option>
        ))}
      </select>
      {type && (
        <button
          className="ac-context-clear"
          onClick={() => { setType(''); setValue(''); }}
          title="Clear context"
        >✕</button>
      )}
    </div>
  );
}

function useContextOptions(type) {
  const { config } = useGlobalConfig();

  // YouTube channels / keywords are fetched lazily when needed.
  const ytChannelsQuery = useQuery({
    queryKey: ['yt-channels'],
    queryFn: () => api('/api/youtube/channels'),
    enabled: type === 'yt-channel',
    staleTime: 60_000,
  });
  const ytKeywordsQuery = useQuery({
    queryKey: ['yt-keywords'],
    queryFn: () => api('/api/youtube/keywords'),
    enabled: type === 'yt-keyword',
    staleTime: 60_000,
  });

  return useMemo(() => {
    if (!type) return { items: [], placeholder: '', disabled: true };

    if (type === 'topic' || type === 'category') {
      const bots = (config && config.bots) || {};
      const items = new Set();
      for (const bot of Object.values(bots)) {
        for (const [catName, cat] of Object.entries(bot.categories || {})) {
          if (type === 'category') items.add(catName);
          else for (const tName of Object.keys(cat.topics || {})) items.add(tName);
        }
      }
      const list = [...items].sort();
      if (!list.length) return { items: [], placeholder: 'No items found', disabled: true };
      return { items: list, placeholder: `— choose ${type} —`, disabled: false };
    }

    if (type === 'yt-channel') {
      if (ytChannelsQuery.isLoading) return { items: [], placeholder: 'Loading…', disabled: true };
      const arr = (ytChannelsQuery.data?.status === 'ok' ? ytChannelsQuery.data.channels : []) || [];
      const list = arr.map((c) => c.channel_name || c.channel_id);
      if (!list.length) return { items: [], placeholder: 'No channels found', disabled: true };
      return { items: list, placeholder: '— choose channel —', disabled: false };
    }

    if (type === 'yt-keyword') {
      if (ytKeywordsQuery.isLoading) return { items: [], placeholder: 'Loading…', disabled: true };
      const arr = (ytKeywordsQuery.data?.status === 'ok' ? ytKeywordsQuery.data.keywords : []) || [];
      const list = arr.map((k) => k.keyword || k.query);
      if (!list.length) return { items: [], placeholder: 'No keywords found', disabled: true };
      return { items: list, placeholder: '— choose keyword —', disabled: false };
    }

    return { items: [], placeholder: '', disabled: true };
  }, [type, config, ytChannelsQuery.isLoading, ytChannelsQuery.data, ytKeywordsQuery.isLoading, ytKeywordsQuery.data]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Message rendering
// ─────────────────────────────────────────────────────────────────────────────

function AgentMessage({ msg, thinkingOpen, onToggleThinking, onToggleSelect, onChipClick, onWriteOwn }) {
  if (msg.role === 'user') {
    return (
      <div className="ac-msg ac-msg-user">
        <div className="ac-msg-bubble ac-msg-bubble-user">{msg.text}</div>
      </div>
    );
  }

  const checkable = !msg.loading && !msg.streaming && !msg.error;
  const agentLabel = msg.loading ? 'Thinking…' : msg.streaming ? 'Working…' : 'Agent';

  return (
    <div className={`ac-msg ac-msg-ai ${msg.selected ? 'ac-msg-selected' : ''}`} data-msg-id={msg.id}>
      <div className="ac-msg-avatar">AI</div>
      <div className="ac-msg-body">
        <div className="ac-msg-meta">
          {checkable && (
            <label className="ac-msg-check">
              <input
                type="checkbox"
                checked={!!msg.selected}
                onChange={(e) => onToggleSelect(msg.id, e.target.checked)}
              />
            </label>
          )}
          <span className="ac-msg-agent-label">{agentLabel}</span>
        </div>
        <div className={`ac-msg-bubble ac-msg-bubble-ai ${msg.error ? 'ac-msg-bubble-error' : ''}`}>
          <BubbleInner
            msg={msg}
            thinkingOpen={thinkingOpen}
            onToggleThinking={onToggleThinking}
            onChipClick={onChipClick}
            onWriteOwn={onWriteOwn}
          />
        </div>
      </div>
    </div>
  );
}

function BubbleInner({ msg, thinkingOpen, onToggleThinking, onChipClick, onWriteOwn }) {
  if (msg.loading) return <Skeleton />;

  const thoughts = (msg.steps || []).filter((s) => s.kind === 'reasoning');
  const actions = (msg.steps || []).filter((s) => s.kind !== 'reasoning');

  const hasThoughts = thoughts.length > 0;
  const stillThinking = msg.streaming && !msg.text && actions.length === 0 && !hasThoughts;
  const showThinking = hasThoughts || stillThinking;
  const isOpen = msg.streaming || thinkingOpen;

  // Trailing chips parsing
  const { mainText, chips } = parseTrailingChips(msg.text, msg.streaming);
  const html = msg.text ? formatMarkdown(mainText || msg.text) : '';

  return (
    <>
      {showThinking && (
        <div className={`ac-thinking-block${isOpen ? ' ac-thinking-open' : ''}`}>
          <button className="ac-thinking-header" onClick={onToggleThinking}>
            {(stillThinking || msg.streaming) ? (
              <>
                <span className="ac-thinking-pulse" />
                <span className="ac-thinking-title">Thinking…</span>
                {hasThoughts && (
                  <span className="ac-thinking-count">· {thoughts.length} step{thoughts.length > 1 ? 's' : ''}</span>
                )}
              </>
            ) : (
              <>
                <span className="ac-thinking-icon">💭</span>
                <span className="ac-thinking-title">Thought for a moment</span>
                {hasThoughts && (
                  <span className="ac-thinking-count">· {thoughts.length} step{thoughts.length > 1 ? 's' : ''}</span>
                )}
              </>
            )}
            <span className="ac-thinking-chevron">▼</span>
          </button>
          <div className={`ac-thinking-content${isOpen ? '' : ' ac-thinking-collapsed'}`}>
            {thoughts.map((t, i) => (
              <div key={i} className="ac-thought">{t.label}</div>
            ))}
          </div>
        </div>
      )}

      {actions.length > 0 && (
        <div className="ac-steps">
          {actions.map((s, i) => (
            <div key={i} className={`ac-step ac-step-${s.kind || 'tool'}`}>
              <span className="ac-step-icon">{s.icon}</span>
              <span className="ac-step-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {msg.text ? (
        <>
          <div
            className={`ac-content${msg.streaming ? ' ac-content-streaming' : ''}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {chips.length > 0 && (
            <div className="ac-option-chips">
              {chips.map((c, i) => (
                <button key={i} className="ac-option-chip" onClick={() => onChipClick(c)}>{c}</button>
              ))}
              <button className="ac-option-chip ac-option-chip-custom" onClick={onWriteOwn}>
                ✏️ Write my own…
              </button>
            </div>
          )}
        </>
      ) : (
        msg.streaming && !hasThoughts && actions.length === 0 && <Skeleton />
      )}
    </>
  );
}

function Skeleton() {
  return (
    <div className="ac-skeleton">
      <div className="ac-skeleton-line" style={{ width: '90%' }} />
      <div className="ac-skeleton-line" style={{ width: '75%' }} />
      <div className="ac-skeleton-line" style={{ width: '60%' }} />
    </div>
  );
}
