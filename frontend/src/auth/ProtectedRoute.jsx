import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

const ADMIN_ONLY_PATHS = new Set([
  '/accounts',
  '/tg-tester',
  '/logs',
  '/ai-usage'
]);

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { isAuthenticated, isAdmin, loading, user } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Wait for /api/auth/me before letting admin-only pages render — otherwise a
  // non-admin could briefly see an admin page on first paint.
  if (loading || (isAuthenticated && !user)) {
    return (
      <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>
    );
  }

  const requiresAdmin = adminOnly || ADMIN_ONLY_PATHS.has(location.pathname);
  if (requiresAdmin && !isAdmin) {
    return <Navigate to="/" replace />;
  }

  return children;
}
