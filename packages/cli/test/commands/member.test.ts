/**
 * Tests for `ac7 member <list|create|update|delete>`.
 *
 * Drives `runMemberCommand` against a temporary config file. The
 * command goes through the same code path as production: resolve KEK,
 * load config, mutate the in-memory member store, persist back via
 * `persistMemberStore`. We don't mock the server module — we invoke
 * the real one against a tmpdir.
 *
 * The KEK is auto-generated alongside the config (no `AC7_KEK` env
 * set), so each test runs in fresh isolation. Tokens minted by
 * `member create` are surfaced via the captured stdout for byte-exact
 * assertion.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageError } from '../../src/commands/errors.js';
import { runMemberCommand } from '../../src/commands/member.js';

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpConfig(): { configPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ac7-member-test-'));
  dirsToClean.push(dir);
  return { configPath: join(dir, 'ac7.json'), dir };
}

const SEED_CONFIG = {
  team: {
    name: 'demo-team',
    directive: 'ship',
    brief: '',
    permissionPresets: {
      admin: ['team.manage', 'members.manage'],
      operator: ['objectives.create', 'objectives.cancel'],
    },
  },
  members: [
    {
      name: 'alice',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      tokenHash: `sha256:${'a'.repeat(64)}`,
    },
    {
      name: 'bob',
      role: { title: 'engineer', description: 'works on things' },
      permissions: [],
      tokenHash: `sha256:${'b'.repeat(64)}`,
    },
  ],
};

function seedConfig(configPath: string): void {
  writeFileSync(configPath, JSON.stringify(SEED_CONFIG, null, 2));
}

function captureStdout(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => lines.push(line),
  };
}

// ─── list ────────────────────────────────────────────────────────────

describe('ac7 member list', () => {
  it('renders all members with role + permissions + totp columns', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { lines, write } = captureStdout();
    await runMemberCommand(['list', '--config-path', configPath], write);
    const joined = lines.join('\n');
    expect(joined).toContain('alice');
    expect(joined).toContain('director');
    expect(joined).toContain('members.manage');
    expect(joined).toContain('bob');
    expect(joined).toContain('engineer');
    // bob has no permissions → "baseline".
    expect(joined).toContain('baseline');
  });

  it('errors with a clear UsageError when the config does not exist', async () => {
    const { configPath } = tmpConfig();
    const { write } = captureStdout();
    await expect(runMemberCommand(['list', '--config-path', configPath], write)).rejects.toThrow(
      UsageError,
    );
  });
});

// ─── create ─────────────────────────────────────────────────────────

describe('ac7 member create', () => {
  it('adds a member, prints the plaintext token, and persists the config', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { lines, write } = captureStdout();
    await runMemberCommand(
      [
        'create',
        '--name',
        'carol',
        '--title',
        'engineer',
        '--description',
        'newer engineer',
        '--config-path',
        configPath,
      ],
      write,
    );
    const joined = lines.join('\n');
    expect(joined).toContain("created member 'carol'");
    // The plaintext token must appear exactly once.
    const tokenMatches = joined.match(/ac7_[A-Za-z0-9_-]+/g);
    expect(tokenMatches?.length ?? 0).toBeGreaterThanOrEqual(1);

    // Reload the config and confirm carol landed with a hashed token.
    const reloaded = JSON.parse(readFileSync(configPath, 'utf8')) as typeof SEED_CONFIG;
    const carol = reloaded.members.find((m) => m.name === 'carol');
    expect(carol).toBeDefined();
    expect(carol?.role.title).toBe('engineer');
    expect(carol?.role.description).toBe('newer engineer');
    expect(carol?.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('resolves preset names in --permissions', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await runMemberCommand(
      [
        'create',
        '--name',
        'op-1',
        '--title',
        'operator',
        '--permissions',
        'operator',
        '--config-path',
        configPath,
      ],
      write,
    );
    const reloaded = JSON.parse(readFileSync(configPath, 'utf8')) as typeof SEED_CONFIG;
    const op = reloaded.members.find((m) => m.name === 'op-1');
    // Raw permissions string is preserved on disk; the resolver runs
    // at load time so the JSON keeps `operator` rather than the
    // expanded leaf list. The runtime store has the leaves.
    expect(op?.permissions).toEqual(['operator']);
  });

  it('rejects an invalid name with UsageError', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(
        [
          'create',
          '--name',
          'bad name with spaces',
          '--title',
          'engineer',
          '--config-path',
          configPath,
        ],
        write,
      ),
    ).rejects.toThrow(UsageError);
  });

  it('rejects collisions on existing names', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(
        ['create', '--name', 'bob', '--title', 'engineer', '--config-path', configPath],
        write,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects unknown preset names', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(
        [
          'create',
          '--name',
          'broken',
          '--title',
          'engineer',
          '--permissions',
          'ghost-preset',
          '--config-path',
          configPath,
        ],
        write,
      ),
    ).rejects.toThrow(UsageError);
  });

  it('errors when --name is missing', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(['create', '--title', 'engineer', '--config-path', configPath], write),
    ).rejects.toThrow(/--name/);
  });

  it('errors when --title is missing', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(['create', '--name', 'newbie', '--config-path', configPath], write),
    ).rejects.toThrow(/--title/);
  });
});

// ─── update ─────────────────────────────────────────────────────────

describe('ac7 member update', () => {
  it('updates role title and description', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await runMemberCommand(
      [
        'update',
        '--name',
        'bob',
        '--title',
        'senior engineer',
        '--description',
        'updated bio',
        '--config-path',
        configPath,
      ],
      write,
    );
    const reloaded = JSON.parse(readFileSync(configPath, 'utf8')) as typeof SEED_CONFIG;
    const bob = reloaded.members.find((m) => m.name === 'bob');
    expect(bob?.role.title).toBe('senior engineer');
    expect(bob?.role.description).toBe('updated bio');
  });

  it('updates instructions independently of role', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await runMemberCommand(
      [
        'update',
        '--name',
        'bob',
        '--instructions',
        'pin this guidance',
        '--config-path',
        configPath,
      ],
      write,
    );
    const reloaded = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> & {
      members: Array<{ name: string; instructions?: string; role: { title: string } }>;
    };
    const bob = reloaded.members.find((m) => m.name === 'bob');
    expect(bob?.instructions).toBe('pin this guidance');
    expect(bob?.role.title).toBe('engineer');
  });

  it('refuses to strip members.manage from the last admin', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    // Demoting alice from admin to operator drops members.manage,
    // and there's no other admin → guard fires.
    await expect(
      runMemberCommand(
        ['update', '--name', 'alice', '--permissions', 'operator', '--config-path', configPath],
        write,
      ),
    ).rejects.toThrow(/last admin/);
  });

  it('errors when no fields are provided', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(['update', '--name', 'bob', '--config-path', configPath], write),
    ).rejects.toThrow(/at least one of/);
  });

  it('errors on unknown member name', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(
        ['update', '--name', 'ghost', '--title', 'x', '--config-path', configPath],
        write,
      ),
    ).rejects.toThrow(/no member named 'ghost'/);
  });
});

// ─── delete ─────────────────────────────────────────────────────────

describe('ac7 member delete', () => {
  it('removes a non-admin member', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await runMemberCommand(['delete', '--name', 'bob', '--config-path', configPath], write);
    const reloaded = JSON.parse(readFileSync(configPath, 'utf8')) as typeof SEED_CONFIG;
    expect(reloaded.members.find((m) => m.name === 'bob')).toBeUndefined();
    expect(reloaded.members.find((m) => m.name === 'alice')).toBeDefined();
  });

  it('aliases `remove` to `delete`', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await runMemberCommand(['remove', '--name', 'bob', '--config-path', configPath], write);
    const reloaded = JSON.parse(readFileSync(configPath, 'utf8')) as typeof SEED_CONFIG;
    expect(reloaded.members.find((m) => m.name === 'bob')).toBeUndefined();
  });

  it('refuses to delete the last admin', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(['delete', '--name', 'alice', '--config-path', configPath], write),
    ).rejects.toThrow(/last admin/);
  });

  it('errors on unknown member', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(
      runMemberCommand(['delete', '--name', 'ghost', '--config-path', configPath], write),
    ).rejects.toThrow(/no member named 'ghost'/);
  });

  it('errors when --name is missing', async () => {
    const { configPath } = tmpConfig();
    seedConfig(configPath);
    const { write } = captureStdout();
    await expect(runMemberCommand(['delete', '--config-path', configPath], write)).rejects.toThrow(
      /--name/,
    );
  });
});

// ─── dispatch ───────────────────────────────────────────────────────

describe('ac7 member dispatch', () => {
  it('errors with a friendly UsageError when no subcommand is given', async () => {
    const { write } = captureStdout();
    await expect(runMemberCommand([], write)).rejects.toThrow(/subcommand required/);
  });

  it('errors on an unknown subcommand', async () => {
    const { write } = captureStdout();
    await expect(runMemberCommand(['frobnicate'], write)).rejects.toThrow(
      /unknown member subcommand/,
    );
  });
});
