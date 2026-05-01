/**
 * BusyTracker tests.
 *
 * Pins the in-memory presence-state semantics:
 *   - `report(name, true)` extends the TTL window
 *   - `report(name, false)` clears the entry immediately
 *   - `isBusy` returns false past the TTL even if `report(true)` was the
 *     last write (the safety net for crashed runners)
 *   - `forget` drops the entry
 *   - `purgeStale` is a no-op for fresh entries
 *
 * The clock is injectable so tests don't have to wait wall-clock time.
 */

import { describe, expect, it } from 'vitest';
import { BUSY_TTL_MS, createBusyTracker } from '../src/busy-tracker.js';

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('createBusyTracker', () => {
  it('starts with no entries — every name reads false', () => {
    const t = createBusyTracker(() => 1);
    expect(t.isBusy('alice')).toBe(false);
    expect(t.isBusy('bob')).toBe(false);
  });

  it('flips to busy on `report(name, true)` within the TTL window', () => {
    const clock = makeClock();
    const t = createBusyTracker(clock.now);
    t.report('alice', true);
    expect(t.isBusy('alice')).toBe(true);
    clock.advance(BUSY_TTL_MS - 1);
    expect(t.isBusy('alice')).toBe(true);
  });

  it('clears immediately on `report(name, false)`', () => {
    const clock = makeClock();
    const t = createBusyTracker(clock.now);
    t.report('alice', true);
    t.report('alice', false);
    expect(t.isBusy('alice')).toBe(false);
  });

  it('expires past the TTL even if no `false` report ever arrives', () => {
    // Regression: this is the safety net. A runner that crashes
    // mid-call would otherwise leave the member stuck "working"
    // forever.
    const clock = makeClock();
    const t = createBusyTracker(clock.now);
    t.report('alice', true);
    clock.advance(BUSY_TTL_MS + 1);
    expect(t.isBusy('alice')).toBe(false);
  });

  it('refreshing with another `report(true)` extends the window', () => {
    const clock = makeClock();
    const t = createBusyTracker(clock.now);
    t.report('alice', true);
    clock.advance(BUSY_TTL_MS - 1_000);
    // Heartbeat — runner re-asserts busy.
    t.report('alice', true);
    clock.advance(BUSY_TTL_MS - 1_000);
    // Without refresh this would have lapsed; with refresh it's still live.
    expect(t.isBusy('alice')).toBe(true);
  });

  it('isolates per-name state', () => {
    const clock = makeClock();
    const t = createBusyTracker(clock.now);
    t.report('alice', true);
    expect(t.isBusy('alice')).toBe(true);
    expect(t.isBusy('bob')).toBe(false);
    t.report('bob', true);
    t.report('alice', false);
    expect(t.isBusy('alice')).toBe(false);
    expect(t.isBusy('bob')).toBe(true);
  });

  it('forget() drops the entry', () => {
    const t = createBusyTracker(() => 1);
    t.report('alice', true);
    t.forget('alice');
    expect(t.isBusy('alice')).toBe(false);
  });

  it('purgeStale() removes only expired entries', () => {
    const clock = makeClock();
    const t = createBusyTracker(clock.now);
    t.report('alice', true);
    clock.advance(BUSY_TTL_MS / 2);
    t.report('bob', true);
    clock.advance(BUSY_TTL_MS / 2 + 1); // alice has lapsed, bob hasn't
    t.purgeStale();
    expect(t.isBusy('alice')).toBe(false);
    expect(t.isBusy('bob')).toBe(true);
  });
});
