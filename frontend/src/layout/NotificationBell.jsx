/**
 * Notification bell — surfaces "missing definitions" warnings
 * (orphaned prompts, orphaned collections, etc.) from /api/warnings.
 *
 * Each warning has `type`, `level`, `message`, and `bot_name`. Clicking a
 * notification navigates to the offending bot's detail page so the user can
 * fix the issue. A × button dismisses the notification (remembered in
 * localStorage so it doesn't reappear after refresh until /api/warnings
 * returns a new state).
 *
 * Mounted in AppShell so it appears on every page. Stays hidden when there
 * are no (un-dismissed) warnings.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const DISMISSED_KEY = 'notif-dismissed';

function loadDismissed() {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function saveDismissed(set) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
  } catch { /* quota / disabled storage — ignore */ }
}

// Stable identity per warning so dismissals persist across refetches.
function warnKey(w) {
  return `${w.type || ''}::${w.bot_name || ''}::${w.message || ''}`;
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => loadDismissed());
  const wrapRef = useRef(null);

  const { data, refetch, isFetching } = useQuery({
    queryKey: ['warnings'],
    queryFn: () => api('/api/warnings'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false
  });

  // Close on outside click.
  useEffect(() => {
    function onClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const allWarnings = Array.isArray(data?.warnings) ? data.warnings : [];
  const visible = useMemo(
    () => allWarnings.filter((w) => !dismissed.has(warnKey(w))),
    [allWarnings, dismissed]
  );

  if (visible.length === 0) return null;

  const errors = visible.filter((w) => w.level === 'error');
  const others = visible.filter((w) => w.level !== 'error');
  const errCount = errors.length;
  const title = errCount
    ? `⛔ Missing Definitions (${errCount} error${errCount > 1 ? 's' : ''})`
    : `⚠️ Missing Definitions (${visible.length})`;

  function dismissOne(w) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(warnKey(w));
      saveDismissed(next);
      return next;
    });
  }

  function clearAll() {
    setDismissed((prev) => {
      const next = new Set(prev);
      visible.forEach((w) => next.add(warnKey(w)));
      saveDismissed(next);
      return next;
    });
    setOpen(false);
  }

  function go(w) {
    if (w.bot_name) {
      navigate(`/bots/${encodeURIComponent(w.bot_name)}`);
    }
    setOpen(false);
  }

  return (
    <div id="notif-bell-wrap" ref={wrapRef}>
      <button
        className={`notif-bell-btn${errCount > 0 ? ' notif-bell-has-error' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
      >
        <span className="notif-bell-icon">🔔</span>
        <span className="notif-bell-badge">{visible.length}</span>
      </button>

      <div className={`notif-panel${open ? ' open' : ''}`}>
        <div className="notif-panel-header">
          <span>{title}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                refetch();
              }}
              disabled={isFetching}
              title="Refresh"
            >↻</button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                clearAll();
              }}
              title="Dismiss all notifications"
            >Clear all</button>
            <button className="btn-icon" onClick={() => setOpen(false)}>×</button>
          </div>
        </div>
        <div className="notif-panel-body">
          {[...errors, ...others].map((w) => (
            <div
              key={warnKey(w)}
              className={`notif-item notif-${w.level}`}
              onClick={() => go(w)}
              style={{ cursor: w.bot_name ? 'pointer' : 'default', display: 'flex', alignItems: 'flex-start', gap: 8 }}
              title={w.bot_name ? `Open ${w.bot_name} →` : undefined}
            >
              <span className="notif-item-icon">{w.level === 'error' ? '⛔' : '⚠️'}</span>
              <span className="notif-item-text" style={{ flex: 1 }}>{w.message}</span>
              <button
                className="btn-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissOne(w);
                }}
                title="Dismiss"
                style={{ flexShrink: 0, opacity: 0.7 }}
              >×</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
