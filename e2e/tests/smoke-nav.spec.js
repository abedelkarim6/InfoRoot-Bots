import { test, expect } from '@playwright/test';

/**
 * Smoke-walks every sidebar destination an admin can see.
 *
 * For each page we:
 *   1. Navigate via URL (more deterministic than clicking the sidebar link
 *      since some pages are inside collapsible sections).
 *   2. Wait for the page <h2> heading to render — this is our proof that the
 *      route resolved AND the React tree mounted without throwing.
 *   3. Assert no `console.error` events fired during navigation. This catches
 *      uncaught render exceptions that don't blow up the page but still
 *      indicate broken UI (failed prop types, undefined access, etc.).
 *
 * Pages that fetch external systems (Telegram, YouTube) only need to render
 * the shell — we don't wait for live data, so a missing telegram session
 * won't fail this suite.
 */

const ROUTES = [
  { path: '/app/',            label: 'Main Dashboard' },
  { path: '/app/dashboard',   label: 'Summaries Dashboard' },
  { path: '/app/bots',        label: 'Bots' },
  { path: '/app/monitor',     label: 'Monitor' },
  { path: '/app/recycle-bin', label: 'Recycle Bin' },
  { path: '/app/yt-videos',   label: 'YouTube Videos' },
  { path: '/app/yt-channels', label: 'YouTube Channels' },
  { path: '/app/yt-keywords', label: 'YouTube Keywords' },
  { path: '/app/yt-chat',     label: 'Video Chat' },
  { path: '/app/agent-chat',  label: 'Agent Chat' },
  { path: '/app/profile',     label: 'Profile' },
  { path: '/app/accounts',    label: 'Accounts (admin)' },
  { path: '/app/tg-tester',   label: 'TG Tester (admin)' },
  { path: '/app/logs',        label: 'Logs (admin)' },
  { path: '/app/ai-usage',    label: 'AI Usage (admin)' }
];

// console.error sources we deliberately ignore. Tighten this list over time
// as the underlying issues get fixed — every entry here is a known papercut.
const IGNORED_CONSOLE_PATTERNS = [
  /Failed to load resource.*404/i,                       // missing favicons, optional assets
  /ResizeObserver loop limit exceeded/i,
  /ResizeObserver loop completed with undelivered/i,
  /Download the React DevTools/i
];

function shouldIgnore(text) {
  return IGNORED_CONSOLE_PATTERNS.some((rx) => rx.test(text));
}

for (const { path, label } of ROUTES) {
  test(`smoke: ${label} (${path}) renders without console errors`, async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !shouldIgnore(msg.text())) {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`pageerror: ${err.message}`);
    });

    await page.goto(path);

    // The AppShell renders a single <h2> per page (PageHeader). If we never
    // see one, the route either failed or got redirected somewhere unexpected.
    await expect(page.locator('main h2, .page-header h2').first()).toBeVisible({
      timeout: 10_000
    });

    expect(consoleErrors, `Console errors on ${path}:\n${consoleErrors.join('\n')}`).toEqual([]);
  });
}
