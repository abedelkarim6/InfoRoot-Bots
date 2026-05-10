# Page conventions (Phase 3 reference)

Every ported page in `src/pages/` should follow these rules. The canonical
example is [`RecycleBinPage.jsx`](./RecycleBinPage.jsx) — read it first, then
copy the structure.

## File layout

- One `*.jsx` file per page, default-exporting the page component.
- If a page grows past ~400 lines, split sub-sections into sibling files
  (e.g. `MonitorPage.jsx` + `monitor/SchedulesTab.jsx`).
- Local helper functions (date math, group-by, formatters) live at the bottom
  of the file. Move to `src/lib/` only when reused across pages.

## Data fetching — TanStack Query

```js
const { data, isLoading, refetch } = useQuery({
  queryKey: ['recycle-bin'],
  queryFn: () => api('/api/recycle-bin/list'),
});
```

- Use a stable `queryKey` per resource. Same key from different components
  shares the cache.
- Don't store API results in `useState`. Let the cache be the source of truth.
- Polling? `refetchInterval: 5000` on the query. Stop on unmount automatically.

## Mutations — `useApiMutation`

```js
const restore = useApiMutation('/api/recycle-bin/restore', {
  invalidate: ['recycle-bin', 'config'],
  successMsg: 'Item restored',
  errorMsg: 'Restore failed',
});
restore.mutate({ id: 42 });
```

- `invalidate` lists the query keys to refetch on success — this replaces the
  legacy `loadAllData()` + manual re-render pattern.
- `successMsg` / `errorMsg` go through `showNotification` automatically.
- Disable buttons while `mutation.isPending`.

## Confirm dialogs — `useConfirmedMutation`

```js
const confirmDelete = useConfirmedMutation(deleteMutation, {
  message: 'Delete this item?',
  title: 'Delete',
  confirmLabel: 'Delete',
  confirmClass: 'btn-danger',
});
<button onClick={() => confirmDelete({ id })}>Delete</button>
```

For one-off prompts, `useDialogs()` exposes `showAlert`, `showConfirm`,
`showPrompt`, and `showNotification` directly.

## Styling

- Reuse the legacy CSS class names from `src/styles/modern.css` (e.g.
  `.btn .btn-primary`, `.card`, `.page-header`, `.rb-item`). Do **not** add
  inline styles when a class already exists.
- Wrap the page in `<div className="page active">`. The `.active` class is
  what triggers the page's CSS visibility — keep it.
- Use `<PageHeader>` from `src/components/PageHeader.jsx` for the title row.

## Auth

- `useAuth()` gives `{ user, isAdmin, logout }`. Use it for in-page admin
  guards; the route-level guard in `ProtectedRoute` already blocks the URL.
- Never read `localStorage.auth_token` directly — go through `useAuth`.

## What NOT to do

- ❌ `document.getElementById(...)` to mutate DOM. Render via state.
- ❌ Manually reading `result.status` after every `api()` call when a mutation
  helper would do it.
- ❌ Importing legacy JS from `static/js/`. Port the logic, don't link to it.
- ❌ Duplicating dialog/notification components. Use `useDialogs()`.
- ❌ Hard-coding admin check via `user?.role`. Use `isAdmin` from `useAuth()`.
