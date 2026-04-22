/**
 * First-run wizard tests.
 *
 * The wizard collects a team + first admin member, auto-enrolls the
 * admin in TOTP, and writes the config. Tests stub stdin with a
 * scripted queue so each test drives the exact sequence of prompts
 * the wizard asks, and pin the TOTP secret + clock so verification
 * is deterministic.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeamConfigFromFile, MemberLoadError } from '../src/members.js';
import { currentCode } from '../src/totp.js';
import { type RunWizardOptions, runFirstRunWizard, type WizardIO } from '../src/wizard.js';

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

/** Deterministic TOTP secret + clock pair for reproducible code verification. */
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

  // Happy-path script: team name (default), directive, brief (skip),
  // admin name (default), role title (default), role description (skip),
  // press enter after token banner, TOTP code.
  function happyScript(code: string, overrides: Partial<Record<string, string>> = {}): string[] {
    return [
      overrides.teamName ?? '',
      overrides.directive ?? 'Ship the payment service',
      overrides.brief ?? '',
      overrides.adminName ?? '',
      overrides.roleTitle ?? '',
      overrides.roleDescription ?? '',
      '',
      code,
    ];
  }

  it('creates a team + first admin and writes a loadable config', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(happyScript(code));

    const config = await runFirstRunWizard(wizardOpts(configPath, io));

    expect(config.team.name).toBe('my-team');
    expect(config.team.directive).toBe('Ship the payment service');
    expect(config.team.brief).toBe('');
    expect(config.team.permissionPresets).toBeDefined();
    expect(config.store.size()).toBe(1);
    expect(config.store.hasAdmin()).toBe(true);

    const admin = config.store.findByName('director-1');
    expect(admin).toBeTruthy();
    expect(admin?.permissions).toContain('members.manage');
    expect(admin?.role.title).toBe('director');
    expect(admin?.totpSecret).toBe(FIXED_TOTP_SECRET);
    expect(admin?.totpLastCounter).toBe(0);

    // On-disk config loads cleanly and still resolves via the token.
    const reloaded = loadTeamConfigFromFile(configPath);
    expect(reloaded.store.size()).toBe(1);
    const resolved = reloaded.store.resolve('ac7_test_fixed_token');
    expect(resolved?.name).toBe('director-1');
    expect(resolved?.permissions).toContain('members.manage');

    expect(io.remaining()).toBe(0);
  });

  it('ships admin + operator permission presets in the generated config', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(happyScript(code));
    const config = await runFirstRunWizard(wizardOpts(configPath, io));

    expect(config.team.permissionPresets.admin).toBeDefined();
    expect(config.team.permissionPresets.admin).toContain('members.manage');
    expect(config.team.permissionPresets.operator).toContain('objectives.create');
  });

  it('accepts a custom admin role title', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(happyScript(code, { roleTitle: 'chief', roleDescription: 'Runs the ship' }));
    const config = await runFirstRunWizard(wizardOpts(configPath, io));

    const admin = config.store.findByName('director-1');
    expect(admin?.role.title).toBe('chief');
    expect(admin?.role.description).toBe('Runs the ship');
  });

  it('re-prompts on an invalid admin name and keeps going', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO([
      '', // team name
      'Ship', // directive
      '', // brief
      'has spaces', // bad name, rejected
      'chief', // good name
      '', // role title (default)
      '', // role description (skip)
      '',
      code,
    ]);
    const config = await runFirstRunWizard(wizardOpts(configPath, io));
    expect(config.store.findByName('chief')).toBeTruthy();
    expect(io.output.some((l) => l.includes('alphanumeric with . _ -'))).toBe(true);
  });

  it('re-prompts on a bad TOTP code and succeeds on retry', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO([...happyScript('000000'), code]);
    const config = await runFirstRunWizard(wizardOpts(configPath, io));
    expect(config.store.size()).toBe(1);
    expect(io.output.some((l) => l.includes('try again'))).toBe(true);
  });

  it('aborts with MemberLoadError after repeated bad TOTP codes', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([...happyScript('000000'), '111111', '222222']);
    await expect(runFirstRunWizard(wizardOpts(configPath, io))).rejects.toBeInstanceOf(
      MemberLoadError,
    );
  });

  it('throws MemberLoadError when the IO is non-interactive', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([], false);
    await expect(runFirstRunWizard(wizardOpts(configPath, io))).rejects.toMatchObject({
      name: 'MemberLoadError',
      message: expect.stringContaining('not a TTY'),
    });
  });

  it('reloads the written config and resolves the plaintext token', async () => {
    const configPath = tmpConfigPath();
    const code = currentCode(FIXED_TOTP_SECRET, FIXED_NOW_MS);
    const io = mockIO(happyScript(code));
    await runFirstRunWizard(wizardOpts(configPath, io));

    const reloaded = loadTeamConfigFromFile(configPath);
    const resolved = reloaded.store.resolve('ac7_test_fixed_token');
    expect(resolved).toBeTruthy();
    expect(resolved?.permissions).toContain('members.manage');

    // And the on-disk JSON shape: `members:` top-level array, single entry.
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      members: Array<{ name: string; permissions: string[] }>;
    };
    expect(raw.members).toHaveLength(1);
    expect(raw.members[0]?.permissions).toContain('admin');
  });
});
