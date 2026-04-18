/**
 * Team config loading for the ac7 server.
 *
 * A team config defines the directive, the roles, and the slots that
 * make up the team. A slot is a reserved position — name + role +
 * authority tier + secret token that authenticates incoming requests.
 * The server is always one team (multi-team coordination lives
 * at the SaaS layer).
 *
 * On disk the config stores SHA-256 hashes, not plaintext secrets.
 * Humans editing the file by hand can paste a plaintext `token`; the
 * server will hash it on next boot and rewrite the file. A broker
 * compromise via read-only disk access therefore leaks hashes, not
 * the original tokens.
 *
 * Config file format (JSON):
 *
 *   {
 *     "_comment": "...",
 *     "team": {
 *       "name": "alpha-team",
 *       "directive": "Ship the payment service.",
 *       "brief": "We own the full lifecycle..."
 *     },
 *     "roles": {
 *       "individual-contributor":    { "description": "...", "instructions": "..." },
 *       "implementer": { "description": "...", "instructions": "..." }
 *     },
 *     "slots": [
 *       { "name": "ACTUAL",  "role": "individual-contributor",    "authority": "director",  "tokenHash": "sha256:..." },
 *       { "name": "LT-ONE",  "role": "individual-contributor",    "authority": "manager", "tokenHash": "sha256:..." },
 *       { "name": "ALPHA-1", "role": "implementer",                             "token":     "ac7_plaintext_for_migration" }
 *     ]
 *   }
 *
 * Missing `authority` defaults to `individual-contributor`. The file path defaults
 * to `./ac7.json` (relative to the server's working directory);
 * an explicit `--config-path` flag or `AC7_CONFIG_PATH` env var overrides.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as FS,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Authority, Role, Slot, Team, Teammate } from '@ac7/sdk/types';
import { z } from 'zod';
import { decryptField, ENCRYPTED_FIELD_PREFIX, encryptField } from './kek.js';

export const TOKEN_HASH_PREFIX = 'sha256:';
const DEFAULT_CONFIG_FILENAME = 'ac7.json';

/**
 * Process-wide KEK for TOTP secret + VAPID private key encryption
 * at rest. Set once at server boot via `setKek` (called from
 * `runServer`), read by the slot writers/loaders.
 *
 * Null means encryption is disabled — legacy behavior for tests and
 * for runtime environments that haven't called `setKek` yet. When
 * null: loaders return plaintext as-is; writers don't encrypt. When
 * set: loaders transparently decrypt `enc-v1:...` values to
 * plaintext in memory, and writers transparently encrypt plaintext
 * values before JSON.stringify.
 *
 * Backwards-compat semantics:
 *   - A config written by an older version (plaintext totpSecret /
 *     vapidPrivateKey) loads cleanly when a KEK is set — the loader
 *     detects plaintext, counts it against the `migrated` field, and
 *     the writer encrypts on the migration rewrite.
 *   - A config written by a newer version (enc-v1 values) loads
 *     cleanly only when the SAME KEK is available. A wrong KEK
 *     surfaces as a clear authentication error from `decryptField`,
 *     not a silent corruption.
 */
let activeKek: Buffer | null = null;

/**
 * Set the process-wide KEK. Call once during server startup from
 * `runServer`. Passing `null` explicitly disables encryption.
 */
export function setKek(kek: Buffer | null): void {
  activeKek = kek;
}

/** Test-only: read the currently-active KEK (for test setup only). */
export function getKek(): Buffer | null {
  return activeKek;
}

/**
 * Hash a raw bearer token into the on-disk representation.
 */
