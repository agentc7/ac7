import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role, Team } from '@agentc7/sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { ENCRYPTED_FIELD_PREFIX, testKek } from '../src/kek.js';
import {
  ConfigNotFoundError,
  createUserStore,
  defaultConfigPath,
  generateUserToken,
  hashToken,
  loadTeamConfigFromFile,
  rotateUserToken,
  UserLoadError,
  setKek,
  TOKEN_HASH_PREFIX,
  writeTeamConfig,
} from '../src/slots.js';

// ── helpers ──────────────────────────────────────────────────────────

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // Reset process-wide KEK so tests don't leak encryption state to
  // unrelated assertions.
  setKek(null);
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac7-slots-test-'));
  dirsToClean.push(dir);
  return dir;
}

function writeConfig(content: string, name = 'ac7.json'): string {
  const dir = tmpDir();
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const SAMPLE_TEAM: Team = {
  name: 'alpha-team',
  directive: 'Ship the payment service.',
  brief: 'We own the full lifecycle.',
};

const SAMPLE_ROLES: Record<string, Role> = {
  'agent': {
    description: 'Directs the team.',
    instructions: 'Lead.',
  },
  implementer: {
    description: 'Writes code.',
    instructions: 'Ship work.',
  },
};

// ── generateUserToken ────────────────────────────────────────────────

describe('generateUserToken', () => {
  it('returns a ac7_-prefixed base64url token', () => {
    const t = generateUserToken();
    expect(t.startsWith('ac7_')).toBe(true);
    expect(t.slice(4)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique tokens across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateUserToken());
    }
    expect(seen.size).toBe(100);
  });

  it('has at least 256 bits of entropy in the payload (43+ base64url chars)', () => {
    const t = generateUserToken();
    expect(t.slice(4).length).toBeGreaterThanOrEqual(43);
  });
});

// ── rotateUserToken ─────────────────────────────────────────────────

describe('rotateUserToken', () => {
  function seedConfig(): { path: string; originalHashes: Record<string, string> } {
    const dir = tmpDir();
    const path = join(dir, 'ac7.json');
    writeTeamConfig(path, SAMPLE_TEAM, SAMPLE_ROLES, [
      {
        name: 'ACTUAL',
        role: 'agent',
        userType: 'admin',
        token: 'original-a',
      },
      {
        name: 'LT-ONE',
        role: 'agent',
        userType: 'operator',
        token: 'original-b',
      },
      {
        name: 'ALPHA-1',
        role: 'implementer',
        token: 'original-c',
        totpSecret: 'ABCDEFGHIJKLMNOP',
        totpLastCounter: 42,
      },
    ]);
    return {
      path,
      originalHashes: {
        ACTUAL: hashToken('original-a'),
        'LT-ONE': hashToken('original-b'),
        'ALPHA-1': hashToken('original-c'),
      },
    };
  }

  it('returns a new ac7_-prefixed plaintext token', () => {
    const { path } = seedConfig();
    const newToken = rotateUserToken(path, 'ACTUAL');
    expect(newToken.startsWith('ac7_')).toBe(true);
    expect(newToken.slice(4).length).toBeGreaterThanOrEqual(43);
  });

  it('invalidates the old bearer token for that slot', () => {
    const { path } = seedConfig();
    rotateUserToken(path, 'ACTUAL');
    const config = loadTeamConfigFromFile(path);
    expect(config.store.resolve('original-a')).toBeNull();
  });

  it('accepts the new plaintext against the updated hash', () => {
    const { path } = seedConfig();
    const newToken = rotateUserToken(path, 'ACTUAL');
    const config = loadTeamConfigFromFile(path);
    const slot = config.store.resolve(newToken);
    expect(slot?.name).toBe('ACTUAL');
  });

  it('does not affect other slots', () => {
    const { path, originalHashes } = seedConfig();
    rotateUserToken(path, 'ACTUAL');
    const config = loadTeamConfigFromFile(path);

    // LT-ONE and ALPHA-1 still resolve against their original tokens.
    expect(config.store.resolve('original-b')?.name).toBe('LT-ONE');
    expect(config.store.resolve('original-c')?.name).toBe('ALPHA-1');

    // And their on-disk hashes are unchanged from pre-rotation.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      users: Array<{ name: string; tokenHash: string }>;
    };
    const ltOne = raw.users.find((s) => s.name === 'LT-ONE');
    const alpha = raw.users.find((s) => s.name === 'ALPHA-1');
    expect(ltOne?.tokenHash).toBe(originalHashes['LT-ONE']);
    expect(alpha?.tokenHash).toBe(originalHashes['ALPHA-1']);
  });

  it('preserves TOTP state on the rotated slot', () => {
    const { path } = seedConfig();
    rotateUserToken(path, 'ALPHA-1');
    const config = loadTeamConfigFromFile(path);
    const slot = config.store.findByName('ALPHA-1');
    expect(slot?.totpSecret).toBe('ABCDEFGHIJKLMNOP');
    expect(slot?.totpLastCounter).toBe(42);
  });

  it('throws UserLoadError on unknown name', () => {
    const { path } = seedConfig();
    expect(() => rotateUserToken(path, 'GHOST')).toThrow(UserLoadError);
  });

  it('throws ConfigNotFoundError when the file does not exist', () => {
    expect(() => rotateUserToken(join(tmpDir(), 'does-not-exist.json'), 'ACTUAL')).toThrow(
      ConfigNotFoundError,
    );
  });
});

