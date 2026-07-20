/**
 * TopicsSection — the bot detail LANDING view (Figma "Summaries Bots" detail):
 * a toolbar (Expand All | Search | Sort by | + Summaries Category) over the
 * list of category rows. Children: CategoryBox → TopicBox → SchedulesSection /
 * SeosSection / LinkedTopicsSection / CatchAllToggle (lazy-mounted on open).
 *
 * Backend endpoints touched directly here:
 *   POST /api/category/add
 */

import { useMemo, useState } from 'react';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import CategoryBox from './CategoryBox';
import Icon from '../../components/icons';

export default function TopicsSection({ botName, bot }) {
  const cats = Object.entries(bot.categories || {});
  // Inherited bots are shared admin bots — structure is read-only for the
  // user; only user-scoped SEO keywords can be added/removed.
  const inherited = !!bot.inherited;

  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  // {value, seq} — seq bumps so CategoryBox reacts every click, even if the
  // desired state didn't flip (e.g. user manually closed some boxes).
  const [expandAll, setExpandAll] = useState(null);
  const [addOpen, setAddOpen] = useState(false);

  const list = useMemo(() => {
    let out = cats;
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(([name, cat]) =>
        name.toLowerCase().includes(q) ||
        Object.keys(cat.topics || {}).some((t) => t.toLowerCase().includes(q))
      );
    }
    if (sortBy === 'name') out = [...out].sort((a, b) => a[0].localeCompare(b[0]));
    else if (sortBy === 'topics') {
      out = [...out].sort(
        (a, b) => Object.keys(b[1].topics || {}).length - Object.keys(a[1].topics || {}).length
      );
    }
    return out;
  }, [cats, search, sortBy]);

  return (
    <div id={`categories-${botName}`}>
      <div className="detail-toolbar">
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setExpandAll((prev) => ({ value: !(prev?.value), seq: (prev?.seq || 0) + 1 }))}
        >
          {expandAll?.value ? 'Collapse All' : 'Expand All'}
          <Icon name="chevronDown" size={13} style={{ marginLeft: 5 }} />
        </button>

        <div className="tg-search detail-toolbar-search">
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="input tg-sort"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          <option value="">Sort by</option>
          <option value="name">Name</option>
          <option value="topics">Topic count</option>
        </select>
        {!inherited && (
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={14} style={{ marginRight: 5 }} />
            Summaries Category
          </button>
        )}
      </div>

      {list.length === 0 && (
        <div className="card" style={{ padding: 26, textAlign: 'center', color: 'var(--text-muted)' }}>
          {cats.length === 0
            ? <>No categories yet.{!inherited && ' Click "+ Summaries Category" to create one.'}</>
            : 'No categories match your search.'}
        </div>
      )}

      {list.map(([catName, cat], i) => (
        <CategoryBox
          key={catName}
          botName={botName}
          catName={catName}
          cat={cat}
          idx={i + 1}
          forceOpen={expandAll}
          inherited={inherited}
        />
      ))}

      {addOpen && (
        <AddCategoryModal botName={botName} onClose={() => setAddOpen(false)} />
      )}
    </div>
  );
}

function AddCategoryModal({ botName, onClose }) {
  const [name, setName] = useState('');
  const { showAlert } = useDialogs();

  const add = useApiMutation('/api/category/add', {
    invalidate: ['config'],
    successMsg: 'Category added',
    errorMsg: 'Failed to add category',
    onSuccess: onClose
  });

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      showAlert('Please enter a category name', { icon: '✏️' });
      return;
    }
    add.mutate({ bot_name: botName, category_name: trimmed });
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h3>New Summaries Category</h3>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Category Name</label>
            <input
              type="text"
              className="input"
              placeholder="e.g., Politics, Sports"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              disabled={add.isPending}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={add.isPending}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add Category'}
          </button>
        </div>
      </div>
    </div>
  );
}
