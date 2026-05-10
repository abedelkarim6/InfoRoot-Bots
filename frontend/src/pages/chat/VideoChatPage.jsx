/**
 * Video Chat page (`/yt-chat`).
 * Port of static/js/youtube.js → ytChat* functions and #yt-chat-page in index.html.
 *
 * Backend endpoints:
 *   POST /api/youtube/chat/start          — load a video, returns session
 *   POST /api/youtube/chat/send           — send a message, returns reply (NOT streaming)
 *   POST /api/youtube/chat/end            — end the session
 *   POST /api/youtube/chat/refine         — AI-polish merged text
 *   POST /api/youtube/chat/send-telegram  — push composed text to Telegram
 *
 * Layout matches the legacy two-column shell (`.yt-chat-layout`).
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../../lib/api';
import { useDialogs } from '../../dialogs/DialogsProvider';
import { formatMarkdown } from './chatHelpers';
import PlanBadge from './PlanBadge';

const SUGGESTIONS = [
  'Summarize this video',
  'List the key points',
  'What are the main takeaways?',
  'Extract facts and statistics',
];

export default function VideoChatPage() {
  const { showNotification } = useDialogs();
  const planBadgeRef = useRef(null);

  const [session, setSession] = useState(null); // { session_id, title, channel_name, thumbnail, video_id }
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]); // {role, text, id, selected, loading, error}
  const [pending, setPending] = useState(false);
  const [input, setInput] = useState('');
  const [final, setFinal] = useState('');
  const [tgTarget, setTgTarget] = useState(() => localStorage.getItem('yt_chat_tg_target') || '');
  const [showSuggestions, setShowSuggestions] = useState(true);

  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const urlInputRef = useRef(null);

  // Focus URL input on mount
  useEffect(() => {
    if (!session) urlInputRef.current?.focus();
  }, [session]);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  // End session on unmount (best-effort, fire-and-forget)
  useEffect(() => {
    return () => {
      if (session?.session_id) {
        api('/api/youtube/chat/end', { session_id: session.session_id });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadVideo = async () => {
    const u = url.trim();
    if (!u) return showNotification('Please enter a YouTube URL or video ID.', 'error');
    setLoading(true);

    // End previous session if any
    if (session?.session_id) {
      await api('/api/youtube/chat/end', { session_id: session.session_id });
    }

    const res = await api('/api/youtube/chat/start', { url: u });
    setLoading(false);

    if (res.status !== 'ok') {
      showNotification(res.message || 'Failed to load video', 'error');
      return;
    }

    setSession({
      session_id: res.session.session_id,
      title: res.session.title || res.session.video_id,
      channel_name: res.session.channel_name || '',
      thumbnail: res.session.thumbnail || '',
      video_id: res.session.video_id,
    });
    setMessages([]);
    setShowSuggestions(true);
    showNotification('Video loaded — start chatting!', 'success');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const resetVideo = async () => {
    if (session?.session_id) {
      await api('/api/youtube/chat/end', { session_id: session.session_id });
    }
    setSession(null);
    setMessages([]);
    setUrl('');
    setShowSuggestions(true);
  };

  const sendMessage = useCallback(async (text) => {
    if (!session?.session_id) {
      showNotification('No video loaded', 'error');
      return;
    }
    const message = (text ?? input).trim();
    if (!message) return;

    if (!text) setInput('');
    setShowSuggestions(false);

    const msgId = Date.now();
    const replyId = msgId + 1;
    setMessages((m) => [
      ...m,
      { role: 'user', text: message, id: msgId, selected: false },
      { role: 'assistant', text: '', id: replyId, selected: false, loading: true },
    ]);
    setPending(true);

    const res = await api('/api/youtube/chat/send', {
      session_id: session.session_id,
      message,
    });

    setPending(false);

    setMessages((m) => {
      if (res.status === 'ok') {
        return m.map((x) =>
          x.id === replyId ? { ...x, loading: false, text: res.reply } : x
        );
      }
      // Error — drop both placeholder + user (matches legacy behaviour)
      const filtered = m.filter((x) => x.id !== replyId && x.id !== msgId);
      if (res.limit_reached) {
        planBadgeRef.current?.showLimit(res.message);
      } else {
        showNotification(`Error: ${res.message || 'Failed to get response'}`, 'error');
      }
      return filtered;
    });

    if (res.status === 'ok') {
      planBadgeRef.current?.decrement();
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [session, input, showNotification]);

  // ── Composer / selection ──────────────────────────────────────────────────
  const toggleSelect = (id, checked) => {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, selected: checked } : x)));
  };
  const selectAll = () => {
    setMessages((m) => m.map((x) => (
      x.role === 'assistant' && !x.loading && !x.error ? { ...x, selected: true } : x
    )));
  };
  const deselectAll = () => {
    setMessages((m) => m.map((x) => ({ ...x, selected: false })));
  };
  const merge = () => {
    const selected = messages.filter((m) => m.selected && m.role === 'assistant');
    if (!selected.length) {
      showNotification('Select at least one response to merge.', 'error');
      return;
    }
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
    const res = await api('/api/youtube/chat/refine', { text: t });
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
    localStorage.setItem('yt_chat_tg_target', target);
    const res = await api('/api/youtube/chat/send-telegram', { text, target });
    if (res.status === 'ok') {
      showNotification(`Sent to ${target}`, 'success');
    } else {
      showNotification(res.message || 'Failed to send', 'error');
    }
  };

  const selectedCount = messages.filter((m) => m.selected).length;

  return (
    <div className="page active">
      <div className="yt-chat-layout">
        {/* Left: Chat panel */}
        <div className="yt-chat-panel">
          <div className="yt-chat-header">
            {!session && (
              <div className="yt-chat-video-input">
                <input
                  ref={urlInputRef}
                  type="text"
                  className="input"
                  placeholder="Paste YouTube URL or video ID…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') loadVideo(); }}
                />
                <button
                  className="btn btn-primary"
                  onClick={loadVideo}
                  disabled={loading}
                >
                  {loading ? 'Loading…' : 'Load Video'}
                </button>
              </div>
            )}
            <div style={{ padding: '6px 0 2px' }}>
              <PlanBadge ref={planBadgeRef} />
            </div>
            {session && (
              <div className="yt-chat-video-info" style={{ display: 'flex' }}>
                {session.thumbnail && (
                  <img className="yt-chat-thumb" src={session.thumbnail} alt="" />
                )}
                <div>
                  <div className="yt-chat-video-title">{session.title}</div>
                  <div className="yt-chat-video-channel text-muted">{session.channel_name}</div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={resetVideo}
                  title="Close video"
                >✕</button>
              </div>
            )}
          </div>

          <div className="yt-chat-messages" ref={messagesRef}>
            {messages.length === 0 ? (
              <div className="yt-chat-empty">
                <div className="yt-chat-empty-icon">💬</div>
                <p>Load a YouTube video to start chatting</p>
                <p className="text-muted">
                  Ask questions, generate summaries, extract key points — all using the video's content
                </p>
              </div>
            ) : (
              messages.map((m) => <YtMessage key={m.id} msg={m} onToggleSelect={toggleSelect} />)
            )}
          </div>

          {session && (
            <div className="yt-chat-input-bar">
              {showSuggestions && (
                <div className="yt-chat-suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className="yt-chat-suggestion"
                      onClick={() => sendMessage(s)}
                    >{s}</button>
                  ))}
                </div>
              )}
              <div className="yt-chat-compose">
                <textarea
                  ref={inputRef}
                  className="input yt-chat-textarea"
                  rows={1}
                  placeholder="Ask about the video…"
                  value={input}
                  disabled={pending}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                />
                <button
                  className="btn btn-primary yt-chat-send-btn"
                  onClick={() => sendMessage()}
                  disabled={pending}
                >Send</button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Composer panel */}
        <div className="yt-chat-composer">
          <div className="yt-chat-composer-header">
            <h3>Message Composer</h3>
            <span className="text-muted yt-chat-selected-count">{selectedCount} selected</span>
          </div>
          <div className="yt-chat-composer-actions">
            <button className="btn btn-secondary btn-sm" onClick={selectAll}>Select All</button>
            <button className="btn btn-secondary btn-sm" onClick={deselectAll}>Deselect All</button>
            <button className="btn btn-primary btn-sm" onClick={merge}>Merge Selected</button>
          </div>
          <div className="yt-chat-composer-body">
            <textarea
              className="input yt-chat-final-textarea"
              rows={12}
              placeholder="Select chat responses and click 'Merge Selected' to build your message here…"
              value={final}
              onChange={(e) => setFinal(e.target.value)}
            />
          </div>
          <div className="yt-chat-tg-bar">
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
          <div className="yt-chat-composer-footer">
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

function YtMessage({ msg, onToggleSelect }) {
  if (msg.role === 'user') {
    return (
      <div className="yt-chat-msg yt-chat-msg-user">
        <div className="yt-chat-msg-content">{msg.text}</div>
      </div>
    );
  }
  const checkable = !msg.loading && !msg.error;
  return (
    <div className={`yt-chat-msg yt-chat-msg-ai ${msg.selected ? 'yt-chat-msg-selected' : ''}`}>
      <div className="yt-chat-msg-header">
        {checkable && (
          <label className="yt-chat-msg-check">
            <input
              type="checkbox"
              checked={!!msg.selected}
              onChange={(e) => onToggleSelect(msg.id, e.target.checked)}
            />
          </label>
        )}
        {msg.loading && <span className="yt-chat-typing">Thinking…</span>}
      </div>
      <div className={`yt-chat-msg-content ${msg.error ? 'yt-chat-msg-error' : ''}`}>
        {msg.loading ? (
          <div className="yt-chat-dots"><span /><span /><span /></div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: formatMarkdown(msg.text, { breaks: true }) }} />
        )}
      </div>
    </div>
  );
}
