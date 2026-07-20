/**
 * TopBar — Figma-style header spanning the content area (right of the sidebar).
 *
 * Right-aligned cluster: global search (moved out of the sidebar), settings
 * gear (→ /profile), the notification bell, and the user avatar (→ /profile).
 * Sticky so it stays visible while scrolling. Hidden on chat pages (they own
 * the full viewport).
 */

import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import SidebarSearch from './SidebarSearch';
import NotificationBell from './NotificationBell';

export default function TopBar() {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();

  const initial = (user?.username || '?').trim().charAt(0).toUpperCase();

  return (
    <header className="top-bar">
      <div className="top-bar-right">
        <SidebarSearch />
        <button
          className="top-bar-iconbtn"
          title="Settings"
          onClick={() => navigate('/profile')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <NotificationBell persistent />
        <button
          className="top-bar-avatar"
          title={user?.username || 'Profile'}
          onClick={() => navigate('/profile')}
        >
          {initial}
          {isAdmin && <span className="top-bar-avatar-badge" title="Admin">✦</span>}
        </button>
      </div>
    </header>
  );
}
