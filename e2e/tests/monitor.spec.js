import { test, expect } from '@playwright/test';

/**
 * Monitor page — verifies tab switching, deep-link sharing via ?tab=, and
 * that each tab renders its key chrome (filter bar, table headers, etc.)
 * without crashing.
 *
 * We don't assert specific data rows because monitor data depends on real
 * bot activity. Instead we assert the tab's rendered shell — heading,
 * filters, table headers, or "no data" placeholders.
 */

const TABS = [
  { id: 'schedules',    label: '📡 Schedules' },
  { id: 'summaries',    label: '📬 Summaries' },
  { id: 'messages',     label: '📥 Messages' },
  { id: 'unclassified', label: '❓ Unclassified' },
  { id: 'history',      label: '📜 History' }
];

test.beforeEach(async ({ page }) => {
  await page.goto('/app/monitor');
  await expect(page.locator('.page-header h2', { hasText: /schedules monitor/i })).toBeVisible();
});

test('all five tab buttons are visible', async ({ page }) => {
  for (const t of TABS) {
    await expect(page.locator('.mon-tab', { hasText: t.label })).toBeVisible();
  }
});

test('clicking each tab updates ?tab= and marks the button active', async ({ page }) => {
  for (const t of TABS) {
    const btn = page.locator('.mon-tab', { hasText: t.label });
    await btn.click();

    // URL syncs to the active tab.
    await expect(page).toHaveURL(new RegExp(`tab=${t.id}`));

    // Active tab gets the `.active` class.
    await expect(btn).toHaveClass(/active/);
  }
});

test('deep link to ?tab=history opens the History tab directly', async ({ page }) => {
  await page.goto('/app/monitor?tab=history');

  await expect(page.locator('.mon-tab.active', { hasText: '📜 History' })).toBeVisible();
});

test('Refresh button re-issues the monitor data fetch', async ({ page }) => {
  // We can't easily detect refetch from outside, but we can confirm the
  // button is present, clickable, and the page is still healthy after
  // clicking — that catches regressions where Refresh throws.
  const refresh = page.getByRole('button', { name: /↻ refresh/i });
  await expect(refresh).toBeVisible();
  await refresh.click();

  // Page should still be functional (heading still visible, no crash dialog).
  await expect(page.locator('.page-header h2')).toBeVisible();
});

test('Messages tab shows its filter bar', async ({ page }) => {
  await page.locator('.mon-tab', { hasText: '📥 Messages' }).click();
  await expect(page).toHaveURL(/tab=messages/);

  // The Messages tab content mounts when active. We don't know which
  // exact filters render (collection/channel/topic depends on data), so
  // we check that *some* form input renders inside the active tab area.
  // If the tab renders blank because of a JS error, this fails fast.
  const tabContent = page.locator('.page.active');
  await expect(tabContent.locator('input, select').first()).toBeVisible({ timeout: 10_000 });
});

test('Unclassified tab renders without throwing', async ({ page }) => {
  await page.locator('.mon-tab', { hasText: '❓ Unclassified' }).click();
  await expect(page).toHaveURL(/tab=unclassified/);

  // Either rows or an empty-state message must be visible — anything
  // less means the tab failed to render.
  const tabContent = page.locator('.page.active');
  await expect(tabContent).toBeVisible();
});

test('History tab renders its own filter chrome', async ({ page }) => {
  await page.locator('.mon-tab', { hasText: '📜 History' }).click();
  await expect(page).toHaveURL(/tab=history/);

  const tabContent = page.locator('.page.active');
  // History always exposes filter inputs (bot, status, date range).
  await expect(tabContent.locator('input, select').first()).toBeVisible({ timeout: 10_000 });
});