// ── at-rest encryption of TOTP + VAPID ───────────────────────────────

describe('at-rest encryption round-trip', () => {
  it('encrypts totpSecret on write and decrypts on load when KEK is active', () => {
    const dir = tmpDir();
    const path = join(dir, 'ac7.json');
    const kek = testKek();

    setKek(kek);
    writeTeamConfig(path, SAMPLE_TEAM, SAMPLE_ROLES, [
      { name: 'ACTUAL', role: 'agent', userType: 'admin', token: 'tok-a' },
      {
        name: 'ALPHA-1',
        role: 'implementer',
        token: 'tok-b',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        totpLastCounter: 99,
      },
    ]);

    // On disk, the totpSecret is ciphertext.
    const rawDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      users: Array<{ name: string; totpSecret?: string }>;
    };
    const alphaOnDisk = rawDisk.users.find((s) => s.name === 'ALPHA-1');
    expect(alphaOnDisk?.totpSecret?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);
    expect(alphaOnDisk?.totpSecret).not.toBe('JBSWY3DPEHPK3PXP');

    // In memory, the loaded slot has plaintext again.
    const config = loadTeamConfigFromFile(path);
    const loaded = config.store.findByName('ALPHA-1');
    expect(loaded?.totpSecret).toBe('JBSWY3DPEHPK3PXP');
    expect(loaded?.totpLastCounter).toBe(99);
  });

  it('migrates plaintext totpSecret on load under an active KEK', () => {
    const dir = tmpDir();
    const path = join(dir, 'ac7.json');
    const kek = testKek();

    // Seed a config WITHOUT a KEK active — totpSecret lands as plaintext.
    setKek(null);
    writeTeamConfig(path, SAMPLE_TEAM, SAMPLE_ROLES, [
      { name: 'ACTUAL', role: 'agent', userType: 'admin', token: 'tok-a' },
      {
        name: 'ALPHA-1',
        role: 'implementer',
        token: 'tok-b',
        totpSecret: 'PLAINTEXTTOTPSECRET',
        totpLastCounter: 5,
      },
    ]);
    const rawBefore = JSON.parse(readFileSync(path, 'utf8')) as {
      users: Array<{ name: string; totpSecret?: string }>;
    };
    expect(rawBefore.users.find((s) => s.name === 'ALPHA-1')?.totpSecret).toBe(
      'PLAINTEXTTOTPSECRET',
    );

    // Now activate the KEK and load — the loader migrates in place.
    setKek(kek);
    const config = loadTeamConfigFromFile(path);
    expect(config.migrated).toBeGreaterThan(0);

    const rawAfter = JSON.parse(readFileSync(path, 'utf8')) as {
      users: Array<{ name: string; totpSecret?: string }>;
    };
    const alphaAfter = rawAfter.users.find((s) => s.name === 'ALPHA-1');
    expect(alphaAfter?.totpSecret?.startsWith(ENCRYPTED_FIELD_PREFIX)).toBe(true);

    // In-memory loaded slot still holds plaintext.
    expect(config.store.findByName('ALPHA-1')?.totpSecret).toBe('PLAINTEXTTOTPSECRET');
  });

  it('rotateUserToken round-trips correctly under an active KEK', () => {
    const dir = tmpDir();
    const path = join(dir, 'ac7.json');
    setKek(testKek());

    writeTeamConfig(path, SAMPLE_TEAM, SAMPLE_ROLES, [
      { name: 'ACTUAL', role: 'agent', userType: 'admin', token: 'tok-a' },
      {
        name: 'ALPHA-1',
        role: 'implementer',
        token: 'tok-b',
        totpSecret: 'PRESERVE-ME',
        totpLastCounter: 77,
      },
    ]);

    const newTok = rotateUserToken(path, 'ALPHA-1');
    const config = loadTeamConfigFromFile(path);
    const loaded = config.store.resolve(newTok);
    expect(loaded?.name).toBe('ALPHA-1');
    // TOTP secret round-trip survives a rotation of an UNRELATED
    // credential (the bearer).
    expect(loaded?.totpSecret).toBe('PRESERVE-ME');
    expect(loaded?.totpLastCounter).toBe(77);
  });
});

