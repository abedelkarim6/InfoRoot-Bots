/**
 * CSV export helpers for the Monitor page.
 *
 * Mirrors static/js/pages/monitor-export.js but with the column definitions
 * exposed and the row builder taking explicit data instead of pulling from
 * window globals. Each tab calls `exportCsv(tabName, rows, opts)` from its
 * own button handler.
 */

import { fmtLBN } from '../../lib/api';
import {
  scheduleStartTime,
  scheduleEndTime,
  scheduleRepeatsText,
  scheduleFiresPerDay,
  getUpcomingFires24h
} from './shared';

export const EXPORT_COLS = {
  schedules_24h: [
    { key: 'time', label: 'Fire Time' },
    { key: 'bot', label: 'Bot' },
    { key: 'topic', label: 'Topic' },
    { key: 'type', label: 'Type' },
    { key: 'name', label: 'Schedule Name' },
    { key: 'pending', label: 'Pending Messages' }
  ],
  mon_summaries: [
    { key: 'bot', label: 'Bot' },
    { key: 'topic', label: 'Topic' },
    { key: 'type', label: 'Type' },
    { key: 'start', label: 'Start Time' },
    { key: 'end', label: 'End Time' },
    { key: 'repeats', label: 'Repeats' },
    { key: 'sent', label: 'Sent Today' },
    { key: 'failed', label: 'Failed Today' },
    { key: 'remain', label: 'Remaining' },
    { key: 'total', label: 'Total / Day' }
  ],
  history: [
    { key: 'time', label: 'Time' },
    { key: 'bot', label: 'Bot' },
    { key: 'topic', label: 'Topic' },
    { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status' },
    { key: 'msgs', label: 'Messages' },
    { key: 'prompt', label: 'Prompt' },
    { key: 'error', label: 'Error' }
  ],
  messages: [
    { key: 'time', label: 'Time' },
    { key: 'collection', label: 'Collection' },
    { key: 'channel', label: 'Channel' },
    { key: 'topics', label: 'Topics' },
    { key: 'categories', label: 'Categories' },
    { key: 'keywords', label: 'Keywords' },
    { key: 'preview', label: 'Preview' }
  ],
  unclassified: [
    { key: 'time', label: 'Time' },
    { key: 'collection', label: 'Collection' },
    { key: 'channel', label: 'Channel' },
    { key: 'bot', label: 'Bot' },
    { key: 'preview', label: 'Preview' }
  ],
  missed: [
    { key: 'time', label: 'Time' },
    { key: 'channel', label: 'Channel' },
    { key: 'bot', label: 'Bot' },
    { key: 'topic', label: 'Topic' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'preview', label: 'Preview' }
  ]
};

export const TAB_LABELS = {
  schedules_24h: 'Schedules (next 24h)',
  mon_summaries: 'Monitor Summaries',
  history: 'Schedule History',
  messages: 'Messages',
  unclassified: 'Unclassified',
  missed: 'Missed'
};

const FILE_LABELS = {
  schedules_24h: 'schedules_24h',
  mon_summaries: 'monitor_summaries',
  history: 'schedule_history'
};

function csvCell(v) {
  const s = (v == null ? '' : String(v)).replace(/"/g, '""');
  return `"${s}"`;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

/**
 * Build CSV rows for a tab. Each builder receives the visible/filtered data
 * already, so it just needs to map per-column.
 */
export function buildScheduleFireRows(items, nowMs) {
  const fires = [];
  for (const item of items) {
    getUpcomingFires24h(item.sch, nowMs).forEach((fireAt, idx) => {
      fires.push({ fireAt, ...item, pending: idx === 0 ? item.pending : 0 });
    });
  }
  fires.sort((a, b) => a.fireAt - b.fireAt);
  return fires;
}

export function buildRowValues(tabName, row, colDefs) {
  return colDefs.map((c) => {
    if (tabName === 'schedules_24h') {
      switch (c.key) {
        case 'time':
          return fmtLBN(row.fireAt);
        case 'bot':
          return row.botName || '';
        case 'topic':
          return row.topicName || '';
        case 'type':
          return row.sch?.type || '';
        case 'name':
          return row.sch?.name || '';
        case 'pending':
          return row.pending ?? 0;
        default:
          return '';
      }
    }
    if (tabName === 'mon_summaries') {
      switch (c.key) {
        case 'bot':
          return row.botName || '';
        case 'topic':
          return row.topicName || '';
        case 'type':
          return row.sch?.type || '';
        case 'start':
          return scheduleStartTime(row.sch);
        case 'end':
          return scheduleEndTime(row.sch);
        case 'repeats':
          return scheduleRepeatsText(row.sch);
        case 'sent':
          return row.stat.sent;
        case 'failed':
          return row.stat.failed;
        case 'remain':
          return row.remain;
        case 'total':
          return row.total;
        default:
          return '';
      }
    }
    if (tabName === 'history') {
      switch (c.key) {
        case 'time':
          return row.fired_at ? fmtLBN(row.fired_at) : '';
        case 'bot':
          return row.bot_name || '';
        case 'topic':
          return row.topic_name || '';
        case 'type':
          return row.schedule_type || '';
        case 'status':
          return row.status || '';
        case 'msgs':
          return row.message_count ?? '';
        case 'prompt':
          return row.prompt_key || '';
        case 'error':
          return row.error_text || '';
        default:
          return '';
      }
    }
    if (tabName === 'messages') {
      switch (c.key) {
        case 'time':
          return row.timestamp ? fmtLBN(row.timestamp) : '';
        case 'collection':
          return row.collection || '';
        case 'channel':
          return row.channel_username ? `@${row.channel_username}` : '';
        case 'topics':
          return row.topics || '';
        case 'categories':
          return row.categories || '';
        case 'keywords':
          return row.keywords_found || '';
        case 'preview':
          return row.preview || '';
        default:
          return '';
      }
    }
    if (tabName === 'unclassified') {
      switch (c.key) {
        case 'time':
          return row.timestamp ? fmtLBN(row.timestamp) : '';
        case 'collection':
          return row.collection_name || '';
        case 'channel':
          return row.channel_username ? `@${row.channel_username}` : '';
        case 'bot':
          return row.bot_name || '';
        case 'preview':
          return row.preview || '';
        default:
          return '';
      }
    }
    if (tabName === 'missed') {
      switch (c.key) {
        case 'time':
          return row.timestamp ? fmtLBN(row.timestamp) : '';
        case 'channel':
          return row.channel_username ? `@${row.channel_username}` : `id:${row.channel_id || ''}`;
        case 'bot':
          return row.bot_name || '';
        case 'topic':
          return row.topic_name || '';
        case 'schedule':
          return row.schedule_type || '';
        case 'preview':
          return row.preview || '';
        default:
          return '';
      }
    }
    return '';
  });
}

scheduleFiresPerDay; // retained for potential future use; silence linter warning by reference

export function downloadCsv(tabName, rows, selectedKeys) {
  const colDefs = (EXPORT_COLS[tabName] || []).filter((c) => selectedKeys.includes(c.key));
  if (!colDefs.length) {
    return { ok: false, reason: 'No columns selected to export.' };
  }
  if (!rows.length) {
    return {
      ok: false,
      reason:
        'Nothing to export — the visible list is empty. Clear filters or wait for data to load, then try again.'
    };
  }
  const dataRows = rows.map((r) => buildRowValues(tabName, r, colDefs));
  const header = csvRow(colDefs.map((c) => c.label));
  // UTF-8 BOM so Excel reads non-ASCII correctly.
  const csv = '﻿' + header + '\n' + dataRows.map(csvRow).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const fileLabel = FILE_LABELS[tabName] || tabName;
  a.download = `${fileLabel}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { ok: true };
}