export function hashToken(rawToken: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * A slot materialized in memory once hashes are known. Extends the
 * wire `Slot` with server-only fields — TOTP enrollment and replay
 * guard state. These never cross the network.
 */
export interface LoadedSlot extends Slot {
  totpSecret?: string | null;
  totpLastCounter?: number;
}

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const ROLE_KEY_REGEX = /^[a-zA-Z0-9._-]+$/;

const TeamSchema = z.object({
  name: z.string().min(1).max(128),
  directive: z.string().min(1).max(512),
  brief: z.string().max(4096).default(''),
});

const RoleSchema = z.object({
  description: z.string().max(512).default(''),
  instructions: z.string().max(8192).default(''),
});

const AuthoritySchema = z.enum(['director', 'manager', 'individual-contributor']);

// Base32 alphabet (RFC 4648) — plaintext TOTP secrets from `otpauth` use this.
// When at-rest encryption is enabled, the stored value instead has the
// `enc-v1:<iv>:<tag>:<ct>` shape emitted by `encryptField` — all
// base64url segments. Either form passes zod validation here; the
// loader (after zod) uses the `enc-v1:` prefix to decide whether to
// decrypt or treat as legacy plaintext.
const TOTP_SECRET_REGEX = /^(?:[A-Z2-7]+=*|enc-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+)$/;

const SlotEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(NAME_REGEX, 'name must be alphanumeric with . _ - allowed'),
    role: z
      .string()
      .min(1)
      .max(64)
      .regex(ROLE_KEY_REGEX, 'role must be alphanumeric with . _ - allowed'),
    authority: AuthoritySchema.default('individual-contributor'),
    token: z.string().min(8, 'token must be at least 8 characters').optional(),
    tokenHash: z
      .string()
      .startsWith(TOKEN_HASH_PREFIX, `tokenHash must start with '${TOKEN_HASH_PREFIX}'`)
      .optional(),
    totpSecret: z
      .string()
      .min(16, 'totpSecret must be at least 16 base32 characters')
      .max(128)
      .regex(TOTP_SECRET_REGEX, 'totpSecret must be a base32-encoded string')
      .nullable()
      .optional(),
    totpLastCounter: z.number().int().nonnegative().optional(),
  })
  .refine((e) => Boolean(e.token) !== Boolean(e.tokenHash), {
    message: 'exactly one of `token` or `tokenHash` is required',
  });

const SelfSignedConfigSchema = z.object({
  lanIp: z.string().nullable().default(null),
  validityDays: z.number().int().positive().max(3650).default(365),
  regenerateIfExpiringWithin: z.number().int().nonnegative().max(365).default(30),
});

const CustomHttpsConfigSchema = z.object({
  certPath: z.string().nullable().default(null),
  keyPath: z.string().nullable().default(null),
});

const WebPushConfigSchema = z.object({
  vapidPublicKey: z.string().min(1),
  vapidPrivateKey: z.string().min(1),
  vapidSubject: z.string().min(1).default('mailto:admin@ac7.local'),
});

const HttpsConfigSchema = z.object({
  mode: z.enum(['off', 'self-signed', 'custom']).default('off'),
  bindHttp: z.number().int().min(1).max(65535).default(8717),
  bindHttps: z.number().int().min(1).max(65535).default(7443),
  redirectHttpToHttps: z.boolean().default(true),
  hsts: z.enum(['auto', 'on', 'off']).default('auto'),
  selfSigned: SelfSignedConfigSchema.default({
    lanIp: null,
    validityDays: 365,
    regenerateIfExpiringWithin: 30,
  }),
  custom: CustomHttpsConfigSchema.default({ certPath: null, keyPath: null }),
});

const TeamConfigSchema = z.object({
  _comment: z.unknown().optional(),
  team: TeamSchema,
  roles: z.record(z.string().min(1).max(64), RoleSchema),
  slots: z.array(SlotEntrySchema).min(1, 'slots must contain at least one entry'),
  https: HttpsConfigSchema.optional(),
  webPush: WebPushConfigSchema.optional(),
});

export type HttpsConfig = z.infer<typeof HttpsConfigSchema>;
export type WebPushConfig = z.infer<typeof WebPushConfigSchema>;

export class SlotLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotLoadError';
  }
}

export class ConfigNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`no config file at ${path}`);
    this.name = 'ConfigNotFoundError';
    this.path = path;
  }
}

