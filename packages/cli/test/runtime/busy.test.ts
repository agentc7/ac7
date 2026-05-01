/**
 * `BusySignal` tests.
 *
 * Pins the boolean-transition contract: subscribers see one notification
 * per 0↔>0 crossing, regardless of how many concurrent in-flight handles
 * are active. Reentrant notifications would cause the runner's POST
 * /presence/busy traffic to thrash on parallel tool fan-outs.
 */

import { describe, expect, it, vi } from 'vitest';
import { createBusySignal } from '../../src/runtime/trace/busy.js';

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
});
