/**
 * Client-side auth config — `(broker URL, bearer token)` persisted at
 * `~/.config/ac7/auth.json` after a successful `ac7 connect` run.
 *
 * The CLI defaults to the env-var path (`AC7_URL` / `AC7_TOKEN`)
 * when both are present, and falls back to this file when they're
 * absent. That keeps existing CI / scripted setups working as-is
 * while giving operators the gh-style "log in once" experience for
 * machine-issued tokens.
 *
 * Storage shape is intentionally minimal — one entry per broker
 * URL, the most-recent write wins for the same URL. We do NOT
 * persist the `tokenId` (server-side handle), `label`, or `member
 * name`; if any of those drift the worst-case is the user re-runs
 * `ac7 connect`. Less metadata on disk = less to leak if the file
 * is exfiltrated.
 *
 * File mode is 0o600 in a 0o700 dir, same posture as the server's
 * `ac7.json` and the telemetry path.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AuthConfigEntry {
  url: string;
  token: string;
  /** Epoch ms — when the token was minted on this device. */
  savedAt: number;
}

interface AuthConfigFile {
  /** Schema marker — bump if the file shape changes. */
  schema: 1;
  entries: AuthConfigEntry[];
}

/**
 * Resolve the auth-config file path. `AC7_AUTH_CONFIG_PATH` overrides
 * for tests and air-gapped layouts.
 */
export function authConfigPath(): string {
  const override = process.env.AC7_AUTH_CONFIG_PATH;
  if (override) return override;
  const home = homedir();
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appdata, 'ac7', 'auth.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'ac7', 'auth.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdg, 'ac7', 'auth.json');
}

/** Read every saved entry. Empty list on missing file or unrecognized shape. */
export function loadAuthConfig(path: string = authConfigPath()): AuthConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { schema: 1, entries: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuthConfigFile>;
    if (parsed.schema !== 1 || !Array.isArray(parsed.entries)) {
      // Surface unknown / corrupted state as an empty file rather
      // than crashing — the next save will overwrite it.
      return { schema: 1, entries: [] };
    }
    return {
      schema: 1,
      entries: parsed.entries.filter(
        (e): e is AuthConfigEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as AuthConfigEntry).url === 'string' &&
          typeof (e as AuthConfigEntry).token === 'string' &&
          typeof (e as AuthConfigEntry).savedAt === 'number',
      ),
    };
  } catch {
    return { schema: 1, entries: [] };
  }
}

/**
 * Atomically replace the entry for `url` (or insert if new) and
 * write back at 0o600. `mkdir -p` the containing dir at 0o700 so a
 * fresh install can save without an explicit setup step.
 */
export function saveAuthEntry(entry: AuthConfigEntry, path: string = authConfigPath()): void {
  const file = loadAuthConfig(path);
  const next: AuthConfigEntry[] = file.entries.filter((e) => e.url !== entry.url);
  next.push(entry);
  const out: AuthConfigFile = { schema: 1, entries: next };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Find a saved token for `url` (exact match — we do not normalize
 * trailing slashes here; the SDK Client does). Returns null if no
 * entry matches.
 */
export function findAuthEntry(
  url: string,
  path: string = authConfigPath(),
): AuthConfigEntry | null {
  const file = loadAuthConfig(path);
  return file.entries.find((e) => e.url === url) ?? null;
}