export interface SlotStore {
  resolve(rawToken: string): LoadedSlot | null;
  resolveByName(name: string): LoadedSlot | null;
  recordTotpAccept(name: string, counter: number): LoadedSlot | null;
  size(): number;
  slots(): LoadedSlot[];
  names(): string[];
}

class MapSlotStore implements SlotStore {
  private readonly byHash = new Map<string, LoadedSlot>();
  private readonly byName = new Map<string, LoadedSlot>();
  private readonly order: LoadedSlot[] = [];

  addHashed(tokenHash: string, slot: LoadedSlot): void {
    if (this.byHash.has(tokenHash)) {
      throw new SlotLoadError(`duplicate token detected for slot '${slot.name}'`);
    }
    if (this.byName.has(slot.name)) {
      throw new SlotLoadError(`duplicate name '${slot.name}'`);
    }
    this.byHash.set(tokenHash, slot);
    this.byName.set(slot.name, slot);
    this.order.push(slot);
  }

  resolve(rawToken: string): LoadedSlot | null {
    return this.byHash.get(hashToken(rawToken)) ?? null;
  }

  resolveByName(name: string): LoadedSlot | null {
    return this.byName.get(name) ?? null;
  }

  recordTotpAccept(name: string, counter: number): LoadedSlot | null {
    const slot = this.byName.get(name);
    if (!slot) return null;
    slot.totpLastCounter = counter;
    return slot;
  }

  size(): number {
    return this.byHash.size;
  }

  slots(): LoadedSlot[] {
    return [...this.order];
  }

  names(): string[] {
    return this.order.map((s) => s.name);
  }
}

/**
 * Build a slot store programmatically from plaintext entries. Used by
 * tests and by alternate runtimes. Tokens are hashed before storage.
 */
export function createSlotStore(
  entries: Array<{
    name: string;
    role: string;
    authority?: Authority;
    token: string;
    totpSecret?: string | null;
    totpLastCounter?: number;
  }>,
): SlotStore {
  if (entries.length === 0) {
    throw new SlotLoadError('createSlotStore: at least one entry is required');
  }
  const store = new MapSlotStore();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new SlotLoadError(`duplicate name '${entry.name}'`);
    }
    seen.add(entry.name);
    store.addHashed(hashToken(entry.token), {
      name: entry.name,
      role: entry.role,
      authority: entry.authority ?? 'individual-contributor',
      totpSecret: entry.totpSecret ?? null,
      totpLastCounter: entry.totpLastCounter ?? 0,
    });
  }
  return store;
}

export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.AC7_CONFIG_PATH;
  if (explicit && explicit.length > 0) return explicit;
  return join(cwd, DEFAULT_CONFIG_FILENAME);
}

/** Full team config materialized from disk. */
export interface TeamConfig {
  team: Team;
  roles: Record<string, Role>;
  store: SlotStore;
  https: HttpsConfig;
  webPush: WebPushConfig | null;
  migrated: number;
}

export function defaultHttpsConfig(): HttpsConfig {
  return {
    mode: 'off',
    bindHttp: 8717,
    bindHttps: 7443,
    redirectHttpToHttps: true,
    hsts: 'auto',
    selfSigned: {
      lanIp: null,
      validityDays: 365,
      regenerateIfExpiringWithin: 30,
    },
    custom: {
      certPath: null,
      keyPath: null,
    },
  };
}

/**
 * Read, validate, and optionally rewrite the config file at `path`.
 * Throws `ConfigNotFoundError` on ENOENT and `SlotLoadError` on
 * everything else. If any slot carried a plaintext `token`, the file
 * is rewritten with `tokenHash` and chmod 0o600 before returning.
 */
