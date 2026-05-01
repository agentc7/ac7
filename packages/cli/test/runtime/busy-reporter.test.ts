/**
 * Busy-reporter tests.
 *
 * Pins:
 *   - POSTs once per transition (idle→busy, busy→idle).
 *   - Heartbeats `busy: true` on the configured interval while busy.
 *   - Stops heartbeating when the count returns to idle.
 *   - Final clear (`busy: false`) on signal abort.
 *   - Swallows POST failures — the spinner is best-effort.
 */

import type { Client as BrokerClient } from '@agentc7/sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBusyReporter } from '../../src/runtime/busy-reporter.js';
import { createBusySignal } from '../../src/runtime/trace/busy.js';

describe('startBusyReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs once per transition (idle → busy → idle)', async () => {
    const setBusy = vi.fn(async (_: { busy: boolean }) => {});
    const broker = { setBusy } as unknown as BrokerClient;
    const busy = createBusySignal();
    const ac = new AbortController();
    startBusyReporter({ brokerClient: broker, busy, signal: ac.signal, log: () => {} });
    // Initial-state fire from subscribe — equals current state, false.
    expect(setBusy).toHaveBeenCalledTimes(1);
    expect(setBusy).toHaveBeenLastCalledWith({ busy: false });

    const h = busy.start();
    expect(setBusy).toHaveBeenCalledTimes(2);
    expect(setBusy).toHaveBeenLastCalledWith({ busy: true });

    h.finish();
    expect(setBusy).toHaveBeenCalledTimes(3);
    expect(setBusy).toHaveBeenLastCalledWith({ busy: false });

    ac.abort();
  });

  it('heartbeats `busy: true` every heartbeatMs while busy', async () => {
    const setBusy = vi.fn(async (_: { busy: boolean }) => {});
    const broker = { setBusy } as unknown as BrokerClient;
    const busy = createBusySignal();
    const ac = new AbortController();
    startBusyReporter({
      brokerClient: broker,
      busy,
      signal: ac.signal,
      log: () => {},
      heartbeatMs: 1_000,
    });
    setBusy.mockClear();

    busy.start();
    expect(setBusy).toHaveBeenCalledTimes(1); // transition

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setBusy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setBusy).toHaveBeenCalledTimes(3);
    expect(setBusy).toHaveBeenLastCalledWith({ busy: true });

    ac.abort();
  });

  it('stops heartbeating after returning to idle', async () => {
    const setBusy = vi.fn(async (_: { busy: boolean }) => {});
    const broker = { setBusy } as unknown as BrokerClient;
    const busy = createBusySignal();
    const ac = new AbortController();
    startBusyReporter({
      brokerClient: broker,
      busy,
      signal: ac.signal,
      log: () => {},
      heartbeatMs: 1_000,
    });
    setBusy.mockClear();

    const h = busy.start();
    await vi.advanceTimersByTimeAsync(1_000);
    h.finish();
    setBusy.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(setBusy).not.toHaveBeenCalled();

    ac.abort();
  });

  it('on abort, posts a final `busy: false` to clear the spinner', async () => {
    const setBusy = vi.fn(async (_: { busy: boolean }) => {});
    const broker = { setBusy } as unknown as BrokerClient;
    const busy = createBusySignal();
    const ac = new AbortController();
    startBusyReporter({
      brokerClient: broker,
      busy,
      signal: ac.signal,
      log: () => {},
      heartbeatMs: 1_000,
    });
    busy.start();
    setBusy.mockClear();

    ac.abort();
    expect(setBusy).toHaveBeenCalledWith({ busy: false });
  });

  it('does not crash when setBusy rejects — logs at debug and keeps going', async () => {
    const setBusy = vi.fn(async () => {
      throw new Error('network');
    });
    const broker = { setBusy } as unknown as BrokerClient;
    const log = vi.fn();
    const busy = createBusySignal();
    const ac = new AbortController();
    startBusyReporter({
      brokerClient: broker,
      busy,
      signal: ac.signal,
      log,
      heartbeatMs: 1_000,
    });
    busy.start();
    // Let the rejected promise settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toMatch(/setBusy failed/);

    ac.abort();
  });
});
