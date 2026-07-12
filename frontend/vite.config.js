import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// FastAPI backend during dev. Override with VITE_API_TARGET if your backend runs elsewhere.
const API_TARGET = process.env.VITE_API_TARGET || 'http://127.0.0.1:8000';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy all backend API calls + auth + youtube WebSub to FastAPI
      '/api':    { target: API_TARGET, changeOrigin: true },
      '/youtube': { target: API_TARGET, changeOrigin: true }
    }
  },
  build: {
    // Build into ../static_react so FastAPI can mount it as /static_react
    // without disturbing the existing /static folder.
    outDir: '../static_react',
    emptyOutDir: true,
    assetsDir: 'assets'
  },
  // Production build is served by FastAPI at /static_react/* — assets must be
  // referenced with that prefix. During `vite dev` we serve the SPA at the
  // root so the Keycloak callback redirect_uri (origin + '/') lands on the
  // running SPA; otherwise / returns nothing and the OIDC callback is dropped.
  base: command === 'build' ? '/static_react/' : '/'
}));
