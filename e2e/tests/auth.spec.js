import { test, expect } from '@playwright/test';
import { loadAdminCreds } from '../lib/admin-creds.js';

test.describe('Auth flow', () => {
  test('admin can log in and lands on the dashboard', async ({ page, browser }) => {
    // Use a clean context — we want to test the actual login flow, not the
    // pre-authenticated storage state shared by the rest of the suite.
    const ctx = await browser.newContext({ storageState: undefined });
    const fresh = await ctx.newPage();
    const { username, password } = loadAdminCreds();

    await fresh.goto('/app/login');
    await fresh.locator('#inp-user').fill(username);
    await fresh.locator('#inp-pass').fill(password);
    await fresh.locator('#submit-btn').click();

    await expect(fresh).toHaveURL(/\/app\/?(\?.*)?$/);
    await expect(fresh.locator('aside.sidebar')).toBeVisible();
    await expect(fresh.getByRole('heading', { level: 2 })).toBeVisible();

    await ctx.close();
  });

  test('wrong password shows an error and stays on login', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: undefined });
    const page = await ctx.newPage();

    await page.goto('/app/login');
    await page.locator('#inp-user').fill('admin');
    await page.locator('#inp-pass').fill('definitely-not-the-password');
    await page.locator('#submit-btn').click();

    // Error alert becomes visible and we don't navigate away.
    await expect(page.locator('.alert.alert-error.visible')).toBeVisible();
    await expect(page).toHaveURL(/\/app\/login/);

    await ctx.close();
  });

  test('protected route redirects to /login when unauthenticated', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: undefined });
    const page = await ctx.newPage();

    await page.goto('/app/bots');
    await expect(page).toHaveURL(/\/app\/login/);

    await ctx.close();
  });

  test('logout returns the user to the login page', async ({ page }) => {
    // Uses the shared admin storage state, so we start logged in.
    await page.goto('/app/');
    await expect(page.locator('aside.sidebar')).toBeVisible();

    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/app\/login/);
  });
});
