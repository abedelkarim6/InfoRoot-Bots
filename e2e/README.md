# SummariesBotv2 — Playwright E2E suite

UI/QA automation for the React frontend. Targets the **built** React app
served by FastAPI at `http://localhost:8000/app` (the same path real users
hit), not the Vite dev server.

## What's covered

| File | Scope |
|------|-------|
| `tests/auth.spec.js` | Login (success / wrong password / locked-out alert), unauthenticated redirect to `/login`, logout. |
| `tests/smoke-nav.spec.js` | Navigates every admin-visible page; asserts the page heading renders and no `console.error` / `pageerror` fires. |
| `tests/bot-crud.spec.js` | Create → rename → duplicate → delete a bot through the UI. |
| `tests/monitor.spec.js` | Tab switching, `?tab=` deep links, Refresh button, per-tab render checks. |

## Prerequisites

1. **Server running** at `http://localhost:8000` with the React build mounted
   (i.e. `static_react/index.html` exists). Start the server normally —
   the tests don't spawn it.

   ```powershell
   .\bot\Scripts\python.exe -m uvicorn app:app --port 8000
   ```

2. **React build present**. If you've changed frontend code recently:

   ```powershell
   cd frontend
   npm run build
   ```

3. **Admin credentials** in `config.yaml` under the `admin:` block. The setup
   step reads them directly — same source as `tests/conftest.py`.

## First-time setup

```powershell
cd e2e
npm install
npm run install-browsers   # downloads Chromium (~150 MB, one-time)
```

## Running

```powershell
cd e2e

# Headless run (CI default)
npm test

# Watch tests run in a real browser
npm run test:headed

# Interactive debugger UI (best for writing/fixing tests)
npm run test:ui

# Open the HTML report from the last run
npm run report
```

Override the target server:

```powershell
$env:E2E_BASE_URL = "http://localhost:5173"   # Vite dev server
npm test
```

## Test data

All UI-created records use the prefix `_e2e_` so cleanup is unambiguous and
collisions with real data are impossible. Each test cleans up before AND
after itself, so a crashed run won't leave the DB in a bad state.

## When tests fail

- **Login setup fails** → check the server is running and `config.yaml` has
  valid `admin.username` / `admin.password`.
- **Smoke nav reports console errors** → check `playwright-report/` for the
  trace. The error list is intentionally strict; if a known harmless error
  is flagging a test, add a regex to `IGNORED_CONSOLE_PATTERNS` in
  `smoke-nav.spec.js` (and open a bug for the underlying issue).
- **Bot CRUD fails on rename / duplicate** → the React routes for
  `/app/bots/<name>` may have changed. Update the URL regexes in
  `bot-crud.spec.js`.
- **Monitor tab assertions fail** → tab IDs (`?tab=schedules`, etc.) and tab
  button labels (`📡 Schedules`, etc.) come from `MonitorPage.jsx`. If
  those changed, sync `tests/monitor.spec.js`.

## Notes on architecture

- One **setup** project (`global.setup.js`) logs in once and saves the
  resulting `localStorage` to `playwright/.auth/admin.json`. Every other
  project loads that storage state — so we pay the login cost once per run.
- Tests run **serially** (`workers: 1`, `fullyParallel: false`) because
  they mutate shared server state (DB rows). Don't enable parallelism
  without isolating per-test data first.
- Direct API calls inside tests (e.g. seeding a bot before a rename test)
  pull the token from `localStorage.auth_token`, matching how the React
  app's `lib/api.js` authenticates.