export function loadTeamConfigFromFile(path: string): TeamConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new SlotLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SlotLoadError(`config file at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  // Legacy schema detection — the pre-rename `team` schema is
  // gracefully rejected with a pointer at the current `team` shape.
  if (parsed && typeof parsed === 'object' && 'team' in parsed && !('team' in parsed)) {
    throw new SlotLoadError(
      `config file at ${path} uses the legacy \`team\` schema.\n` +
        `ac7 now uses a team/roles/slots schema. Rename \`team\` → \`team\`,\n` +
        `\`directive\` → \`directive\`, and \`name\` → \`name\`. See\n` +
        `apps/server/config.example.json for the new format, or delete this file\n` +
        `and re-run to launch the setup wizard.`,
    );
  }
  // Also catch the even-older `tokens` top-level array.
  if (
    parsed &&
    typeof parsed === 'object' &&
    'tokens' in parsed &&
    !('team' in parsed) &&
    !('slots' in parsed)
  ) {
    throw new SlotLoadError(
      `config file at ${path} uses the legacy \`tokens\` schema.\n` +
        `ac7 now uses a team/roles/slots schema. See apps/server/config.example.json\n` +
        `for the new format, or delete this file and re-run to launch the setup wizard.`,
    );
  }

  const result = TeamConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue: { path: PropertyKey[]; message: string }) =>
          `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new SlotLoadError(`config file at ${path} is invalid:\n${issues}`);
  }

  const team: Team = result.data.team;
  const roles: Record<string, Role> = result.data.roles;

  // Every slot's role must reference a known role key.
  for (const slot of result.data.slots) {
    if (!Object.hasOwn(roles, slot.role)) {
      throw new SlotLoadError(
        `slot '${slot.name}' references unknown role '${slot.role}' in ${path}. ` +
          `Known roles: ${Object.keys(roles).join(', ') || '(none)'}`,
      );
    }
  }

  // At least one slot must hold director authority so there's always
  // someone who can edit the team config.
  const hasDirector = result.data.slots.some((s) => s.authority === 'director');
  if (!hasDirector) {
    throw new SlotLoadError(
      `team config at ${path} has no slot with authority='director'. ` +
        `At least one director is required to administer the team.`,
    );
  }

  const store = new MapSlotStore();
  const seen = new Set<string>();
  const onDisk: SlotOnDisk[] = [];
  let migrated = 0;

  for (const entry of result.data.slots) {
    if (seen.has(entry.name)) {
      throw new SlotLoadError(`duplicate name '${entry.name}' in ${path}`);
    }
    seen.add(entry.name);

    let tokenHash: string;
    if (entry.tokenHash) {
      tokenHash = entry.tokenHash;
    } else if (entry.token) {
      tokenHash = hashToken(entry.token);
      migrated++;
    } else {
      throw new SlotLoadError(
        `slot entry '${entry.name}' in ${path} has neither token nor tokenHash`,
      );
    }

    const totpLastCounter = entry.totpLastCounter ?? 0;

    // TOTP secret handling. When a KEK is active:
    //   - enc-v1 values are decrypted to plaintext for the in-memory
    //     LoadedSlot (so verifyTotpCode has a usable secret).
    //   - plaintext values (legacy / hand-edited) flow through as-is,
    //     bump `migrated`, and land as plaintext in `onDisk` — the
    //     writer encrypts them on the migration rewrite.
    // When no KEK is active, values pass through unchanged — keeps
    // tests and KEK-less dev flows working identically to pre-
    // encryption behavior.
    const storedTotp = entry.totpSecret ?? null;
    let totpSecretPlaintext: string | null = storedTotp;
    if (storedTotp !== null && activeKek !== null) {
      if (storedTotp.startsWith(ENCRYPTED_FIELD_PREFIX)) {
        totpSecretPlaintext = decryptField(storedTotp, activeKek);
      } else {
        // Plaintext found under an active KEK — migrate.
        migrated++;
      }
    }

    store.addHashed(tokenHash, {
      name: entry.name,
      role: entry.role,
      authority: entry.authority,
      totpSecret: totpSecretPlaintext,
      totpLastCounter,
    });
    onDisk.push({
      name: entry.name,
      role: entry.role,
      authority: entry.authority,
      tokenHash,
      // onDisk always holds plaintext; writer encrypts when KEK is active.
      totpSecret: totpSecretPlaintext,
      totpLastCounter,
    });
  }

  const https: HttpsConfig = result.data.https ?? defaultHttpsConfig();
  let webPush: WebPushConfig | null = result.data.webPush ?? null;

  // VAPID private key encryption follows the same at-rest story as
  // TOTP secrets. A PEM private key is always multi-line with dashes;
  // `enc-v1:...` is single-line. Same migration detection pattern.
  if (webPush !== null && activeKek !== null) {
    if (webPush.vapidPrivateKey.startsWith(ENCRYPTED_FIELD_PREFIX)) {
      const decrypted = decryptField(webPush.vapidPrivateKey, activeKek);
      if (decrypted === null) {
        throw new SlotLoadError(
          `webPush.vapidPrivateKey in ${path} decrypted to null (should not happen)`,
        );
      }
      webPush = { ...webPush, vapidPrivateKey: decrypted };
    } else {
      // Plaintext PEM — migrate.
      migrated++;
    }
  }

  if (migrated > 0) {
    const topComment =
      typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
    writeTeamConfigFile(path, topComment, team, roles, onDisk, https, webPush);
  }

  return { team, roles, store, https, webPush, migrated };
}

/** Shape persisted to disk for a single slot entry. */
interface SlotOnDisk {
  name: string;
  role: string;
  authority: Authority;
  tokenHash: string;
  totpSecret?: string | null;
  totpLastCounter?: number;
}

/**
 * Write a fresh config file containing the supplied team, roles,
 * and slots with their tokens hashed. Mode is 0o600.
 */
export function writeTeamConfig(
  path: string,
  team: Team,
  roles: Record<string, Role>,
  slotsWithTokens: Array<{
    name: string;
    role: string;
    authority?: Authority;
    token: string;
    totpSecret?: string | null;
    totpLastCounter?: number;
  }>,
  https?: HttpsConfig,
  webPush?: WebPushConfig | null,
): void {
  const onDisk: SlotOnDisk[] = slotsWithTokens.map((s) => ({
    name: s.name,
    role: s.role,
    authority: s.authority ?? 'individual-contributor',
    tokenHash: hashToken(s.token),
    totpSecret: s.totpSecret ?? null,
    totpLastCounter: s.totpLastCounter ?? 0,
  }));
  writeTeamConfigFile(path, CONFIG_FILE_COMMENT, team, roles, onDisk, https, webPush);
}

/**
 * Rewrite the config file with a fresh `webPush` block. Called by
 * `runServer` after auto-generating VAPID keys on first boot.
 */
export function writeWebPushConfig(path: string, webPush: WebPushConfig): void {
  const raw = readFileSync(path, 'utf8');
  const parsed = TeamConfigSchema.parse(JSON.parse(raw));
  const topComment = typeof parsed._comment === 'string' ? parsed._comment : CONFIG_FILE_COMMENT;
  const onDisk: SlotOnDisk[] = parsed.slots.map((s) => ({
    name: s.name,
    role: s.role,
    authority: s.authority,
    tokenHash: s.tokenHash ?? hashToken(s.token as string),
    totpSecret: s.totpSecret ?? null,
    totpLastCounter: s.totpLastCounter ?? 0,
  }));
  writeTeamConfigFile(path, topComment, parsed.team, parsed.roles, onDisk, parsed.https, webPush);
}

/**
 * Generate a fresh cryptorandom bearer token in the same
 * `ac7_<base64url>` format the wizard uses. 32 raw bytes → 43-char
 * base64url payload (~256 bits of entropy).
 */
export function generateSlotToken(): string {
  return `ac7_${randomBytes(32).toString('base64url')}`;
}

/**
 * Rotate the bearer token for `name`. Generates a fresh
 * cryptorandom plaintext token, hashes it, atomically rewrites the
 * config file, and returns the NEW PLAINTEXT so the caller can show
 * it to the individual-contributor once. The plaintext is never persisted; only
 * its hash lands on disk.
 *
 * Safety posture:
 *   - Atomic: temp-file + rename inside the config directory.
 *   - 0o600 on the result (same as writeTeamConfig).
 *   - Defensive reload + re-parse of the file, so a concurrent hand
 *     edit elsewhere in the same file doesn't get trampled.
 *   - Preserves every other slot's `totpSecret` / `totpLastCounter` /
 *     `authority` / `role` untouched.
 */
export function rotateSlotToken(path: string, name: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new SlotLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SlotLoadError(`config file at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = TeamConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new SlotLoadError(`config file at ${path} is invalid — cannot rotate`);
  }
  const target = result.data.slots.find((s) => s.name === name);
  if (!target) {
    throw new SlotLoadError(`no slot with name '${name}' in ${path}`);
  }

  const newToken = generateSlotToken();
  const newHash = hashToken(newToken);

  const onDisk: SlotOnDisk[] = result.data.slots.map((s) => {
    if (s.name === name) {
      return {
        name: s.name,
        role: s.role,
        authority: s.authority,
        tokenHash: newHash,
        totpSecret: s.totpSecret ?? null,
        totpLastCounter: s.totpLastCounter ?? 0,
      };
    }
    return {
      name: s.name,
      role: s.role,
      authority: s.authority,
      tokenHash: s.tokenHash ?? hashToken(s.token as string),
      totpSecret: s.totpSecret ?? null,
      totpLastCounter: s.totpLastCounter ?? 0,
    };
  });

  const topComment =
    typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
  writeTeamConfigFile(
    path,
    topComment,
    result.data.team,
    result.data.roles,
    onDisk,
    result.data.https,
    result.data.webPush,
  );

  return newToken;
}

