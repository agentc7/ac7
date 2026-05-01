/**
 * `runServer` wiring contract — end-to-end regression for the
 * persistMembers gate.
 *
 * The published `ac7 serve` CLI shipped a wiring bug where it called
 * `runServer({...})` without `configPath`, which silently disabled
 * the `persistMembers` hook. With persistMembers undefined, every
 * member-mutation endpoint short-circuited with 501 Not Implemented
 * — including the "create new member" branch of `/enroll/approve`,
 * which is what the web UI calls during enrollment approval.
 *
 * The CLI-side unit test for `buildServeRunOptions` (in
 * `packages/cli/test/commands/serve.test.ts`) pins the option
 * construction. This file pins the OTHER side of the contract:
 * `runServer({ configPath })` actually produces a server that
 * accepts member mutations, and `runServer({})` (no configPath)
 * still rejects them with 501. If either invariant flips, this
 * test fails.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemberStore, defaultHttpsConfig } from '../src/members.js';
import { type RunningServer, runServer } from '../src/run.js';

const ADMIN_TOKEN = 'ac7_run_wiring_test_admin_token';

const TEAM = {
  name: 'demo-team',
  directive: 'Verify run.ts wiring.',
  brief: '',
  permissionPresets: {},
};

const dirsToClean: string[] = [];
const serversToStop: RunningServer[] = [];

afterEach(async () => {
  for (const s of serversToStop.splice(0)) {
    await s.stop();
  }
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac7-run-wiring-'));
  dirsToClean.push(dir);
  return dir;
}

function makeMembers() {
  return createMemberStore([
    {
      name: 'alice',
      role: { title: 'admin', description: '' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
    },
  ]);
}

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function bootHttp(opts: { configPath?: string; configDir?: string }): Promise<RunningServer> {
  const dir = opts.configDir ?? tmpDir();
  const running = await runServer({
    members: makeMembers(),
    team: TEAM,
    https: { ...defaultHttpsConfig(), mode: 'off' },
    // null + configPath → runServer auto-generates VAPID keys; null
    // alone → Web Push stays off. Either is fine for this test.
    webPush: null,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.configPath !== undefined ? { configDir: dir } : {}),
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    publicRoot: null,
    logger: silentLogger(),
  });
  serversToStop.push(running);
  return running;
}

function seedConfigFile(dir: string): string {
  const configPath = join(dir, 'ac7.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      team: TEAM,
      members: [
        {
          name: 'alice',
          role: { title: 'admin', description: '' },
          permissions: ['members.manage'],
          // Hash of ADMIN_TOKEN — but we don't actually use the
          // file's auth path here; we re-hash the live token via
          // createMemberStore in bootHttp(). The file just needs to
          // exist so persistMemberStore has something to rewrite.
          tokenHash: `sha256:${'a'.repeat(64)}`,
        },
      ],
    }),
  );
  return configPath;
}

async function postMember(running: RunningServer, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${running.port}/members`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('runServer member mutation gate', () => {
  it('200s POST /members when configPath is wired (regression for `ac7 serve` bug)', async () => {
    const dir = tmpDir();
    const configPath = seedConfigFile(dir);
    const running = await bootHttp({ configPath, configDir: dir });

    const res = await postMember(running, {
      name: 'newbie',
      role: { title: 'engineer', description: '' },
      permissions: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^ac7_/);
  });

  it('501s POST /members when configPath is omitted (the failure mode)', async () => {
    const running = await bootHttp({});

    const res = await postMember(running, {
      name: 'newbie',
      role: { title: 'engineer', description: '' },
      permissions: [],
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('persistMembers');
  });
});
