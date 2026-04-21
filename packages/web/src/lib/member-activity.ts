/**
 * Presence activity stream — hydration + live SSE tailing for a single
 * slot's `/members/:name/activity` timeline.
 *
 * There's exactly one active subscription at a time — a new call
 * to `startMemberActivitySubscribe(name)` tears down the
 * previous EventSource before opening a new one. This matches how
 * the AgentPage component mounts/unmounts across navigation.
 *
 * On open:
 *   1. Hydrate via `listActivity(name)` — the server
 *      returns up to 200 most-recent rows newest-first. We flip
 *      them into oldest-first order so the UI can prepend newer
 *      events naturally at the top.
 *   2. Open the EventSource at `/members/:name/activity/stream`.
 *   3. Every incoming `message` event is a JSON-encoded
 *      `ActivityRow`. Append to the head of the list
 *      (newest-first), de-duping by `id` so a backfill
 *      immediately after a reconnect doesn't double-render.
 *
 * We cap the in-memory list at `MAX_ROWS` to avoid unbounded
 * growth on long-running pages — oldest rows drop when the cap is
 * exceeded. `loadOlder()` fetches older rows on demand for
 * pagination.
 */

import { ActivityRowSchema } from '@agentc7/sdk/schemas';
import type { ActivityRow } from '@agentc7/sdk/types';
import { signal } from '@preact/signals';
import { getClient } from './client.js';

/** Hard cap on the in-memory row list per subscription. */
const MAX_ROWS = 500;

/**
 * Rows for the currently-subscribed agent, **newest-first**. Empty
 * when no subscription is active or before hydration completes.
 */
export const memberActivityRows = signal<ActivityRow[]>([]);

/** True while the SSE connection is live. False before open / after drop. */
export const memberActivityConnected = signal(false);

/** True during initial hydration + any time `loadOlder()` is in flight. */
export const memberActivityLoading = signal(false);

/** Non-null when hydration failed — surfaced inline on the page. */
export const memberActivityError = signal<string | null>(null);

/** Name of the currently-subscribed agent. null when idle. */
export const memberActivityName = signal<string | null>(null);

/**
 * True when we've scrolled back as far as the server has — no more
 * older rows to fetch. Set when a `loadOlder()` call returns fewer
 * rows than the limit it asked for.
 */
export const memberActivityExhausted = signal(false);

export interface StartAgentActivityOptions {
  name: string;
  /** Backfill depth on hydrate. Default 200 (max). */
  hydrationLimit?: number;
  /** Surface errors to the page. */
  onError?: (err: unknown) => void;
}

/**
 * Start (or switch) the member-activity subscription to the given
 * name. Returns a teardown function that closes the SSE stream
 * and clears the signals. Idempotent.
 */
export function startMemberActivitySubscribe(options: StartAgentActivityOptions): () => void {
  const { name, hydrationLimit = 200, onError } = options;
  const url = `/members/${encodeURIComponent(name)}/activity/stream`;

  let source: EventSource | null = null;
  let cancelled = false;

  // Reset state for the new subscription — previous pages leave
  // their rows in the signal which would otherwise briefly flash
  // the old agent's data.
  memberActivityRows.value = [];
  memberActivityConnected.value = false;
  memberActivityLoading.value = true;
  memberActivityError.value = null;
  memberActivityExhausted.value = false;
  memberActivityName.value = name;

  const hydrate = async (): Promise<void> => {
    try {
      const rows = await getClient().listActivity(name, { limit: hydrationLimit });
      if (cancelled) return;
      // Server returns newest-first; we keep that ordering in the
      // signal (render reads left-to-right as newest-first).
      memberActivityRows.value = rows.slice(0, MAX_ROWS);
      // If the server returned fewer than requested, there's no
      // more history to fetch.
      if (rows.length < hydrationLimit) memberActivityExhausted.value = true;
      memberActivityError.value = null;
    } catch (err) {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      memberActivityError.value = msg;
      onError?.(err);
    } finally {
      if (!cancelled) memberActivityLoading.value = false;
    }
  };

  const open = (): void => {
    if (cancelled) return;
    source = new EventSource(url, { withCredentials: true });

    source.addEventListener('open', () => {
      memberActivityConnected.value = true;
      // Re-hydrate on every successful connect: on initial open
      // this seeds the list, on reconnect it fills any gap the
      // stream dropped. `mergeRows` de-dupes by id so the overlap
      // is harmless.
      void hydrate();
    });

    source.addEventListener('message', (event) => {
      if (!event.data) return;
      try {
        const row = ActivityRowSchema.parse(JSON.parse(event.data));
        mergeRow(row);
      } catch (err) {
        onError?.(err);
      }
    });

    source.addEventListener('error', () => {
      memberActivityConnected.value = false;
      // EventSource auto-reconnects; we don't close and reopen
      // manually or we'd race with its internal retry.
    });
  };

  open();

  return () => {
    cancelled = true;
    memberActivityConnected.value = false;
    memberActivityLoading.value = false;
    memberActivityName.value = null;
    memberActivityRows.value = [];
    memberActivityError.value = null;
    memberActivityExhausted.value = false;
    if (source !== null) {
      source.close();
      source = null;
    }
  };
}

