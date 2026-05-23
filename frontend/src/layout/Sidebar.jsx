import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useGlobalConfig } from '../config/ConfigProvider';
import SidebarSearch from './SidebarSearch';

const THEME_KEY = 'theme';
// Match the legacy localStorage keys so a user's saved sidebar state
// carries over from the old app. Different keys would silently revert the
// sidebar to the default (260px, expanded).
const COLLAPSED_KEY = 'sidebar-collapsed';
const WIDTH_KEY     = 'sidebar-width';

// Logo link target. Overridable per-environment via a gitignored .env.local on
// the server (VITE_SITE_URL=...). The fallback below is the staging URL, so a
// code push never changes what production renders — prod's .env.local wins at
// build time. Mirrors the import.meta.env pattern in lib/keycloak.js.
const SITE_URL = import.meta.env.VITE_SITE_URL || 'https://stg.ibahsoun.com';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

function applySidebarWidth(px) {
  document.documentElement.style.setProperty('--sidebar-width', px + 'px');
}

export default function Sidebar() {
  const { user, isAdmin, logout } = useAuth();
  const { config } = useGlobalConfig();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true');
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark');
  const sidebarRef = useRef(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Reflect collapsed state in the body class (legacy CSS reads it) and persist.
  useEffect(() => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem(COLLAPSED_KEY, collapsed ? 'true' : 'false');
    // When uncollapsing, restore the user's saved width so dragging carries over.
    if (!collapsed) {
      const saved = parseInt(localStorage.getItem(WIDTH_KEY), 10);
      if (saved && saved >= 180 && saved <= 520) applySidebarWidth(saved);
    }
  }, [collapsed]);

  // Apply the saved width once on mount (skip if collapsed — collapsed state
  // already overrides via .sidebar.collapsed CSS rules).
  useEffect(() => {
    if (collapsed) return;
    const saved = parseInt(localStorage.getItem(WIDTH_KEY), 10);
    if (saved && saved >= 180 && saved <= 520) applySidebarWidth(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag-to-resize on the right edge of the sidebar (matches legacy behavior).
  function startDrag(e) {
    if (collapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarRef.current?.offsetWidth || 260;
    function onMove(ev) {
      const w = Math.max(180, Math.min(520, startW + ev.clientX - startX));
      applySidebarWidth(w);
    }
    function onUp() {
      const finalW = sidebarRef.current?.offsetWidth || 260;
      localStorage.setItem(WIDTH_KEY, String(finalW));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Show/hide nav sections the same way the legacy app did (accounts.js
  // lines 33-50):
  //   - Admin sees everything regardless of per-user flags.
  //   - Regular users only see sections they have access to.
  const bots = config?.bots || {};
  const hasBots   = isAdmin || Boolean(user?.bots_on) || Boolean(user?.has_bot_access);
  const youtubeOn = isAdmin || Boolean(user?.youtube_on);
  const ytChatOn  = isAdmin || Boolean(user?.yt_chat_on);
  const agentsOn  = isAdmin || Boolean(user?.agents_on);
  const collectionsCount = Object.keys(config?.collections || {}).length;

  return (
    <aside
      className={`sidebar${collapsed ? ' collapsed' : ''}`}
      id="main-sidebar"
      ref={sidebarRef}
    >
      <div
        className="sidebar-resize-handle"
        onMouseDown={startDrag}
        title="Drag to resize"
      />
      <div className="sidebar-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="sidebar-title-wrap">
            <p className="version version-ai">AI</p>
            <a href={SITE_URL} className="sidebar-logo-link">
              <img src="/static_react/logo_dark.png" alt="Inforoot" className="sidebar-logo sidebar-logo-dark" />
              <img src="/static_react/logo_light.png" alt="Inforoot" className="sidebar-logo sidebar-logo-light" />
            </a>
          </div>
          <button
            className="sidebar-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '▶' : '◀'}
          </button>
        </div>
      </div>

      <SidebarSearch />

      <nav className="sidebar-nav">
        <NavItem to="/" icon="🔌" label="Main Dashboard" end />
        {/* Telegram Setup was a separate page in legacy; merged into Profile now. */}

        {hasBots && (
          <>
            <div className="nav-separator" />
            <span className="nav-section-label">Summaries</span>
            <NavItem to="/dashboard" icon="📊" label="Summaries Dashboard" />
            <NavItem to="/bots" icon="🤖" label="Summaries Bots" badge={Object.keys(bots).length} />
            <NavItem to="/seos" icon="🔍" label="SEOs" />
            <NavItem to="/monitor" icon="📡" label="Schedules Monitor" />
          </>
        )}


        {youtubeOn && (
          <>
            <div className="nav-separator" />
            <span className="nav-section-label">YouTube Reader</span>
            <NavItem to="/yt-videos" icon="📋" label="Youtube Dashboard" />
            <NavItem to="/yt-channels" icon="📺" label="Youtube Channels" />
            <NavItem to="/yt-keywords" icon="🔎" label="YouTube SEOs" />
            <NavItem to="/youtube-prompts" icon="📝" label="Youtube Prompts" />
          </>
        )}

        {(ytChatOn || agentsOn) && (
          <>
            <div className="nav-separator" />
            <span className="nav-section-label">AI Chatbots</span>
            {ytChatOn && <NavItem to="/yt-chat" icon="💬" label="Video Chat" />}
            {agentsOn && <NavItem to="/agent-chat" icon="🤖" label="Agent Bot" />}
          </>
        )}

        <div className="nav-separator" />
        <span className="nav-section-label">System</span>
        <NavItem to="/recycle-bin" icon="🗑️" label="Recycle Bin" />

        {isAdmin && (
          <>
            <div className="nav-separator" />
            <span className="nav-section-label">Admin</span>
            <NavItem to="/prompts" icon="🔒" label="Admin Prompts" />
            <NavItem to="/accounts" icon="👥" label="Access & Plans" />
            <NavItem to="/tg-tester" icon="🧪" label="TG Tester" />
            <NavItem to="/logs" icon="📋" label="Logs" />
            <NavItem to="/ai-usage" icon="⚡" label="AI Usage" />
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        <NavItem to="/profile" icon="👤" label={user?.username || 'Profile'} className="profile-link" />
        <div className="footer-status-row">
          <div className="system-status">
            <div className="status-indicator" />
            <span>System Online</span>
          </div>
          <button
            className="theme-toggle-btn"
            title="Switch theme"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          />
        </div>
        <button className="logout-btn" onClick={logout}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign Out
        </button>
        <p className="sidebar-copyright">
          © Inforoot.org. All rights reserved.<br />
          <a href="/terms" target="_blank" rel="noreferrer" className="sidebar-copyright-link">Terms of Service</a>{' '}·{' '}
          <a href="/privacy" target="_blank" rel="noreferrer" className="sidebar-copyright-link">Privacy Policy</a>
        </p>
      </div>
    </aside>
  );
}

function NavItem({ to, icon, label, badge, end, className = '' }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `nav-item ${className} ${isActive ? 'active' : ''}`.trim()}
    >
      <span className="icon">{icon}</span>
      <span>{label}</span>
      {badge != null && badge > 0 && <span className="badge">{badge}</span>}
    </NavLink>
  );
}
