/**
 * `BusySignal` tests.
 *
 * Pins the boolean-transition contract: subscribers see one notification
 * per 0↔>0 crossing, regardless of how many concurrent in-flight handles
 * are active. Reentrant notifications would cause the runner's POST
 * /presence/busy traffic to thrash on parallel tool fan-outs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusySignal, DEFAULT_MAX_AGE_MS } from '../../src/runtime/trace/busy.js';

describe('createBusySignal', () => {
  it('starts idle (count=0, busy=false)', () => {
    const b = createBusySignal();
    expect(b.count).toBe(0);
    expect(b.busy).toBe(false);
  });

  it('flips to busy on the first start, back to idle on the matching finish', () => {
    const b = createBusySignal();
    const observed: boolean[] = [];
    b.subscribe((busy) => observed.push(busy));
    const h = b.start();
    expect(b.busy).toBe(true);
    h.finish();
    expect(b.busy).toBe(false);
    // Initial fire on subscribe (false) + transition to true + back to false.
    expect(observed).toEqual([false, true, false]);
  });

  it('does not re-fire on increments while already busy (regression)', () => {
    const b = createBusySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();

    const h1 = b.start();
    const h2 = b.start();
    const h3 = b.start();
    expect(listener).toHaveBeenCalledTimes(1); // only the 0→1 transition
    expect(listener).toHaveBeenLastCalledWith(true);

    h2.finish();
    h3.finish();
    expect(listener).toHaveBeenCalledTimes(1); // count still > 0; no fire
    h1.finish();
    expect(listener).toHaveBeenCalledTimes(2); // 1→0 transition
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it('finish() is idempotent — double-finishing one handle does not corrupt count', () => {
    const b = createBusySignal();
    const h = b.start();
    expect(b.count).toBe(1);
    h.finish();
    h.finish();
    h.finish();
    expect(b.count).toBe(0);
    expect(b.busy).toBe(false);
  });

  it('fires the current state on subscribe even mid-burst', () => {
    const b = createBusySignal();
    b.start();
    const observed: boolean[] = [];
    b.subscribe((busy) => observed.push(busy));
    expect(observed).toEqual([true]);
  });

  it('isolates one listener throwing from the others', () => {
    const b = createBusySignal();
    const good = vi.fn();
    b.subscribe(() => {
      throw new Error('boom');
    });
    b.subscribe(good);
    good.mockClear();
    b.start();
    expect(good).toHaveBeenCalledWith(true);
  });

  it('supports unsubscribe', () => {
    const b = createBusySignal();
    const listener = vi.fn();
    const unsubscribe = b.subscribe(listener);
    listener.mockClear();
    unsubscribe();
    b.start();
    expect(listener).not.toHaveBeenCalled();
  });

  it('tracks per-source counts independently', () => {
    const b = createBusySignal();
    const llm = b.start('llm_inflight');
    const tool1 = b.start('tool_inflight');
    const tool2 = b.start('tool_inflight');
    expect(b.getSourceCounts()).toEqual({ llm_inflight: 1, tool_inflight: 2 });
    expect(b.count).toBe(3);
    expect(b.busy).toBe(true);

    llm.finish();
    expect(b.getSourceCounts()).toEqual({ llm_inflight: 0, tool_inflight: 2 });
    // Still busy — tool_inflight is non-zero.
    expect(b.busy).toBe(true);

    tool1.finish();
    tool2.finish();
    expect(b.getSourceCounts()).toEqual({ llm_inflight: 0, tool_inflight: 0 });
    expect(b.busy).toBe(false);
  });

  it('emits only one 0→busy transition across mixed sources', () => {
    const b = createBusySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();

    const llm = b.start('llm_inflight');
    const tool = b.start('tool_inflight');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);

    llm.finish();
    // tool_inflight still in flight — no transition.
    expect(listener).toHaveBeenCalledTimes(1);

    tool.finish();
    // Now all sources drained — transition fires.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it("defaults to 'llm_inflight' when start() is called without a source", () => {
    // Backwards compatibility — existing MITM call sites that don't
    // pass a source must keep behaving as they did.
    const b = createBusySignal();
    const h = b.start();
    expect(b.getSourceCounts()).toEqual({ llm_inflight: 1, tool_inflight: 0 });
    h.finish();
    expect(b.getSourceCounts()).toEqual({ llm_inflight: 0, tool_inflight: 0 });
  });

  it('a wedged source does not poison drain of the other', () => {
    // Regression: if one feeder forgets to decrement, the other
    // should still be able to report idle on its own track. The
    // overall `busy` stays true (correct — there IS in-flight work
    // by the contract) but `getSourceCounts()` makes the culprit
    // diagnosable instead of leaving us guessing.
    const b = createBusySignal();
    b.start('llm_inflight', { maxAgeMs: Infinity }); // intentionally not finished, safety disabled
    const tool = b.start('tool_inflight');
    tool.finish();
    expect(b.busy).toBe(true);
    expect(b.getSourceCounts()).toEqual({ llm_inflight: 1, tool_inflight: 0 });
  });
});

describe('createBusySignal — handle max-age safety net', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-finishes a handle that exceeds its max-age and emits the idle transition', () => {
    const log = vi.fn();
    const b = createBusySignal({ log });
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();
    log.mockClear();

    b.start('llm_inflight', { maxAgeMs: 1000 });
    expect(b.busy).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(999);
    expect(b.busy).toBe(true); // not yet

    vi.advanceTimersByTime(2);
    expect(b.busy).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);
    // Log carries the diagnostic context.
    expect(log).toHaveBeenCalledWith(
      'busy: handle auto-finished',
      expect.objectContaining({ source: 'llm_inflight', reason: 'timeout' }),
    );
  });

  it('respects a custom maxAgeMs even when the default is much larger', () => {
    const b = createBusySignal();
    b.start('tool_inflight', { maxAgeMs: 50 });
    expect(b.busy).toBe(true);
    vi.advanceTimersByTime(60);
    expect(b.busy).toBe(false);
  });

  it('Infinity maxAgeMs disables the safety net entirely', () => {
    const b = createBusySignal();
    b.start('llm_inflight', { maxAgeMs: Number.POSITIVE_INFINITY });
    expect(b.busy).toBe(true);
    // Crank well past any default — handle should still be live.
    vi.advanceTimersByTime(DEFAULT_MAX_AGE_MS.llm_inflight * 10);
    expect(b.busy).toBe(true);
  });

  it('finish() before the deadline cancels the timer (no double-finish)', () => {
    const log = vi.fn();
    const b = createBusySignal({ log });
    const h = b.start('llm_inflight', { maxAgeMs: 1000 });
    expect(b.getSourceCounts().llm_inflight).toBe(1);

    h.finish();
    expect(b.getSourceCounts().llm_inflight).toBe(0);

    // Advance well past the original deadline — the timer should
    // have been cleared, so no auto-finish fires (which would
    // otherwise underflow the count or fire a spurious idle
    // transition).
    vi.advanceTimersByTime(5000);
    expect(b.getSourceCounts().llm_inflight).toBe(0);
    expect(log).not.toHaveBeenCalledWith('busy: handle auto-finished', expect.anything());
  });

  it('applies the per-source default when maxAgeMs is omitted', () => {
    const b = createBusySignal();
    b.start('tool_inflight');
    // 14:59 — not yet.
    vi.advanceTimersByTime(DEFAULT_MAX_AGE_MS.tool_inflight - 1000);
    expect(b.busy).toBe(true);
    // Past 15min.
    vi.advanceTimersByTime(2000);
    expect(b.busy).toBe(false);
  });

  it('falls back to the default when maxAgeMs is non-positive or NaN', () => {
    const b = createBusySignal();
    b.start('llm_inflight', { maxAgeMs: 0 });
    b.start('llm_inflight', { maxAgeMs: -100 });
    b.start('llm_inflight', { maxAgeMs: Number.NaN });
    expect(b.getSourceCounts().llm_inflight).toBe(3);

    // None of those should auto-finish before the source default.
    vi.advanceTimersByTime(DEFAULT_MAX_AGE_MS.llm_inflight - 1);
    expect(b.getSourceCounts().llm_inflight).toBe(3);
    // Past the default.
    vi.advanceTimersByTime(2);
    expect(b.getSourceCounts().llm_inflight).toBe(0);
  });
});

describe('createBusySignal — forceFinishAll', () => {
  it('returns 0 and emits nothing when no work is in flight', () => {
    const b = createBusySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();
    const drained = b.forceFinishAll();
    expect(drained).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('drains every live handle across both sources with a single idle transition', () => {
    const b = createBusySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();

    b.start('llm_inflight');
    b.start('llm_inflight');
    b.start('tool_inflight');
    expect(b.getSourceCounts()).toEqual({ llm_inflight: 2, tool_inflight: 1 });
    expect(listener).toHaveBeenCalledTimes(1); // 0→busy

    const drained = b.forceFinishAll();
    expect(drained).toBe(3);
    expect(b.getSourceCounts()).toEqual({ llm_inflight: 0, tool_inflight: 0 });
    expect(b.busy).toBe(false);
    // One additional listener fire — the busy→idle transition. No
    // intermediate per-handle transitions because the counters stayed
    // > 0 until the last one drained.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it('subsequent finish() on a force-finished handle is a no-op', () => {
    const b = createBusySignal();
    const h = b.start('llm_inflight');
    expect(b.getSourceCounts().llm_inflight).toBe(1);

    b.forceFinishAll();
    expect(b.getSourceCounts().llm_inflight).toBe(0);

    // The caller's handle.finish() shouldn't underflow.
    h.finish();
    expect(b.getSourceCounts().llm_inflight).toBe(0);
    expect(b.busy).toBe(false);
  });

  it('logs the drain count for diagnostics', () => {
    const log = vi.fn();
    const b = createBusySignal({ log });
    b.start('llm_inflight');
    b.start('tool_inflight');
    b.forceFinishAll();
    expect(log).toHaveBeenCalledWith(
      'busy: force-finished outstanding handles',
      expect.objectContaining({ drained: 2 }),
    );
  });
});
