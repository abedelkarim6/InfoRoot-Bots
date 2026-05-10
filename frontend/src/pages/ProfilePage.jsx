/**
 * Profile page — port of legacy `static/js/profile.js`.
 *
 * Combines what the legacy app split across two pages:
 *   - #profile-page    → account info, change name/password, AI usage (admin)
 *   - #tg-setup-page   → link/disconnect Telegram, OTP/code/2FA flow, dialogs
 *
 * The legacy Profile page only had a "Telegram Setup →" navigation link to a
 * separate route. Per task brief, the React Profile page renders the Telegram
 * section inline so users can manage everything in one place.
 *
 * Backend endpoints used:
 *   GET  /api/auth/me
 *   POST /api/auth/profile/change-username
 *   POST /api/auth/profile/change-password
 *   POST /api/auth/profile/disconnect-telegram
 *   POST /api/auth/profile/update-session            (admin power-user form)
 *   POST /api/auth/profile/gemini-keys               (per-user GCP projects)
 *   POST /api/auth/telegram/send-code
 *   POST /api/auth/telegram/verify-code
 *   POST /api/auth/telegram/verify-2fa
 *   GET  /api/system/gemini-usage                    (admin only)
 *   GET  /api/me/ai-usage
 *   GET  /api/telegram/userbot/me
 *   GET  /api/telegram/userbot/dialogs
 *   POST /api/telegram/session/test                  (admin only)
 *
 * Note: legacy errors come back as `{error: "..."}` (no `status` field).
 * `useApiMutation` checks `result.status !== 'ok'` so those still fail, but
 * the custom error message comes from `result.error` — we surface it via the
 * mutation's onError callback rather than the helper's default errorMsg.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApiMutation } from '../lib/useApiMutation';
import { useDialogs } from '../dialogs/DialogsProvider';
import PageHeader from '../components/PageHeader';

// ─────────────────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const { data: me, isLoading } = useQuery({
    queryKey: ['auth-me'],
    queryFn: () => api('/api/auth/me'),
  });

  const user = me && me.status !== 'error' ? me : null;
  const isAdmin = user?.role === 'admin';

  return (
    <div className="page active">
      <PageHeader title="Profile" subtitle="Your account settings" />

      {isLoading && <p className="text-muted">Loading…</p>}

      {!isLoading && !user && (
        <p style={{ color: 'var(--danger)' }}>Not authenticated.</p>
      )}

      {!isLoading && user && (
        <div style={{ maxWidth: 640 }}>
          <UserInfoCard user={user} />
          <TelegramSection user={user} />
          {/* Admin Gemini quota meters removed — single source of truth lives
              on /ai-usage. Profile only shows account / Telegram / plan info. */}
          <AiPlanCard />
          {!isAdmin && <ChangeUsernameCard user={user} />}
          {!isAdmin && <ChangePasswordCard />}
        </div>
      )}

      <ProfileStyles />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// User info card

function UserInfoCard({ user }) {
  const isAdmin = user.role === 'admin';
  const joinedDate = user.created_at
    ? new Date(user.created_at).toLocaleDateString()
    : '—';

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <div className="pf-avatar">
          {(user.username || '?')[0].toUpperCase()}
        </div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{user.username}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
            <span className={`pf-badge ${isAdmin ? 'pf-badge-admin' : 'pf-badge-user'}`}>
              {isAdmin ? '🔑 Admin' : '👤 User'}
            </span>
            {user.is_active !== false ? (
              <span className="pf-badge pf-badge-active">● Active</span>
            ) : (
              <span className="pf-badge pf-badge-inactive">○ Inactive</span>
            )}
            {!isAdmin && (
              <span className="pf-badge" style={{ opacity: 0.6 }}>
                Joined {joinedDate}
              </span>
            )}
          </div>
        </div>
      </div>

      {!isAdmin && (
        <div
          style={{
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
            paddingTop: 14,
            borderTop: '1px solid var(--border-color)',
          }}
        >
          <FeatureFlag label="📺 YouTube Summaries" on={user.youtube_on} />
          <FeatureFlag label="💬 Video Chat" on={user.yt_chat_on} />
          <FeatureFlag label="🤖 Agent Bot" on={user.agents_on} />
          <FeatureFlag label="🔧 System Bot" on={user.sys_bot_on} />
        </div>
      )}
    </div>
  );
}

