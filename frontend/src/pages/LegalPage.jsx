/**
 * Generic legal-content page (Terms of Service / Privacy Policy).
 *
 * Replaces the old /static/terms.html and /static/privacy.html. Fetches a
 * plain-text source from /static_react/<file>.txt and renders it with the
 * same lightweight formatting as the legacy pages:
 *   - first non-blank line  → page title
 *   - second non-blank line → "Effective Date: …"
 *   - blocks separated by blank lines
 *   - a block starting with "# " becomes a section heading
 *   - a block where every line starts with "- " becomes a bullet list
 *   - **bold** spans inside text
 *   - bare email addresses become mailto: links
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const SOURCES = {
  terms:   { file: 'terms_conditions.txt',  fallbackTitle: 'Terms of Service' },
  privacy: { file: 'privacy_policy.txt',    fallbackTitle: 'Privacy Policy'   }
};

export default function LegalPage({ kind }) {
  const navigate = useNavigate();
  const cfg = SOURCES[kind];
  const [state, setState] = useState({ status: 'loading', title: cfg.fallbackTitle, effective: '', html: '' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/static_react/${cfg.file}?_=${Date.now()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (cancelled) return;
        setState({ status: 'ok', ...renderTxt(raw, cfg.fallbackTitle) });
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({ ...s, status: 'error' }));
      }
    })();
    return () => { cancelled = true; };
  }, [cfg.file, cfg.fallbackTitle]);

  return (
    <div style={WRAP}>
      <div style={TOPBAR}>
        <button type="button" onClick={() => navigate(-1)} style={BACK_BTN}>
          ‹ Back
        </button>
        <span style={{ fontSize: 13, color: '#64748b' }}>Inforoot.org</span>
      </div>

      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6 }}>{state.title}</h1>
        {state.effective && <p style={{ fontSize: 13, color: '#64748b' }}>{state.effective}</p>}
      </div>

      <div style={CARD}>
        {state.status === 'loading' && <p style={{ color: '#64748b' }}>Loading…</p>}
        {state.status === 'error' && (
          <p>Could not load {state.title}. Please try again later.</p>
        )}
        {state.status === 'ok' && (
          <div dangerouslySetInnerHTML={{ __html: state.html }} />
        )}
      </div>

      <footer style={FOOTER}>
        <span>© 2026 Inforoot.org. All rights reserved.</span>
        &nbsp;·&nbsp;
        <a href={kind === 'terms' ? '/privacy' : '/terms'}>
          {kind === 'terms' ? 'Privacy Policy' : 'Terms of Service'}
        </a>
      </footer>
    </div>
  );
}

function escape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineRender(text) {
  let out = escape(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(
    /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g,
    '<a href="mailto:$1">$1</a>'
  );
  return out;
}

function renderTxt(raw, fallbackTitle) {
  const lines = raw.split('\n');
  let i = 0;
  let title = fallbackTitle;
  let effective = '';

  // First two non-blank lines = title + effective date.
  let headerLines = 0;
  while (i < lines.length && headerLines < 2) {
    const line = lines[i].trim();
    i++;
    if (!line) continue;
    if (headerLines === 0) {
      title = line;
    } else {
      effective = line;
    }
    headerLines++;
  }

  // Group remaining lines into blank-line-separated blocks.
  const blocks = [];
  let current = [];
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (line.trim() === '') {
      if (current.length) { blocks.push(current); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);

  let html = '';
  for (const block of blocks) {
    const first = block[0].trim();
    if (first.startsWith('# ')) {
      html += `<h3>${inlineRender(first.slice(2).trim())}</h3>`;
      if (block.length > 1) {
        html += `<p>${inlineRender(block.slice(1).map((l) => l.trim()).join(' '))}</p>`;
      }
    } else if (block.every((l) => l.trim().startsWith('- '))) {
      html += '<ul>';
      for (const l of block) html += `<li>${inlineRender(l.trim().slice(2))}</li>`;
      html += '</ul>';
    } else {
      html += `<p>${inlineRender(block.map((l) => l.trim()).join(' '))}</p>`;
    }
  }

  return { title, effective, html };
}

const WRAP = {
  maxWidth: 760,
  margin: '0 auto',
  padding: '40px 16px 60px',
  fontFamily: "'Inter', sans-serif"
};
const TOPBAR = { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 36 };
const BACK_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: '#1e2433',
  border: '1px solid #2d3748',
  color: '#94a3b8',
  borderRadius: 8,
  padding: '6px 14px',
  fontSize: 13,
  cursor: 'pointer'
};
const CARD = {
  background: '#1e2433',
  border: '1px solid #2d3748',
  borderRadius: 12,
  padding: '32px 36px',
  fontSize: 14.5,
  color: '#94a3b8',
  lineHeight: 1.7
};
const FOOTER = {
  textAlign: 'center',
  marginTop: 40,
  fontSize: 12,
  color: '#64748b'
};
