/**
 * First-run wizard tests.
 *
 * The wizard collects a team + first admin, auto-enrolls the admin
 * in TOTP, and writes the config. We stub stdin with a scripted
 * queue so each test drives the exact sequence of prompts the
 * wizard asks. Tests also pin the TOTP secret + clock so the
 * verification step is deterministic.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeamConfigFromFile, UserLoadError } from '../src/slots.js';
import { currentCode } from '../src/totp.js';
import {
  DEFAULT_ROLES,
  type RunWizardOptions,
  runFirstRunWizard,
  type WizardIO,
} from '../src/wizard.js';

interface MockIO extends WizardIO {
  output: string[];
  remaining(): number;
}

function mockIO(scripted: string[], isInteractive = true): MockIO {
  const queue = scripted.slice();
  const output: string[] = [];
  return {
    output,
    isInteractive,
    prompt: async (question) => {
      output.push(`? ${question}`);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`mock IO exhausted (prompt: ${question})`);
      }
      return next;
    },
    println: (line) => {
      output.push(line);
    },
    redactLines: () => {},
    remaining: () => queue.length,
  };
}

/**
 * A deterministic TOTP secret + clock pair. `currentCode(SECRET, T)`
 * produces a known code the mock IO can submit without guesswork.
 * 160 bits of entropy, base32-encoded, matching what `generateSecret`
 * would emit.
 */
const FIXED_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const FIXED_NOW_MS = 1_700_000_000_000;

describe('runFirstRunWizard', () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpConfigPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ac7-wizard-test-'));
    dirsToClean.push(dir);
    return join(dir, 'ac7.json');
  }

  function wizardOpts(configPath: string, io: WizardIO): RunWizardOptions {
    return {
      configPath,
      io,
      tokenFactory: () => 'ac7_test_fixed_token',
      totpSecretFactory: () => FIXED_TOTP_SECRET,
      now: () => FIXED_NOW_MS,
      qrRenderer: () => '«qr»',
    };
  }

  it('creates a team + first admin and writes a loadable config', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO([
      // team name (accept default 'my-team')
      '',
      // directive (required)
      'Ship the payment service',
      // brief (skip)
      '',
      // admin name (accept default 'admin')
      '',
      // admin role (accept default 'admin')
      '',
      // press enter after token banner
      '',
      // TOTP confirmation code
      code,
    ]);

    const config = await runFirstRunWizard(wizardOpts(configPath, io));

    // Returned TeamConfig is fully populated.
    expect(config.team.name).toBe('my-team');
    expect(config.team.directive).toBe('Ship the payment service');
    expect(config.team.brief).toBe('');
    expect(config.store.size()).toBe(1);
    expect(config.store.hasAdmin()).toBe(true);

    const admin = config.store.findByName('admin');
    expect(admin).toBeTruthy();
    expect(admin?.userType).toBe('admin');
    expect(admin?.role).toBe('admin');
    expect(admin?.totpSecret).toBe(FIXED_TOTP_SECRET);
    expect(admin?.totpLastCounter).toBe(0);

    // On-disk config loads cleanly and still resolves via the token.
    const reloaded = loadTeamConfigFromFile(configPath);
    expect(reloaded.store.size()).toBe(1);
    const resolved = reloaded.store.resolve('ac7_test_fixed_token');
    expect(resolved?.name).toBe('admin');
    expect(resolved?.userType).toBe('admin');

    // No unconsumed scripted input — means the wizard asked exactly
    // the seven prompts we set up.
    expect(io.remaining()).toBe(0);
  });

  it('ships all four default roles in the generated config', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(['', 'Ship', '', '', '', '', code]);
    const config = await runFirstRunWizard(wizardOpts(configPath, io));

    const roleKeys = Object.keys(config.roles).sort();
    expect(roleKeys).toEqual(['admin', 'implementer', 'reviewer', 'watcher']);
    for (const key of Object.keys(DEFAULT_ROLES)) {
      expect(config.roles[key]).toBeDefined();
    }
  });

  it('adds a placeholder entry for a custom role', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO([
      '',
      'Ship',
      '',
      'chief',
      // custom role 'operator-general' (not in DEFAULT_ROLES)
      'operator-general',
      '',
      code,
    ]);
    const config = await runFirstRunWizard(wizardOpts(configPath, io));
    expect(config.roles['operator-general']).toBeDefined();
    expect(config.roles['operator-general']?.description).toContain('custom role');
    // The default roles still ship alongside the custom one.
    expect(config.roles.admin).toBeDefined();
  });

  it('re-prompts on an invalid admin name and keeps going', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO([
      '',
      'Ship',
      '',
      // invalid name — rejected
      'has spaces',
      // valid name
      'chief',
      '',
      '',
      code,
    ]);
    const config = await runFirstRunWizard(wizardOpts(configPath, io));
    expect(config.store.findByName('chief')).toBeTruthy();
    // Re-prompt emitted a helpful message.
    expect(io.output.some((l) => l.includes('alphanumeric with . _ -'))).toBe(true);
  });

  it('re-prompts on a bad TOTP code and succeeds on retry', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO([
      '',
      'Ship',
      '',
      '',
      '',
      '',
      // first attempt — wrong code
      '000000',
      // second attempt — correct
      code,
    ]);
    const config = await runFirstRunWizard(wizardOpts(configPath, io));
    expect(config.store.size()).toBe(1);
    expect(io.output.some((l) => l.includes('try again'))).toBe(true);
  });

  it('aborts with UserLoadError after repeated bad TOTP codes', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([
      '',
      'Ship',
      '',
      '',
      '',
      '',
      '000000',
      '111111',
      '222222',
    ]);
    await expect(runFirstRunWizard(wizardOpts(configPath, io))).rejects.toBeInstanceOf(
      UserLoadError,
    );
  });

  it('throws UserLoadError when the IO is non-interactive', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([], false);
    await expect(runFirstRunWizard(wizardOpts(configPath, io))).rejects.toMatchObject({
      name: 'UserLoadError',
      message: expect.stringContaining('not a TTY'),
    });
  });

  it('reloads the written config and resolves the plaintext token', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(['', 'Ship', '', '', '', '', code]);
    await runFirstRunWizard(wizardOpts(configPath, io));

    const reloaded = loadTeamConfigFromFile(configPath);
    const resolved = reloaded.store.resolve('ac7_test_fixed_token');
    expect(resolved).toBeTruthy();
    expect(resolved?.userType).toBe('admin');

    // And the on-disk JSON shape: `users:` top-level array, single entry.
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      users: Array<{ name: string; userType: string }>;
    };
    expect(raw.users).toHaveLength(1);
    expect(raw.users[0]?.userType).toBe('admin');
  });
});
