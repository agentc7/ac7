/**
 * "Agent is working" signal for the runner.
 *
 * Tracks in-flight work the agent is doing across multiple independent
 * sources. The runner reports `busy = anyCount > 0` to the broker,
 * which surfaces it on `/roster` so the web UI can render a spinner
 * next to the agent's name.
 *
 * The signal is multi-sourced because no single observation point sees
 * everything an agent does:
 *
 *   - `llm_inflight` — bumped by the MITM trace pipeline whenever a
 *     request to an allowlisted LLM-provider host is in flight. Lights
 *     up while the model is generating between tool calls. This is the
 *     historical bumper and the one that still fires today.
 *   - `tool_inflight` — bumped by per-runner integrations watching
 *     tool lifecycle events (claude-code hooks, codex app-server
 *     `item/started`/`item/completed` notifications). Lights up during
 *     bash, file-edit, MCP-tool, and other tool execution windows that
 *     the LLM bump alone wouldn't cover.
 *
 * Why per-source counters: any single feeder can stall (a misbehaving
 * hook that never decrements, a JSON-RPC stream that drops a
 * notification). With separate counters, a stuck source can't poison
 * the others — and `getSourceCounts()` lets diagnostics tell us which
 * one is wedged. The public observable stays a single boolean so the
 * UI never has to merge state.
 *
 * Why a count rather than a bool per source: many concurrent in-flight
 * units are normal (parallel tool fan-out, streaming LLM requests).
 * Using a count means we don't accidentally flip "not busy" mid-burst
 * when one of N completes. Subscribers still see only the boolean
 * transitions, so the UI never thrashes.
 *
 * Listeners are notified on every transition between "any source has
 * work" and "no source has work". Subsequent increments while already
 * busy don't fire.
 *
 * Defense in depth — handles that never see their `finish()` call:
 *
 *   - Each handle has an auto-finish timer (see `DEFAULT_MAX_AGE_MS`).
 *     If `finish()` hasn't run by then we force it. A keep-alive socket
 *     surviving a TUI interrupt, a dropped tool-lifecycle notification,
 *     or a parser failing to complete an exchange would all otherwise
 *     wedge the indicator. We'd rather flicker idle after a long
 *     legitimate operation than show busy forever.
 *   - `forceFinishAll()` drains every live handle and is called from
 *     `TraceHost.close()` after sub-systems shut down — a teardown-time
 *     safety net for any handle a sub-system's own cleanup missed.
 */

export type BusySource = 'llm_inflight' | 'tool_inflight';

const ALL_SOURCES: readonly BusySource[] = ['llm_inflight', 'tool_inflight'];

/**
 * Per-source upper bound on how long a single handle is allowed to
 * stay open before the safety net force-finishes it.
 *
 *   - `llm_inflight` — 5 minutes. Extended-thinking turns and long
 *     batch generations can take ~1-2 minutes legitimately; 5 minutes
 *     leaves plenty of headroom while still bounding the stuck case.
 *   - `tool_inflight` — 15 minutes. Tool calls can include long bash
 *     commands (npm install, docker build, large checkouts). Beyond
 *     15 minutes we'd rather risk flickering than show stuck-busy
 *     forever.
 *
 * Callers with legitimate need for a different cap (or no cap) can
 * pass `maxAgeMs` explicitly to `start()`. Use `Infinity` to disable
 * the timer entirely; non-positive / non-finite values fall back to
 * the source default.
 */
export const DEFAULT_MAX_AGE_MS: Readonly<Record<BusySource, number>> = {
  llm_inflight: 5 * 60_000,
  tool_inflight: 15 * 60_000,
};

