import { test, expect } from '@playwright/test';

/**
 * Bot CRUD via the UI: create → rename → duplicate → delete.
 *
 * All test data uses the `_e2e_` prefix so cleanup is unambiguous and a
 * failed run can't collide with real bots. We also clean up via the API at
 * the start of each test so partial state from a prior crash doesn't break
 * the run.
 *
 * Why API cleanup instead of UI: the delete confirm dialog only fires on
 * existing bots, so cleaning up via UI requires conditional logic and slows
 * the suite down with no extra coverage — the actual delete flow is
 * exercised in the dedicated test.
 */

const PREFIX = '_e2e_';
const BOT       = `${PREFIX}bot`;
const BOT_RENAMED = `${PREFIX}bot_renamed`;
const BOT_DUP   = `${PREFIX}bot_dup`;

async function apiDeleteBot(request, name) {
  // The shared admin storage state injects the Bearer token via the page,
  // not the APIRequestContext. Pull the token off page storage so direct
  // API calls authenticate the same way.
  await request.post('/api/bot/delete', { data: { name } }).catch(() => {});
}

test.beforeEach(async ({ page }) => {
  // Visit the bots page so localStorage is populated, then send an
  // authenticated API request to clear test bots from previous runs.
  await page.goto('/app/bots');
  await expect(page.locator('#bots-page')).toBeVisible();

  for (const name of [BOT, BOT_RENAMED, BOT_DUP]) {
    await page.evaluate(async (botName) => {
      const token = localStorage.getItem('auth_token');
      if (!token) return;
      await fetch('/api/bot/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name: botName })
      }).catch(() => {});
    }, name);
  }

  // Force a fresh config fetch so the deleted bots disappear from the DOM.
  await page.reload();
  await expect(page.locator('#bots-page')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  for (const name of [BOT, BOT_RENAMED, BOT_DUP]) {
    await page.evaluate(async (botName) => {
      const token = localStorage.getItem('auth_token');
      if (!token) return;
      await fetch('/api/bot/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name: botName })
      }).catch(() => {});
    }, name);
  }
});

test('create a new bot from the list page', async ({ page }) => {
  await page.locator('#new-bot-name').fill(BOT);
  await page.getByRole('button', { name: /^create bot$/i }).click();

  // After create the app navigates to /bots/<name> (BotDetail view).
  await expect(page).toHaveURL(new RegExp(`/app/bots/${encodeURIComponent(BOT)}$`));

  // Heading on the detail page reflects the bot name.
  await expect(page.locator('.page-header h2')).toContainText(BOT);

  // Going back to the list view should show the new card.
  await page.goto('/app/bots');
  await expect(page.locator('.bot-list-name', { hasText: BOT })).toBeVisible();
});

test('rename a bot via Basic Settings', async ({ page }) => {
  // Seed the bot via API so the test focuses on the rename flow.
  await page.evaluate(async (botName) => {
    const token = localStorage.getItem('auth_token');
    await fetch('/api/bot/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ name: botName, create_only: true, enabled: false })
    });
  }, BOT);

  await page.goto(`/app/bots/${encodeURIComponent(BOT)}`);
  await expect(page.locator('.page-header h2')).toContainText(BOT);

  // Two ✏️ Rename buttons exist on this page — one in the detail header
  // (opens a modal), one inline in Basic Settings (acts on the adjacent
  // input). Scope to the form-group that owns the bot-name-input field
  // so we hit the inline button only.
  const input = page.locator(`#bot-name-input-${BOT}`);
  await input.fill(BOT_RENAMED);
  const inlineForm = page.locator('.form-group', {
    has: page.locator(`#bot-name-input-${BOT}`)
  });
  await inlineForm.getByRole('button', { name: /✏️ rename/i }).click();

  // The detail route swaps to the new name.
  await expect(page).toHaveURL(new RegExp(`/app/bots/${encodeURIComponent(BOT_RENAMED)}$`));
  await expect(page.locator('.page-header h2')).toContainText(BOT_RENAMED);
});

test('duplicate a bot from the list card', async ({ page }) => {
  // Seed source bot.
  await page.evaluate(async (botName) => {
    const token = localStorage.getItem('auth_token');
    await fetch('/api/bot/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ name: botName, create_only: true, enabled: false })
    });
  }, BOT);

  await page.goto('/app/bots');
  const sourceCard = page.locator('.bot-list-card', { has: page.locator('.bot-list-name', { hasText: BOT }) });
  await expect(sourceCard).toBeVisible();

  // The duplicate button has the ⧉ glyph and a "Duplicate bot" title.
  await sourceCard.locator('button[title="Duplicate bot"]').click();

  const modal = page.locator('.modal-overlay');
  await expect(modal).toBeVisible();
  await expect(modal.locator('h3', { hasText: 'Duplicate Bot' })).toBeVisible();

  // The default new name is "Copy_of_<src>" — overwrite with the test value.
  await modal.locator('input.input').first().fill(BOT_DUP);
  await modal.getByRole('button', { name: /⧉ duplicate/i }).click();

  // App navigates to the duplicated bot's detail page after success.
  await expect(page).toHaveURL(new RegExp(`/app/bots/${encodeURIComponent(BOT_DUP)}$`), {
    timeout: 10_000
  });
  await expect(page.locator('.page-header h2')).toContainText(BOT_DUP);
});

test('delete a bot via the detail page', async ({ page }) => {
  // Seed.
  await page.evaluate(async (botName) => {
    const token = localStorage.getItem('auth_token');
    await fetch('/api/bot/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ name: botName, create_only: true, enabled: false })
    });
  }, BOT);

  await page.goto(`/app/bots/${encodeURIComponent(BOT)}`);
  await expect(page.locator('.page-header h2')).toContainText(BOT);

  // Header has a "🗑️ Delete" button that opens a confirm dialog.
  await page.getByRole('button', { name: /🗑️ delete/i }).click();

  // Confirm dialog → click the destructive Delete action.
  await expect(page.locator('.dialog-confirm')).toBeVisible();
  await page.locator('.dialog-confirm').click();

  // The user lands back on /bots.
  await expect(page).toHaveURL(/\/app\/bots\/?$/);
  await expect(page.locator('.bot-list-name', { hasText: BOT })).toHaveCount(0);
});
