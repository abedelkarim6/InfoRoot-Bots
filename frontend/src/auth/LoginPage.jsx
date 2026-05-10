import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import '../styles/login.css';

const MAX_ATTEMPTS = 5;

export default function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const userRef = useRef(null);
  const passRef = useRef(null);

  const [showPass, setShowPass] = useState(false);
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [lockedMsg, setLockedMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [locked, setLocked] = useState(false);

  // Already logged in? Bounce to the app.
  useEffect(() => {
    if (isAuthenticated) navigate('/', { replace: true });
  }, [isAuthenticated, navigate]);

  // Focus username on load.
  useEffect(() => {
    userRef.current?.focus();
  }, []);

  // Mark the body so login.css's `html,body { overflow:hidden }` block applies
  // only while this page is mounted. Remove on unmount so the rest of the app
  // can scroll normally.
  useEffect(() => {
    document.body.classList.add('auth-page');
    return () => document.body.classList.remove('auth-page');
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    const username = userRef.current.value.trim();
    const password = passRef.current.value;
    if (!username || !password) return;

    setSubmitting(true);
    setErrorMsg('');
    setLockedMsg('');

    const res = await login(username, password);

    if (res.ok) {
      setSuccess(true);
      setTimeout(() => navigate('/', { replace: true }), 600);
      return;
    }

    setSubmitting(false);

    if (res.status === 429) {
      setLocked(true);
      setLockedMsg(res.error || 'Too many attempts. Please wait.');
      setAttemptsUsed(MAX_ATTEMPTS);
      return;
    }

    const used = res.attempts_used !== undefined ? res.attempts_used : attemptsUsed + 1;
    setAttemptsUsed(used);
    setErrorMsg(res.error || 'Invalid credentials.');
    if (passRef.current) {
      passRef.current.value = '';
      passRef.current.focus();
    }
  }

  const attemptsLeft = MAX_ATTEMPTS - attemptsUsed;

  return (
    <>
      <div className="bg-orb orb-1" />
      <div className="bg-orb orb-2" />
      <div className="bg-grid" />

      <a className="back-link" href="https://stg.ibahsoun.com">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to Inforoot
      </a>

      <div className="login-wrap">
        <div className="card">
          <div className="brand">
            <div className="brand-icon">🤖</div>
            <div className="brand-info">
              <div className="brand-name">Inforoot AI Summaries Manager</div>
              <div className="brand-tag">v1.0 · Secure Access</div>
            </div>
          </div>

          <div className="divider" />

          <h2 className="card-title">Sign in to your workspace</h2>
          <p className="card-sub">Enter your credentials to continue.</p>

          <form onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="inp-user">Username</label>
              <input
                ref={userRef}
                type="text"
                id="inp-user"
                autoComplete="username"
                placeholder="Enter username"
                spellCheck={false}
                required
                disabled={locked}
              />
            </div>

            <div className="field">
              <label htmlFor="inp-pass">Password</label>
              <div className="pass-wrap">
                <input
                  ref={passRef}
                  type={showPass ? 'text' : 'password'}
                  id="inp-pass"
                  autoComplete="current-password"
                  placeholder="Enter password"
                  required
                  disabled={locked}
                />
                <button
                  type="button"
                  className="eye-btn"
                  onClick={() => setShowPass((s) => !s)}
                  title="Show / hide"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {showPass ? (
                      <>
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </>
                    ) : (
                      <>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
            </div>

            <div className={`attempts-row ${attemptsUsed > 0 || locked ? 'visible' : ''}`}>
              <div className="attempts-dots">
                {Array.from({ length: MAX_ATTEMPTS }).map((_, i) => (
                  <span
                    key={i}
                    className={`dot-attempt active${i < attemptsUsed ? ' used' : ''}`}
                  />
                ))}
              </div>
              <span className="attempts-label">
                {attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} remaining
              </span>
            </div>

            <div className={`alert alert-error ${errorMsg ? 'visible' : ''}`}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{errorMsg || 'Invalid credentials.'}</span>
            </div>

            <div className={`alert alert-locked ${lockedMsg ? 'visible' : ''}`}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>{lockedMsg || 'Account temporarily locked.'}</span>
            </div>

            <button
              type="submit"
              id="submit-btn"
              disabled={submitting || locked}
              className={success ? 'success' : locked ? 'locked-state' : ''}
            >
              <span>{success ? 'Access granted' : submitting ? 'Signing in…' : locked ? 'Locked' : 'Sign In'}</span>
              {submitting ? (
                <svg className="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              )}
            </button>
          </form>

          <p className="terms-consent" style={{ marginTop: 14 }}>
            Don't have an account? <a href="/register">Create one</a>
          </p>
          <p className="terms-consent">
            By using this service, you agree to our{' '}
            <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a> and{' '}
            <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
          </p>
          <p className="footer-note">🔒 Connection is secure and encrypted</p>
          <p className="copyright-note">© Inforoot.org. All rights reserved. Unauthorized copying of features or workflows may lead to legal action.</p>
        </div>
      </div>
    </>
  );
}
