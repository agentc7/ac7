import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeamConfigFromFile, SlotLoadError } from '../src/slots.js';
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

  it('creates a team with a single director slot using defaults', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      // team name (default my-team)
      '',
      // directive (required)
      'Ship the payment service',
      // brief (empty)
      '',
      // slot 1: name (default individual-contributor-1)
      '',
      // slot 1: role (default individual-contributor)
      '',
      // slot 1: authority (default director)
      '',
      // press enter after banner
      '',
      // enable web UI login? (skip for this test)
      'n',
      // add another slot? no
      'n',
    ]);

    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `ac7_test_token_${++tokenCounter}`,
      qrRenderer: () => '',
    });

    expect(config.store.size()).toBe(1);
    const actual = config.store.resolve('ac7_test_token_1');
    expect(actual?.name).toBe('individual-contributor-1');
    expect(actual?.role).toBe('individual-contributor');
    expect(actual?.authority).toBe('director');
    expect(config.team.name).toBe('my-team');
    expect(config.team.directive).toBe('Ship the payment service');
    expect(config.team.brief).toBe('');

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      team: { name: string; directive: string; brief: string };
      roles: Record<string, { description?: string; instructions?: string }>;
      slots: Array<{ name: string; role: string; authority?: string; tokenHash: string }>;
    };
    expect(onDisk.team.name).toBe('my-team');
    expect(onDisk.team.directive).toBe('Ship the payment service');
    expect(onDisk.slots).toHaveLength(1);
    expect(onDisk.slots[0]?.name).toBe('individual-contributor-1');
    expect(onDisk.slots[0]?.role).toBe('individual-contributor');
    expect(onDisk.slots[0]?.authority).toBe('director');
    expect(onDisk.slots[0]?.tokenHash).toMatch(/^sha256:/);

    // All 4 default roles ship with every generated config.
    expect(Object.keys(onDisk.roles).sort()).toEqual([
      'implementer',
      'individual-contributor',
      'reviewer',
      'watcher',
    ]);

    // File can be re-loaded round-trip.
    const reloaded = loadTeamConfigFromFile(configPath);
    const reloadedSlot = reloaded.store.resolve('ac7_test_token_1');
    expect(reloadedSlot?.name).toBe('individual-contributor-1');
    expect(reloadedSlot?.authority).toBe('director');
  });

  it('collects multiple slots with mixed authority tiers', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'alpha-team',
      'ship the payment service',
      'we own the full lifecycle',
      // slot 1 — director (TOTP prompt fires, skip)
      'ACTUAL',
      'individual-contributor',
      '', // default director
      '',
      'n',
      'y',
      // slot 2 — individual-contributor (no TOTP prompt)
      'ALPHA-1',
      'implementer',
      '', // default individual-contributor
      '',
      'no',
    ]);

    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `ac7_test_token_${++tokenCounter}`,
      qrRenderer: () => '',
    });

    expect(config.store.size()).toBe(2);
    expect(config.store.resolve('ac7_test_token_1')?.name).toBe('ACTUAL');
    expect(config.store.resolve('ac7_test_token_1')?.authority).toBe('director');
    expect(config.store.resolve('ac7_test_token_2')?.name).toBe('ALPHA-1');
    expect(config.store.resolve('ac7_test_token_2')?.role).toBe('implementer');
    expect(config.store.resolve('ac7_test_token_2')?.authority).toBe('individual-contributor');
    expect(config.team.name).toBe('alpha-team');
    expect(config.team.brief).toBe('we own the full lifecycle');
  });

  it('accepts manager as an explicit authority', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'alpha-team',
      'directive',
      '',
      // slot 1: director (default)
      'ACTUAL',
      'individual-contributor',
      '',
      '',
      'n',
      'y',
      // slot 2: explicit manager
      'LT-ONE',
      'individual-contributor',
      'manager',
      '',
      // LT gets TOTP prompt — skip
      'n',
      'n',
    ]);
    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `ac7_t_${++tokenCounter}`,
      qrRenderer: () => '',
    });
    expect(config.store.resolve('ac7_t_2')?.authority).toBe('manager');
  });

  it('re-prompts on invalid authority', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([
      'team',
      'hold the line',
      '',
      'ACTUAL',
      'individual-contributor',
      // invalid authority, then valid
      'admin',
      '',
      // press enter after banner
      '',
      'n',
      'n',
    ]);
    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => 'ac7_tok',
      qrRenderer: () => '',
    });
    expect(config.store.size()).toBe(1);
    expect(io.output.some((l) => l.includes('authority must be one of'))).toBe(true);
  });

  it('re-prompts on invalid name and accepts custom roles with a note', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([
      'team',
      'hold the line',
      '',
      // invalid names, then a valid one
      'has spaces',
      'also invalid!',
      'valid-name',
      // custom role — accepted with note, auto-added to config
      'custom-role',
      // director default
      '',
      '',
      // director → TOTP prompt fires, skip
      'n',
      'n',
    ]);

    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => 'ac7_mocked_token',
      qrRenderer: () => '',
    });

    expect(config.store.size()).toBe(1);
    expect(config.store.resolve('ac7_mocked_token')?.name).toBe('valid-name');
    expect(config.store.resolve('ac7_mocked_token')?.role).toBe('custom-role');
    expect(config.roles['custom-role']).toBeDefined();
    expect(io.output.some((l) => l.includes('alphanumeric'))).toBe(true);
    expect(io.output.some((l) => l.includes('custom role'))).toBe(true);

    // Generated config must be loadable — custom role was auto-injected.
    const reloaded = loadTeamConfigFromFile(configPath);
    expect(reloaded.store.resolve('ac7_mocked_token')?.role).toBe('custom-role');
    expect(reloaded.roles['custom-role']).toBeDefined();
  });

  it('rejects role keys with invalid characters', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([
      'team',
      'directive',
      '',
      'ACTUAL',
      // invalid role key (contains space), then valid
      'bad role',
      'individual-contributor',
      // director default
      '',
      '',
      // skip web UI login
      'n',
      // add another slot? no
      'n',
    ]);
    await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => 'ac7_token',
      qrRenderer: () => '',
    });
    expect(io.output.some((l) => l.includes('role must be alphanumeric'))).toBe(true);
  });

  it('rejects duplicate names within the same session', async () => {
    const configPath = tmpConfigPath();
    let tokenCounter = 0;
    const io = mockIO([
      'team',
      'hold the line',
      '',
      'ACTUAL',
      'individual-contributor',
      '', // director
      '',
      'n',
      'y',
      // duplicate → re-prompted
      'ACTUAL',
      'ALPHA-1',
      'implementer',
      '', // individual-contributor
      '',
      'n',
    ]);
    const config = await runFirstRunWizard({
      configPath,
      io,
      tokenFactory: () => `ac7_t_${++tokenCounter}`,
      qrRenderer: () => '',
    });
    expect(config.store.names().sort()).toEqual(['ACTUAL', 'ALPHA-1']);
    expect(io.output.some((l) => l.includes("'ACTUAL' already added"))).toBe(true);
  });

  it('throws SlotLoadError when the IO is not interactive', async () => {
    const configPath = tmpConfigPath();
    const io = mockIO([], false);
    await expect(runFirstRunWizard({ configPath, io, tokenFactory: () => 'tok' })).rejects.toThrow(
      SlotLoadError,
    );
  });

  it('ships all 4 default roles (individual-contributor, implementer, reviewer, watcher)', () => {
    expect(Object.keys(DEFAULT_ROLES).sort()).toEqual([
      'implementer',
      'individual-contributor',
      'reviewer',
      'watcher',
    ]);
  });

  // ── TOTP enrollment ────────────────────────────────────────────────

  describe('TOTP enrollment', () => {
    const FIXED_SECRET = 'JBSWY3DPEHPK3PXP';
    const FIXED_NOW = 1_700_000_000_000;

    function enrollmentOptions(io: WizardIO, configPath: string): RunWizardOptions {
      return {
        configPath,
        io,
        tokenFactory: () => 'ac7_test_token',
        totpSecretFactory: () => FIXED_SECRET,
        now: () => FIXED_NOW,
        qrRenderer: () => '[qr-code]',
      };
    }

    it('enrolls a director slot with a valid code and persists the secret', async () => {
      const configPath = tmpConfigPath();
      const code = currentCode(FIXED_SECRET, FIXED_NOW);
      const io = mockIO([
        '',
        'directive',
        '',
        'ACTUAL',
        'individual-contributor',
        '', // director (default)
        '',
        // enable web UI login? default Y
        'y',
        // enter the 6-digit code
        code,
        // add another slot? no
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('ac7_test_token')?.totpSecret).toBe(FIXED_SECRET);

      const reloaded = loadTeamConfigFromFile(configPath);
      expect(reloaded.store.resolve('ac7_test_token')?.totpSecret).toBe(FIXED_SECRET);
      expect(io.output.some((l) => l.includes('enrollment confirmed for ACTUAL'))).toBe(true);
    });

    it('re-prompts on an incorrect code and accepts the retry', async () => {
      const configPath = tmpConfigPath();
      const code = currentCode(FIXED_SECRET, FIXED_NOW);
      const io = mockIO([
        '',
        'directive',
        '',
        'ACTUAL',
        'individual-contributor',
        '', // director
        '',
        'y',
        '000000',
        code,
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('ac7_test_token')?.totpSecret).toBe(FIXED_SECRET);
      expect(io.output.some((l) => l.includes('that code is incorrect'))).toBe(true);
    });

    it('skips enrollment when the user answers n at the prompt', async () => {
      const configPath = tmpConfigPath();
      const io = mockIO([
        '',
        'directive',
        '',
        'ACTUAL',
        'individual-contributor',
        '',
        '',
        'n',
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('ac7_test_token')?.totpSecret).toBeFalsy();
      expect(io.output.some((l) => l.includes('ac7 enroll --slot ACTUAL'))).toBe(true);
    });

    it('bails after too many bad codes without persisting a secret', async () => {
      const configPath = tmpConfigPath();
      const io = mockIO([
        '',
        'directive',
        '',
        'ACTUAL',
        'individual-contributor',
        '',
        '',
        'y',
        '000000',
        '111111',
        '222222',
        'n',
      ]);
      const config = await runFirstRunWizard(enrollmentOptions(io, configPath));
      expect(config.store.resolve('ac7_test_token')?.totpSecret).toBeFalsy();
      expect(io.output.some((l) => l.includes('too many bad attempts'))).toBe(true);
    });

    it('does NOT prompt TOTP for plain-individual-contributor-authority slots', async () => {
      // The scenario: a single slot that the user explicitly marks as
      // individual-contributor authority. Since at least one director is required,
      // the wizard rejects the config at write time — but the point of
      // this test is just that the TOTP prompt never fires. We catch
      // the SlotLoadError at the end.
      const configPath = tmpConfigPath();
      const io = mockIO([
        '',
        'directive',
        '',
        'ACTUAL',
        'individual-contributor',
        'individual-contributor', // explicitly downgrade authority
        '',
        // no TOTP prompt — go straight to "add another slot?"
        'n',
      ]);
      await expect(runFirstRunWizard(enrollmentOptions(io, configPath))).rejects.toThrow(
        /at least one slot must have authority=director/,
      );
      // If the TOTP prompt had fired, the queue would exhaust before
      // we got to the "no director" check.
      expect(io.output.every((l) => !l.includes('enable web UI login'))).toBe(true);
    });
  });
});
