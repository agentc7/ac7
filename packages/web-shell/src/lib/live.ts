/**
 * Live subscription — WebSocket stream feeding the messages signal.
 *
 * Uses the browser's native `WebSocket`. Cookies flow automatically
 * on same-origin upgrades, so the SPA authenticates via its session
 * cookie (no explicit Authorization header required — the browser
 * WebSocket API doesn't support setting arbitrary headers anyway).
 *
 * Reconnect: WebSocket does NOT auto-reconnect the way EventSource
 * did, so we roll our own — exponential backoff capped at 30s, reset
 * on each successful open. On every (re)connect we pull
 * `/history?limit=50` to backfill messages delivered during any gap.
 * `appendMessages` de-dupes by id so the overlap with already-present
 * messages is harmless.
 *
 * `streamConnected` tracks live state; the header uses it for
 * ONLINE / OFFLINE. `streamEverConnected` is true once we've opened
 * at least one successful connection this session — consumers
 * (DisconnectedBanner) use it to suppress the disconnected banner
 * during the initial-load window before the first open event fires.
 */

import { MessageSchema } from '@agentc7/sdk/schemas';
import { signal } from '@preact/signals';
import { getClient } from './client.js';
import { appendMessages } from './messages.js';
import { loadObjectives } from './objectives.js';

export const streamConnected = signal(false);
export const streamEverConnected = signal(false);
export const streamBackfillError = signal<string | null>(null);

export interface StartSubscribeOptions {
  /** Name to subscribe as (= the current member's name). */
  name: string;
  /** Max history entries to backfill on first open + every reconnect. */
  historyLimit?: number;
  /** Optional callback for errors you want to surface in the UI. */
  onError?: (err: unknown) => void;
}

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Open the live WebSocket. Returns a teardown function that closes
 * the socket and cancels any pending reconnect. Idempotent — calling
 * teardown twice is safe.
 */
export function startSubscribe(options: StartSubscribeOptions): () => void {
  const { name, historyLimit = 50, onError } = options;
  const url = buildWsUrl(`/subscribe?name=${encodeURIComponent(name)}`);

  let ws: WebSocket | null = null;
  let cancelled = false;
  let retryMs = INITIAL_RETRY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const backfill = async (): Promise<void> => {
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

  const scheduleReconnect = (): void => {
    if (cancelled) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };

  const open = (): void => {
    if (cancelled) return;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      onError?.(err);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      streamConnected.value = true;
      streamEverConnected.value = true;
      retryMs = INITIAL_RETRY_MS;
      // Every successful connect (initial or reconnect) backfills
      // so we close any gap the previous connection dropped.
      void backfill();
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (!raw) return;
      try {
        const msg = MessageSchema.parse(JSON.parse(raw));
        appendMessages(name, [msg]);
        // If this frame carried an objective event, refresh the
        // objectives signal so the sidebar count + panel stay in
        // sync with the server's authoritative state.
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

    ws.addEventListener('error', () => {
      streamConnected.value = false;
      // Close will fire next; reconnect is scheduled from there.
    });

    ws.addEventListener('close', () => {
      streamConnected.value = false;
      ws = null;
      scheduleReconnect();
    });
  };

  open();

  return () => {
    cancelled = true;
    streamConnected.value = false;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      ws = null;
    }
  };
}

/**
 * Compose an absolute WebSocket URL from a relative path, using the
 * page's origin. Upgrades scheme from http/https to ws/wss.
 */
function buildWsUrl(path: string): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${path}`;
}

export function __resetLiveForTests(): void {
  streamConnected.value = false;
  streamEverConnected.value = false;
  streamBackfillError.value = null;
}
