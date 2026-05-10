/**
 * Global search input in the sidebar (Ctrl+K). Searches across the user's
 * bots, categories, topics, keywords (SEOs), collections, and channels —
 * all from the cached `useGlobalConfig()` data, no extra API call.
 *
 * Selecting a result navigates to the right page and (where the legacy did
 * the same) passes a query param so the destination page can scroll/expand
 * to the chosen item.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGlobalConfig } from '../config/ConfigProvider';
import { debounce } from '../lib/api';

const TYPE_ORDER = ['bot', 'category', 'topic', 'keyword', 'source', 'target'];
const TYPE_LABELS = {
  bot: 'Bots',
  category: 'Categories',
  topic: 'Topics',
  keyword: 'SEOs',
  source: 'Sources',
  target: 'Targets'
};

function buildIndex(config) {
  const out = [];
  if (!config) return out;

  for (const [botName, bot] of Object.entries(config.bots || {})) {
    const cats = bot.categories || {};
    const catCount = Object.keys(cats).length;
    out.push({
      type: 'bot',
      label: botName,
      subtitle: `Bot · ${catCount} categor${catCount === 1 ? 'y' : 'ies'}`,
      icon: '🤖',
      to: `/bots/${encodeURIComponent(botName)}`
    });

    for (const [catName, cat] of Object.entries(cats)) {
      const topicCount = Object.keys(cat.topics || {}).length;
      out.push({
        type: 'category',
        label: catName,
        subtitle: `Category in ${botName} · ${topicCount} topic${topicCount === 1 ? '' : 's'}`,
        icon: '🗂️',
        to: `/bots/${encodeURIComponent(botName)}?cat=${encodeURIComponent(catName)}`
      });

      for (const [topicName, topic] of Object.entries(cat.topics || {})) {
        out.push({
          type: 'topic',
          label: topicName,
          subtitle: `Topic in ${catName} › ${botName}`,
          icon: '📌',
          to: `/bots/${encodeURIComponent(botName)}?cat=${encodeURIComponent(catName)}&topic=${encodeURIComponent(topicName)}`
        });

        for (const kw of (topic.keywords || [])) {
          out.push({
            type: 'keyword',
            label: kw,
            subtitle: `SEO in ${topicName} › ${catName}`,
            icon: '🔎',
            to: `/bots/${encodeURIComponent(botName)}?cat=${encodeURIComponent(catName)}&topic=${encodeURIComponent(topicName)}`
          });
        }
      }
    }
  }

  // Channels are now per-bot: each bot has its own auto-collection (named
  // after the bot). Index source/target channels via the bot they belong to,
  // so search results navigate to /bots/<botName>.
  const colToBots = {}; // collection name → list of bot names that reference it
  for (const [botName, bot] of Object.entries(config.bots || {})) {
    for (const collName of (bot.collections || [])) {
      if (!colToBots[collName]) colToBots[collName] = [];
      colToBots[collName].push(botName);
    }
  }
  const seenSources = new Set();
  const seenTargets = new Set();
  for (const [collName, coll] of Object.entries(config.collections || {})) {
    const owners = colToBots[collName] || [];
    if (owners.length === 0) continue; // orphaned collection — skip
    const owner = owners[0]; // pick the first bot that uses it
    for (const src of (coll.source_channels || [])) {
      const k = `${owner}::${src}`;
      if (seenSources.has(k)) continue;
      seenSources.add(k);
      out.push({
        type: 'source',
        label: src,
        subtitle: `Source channel in ${owner}`,
        icon: '📡',
        to: `/bots/${encodeURIComponent(owner)}`
      });
    }
    const targets = [coll.target_channel, ...(coll.target_channels || [])].filter(Boolean);
    for (const tgt of [...new Set(targets)]) {
      const k = `${owner}::${tgt}`;
      if (seenTargets.has(k)) continue;
      seenTargets.add(k);
      out.push({
        type: 'target',
        label: tgt,
        subtitle: `Target channel in ${owner}`,
        icon: '📤',
        to: `/bots/${encodeURIComponent(owner)}`
      });
    }
  }

  return out;
}

function highlightMatch(text, query) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="search-highlight">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function SidebarSearch() {
  const { config } = useGlobalConfig();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);

  // Debounce search input (150ms — matches legacy).
  const setDebouncedFn = useMemo(
    () => debounce((v) => setDebouncedQuery(v), 150),
    []
  );
  useEffect(() => { setDebouncedFn(query); }, [query, setDebouncedFn]);

  // Ctrl+K / Cmd+K to focus the search.
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Close the dropdown when clicking outside the search wrapper.
  useEffect(() => {
    function onClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setQuery('');
        setSelectedIdx(-1);
      }
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Build & filter the index whenever the config or query changes.
  const results = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    const q = debouncedQuery.trim().toLowerCase();
    return buildIndex(config)
      .filter((item) =>
        item.label.toLowerCase().includes(q) || item.subtitle.toLowerCase().includes(q)
      )
      .slice(0, 25);
  }, [config, debouncedQuery]);

  // Reset highlighted index whenever the result set changes.
  useEffect(() => { setSelectedIdx(-1); }, [results]);

  function selectIndex(i) {
    const item = results[i];
    if (!item) return;
    setQuery('');
    setSelectedIdx(-1);
    navigate(item.to);
  }

  function onKeyDown(e) {
    if (!results.length) {
      if (e.key === 'Escape') setQuery('');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0) selectIndex(selectedIdx);
    } else if (e.key === 'Escape') {
      setQuery('');
      setSelectedIdx(-1);
    }
  }

  // Group by type (legacy order).
  const grouped = useMemo(() => {
    const g = {};
    for (const item of results) {
      if (!g[item.type]) g[item.type] = [];
      g[item.type].push(item);
    }
    return g;
  }, [results]);

  const showDropdown = debouncedQuery.trim().length > 0;
  let runningIdx = 0;

  return (
    <div className="sidebar-search" ref={wrapRef}>
      <div className="sidebar-search-wrap">
        <span className="sidebar-search-icon">🔍</span>
        <input
          ref={inputRef}
          type="text"
          className="sidebar-search-input"
          placeholder="Search... (Ctrl+K)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
        {query && (
          <button
            className="sidebar-search-clear"
            onClick={() => { setQuery(''); setSelectedIdx(-1); }}
          >✕</button>
        )}
      </div>

      {showDropdown && (
        <div className="search-results-dropdown" style={{ display: 'block' }}>
          {results.length === 0 ? (
            <div className="search-no-results">
              No results for "<strong>{debouncedQuery}</strong>"
            </div>
          ) : (
            TYPE_ORDER.map((type) => {
              if (!grouped[type]) return null;
              return (
                <div key={type}>
                  <div className="search-result-group-label">{TYPE_LABELS[type]}</div>
                  {grouped[type].map((item) => {
                    const idx = runningIdx++;
                    return (
                      <div
                        key={`${item.type}:${item.label}:${idx}`}
                        className={`search-result-item${idx === selectedIdx ? ' selected' : ''}`}
                        onClick={() => selectIndex(idx)}
                        onMouseEnter={() => setSelectedIdx(idx)}
                      >
                        <span className="search-result-icon">{item.icon}</span>
                        <div className="search-result-text">
                          <div className="search-result-label">
                            {highlightMatch(item.label, debouncedQuery)}
                          </div>
                          <div className="search-result-subtitle">{item.subtitle}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
