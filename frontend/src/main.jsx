import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initKeycloak } from './lib/keycloak';

// Apply persisted theme as early as possible so we don't flash the wrong one.
const initialTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', initialTheme);

// Initialize Keycloak (SSO check) BEFORE mounting React so the first render
// already knows whether the user is authenticated — no flash of guarded UI.
initKeycloak().finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
