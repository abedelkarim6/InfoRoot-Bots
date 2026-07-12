/**
 * SeoLibraryPage — the "🏷️ SEOs" page. Two tabs over the same global category
 * library (sourced from the external platform):
 *
 *   • SEO Groups          — categories → keyword groups → keywords
 *                           (attached to topics for message matching)
 *   • Replace Terms Groups — categories → replace groups → from→to pairs
 *                           (used by bot "Replace in message" rules)
 *
 * Categories are shared between both tabs, so the "+ Add Category" bar lives at
 * the page level.
 *
 * Backend:
 *   GET  /api/seo/library | /api/seo/replace-library
 *   POST /api/seo/category/{add,rename,delete}
 *   POST /api/seo/group/* | /api/seo/replace-group/*
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useAuth } from '../../auth/AuthContext';
import { useUrlString } from '../../lib/useUrlState';
import PageHeader from '../../components/PageHeader';
import SeoCategoryBox from './SeoCategoryBox';
import ReplaceGroupsTab from './ReplaceGroupsTab';

const TABS = [
  { id: 'seo', label: '🏷️ SEO Groups' },
  { id: 'replace', label: '🔁 Replace Terms Groups' }
];

export default function SeoLibraryPage() {
  const { isAdmin } = useAuth();
  const [newCat, setNewCat] = useState('');
  const [tab, setTab] = useUrlString('tab', 'seo');
  const activeTab = TABS.some((t) => t.id === tab) ? tab : 'seo';

  const { data, isLoading } = useQuery({
    queryKey: ['seo-library'],
    queryFn: () => api('/api/seo/library'),
    enabled: activeTab === 'seo'
  });

  const addCategory = useApiMutation('/api/seo/category/add', {
    invalidate: ['seo-library', 'seo-replace-library'],
    successMsg: 'Category added',
    errorMsg: 'Failed to add category',
    onSuccess: () => setNewCat('')
  });

  const categories = data?.status === 'ok' ? data.categories || [] : [];
  const totalGroups = categories.reduce((n, c) => n + (c.groups?.length || 0), 0);

  function onAddCategory() {
    const name = newCat.trim();
    if (!name) return;
    addCategory.mutate({ name });
  }

  return (
    <div className="page active">
      <PageHeader
        title="SEOs"
        subtitle="Shared category library — keyword groups for topic matching, and replace-term groups for message rewriting."
      />

      {isAdmin && (
        <div
          className="card"
          style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 14, marginBottom: 16, flexWrap: 'wrap' }}
        >
          <input
            className="input"
            style={{ flex: '1 1 240px', minWidth: 200 }}
            placeholder="New category name…"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAddCategory()}
          />
          <button
            className="btn btn-primary"
            onClick={onAddCategory}
            disabled={addCategory.isPending || !newCat.trim()}
          >
            + Add Category
          </button>
        </div>
      )}

      <div className="mon-tab-bar" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`mon-tab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'seo' && (
        <>
          {isLoading && <div className="text-muted" style={{ padding: 20 }}>Loading…</div>}
          {!isLoading && categories.length === 0 && (
            <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
              No categories yet.{isAdmin ? ' Create one above to get started.' : ''}
            </div>
          )}
          {categories.map((cat) => (
            <SeoCategoryBox key={cat.id ?? 'uncategorized'} category={cat} isAdmin={isAdmin} />
          ))}
        </>
      )}

      {activeTab === 'replace' && <ReplaceGroupsTab isAdmin={isAdmin} />}
    </div>
  );
}
