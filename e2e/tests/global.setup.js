import fs from 'node:fs';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { loadAdminCreds } from '../lib/admin-creds.js';

const STORAGE = 'playwright/.auth/admin.json';

/**
 * Logs the admin in once and saves the resulting localStorage (where the
 * React app stores the auth token) to a storage-state file. Every other
 * test reuses it via `storageState` in playwright.config.js, so we only
 * pay the login cost once per `npm test` invocation.
 */
setup('authenticate as admin', async ({ page }) => {
  fs.mkdirSync(path.dirname(STORAGE), { recursive: true });

  const { username, password } = loadAdminCreds();

  await page.goto('/app/login');

  await page.locator('#inp-user').fill(username);
  await page.locator('#inp-pass').fill(password);
  await page.locator('#submit-btn').click();

  // Successful login redirects to /app/. Wait for the sidebar to render
  // before saving — that's our proof the auth context is initialized.
  await expect(page).toHaveURL(/\/app\/?(\?.*)?$/);
  await expect(page.locator('aside.sidebar')).toBeVisible();

  await page.context().storageState({ path: STORAGE });
});