function FeatureFlag({ label, on }) {
  return (
    <div className={`pf-flag ${on ? 'pf-flag-on' : ''}`}>
      {label} <strong>{on ? 'ON' : 'OFF'}</strong>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram section — link/disconnect, profile preview, channel list, OTP form

function TelegramSection({ user }) {
  const { showConfirm, showNotification } = useDialogs();
  const qc = useQueryClient();
  const isAdmin = user.role === 'admin';
  const hasTelegram = !!user.telegram_phone || !!user.telegram_session;

  const [linkOpen, setLinkOpen] = useState(false);
  const [testLogs, setTestLogs] = useState(null);
  const [testBusy, setTestBusy] = useState(false);

  // ── Live profile (telegram/userbot/me) ──
  const profileQ = useQuery({
    queryKey: ['tg-userbot-me'],
    queryFn: () => api('/api/telegram/userbot/me'),
    enabled: hasTelegram,
  });

  // ── Subscribed channels (admin only) ──
  const channelsQ = useQuery({
    queryKey: ['tg-userbot-dialogs'],
    queryFn: () => api('/api/telegram/userbot/dialogs'),
    enabled: hasTelegram && isAdmin,
  });

  const disconnect = useApiMutation('/api/auth/profile/disconnect-telegram', {
    invalidate: [['auth-me'], ['tg-userbot-me'], ['tg-userbot-dialogs']],
    successMsg: 'Telegram account disconnected',
    errorMsg: 'Disconnect failed',
  });

  function onDisconnect() {
    showConfirm(
      'Disconnect your Telegram account? You will no longer receive channel updates until you re-link.',
      () => disconnect.mutate({}),
      {
        title: 'Disconnect Telegram',
        icon: '🔌',
        confirmLabel: 'Disconnect',
        confirmClass: 'btn-danger',
      }
    );
  }

  async function onTestConnection() {
    setTestBusy(true);
    setTestLogs(['Connecting…']);
    const res = await api('/api/telegram/session/test', {});
    const logs = res?.logs || ['[ERROR] Request failed'];
    setTestLogs(logs);
    setTestBusy(false);
    if (res?.status === 'ok') {
      qc.invalidateQueries({ queryKey: ['tg-userbot-me'] });
    }
  }

  function onLinkSuccess() {
    setLinkOpen(false);
    qc.invalidateQueries({ queryKey: ['auth-me'] });
    qc.invalidateQueries({ queryKey: ['tg-userbot-me'] });
    qc.invalidateQueries({ queryKey: ['tg-userbot-dialogs'] });
    showNotification('Telegram account linked', 'success');
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 14,
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
          📱 Telegram Account
        </h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && hasTelegram && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={onTestConnection}
              disabled={testBusy}
            >
              {testBusy ? '⏳' : '🔌 Test'}
            </button>
          )}
          <button
            className={`btn ${hasTelegram ? 'btn-secondary' : 'btn-primary'} btn-sm`}
            onClick={() => setLinkOpen(true)}
          >
            {hasTelegram ? '🔄 Re-link' : '🔗 Link Telegram'}
          </button>
          {hasTelegram && (
            <button
              className="btn btn-danger btn-sm"
              onClick={onDisconnect}
              disabled={disconnect.isPending}
            >
              ✕ Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Profile snapshot */}
      <TelegramProfilePreview
        user={user}
        hasTelegram={hasTelegram}
        profileResult={profileQ.data}
        loading={profileQ.isLoading}
      />

      {/* Test logs */}
      {testLogs && (
        <div
          style={{
            marginTop: 10,
            background: 'var(--bg-secondary)',
            borderRadius: 6,
            padding: '8px 10px',
            fontFamily: 'monospace',
            fontSize: 11,
            maxHeight: 120,
            overflowY: 'auto',
          }}
        >
          {testLogs.map((line, i) => {
            const color = line.includes('[ERROR]')
              ? 'var(--danger)'
              : line.includes('[SUCCESS]')
                ? 'var(--success)'
                : 'var(--text-muted)';
            return (
              <div key={i} style={{ color }}>
                {line}
              </div>
            );
          })}
        </div>
      )}

      {/* Channel list (admin only) */}
      {isAdmin && hasTelegram && <TelegramChannelList result={channelsQ.data} />}

      {/* Link / re-link form */}
      {linkOpen && (
        <TelegramLinkForm
          onCancel={() => setLinkOpen(false)}
          onSuccess={onLinkSuccess}
        />
      )}

      {/* Admin: power-user direct session string update */}
      {isAdmin && <SessionStringForm user={user} />}
    </div>
  );
}

function TelegramProfilePreview({ user, hasTelegram, profileResult, loading }) {
  if (!hasTelegram) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>⚠️</span>
        <div>
          <div style={{ fontSize: 13, color: 'var(--warning)' }}>
            No Telegram account linked
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Link your account to enable monitoring
          </div>
        </div>
      </div>
    );
  }

  if (loading || !profileResult) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: 'var(--accent-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            color: '#fff',
            flexShrink: 0,
          }}
        >
          {(user.telegram_phone || '?')[0]}
        </div>
        <div>
          {user.telegram_phone && (
            <div style={{ fontSize: 14, fontWeight: 500 }}>
              {user.telegram_phone}
            </div>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Checking connection…
          </span>
        </div>
      </div>
    );
  }

  if (profileResult.status === 'ok') {
    const name = [profileResult.first_name, profileResult.last_name]
      .filter(Boolean)
      .join(' ');
    const initial = (profileResult.first_name || profileResult.username || '?')[0]
      .toUpperCase();
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'var(--accent-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 700,
            color: '#fff',
            flexShrink: 0,
          }}
        >
          {initial}
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {name || 'Unknown'}
          </div>
          {profileResult.username && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              @{profileResult.username}
            </div>
          )}
          {profileResult.phone && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              +{profileResult.phone}
            </div>
          )}
          <span
            style={{
              fontSize: 11,
              padding: '2px 7px',
              borderRadius: 8,
              background: 'rgba(16,185,129,.12)',
              border: '1px solid rgba(16,185,129,.3)',
              color: '#6ee7b7',
              marginTop: 5,
              display: 'inline-block',
            }}
          >
            ✅ Connected
          </span>
        </div>
      </div>
    );
  }

  if (profileResult.status === 'unauthorized') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--warning)',
          fontSize: 13,
        }}
      >
        <span>⚠️</span>
        <span>Session expired — please re-link your account</span>
      </div>
    );
  }

  if (profileResult.status === 'no_session') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--text-muted)',
          fontSize: 13,
        }}
      >
        <span>📵</span>
        <span>No session configured</span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: 'var(--warning)',
        fontSize: 13,
      }}
    >
      <span>⚠️</span>
      <span>
        Could not verify: {profileResult.message || 'unknown error'}
      </span>
    </div>
  );
}

