/**
 * Filesystem store — the permission-aware metadata layer over a
 * content-addressed `BlobStore`.
 *
 * Schema:
 *   `fs_entries`    — one row per path (file or directory). Path is the
 *                     primary key; parent_path indexed for tree queries.
 *   `fs_blobs`      — hash → refcount + size. Incremented on every
 *                     create/overwrite that points at a hash;
 *                     decremented on delete/overwrite. At refcount 0
 *                     the blob is dropped from disk.
 *   `fs_grants`     — (path, viewer, granted_via) rows. Populated when
 *                     a message or objective references an attachment,
 *                     granting the recipient read access to that exact
 *                     path even though the tree otherwise belongs to
 *                     someone else.
 *
 * Permissions:
 *   director          — full read/write/delete anywhere
 *   owner             — full read/write/delete under their home (first
 *                       path segment equals their slot name)
 *   everyone else     — read-only, and only when they hold a grant for
 *                       the specific path (exact match, not prefix)
 *
 * Ancestor auto-creation on write keeps the UX simple: writing
 * `/alice/uploads/report.pdf` creates `/alice` and `/alice/uploads`
 * as directories if they don't exist yet.
 */

import type { Authority, FsEntry } from '@agentc7/sdk/types';
import type { Readable } from 'node:stream';
import type { DatabaseSyncInstance, StatementInstance } from '../db.js';
import type { BlobStore } from './blob-store.js';
import { FsError } from './errors.js';
import {
  basenameOf,
  dedupeBasename,
  isAncestorPath,
  joinPath,
  normalizePath,
  ownerOf,
  parentOf,
  ROOT_PATH,
} from './paths.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fs_entries (
    path TEXT PRIMARY KEY,
    parent_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file','directory')),
    owner TEXT NOT NULL,
    content_hash TEXT,
    size INTEGER,
    mime_type TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fs_entries_parent_idx ON fs_entries (parent_path);
  CREATE INDEX IF NOT EXISTS fs_entries_owner_idx ON fs_entries (owner);
  CREATE INDEX IF NOT EXISTS fs_entries_hash_idx ON fs_entries (content_hash);

  CREATE TABLE IF NOT EXISTS fs_blobs (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    refcount INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fs_grants (
    path TEXT NOT NULL,
    viewer TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    granted_via TEXT NOT NULL,
    PRIMARY KEY (path, viewer, granted_via)
  );
  CREATE INDEX IF NOT EXISTS fs_grants_viewer_idx ON fs_grants (viewer);
  CREATE INDEX IF NOT EXISTS fs_grants_path_idx ON fs_grants (path);
`;

interface FsEntryRow {
  path: string;
  parent_path: string;
  name: string;
  kind: 'file' | 'directory';
  owner: string;
  content_hash: string | null;
  size: number | null;
  mime_type: string | null;
  created_at: number;
  created_by: string;
  updated_at: number;
}

function rowToEntry(row: FsEntryRow): FsEntry {
  return {
    path: row.path,
    name: row.name,
    kind: row.kind,
    owner: row.owner,
    size: row.size,
    mimeType: row.mime_type,
    hash: row.content_hash,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  };
}

export interface ViewerContext {
  name: string;
  authority: Authority;
}

export type WriteCollisionStrategy = 'error' | 'overwrite' | 'suffix';

export interface WriteFileInput {
  path: string;
  mimeType: string;
  writer: ViewerContext;
  source: Readable | Buffer;
  collision?: WriteCollisionStrategy;
  /** Reject uploads larger than this many bytes. */
  maxSize?: number;
}

export interface WriteFileResult {
  entry: FsEntry;
  /** True when dedup suffix caused the final path to differ from the requested one. */
  renamed: boolean;
}

export interface FilesystemStore {
  stat(path: string, viewer: ViewerContext): FsEntry | null;
  list(path: string, viewer: ViewerContext): FsEntry[];
  listShared(viewer: ViewerContext): FsEntry[];

  openReadStream(path: string, viewer: ViewerContext): { entry: FsEntry; stream: Readable };

  writeFile(input: WriteFileInput): Promise<WriteFileResult>;
  mkdir(path: string, writer: ViewerContext, opts?: { recursive?: boolean }): FsEntry;
  remove(path: string, writer: ViewerContext, opts?: { recursive?: boolean }): Promise<void>;
  move(from: string, to: string, writer: ViewerContext): FsEntry;

  /**
   * Record that `viewer` is permitted to read `path` via a specific
   * referencing context (message id, objective id, etc.). Idempotent —
   * duplicate (path, viewer, via) triples are coalesced by the primary
   * key.
   */
  grant(path: string, viewer: string, grantedVia: string, now?: number): void;
  /** True iff viewer has at least one grant for path. */
  hasGrant(path: string, viewer: string): boolean;

  /**
   * Create a slot's home directory if missing. Safe to call repeatedly;
   * a no-op when the directory already exists.
   */
  ensureHome(slotName: string, now?: number): void;
}

interface SqliteFilesystemStoreOptions {
  db: DatabaseSyncInstance;
  blobs: BlobStore;
}

class SqliteFilesystemStore implements FilesystemStore {
  private readonly db: DatabaseSyncInstance;
  private readonly blobs: BlobStore;

  private readonly getEntryStmt: StatementInstance;
  private readonly listChildrenStmt: StatementInstance;
  private readonly listDescendantsStmt: StatementInstance;
  private readonly listSharedStmt: StatementInstance;
  private readonly insertEntryStmt: StatementInstance;
  private readonly updateEntryContentStmt: StatementInstance;
  private readonly deleteEntryStmt: StatementInstance;
  private readonly deleteGrantsForPathStmt: StatementInstance;
  private readonly upsertBlobStmt: StatementInstance;
  private readonly incRefStmt: StatementInstance;
  private readonly decRefStmt: StatementInstance;
  private readonly deleteZeroBlobStmt: StatementInstance;
  private readonly insertGrantStmt: StatementInstance;
  private readonly hasGrantStmt: StatementInstance;
  private readonly movePathStmt: StatementInstance;
  private readonly listHomesStmt: StatementInstance;

  constructor(opts: SqliteFilesystemStoreOptions) {
    this.db = opts.db;
    this.blobs = opts.blobs;
    this.db.exec(CREATE_SCHEMA);

    this.getEntryStmt = this.db.prepare('SELECT * FROM fs_entries WHERE path = ?');
    this.listChildrenStmt = this.db.prepare(
      "SELECT * FROM fs_entries WHERE parent_path = ? ORDER BY kind='file', name",
    );
    this.listDescendantsStmt = this.db.prepare(
      "SELECT * FROM fs_entries WHERE path = ? OR path LIKE ? ORDER BY length(path) DESC",
    );
    this.listSharedStmt = this.db.prepare(
      `SELECT DISTINCT e.* FROM fs_entries e
         INNER JOIN fs_grants g ON g.path = e.path
        WHERE g.viewer = ? ORDER BY e.updated_at DESC`,
    );
    this.insertEntryStmt = this.db.prepare(
      `INSERT INTO fs_entries
         (path, parent_path, name, kind, owner, content_hash, size, mime_type,
          created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateEntryContentStmt = this.db.prepare(
      `UPDATE fs_entries SET content_hash = ?, size = ?, mime_type = ?, updated_at = ?
         WHERE path = ?`,
    );
    this.deleteEntryStmt = this.db.prepare('DELETE FROM fs_entries WHERE path = ?');
    this.deleteGrantsForPathStmt = this.db.prepare('DELETE FROM fs_grants WHERE path = ?');
    this.upsertBlobStmt = this.db.prepare(
      `INSERT INTO fs_blobs (hash, size, refcount, created_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(hash) DO NOTHING`,
    );
    this.incRefStmt = this.db.prepare('UPDATE fs_blobs SET refcount = refcount + 1 WHERE hash = ?');
    this.decRefStmt = this.db.prepare('UPDATE fs_blobs SET refcount = refcount - 1 WHERE hash = ?');
    this.deleteZeroBlobStmt = this.db.prepare(
      'DELETE FROM fs_blobs WHERE hash = ? AND refcount <= 0',
    );
    this.insertGrantStmt = this.db.prepare(
      `INSERT INTO fs_grants (path, viewer, granted_at, granted_via) VALUES (?, ?, ?, ?)
         ON CONFLICT(path, viewer, granted_via) DO NOTHING`,
    );
    this.hasGrantStmt = this.db.prepare(
      'SELECT 1 FROM fs_grants WHERE path = ? AND viewer = ? LIMIT 1',
    );
    this.movePathStmt = this.db.prepare(
      `UPDATE fs_entries SET path = ?, parent_path = ?, name = ?, updated_at = ? WHERE path = ?`,
    );
    this.listHomesStmt = this.db.prepare(
      "SELECT * FROM fs_entries WHERE parent_path = '/' AND kind = 'directory' ORDER BY name",
    );
  }

  // ─── permissions ────────────────────────────────────────────────

  private ownsPath(path: string, viewer: ViewerContext): boolean {
    if (path === ROOT_PATH) return false;
    return ownerOf(path) === viewer.name;
  }

  private canRead(path: string, viewer: ViewerContext): boolean {
    if (viewer.authority === 'director') return true;
    if (this.ownsPath(path, viewer)) return true;
    return this.hasGrant(path, viewer.name);
  }

  private canWrite(path: string, viewer: ViewerContext): boolean {
    if (viewer.authority === 'director') return true;
    return this.ownsPath(path, viewer);
  }

  // ─── read API ──────────────────────────────────────────────────

  stat(path: string, viewer: ViewerContext): FsEntry | null {
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FsError('invalid_input', 'cannot stat the root — use list("/") instead');
    }
    if (!this.canRead(normalized, viewer)) {
      throw new FsError('forbidden', `cannot stat ${normalized}`);
    }
    const row = this.getEntryStmt.get(normalized) as FsEntryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  list(path: string, viewer: ViewerContext): FsEntry[] {
    const normalized = normalizePath(path);

    if (normalized === ROOT_PATH) {
      // Root listing: directors see every home; everyone else sees only
      // their own. We query all top-level directories and filter rather
      // than eagerly materializing homes for every slot on the team.
      const rows = this.listHomesStmt.all() as unknown as FsEntryRow[];
      if (viewer.authority === 'director') return rows.map(rowToEntry);
      return rows
        .filter((r) => r.owner === viewer.name)
        .map(rowToEntry);
    }

    if (viewer.authority !== 'director' && !this.ownsPath(normalized, viewer)) {
      throw new FsError('forbidden', `cannot list ${normalized}`);
    }
    const target = this.getEntryStmt.get(normalized) as FsEntryRow | undefined;
    if (!target) {
      // Owner listing their own non-existent home is fine — return empty.
      if (this.ownsPath(normalized, viewer) || viewer.authority === 'director') {
        return [];
      }
      throw new FsError('not_found', `no such path: ${normalized}`);
    }
    if (target.kind !== 'directory') {
      throw new FsError('not_a_directory', `not a directory: ${normalized}`);
    }
    const rows = this.listChildrenStmt.all(normalized) as unknown as FsEntryRow[];
    return rows.map(rowToEntry);
  }

  listShared(viewer: ViewerContext): FsEntry[] {
    const rows = this.listSharedStmt.all(viewer.name) as unknown as FsEntryRow[];
    return rows.map(rowToEntry);
  }

  openReadStream(path: string, viewer: ViewerContext): { entry: FsEntry; stream: Readable } {
    const entry = this.stat(path, viewer);
    if (!entry) throw new FsError('not_found', `no such path: ${path}`);
    if (entry.kind !== 'file') throw new FsError('is_a_directory', `not a file: ${entry.path}`);
    if (!entry.hash) throw new FsError('corrupt', `file has no content hash: ${entry.path}`);
    return { entry, stream: this.blobs.openReadStream(entry.hash) };
  }

  // ─── write API ─────────────────────────────────────────────────

  async writeFile(input: WriteFileInput): Promise<WriteFileResult> {
    const normalized = normalizePath(input.path);
    if (normalized === ROOT_PATH) {
      throw new FsError('invalid_input', 'cannot write to root');
    }
    if (!this.canWrite(normalized, input.writer)) {
      throw new FsError('forbidden', `cannot write to ${normalized}`);
    }

    const parent = parentOf(normalized);
    const now = Date.now();
    // Auto-create ancestors outside the main transaction — mkdir is
    // its own idempotent txn and can safely run before the blob put.
    this.ensureDirectoryTree(parent, input.writer, now);

    // Blob write happens before the metadata transaction. If the
    // transaction fails, the blob becomes a zero-refcount orphan —
    // harmless (GC-eligible), never observable by a user.
    const { hash, size } = Buffer.isBuffer(input.source)
      ? await this.blobs.putFromBuffer(input.source, { maxSize: input.maxSize })
      : await this.blobs.putFromStream(input.source, { maxSize: input.maxSize });

    // Collision resolution happens inside the metadata txn so two
    // concurrent writers at the same path don't both succeed.
    const collision = input.collision ?? 'error';
    let finalPath = normalized;
    let renamed = false;

    this.withTx(() => {
      let existing = this.getEntryStmt.get(finalPath) as FsEntryRow | undefined;

      if (existing) {
        if (existing.kind === 'directory') {
          throw new FsError('is_a_directory', `cannot overwrite directory: ${finalPath}`);
        }
        if (collision === 'error') {
          throw new FsError('exists', `already exists: ${finalPath}`);
        }
        if (collision === 'suffix') {
          const parentPath = existing.parent_path;
          const base = basenameOf(finalPath);
          const newName = dedupeBasename(base, (candidate) => {
            const p = joinPath(parentPath, candidate);
            return this.getEntryStmt.get(p) !== undefined;
          });
          finalPath = joinPath(parentPath, newName);
          existing = undefined;
          renamed = base !== newName;
        }
      }

      this.upsertBlobStmt.run(hash, size, now);

      if (existing && collision === 'overwrite') {
        // Overwrite: decrement the prior blob, point the row at the new hash.
        const priorHash = existing.content_hash;
        this.updateEntryContentStmt.run(hash, size, input.mimeType, now, finalPath);
        this.incRefStmt.run(hash);
        if (priorHash && priorHash !== hash) {
          this.decrementAndMaybeDropBlob(priorHash);
        }
      } else {
        const ownerName = ownerOf(finalPath);
        if (!ownerName) {
          throw new FsError('invalid_input', 'cannot write directly under root');
        }
        this.insertEntryStmt.run(
          finalPath,
          parentOf(finalPath),
          basenameOf(finalPath),
          'file',
          ownerName,
          hash,
          size,
          input.mimeType,
          now,
          input.writer.name,
          now,
        );
        this.incRefStmt.run(hash);
      }
    });

    // Post-txn: if we dropped a prior blob to zero refs on overwrite,
    // the helper already queued a best-effort disk delete (fire-and-forget).
    // No additional work here.

    const row = this.getEntryStmt.get(finalPath) as FsEntryRow | undefined;
    if (!row) throw new FsError('corrupt', `entry vanished after write: ${finalPath}`);
    return { entry: rowToEntry(row), renamed };
  }

  mkdir(path: string, writer: ViewerContext, opts: { recursive?: boolean } = {}): FsEntry {
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FsError('invalid_input', 'cannot mkdir root');
    }
    if (!this.canWrite(normalized, writer)) {
      throw new FsError('forbidden', `cannot mkdir ${normalized}`);
    }
    const now = Date.now();
    if (opts.recursive) {
      return this.ensureDirectoryTree(normalized, writer, now);
    }
    // Non-recursive: parent must exist (unless it's root or the writer's home placeholder).
    const parent = parentOf(normalized);
    if (parent !== ROOT_PATH) {
      const parentRow = this.getEntryStmt.get(parent) as FsEntryRow | undefined;
      if (!parentRow) {
        throw new FsError('not_found', `parent does not exist: ${parent}`);
      }
      if (parentRow.kind !== 'directory') {
        throw new FsError('not_a_directory', `parent is not a directory: ${parent}`);
      }
    }
    return this.createDirectoryRow(normalized, writer, now);
  }

  async remove(
    path: string,
    writer: ViewerContext,
    opts: { recursive?: boolean } = {},
  ): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FsError('invalid_input', 'cannot remove root');
    }
    if (!this.canWrite(normalized, writer)) {
      throw new FsError('forbidden', `cannot remove ${normalized}`);
    }
    const target = this.getEntryStmt.get(normalized) as FsEntryRow | undefined;
    if (!target) {
      throw new FsError('not_found', `no such path: ${normalized}`);
    }

    const blobsToDrop: string[] = [];

    this.withTx(() => {
      if (target.kind === 'file') {
        this.deleteEntryStmt.run(normalized);
        this.deleteGrantsForPathStmt.run(normalized);
        if (target.content_hash) {
          this.decRefStmt.run(target.content_hash);
          if (this.blobRefcount(target.content_hash) <= 0) {
            this.deleteZeroBlobStmt.run(target.content_hash);
            blobsToDrop.push(target.content_hash);
          }
        }
        return;
      }
      // Directory — require recursive OR emptiness.
      const children = this.listChildrenStmt.all(normalized) as unknown as FsEntryRow[];
      if (children.length > 0 && !opts.recursive) {
        throw new FsError('not_empty', `directory not empty: ${normalized}`);
      }
      // Cascade delete — listDescendants returns the target dir plus
      // every row under it, ordered by path length DESC so leaves
      // drop first.
      const rows = this.listDescendantsStmt.all(
        normalized,
        `${normalized}/%`,
      ) as unknown as FsEntryRow[];
      for (const row of rows) {
        this.deleteEntryStmt.run(row.path);
        this.deleteGrantsForPathStmt.run(row.path);
        if (row.kind === 'file' && row.content_hash) {
          this.decRefStmt.run(row.content_hash);
          if (this.blobRefcount(row.content_hash) <= 0) {
            this.deleteZeroBlobStmt.run(row.content_hash);
            blobsToDrop.push(row.content_hash);
          }
        }
      }
    });

    // Disk blob deletes happen outside the DB transaction. Errors are
    // logged-and-swallowed — the metadata is already gone, and an
    // orphan blob costs only disk space.
    await Promise.all(blobsToDrop.map((h) => this.blobs.delete(h)));
  }

  move(from: string, to: string, writer: ViewerContext): FsEntry {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    if (src === dst) {
      const row = this.getEntryStmt.get(src) as FsEntryRow | undefined;
      if (!row) throw new FsError('not_found', `no such path: ${src}`);
      return rowToEntry(row);
    }
    if (src === ROOT_PATH || dst === ROOT_PATH) {
      throw new FsError('invalid_input', 'cannot move root');
    }
    if (!this.canWrite(src, writer) || !this.canWrite(dst, writer)) {
      throw new FsError('forbidden', `cannot move ${src} → ${dst}`);
    }
    if (isAncestorPath(src, dst)) {
      throw new FsError('invalid_input', `destination ${dst} is inside source ${src}`);
    }
    const row = this.getEntryStmt.get(src) as FsEntryRow | undefined;
    if (!row) throw new FsError('not_found', `no such path: ${src}`);
    if (row.kind === 'directory') {
      // v1 limitation: directory moves require rewriting every
      // descendant's path + parent_path. We can add this when we
      // need it; for now files only.
      throw new FsError('invalid_input', 'directory move is not supported yet');
    }

    const now = Date.now();
    this.ensureDirectoryTree(parentOf(dst), writer, now);

    this.withTx(() => {
      const existing = this.getEntryStmt.get(dst) as FsEntryRow | undefined;
      if (existing) throw new FsError('exists', `destination exists: ${dst}`);
      this.movePathStmt.run(dst, parentOf(dst), basenameOf(dst), now, src);
      // Grants follow the path — copy across with the new key. The
      // grant table's PK includes granted_via so we do this as an
      // insert-with-select + delete-old.
      this.db
        .prepare('INSERT INTO fs_grants (path, viewer, granted_at, granted_via) SELECT ?, viewer, granted_at, granted_via FROM fs_grants WHERE path = ?')
        .run(dst, src);
      this.deleteGrantsForPathStmt.run(src);
    });

    const moved = this.getEntryStmt.get(dst) as FsEntryRow | undefined;
    if (!moved) throw new FsError('corrupt', `entry vanished after move: ${dst}`);
    return rowToEntry(moved);
  }

  // ─── grants ───────────────────────────────────────────────────

  grant(path: string, viewer: string, grantedVia: string, now: number = Date.now()): void {
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FsError('invalid_input', 'cannot grant access to root');
    }
    // Owner-self-grants are redundant; skip so fs_grants stays lean.
    if (ownerOf(normalized) === viewer) return;
    this.insertGrantStmt.run(normalized, viewer, now, grantedVia);
  }

  hasGrant(path: string, viewer: string): boolean {
    return this.hasGrantStmt.get(path, viewer) !== undefined;
  }

  // ─── home bootstrap ───────────────────────────────────────────

  ensureHome(slotName: string, now: number = Date.now()): void {
    const home = joinPath('/', slotName);
    const row = this.getEntryStmt.get(home) as FsEntryRow | undefined;
    if (row) return;
    this.insertEntryStmt.run(
      home,
      ROOT_PATH,
      slotName,
      'directory',
      slotName,
      null,
      null,
      null,
      now,
      slotName,
      now,
    );
  }

  // ─── internal helpers ────────────────────────────────────────

  private ensureDirectoryTree(path: string, writer: ViewerContext, now: number): FsEntry {
    if (path === ROOT_PATH) {
      // Return a synthetic root entry — root isn't stored in the DB
      // but callers that want its shape deserve a consistent object.
      return {
        path: ROOT_PATH,
        name: '',
        kind: 'directory',
        owner: '',
        size: null,
        mimeType: null,
        hash: null,
        createdAt: 0,
        createdBy: '',
        updatedAt: 0,
      };
    }
    const existing = this.getEntryStmt.get(path) as FsEntryRow | undefined;
    if (existing) {
      if (existing.kind !== 'directory') {
        throw new FsError('not_a_directory', `ancestor is not a directory: ${path}`);
      }
      return rowToEntry(existing);
    }
    // Recurse up first so we fill in parents before inserting this row.
    this.ensureDirectoryTree(parentOf(path), writer, now);
    return this.createDirectoryRow(path, writer, now);
  }

  private createDirectoryRow(path: string, writer: ViewerContext, now: number): FsEntry {
    if (path === ROOT_PATH) {
      throw new FsError('invalid_input', 'cannot create root');
    }
    const existing = this.getEntryStmt.get(path) as FsEntryRow | undefined;
    if (existing) {
      if (existing.kind !== 'directory') {
        throw new FsError('not_a_directory', `already exists as file: ${path}`);
      }
      return rowToEntry(existing);
    }
    const ownerName = ownerOf(path);
    if (!ownerName) throw new FsError('invalid_input', `cannot create directory at ${path}`);
    this.insertEntryStmt.run(
      path,
      parentOf(path),
      basenameOf(path),
      'directory',
      ownerName,
      null,
      null,
      null,
      now,
      writer.name,
      now,
    );
    const row = this.getEntryStmt.get(path) as unknown as FsEntryRow;
    return rowToEntry(row);
  }

  private withTx<T>(fn: () => T): T {
    const begin = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    begin.run();
    try {
      const out = fn();
      commit.run();
      return out;
    } catch (err) {
      rollback.run();
      throw err;
    }
  }

  private decrementAndMaybeDropBlob(hash: string): void {
    this.decRefStmt.run(hash);
    if (this.blobRefcount(hash) <= 0) {
      this.deleteZeroBlobStmt.run(hash);
      // Disk delete happens later outside the transaction in callers
      // that care; overwrite is called from writeFile which
      // fire-and-forgets it.
      void this.blobs.delete(hash);
    }
  }

  private blobRefcount(hash: string): number {
    const row = this.db.prepare('SELECT refcount FROM fs_blobs WHERE hash = ?').get(hash) as
      | { refcount: number }
      | undefined;
    return row?.refcount ?? 0;
  }
}

export function createSqliteFilesystemStore(opts: SqliteFilesystemStoreOptions): FilesystemStore {
  return new SqliteFilesystemStore(opts);
}
