import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { login as kcLogin } from '../lib/keycloak';

export default function LoginPage() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/', { replace: true });
      return;
    }
    // Not authed → redirect to Keycloak. On return, /login is hit again, the
    // SSO check finds an active session, and the effect above bounces to /.
    kcLogin(window.location.origin + '/');
  }, [isAuthenticated, navigate]);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg, #0b0f1a)',
      color: 'var(--text, #e6e9ef)',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            width: 40,
            height: 40,
            margin: '0 auto 16px',
            border: '3px solid rgba(255,255,255,0.15)',
            borderTopColor: '#5b8def',
            borderRadius: '50%',
            animation: 'spin 0.9s linear infinite',
          }}
        />
        <p>Redirecting to sign in…</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