export interface BusySignalOptions {
  /**
   * Optional logger for non-routine events: handle auto-finished by
   * the max-age timer, handles drained via `forceFinishAll()`, etc.
   * The signal is normally silent on the happy path.
   */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface BusyStartOptions {
  /**
   * Hard cap on the handle's lifetime in milliseconds. If `finish()`
   * isn't called by then we force-finish, log a warning, and drop the
   * count. Defaults to `DEFAULT_MAX_AGE_MS[source]`. Pass `Infinity`
   * to disable the safety net for this handle.
   */
  maxAgeMs?: number;
}

export interface BusyHandle {
  finish(): void;
}

export interface BusySignal {
  /** Sum of in-flight counts across all sources. */
  readonly count: number;
  /** Whether at least one source has work in flight. */
  readonly busy: boolean;
  /**
   * Mark a new unit of work as started. Returns a handle that
   * decrements on `finish()`. Defaults to `llm_inflight` so existing
   * MITM bumper code that doesn't pass a source remains correct.
   *
   * Each handle auto-finishes after `maxAgeMs` if `finish()` hasn't
   * been called — see the file-level comment on defense in depth.
   */
  start(source?: BusySource, options?: BusyStartOptions): BusyHandle;
  /**
   * Subscribe to busy-state changes. Listener fires immediately with
   * the current state, then on every transition. Returns an unsubscribe
   * function.
   */
  subscribe(listener: (busy: boolean) => void): () => void;
  /**
   * Diagnostics: read the live per-source counts. Useful when a
   * subscriber suspects one source is stuck — see which counter
   * refuses to drain.
   */
  getSourceCounts(): Readonly<Record<BusySource, number>>;
  /**
   * Force every outstanding handle to finish. Returns the number of
   * handles that were drained (zero when no work was in flight). Emits
   * a single busy→idle transition if at least one handle was open.
   *
   * The trace host calls this from its `close()` path after the proxy
   * and hook server have shut down, as a final safety net for handles
   * a sub-system's own cleanup missed. Tests can also use it to
   * scrub state between cases.
   */
  forceFinishAll(): number;
}

interface InternalHandle {
  source: BusySource;
  finish: (reason: 'normal' | 'timeout' | 'force') => void;
}

export function createBusySignal(options: BusySignalOptions = {}): BusySignal {
  const log = options.log ?? (() => {});
  const counts = new Map<BusySource, number>();
  for (const source of ALL_SOURCES) counts.set(source, 0);
  const listeners = new Set<(busy: boolean) => void>();
  const liveHandles = new Set<InternalHandle>();

  const totalCount = (): number => {
    let total = 0;
    for (const v of counts.values()) total += v;
    return total;
  };

  const emit = (busy: boolean): void => {
    for (const listener of listeners) {
      try {
        listener(busy);
      } catch {
        /* listener threw — not our problem */
      }
    }
  };

  const resolveMaxAge = (source: BusySource, requested: number | undefined): number => {
    if (requested === undefined) return DEFAULT_MAX_AGE_MS[source];
    if (typeof requested !== 'number') return DEFAULT_MAX_AGE_MS[source];
    if (Number.isNaN(requested)) return DEFAULT_MAX_AGE_MS[source];
    // Positive Infinity is the documented opt-out signal — let it
    // through so the timer setup below sees a non-finite value and
    // skips scheduling.
    if (requested === Number.POSITIVE_INFINITY) return requested;
    if (requested <= 0) return DEFAULT_MAX_AGE_MS[source];
    return requested;
  };

  const start = (
    source: BusySource = 'llm_inflight',
    startOpts: BusyStartOptions = {},
  ): BusyHandle => {
    const wasBusy = totalCount() > 0;
    counts.set(source, (counts.get(source) ?? 0) + 1);
    if (!wasBusy) emit(true);

    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const finish = (reason: 'normal' | 'timeout' | 'force'): void => {
      // Idempotent — a callback wired to two completion paths
      // (e.g., onExchange + closeSession) shouldn't double-decrement.
      if (finished) return;
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      liveHandles.delete(handleEntry);
      const next = Math.max(0, (counts.get(source) ?? 0) - 1);
      counts.set(source, next);
      if (totalCount() === 0) emit(false);
      if (reason !== 'normal') {
        log('busy: handle auto-finished', {
          source,
          reason,
          ageMs: Date.now() - startedAt,
        });
      }
    };

    const handleEntry: InternalHandle = {
      source,
      finish,
    };
    liveHandles.add(handleEntry);

    const maxAgeMs = resolveMaxAge(source, startOpts.maxAgeMs);
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
      timer = setTimeout(() => finish('timeout'), maxAgeMs);
      // Don't keep the runner process alive just to fire this watchdog —
      // if the runner is exiting and this is the only live timer, we
      // want the loop to drain so close() can proceed.
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
    }

    return {
      finish: () => finish('normal'),
    };
  };

  const forceFinishAll = (): number => {
    if (liveHandles.size === 0) return 0;
    const drained = liveHandles.size;
    // Snapshot before iterating since each finish() mutates the set.
    for (const entry of [...liveHandles]) {
      entry.finish('force');
    }
    log('busy: force-finished outstanding handles', { drained });
    return drained;
  };

  return {
    get count() {
      return totalCount();
    },
    get busy() {
      return totalCount() > 0;
    },
    start,
    subscribe(listener) {
      listeners.add(listener);
      // Late subscribers see the current state.
      try {
        listener(totalCount() > 0);
      } catch {
        /* ignore */
      }
      return () => {
        listeners.delete(listener);
      };
    },
    getSourceCounts() {
      const out = { llm_inflight: 0, tool_inflight: 0 } as Record<BusySource, number>;
      for (const [k, v] of counts) out[k] = v;
      return out;
    },
    forceFinishAll,
  };
}
