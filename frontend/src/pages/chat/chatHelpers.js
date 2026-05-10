/**
 * Shared helpers for the chat pages — markdown rendering + trailing-chip parsing.
 * Ported verbatim from static/js/chatbot.js + static/js/youtube.js so the
 * rendered output is byte-identical with the legacy app.
 */

/**
 * Render markdown text via the global `marked` script (loaded in index.html).
 * Falls back to escaped plain text if marked isn't available.
 */
export function formatMarkdown(text, { breaks = false } = {}) {
  if (!text) return '';
  // Collapse 3+ consecutive newlines → 2 (one blank line) to prevent giant gaps
  const normalized = text.replace(/\n{3,}/g, '\n\n');
  const m = typeof window !== 'undefined' ? window.marked : null;
  if (m && typeof m.parse === 'function') {
    return m.parse(normalized, { gfm: true, breaks });
  }
  // Fallback: escaped plain text wrapped in <p>
  return escapeHtml(normalized);
}

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Detect a trailing list of 2–6 items at the end of a done response.
 * Returns { mainText, chips }.
 */
export function parseTrailingChips(text, streaming) {
  if (streaming || !text) return { mainText: text, chips: [] };

  const lines = text.split('\n');
  const listRe = /^[ \t]*[-*]\s+(.+)/;

  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i--;

  const chips = [];
  let listStart = -1;
  while (i >= 0) {
    const m = listRe.exec(lines[i]);
    if (m) {
      chips.unshift(m[1].trim());
      listStart = i;
      i--;
    } else if (lines[i].trim() === '' && chips.length) {
      i--; // tolerate a blank line between list items
    } else {
      break;
    }
  }

  if (chips.length < 2 || chips.length > 6 || listStart < 0) {
    return { mainText: text, chips: [] };
  }

  const mainText = lines.slice(0, listStart).join('\n').trimEnd();
  return { mainText, chips };
}
