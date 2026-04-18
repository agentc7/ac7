/**
 * SSE subscription — live /subscribe stream feeding the messages signal.
 *
 * Uses the browser's native `EventSource`:
 *   - auto-reconnects with a built-in retry delay
 *   - auto-sends `Last-Event-ID` on reconnect (cosmetic — server doesn't
 *     use it today)
 *   - cookies are sent automatically for same-origin requests, which
 *     is how the SPA authenticates (no Authorization header needed)
 *
 * On every reconnect we re-pull `/history?limit=50` to backfill any
 * messages delivered during the gap. Merge happens through
 * `appendMessages`, which de-dupes by message id so the overlap with
 * what we already have is harmless.
 *
 * We track a `connected` signal so the header can show ONLINE / OFFLINE
 * state based on whether the stream is currently live.
 */

import { MessageSchema } from '@ac7/sdk/schemas';
import { signal } from '@preact/signals';
import { getClient } from './client.js';
import { appendMessages } from './messages.js';
import { loadObjectives } from './objectives.js';

export const streamConnected = signal(false);

/**
 * Surfaced in the shell header when the last backfill on connect (or
 * reconnect) failed. The stream itself may still be alive — we just
 * couldn't fill in the gap. User sees "reconnected but missed some
 * messages" and can refresh. Cleared on the next successful backfill.
 */
export const streamBackfillError = signal<string | null>(null);

export interface StartSubscribeOptions {
  /** Name to subscribe as (= the current slot's name). */
  name: string;
  /** Max history entries to backfill on first open + every reconnect. */
  historyLimit?: number;
  /** Optional callback for errors you want to surface in the UI. */
  onError?: (err: unknown) => void;
}

/**
 * Open the SSE stream. Returns a teardown function that closes the
 * EventSource and marks the connection as disconnected. Idempotent
 * — calling teardown twice is safe.
 */
export function startSubscribe(options: StartSubscribeOptions): () => void {
  const { name, historyLimit = 50, onError } = options;
  const url = `/subscribe?agentId=${encodeURIComponent(name)}`;

  let source: EventSource | null = null;
  let cancelled = false;

  const backfill = async () => {
    try {
      const history = await getClient().history({ limit: historyLimit });
      appendMessages(name, history);
      streamBackfillError.value = null;
    } catch (err) {
      streamBackfillError.value =
        err instanceof Error && err.message ? err.message : 'history backfill failed';
      onError?.(err);
    }
  };

  const open = () => {
    if (cancelled) return;
    source = new EventSource(url, { withCredentials: true });

    source.addEventListener('open', () => {
      streamConnected.value = true;
      // Every successful connect (initial or reconnect) triggers a
      // backfill. On initial open this seeds the transcript; on
      // reconnect it fills in whatever we missed during the gap.
      void backfill();
    });

    source.addEventListener('message', (event) => {
      if (!event.data) return;
      try {
        const msg = MessageSchema.parse(JSON.parse(event.data));
        appendMessages(name, [msg]);
        // If this frame carried an objective event, refresh the
        // objectives signal so the sidebar count + panel stay in sync
        // with the server's authoritative state.
        const data = msg.data as Record<string, unknown> | undefined;
        if (data && data.kind === 'objective') {
          void loadObjectives().catch(() => {
            /* swallow — next event will retry */
          });
        }
      } catch (err) {
        onError?.(err);
      }
    });

    source.addEventListener('error', () => {
      streamConnected.value = false;
      // EventSource will auto-reconnect on its own. We don't close
      // and reopen manually — that would race with its internal
      // retry loop.
    });
  };

  open();

  return () => {
    cancelled = true;
    streamConnected.value = false;
    if (source !== null) {
      source.close();
      source = null;
    }
  };
}

export function __resetSseForTests(): void {
  streamConnected.value = false;
  streamBackfillError.value = null;
}
