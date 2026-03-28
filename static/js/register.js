'use strict';

/* ── Redirect if already authenticated ────────── */
(function () {
  if (localStorage.getItem('auth_token')) {
    window.location.replace('/');
  }
}());

/* ── State ────────────────────────────────────── */
var authToken = null;   // set after step 1 succeeds
var phoneNumber = null; // full international number used in step 2
var currentStep = 1;

/* ── Progress dots ────────────────────────────── */
function setProgress(step) {
  currentStep = step;
  for (var i = 1; i <= 3; i++) {
    var dot = document.getElementById('dot-s' + i);
    dot.className = 'progress-dot' +
      (i < step ? ' done' : (i === step ? ' active' : ''));
  }
}

/* ── Step navigation ──────────────────────────── */
function showStep(name) {
  document.querySelectorAll('.step').forEach(function (el) {
    el.classList.remove('active');
  });
  document.getElementById('step-' + name).classList.add('active');
}

/* ── Eye-toggle helper ────────────────────────── */
window.togglePass = function (inputId, iconId) {
  var inp  = document.getElementById(inputId);
  var icon = document.getElementById(iconId);
  var show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  icon.innerHTML = show
    ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>' +
      '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/>'
    : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>' +
      '<circle cx="12" cy="12" r="3"></circle>';
};

/* ── Alert helpers ────────────────────────────── */
function showAlert(id, msg) {
  var el = document.getElementById(id);
  var textEl = document.getElementById(id + '-text');
  if (textEl) textEl.textContent = msg;
  el.classList.remove('visible');
  void el.offsetWidth; // re-trigger animation
  el.classList.add('visible');
}

function hideAlert(id) {
  document.getElementById(id).classList.remove('visible');
}

/* ── Button loading state ─────────────────────── */
function btnLoading(prefix, loading) {
  var btn     = document.getElementById(prefix + '-btn');
  var label   = document.getElementById(prefix + '-label') || document.getElementById(prefix + '-btn-label');
  var arrow   = document.getElementById(prefix + '-arrow') || document.getElementById(prefix + '-btn-arrow');
  var spinner = document.getElementById(prefix + '-spinner') || document.getElementById(prefix + '-btn-spinner');
  btn.disabled = loading;
  if (spinner) spinner.style.display = loading ? '' : 'none';
  if (arrow)   arrow.style.display   = loading ? 'none' : '';
}

/* ── STEP 1: Register account ──────────────────── */
document.getElementById('register-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  hideAlert('reg-error');

  var username = document.getElementById('inp-user').value.trim();
  var password = document.getElementById('inp-pass').value;
  var password2 = document.getElementById('inp-pass2').value;

  if (password !== password2) {
    showAlert('reg-error', 'Passwords do not match.');
    return;
  }

  btnLoading('reg', true);
  document.getElementById('reg-btn-label').textContent = 'Creating…';

  try {
    var res  = await fetch('/api/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username: username, password: password }),
    });
    var data = await res.json();

    if (res.ok) {
      authToken = data.token;
      localStorage.setItem('auth_token', authToken);
      // Advance to Telegram step
      setProgress(2);
      showStep('telegram');
    } else {
      showAlert('reg-error', data.error || 'Registration failed.');
      btnLoading('reg', false);
      document.getElementById('reg-btn-label').textContent = 'Create Account';
    }
  } catch (_) {
    showAlert('reg-error', 'Connection error — check server status.');
    btnLoading('reg', false);
    document.getElementById('reg-btn-label').textContent = 'Create Account';
  }
});

/* ── STEP 2A: Send Telegram code ──────────────── */
window.sendTgCode = async function () {
  hideAlert('tg-error');

  var prefix = document.getElementById('country-code').value;
  // Strip spaces, dashes, parentheses and leading zeros from the local part
  var local  = document.getElementById('inp-phone').value
    .trim()
    .replace(/[\s\-().]/g, '')
    .replace(/^0+/, '');
  if (!local) {
    showAlert('tg-error', 'Please enter your phone number.');
    return;
  }
  phoneNumber = prefix + local;

  var btn     = document.getElementById('tg-send-btn');
  var label   = document.getElementById('tg-send-label');
  var arrow   = document.getElementById('tg-send-arrow');
  var spinner = document.getElementById('tg-send-spinner');
  btn.disabled = true;
  label.textContent = 'Sending…';
  arrow.style.display   = 'none';
  spinner.style.display = '';

  try {
    var res  = await fetch('/api/auth/telegram/send-code', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
      },
      body: JSON.stringify({ phone: phoneNumber }),
    });
    var data = await res.json();

    btn.disabled = false;
    label.textContent = 'Send Code';
    arrow.style.display   = '';
    spinner.style.display = 'none';

    if (res.ok) {
      document.getElementById('tg-otp-hint').textContent =
        'Enter the code sent to ' + phoneNumber + ' via Telegram.';
      document.getElementById('tg-phone-section').style.display = 'none';
      document.getElementById('tg-otp-section').style.display   = '';
      setTimeout(function () { document.getElementById('inp-otp').focus(); }, 50);
    } else {
      showAlert('tg-error', data.error || 'Failed to send code.');
    }
  } catch (_) {
    btn.disabled = false;
    label.textContent = 'Send Code';
    arrow.style.display   = '';
    spinner.style.display = 'none';
    showAlert('tg-error', 'Connection error.');
  }
};

