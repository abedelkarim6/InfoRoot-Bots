// Verification-only entry: mounts the REAL <App/> (full routing tree,
// BrowserRouter, ProtectedRoute, useUrlState hooks) WITHOUT the Keycloak
// redirect that main.jsx performs. The backend/auth boundary is stubbed by
// the CDP driver via Fetch interception — nothing in the routing/history code
// under test is replaced.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App.jsx';

document.documentElement.setAttribute('data-theme', 'dark');
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
