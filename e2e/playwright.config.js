import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for SummariesBotv2.
 *
 * Default target: built React app served by FastAPI at http://localhost:8000/app
 * Override:        E2E_BASE_URL=http://localhost:5173 npm test  (vite dev)
 *
 * The server must already be running. We do NOT spawn it from here — startup
 * involves DB migrations, the Telegram userbot, the YouTube scheduler, etc.
 * Running it under Playwright's webServer would slow every run and risk
 * flakiness from background tasks.
 */
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false, // tests mutate server-side state; run serially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './playwright-report' }]
  ],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 7_000,
    navigationTimeout: 15_000
  },
  projects: [
    // Sets up storageState (logged-in admin) once. Other projects depend on it.
    {
      name: 'setup',
      testMatch: /global\.setup\.js/
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/admin.json'
      },
      dependencies: ['setup']
    }
  ]
});
