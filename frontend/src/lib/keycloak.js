import Keycloak from 'keycloak-js';

// Same realm as whatsapp_app so logging into one signs you into the other.
const KEYCLOAK_URL = import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8180';
const KEYCLOAK_REALM = import.meta.env.VITE_KEYCLOAK_REALM || 'inforoot';
const KEYCLOAK_CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'aibot';

export const keycloak = new Keycloak({
  url: KEYCLOAK_URL,
  realm: KEYCLOAK_REALM,
  clientId: KEYCLOAK_CLIENT_ID,
});

let initPromise = null;

/**
 * Initialize Keycloak with onLoad: 'login-required'.
 *
 * If there is no active session, keycloak-js redirects the browser straight to
 * the Keycloak login page. React never mounts in that state, so we don't need
 * any custom redirect logic in components — by the time React renders, the
 * user is authenticated.
 *
 * On the OAuth callback (?code=…&state=…), keycloak-js consumes the params,
 * exchanges the code for tokens, and resolves init() with authenticated=true.
 * It also schedules silent refreshes via onTokenExpired below.
 */
export function initKeycloak() {
  if (initPromise) return initPromise;
  initPromise = keycloak.init({
    onLoad: 'login-required',
    pkceMethod: 'S256',
    checkLoginIframe: false,
  }).catch((err) => {
    console.error('Keycloak init failed:', err);
    return false;
  });
  keycloak.onTokenExpired = () => {
    keycloak.updateToken(30).catch(() => keycloak.login());
  };
  return initPromise;
}

export function getAccessToken() {
  return keycloak.token;
}

export async function ensureFreshToken(minValiditySeconds = 30) {
  if (!keycloak.authenticated) return undefined;
  try {
    await keycloak.updateToken(minValiditySeconds);
  } catch {
    await keycloak.login();
    return undefined;
  }
  return keycloak.token;
}

export function logout(redirectUri = window.location.origin + '/') {
  return keycloak.logout({ redirectUri });
}
