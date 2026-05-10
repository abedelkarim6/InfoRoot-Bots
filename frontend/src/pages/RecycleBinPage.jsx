/**
 * Recycle Bin — Phase 2 reference port.
 *
 * This file is intentionally the canonical example for every other page in
 * Phase 3. The conventions used here:
 *
 *   1. One useQuery for the page's primary data (queryKey = ['recycle-bin']).
 *   2. useApiMutation for every write — handles toast + cache invalidation.
 *   3. useConfirmedMutation for any destructive action — wraps a confirm dialog.
 *   4. Pure render, no DOM mutation. State drives everything.
 *   5. Reuses the legacy CSS classes verbatim (.rb-item, .rb-empty, etc.) so
 *      the visual output is byte-identical to the legacy page.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApiMutation, useConfirmedMutation } from '../lib/useApiMutation';
import PageHeader from '../components/PageHeader';

const TYPE_ICONS = {
  bot: '🤖',
  category: '🗂️',
  topic: '📝',
  collection: '📦',
  prompt: '📄',
  schedule: '⏰',
  yt_channel: '📺',
  yt_keyword: '🔍'
};

const TYPE_LABELS = {
  bot: 'Bot',
  category: 'Category',
  topic: 'Topic',
  collection: 'Collection',
  prompt: 'Prompt',
  schedule: 'Schedule',
  yt_channel: 'YouTube Channel',
  yt_keyword: 'YouTube Tracker'
};

export default function RecycleBinPage() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['recycle-bin'],
    queryFn: () => api('/api/recycle-bin/list')
  });

  // Restore: refresh both the recycle bin AND the global config (a restored
  // bot/category/topic/collection re-appears in the sidebar badges + pages).
  const restore = useApiMutation('/api/recycle-bin/restore', {
    invalidate: ['recycle-bin', 'config'],
    successMsg: 'Item restored',
    errorMsg: 'Restore failed'
  });

  const remove = useApiMutation('/api/recycle-bin/delete', {
    invalidate: ['recycle-bin'],
    successMsg: 'Item permanently deleted',
    errorMsg: 'Delete failed'
  });

  const empty = useApiMutation('/api/recycle-bin/empty', {
    invalidate: ['recycle-bin'],
    successMsg: (res) => `Recycle bin emptied (${res.deleted} items)`,
    errorMsg: 'Empty bin failed'
  });

  const confirmRestore = useConfirmedMutation(restore, {
    message: 'Restore this item?',
    title: 'Restore Item',
    confirmLabel: 'Restore',
    confirmClass: 'btn-primary',
    icon: '♻️'
  });

  const confirmRemove = useConfirmedMutation(remove, {
    message: 'Permanently delete this item? This cannot be undone.',
    title: 'Permanent Delete',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger'
  });

  const confirmEmpty = useConfirmedMutation(empty, {
    message: 'Permanently delete ALL items in the recycle bin? This cannot be undone.',
    title: 'Empty Recycle Bin',
    confirmLabel: 'Empty Bin',
    confirmClass: 'btn-danger'
  });

  const items = data?.status === 'ok' ? data.items || [] : [];
  const grouped = groupByType(items);

  return (
    <div className="page active">
      <PageHeader
        title="Recycle Bin"
        subtitle="Deleted items are kept for 5 days before permanent removal"
      >
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          ↻ Refresh
        </button>
        {items.length > 0 && (
          <button
            className="btn btn-danger btn-sm"
            onClick={() => confirmEmpty({})}
            disabled={empty.isPending}
          >
            Empty Bin
          </button>
        )}
      </PageHeader>

      {isLoading && <p className="text-muted">Loading...</p>}

      {!isLoading && data?.status !== 'ok' && (
        <p className="text-muted">
          Failed to load recycle bin: {data?.message || 'unknown error'}
        </p>
      )}

      {!isLoading && data?.status === 'ok' && items.length === 0 && (
        <div className="rb-empty">
          <div className="rb-empty-icon">🗑️</div>
          <h3>Recycle Bin is Empty</h3>
          <p className="text-muted">
            Deleted items will appear here for 5 days before permanent removal.
          </p>
        </div>
      )}

      {!isLoading && items.length > 0 && (
        <>
          {Object.entries(grouped).map(([type, typeItems]) => (
            <div className="rb-group" key={type}>
              <h3 className="rb-group-title">
                {TYPE_ICONS[type] || '📎'} {TYPE_LABELS[type] || type}s ({typeItems.length})
              </h3>
              {typeItems.map((item) => (
                <RecycleBinRow
                  key={item.id}
                  item={item}
                  onRestore={() => confirmRestore({ id: item.id })}
                  onDelete={() => confirmRemove({ id: item.id })}
                  isBusy={restore.isPending || remove.isPending}
                />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function RecycleBinRow({ item, onRestore, onDelete, isBusy }) {
  const icon = TYPE_ICONS[item.entity_type] || '📎';
  const detail = entityDetail(item);
  return (
    <div className="rb-item">
      <div className="rb-item-info">
        <span className="rb-item-icon">{icon}</span>
        <div className="rb-item-text">
          <span className="rb-item-name">{item.entity_name}</span>
          {detail && <span className="rb-item-detail">{detail}</span>}
        </div>
      </div>
      <div className="rb-item-meta">
        <span className="rb-item-age" title={`Deleted ${item.deleted_at}`}>
          {timeAgo(item.deleted_at)}
        </span>
        <span className="rb-item-expiry">{daysLeft(item.deleted_at)}</span>
      </div>
      <div className="rb-item-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={onRestore}
          disabled={isBusy}
        >
          Restore
        </button>
        <button
          className="btn btn-danger btn-sm"
          onClick={onDelete}
          disabled={isBusy}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function groupByType(items) {
  const out = {};
  for (const item of items) {
    const t = item.entity_type;
    if (!out[t]) out[t] = [];
    out[t].push(item);
  }
  return out;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function daysLeft(iso) {
  if (!iso) return '';
  const deleted = new Date(iso).getTime();
  const expiry = deleted + 5 * 24 * 60 * 60 * 1000;
  const left = expiry - Date.now();
  if (left <= 0) return 'Expiring soon';
  return `${Math.ceil(left / (24 * 60 * 60 * 1000))}d left`;
}

function entityDetail(item) {
  const d = item.entity_data;
  if (!d) return '';
  const t = item.entity_type;
  if (t === 'bot') return `${Object.keys(d.categories || {}).length} categories`;
  if (t === 'category') return `${Object.keys(d.topics || {}).length} topics`;
  if (t === 'topic')
    return `${(d.keywords || []).length} keywords, ${(d.schedules || []).length} schedules`;
  if (t === 'collection')
    return `${(d.source_channels || []).length} sources, ${(d.target_channels || []).length} targets`;
  if (t === 'prompt') return d.bot_name || '';
  if (t === 'schedule') return `${d.bot_name}/${d.topic_name}`;
  if (t === 'yt_channel') return d.channel_name || d.channel_id || '';
  if (t === 'yt_keyword') return d.keyword || '';
  return '';
}
