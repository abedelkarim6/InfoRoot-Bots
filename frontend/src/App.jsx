import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';

import { AuthProvider } from './auth/AuthContext';
import ProtectedRoute from './auth/ProtectedRoute';
import { DialogsProvider } from './dialogs/DialogsProvider';
import { ConfigProvider } from './config/ConfigProvider';
import { queryClient } from './lib/queryClient';
import AppShell from './layout/AppShell';

import BotsPage from './pages/bots/BotsPage';
import MonitorPage from './pages/monitor/MonitorPage';

// Real (ported) pages — import directly so the placeholder in pages/index.jsx
// is not used. As more pages get ported in Phase 3 they move out of the
// placeholder export the same way.
import RecycleBinPage from './pages/RecycleBinPage';
import ProfilePage from './pages/ProfilePage';
import SystemPage from './pages/SystemPage';
import DashboardPage from './pages/DashboardPage';
import AccountsPage from './pages/AccountsPage';
import LogsPage from './pages/admin/LogsPage';
import AiUsagePage from './pages/admin/AiUsagePage';
import TgTesterPage from './pages/admin/TgTesterPage';
import YtVideosPage from './pages/youtube/VideosPage';
import YtChannelsPage from './pages/youtube/ChannelsPage';
import YtKeywordsPage from './pages/youtube/KeywordsPage';
import PromptsPage from './pages/PromptsPage';
import SummariesPromptsPage from './pages/SummariesPromptsPage';
import YoutubePromptsPage from './pages/YoutubePromptsPage';
import DefaultSchedulesPage from './pages/DefaultSchedulesPage';
import YtChatPage from './pages/chat/VideoChatPage';
import AgentChatPage from './pages/chat/AgentChatPage';
import LegalPage from './pages/LegalPage';

import './styles/modern.css';
import './styles/modern-injected.css';
import './styles/auto-save.css';
import './styles/react-overrides.css';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <DialogsProvider>
            <Routes>
              {/* /login and /register are gone — authentication is handled by
                  Keycloak. ProtectedRoute triggers the redirect to the Keycloak
                  hosted login page directly. */}
              <Route path="/terms" element={<LegalPage kind="terms" />} />
              <Route path="/privacy" element={<LegalPage kind="privacy" />} />
              {/* /app/* — legacy basename. Redirect anything that still uses it to root. */}
              <Route path="/app/*" element={<Navigate to="/" replace />} />

              <Route
                element={
                  <ProtectedRoute>
                    <ConfigProvider>
                      <AppShell />
                    </ConfigProvider>
                  </ProtectedRoute>
                }
              >
                <Route index element={<SystemPage />} />
                {/* tg-setup was a separate page in the legacy app; ProfilePage now
                    contains the Telegram link/disconnect flow, so redirect here. */}
                <Route path="tg-setup"     element={<Navigate to="/profile" replace />} />
                <Route path="dashboard"    element={<DashboardPage />} />
                {/* /collections removed — per-bot Sources/Destinations buttons replaced this page. */}
                <Route path="collections"  element={<Navigate to="/bots" replace />} />
                <Route path="bots"             element={<BotsPage />} />
                <Route path="bots/:botName"    element={<BotsPage />} />
                <Route path="prompts"            element={<PromptsPage />} />
                <Route path="summaries-prompts"  element={<SummariesPromptsPage />} />
                <Route path="youtube-prompts"    element={<YoutubePromptsPage />} />
                <Route path="default-schedules"  element={<DefaultSchedulesPage />} />
                <Route path="monitor"      element={<MonitorPage />} />
                <Route path="recycle-bin"  element={<RecycleBinPage />} />

                <Route path="yt-videos"    element={<YtVideosPage />} />
                <Route path="yt-channels"  element={<YtChannelsPage />} />
                <Route path="yt-keywords"  element={<YtKeywordsPage />} />
                <Route path="yt-chat"      element={<YtChatPage />} />
                <Route path="agent-chat"   element={<AgentChatPage />} />

                <Route path="profile"      element={<ProfilePage />} />

                {/* Admin-only — ProtectedRoute checks the path against ADMIN_ONLY_PATHS */}
                <Route path="accounts"     element={<ProtectedRoute adminOnly><AccountsPage /></ProtectedRoute>} />
                <Route path="tg-tester"    element={<ProtectedRoute adminOnly><TgTesterPage /></ProtectedRoute>} />
                <Route path="logs"         element={<ProtectedRoute adminOnly><LogsPage /></ProtectedRoute>} />
                <Route path="ai-usage"     element={<ProtectedRoute adminOnly><AiUsagePage /></ProtectedRoute>} />

                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </DialogsProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
