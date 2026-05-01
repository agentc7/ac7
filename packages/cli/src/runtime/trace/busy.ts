/**
 * "Agent is working" signal for the runner.
 *
 * Tracks an integer count of in-flight upstream HTTP requests captured
 * by the MITM proxy. The runner reports `busy = count > 0` to the
 * broker, which surfaces it on `/roster` so the web UI can render a
 * spinner next to the agent's name.
 *
 * Why a count rather than a bool: many concurrent calls are normal
 * (parallel tool fan-out), and using a count means we don't accidentally
 * flip "not busy" mid-burst when one of N calls finishes. Subscribers
 * still see only the boolean transitions, so the UI never thrashes.
 *
 * Listeners are notified on every transition between 0 and >0 (and
 * vice versa). Subsequent increments while already busy don't fire —
 * the public observable is the boolean, not the count.
 */

export interface BusySignal {
  /** Current count of in-flight requests. */
  readonly count: number;
  /** Whether at least one request is in flight (`count > 0`). */
  readonly busy: boolean;
  /** Mark a new request as started. Returns a handle that decrements on `finish()`. */
  start(): { finish: () => void };
  /**
   * Subscribe to busy-state changes. Listener fires immediately with
   * the current state, then on every transition. Returns an unsubscribe
   * function.
   */
  subscribe(listener: (busy: boolean) => void): () => void;
}

export function createBusySignal(): BusySignal {
  let count = 0;
  const listeners = new Set<(busy: boolean) => void>();

  const emit = (busy: boolean): void => {
    for (const listener of listeners) {
      try {
        listener(busy);
      } catch {
        /* listener threw — not our problem */
      }
    }
  };

  const start = (): { finish: () => void } => {
    const wasBusy = count > 0;
    count += 1;
    if (!wasBusy) emit(true);
    let finished = false;
    return {
      finish: () => {
        // Idempotent — a callback wired to two completion paths
        // (e.g., onExchange + closeSession) shouldn't double-decrement.
        if (finished) return;
        finished = true;
        count = Math.max(0, count - 1);
        if (count === 0) emit(false);
      },
    };
  };

  return {
    get count() {
      return count;
    },
    get busy() {
      return count > 0;
    },
    start,
    subscribe(listener) {
      listeners.add(listener);
      // Late subscribers see the current state.
      try {
        listener(count > 0);
      } catch {
        /* ignore */
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
