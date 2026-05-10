/**
 * Sign-up page (legacy `/register`). Three-step onboarding:
 *   1. Create account (username + password) → POST /api/auth/register
 *   2. Link Telegram (phone → OTP → optional 2FA)
 *   3. Done — go to the app
 *
 * The Telegram linking step is optional; users can skip and link later from
 * their Profile page.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../lib/api';
import { useAuth } from './AuthContext';
import '../styles/login.css';

const initialLink = { step: 'phone', phone: '', error: '' };

function linkReducer(state, action) {
  switch (action.type) {
    case 'set_phone':  return { ...state, phone: action.value, error: '' };
    case 'go_otp':     return { ...state, step: 'otp', error: '' };
    case 'go_2fa':     return { ...state, step: '2fa', error: '' };
    case 'back_phone': return { ...state, step: 'phone', error: '' };
    case 'error':      return { ...state, error: action.message };
    default:           return state;
  }
}

export default function RegisterPage() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);          // 1 = account, 2 = telegram, 3 = done
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [accountErr, setAccountErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const userRef = useRef(null);

  // If already logged in, bounce away.
  useEffect(() => {
    if (isAuthenticated && step !== 2 && step !== 3) {
      navigate('/', { replace: true });
    }
  }, [isAuthenticated, navigate, step]);

  useEffect(() => {
    userRef.current?.focus();
  }, []);

  // Same as LoginPage — scope login.css's body-overflow rules to this route.
  useEffect(() => {
    document.body.classList.add('auth-page');
    return () => document.body.classList.remove('auth-page');
  }, []);

  async function submitAccount(e) {
    e.preventDefault();
    setAccountErr('');
    if (pw !== pw2) {
      setAccountErr('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password: pw })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
        setToken(data.token);
        setStep(2);
      } else {
        setAccountErr(data.error || 'Registration failed.');
      }
    } catch {
      setAccountErr('Connection error — check server status.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="bg-orb orb-1" />
      <div className="bg-orb orb-2" />
      <div className="bg-grid" />

      <div className="login-wrap">
        <div className="card">
          <div className="brand">
            <div className="brand-icon">🤖</div>
            <div className="brand-info">
              <div className="brand-name">Inforoot AI Summaries Manager</div>
              <div className="brand-tag">Create your account</div>
            </div>
          </div>
          <div className="divider" />

          <div className="progress-dots" style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 16 }}>
            {[1, 2, 3].map((i) => (
              <span
                key={i}
                className={`progress-dot${i < step ? ' done' : i === step ? ' active' : ''}`}
                style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: i <= step ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                  display: 'inline-block'
                }}
              />
            ))}
          </div>

          {step === 1 && (
            <>
              <h2 className="card-title">Create your account</h2>
              <p className="card-sub">Pick a username and a strong password.</p>
              <form onSubmit={submitAccount}>
                <div className="field">
                  <label htmlFor="reg-user">Username</label>
                  <input
                    ref={userRef}
                    id="reg-user"
                    type="text"
                    autoComplete="username"
                    placeholder="Pick a username"
                    spellCheck={false}
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="reg-pass">Password</label>
                  <input
                    id="reg-pass"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    required
                    minLength={8}
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="reg-pass2">Confirm password</label>
                  <input
                    id="reg-pass2"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Re-type password"
                    required
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                  />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                  <input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} />
                  Show passwords
                </label>

                <div className={`alert alert-error ${accountErr ? 'visible' : ''}`}>
                  <span>{accountErr || 'Registration failed.'}</span>
                </div>

                <button type="submit" disabled={submitting}>
                  <span>{submitting ? 'Creating…' : 'Create Account'}</span>
                </button>
              </form>

              <p className="terms-consent" style={{ marginTop: 14 }}>
                Already have an account?{' '}
                <a href="/login">Sign in</a>
              </p>
            </>
          )}

          {step === 2 && (
            <TelegramLinkStep
              onDone={() => setStep(3)}
              onSkip={() => navigate('/', { replace: true })}
            />
          )}

          {step === 3 && (
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <h2 className="card-title">🎉 You're all set</h2>
              <p className="card-sub">Your account is ready and Telegram is linked.</p>
              <button onClick={() => navigate('/', { replace: true })} style={{ marginTop: 12 }}>
                <span>Open the app</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function TelegramLinkStep({ onDone, onSkip }) {
  const [state, dispatch] = useReducer(linkReducer, initialLink);
  const [code, setCode] = useState('');
  const [pw2fa, setPw2fa] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function sendCode(e) {
    e?.preventDefault?.();
    if (!state.phone.trim()) {
      dispatch({ type: 'error', message: 'Please enter your phone number.' });
      return;
    }
    setSubmitting(true);
    const res = await api('/api/auth/telegram/send-code', { phone: state.phone.trim() });
    setSubmitting(false);
    if (res?.status === 'ok' || res?.phone_code_hash || res?.code_sent) {
      dispatch({ type: 'go_otp' });
    } else {
      dispatch({ type: 'error', message: res?.error || res?.message || 'Failed to send code.' });
    }
  }

  async function verifyCode(e) {
    e?.preventDefault?.();
    if (!code.trim()) {
      dispatch({ type: 'error', message: 'Please enter the verification code.' });
      return;
    }
    setSubmitting(true);
    const res = await api('/api/auth/telegram/verify-code', { phone: state.phone.trim(), code: code.trim() });
    setSubmitting(false);
    if (res?.status === 'needs_2fa') {
      dispatch({ type: 'go_2fa' });
    } else if (res?.status === 'ok') {
      onDone();
    } else {
      dispatch({ type: 'error', message: res?.error || res?.message || 'Invalid code.' });
    }
  }

  async function verify2fa(e) {
    e?.preventDefault?.();
    if (!pw2fa) {
      dispatch({ type: 'error', message: 'Please enter your 2FA password.' });
      return;
    }
    setSubmitting(true);
    const res = await api('/api/auth/telegram/verify-2fa', { phone: state.phone.trim(), password: pw2fa });
    setSubmitting(false);
    if (res?.status === 'ok') {
      onDone();
    } else {
      dispatch({ type: 'error', message: res?.error || res?.message || 'Incorrect password.' });
    }
  }

  return (
    <>
      <h2 className="card-title">Link Telegram</h2>
      <p className="card-sub">
        We need your Telegram session to receive and forward messages on your behalf.
      </p>

      {state.step === 'phone' && (
        <form onSubmit={sendCode}>
          <div className="field">
            <label htmlFor="tg-phone">Phone (with country code)</label>
            <input
              id="tg-phone"
              type="tel"
              placeholder="+961…"
              required
              value={state.phone}
              onChange={(e) => dispatch({ type: 'set_phone', value: e.target.value })}
            />
          </div>
          <div className={`alert alert-error ${state.error ? 'visible' : ''}`}>
            <span>{state.error || 'Failed.'}</span>
          </div>
          <button type="submit" disabled={submitting}>
            <span>{submitting ? 'Sending…' : 'Send Code'}</span>
          </button>
        </form>
      )}

      {state.step === 'otp' && (
        <form onSubmit={verifyCode}>
          <p className="card-sub" style={{ fontSize: 13 }}>
            Enter the code sent to <strong>{state.phone}</strong> via Telegram.
          </p>
          <div className="field">
            <label htmlFor="tg-otp">Verification code</label>
            <input
              id="tg-otp"
              type="text"
              inputMode="numeric"
              placeholder="12345"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className={`alert alert-error ${state.error ? 'visible' : ''}`}>
            <span>{state.error || 'Failed.'}</span>
          </div>
          <button type="submit" disabled={submitting}>
            <span>{submitting ? 'Verifying…' : 'Verify'}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => dispatch({ type: 'back_phone' })}
          >
            ← Use a different number
          </button>
        </form>
      )}

      {state.step === '2fa' && (
        <form onSubmit={verify2fa}>
          <p className="card-sub" style={{ fontSize: 13 }}>
            Your account has 2FA. Enter your Telegram cloud password.
          </p>
          <div className="field">
            <label htmlFor="tg-2fa">2FA password</label>
            <input
              id="tg-2fa"
              type="password"
              autoFocus
              value={pw2fa}
              onChange={(e) => setPw2fa(e.target.value)}
            />
          </div>
          <div className={`alert alert-error ${state.error ? 'visible' : ''}`}>
            <span>{state.error || 'Failed.'}</span>
          </div>
          <button type="submit" disabled={submitting}>
            <span>{submitting ? 'Confirming…' : 'Confirm'}</span>
          </button>
        </form>
      )}

      <button
        type="button"
        className="btn btn-secondary"
        style={{ marginTop: 14, width: '100%' }}
        onClick={onSkip}
      >
        Skip for now (link from Profile later)
      </button>
    </>
  );
}
