/**
 * TopicsSection — top-level Categories & Topics editor for a single bot.
 *
 * Mirrors `createCategoriesSection` from `static/js/pages/bots-topics.js`. The
 * children are CategoryBox → TopicBox → SchedulesSection / SeosSection /
 * LinkedTopicsSection / CatchAllToggle (lazy-mounted on first open).
 *
 * Backend endpoints touched directly here:
 *   POST /api/category/add
 *
 * Other endpoints used by descendants — see CategoryBox / TopicBox / ...
 */

import { useState } from 'react';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';
import CategoryBox from './CategoryBox';

export default function TopicsSection({ botName, bot }) {
  const cats = Object.entries(bot.categories || {});
  const [open, setOpen] = useState(true);
  // Inherited bots are shared admin bots — structure is read-only for the
  // user; only user-scoped SEO keywords can be added/removed.
  const inherited = !!bot.inherited;

  return (
    <div
      className={`collapsible-section ${open ? 'open' : ''}`}
      id={`categories-${botName}`}
    >
      <div className="collapsible-header" onClick={() => setOpen((v) => !v)}>
        <div className="collapsible-title">
          <span className="icon">📁</span>
          <span>Categories &amp; Topics ({cats.length})</span>
        </div>
        <span className="collapsible-toggle">▼</span>
      </div>
      <div className="collapsible-content">
        <div className="collapsible-body">
          {cats.map(([catName, cat]) => (
            <CategoryBox
              key={catName}
              botName={botName}
              catName={catName}
              cat={cat}
              inherited={inherited}
            />
          ))}

          {!inherited && <AddCategoryInline botName={botName} />}
        </div>
      </div>
    </div>
  );
}

function AddCategoryInline({ botName }) {
  const [name, setName] = useState('');
  const { showAlert } = useDialogs();

  const add = useApiMutation('/api/category/add', {
    invalidate: ['config'],
    successMsg: 'Category added',
    errorMsg: 'Failed to add category',
    onSuccess: () => setName('')
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
    <div className="add-category-section">
      <input
        type="text"
        className="input"
        placeholder="New category name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        style={{ display: 'inline-block', width: 'auto', marginRight: 8 }}
        disabled={add.isPending}
      />
      <button
        className="btn btn-secondary btn-sm"
        onClick={submit}
        disabled={add.isPending}
      >
        + Add Category
      </button>
    </div>
  );
}