/**
 * Merge a single freshly-arrived row into the newest-first list.
 * Deduped by `id` — if an earlier hydration already has this row,
 * we leave the list alone. Inserts new rows at the head and
 * enforces the `MAX_ROWS` cap on the tail.
 */
function mergeRow(row: ActivityRow): void {
  const existing = memberActivityRows.value;
  if (existing.some((r) => r.id === row.id)) return;
  // Insert in ts-descending position. The common case is that the
  // new row is newer than everything in the list, so we fast-path
  // that and only walk the list for out-of-order arrivals.
  const newest = existing[0];
  if (!newest || row.event.ts >= newest.event.ts) {
    const next = [row, ...existing];
    memberActivityRows.value = next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
    return;
  }
  const inserted = [...existing];
  const idx = inserted.findIndex((r) => r.event.ts <= row.event.ts);
  if (idx === -1) inserted.push(row);
  else inserted.splice(idx, 0, row);
  memberActivityRows.value = inserted.length > MAX_ROWS ? inserted.slice(0, MAX_ROWS) : inserted;
}

/**
 * Load one more page of older rows for the currently-subscribed
 * agent. Uses the oldest row in the current list as an upper
 * bound on the `to` query and asks the server for another
 * hydration-sized chunk. No-op if we're already exhausted or no
 * subscription is active.
 */
export async function loadOlderMemberActivity(limit = 100): Promise<void> {
  const name = memberActivityName.value;
  if (!name) return;
  if (memberActivityExhausted.value) return;
  const rows = memberActivityRows.value;
  const oldest = rows[rows.length - 1];
  if (!oldest) return;
  memberActivityLoading.value = true;
  try {
    // `to = oldest.ts - 1` so we don't re-fetch the oldest row.
    const older = await getClient().listActivity(name, {
      to: oldest.event.ts - 1,
      limit,
    });
    if (older.length === 0) {
      memberActivityExhausted.value = true;
      return;
    }
    const merged = [...rows, ...older];
    // Dedup by id as a safety net against concurrent inserts.
    const seen = new Set<number>();
    const deduped: ActivityRow[] = [];
    for (const r of merged) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      deduped.push(r);
    }
    memberActivityRows.value = deduped.slice(0, MAX_ROWS);
    if (older.length < limit) memberActivityExhausted.value = true;
  } catch (err) {
    memberActivityError.value = err instanceof Error ? err.message : String(err);
  } finally {
    memberActivityLoading.value = false;
  }
}

/** Test-only reset for unit tests. */
export function __resetMemberActivityForTests(): void {
  memberActivityRows.value = [];
  memberActivityConnected.value = false;
  memberActivityLoading.value = false;
  memberActivityError.value = null;
  memberActivityName.value = null;
  memberActivityExhausted.value = false;
}
