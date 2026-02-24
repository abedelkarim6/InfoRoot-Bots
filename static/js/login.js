'use strict';

/* ── Redirect if already authenticated ─────────── */
(function () {
  if (localStorage.getItem('auth_token')) {
    window.location.replace('/');
  }
}());

/* ── Password visibility toggle ─────────────────── */
window.togglePassword = function () {
  var inp  = document.getElementById('inp-pass');
  var icon = document.getElementById('eye-icon');
  var show = inp.type === 'password';

  inp.type = show ? 'text' : 'password';

  // Swap icon: open eye ↔ crossed eye
  icon.innerHTML = show
    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>' +
      '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/>'
    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>' +
      '<circle cx="12" cy="12" r="3"></circle>';
};

/* ── Attempt counter state ──────────────────────── */
var usedAttempts = 0;
var MAX_ATTEMPTS = 5;

function showAttempts(used) {
  usedAttempts = used;
  var row   = document.getElementById('attempts-row');
  var label = document.getElementById('attempts-label');
  row.classList.add('visible');

  var left = MAX_ATTEMPTS - used;
  label.textContent = left + ' attempt' + (left === 1 ? '' : 's') + ' remaining';

  for (var i = 1; i <= MAX_ATTEMPTS; i++) {
    var dot = document.getElementById('dot-' + i);
    if (dot) {
      dot.classList.toggle('used', i <= used);
    }
  }
}

/* ── Alert helpers ──────────────────────────────── */
function showError(msg) {
  hide('alert-locked');
  document.getElementById('alert-text').textContent = msg;
  var el = document.getElementById('alert-error');
  // Re-trigger animation
  el.classList.remove('visible');
  void el.offsetWidth;
  el.classList.add('visible');
}

function showLocked(msg) {
  hide('alert-error');
  document.getElementById('locked-text').textContent = msg;
  var el = document.getElementById('alert-locked');
  el.classList.remove('visible');
  void el.offsetWidth;
  el.classList.add('visible');
}

function hide(id) {
  document.getElementById(id).classList.remove('visible');
}

/* ── Form submission ────────────────────────────── */
document.getElementById('auth-form').addEventListener('submit', async function (e) {
  e.preventDefault();

  var btn      = document.getElementById('submit-btn');
  var label    = document.getElementById('btn-label');
  var arrow    = document.getElementById('btn-arrow');
  var spinner  = document.getElementById('btn-spinner');
  var username = document.getElementById('inp-user').value.trim();
  var password = document.getElementById('inp-pass').value;

  if (!username || !password) return;

  // Loading state
  btn.disabled   = true;
  label.textContent = 'Signing in…';
  arrow.style.display   = 'none';
  spinner.style.display = '';

  hide('alert-error');
  hide('alert-locked');

  try {
    var res  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username: username, password: password }),
    });

    var data = await res.json();

    if (res.ok) {
      // ── Success ──────────────────────────────────
      localStorage.setItem('auth_token', data.token);
      label.textContent         = 'Access granted';
      spinner.style.display     = 'none';
      arrow.style.display       = '';
      btn.classList.add('success');

      setTimeout(function () { window.location.replace('/'); }, 600);

    } else if (res.status === 429) {
      // ── Locked out ───────────────────────────────
      spinner.style.display = 'none';
      arrow.style.display   = '';
      label.textContent     = 'Locked';
      btn.classList.add('locked-state');
      showLocked(data.error || 'Too many attempts. Please wait.');
      showAttempts(MAX_ATTEMPTS);
      // Keep button disabled while locked
      document.getElementById('inp-user').disabled = true;
      document.getElementById('inp-pass').disabled = true;

    } else {
      // ── Invalid credentials ───────────────────────
      var attempts = data.attempts_used !== undefined
        ? data.attempts_used
        : usedAttempts + 1;

      showAttempts(attempts);
      showError(data.error || 'Invalid credentials.');

      // Reset button
      btn.disabled          = false;
      label.textContent     = 'Sign In';
      spinner.style.display = 'none';
      arrow.style.display   = '';

      // Clear password, refocus
      document.getElementById('inp-pass').value = '';
      document.getElementById('inp-pass').focus();
    }

  } catch (_) {
    showError('Connection error — check server status.');
    btn.disabled          = false;
    label.textContent     = 'Sign In';
    spinner.style.display = 'none';
    arrow.style.display   = '';
  }
});

/* ── Focus username on load ──────────────────────── */
window.addEventListener('load', function () {
  document.getElementById('inp-user').focus();
});