/**
 * Rewrite the config file at `path` with a new TOTP secret for
 * `name`. Used by the CLI `ac7 enroll` command and by the wizard.
 */
export function enrollSlotTotp(path: string, name: string, totpSecret: string | null): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new SlotLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SlotLoadError(`config file at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = TeamConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new SlotLoadError(`config file at ${path} is invalid — cannot enroll`);
  }
  const target = result.data.slots.find((s) => s.name === name);
  if (!target) {
    throw new SlotLoadError(`no slot with name '${name}' in ${path}`);
  }

  const onDisk: SlotOnDisk[] = result.data.slots.map((s) => {
    const tokenHash = s.tokenHash ?? hashToken(s.token as string);
    if (s.name === name) {
      return {
        name: s.name,
        role: s.role,
        authority: s.authority,
        tokenHash,
        totpSecret,
        totpLastCounter: 0,
      };
    }
    return {
      name: s.name,
      role: s.role,
      authority: s.authority,
      tokenHash,
      totpSecret: s.totpSecret ?? null,
      totpLastCounter: s.totpLastCounter ?? 0,
    };
  });

  const topComment =
    typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
  writeTeamConfigFile(
    path,
    topComment,
    result.data.team,
    result.data.roles,
    onDisk,
    result.data.https,
    result.data.webPush,
  );
}

function writeTeamConfigFile(
  path: string,
  comment: string,
  team: Team,
  roles: Record<string, Role>,
  slots: SlotOnDisk[],
  https?: HttpsConfig,
  webPush?: WebPushConfig | null,
): void {
  const slotsForDisk = slots.map((s) => {
    const out: Record<string, unknown> = {
      name: s.name,
      role: s.role,
    };
    // Only emit `authority` when it differs from the default, to keep
    // freshly-written configs tidy for plain-individual-contributor-only teams.
    if (s.authority !== 'individual-contributor') {
      out.authority = s.authority;
    }
    out.tokenHash = s.tokenHash;
    if (s.totpSecret !== undefined && s.totpSecret !== null) {
      // Encrypt at the on-disk boundary when a KEK is active.
      // `encryptField` is idempotent on enc-v1 values, so passing a
      // mix of plaintext + already-encrypted values (e.g. during an
      // enroll that touches one slot in a file with others in
      // various states) is safe.
      out.totpSecret =
        activeKek !== null ? (encryptField(s.totpSecret, activeKek) ?? s.totpSecret) : s.totpSecret;
    }
    if (s.totpLastCounter !== undefined && s.totpLastCounter > 0) {
      out.totpLastCounter = s.totpLastCounter;
    }
    return out;
  });
  const payload: Record<string, unknown> = {
    _comment: comment,
    team,
    roles,
    slots: slotsForDisk,
  };
  if (https && !httpsConfigEqualsDefault(https)) {
    payload.https = https;
  }
  if (webPush) {
    // Encrypt the VAPID private key at the on-disk boundary when a
    // KEK is active. Public key and subject stay in the clear —
    // neither is sensitive.
    const vapidPrivateKeyForDisk =
      activeKek !== null
        ? (encryptField(webPush.vapidPrivateKey, activeKek) ?? webPush.vapidPrivateKey)
        : webPush.vapidPrivateKey;
    payload.webPush = { ...webPush, vapidPrivateKey: vapidPrivateKeyForDisk };
  }
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  atomicWriteRestricted(path, body);
}

function httpsConfigEqualsDefault(https: HttpsConfig): boolean {
  const def = defaultHttpsConfig();
  return JSON.stringify(https) === JSON.stringify(def);
}

function atomicWriteRestricted(path: string, body: string): void {
  const dir = dirname(path);
  const nonce = randomBytes(6).toString('hex');
  const tmp = join(dir, `.ac7.${nonce}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, FS.O_CREAT | FS.O_WRONLY | FS.O_EXCL, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort only
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // tmp might not exist, or already renamed — either way, ignore
    }
    throw err;
  }
}

