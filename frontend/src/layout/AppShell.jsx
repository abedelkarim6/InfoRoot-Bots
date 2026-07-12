import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import SysBotDrawer from './sysbot/SysBotDrawer';
import ErrorBoundary from '../components/ErrorBoundary';

const CHAT_PATHS = new Set(['/yt-chat', '/agent-chat']);

export default function AppShell() {
  const location = useLocation();
  const isChatPage = CHAT_PATHS.has(location.pathname);

  // Chat pages strip main-content padding (legacy parity).
  useEffect(() => {
    document.body.classList.toggle('chat-page-active', isChatPage);
  }, [isChatPage]);

  return (
    <>
      <Sidebar />
      <main className="main-content">
        {/* Chat pages own the full viewport — no top bar there. */}
        {!isChatPage && <TopBar />}
        <div className="content-wrap">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      {/* Floating System Bot — visible only when user.sys_bot_on is true */}
      <SysBotDrawer />
    </>
  );
}
