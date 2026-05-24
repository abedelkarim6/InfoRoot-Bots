import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { api, setUnauthorizedHandler } from '../lib/api';
import { keycloak, logout as kcLogout } from '../lib/keycloak';

const AuthContext = createContext(null);

/**
 * Auth context — thin wrapper over the keycloak-js singleton.
 *
 * Since main.jsx initializes Keycloak with onLoad: 'login-required' before
 * mounting React, by the time this provider renders the user is guaranteed
 * to be authenticated. This component only:
 *   - fetches the DB user record (role, plan, permissions) via /api/auth/me
 *   - exposes logout()
 *   - exposes the parsed Keycloak claims for convenience
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On a 401 from any API call, force a fresh Keycloak round-trip.
  useEffect(() => {
    setUnauthorizedHandler(() => keycloak.login());
  }, []);

  // Fetch the DB user record once. keycloak-js owns the token lifecycle from
  // here on; api() prepends a fresh Bearer on every request.
  useEffect(() => {
    let cancelled = false;
    api('/api/auth/me').then((res) => {
      if (cancelled) return;
      if (res && res.status !== 'error' && !res.error) {
        setUser(res.user || res);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const logout = useCallback(() => kcLogout(window.location.origin + '/'), []);

  const value = useMemo(() => ({
    token: keycloak.token,
    user,
    loading,
    isAuthenticated: !!keycloak.authenticated,
    isAdmin: user?.role === 'admin',
    username: keycloak.tokenParsed?.preferred_username,
    logout,
  }), [user, loading, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
