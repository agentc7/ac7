/**
 * Claude Code adapter unit tests.
 *
 * Covers the `.mcp.json` backup/restore contract for prepareMcpConfig:
 *
 *   - Fresh creation when the file was absent
 *   - Merge into an existing file, preserving other top-level keys and
 *     other mcpServers entries
 *   - Restore paths for all three "existed before" states:
 *       (a) file didn't exist      → restore deletes it
 *       (b) file existed, no ac7    → restore rewrites original bytes
 *       (c) file had a stale ac7    → restore rewrites original bytes
 *   - Refusal to modify when the existing file is corrupt JSON
 *   - Restore is idempotent — calling it twice is a no-op on the second
 *
 * Every test uses a fresh tmpdir so they don't stomp each other and
 * tests never touch the repo's real `.mcp.json`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeCodeAdapterError,
  prepareClaudeSettings,
  prepareMcpConfig,
} from '../../src/runtime/agents/claude-code.js';

describe('prepareMcpConfig', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ac7-adapter-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates a fresh .mcp.json when none existed, then restore deletes it', () => {
    const configPath = join(cwd, '.mcp.json');
    expect(existsSync(configPath)).toBe(false);

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/fake-runner.sock',
    });

    expect(handle.path).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written.mcpServers.ac7).toEqual({
      command: 'ac7',
      args: ['mcp-bridge'],
      env: { AC7_RUNNER_SOCKET: '/tmp/fake-runner.sock' },
    });

    handle.restore();
    expect(existsSync(configPath)).toBe(false);
  });

  it('merges into an existing file and preserves other entries + top-level keys', () => {
    const configPath = join(cwd, '.mcp.json');
    const original = {
      hooks: { preToolUse: 'echo hi' },
      mcpServers: {
        other: {
          command: 'node',
          args: ['some-other-mcp.js'],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), 'utf8');

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/fake.sock',
      bridgeCommand: '/abs/path/to/cli.js',
      bridgeArgs: ['mcp-bridge', '--trace'],
      extraEnv: { ALL_PROXY: 'socks5://127.0.0.1:9050' },
    });

    const merged = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(merged.hooks).toEqual({ preToolUse: 'echo hi' });
    expect(merged.mcpServers.other).toEqual({
      command: 'node',
      args: ['some-other-mcp.js'],
    });
    expect(merged.mcpServers.ac7).toEqual({
      command: '/abs/path/to/cli.js',
      args: ['mcp-bridge', '--trace'],
      env: {
        AC7_RUNNER_SOCKET: '/tmp/fake.sock',
        ALL_PROXY: 'socks5://127.0.0.1:9050',
      },
    });

    handle.restore();
    const afterRestore = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(afterRestore).toEqual(original);
  });

  it('replaces a stale ac7 entry and restores the original on teardown', () => {
    const configPath = join(cwd, '.mcp.json');
    const original = {
      mcpServers: {
        ac7: {
          command: 'ac7',
          args: ['mcp-bridge'],
          env: { AC7_RUNNER_SOCKET: '/tmp/OLD.sock' },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2), 'utf8');

    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/NEW.sock',
    });

    const merged = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(merged.mcpServers.ac7.env.AC7_RUNNER_SOCKET).toBe('/tmp/NEW.sock');

    handle.restore();
    const afterRestore = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(afterRestore).toEqual(original);
  });

  it('refuses to modify a corrupt .mcp.json and leaves the file untouched', () => {
    const configPath = join(cwd, '.mcp.json');
    const corrupt = '{ "mcpServers": { not valid json';
    writeFileSync(configPath, corrupt, 'utf8');

    expect(() =>
      prepareMcpConfig({
        cwd,
        runnerSocketPath: '/tmp/x.sock',
      }),
    ).toThrow(ClaudeCodeAdapterError);

    expect(readFileSync(configPath, 'utf8')).toBe(corrupt);
  });

  it('refuses to modify when top-level is not an object (e.g. array)', () => {
    const configPath = join(cwd, '.mcp.json');
    const arrayJson = '[1, 2, 3]';
    writeFileSync(configPath, arrayJson, 'utf8');

    expect(() =>
      prepareMcpConfig({
        cwd,
        runnerSocketPath: '/tmp/x.sock',
      }),
    ).toThrow(ClaudeCodeAdapterError);

    expect(readFileSync(configPath, 'utf8')).toBe(arrayJson);
  });

  it('restore is idempotent — second call is a no-op', () => {
    const configPath = join(cwd, '.mcp.json');
    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/x.sock',
    });
    expect(existsSync(configPath)).toBe(true);

    handle.restore();
    expect(existsSync(configPath)).toBe(false);

    // Recreate a different file at the same path — restore should NOT
    // touch it, since we've already restored once.
    writeFileSync(configPath, '{"unrelated":true}', 'utf8');
    handle.restore();
    expect(readFileSync(configPath, 'utf8')).toBe('{"unrelated":true}');
  });

  it('injects default bridge command + args when options omit them', () => {
    const handle = prepareMcpConfig({
      cwd,
      runnerSocketPath: '/tmp/defaults.sock',
    });
    const merged = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    expect(merged.mcpServers.ac7.command).toBe('ac7');
    expect(merged.mcpServers.ac7.args).toEqual(['mcp-bridge']);
    handle.restore();
  });
});

describe('prepareClaudeSettings', () => {
  let cwd: string;
  const hookUrl = 'http://127.0.0.1:55555/hook/tool-event';

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ac7-claude-settings-test-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates .claude/settings.json when neither dir nor file existed, restore removes both', () => {
    const dirPath = join(cwd, '.claude');
    const settingsPath = join(dirPath, 'settings.json');
    expect(existsSync(dirPath)).toBe(false);

    const handle = prepareClaudeSettings({ cwd, hookUrl });

    expect(handle.path).toBe(settingsPath);
    expect(existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      const matchers = written.hooks[event];
      expect(Array.isArray(matchers)).toBe(true);
      const ac7 = matchers
        .flatMap((m: { hooks: unknown[] }) => m.hooks)
        .find(
          (h: Record<string, unknown>) =>
            h.type === 'http' && h.url === hookUrl && h.x_ac7_busy_feeder === true,
        );
      expect(ac7).toBeTruthy();
    }

    handle.restore();
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(dirPath)).toBe(false);
  });

  it('merges into existing settings.json while preserving other keys + other hooks', () => {
    const dirPath = join(cwd, '.claude');
    const settingsPath = join(dirPath, 'settings.json');
    // Pre-existing user config: a Stop hook AND an unrelated top-level key.
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'notify-send done' }] }],
        },
      }),
    );

    const handle = prepareClaudeSettings({ cwd, hookUrl });
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8'));

    // Unrelated top-level key preserved.
    expect(merged.permissions).toEqual({ allow: ['Bash'] });
    // User's Stop hook preserved verbatim.
    expect(merged.hooks.Stop).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'notify-send done' }] },
    ]);
    // Our PreToolUse hook injected.
    expect(merged.hooks.PreToolUse).toBeTruthy();
    const preToolEntries = merged.hooks.PreToolUse.flatMap((m: { hooks: unknown[] }) => m.hooks);
    expect(preToolEntries).toContainEqual({
      type: 'http',
      url: hookUrl,
      x_ac7_busy_feeder: true,
    });

    handle.restore();
    // Restore writes the original bytes back — Stop hook still there,
    // our PreToolUse gone.
    const restored = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(restored.hooks.PreToolUse).toBeUndefined();
    expect(restored.hooks.Stop).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: 'notify-send done' }] },
    ]);
    expect(restored.permissions).toEqual({ allow: ['Bash'] });
  });

  it('drops a stale ac7 hook entry from a previous crash before injecting fresh ones', () => {
    const dirPath = join(cwd, '.claude');
    const settingsPath = join(dirPath, 'settings.json');
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    // Simulate a previous run that crashed mid-restore, leaving a
    // stale ac7 entry behind. Our prepare should NOT duplicate it.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                { type: 'http', url: 'http://stale.local/hook', x_ac7_busy_feeder: true },
                { type: 'command', command: 'audit-log' },
              ],
            },
          ],
        },
      }),
    );

    const handle = prepareClaudeSettings({ cwd, hookUrl });
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const entries = merged.hooks.PreToolUse.flatMap(
      (m: { hooks: Record<string, unknown>[] }) => m.hooks,
    );
    // Stale ac7 entry gone.
    expect(
      entries.filter((e: Record<string, unknown>) => e.url === 'http://stale.local/hook'),
    ).toHaveLength(0);
    // User's unrelated audit-log hook preserved.
    expect(entries.find((e: Record<string, unknown>) => e.command === 'audit-log')).toBeTruthy();
    // Fresh ac7 entry pointing at the current hook URL.
    expect(entries.find((e: Record<string, unknown>) => e.url === hookUrl)).toBeTruthy();
    handle.restore();
  });

  it('refuses to modify when existing settings.json is not valid JSON', () => {
    const dirPath = join(cwd, '.claude');
    const settingsPath = join(dirPath, 'settings.json');
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    writeFileSync(settingsPath, 'not-json');
    expect(() => prepareClaudeSettings({ cwd, hookUrl })).toThrow(ClaudeCodeAdapterError);
    // Original file untouched.
    expect(readFileSync(settingsPath, 'utf8')).toBe('not-json');
  });

  it('restore() is idempotent — second call is a no-op', () => {
    const handle = prepareClaudeSettings({ cwd, hookUrl });
    handle.restore();
    expect(() => handle.restore()).not.toThrow();
  });

  it('preserves the .claude/ dir on restore if other files live there', () => {
    const dirPath = join(cwd, '.claude');
    require('node:fs').mkdirSync(dirPath, { recursive: true });
    // User had something else in .claude/ but no settings.json yet.
    writeFileSync(join(dirPath, 'agents.md'), '# my agents');
    const handle = prepareClaudeSettings({ cwd, hookUrl });
    handle.restore();
    // Settings file gone, but the .claude/ dir + agents.md stay because
    // the dir existed before our prepare touched it.
    expect(existsSync(join(dirPath, 'settings.json'))).toBe(false);
    expect(existsSync(join(dirPath, 'agents.md'))).toBe(true);
  });
});
