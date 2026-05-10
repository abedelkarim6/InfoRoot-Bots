import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { api, getToken, setToken, clearToken, setUnauthorizedHandler } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(() => getToken());
  const [user, setUser] = useState(null); // { id, username, role, ... } from /api/auth/me
  const [loading, setLoading] = useState(Boolean(getToken()));

  // Wire the api() helper's 401 handler to logout + redirect.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      setTokenState(null);
      setUser(null);
      // Hard redirect — clears any in-flight UI.
      if (window.location.pathname !== '/login') {
        window.location.replace('/login');
      }
    });
  }, []);

  // Fetch the current user whenever the token changes.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api('/api/auth/me').then((res) => {
      if (cancelled) return;
      if (res && res.status !== 'error') {
        // Some endpoints return the user directly, others wrap it — handle both.
        setUser(res.user || res);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const login = useCallback(async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      setToken(data.token);
      setTokenState(data.token);
      return { ok: true };
    }
    return {
      ok: false,
      status: res.status,
      error: data.error || 'Login failed',
      attempts_used: data.attempts_used
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', {});
    } catch {
      /* ignore */
    }
    clearToken();
    setTokenState(null);
    setUser(null);
    window.location.replace('/login');
  }, []);

  const value = useMemo(
    () => ({
      token,
      user,
      loading,
      isAuthenticated: Boolean(token),
      isAdmin: user?.role === 'admin',
      login,
      logout
    }),
    [token, user, loading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
