// Token storage key — must match the legacy key so an existing logged-in
// session in localStorage continues to work after the React migration.
const TOKEN_KEY = 'auth_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Hook for the AuthContext to handle 401s globally (logout + redirect).
let _onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  _onUnauthorized = fn;
}

/**
 * Same surface as the legacy `api(path, body?)` helper:
 *   - GET when body is undefined, POST otherwise
 *   - JSON in / JSON out
 *   - Always returns a parsed body (even on errors) shaped like { status, ... }
 *   - Auto-attaches Bearer token for /api/* paths
 *   - On 401, triggers the global unauthorized handler (which clears the token
 *     and routes to /login), then returns a never-resolving promise so callers
 *     don't continue with a logged-out state.
 */
export async function api(path, body) {
  const options = {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

  if (path.startsWith('/api/')) {
    const token = getToken();
    if (token) options.headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(path, options);

    if (response.status === 401) {
      if (_onUnauthorized) _onUnauthorized();
      return new Promise(() => {}); // never resolves — match legacy auth.js behavior
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: 'error', message: text || `Server error (${response.status})` };
    }
  } catch (error) {
    console.error('API Error:', error);
    return { status: 'error', message: error.message };
  }
}

// ==================== Utilities (parity with shared/api.js) ====================

export function debounce(fn, ms = 250) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const escapeHtmlSys = escapeHtml;

export function jsAttr(str) {
  if (str == null) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Format an ISO/UTC timestamp for display in Lebanon time (Asia/Beirut).
export function fmtLBN(iso) {
  if (!iso && iso !== 0) return '—';
  let d;
  if (typeof iso === 'number') {
    d = new Date(iso);
  } else {
    const s = String(iso).replace(' ', 'T');
    const norm = s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z';
    d = new Date(norm);
  }
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Beirut',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