/* ── STEP 2B: Verify OTP ──────────────────────── */
window.verifyTgCode = async function () {
  hideAlert('otp-error');

  var code = document.getElementById('inp-otp').value.trim();
  if (!code) {
    showAlert('otp-error', 'Please enter the verification code.');
    return;
  }

  var btn     = document.getElementById('tg-verify-btn');
  var label   = document.getElementById('tg-verify-label');
  var arrow   = document.getElementById('tg-verify-arrow');
  var spinner = document.getElementById('tg-verify-spinner');
  btn.disabled = true;
  label.textContent = 'Verifying…';
  arrow.style.display   = 'none';
  spinner.style.display = '';

  try {
    var res  = await fetch('/api/auth/telegram/verify-code', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
      },
      body: JSON.stringify({ phone: phoneNumber, code: code }),
    });
    var data = await res.json();

    btn.disabled = false;
    label.textContent = 'Verify';
    arrow.style.display   = '';
    spinner.style.display = 'none';

    if (res.ok) {
      if (data.status === 'needs_2fa') {
        document.getElementById('tg-otp-section').style.display = 'none';
        document.getElementById('tg-2fa-section').style.display = '';
        setTimeout(function () { document.getElementById('inp-2fa').focus(); }, 50);
      } else {
        // Linked successfully
        finishWithTelegram();
      }
    } else {
      showAlert('otp-error', data.error || 'Invalid code.');
    }
  } catch (_) {
    btn.disabled = false;
    label.textContent = 'Verify';
    arrow.style.display   = '';
    spinner.style.display = 'none';
    showAlert('otp-error', 'Connection error.');
  }
};

/* ── STEP 2C: 2FA ─────────────────────────────── */
window.verify2FA = async function () {
  hideAlert('twofa-error');

  var password = document.getElementById('inp-2fa').value;
  if (!password) {
    showAlert('twofa-error', 'Please enter your 2FA password.');
    return;
  }

  var btn     = document.getElementById('tg-2fa-btn');
  var label   = document.getElementById('tg-2fa-label');
  var arrow   = document.getElementById('tg-2fa-arrow');
  var spinner = document.getElementById('tg-2fa-spinner');
  btn.disabled = true;
  label.textContent = 'Confirming…';
  arrow.style.display   = 'none';
  spinner.style.display = '';

  try {
    var res  = await fetch('/api/auth/telegram/verify-2fa', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
      },
      body: JSON.stringify({ phone: phoneNumber, password: password }),
    });
    var data = await res.json();

    btn.disabled = false;
    label.textContent = 'Confirm';
    arrow.style.display   = '';
    spinner.style.display = 'none';

    if (res.ok && data.status === 'ok') {
      finishWithTelegram();
    } else {
      showAlert('twofa-error', data.error || 'Incorrect password.');
    }
  } catch (_) {
    btn.disabled = false;
    label.textContent = 'Confirm';
    arrow.style.display   = '';
    spinner.style.display = 'none';
    showAlert('twofa-error', 'Connection error.');
  }
};

/* ── Navigation helpers ───────────────────────── */
window.goBackToPhone = function () {
  document.getElementById('tg-otp-section').style.display   = 'none';
  document.getElementById('tg-2fa-section').style.display   = 'none';
  document.getElementById('tg-phone-section').style.display = '';
  document.getElementById('inp-otp').value = '';
  hideAlert('otp-error');
};

function finishWithTelegram() {
  setProgress(3);
  showStep('done');
  document.getElementById('done-sub').textContent =
    'Your account is ready and Telegram has been linked.';
}

window.goToApp = function () {
  window.location.replace('/');
};

/* ── Auto-focus on load ───────────────────────── */
window.addEventListener('load', function () {
  document.getElementById('inp-user').focus();
});