function TelegramChannelList({ result }) {
  if (!result || result.status !== 'ok' || !result.channels?.length) return null;
  const channels = result.channels;
  return (
    <div
      style={{
        borderTop: '1px solid var(--border-color)',
        marginTop: 14,
        paddingTop: 14,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-muted)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '.04em',
        }}
      >
        📡 Subscribed Channels ({channels.length})
      </div>
      <div
        style={{
          maxHeight: 220,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {channels.map((ch, idx) => (
          <div
            key={ch.id ?? idx}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 8px',
              borderRadius: 6,
              background: 'var(--bg-secondary)',
              fontSize: 12,
            }}
          >
            <span>{ch.is_megagroup || ch.is_group ? '👥' : '📢'}</span>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div
                style={{
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {ch.title || ch.username || 'Unknown'}
              </div>
              {ch.username && (
                <div style={{ color: 'var(--text-muted)' }}>@{ch.username}</div>
              )}
            </div>
          </div>
        ))}
      </div>
      {result.updated_at && (
        <div
          style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}
        >
          Last refreshed: {new Date(result.updated_at).toLocaleString()}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram link/re-link state machine: phone → code → 2fa

const LINK_INITIAL = { step: 'phone', phone: '', error: '' };
function linkReducer(state, action) {
  switch (action.type) {
    case 'set_error':
      return { ...state, error: action.error || '' };
    case 'phone_sent':
      return { ...state, step: 'code', phone: action.phone, error: '' };
    case 'needs_2fa':
      return { ...state, step: '2fa', error: '' };
    case 'back_to_phone':
      return { ...state, step: 'phone', error: '' };
    case 'reset':
      return LINK_INITIAL;
    default:
      return state;
  }
}

function TelegramLinkForm({ onCancel, onSuccess }) {
  const [state, dispatch] = useReducer(linkReducer, LINK_INITIAL);
  const phoneRef = useRef(null);
  const codeRef = useRef(null);
  const twoFaRef = useRef(null);

  const [phoneInput, setPhoneInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [twoFaInput, setTwoFaInput] = useState('');

  const [busy, setBusy] = useState(false);

  // Focus the visible step's input
  useEffect(() => {
    if (state.step === 'phone') phoneRef.current?.focus();
    if (state.step === 'code') codeRef.current?.focus();
    if (state.step === '2fa') twoFaRef.current?.focus();
  }, [state.step]);

  async function sendCode() {
    const cleaned = phoneInput.replace(/[\s\-().]/g, '').replace(/^00/, '+');
    if (!cleaned) {
      dispatch({ type: 'set_error', error: 'Enter a phone number.' });
      return;
    }
    setBusy(true);
    const res = await api('/api/auth/telegram/send-code', { phone: cleaned });
    setBusy(false);
    if (res?.error) {
      dispatch({ type: 'set_error', error: res.error });
      return;
    }
    dispatch({ type: 'phone_sent', phone: cleaned });
    setCodeInput('');
  }

  async function verifyCode() {
    const code = codeInput.trim();
    if (!code) {
      dispatch({ type: 'set_error', error: 'Enter the code.' });
      return;
    }
    setBusy(true);
    const res = await api('/api/auth/telegram/verify-code', {
      phone: state.phone,
      code,
    });
    setBusy(false);
    if (res?.status === 'needs_2fa') {
      dispatch({ type: 'needs_2fa' });
      setTwoFaInput('');
      return;
    }
    if (res?.error) {
      dispatch({ type: 'set_error', error: res.error });
      return;
    }
    if (res?.status === 'ok') {
      onSuccess();
    }
  }

  async function verify2FA() {
    if (!twoFaInput) {
      dispatch({ type: 'set_error', error: 'Enter your 2FA password.' });
      return;
    }
    setBusy(true);
    const res = await api('/api/auth/telegram/verify-2fa', {
      phone: state.phone,
      password: twoFaInput,
    });
    setBusy(false);
    if (res?.error) {
      dispatch({ type: 'set_error', error: res.error });
      return;
    }
    if (res?.status === 'ok') {
      onSuccess();
    }
  }

  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 16,
        borderTop: '1px solid var(--border-color)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>
        Link a Telegram account via OTP
      </div>

      {state.step === 'phone' && (
        <div>
          <label className="form-label">Phone number (with country code)</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input
              ref={phoneRef}
              type="tel"
              className="input"
              placeholder="+1 234 567 8900"
              style={{ flex: 1 }}
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendCode();
              }}
              disabled={busy}
            />
            <button
              className="btn btn-primary"
              onClick={sendCode}
              disabled={busy}
            >
              {busy ? 'Sending…' : 'Send Code'}
            </button>
          </div>
          <div className="pf-err">{state.error}</div>
          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 10 }}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      )}

      {state.step === 'code' && (
        <div>
          <label className="form-label">
            Verification code sent to Telegram
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input
              ref={codeRef}
              type="text"
              className="input"
              placeholder="12345"
              maxLength={8}
              style={{ flex: 1, letterSpacing: '.15em' }}
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') verifyCode();
              }}
              disabled={busy}
            />
            <button
              className="btn btn-primary"
              onClick={verifyCode}
              disabled={busy}
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </div>
          <div className="pf-err">{state.error}</div>
          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 10 }}
            onClick={() => dispatch({ type: 'back_to_phone' })}
            disabled={busy}
          >
            ← Change number
          </button>
        </div>
      )}

      {state.step === '2fa' && (
        <div>
          <label className="form-label">
            Two-factor authentication password
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input
              ref={twoFaRef}
              type="password"
              className="input"
              placeholder="Your 2FA password"
              style={{ flex: 1 }}
              value={twoFaInput}
              onChange={(e) => setTwoFaInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') verify2FA();
              }}
              disabled={busy}
            />
            <button
              className="btn btn-primary"
              onClick={verify2FA}
              disabled={busy}
            >
              {busy ? 'Confirming…' : 'Confirm'}
            </button>
          </div>
          <div className="pf-err">{state.error}</div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct session-string update form (admin power-user)

function SessionStringForm({ user }) {
  const [sessionStr, setSessionStr] = useState('');
  const [phone, setPhone] = useState(user.telegram_phone || '');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const qc = useQueryClient();
  const { showNotification } = useDialogs();

  const update = useApiMutation('/api/auth/profile/update-session', {
    invalidate: [['auth-me'], ['tg-userbot-me'], ['tg-userbot-dialogs']],
    onSuccess: () => {
      setSessionStr('');
      setSuccess('Session saved!');
      setError('');
      setTimeout(() => setSuccess(''), 2500);
      showNotification('Session saved', 'success');
    },
    onError: (res) => {
      setError(res?.error || res?.message || 'Save failed');
      setSuccess('');
    },
  });

  function onSave() {
    setError('');
    setSuccess('');
    if (!sessionStr.trim()) {
      setError('Session string cannot be empty.');
      return;
    }
    update.mutate({ session_string: sessionStr.trim(), phone: phone.trim() });
  }

  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 16,
        borderTop: '1px solid var(--border-color)',
      }}
    >
      <details>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-muted)',
          }}
        >
          🛠️ Advanced: paste session string
        </summary>
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxWidth: 560,
          }}
        >
          <div>
            <label className="form-label">Phone (optional)</label>
            <input
              type="tel"
              className="input"
              style={{ marginTop: 4 }}
              placeholder="+1 234 567 8900"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label">Telethon session string</label>
            <textarea
              className="input"
              style={{ marginTop: 4, minHeight: 80, fontFamily: 'monospace' }}
              placeholder="1ApWapzMBu..."
              value={sessionStr}
              onChange={(e) => setSessionStr(e.target.value)}
            />
          </div>
          <div
            className="pf-err"
            style={{ color: success ? 'var(--success, #10b981)' : 'var(--danger)' }}
          >
            {error || success}
          </div>
          <button
            className="btn btn-primary"
            style={{ alignSelf: 'flex-start' }}
            onClick={onSave}
            disabled={update.isPending}
          >
            {update.isPending ? 'Saving…' : 'Save Session'}
          </button>
        </div>
      </details>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-user AI plan / monthly usage card

function AiPlanCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['me-ai-usage'],
    queryFn: () => api('/api/me/ai-usage'),
  });

  if (isLoading || !data || !data.has_plan) return null;

  const used = data.used ?? 0;
  const limit = data.limit ?? 0;
  const remaining = data.remaining ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const color =
    pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--success)';

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 14px' }}>
        📦 Your Plan
      </h3>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500 }}>{data.plan_name}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{remaining}</strong>{' '}
          left this month
        </span>
      </div>
      <div
        style={{
          background: 'var(--border)',
          borderRadius: 4,
          height: 6,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: 4,
            transition: 'width .4s',
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
        {used} of {limit} requests used
        {data.year_month ? ` · ${data.year_month}` : ''}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Change name (DB users only)

function ChangeUsernameCard({ user }) {
  const [value, setValue] = useState(user.username || '');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const qc = useQueryClient();

  const update = useApiMutation('/api/auth/profile/change-username', {
    invalidate: [['auth-me']],
    onSuccess: (res) => {
      setSuccess('Name updated successfully.');
      setError('');
      // Sidebar/avatar driven by auth context — invalidating auth-me refreshes
      // this page; the sidebar reads from useAuth() which re-fetches on token
      // change but not on me-refetch. Reload as a fallback to refresh nav.
      setTimeout(() => window.location.reload(), 600);
    },
    onError: (res) => {
      setError(res?.error || res?.message || 'Update failed');
      setSuccess('');
    },
  });

  function onSubmit() {
    setError('');
    setSuccess('');
    const newName = value.trim();
    if (newName.length < 3) {
      setError('Name must be at least 3 characters.');
      return;
    }
    update.mutate({ new_username: newName });
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 14px' }}>
        ✏️ Change Name
      </h3>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          maxWidth: 360,
        }}
      >
        <div>
          <label className="form-label">New name</label>
          <input
            type="text"
            className="input"
            style={{ marginTop: 4 }}
            placeholder="Your new display name"
            maxLength={40}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div
          className="pf-err"
          style={{ color: success ? 'var(--success, #10b981)' : 'var(--danger)' }}
        >
          {error || success}
        </div>
        <button
          className="btn btn-primary"
          style={{ alignSelf: 'flex-start' }}
          onClick={onSubmit}
          disabled={update.isPending}
        >
          {update.isPending ? 'Saving…' : 'Update Name'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Change password (DB users only)

function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const update = useApiMutation('/api/auth/profile/change-password', {
    onSuccess: () => {
      setSuccess('Password updated successfully.');
      setError('');
      setCurrent('');
      setNext('');
      setConfirm('');
    },
    onError: (res) => {
      setError(res?.error || res?.message || 'Update failed');
      setSuccess('');
    },
  });

  function onSubmit() {
    setError('');
    setSuccess('');
    if (!current) {
      setError('Enter your current password.');
      return;
    }
    if (next.length < 6) {
      setError('New password must be at least 6 characters.');
      return;
    }
    if (next !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    update.mutate({ current_password: current, new_password: next });
  }

  return (
    <div className="card">
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 14px' }}>
        🔒 Change Password
      </h3>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          maxWidth: 360,
        }}
      >
        <div>
          <label className="form-label">Current password</label>
          <input
            type="password"
            className="input"
            style={{ marginTop: 4 }}
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label">New password</label>
          <input
            type="password"
            className="input"
            style={{ marginTop: 4 }}
            placeholder="New password (min 6 chars)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label">Confirm new password</label>
          <input
            type="password"
            className="input"
            style={{ marginTop: 4 }}
            placeholder="Repeat new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <div
          className="pf-err"
          style={{ color: success ? 'var(--success, #10b981)' : 'var(--danger)' }}
        >
          {error || success}
        </div>
        <button
          className="btn btn-primary"
          style={{ alignSelf: 'flex-start' }}
          onClick={onSubmit}
          disabled={update.isPending}
        >
          {update.isPending ? 'Saving…' : 'Update Password'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy injected styles (.pf-avatar, .pf-badge, .pf-flag, .pf-err)

function ProfileStyles() {
  // Inline-render once, mirrors the legacy injectProfileStyles() IIFE.
  // Using <style> in JSX is safe and tied to component lifetime.
  return (
    <style>{`
      .pf-avatar {
        width:52px; height:52px; border-radius:50%; background:var(--accent-primary);
        color:#fff; display:flex; align-items:center; justify-content:center;
        font-size:22px; font-weight:700; flex-shrink:0;
      }
      .pf-badge {
        font-size:11px; padding:3px 8px; border-radius:10px;
        background:rgba(255,255,255,0.07); border:1px solid var(--border-color);
        color:var(--text-muted);
      }
      .pf-badge-admin  { background:rgba(139,92,246,.15); border-color:rgba(139,92,246,.35); color:#c4b5fd; }
      .pf-badge-user   { background:rgba(99,179,237,.12); border-color:rgba(99,179,237,.3);  color:#93c5fd; }
      .pf-badge-active { background:rgba(16,185,129,.12); border-color:rgba(16,185,129,.3);  color:#6ee7b7; }
      .pf-badge-inactive { background:rgba(239,68,68,.1); border-color:rgba(239,68,68,.25); color:#fca5a5; }
      .pf-flag {
        font-size:12px; padding:6px 12px; border-radius:8px;
        background:rgba(255,255,255,.04); border:1px solid var(--border-color);
        color:var(--text-muted);
      }
      .pf-flag-on {
        background:rgba(16,185,129,.08); border-color:rgba(16,185,129,.25); color:#6ee7b7;
      }
      .pf-err {
        font-size:12px; color:var(--danger); margin-top:6px; min-height:16px;
      }
    `}</style>
  );
}
