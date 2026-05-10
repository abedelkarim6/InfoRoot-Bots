/**
 * Bots — top-level page. Decides between the list view and the per-bot detail
 * view based on the URL.
 *
 * Routing parity with the legacy app:
 *   - /bots                → list view
 *   - /bots/<botName>      → detail view for that bot (preferred)
 *   - /bots?bot=<botName>  → detail view (legacy SystemPage links here, see
 *                            SystemPage.jsx — we honor it by promoting the
 *                            query param into the route on mount)
 *
 * Wiring note: this file owns ONLY the route shape + which sub-view renders.
 * Bot CRUD (create/rename/duplicate/delete) lives inside BotList / BasicSettings,
 * not here. That keeps the page surface tiny so the heavier tab content lives
 * close to its owning component (mirrors the legacy split across 5 files).
 */

import { useEffect } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useGlobalConfig } from '../../config/ConfigProvider';
import BotList from './BotList';
import BotDetail from './BotDetail';

export default function BotsPage() {
  const { botName } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { config, isLoading } = useGlobalConfig();

  // Legacy SystemPage links to /bots?bot=<name>. Promote the query param into
  // a route segment so refreshing/back-buttoning lands on the right view.
  const queryBot = searchParams.get('bot');
  useEffect(() => {
    if (!botName && queryBot) {
      navigate(`/bots/${encodeURIComponent(queryBot)}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryBot, botName]);

  if (botName) {
    // If config is loaded and the bot doesn't exist, drop to the list — matches
    // legacy `_showBotsListView()` fallback when a bot was deleted.
    if (!isLoading && config && !(config.bots || {})[botName]) {
      return <Navigate to="/bots" replace />;
    }
    return <BotDetail botName={botName} />;
  }

  return <BotList />;
}
