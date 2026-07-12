import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

const ADMIN_ONLY_PATHS = new Set([
  '/accounts',
  '/tg-tester',
  '/logs',
  '/ai-usage',
  '/youtube-quota',
]);

/**
 * Authentication is handled entirely by keycloak-js (onLoad: 'login-required'
 * in main.jsx). By the time this component renders, the user is signed in.
 *
 * Responsibilities here are purely authorization:
 *   - wait for the DB user record (/api/auth/me) so role checks are reliable
 *   - block admin-only routes for non-admin users
 */
export default function ProtectedRoute({ children, adminOnly = false }) {
  const { isAdmin, loading, user } = useAuth();
  const location = useLocation();

  if (loading || !user) {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>;
  }

  const requiresAdmin = adminOnly || ADMIN_ONLY_PATHS.has(location.pathname);
  if (requiresAdmin && !isAdmin) {
    return <Navigate to="/" replace />;
  }

  return children;
}
