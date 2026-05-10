/**
 * Summaries tab — per-schedule dashboard with today's sent/failed/remaining.
 *
 * Two queries:
 *   - ['monitor','data']           (already kept fresh by the parent)
 *   - ['monitor','schedule-stats'] (today's per-schedule stats; 60s refresh)
 *
 * Shows a flat table joining the two, with bot/topic/type multi-select filters.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import MultiSelect from './MultiSelect';
import ExportColumnsModal from './ExportColumnsModal';
import {
  scheduleStartTime,
  scheduleEndTime,
  scheduleRepeatsText,
  scheduleFiresPerDay
} from './shared';
import { downloadCsv } from './exportCsv';
import { useDialogs } from '../../dialogs/DialogsProvider';

export default function SummariesTab({ data, isLoading }) {
  const { showAlert } = useDialogs();
  const [selBots, setSelBots] = useState(() => new Set());
  const [selTopics, setSelTopics] = useState(() => new Set());
  const [selTypes, setSelTypes] = useState(() => new Set());
  const [showExport, setShowExport] = useState(false);

  const statsQuery = useQuery({
    queryKey: ['monitor', 'schedule-stats'],
    queryFn: () => api('/api/monitor/schedule-stats'),
    refetchInterval: 60000,
    refetchIntervalInBackground: false
  });

  const stats = statsQuery.data?.status === 'ok' ? statsQuery.data.stats || [] : [];

  const botsData = data?.bots || {};

  const allBots = useMemo(() => Object.keys(botsData).sort(), [botsData]);
  const allTopics = useMemo(
    () =>
      uniqueSorted(
        Object.values(botsData).flatMap((b) =>
          Object.values(b.categories || {}).flatMap((c) => Object.keys(c.topics || {}))
        )
      ),
    [botsData]
  );
  const allTypes = useMemo(
    () =>
      uniqueSorted(
        Object.values(botsData).flatMap((b) =>
          Object.values(b.categories || {}).flatMap((c) =>
            Object.values(c.topics || {}).flatMap((t) =>
              (t.schedules || []).map((s) => s.type).filter(Boolean)
            )
          )
        )
      ),
    [botsData]
  );

  const rows = useMemo(() => {
    const lookup = {};
    for (const s of stats) {
      lookup[`${s.bot_name}|${s.topic_name}|${s.schedule_type}`] = {
        sent: s.sent || 0,
        failed: s.failed || 0
      };
    }
    const out = [];
    for (const botName in botsData) {
      if (selBots.size && !selBots.has(botName)) continue;
      const botData = botsData[botName];
      if (!botData.enabled) continue;
      const cats = botData.categories || {};
      for (const catName in cats) {
        const catData = cats[catName];
        if (!catData.enabled) continue;
        const topics = catData.topics || {};
        for (const topicName in topics) {
          if (selTopics.size && !selTopics.has(topicName)) continue;
          const topicData = topics[topicName];
          if (!topicData.enabled) continue;
          const schedules = topicData.schedules || [];
          for (const sch of schedules) {
            if (!sch.enabled) continue;
            if (selTypes.size && !selTypes.has(sch.type || '')) continue;
            const stat = lookup[`${botName}|${topicName}|${sch.type}`] || {
              sent: 0,
              failed: 0
            };
            const total = scheduleFiresPerDay(sch);
            const remain = Math.max(0, total - stat.sent - stat.failed);
            out.push({ botName, topicName, sch, stat, total, remain });
          }
        }
      }
    }
    return out;
  }, [botsData, stats, selBots, selTopics, selTypes]);

  return (
    <>
      <div className="mon-filter-bar">
        <MultiSelect label="All Bots" values={allBots} selected={selBots} onChange={setSelBots} />
        <MultiSelect
          label="All Topics"
          values={allTopics}
          selected={selTopics}
          onChange={setSelTopics}
        />
        <MultiSelect
          label="All Types"
          values={allTypes}
          selected={selTypes}
          onChange={setSelTypes}
        />
        <button
          className="btn btn-secondary btn-sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowExport(true)}
          title="Export today's schedule stats to CSV"
        >
          ⬇ Export
        </button>
      </div>

      {isLoading && !data ? (
        <p className="mon-empty">Loading…</p>
      ) : !rows.length ? (
        <p className="mon-empty">No enabled schedules found.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="mon-table">
            <thead>
              <tr>
                <th>Bot</th>
                <th>Topic</th>
                <th>Type</th>
                <th>Start Time</th>
                <th>End Time</th>
                <th>Repeats</th>
                <th style={{ textAlign: 'center' }}>Sent Today</th>
                <th style={{ textAlign: 'center' }}>Failed Today</th>
                <th style={{ textAlign: 'center' }}>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const typeCls = r.sch.type || 'hourly';
                const startTime = scheduleStartTime(r.sch);
                const endTime = scheduleEndTime(r.sch);
                const repeats = scheduleRepeatsText(r.sch);
                return (
                  <tr key={`${r.botName}|${r.topicName}|${r.sch.type}|${i}`}>
                    <td>{r.botName}</td>
                    <td>{r.topicName}</td>
                    <td>
                      <span className={`mon-type-badge ${typeCls}`}>{r.sch.type}</span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{startTime}</td>
                    <td>
                      {endTime !== '—' ? (
                        <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{endTime}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td style={{ fontSize: 12 }}>{repeats}</td>
                    <td style={{ textAlign: 'center' }}>
                      {r.stat.sent > 0 ? (
                        <span style={{ color: 'var(--success,#22c55e)', fontWeight: 600 }}>
                          {r.stat.sent}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>0</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {r.stat.failed > 0 ? (
                        <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                          {r.stat.failed}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>0</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {r.remain > 0 ? (
                        <span style={{ color: 'var(--text-secondary)' }}>{r.remain}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>0</span>
                      )}{' '}
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        / {r.total}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showExport && (
        <ExportColumnsModal
          tabName="mon_summaries"
          onClose={() => setShowExport(false)}
          onConfirm={(keys) => {
            const res = downloadCsv('mon_summaries', rows, keys);
            setShowExport(false);
            if (!res.ok) showAlert(res.reason, { title: 'Export', icon: '⚠️' });
          }}
        />
      )}
    </>
  );
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}
