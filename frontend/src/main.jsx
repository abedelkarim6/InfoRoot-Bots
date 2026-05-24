import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initKeycloak } from './lib/keycloak';

// Apply persisted theme as early as possible so we don't flash the wrong one.
const initialTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', initialTheme);

// keycloak-js with onLoad: 'login-required' redirects unauthenticated users
// to the Keycloak hosted login page during init() — React never mounts in
// that state, so we don't need any redirect logic inside the app. We only
// reach createRoot once the user is signed in (or the redirect failed).
initKeycloak().then((authenticated) => {
  if (!authenticated) {
    // init() should have redirected. If we're still here without an
    // authenticated session, Keycloak is unreachable. Show a plain error.
    document.body.innerHTML =
      '<div style="font-family:system-ui;padding:40px;color:#e6e9ef;background:#0b0f1a;min-height:100vh">' +
      '<h2>Authentication unavailable</h2>' +
      '<p>Could not reach the Keycloak server. Please try again later.</p>' +
      '</div>';
    return;
  }
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