// ── hashToken ────────────────────────────────────────────────────────

describe('hashToken', () => {
  it('returns a sha256-prefixed hex digest', () => {
    const h = hashToken('ac7_secret_value');
    expect(h.startsWith(TOKEN_HASH_PREFIX)).toBe(true);
    expect(h.slice(TOKEN_HASH_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input', () => {
    expect(hashToken('same')).toBe(hashToken('same'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

// ── defaultConfigPath ───────────────────────────────────────────────

describe('defaultConfigPath', () => {
  it('honors AC7_CONFIG_PATH when set', () => {
    expect(defaultConfigPath({ AC7_CONFIG_PATH: '/custom/path.json' }, '/irrelevant')).toBe(
      '/custom/path.json',
    );
  });

  it('falls back to cwd/ac7.json when no env is set', () => {
    expect(defaultConfigPath({}, '/home/op/project')).toBe('/home/op/project/ac7.json');
  });

  it('ignores an empty AC7_CONFIG_PATH', () => {
    expect(defaultConfigPath({ AC7_CONFIG_PATH: '' }, '/cwd')).toBe('/cwd/ac7.json');
  });
});

// ── createUserStore ─────────────────────────────────────────────────

describe('createUserStore', () => {
  it('builds a store from in-memory entries', () => {
    const store = createUserStore([
      { name: 'ACTUAL', role: 'agent', token: 'op-token' },
      { name: 'ALPHA-1', role: 'implementer', token: 'impl-token' },
    ]);
    expect(store.size()).toBe(2);
    expect(store.names().sort()).toEqual(['ACTUAL', 'ALPHA-1']);
    expect(store.resolve('op-token')).toEqual({
      name: 'ACTUAL',
      role: 'agent',
      userType: 'agent',
      totpSecret: null,
      totpLastCounter: 0,
    });
    expect(store.resolve('impl-token')).toEqual({
      name: 'ALPHA-1',
      role: 'implementer',
      userType: 'agent',
      totpSecret: null,
      totpLastCounter: 0,
    });
    expect(store.resolve('unknown')).toBeNull();
  });

  it('rejects empty entry lists', () => {
    expect(() => createUserStore([])).toThrow(UserLoadError);
  });

  it('rejects duplicate names', () => {
    expect(() =>
      createUserStore([
        { name: 'ACTUAL', role: 'agent', token: 'a-secret' },
        { name: 'ACTUAL', role: 'implementer', token: 'b-secret' },
      ]),
    ).toThrow(/duplicate name 'ACTUAL'/);
  });

  it('rejects duplicate tokens', () => {
    expect(() =>
      createUserStore([
        { name: 'ACTUAL', role: 'agent', token: 'shared-secret' },
        { name: 'BOB', role: 'agent', token: 'shared-secret' },
      ]),
    ).toThrow(/duplicate token/);
  });
});

// ── loadTeamConfigFromFile ──────────────────────────────────────────

describe('loadTeamConfigFromFile', () => {
  it('loads a well-formed hashed config without rewriting the file', () => {
    const aliceHash = hashToken('ac7_op_secret');
    const implHash = hashToken('ac7_impl_secret');
    const original = JSON.stringify(
      {
        team: SAMPLE_TEAM,
        roles: SAMPLE_ROLES,
        users: [
          {
            name: 'ACTUAL',
            role: 'agent',
            userType: 'admin',
            tokenHash: aliceHash,
          },
          { name: 'ALPHA-1', role: 'implementer', tokenHash: implHash },
        ],
      },
      null,
      2,
    );
    const path = writeConfig(original);
    const config = loadTeamConfigFromFile(path);
    expect(config.store.size()).toBe(2);
    expect(config.store.resolve('ac7_op_secret')?.name).toBe('ACTUAL');
    expect(config.store.resolve('ac7_impl_secret')?.role).toBe('implementer');
    expect(config.migrated).toBe(0);
    expect(config.team).toEqual(SAMPLE_TEAM);
    expect(config.roles['agent']?.description).toContain('team');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('auto-migrates plaintext tokens to hashes and rewrites the file', () => {
    const path = writeConfig(
      JSON.stringify({
        team: SAMPLE_TEAM,
        roles: SAMPLE_ROLES,
        users: [
          {
            name: 'ACTUAL',
            role: 'agent',
            userType: 'admin',
            token: 'ac7_op_secret',
          },
          { name: 'ALPHA-1', role: 'implementer', token: 'ac7_impl_secret' },
        ],
      }),
    );
    const config = loadTeamConfigFromFile(path);
    expect(config.store.resolve('ac7_op_secret')?.name).toBe('ACTUAL');
    expect(config.migrated).toBe(2);

    const rewritten = JSON.parse(readFileSync(path, 'utf8')) as {
      users: Array<{ name: string; role: string; tokenHash?: string; token?: string }>;
    };
    expect(rewritten.users).toHaveLength(2);
    for (const slot of rewritten.users) {
      expect(slot.token).toBeUndefined();
      expect(slot.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    // Re-loading the rewritten file must still resolve the original plaintext.
    const reload = loadTeamConfigFromFile(path);
    expect(reload.migrated).toBe(0);
    expect(reload.store.resolve('ac7_op_secret')?.name).toBe('ACTUAL');
  });

  it('throws ConfigNotFoundError when the file is missing', () => {
    const path = join(tmpDir(), 'does-not-exist.json');
    expect(() => loadTeamConfigFromFile(path)).toThrow(ConfigNotFoundError);
    try {
      loadTeamConfigFromFile(path);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigNotFoundError);
      expect((err as ConfigNotFoundError).path).toBe(path);
    }
  });

  it('rejects the legacy `tokens` schema with a helpful message', () => {
    const path = writeConfig(
      JSON.stringify({
        tokens: [{ name: 'alice', kind: 'human', token: 'ac7_legacy' }],
      }),
    );
    expect(() => loadTeamConfigFromFile(path)).toThrow(/legacy `tokens` schema/);
  });

  it('rejects malformed JSON', () => {
    const path = writeConfig('{not valid json');
    expect(() => loadTeamConfigFromFile(path)).toThrow(/not valid JSON/);
  });

  it('rejects empty slots lists', () => {
    const path = writeConfig(JSON.stringify({ team: SAMPLE_TEAM, roles: SAMPLE_ROLES, users: [] }));
    expect(() => loadTeamConfigFromFile(path)).toThrow(/at least one entry/);
  });

  it('rejects slots referencing an unknown role', () => {
    const path = writeConfig(
      JSON.stringify({
        team: SAMPLE_TEAM,
        roles: SAMPLE_ROLES,
        users: [{ name: 'GHOST', role: 'phantom', token: 'ac7_ghost_secret' }],
      }),
    );
    expect(() => loadTeamConfigFromFile(path)).toThrow(/unknown role 'phantom'/);
  });

  it('rejects names with invalid characters', () => {
    const path = writeConfig(
      JSON.stringify({
        team: SAMPLE_TEAM,
        roles: SAMPLE_ROLES,
        users: [{ name: 'has spaces', role: 'agent', token: 'ac7_bad_secret' }],
      }),
    );
    expect(() => loadTeamConfigFromFile(path)).toThrow();
  });

  it('rejects a slot with neither token nor tokenHash', () => {
    const path = writeConfig(
      JSON.stringify({
        team: SAMPLE_TEAM,
        roles: SAMPLE_ROLES,
        users: [{ name: 'ACTUAL', role: 'agent' }],
      }),
    );
    expect(() => loadTeamConfigFromFile(path)).toThrow();
  });

  it('rejects a slot with both token and tokenHash', () => {
    const path = writeConfig(
      JSON.stringify({
        team: SAMPLE_TEAM,
        roles: SAMPLE_ROLES,
        users: [
          {
            name: 'ACTUAL',
            role: 'agent',
            token: 'ac7_plain_secret',
            tokenHash: hashToken('ac7_plain_secret'),
          },
        ],
      }),
    );
    expect(() => loadTeamConfigFromFile(path)).toThrow();
  });
});

// ── writeTeamConfig ─────────────────────────────────────────────────

describe('writeTeamConfig', () => {
  it('writes a config that loads cleanly and resolves the original plaintext', () => {
    const path = join(tmpDir(), 'ac7.json');
    writeTeamConfig(path, SAMPLE_TEAM, SAMPLE_ROLES, [
      {
        name: 'ACTUAL',
        role: 'agent',
        userType: 'admin',
        token: 'ac7_plain_op',
      },
      { name: 'ALPHA-1', role: 'implementer', token: 'ac7_plain_impl' },
    ]);

    const body = JSON.parse(readFileSync(path, 'utf8')) as {
      team: Team;
      roles: Record<string, Role>;
      users: Array<{ token?: string; tokenHash?: string }>;
    };
    expect(body.team).toEqual(SAMPLE_TEAM);
    expect(body.roles['agent']?.description).toContain('team');
    for (const slot of body.users) {
      expect(slot.token).toBeUndefined();
      expect(slot.tokenHash).toMatch(/^sha256:/);
    }

    const config = loadTeamConfigFromFile(path);
    expect(config.migrated).toBe(0);
    expect(config.store.resolve('ac7_plain_op')?.name).toBe('ACTUAL');
    expect(config.store.resolve('ac7_plain_impl')?.role).toBe('implementer');
  });
});