/**
 * Project the loaded slots into a teammate list suitable for the
 * briefing response. Preserves config ordering. Cached by store
 * identity since slots are immutable after boot.
 */
const teammateCache = new WeakMap<SlotStore, Teammate[]>();
export function teammatesFromStore(store: SlotStore): Teammate[] {
  const cached = teammateCache.get(store);
  if (cached) return cached;
  const teammates = store.slots().map((s) => ({
    name: s.name,
    role: s.role,
    authority: s.authority,
  }));
  teammateCache.set(store, teammates);
  return teammates;
}

export const CONFIG_FILE_COMMENT =
  'ac7 team config. Defines one team with a directive, roles, and slots. ' +
  'Each slot has { name, role, authority, tokenHash }. `authority` is one of ' +
  '`director | manager | individual-contributor`, defaulting to `individual-contributor` when omitted. ' +
  'At least one director is required. To rotate or add a slot by hand, add ' +
  '{ "name": "...", "role": "...", "authority": "...", "token": "<plaintext>" } ' +
  'and the server will hash the token on next boot and rewrite this file.';

export function exampleConfig(): string {
  return `{
  "_comment": "${CONFIG_FILE_COMMENT}",
  "team": {
    "name": "alpha-team",
    "directive": "Describe what the team is working toward.",
    "brief": "Longer narrative about scope, constraints, operating window."
  },
  "roles": {
    "individual-contributor": {
      "description": "Human directs the team, makes go/no-go calls, handles escalations.",
      "instructions": "The individual-contributor role directs activity in the team channel and handles escalations."
    },
    "implementer": {
      "description": "Writes and ships code changes.",
      "instructions": "The implementer role writes and ships code, takes direction from the director, and reports progress."
    },
    "reviewer": {
      "description": "Reviews implementer work before it ships.",
      "instructions": "The reviewer role checks diffs and signs off on changes."
    },
    "watcher": {
      "description": "Passively monitors team activity and flags anomalies.",
      "instructions": "The watcher role observes team activity and surfaces issues."
    }
  },
  "slots": [
    { "name": "ACTUAL",  "role": "individual-contributor",    "authority": "director",  "token": "ac7_change_me_to_a_real_secret" },
    { "name": "LT-ONE",  "role": "individual-contributor",    "authority": "manager", "token": "ac7_change_me_to_another_real_secret" },
    { "name": "ALPHA-1", "role": "implementer",                             "token": "ac7_change_me_to_another_real_secret" }
  ]
}`;
}
