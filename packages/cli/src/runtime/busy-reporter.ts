/**
 * Pushes "agent is working" state from the trace host's busy signal
 * up to the broker via `POST /presence/busy`.
 *
 * Behavior:
 *   - On every transition (idle→busy, busy→idle), POST immediately.
 *   - While busy, re-POST `{busy: true}` every `heartbeatMs` (default
 *     10s) so the server-side TTL (30s) stays fresh. If the runner
 *     dies mid-call the TTL lapses on its own.
 *   - When idle, no traffic — no need to remind the server "still
 *     idle." The server treats absence as not-busy.
 *
 * POST failures are logged at debug and swallowed: the spinner is a
 * UI nicety, not an invariant. The next transition or heartbeat will
 * try again, and if the runner is offline entirely the broker won't
 * see anything until it reconnects.
 */

import type { Client as BrokerClient } from '@agentc7/sdk/client';
import type { BusySignal } from './trace/busy.js';

export interface BusyReporterOptions {
  brokerClient: BrokerClient;
  busy: BusySignal;
  /** Cancellation. When aborted, the reporter stops heartbeating. */
  signal: AbortSignal;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Override the heartbeat interval. Default 10_000ms. */
  heartbeatMs?: number;
}

export const DEFAULT_HEARTBEAT_MS = 10_000;

export function startBusyReporter(opts: BusyReporterOptions): void {
  const { brokerClient, busy, signal, log } = opts;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Raw poster — ignores aborted state so we can fire one final
  // `busy: false` from the abort handler. Internal-only; the
  // subscriber/heartbeat call the abort-aware wrapper below.
  const postRaw = (next: boolean): void => {
    void brokerClient.setBusy({ busy: next }).catch((err: unknown) => {
      log('busy-reporter: setBusy failed', {
        busy: next,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const post = (next: boolean): void => {
    if (signal.aborted) return;
    postRaw(next);
  };

  const startHeartbeat = (): void => {
    if (heartbeatTimer !== null) return;
    heartbeatTimer = setInterval(() => {
      if (busy.busy) post(true);
    }, heartbeatMs);
    // Don't keep the runner process alive just for this heartbeat —
    // when claude exits and the runner shuts down, the timer should
    // not block process termination.
    if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
      (heartbeatTimer as { unref: () => void }).unref();
    }
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const unsubscribe = busy.subscribe((isBusy) => {
    post(isBusy);
    if (isBusy) {
      startHeartbeat();
    } else {
      stopHeartbeat();
    }
  });

  signal.addEventListener(
    'abort',
    () => {
      stopHeartbeat();
      unsubscribe();
      // Best-effort final clear so the spinner drops as soon as the
      // runner exits. Server's TTL would clear it eventually anyway.
      // Uses `postRaw` directly since `post` no-ops on aborted signal.
      if (busy.busy) postRaw(false);
    },
    { once: true },
  );
}
