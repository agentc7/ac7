/**
 * Server-side "agent is working" presence tracker.
 *
 * The runner posts `{busy: bool}` to `POST /presence/busy` whenever
 * its trace host's in-flight HTTP-request count crosses 0/1, plus a
 * heartbeat while still working. We hold the latest report per
 * member with an absolute expiry timestamp; calls to `isBusy(name)`
 * past the expiry return `false` even if the runner never told us
 * to flip — that's the safety net for runner crashes mid-call.
 *
 * In-memory only. Multi-process deployments aren't supported (the
 * broker is single-process today), and persisting busy state across
 * restarts has no value: a busy member that survives a restart is
 * almost certainly stale.
 *
 * The clock is injectable so tests can advance time without sleeping.
 */

/** How long a `busy: true` report stays "valid" without a refresh. */
export const BUSY_TTL_MS = 30_000;

export interface BusyReport {
  busy: boolean;
  /** Wall-clock at which this report was filed. */
  reportedAt: number;
  /** Wall-clock past which `busy=true` reports auto-expire to `false`. */
  expiresAt: number;
}

export interface BusyTracker {
  /**
   * Record a runner's report. `busy: true` extends the expiry window;
   * `busy: false` clears the entry immediately.
   */
  report(name: string, busy: boolean): void;
  /**
   * Resolve the current busy state for a member. Returns `false` for
   * unknown members and for stale `busy: true` entries past their TTL.
   */
  isBusy(name: string): boolean;
  /**
   * Forget any state for `name`. Called when a member is deleted so
   * a stale entry can't surface a deleted name on the roster.
   */
  forget(name: string): void;
  /** Drop every entry whose TTL has lapsed. Idempotent. */
  purgeStale(): void;
}

export function createBusyTracker(now: () => number = Date.now): BusyTracker {
  const reports = new Map<string, BusyReport>();

  return {
    report(name, busy) {
      if (!busy) {
        reports.delete(name);
        return;
      }
      const ts = now();
      reports.set(name, {
        busy: true,
        reportedAt: ts,
        expiresAt: ts + BUSY_TTL_MS,
      });
    },
    isBusy(name) {
      const entry = reports.get(name);
      if (!entry) return false;
      if (entry.expiresAt <= now()) {
        reports.delete(name);
        return false;
      }
      return entry.busy;
    },
    forget(name) {
      reports.delete(name);
    },
    purgeStale() {
      const ts = now();
      for (const [name, entry] of reports) {
        if (entry.expiresAt <= ts) reports.delete(name);
      }
    },
  };
}
