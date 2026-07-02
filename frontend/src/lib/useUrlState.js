/**
 * URL-backed state hooks.
 *
 * Every navigation state (tabs, drill-down panels, filters, search boxes,
 * pagination) should use these instead of useState so that:
 *   - refreshing the page keeps you on the same view
 *   - the browser back button moves between views inside a page
 *   - URLs are shareable / bookmarkable
 *
 * Updates default to `{ replace: true }` so typing in a filter doesn't spam
 * history entries — only the *current* state lives in the URL. Genuine view
 * transitions (switching tabs, drilling into a detail panel) should instead
 * pass `{ push: true }` to the setter so the browser Back button returns to
 * the previous view:
 *   setTab('history', { push: true });
 *   setSummaryId(id, { push: true });
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * String-valued URL param.
 *   const [tab, setTab] = useUrlString('tab', 'categories');
 *
 * Setting the value to '' or null or the default value removes the param so
 * the URL stays clean. `defaultValue` is what `get()` returns when the param
 * is absent — it's NOT written to the URL when no one set it explicitly.
 */
export function useUrlString(key, defaultValue = '') {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key);
  const value = raw == null ? defaultValue : raw;

  const setValue = useCallback(
    (next, opts) => {
      const params = new URLSearchParams(window.location.search);
      const v = typeof next === 'function' ? next(params.get(key) ?? defaultValue) : next;
      if (v == null || v === '' || v === defaultValue) {
        params.delete(key);
      } else {
        params.set(key, String(v));
      }
      setSearchParams(params, { replace: !opts?.push });
    },
    [key, defaultValue, setSearchParams]
  );

  return [value, setValue];
}

/**
 * Boolean-valued URL param. Stored as "1" when true, omitted when false.
 *   const [flat, setFlat] = useUrlBool('flat');
 */
export function useUrlBool(key) {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key) === '1';

  const setValue = useCallback(
    (next, opts) => {
      const params = new URLSearchParams(window.location.search);
      const v = typeof next === 'function' ? next(params.get(key) === '1') : next;
      if (v) {
        params.set(key, '1');
      } else {
        params.delete(key);
      }
      setSearchParams(params, { replace: !opts?.push });
    },
    [key, setSearchParams]
  );

  return [value, setValue];
}

/**
 * Set<string>-valued URL param. Stored comma-separated.
 *   const [bots, setBots] = useUrlSet('bots');
 *   setBots(new Set(['A', 'B']));   // ?bots=A,B
 *
 * Accepts a Set or a function (prev:Set) => Set when setting. Returns a
 * stable Set instance per URL value so React's Set-equality optimizations
 * still work.
 */
export function useUrlSet(key) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key) || '';
  const value = useMemo(
    () => new Set(raw ? raw.split(',').filter(Boolean) : []),
    [raw]
  );

  const setValue = useCallback(
    (next, opts) => {
      const params = new URLSearchParams(window.location.search);
      const prev = new Set(
        (params.get(key) || '').split(',').filter(Boolean)
      );
      const updated = typeof next === 'function' ? next(prev) : next;
      const arr = Array.from(updated).filter(Boolean);
      if (arr.length === 0) {
        params.delete(key);
      } else {
        params.set(key, arr.join(','));
      }
      setSearchParams(params, { replace: !opts?.push });
    },
    [key, setSearchParams]
  );

  return [value, setValue];
}

/**
 * Integer-valued URL param (e.g. page number).
 *   const [page, setPage] = useUrlInt('page', 0);
 */
export function useUrlInt(key, defaultValue = 0) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key);
  const parsed = raw == null ? defaultValue : parseInt(raw, 10);
  const value = Number.isFinite(parsed) ? parsed : defaultValue;

  const setValue = useCallback(
    (next, opts) => {
      const params = new URLSearchParams(window.location.search);
      const prevRaw = params.get(key);
      const prev = prevRaw == null ? defaultValue : (parseInt(prevRaw, 10) || defaultValue);
      const v = typeof next === 'function' ? next(prev) : next;
      if (v === defaultValue || v == null || !Number.isFinite(Number(v))) {
        params.delete(key);
      } else {
        params.set(key, String(v));
      }
      setSearchParams(params, { replace: !opts?.push });
    },
    [key, defaultValue, setSearchParams]
  );

  return [value, setValue];
}

/**
 * JSON-valued URL param. Used for the rare case where an object/array must
 * survive a refresh (e.g. a drill-down's full context). Use sparingly —
 * prefer flat string params when possible.
 *   const [pending, setPending] = useUrlJson('pending');
 */
export function useUrlJson(key) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key);
  const value = useMemo(() => {
    if (!raw) return null;
    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }, [raw]);

  const setValue = useCallback(
    (next, opts) => {
      const params = new URLSearchParams(window.location.search);
      if (next == null) {
        params.delete(key);
      } else {
        params.set(key, encodeURIComponent(JSON.stringify(next)));
      }
      setSearchParams(params, { replace: !opts?.push });
    },
    [key, setSearchParams]
  );

  return [value, setValue];
}
