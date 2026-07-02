/**
 * SeoGroupSuggestModal — AI keyword suggestion for an SEO group. Two steps:
 *   1) config (count, languages, note)
 *   2) generate in batches of ≤50, accumulate, then bulk-add the picked set.
 *
 * Adapted from the topic SeoSuggestModal.
 *
 * Backend:
 *   POST /api/seo/group/suggest-seos     (one call per batch)
 *   POST /api/seo/group/keyword/add-bulk (final approve)
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/useApiMutation';
import { useDialogs } from '../../dialogs/DialogsProvider';

const LANGUAGES = [
  { value: 'Arabic',  label: '🇱🇧 Arabic' },
  { value: 'English', label: '🇬🇧 English' },
  { value: 'French',  label: '🇫🇷 French' }
];

const LOADING_MSGS = [
  'Analyzing group keywords…',
  'Generating suggestions…',
  'Finding relevant terms…',
  'Expanding keyword list…',
  'Almost done…'
];

export default function SeoGroupSuggestModal({ groupId, groupName, onClose }) {
  const [step, setStep] = useState('config');
  const [count, setCount] = useState(50);
  const [languages, setLanguages] = useState(['Arabic']);
  const [note, setNote] = useState('');

  const [suggestions, setSuggestions] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [progressPct, setProgressPct] = useState(0);
  const [progressLabel, setProgressLabel] = useState('Starting…');
  const [progressSubtext, setProgressSubtext] = useState(LOADING_MSGS[0]);
  const [errorMsg, setErrorMsg] = useState('');

  const subtextTimer = useRef(null);
  const fakeProgressTimer = useRef(null);
  const cancelledRef = useRef(false);
  const { showNotification } = useDialogs();

  const approve = useApiMutation('/api/seo/group/keyword/add-bulk', {
    invalidate: ['seo-library', 'config'],
    successMsg: (res) => `${res.inserted} keyword${res.inserted !== 1 ? 's' : ''} added`,
    errorMsg: 'Failed to save keywords',
    onSuccess: onClose
  });

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (subtextTimer.current) clearInterval(subtextTimer.current);
      if (fakeProgressTimer.current) clearInterval(fakeProgressTimer.current);
    };
  }, []);

  function toggleLanguage(v) {
    setLanguages((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  }

  function _startSubtextLoop() {
    let idx = 0;
    setProgressSubtext(LOADING_MSGS[0]);
    if (subtextTimer.current) clearInterval(subtextTimer.current);
    subtextTimer.current = setInterval(() => {
      idx = (idx + 1) % LOADING_MSGS.length;
      setProgressSubtext(LOADING_MSGS[idx]);
    }, 2400);
  }
  function _stopSubtextLoop() {
    if (subtextTimer.current) { clearInterval(subtextTimer.current); subtextTimer.current = null; }
  }
  function _startFakeProgress(fromPct, toPct) {
    if (fakeProgressTimer.current) clearInterval(fakeProgressTimer.current);
    const ceiling = fromPct + (toPct - fromPct) * 0.88;
    let cur = fromPct;
    setProgressPct(fromPct);
    fakeProgressTimer.current = setInterval(() => {
      cur += (ceiling - cur) * 0.04;
      setProgressPct(Number(cur.toFixed(2)));
    }, 80);
  }
  function _stopFakeProgress(actual) {
    if (fakeProgressTimer.current) { clearInterval(fakeProgressTimer.current); fakeProgressTimer.current = null; }
    setProgressPct(actual);
  }

  async function startGenerate() {
    if (!languages.length) {
      showNotification('Select at least one language', 'error');
      return;
    }
    setSuggestions([]);
    setPicked(new Set());
    setErrorMsg('');
    setStep('generating');
    _startSubtextLoop();

    const total = Math.max(10, Math.min(500, parseInt(count, 10) || 50));
    const batches = Math.ceil(total / 50);
    const batchPct = 100 / batches;
    let acc = [];

    for (let i = 0; i < batches; i++) {
      if (cancelledRef.current) return;
      const batchSize = Math.min(50, total - i * 50);
      const fromPct = i * batchPct;
      const toPct = (i + 1) * batchPct;
      setProgressLabel(batches === 1 ? 'Generating…' : `Pass ${i + 1} of ${batches}`);
      _startFakeProgress(fromPct, toPct);

      const result = await api('/api/seo/group/suggest-seos', {
        group_id: groupId,
        group_name: groupName,
        count: batchSize,
        languages,
        note,
        exclude: acc
      });
      _stopFakeProgress(toPct);
      if (cancelledRef.current) return;
      if (result.status !== 'ok') {
        setErrorMsg(result.message || 'AI error');
        break;
      }
      acc = [...acc, ...(result.suggestions || [])];
      setSuggestions([...acc]);
      setPicked(new Set(acc));
    }

    _stopSubtextLoop();
    _stopFakeProgress(100);
    setProgressLabel(acc.length ? `✓ ${acc.length} suggestions ready` : 'Done');
    setProgressSubtext('');
    setStep('done');
  }

  function togglePick(s) {
    setPicked((cur) => {
      const next = new Set(cur);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }
  function toggleAll(checked) {
    setPicked(checked ? new Set(suggestions) : new Set());
  }
  function onApprove() {
    const list = suggestions.filter((s) => picked.has(s));
    if (!list.length) {
      showNotification('No keywords selected', 'error');
      return;
    }
    approve.mutate({ group_id: groupId, keywords: list });
  }

  const totalCount = Math.max(10, Math.min(500, parseInt(count, 10) || 50));

  if (step === 'config') {
    return (
      <div className="modal-overlay" style={{ display: 'flex' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal-dialog" style={{ maxWidth: 480 }}>
          <div className="modal-header" style={{ padding: '18px 22px' }}>
            <div>
              <h3 style={{ fontSize: 16, margin: 0 }}>✨ Suggest Keywords with AI</h3>
              <small style={{ color: 'var(--text-muted)', fontSize: 12 }}>{groupName}</small>
            </div>
            <button className="btn-icon" onClick={onClose}>×</button>
          </div>
          <div className="modal-body" style={{ padding: '18px 22px' }}>
            <div className="form-group">
              <label className="form-label">Number of suggestions</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="number" className="input" min="10" max="500" step="10" style={{ width: 90 }}
                  value={count} onChange={(e) => setCount(e.target.value)}
                />
                <small className="text-muted">Numbers above 50 run in multiple passes</small>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Languages</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                {LANGUAGES.map((l) => (
                  <label key={l.value} className="seo-lang-pill">
                    <input
                      type="checkbox" className="seo-lang-cb" value={l.value}
                      checked={languages.includes(l.value)} onChange={() => toggleLanguage(l.value)}
                    />
                    <span>{l.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">
                Custom instructions{' '}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span>
              </label>
              <textarea
                className="input" rows={3}
                placeholder="e.g. focus on military terms, include hashtag formats…"
                style={{ resize: 'vertical', minHeight: 72, width: '100%' }}
                value={note} onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
          <div className="modal-footer" style={{ padding: '14px 22px' }}>
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={startGenerate}>✨ Generate</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" style={{ display: 'flex' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-dialog" style={{ maxWidth: 640 }}>
        <div className="modal-header" style={{ padding: '18px 22px' }}>
          <div>
            <h3 style={{ fontSize: 16, margin: 0 }}>✨ AI Keyword Suggestions</h3>
            <small style={{ color: 'var(--text-muted)', fontSize: 12 }}>{groupName} — {totalCount} suggestions</small>
          </div>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '16px 22px', minHeight: 140, maxHeight: '62vh', overflowY: 'auto' }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)', marginBottom: 7 }}>
              <span>{progressLabel}</span>
              <span>{suggestions.length} / {totalCount}</span>
            </div>
            <div style={{ background: 'var(--bg-tertiary,#2a2a3e)', borderRadius: 6, height: 8, overflow: 'hidden' }}>
              <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--accent-primary,#6366f1)', transition: 'width 80ms linear' }} />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>{progressSubtext}</div>
          </div>

          <div id="seo-suggest-chips">
            {suggestions.map((s) => (
              <label className="seo-chip" key={s}>
                <input type="checkbox" className="seo-chip-cb" checked={picked.has(s)} onChange={() => togglePick(s)} />
                <span>{s}</span>
              </label>
            ))}
            {errorMsg && (
              <div style={{ color: 'var(--danger)', fontSize: 13, padding: '8px 0', width: '100%' }}>{errorMsg}</div>
            )}
          </div>
        </div>
        <div className="modal-footer" style={{ padding: '14px 22px' }}>
          <button className="btn btn-secondary" onClick={onClose}>Discard All</button>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={suggestions.length > 0 && picked.size === suggestions.length}
              onChange={(e) => toggleAll(e.target.checked)}
            />{' '}
            Select all
          </label>
          <button
            className="btn btn-primary"
            onClick={onApprove}
            disabled={approve.isPending || step !== 'done' || picked.size === 0}
          >
            {approve.isPending ? 'Saving…' : `Approve Selected (${picked.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
