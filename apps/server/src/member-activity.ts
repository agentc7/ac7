/**
 * Member activity stream store.
 *
 * Append-only timeline per member, capturing everything the member's
 * runner observed: LLM exchanges through the MITM proxy, opaque HTTP
 * calls to non-Anthropic endpoints, and objective lifecycle markers
 * (`objective_open` / `objective_close`). Objective traces are a
 * view over this stream — you query by time range bounded by the
 * markers for a given objectiveId.
 *
 * The store is a thin wrapper around SQLite plus an in-process
 * `EventEmitter` that the SSE endpoint subscribes to for live tail.
 * Appends fire the emitter synchronously after the insert commits,
 * so a subscriber attached during an append never misses a row — and
 * a subscriber that attaches AFTER an append can pull the tail via
 * `list()` and merge with the live stream, if the client cares about
 * zero gaps.
 *
 * Payloads are stored as JSON blobs (`event_json`). The server
 * doesn't introspect them beyond validating the discriminator at the
 * app layer; everything else is the SDK's responsibility.
 */

import { EventEmitter } from 'node:events';
import type {
  ActivityListener,
  ActivityStore as CoreActivityStore,
  ListActivityFilter as CoreListActivityFilter,
} from '@agentc7/core';
import { ActivityEventSchema } from '@agentc7/sdk/schemas';
import type { ActivityEvent, ActivityRow } from '@agentc7/sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS member_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_name TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS member_activity_member_ts_idx
    ON member_activity (member_name, ts);
  CREATE INDEX IF NOT EXISTS member_activity_member_kind_ts_idx
    ON member_activity (member_name, kind, ts);
`;

interface ActivityRowRaw {
  id: number;
  member_name: string;
  ts: number;
  kind: string;
  event_json: string;
  created_at: number;
}

function rowToActivity(row: ActivityRowRaw): ActivityRow {
  let event: ActivityEvent;
  try {
    event = ActivityEventSchema.parse(JSON.parse(row.event_json));
  } catch {
    // Malformed row — shouldn't happen since the app layer validates
    // on write, but degrade gracefully with a placeholder rather
    // than throw so one corrupt row can't break the whole query.
    event = {
      kind: 'opaque_http',
      ts: row.ts,
      duration: 0,
      entry: {
        kind: 'opaque_http',
        startedAt: row.ts,
        endedAt: row.ts,
        host: 'malformed-payload',
        method: 'UNKNOWN',
        url: '',
        status: null,
        requestHeaders: {},
        responseHeaders: {},
        requestBodyPreview: null,
        responseBodyPreview: null,
      },
    };
  }
  return {
    id: row.id,
    memberName: row.member_name,
    event,
    createdAt: row.created_at,
  };
}

export type ListActivityFilter = CoreListActivityFilter;
export type ActivityStore = CoreActivityStore;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

class SqliteActivityStore implements CoreActivityStore {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly emitter = new EventEmitter();

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);
    this.insertStmt = db.prepare(
      `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // An admin with the web UI open + the member itself tailing its
    // own stream can realistically hit 2-3 listeners per member; 50
    // gives plenty of headroom.
    this.emitter.setMaxListeners(50);
  }

  append(memberName: string, events: readonly ActivityEvent[]): ActivityRow[] {
    if (events.length === 0) return [];
    const now = Date.now();
    const inserted: ActivityRow[] = [];

    // Transaction: either all rows land or none. node:sqlite doesn't
    // expose a high-level transaction API; BEGIN/COMMIT via exec is
    // the standard pattern.
    this.db.exec('BEGIN');
    try {
      for (const event of events) {
        const result = this.insertStmt.run(
          memberName,
          event.ts,
          event.kind,
          JSON.stringify(event),
          now,
        );
        const id = Number(result.lastInsertRowid ?? 0);
        inserted.push({
          id,
          memberName,
          event,
          createdAt: now,
        });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }

    for (const row of inserted) {
      this.emitter.emit(`row:${memberName}`, row);
    }

    return inserted;
  }

  list(filter: ListActivityFilter): ActivityRow[] {
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const conditions: string[] = ['member_name = ?'];
    const params: Array<string | number> = [filter.memberName];
    if (filter.from !== undefined) {
      conditions.push('ts >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('ts <= ?');
      params.push(filter.to);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map(() => '?').join(',');
      conditions.push(`kind IN (${placeholders})`);
      params.push(...filter.kinds);
    }
    const sql =
      `SELECT * FROM member_activity WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY ts DESC, id DESC LIMIT ?`;
    params.push(limit);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as unknown as ActivityRowRaw[];
    return rows.map(rowToActivity);
  }

  subscribe(memberName: string, listener: ActivityListener): () => void {
    const key = `row:${memberName}`;
    this.emitter.on(key, listener);
    return () => {
      this.emitter.off(key, listener);
    };
  }

  /**
   * Delete every activity row older than `cutoffTs` (by `event.ts`).
   * Returns the number of rows deleted. Not part of the core
   * `ActivityStore` interface — a non-persistent backend has nothing
   * to prune — but surfaced on the SQLite impl for the
   * `ac7 prune-traces` CLI and any future background-sweep timer.
   */
  prune(cutoffTs: number): number {
    const stmt = this.db.prepare('DELETE FROM member_activity WHERE ts < ?');
    const result = stmt.run(cutoffTs);
    return Number(result.changes ?? 0);
  }
}

export type SqliteActivityStoreHandle = SqliteActivityStore;

export function createSqliteActivityStore(db: DatabaseSyncInstance): SqliteActivityStoreHandle {
  return new SqliteActivityStore(db);
}

/**
 * Stand-alone helper for `ac7 prune-traces` that opens the activity
 * DB, prunes, and closes — without spinning up a full `runServer`.
 */
export function pruneActivityDb(db: DatabaseSyncInstance, cutoffTs: number): number {
  db.exec(CREATE_SCHEMA);
  const stmt = db.prepare('DELETE FROM member_activity WHERE ts < ?');
  const result = stmt.run(cutoffTs);
  return Number(result.changes ?? 0);
}

export { parseDurationMs } from './duration.js';
