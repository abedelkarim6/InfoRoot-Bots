import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { api, setUnauthorizedHandler } from '../lib/api';
import {
  keycloak,
  isAuthenticated as kcIsAuthenticated,
  login as kcLogin,
  logout as kcLogout,
} from '../lib/keycloak';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Keycloak has already initialized in main.jsx before React mounts, so
  // keycloak.authenticated is authoritative on first render.
  const [authed, setAuthed] = useState(() => kcIsAuthenticated());
  const [user, setUser] = useState(null); // { id, username, role, ... } from /api/auth/me
  const [loading, setLoading] = useState(authed);

  // Keep `authed` in sync with Keycloak's own auth-state events.
  useEffect(() => {
    const sync = () => setAuthed(kcIsAuthenticated());
    const prevSuccess = keycloak.onAuthSuccess;
    const prevLogout = keycloak.onAuthLogout;
    keycloak.onAuthSuccess = () => { prevSuccess?.(); sync(); };
    keycloak.onAuthLogout = () => { prevLogout?.(); sync(); };
    return () => {
      keycloak.onAuthSuccess = prevSuccess;
      keycloak.onAuthLogout = prevLogout;
    };
  }, []);

  // Wire the api() helper's 401 handler to logout + redirect.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthed(false);
      setUser(null);
      kcLogout(window.location.origin + '/login');
    });
  }, []);

  // Fetch the DB user record (role, permissions, plan, etc.) whenever auth
  // flips on. The Keycloak JWT only tells us *who* — the backend tells us
  // *what they can do* based on the synced/auto-provisioned DB row.
  useEffect(() => {
    let cancelled = false;
    if (!authed) {
      setUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api('/api/auth/me').then((res) => {
      if (cancelled) return;
      if (res && res.status !== 'error') {
        setUser(res.user || res);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  const login = useCallback(async () => {
    // Full-page redirect to Keycloak. Returns here post-auth with tokens set
    // by keycloak-js, which fires onAuthSuccess → sync above.
    await kcLogin(window.location.origin + '/');
    return { ok: true };
  }, []);

  const logout = useCallback(async () => {
    setAuthed(false);
    setUser(null);
    await kcLogout(window.location.origin + '/login');
  }, []);

  const value = useMemo(
    () => ({
      token: keycloak.token,
      user,
      loading,
      isAuthenticated: authed,
      isAdmin: user?.role === 'admin',
      login,
      logout
    }),
    [authed, user, loading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
