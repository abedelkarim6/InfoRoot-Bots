/**
 * Shared SSE-streaming hook for the Agent Chat page.
 *
 * Reads `data: {...}\n\n` events from a POST → text/event-stream endpoint
 * (`/api/chatbot/stream`). Handles:
 *   - Bearer auth header (parity with the api() helper).
 *   - Step / delta / done / error event types — emitted to the caller via `onEvent`.
 *   - AbortController for user-cancellation.
 *   - Aborts any in-flight stream on unmount so leaving the page doesn't leak
 *     the connection.
 *
 * Returns:
 *   { send, cancel, streaming }
 *
 * `send(payload)` resolves to one of:
 *   { ok: true }                        — stream completed normally
 *   { ok: false, aborted: true }        — user (or unmount) cancelled
 *   { ok: false, error: <message> }    — network / parse failure
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from '../../lib/api';

export default function useChatStream({ url, onEvent }) {
  const abortRef = useRef(null);
  const onEventRef = useRef(onEvent);
  const [streaming, setStreaming] = useState(false);

  // Always invoke the latest onEvent without re-creating `send`.
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // Abort any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const send = useCallback(async (payload) => {
    cancel(); // ensure no overlap
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true);

    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      if (!response.ok || !response.body) {
        return { ok: false, error: `HTTP ${response.status}` };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let evt;
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          onEventRef.current?.(evt);
        }
      }

      return { ok: true };
    } catch (e) {
      if (e?.name === 'AbortError') {
        return { ok: false, aborted: true };
      }
      return { ok: false, error: e?.message || 'Connection error' };
    } finally {
      setStreaming(false);
      // Only clear if this controller is still the active one.
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, [url, cancel]);

  return { send, cancel, streaming };
}
