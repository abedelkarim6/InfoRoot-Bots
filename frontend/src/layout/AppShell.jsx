import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import SysBotDrawer from './sysbot/SysBotDrawer';
import NotificationBell from './NotificationBell';

const CHAT_PATHS = new Set(['/yt-chat', '/agent-chat']);

export default function AppShell() {
  const location = useLocation();

  // Chat pages strip main-content padding (legacy parity).
  useEffect(() => {
    document.body.classList.toggle('chat-page-active', CHAT_PATHS.has(location.pathname));
  }, [location.pathname]);

  return (
    <>
      <Sidebar />
      <main className="main-content">
        <NotificationBell />
        <Outlet />
      </main>
      {/* Floating System Bot — visible only when user.sys_bot_on is true */}
      <SysBotDrawer />
    </>
  );
}
