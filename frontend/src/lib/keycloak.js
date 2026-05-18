import Keycloak from 'keycloak-js';

// Keep these defaults aligned with the whatsapp_app realm so both SPAs share
// the same Keycloak SSO session. Override per-environment via Vite env vars.
const KEYCLOAK_URL = import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8180';
const KEYCLOAK_REALM = import.meta.env.VITE_KEYCLOAK_REALM || 'inforoot';
const KEYCLOAK_CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'inforoot-web';

const REFRESH_TOKEN_KEY = 'kc_refresh_token';
const ID_TOKEN_KEY = 'kc_id_token';

export const keycloak = new Keycloak({
  url: KEYCLOAK_URL,
  realm: KEYCLOAK_REALM,
  clientId: KEYCLOAK_CLIENT_ID,
});

let initPromise = null;

export function initKeycloak() {
  if (initPromise) return initPromise;

  initPromise = keycloak
    .init({
      onLoad: 'check-sso',
      pkceMethod: 'S256',
      checkLoginIframe: false,
      refreshToken: localStorage.getItem(REFRESH_TOKEN_KEY) ?? undefined,
      idToken: localStorage.getItem(ID_TOKEN_KEY) ?? undefined,
    })
    .then((authenticated) => {
      if (authenticated) persistTokens();
      return authenticated;
    })
    .catch((err) => {
      console.error('Keycloak init failed:', err);
      clearPersistedTokens();
      return false;
    });

  keycloak.onAuthSuccess = persistTokens;
  keycloak.onAuthRefreshSuccess = persistTokens;
  keycloak.onAuthLogout = clearPersistedTokens;
  keycloak.onTokenExpired = () => {
    keycloak.updateToken(30).catch(() => {
      clearPersistedTokens();
      keycloak.login();
    });
  };

  return initPromise;
}

function persistTokens() {
  if (keycloak.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, keycloak.refreshToken);
  if (keycloak.idToken) localStorage.setItem(ID_TOKEN_KEY, keycloak.idToken);
}

function clearPersistedTokens() {
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(ID_TOKEN_KEY);
}

export function isAuthenticated() {
  return !!keycloak.authenticated;
}

export function getAccessToken() {
  return keycloak.token;
}

export async function ensureFreshToken(minValiditySeconds = 30) {
  if (!keycloak.authenticated) return undefined;
  try {
    await keycloak.updateToken(minValiditySeconds);
  } catch {
    clearPersistedTokens();
    await keycloak.login();
    return undefined;
  }
  return keycloak.token;
}

export function login(redirectUri = window.location.origin + '/') {
  return keycloak.login({ redirectUri });
}

export function logout(redirectUri = window.location.origin + '/login') {
  clearPersistedTokens();
  return keycloak.logout({ redirectUri });
}

export function getUsername() {
  return keycloak.tokenParsed?.preferred_username;
}
