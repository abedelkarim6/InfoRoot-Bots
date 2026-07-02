/**
 * Monitor page shell — owns the tab bar, the shared `/api/monitor/data` fetch
 * (used by Schedules + Summaries tabs), and the unclassified/missed badge
 * counts shown on the tab buttons. Each tab component handles its own data
 * needs beyond that.
 *
 * Tab state is mirrored to the URL search param `?tab=...` so deep links
 * work and back/forward navigation moves between tabs.
 */

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import PageHeader from '../../components/PageHeader';

import SchedulesTab from './SchedulesTab';
import SummariesTab from './SummariesTab';
import MessagesTab from './MessagesTab';
import UnclassifiedTab from './UnclassifiedTab';
import HistoryTab from './HistoryTab';

const TABS = [
  { id: 'schedules',    label: '📡 Schedules' },
  { id: 'summaries',    label: '📬 Summaries' },
  { id: 'messages',     label: '📥 Messages' },
  { id: 'unclassified', label: '❓ Unclassified' },
  { id: 'history',      label: '📜 History' }
];

const VALID_TABS = new Set(TABS.map((t) => t.id));
const ACTIVE_TAB_KEY = 'mon-active-tab';

export default function MonitorPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Resolve the active tab from URL → localStorage → default.
  const tabFromUrl = searchParams.get('tab');
  const activeTab = VALID_TABS.has(tabFromUrl)
    ? tabFromUrl
    : (localStorage.getItem(ACTIVE_TAB_KEY) || 'schedules');

  // Backfill the URL if it's missing — keeps deep-link sharing consistent.
  useEffect(() => {
    if (!tabFromUrl) {
      setSearchParams({ tab: activeTab }, { replace: true });
    }
  }, [tabFromUrl, activeTab, setSearchParams]);

  // Persist the active tab so reopening the page lands in the same place.
  useEffect(() => {
    localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
  }, [activeTab]);

  // Schedules + Summaries tabs read from the same /api/monitor/data fetch.
  // 60s poll matches the legacy 15s but cheaper — countdowns tick locally.
  const monitor = useQuery({
    queryKey: ['monitor', 'data'],
    queryFn: () => api('/api/monitor/data'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false
  });

  // Unclassified + Missed badge counts (shown on the tab buttons). These
  // respect the localStorage "cleared at" timestamps so users can dismiss
  // them.
  const unclSince = localStorage.getItem('mon-uncl-cleared-at');
  const unclassifiedBadge = useQuery({
    queryKey: ['monitor', 'unclassified-badge', unclSince || null],
    queryFn: async () => {
      const url = '/api/monitor/unclassified?limit=1' + (unclSince ? `&since=${encodeURIComponent(unclSince)}` : '');
      const r = await api(url);
      if (r.status !== 'ok') return 0;
      return (r.stats || []).reduce((s, x) => s + (x.cnt || 0), 0);
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false
  });

  // Push (not replace) so the browser Back button returns to the previous tab.
  function setTab(t) {
    setSearchParams({ tab: t }, { replace: false });
  }

  const data = monitor.data?.status === 'ok' ? monitor.data : null;

  return (
    <div className="page active">
      <PageHeader
        title="Schedules Monitor"
        subtitle="Live schedule tracking, summaries, messages, and history"
      >
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => monitor.refetch()}
          disabled={monitor.isFetching}
        >
          ↻ Refresh
        </button>
      </PageHeader>

      <div className="mon-tab-bar" style={{ marginBottom: 16 }}>
        {TABS.map((t) => {
          const badge = t.id === 'unclassified' ? unclassifiedBadge.data : null;
          return (
            <button
              key={t.id}
              className={`mon-tab${activeTab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {badge != null && badge > 0 && (
                <span className="mon-uncl-badge" style={{ display: 'inline-block' }}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Each tab is mounted only when active so per-tab queries don't run
          in the background. Schedules + Summaries share the data fetched
          once at the page level. */}
      {activeTab === 'schedules'    && <SchedulesTab    data={data} isLoading={monitor.isLoading} />}
      {activeTab === 'summaries'    && <SummariesTab    data={data} isLoading={monitor.isLoading} />}
      {activeTab === 'messages'     && <MessagesTab />}
      {activeTab === 'unclassified' && <UnclassifiedTab />}
      {activeTab === 'history'      && <HistoryTab />}
    </div>
  );
}
