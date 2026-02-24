/* ─────────────────────────────────────────────────
   auth.js — loaded first in index.html
   Checks token presence and patches window.fetch
   to automatically inject the auth header and
   redirect to /login on any 401 response.
   ───────────────────────────────────────────────── */

(function () {
  'use strict';

  var token = localStorage.getItem('auth_token');

  if (!token) {
    window.location.replace('/login');
    return;
  }

  var _origFetch = window.fetch.bind(window);

  window.fetch = function (url, opts) {
    opts = opts || {};

    // Only inject the header on internal API calls
    if (typeof url === 'string' && url.startsWith('/api/')) {
      opts.headers = Object.assign({}, opts.headers, {
        'Authorization': 'Bearer ' + token
      });
    }

    return _origFetch(url, opts).then(function (res) {
      if (res.status === 401) {
        localStorage.removeItem('auth_token');
        window.location.replace('/login');
        // Return a never-resolving promise so no downstream code runs
        return new Promise(function () {});
      }
      return res;
    });
  };

  // ── Logout ─────────────────────────────────────
  window.logout = async function () {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    localStorage.removeItem('auth_token');
    window.location.replace('/login');
  };
}());
