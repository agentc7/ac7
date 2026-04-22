/**
 * Team config loading for the ac7 server.
 *
 * A team config defines the directive, the permission presets, and
 * the members that make up the team. Each member carries a name, a
 * role (title + description), per-member permissions (preset name or
 * leaf), personal instructions, and a hashed bearer token. Humans vs
 * agents is not a first-class distinction — members are just
 * members, and TOTP enrollment is optional for anyone.
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
 *       "name": "demo-team",
 *       "directive": "Ship the payment service.",
 *       "brief": "We own the full lifecycle...",
 *       "permissionPresets": {
 *         "admin":    ["team.manage", "members.manage", "objectives.create", "objectives.cancel", "objectives.reassign", "objectives.watch", "activity.read"],
 *         "operator": ["objectives.create", "objectives.cancel", "objectives.reassign"]
 *       }
 *     },
 *     "members": [
 *       { "name": "director-1",  "role": { "title": "director", "description": "Leads the team." },
 *         "instructions": "Approve objectives before they go to the team.",
 *         "permissions": ["admin"],
 *         "tokenHash": "sha256:..." },
 *       { "name": "engineer-1", "role": { "title": "engineer", "description": "Ships code." },
 *         "instructions": "", "permissions": [],
 *         "token": "ac7_plaintext_for_migration" }
 *     ]
 *   }
 *
 * `permissions` entries may be preset names (resolved via the team's
 * `permissionPresets`) or leaf permission strings; the server
 * validates each entry resolves.
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
import type { Member, Permission, Role, Team, Teammate } from '@agentc7/sdk/types';
import { PERMISSIONS } from '@agentc7/sdk/types';
import { z } from 'zod';
import { decryptField, ENCRYPTED_FIELD_PREFIX, encryptField } from './kek.js';

export const TOKEN_HASH_PREFIX = 'sha256:';
const DEFAULT_CONFIG_FILENAME = 'ac7.json';

/**
 * Process-wide KEK for TOTP secret + VAPID private key encryption
 * at rest. Set once at server boot via `setKek` (called from
 * `runServer`), read by the member writers/loaders.
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

/** Hash a raw bearer token into the on-disk representation. */
export function hashToken(rawToken: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * A member materialized in memory once hashes are known. Extends the
 * wire `Member` with server-only fields — TOTP enrollment and replay
 * guard state, plus the raw (unresolved) permissions list so we can
 * round-trip preset references to disk without expanding them.
 */
export interface LoadedMember extends Member {
  /** Preset names + leaf permissions as written on disk; preserved for round-tripping. */
  rawPermissions: string[];
  totpSecret?: string | null;
  totpLastCounter?: number;
}

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const PRESET_KEY_REGEX = /^[a-zA-Z0-9._-]+$/;

// Base32 alphabet (RFC 4648) — plaintext TOTP secrets from `otpauth` use this.
// When at-rest encryption is enabled, the stored value instead has the
// `enc-v1:<iv>:<tag>:<ct>` shape emitted by `encryptField` — all
// base64url segments. Either form passes zod validation here; the
// loader (after zod) uses the `enc-v1:` prefix to decide whether to
// decrypt or treat as legacy plaintext.
const TOTP_SECRET_REGEX = /^(?:[A-Z2-7]+=*|enc-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+)$/;

const PermissionLeafSchema = z.enum(PERMISSIONS);

const RoleSchema = z.object({
  title: z.string().min(1).max(64),
  description: z.string().max(512).default(''),
});

const PermissionPresetsSchema = z.record(
  z
    .string()
    .min(1)
    .max(64)
    .regex(PRESET_KEY_REGEX, 'preset name must be alphanumeric with . _ - allowed'),
  z.array(PermissionLeafSchema),
);

const TeamSchema = z.object({
  name: z.string().min(1).max(128),
  directive: z.string().min(1).max(512),
  brief: z.string().max(4096).default(''),
  permissionPresets: PermissionPresetsSchema.default({}),
});

const MemberEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(NAME_REGEX, 'name must be alphanumeric with . _ - allowed'),
    role: RoleSchema,
    instructions: z.string().max(8192).default(''),
    /**
     * On-disk entries are preset-name-or-leaf strings. Resolution
     * against the team's `permissionPresets` happens post-parse in
     * `loadTeamConfigFromFile` so we can produce useful error
     * messages pointing at unknown names.
     */
    permissions: z.array(z.string().min(1).max(64)).max(32).default([]),
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

const FilesConfigSchema = z.object({
  root: z.string().min(1).optional(),
  maxFileSize: z.number().int().positive().optional(),
});

const TeamConfigSchema = z.object({
  _comment: z.unknown().optional(),
  team: TeamSchema,
  members: z.array(MemberEntrySchema).min(1, 'members must contain at least one entry'),
  https: HttpsConfigSchema.optional(),
  webPush: WebPushConfigSchema.optional(),
  files: FilesConfigSchema.optional(),
});

export type HttpsConfig = z.infer<typeof HttpsConfigSchema>;
export type WebPushConfig = z.infer<typeof WebPushConfigSchema>;
export type FilesConfig = z.infer<typeof FilesConfigSchema>;

export class MemberLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberLoadError';
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

/**
 * Expand a raw permissions list (preset names + leaves) against the
 * team's permission presets into a flat, deduplicated array of leaf
 * permissions. Unknown names throw `MemberLoadError` with the
 * offending entry called out.
 */
export function resolvePermissions(
  raw: readonly string[],
  presets: Record<string, Permission[]>,
  context: string,
): Permission[] {
  const set = new Set<Permission>();
  for (const entry of raw) {
    if ((PERMISSIONS as readonly string[]).includes(entry)) {
      set.add(entry as Permission);
      continue;
    }
    const presetLeaves = presets[entry];
    if (presetLeaves) {
      for (const leaf of presetLeaves) set.add(leaf);
      continue;
    }
    throw new MemberLoadError(
      `${context}: unknown permission or preset '${entry}'. ` +
        `Valid leaves: ${PERMISSIONS.join(', ')}. ` +
        `Presets: ${Object.keys(presets).join(', ') || '(none)'}.`,
    );
  }
  // Preserve canonical leaf ordering so outputs are stable.
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Input to `MemberStore.addMember`. */
export interface AddMemberInput {
  name: string;
  role: Role;
  instructions: string;
  /** Raw form — preset names or leaf permissions. Resolved by caller. */
  rawPermissions: string[];
  /** Resolved leaf permissions (derived from `rawPermissions` + presets). */
  permissions: Permission[];
  token: string;
  totpSecret?: string | null;
}

/** Patch for `MemberStore.updateMember` — any subset of fields may be omitted. */
export interface UpdateMemberPatch {
  role?: Role;
  instructions?: string;
  rawPermissions?: string[];
  permissions?: Permission[];
}

export interface MemberStore {
  // Read surface
  resolve(rawToken: string): LoadedMember | null;
  findByName(name: string): LoadedMember | null;
  /**
   * Internal accessor for the stored token hash of `name`. Used by
   * the persistence helper to rewrite the config file.
   */
  tokenHashOf(name: string): string | null;
  recordTotpAccept(name: string, counter: number): LoadedMember | null;
  size(): number;
  /** Snapshot of every member in insertion order. */
  members(): LoadedMember[];
  names(): string[];
  /** True iff at least one member has the `members.manage` permission. */
  hasAdmin(): boolean;

  // Mutation surface — each method mutates in-memory state atomically
  // and throws `MemberLoadError` on validation failure without leaving
  // partial state. Callers persist the change via `persistMemberStore`.
  addMember(input: AddMemberInput): LoadedMember;
  removeMember(name: string): void;
  updateMember(name: string, patch: UpdateMemberPatch): LoadedMember;
  /** Replace a member's bearer-token hash with a fresh one. */
  rotateToken(name: string, newRawToken: string): LoadedMember;
  /**
   * Replace a member's TOTP secret. Pass `null` to clear the
   * enrollment. Resets `totpLastCounter` to 0.
   */
  setTotpSecret(name: string, secret: string | null): LoadedMember;
}

class MapMemberStore implements MemberStore {
  private readonly byHash = new Map<string, LoadedMember>();
  private readonly byName = new Map<string, LoadedMember>();
  private readonly order: LoadedMember[] = [];

  addHashed(tokenHash: string, member: LoadedMember): void {
    if (this.byHash.has(tokenHash)) {
      throw new MemberLoadError(`duplicate token detected for member '${member.name}'`);
    }
    if (this.byName.has(member.name)) {
      throw new MemberLoadError(`duplicate name '${member.name}'`);
    }
    this.byHash.set(tokenHash, member);
    this.byName.set(member.name, member);
    this.order.push(member);
  }

  resolve(rawToken: string): LoadedMember | null {
    return this.byHash.get(hashToken(rawToken)) ?? null;
  }

  findByName(name: string): LoadedMember | null {
    return this.byName.get(name) ?? null;
  }

  tokenHashOf(name: string): string | null {
    const member = this.byName.get(name);
    if (!member) return null;
    for (const [h, m] of this.byHash) {
      if (m === member) return h;
    }
    return null;
  }

  recordTotpAccept(name: string, counter: number): LoadedMember | null {
    const member = this.byName.get(name);
    if (!member) return null;
    member.totpLastCounter = counter;
    return member;
  }

  size(): number {
    return this.byHash.size;
  }

  members(): LoadedMember[] {
    return [...this.order];
  }

  names(): string[] {
    return this.order.map((m) => m.name);
  }

  hasAdmin(): boolean {
    for (const m of this.order) {
      if (m.permissions.includes('members.manage')) return true;
    }
    return false;
  }

  addMember(input: AddMemberInput): LoadedMember {
    const tokenHash = hashToken(input.token);
    const member: LoadedMember = {
      name: input.name,
      role: input.role,
      instructions: input.instructions,
      permissions: input.permissions,
      rawPermissions: input.rawPermissions,
      totpSecret: input.totpSecret ?? null,
      totpLastCounter: 0,
    };
    this.addHashed(tokenHash, member);
    return member;
  }

  removeMember(name: string): void {
    const member = this.byName.get(name);
    if (!member) throw new MemberLoadError(`no such member: '${name}'`);
    let hashToDrop: string | null = null;
    for (const [h, m] of this.byHash) {
      if (m === member) {
        hashToDrop = h;
        break;
      }
    }
    if (hashToDrop !== null) this.byHash.delete(hashToDrop);
    this.byName.delete(name);
    const idx = this.order.indexOf(member);
    if (idx !== -1) this.order.splice(idx, 1);
  }

  updateMember(name: string, patch: UpdateMemberPatch): LoadedMember {
    const member = this.byName.get(name);
    if (!member) throw new MemberLoadError(`no such member: '${name}'`);
    if (patch.role !== undefined) member.role = patch.role;
    if (patch.instructions !== undefined) member.instructions = patch.instructions;
    if (patch.permissions !== undefined) member.permissions = patch.permissions;
    if (patch.rawPermissions !== undefined) member.rawPermissions = patch.rawPermissions;
    return member;
  }

  rotateToken(name: string, newRawToken: string): LoadedMember {
    const member = this.byName.get(name);
    if (!member) throw new MemberLoadError(`no such member: '${name}'`);
    const newHash = hashToken(newRawToken);
    if (this.byHash.has(newHash)) {
      throw new MemberLoadError('hash collision rotating token — caller should retry');
    }
    let oldHash: string | null = null;
    for (const [h, m] of this.byHash) {
      if (m === member) {
        oldHash = h;
        break;
      }
    }
    if (oldHash !== null) this.byHash.delete(oldHash);
    this.byHash.set(newHash, member);
    return member;
  }

  setTotpSecret(name: string, secret: string | null): LoadedMember {
    const member = this.byName.get(name);
    if (!member) throw new MemberLoadError(`no such member: '${name}'`);
    member.totpSecret = secret;
    member.totpLastCounter = 0;
    return member;
  }
}

/**
 * Build a member store programmatically from plaintext entries. Used
 * by tests and alternate runtimes. Tokens are hashed before storage.
 */
export function createMemberStore(
  entries: Array<{
    name: string;
    role: Role;
    instructions?: string;
    rawPermissions?: string[];
    permissions: Permission[];
    token: string;
    totpSecret?: string | null;
    totpLastCounter?: number;
  }>,
): MemberStore {
  if (entries.length === 0) {
    throw new MemberLoadError('createMemberStore: at least one entry is required');
  }
  const store = new MapMemberStore();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new MemberLoadError(`duplicate name '${entry.name}'`);
    }
    seen.add(entry.name);
    store.addHashed(hashToken(entry.token), {
      name: entry.name,
      role: entry.role,
      instructions: entry.instructions ?? '',
      permissions: entry.permissions,
      rawPermissions: entry.rawPermissions ?? entry.permissions,
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
  store: MemberStore;
  https: HttpsConfig;
  webPush: WebPushConfig | null;
  files: FilesConfig | null;
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
 * Throws `ConfigNotFoundError` on ENOENT and `MemberLoadError` on
 * everything else. If any member carried a plaintext `token`, the
 * file is rewritten with `tokenHash` and chmod 0o600 before returning.
 */
export function loadTeamConfigFromFile(path: string): TeamConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new MemberLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MemberLoadError(
      `config file at ${path} is not valid JSON: ${(err as Error).message}`,
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
    throw new MemberLoadError(`config file at ${path} is invalid:\n${issues}`);
  }

  const team: Team = result.data.team;
  const presets = result.data.team.permissionPresets;

  const store = new MapMemberStore();
  const seen = new Set<string>();
  const onDisk: MemberOnDisk[] = [];
  let migrated = 0;
  let hasAdmin = false;

  for (const entry of result.data.members) {
    if (seen.has(entry.name)) {
      throw new MemberLoadError(`duplicate name '${entry.name}' in ${path}`);
    }
    seen.add(entry.name);

    let tokenHash: string;
    if (entry.tokenHash) {
      tokenHash = entry.tokenHash;
    } else if (entry.token) {
      tokenHash = hashToken(entry.token);
      migrated++;
    } else {
      throw new MemberLoadError(
        `member entry '${entry.name}' in ${path} has neither token nor tokenHash`,
      );
    }

    const resolvedPerms = resolvePermissions(
      entry.permissions,
      presets,
      `member '${entry.name}' in ${path}`,
    );
    if (resolvedPerms.includes('members.manage')) hasAdmin = true;

    const totpLastCounter = entry.totpLastCounter ?? 0;
    const storedTotp = entry.totpSecret ?? null;
    let totpSecretPlaintext: string | null = storedTotp;
    if (storedTotp !== null && activeKek !== null) {
      if (storedTotp.startsWith(ENCRYPTED_FIELD_PREFIX)) {
        totpSecretPlaintext = decryptField(storedTotp, activeKek);
      } else {
        migrated++;
      }
    }

    store.addHashed(tokenHash, {
      name: entry.name,
      role: entry.role,
      instructions: entry.instructions,
      permissions: resolvedPerms,
      rawPermissions: [...entry.permissions],
      totpSecret: totpSecretPlaintext,
      totpLastCounter,
    });
    onDisk.push({
      name: entry.name,
      role: entry.role,
      instructions: entry.instructions,
      permissions: [...entry.permissions],
      tokenHash,
      totpSecret: totpSecretPlaintext,
      totpLastCounter,
    });
  }

  if (!hasAdmin) {
    throw new MemberLoadError(
      `team config at ${path} has no member with the 'members.manage' permission.\n` +
        `At least one admin-capable member is required to administer the team.`,
    );
  }

  const https: HttpsConfig = result.data.https ?? defaultHttpsConfig();
  let webPush: WebPushConfig | null = result.data.webPush ?? null;

  if (webPush !== null && activeKek !== null) {
    if (webPush.vapidPrivateKey.startsWith(ENCRYPTED_FIELD_PREFIX)) {
      const decrypted = decryptField(webPush.vapidPrivateKey, activeKek);
      if (decrypted === null) {
        throw new MemberLoadError(
          `webPush.vapidPrivateKey in ${path} decrypted to null (should not happen)`,
        );
      }
      webPush = { ...webPush, vapidPrivateKey: decrypted };
    } else {
      migrated++;
    }
  }

  const files: FilesConfig | null = result.data.files ?? null;

  if (migrated > 0) {
    const topComment =
      typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
    writeTeamConfigFile(path, topComment, team, onDisk, https, webPush);
  }

  return { team, store, https, webPush, files, migrated };
}

/** Shape persisted to disk for a single member entry. */
interface MemberOnDisk {
  name: string;
  role: Role;
  instructions: string;
  /** Raw form — preset names + leaf permissions. */
  permissions: string[];
  tokenHash: string;
  totpSecret?: string | null;
  totpLastCounter?: number;
}

/**
 * Write a fresh config file from plaintext inputs. Tokens are hashed
 * before write. Mode is 0o600.
 */
export function writeTeamConfig(
  path: string,
  team: Team,
  membersWithTokens: Array<{
    name: string;
    role: Role;
    instructions?: string;
    permissions: string[];
    token: string;
    totpSecret?: string | null;
    totpLastCounter?: number;
  }>,
  https?: HttpsConfig,
  webPush?: WebPushConfig | null,
): void {
  const onDisk: MemberOnDisk[] = membersWithTokens.map((m) => ({
    name: m.name,
    role: m.role,
    instructions: m.instructions ?? '',
    permissions: [...m.permissions],
    tokenHash: hashToken(m.token),
    totpSecret: m.totpSecret ?? null,
    totpLastCounter: m.totpLastCounter ?? 0,
  }));
  writeTeamConfigFile(path, CONFIG_FILE_COMMENT, team, onDisk, https, webPush);
}

/**
 * Atomically rewrite `path` from the current in-memory `MemberStore`
 * state plus the supplied team/https/webPush context.
 */
export function persistMemberStore(
  path: string,
  team: Team,
  store: MemberStore,
  https: HttpsConfig,
  webPush: WebPushConfig | null,
): void {
  const onDisk: MemberOnDisk[] = store.members().map((m) => {
    const tokenHash = store.tokenHashOf(m.name);
    if (tokenHash === null) {
      throw new MemberLoadError(`member '${m.name}' has no token hash in the store`);
    }
    return {
      name: m.name,
      role: m.role,
      instructions: m.instructions,
      permissions: [...m.rawPermissions],
      tokenHash,
      totpSecret: m.totpSecret ?? null,
      totpLastCounter: m.totpLastCounter ?? 0,
    };
  });
  let topComment = CONFIG_FILE_COMMENT;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { _comment?: unknown };
    if (typeof parsed._comment === 'string') topComment = parsed._comment;
  } catch {
    /* fresh file — keep default comment */
  }
  writeTeamConfigFile(path, topComment, team, onDisk, https, webPush);
}

/**
 * Rewrite the config file with a fresh `webPush` block. Called by
 * `runServer` after auto-generating VAPID keys on first boot.
 */
export function writeWebPushConfig(path: string, webPush: WebPushConfig): void {
  const raw = readFileSync(path, 'utf8');
  const parsed = TeamConfigSchema.parse(JSON.parse(raw));
  const topComment = typeof parsed._comment === 'string' ? parsed._comment : CONFIG_FILE_COMMENT;
  const onDisk: MemberOnDisk[] = parsed.members.map((m) => ({
    name: m.name,
    role: m.role,
    instructions: m.instructions,
    permissions: [...m.permissions],
    tokenHash: m.tokenHash ?? hashToken(m.token as string),
    totpSecret: m.totpSecret ?? null,
    totpLastCounter: m.totpLastCounter ?? 0,
  }));
  writeTeamConfigFile(path, topComment, parsed.team, onDisk, parsed.https, webPush);
}

/**
 * Generate a fresh cryptorandom bearer token in the standard
 * `ac7_<base64url>` format. 32 raw bytes → 43-char payload (~256 bits).
 */
export function generateMemberToken(): string {
  return `ac7_${randomBytes(32).toString('base64url')}`;
}

/**
 * Rotate the bearer token for `name`. Generates a fresh plaintext,
 * hashes it, atomically rewrites the config file, and returns the
 * NEW PLAINTEXT so the caller can show it once. The plaintext is
 * never persisted; only its hash lands on disk.
 */
export function rotateMemberToken(path: string, name: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new MemberLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MemberLoadError(
      `config file at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = TeamConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new MemberLoadError(`config file at ${path} is invalid — cannot rotate`);
  }
  const target = result.data.members.find((m) => m.name === name);
  if (!target) {
    throw new MemberLoadError(`no member with name '${name}' in ${path}`);
  }

  const newToken = generateMemberToken();
  const newHash = hashToken(newToken);

  const onDisk: MemberOnDisk[] = result.data.members.map((m) => {
    const tokenHash = m.name === name ? newHash : (m.tokenHash ?? hashToken(m.token as string));
    return {
      name: m.name,
      role: m.role,
      instructions: m.instructions,
      permissions: [...m.permissions],
      tokenHash,
      totpSecret: m.totpSecret ?? null,
      totpLastCounter: m.totpLastCounter ?? 0,
    };
  });

  const topComment =
    typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
  writeTeamConfigFile(
    path,
    topComment,
    result.data.team,
    onDisk,
    result.data.https,
    result.data.webPush,
  );

  return newToken;
}

/** Rewrite the config file with a new TOTP secret for `name`. */
export function enrollMemberTotp(path: string, name: string, totpSecret: string | null): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new MemberLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MemberLoadError(
      `config file at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = TeamConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new MemberLoadError(`config file at ${path} is invalid — cannot enroll`);
  }
  const target = result.data.members.find((m) => m.name === name);
  if (!target) {
    throw new MemberLoadError(`no member with name '${name}' in ${path}`);
  }

  const onDisk: MemberOnDisk[] = result.data.members.map((m) => {
    const tokenHash = m.tokenHash ?? hashToken(m.token as string);
    const secret = m.name === name ? totpSecret : (m.totpSecret ?? null);
    const counter = m.name === name ? 0 : (m.totpLastCounter ?? 0);
    return {
      name: m.name,
      role: m.role,
      instructions: m.instructions,
      permissions: [...m.permissions],
      tokenHash,
      totpSecret: secret,
      totpLastCounter: counter,
    };
  });

  const topComment =
    typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
  writeTeamConfigFile(
    path,
    topComment,
    result.data.team,
    onDisk,
    result.data.https,
    result.data.webPush,
  );
}

function writeTeamConfigFile(
  path: string,
  comment: string,
  team: Team,
  members: MemberOnDisk[],
  https?: HttpsConfig,
  webPush?: WebPushConfig | null,
): void {
  const membersForDisk = members.map((m) => {
    const out: Record<string, unknown> = {
      name: m.name,
      role: m.role,
      permissions: m.permissions,
      tokenHash: m.tokenHash,
    };
    if (m.instructions && m.instructions.length > 0) {
      out.instructions = m.instructions;
    }
    if (m.totpSecret !== undefined && m.totpSecret !== null) {
      out.totpSecret =
        activeKek !== null ? (encryptField(m.totpSecret, activeKek) ?? m.totpSecret) : m.totpSecret;
    }
    if (m.totpLastCounter !== undefined && m.totpLastCounter > 0) {
      out.totpLastCounter = m.totpLastCounter;
    }
    return out;
  });
  const payload: Record<string, unknown> = {
    _comment: comment,
    team,
    members: membersForDisk,
  };
  if (https && !httpsConfigEqualsDefault(https)) {
    payload.https = https;
  }
  if (webPush) {
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
      /* tmp might not exist — ignore */
    }
    throw err;
  }
}

/**
 * Project the loaded members into a teammate list suitable for the
 * roster and briefing responses. Preserves config ordering. Drops
 * the private `instructions` field (teammates don't see each other's
 * personal instructions).
 */
export function teammatesFromMembers(store: MemberStore): Teammate[] {
  return store.members().map((m) => ({
    name: m.name,
    role: m.role,
    permissions: m.permissions,
  }));
}

export const CONFIG_FILE_COMMENT =
  'ac7 team config. Defines one team with a directive, permission presets, and ' +
  'members. Each member has { name, role: {title, description}, instructions, ' +
  'permissions, tokenHash }. `permissions` entries may be preset names ' +
  '(defined in team.permissionPresets) or leaf permissions. At least one ' +
  'member must hold `members.manage` via its permissions. To rotate or add a ' +
  'member by hand, add { "name": "...", "role": {...}, "permissions": [...], ' +
  '"token": "<plaintext>" } and the server will hash the token on next boot.';

export function exampleConfig(): string {
  return `{
  "_comment": "${CONFIG_FILE_COMMENT}",
  "team": {
    "name": "demo-team",
    "directive": "Describe what the team is working toward.",
    "brief": "Longer narrative about scope, constraints, operating window.",
    "permissionPresets": {
      "admin": [
        "team.manage",
        "members.manage",
        "objectives.create",
        "objectives.cancel",
        "objectives.reassign",
        "objectives.watch",
        "activity.read"
      ],
      "operator": [
        "objectives.create",
        "objectives.cancel",
        "objectives.reassign"
      ]
    }
  },
  "members": [
    {
      "name": "director-1",
      "role": { "title": "director", "description": "Leads the team, approves objective scope, mediates cross-functional decisions." },
      "instructions": "Approve objectives before they go to the team. Escalate blockers within 2 hours.",
      "permissions": ["admin"],
      "token": "ac7_change_me_to_a_real_secret"
    },
    {
      "name": "manager-1",
      "role": { "title": "manager", "description": "Runs day-to-day operations and triages incoming work." },
      "instructions": "",
      "permissions": ["operator"],
      "token": "ac7_change_me_to_another_real_secret"
    },
    {
      "name": "engineer-1",
      "role": { "title": "engineer", "description": "Writes and ships code changes; reports progress on assigned objectives." },
      "instructions": "",
      "permissions": [],
      "token": "ac7_change_me_to_another_real_secret"
    }
  ]
}`;
}
