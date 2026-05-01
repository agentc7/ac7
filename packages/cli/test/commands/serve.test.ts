/**
 * Tests for `ac7 serve` option construction.
 *
 * Regression for the seam-class bug where `serve.ts` constructed a
 * `runServer` options bag without `configPath` (and other TeamConfig
 * fields), causing every member-mutation endpoint — including the
 * "create new member" branch of `/enroll/approve` that the web UI
 * hits during enrollment approval — to short-circuit with 501.
 *
 * The unit checks here pin the option-construction contract; an
 * end-to-end integration check lives in the server suite at
 * `apps/server/test/serve-wiring.test.ts` and asserts the wired
 * options actually produce a working server.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServeRunOptions, runServeCommand } from '../../src/commands/serve.js';

async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const TEAM = {
  name: 'demo',
  directive: 'ship',
  brief: '',
  permissionPresets: {},
};

const HTTPS = {
  mode: 'off' as const,
  bindHttp: 8717,
  bindHttps: 7443,
  redirectHttpToHttps: true,
  hsts: 'auto' as const,
  selfSigned: { lanIp: null, validityDays: 365, regenerateIfExpiringWithin: 30 },
  custom: { certPath: null, keyPath: null },
};

const STORE_STUB = {
  members: () => [],
  size: () => 0,
  names: () => [],
} as unknown as Parameters<typeof buildServeRunOptions>[0]['config']['store'];

function baseConfig(overrides: Partial<Parameters<typeof buildServeRunOptions>[0]['config']> = {}) {
  return {
    team: TEAM,
    store: STORE_STUB,
    https: HTTPS,
    webPush: null,
    files: null,
    jwt: null,
    migrated: 0,
    ...overrides,
  };
}

describe('buildServeRunOptions — must thread configPath et al', () => {
  it('forwards configPath verbatim so persistMembers wires up', () => {
    const opts = buildServeRunOptions({
      config: baseConfig(),
      configPath: '/tmp/whatever/ac7.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    // The bug: configPath was being dropped here. Without it,
    // runServer skips the persistMembers hook and every member-
    // mutation endpoint returns 501.
    expect(opts.configPath).toBe('/tmp/whatever/ac7.json');
  });

  it('derives configDir from configPath', () => {
    const opts = buildServeRunOptions({
      config: baseConfig(),
      configPath: '/etc/ac7/team.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(opts.configDir).toBe('/etc/ac7');
  });

  it('forwards https config (the loaded https block, not undefined)', () => {
    const opts = buildServeRunOptions({
      config: baseConfig({ https: { ...HTTPS, mode: 'self-signed' } }),
      configPath: '/x/ac7.json',
      port: 8717,
      host: '0.0.0.0',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(opts.https?.mode).toBe('self-signed');
  });

  it('forwards webPush only when present (omits the field on null)', () => {
    const omitted = buildServeRunOptions({
      config: baseConfig({ webPush: null }),
      configPath: '/x/ac7.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    // Note: webPush=null AND configPath set means runServer will
    // auto-generate VAPID keys on first boot. Omitting the field
    // entirely would skip that auto-gen path, which is wrong. The
    // helper must not pass webPush:null to the bag — the absence
    // signals "let runServer decide."
    expect('webPush' in omitted).toBe(false);

    const wired = buildServeRunOptions({
      config: baseConfig({
        webPush: {
          vapidPublicKey: 'pub',
          vapidPrivateKey: 'priv',
          vapidSubject: 'mailto:x@y',
        },
      }),
      configPath: '/x/ac7.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(wired.webPush?.vapidPublicKey).toBe('pub');
  });

  it('forwards jwt only when present', () => {
    const omitted = buildServeRunOptions({
      config: baseConfig({ jwt: null }),
      configPath: '/x/ac7.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect('jwt' in omitted).toBe(false);

    const wired = buildServeRunOptions({
      config: baseConfig({
        jwt: {
          issuer: 'https://issuer.test',
          jwksUrl: 'https://issuer.test/.well-known/jwks.json',
          audience: 'team:demo',
        },
      }),
      configPath: '/x/ac7.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(wired.jwt?.issuer).toBe('https://issuer.test');
  });

  it('forwards filesRoot + maxFileSize from config.files when present', () => {
    const opts = buildServeRunOptions({
      config: baseConfig({
        files: { root: '/var/ac7/files', maxFileSize: 12345 },
      }),
      configPath: '/x/ac7.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(opts.filesRoot).toBe('/var/ac7/files');
    expect(opts.maxFileSize).toBe(12345);
  });

  it('omits filesRoot + maxFileSize when files is null', () => {
    const opts = buildServeRunOptions({
      config: baseConfig({ files: null }),
      configPath: '/x/ac7.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect('filesRoot' in opts).toBe(false);
    expect('maxFileSize' in opts).toBe(false);
  });

  it('does not pass through filesRoot/maxFileSize when files config has only one set', () => {
    const opts = buildServeRunOptions({
      config: baseConfig({ files: { root: '/x', maxFileSize: undefined } as never }),
      configPath: '/x/ac7.json',
      port: 8717,
      host: '127.0.0.1',
      dbPath: ':memory:',
      onListen: () => {},
    });
    expect(opts.filesRoot).toBe('/x');
    expect('maxFileSize' in opts).toBe(false);
  });

  it('passes through port, host, dbPath, members, team, onListen', () => {
    const onListen = () => {};
    const opts = buildServeRunOptions({
      config: baseConfig(),
      configPath: '/x/ac7.json',
      port: 9001,
      host: '0.0.0.0',
      dbPath: '/tmp/ac7.db',
      onListen,
    });
    expect(opts.port).toBe(9001);
    expect(opts.host).toBe('0.0.0.0');
    expect(opts.dbPath).toBe('/tmp/ac7.db');
    expect(opts.members).toBe(STORE_STUB);
    expect(opts.team).toBe(TEAM);
    expect(opts.onListen).toBe(onListen);
  });
});

// ─── end-to-end: runServeCommand → real server → POST /members ────

const dirsToClean: string[] = [];

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpServeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac7-serve-e2e-'));
  dirsToClean.push(dir);
  return dir;
}

const ADMIN_TOKEN = 'ac7_serve_e2e_admin_token';

function seedConfig(dir: string): string {
  const configPath = join(dir, 'ac7.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      team: {
        name: 'demo',
        directive: 'ship',
        brief: '',
        permissionPresets: {},
      },
      members: [
        {
          name: 'alice',
          role: { title: 'admin', description: '' },
          permissions: ['members.manage'],
          // Real plaintext token — `loadTeamConfigFromFile` accepts
          // the `token` field on first load and replaces it with
          // `tokenHash` on disk, so we can authenticate live.
          token: ADMIN_TOKEN,
        },
      ],
    }),
  );
  return configPath;
}

describe('runServeCommand → live server (regression for the published-CLI bug)', () => {
  it('boots and accepts POST /members — fails 501 before the configPath fix', async () => {
    const dir = tmpServeDir();
    const configPath = seedConfig(dir);
    const port = await pickFreePort();
    const running = await runServeCommand(
      {
        configPath,
        port,
        host: '127.0.0.1',
        dbPath: ':memory:',
      },
      () => {},
    );
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/members`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'newbie',
          role: { title: 'engineer', description: '' },
          permissions: [],
        }),
      });
      // The bug shipped: this used to return 501 "member creation is
      // not available (persistMembers missing)". After the fix:
      // serve.ts threads configPath → runServer wires persistMembers
      // → POST /members works.
      expect(res.status).toBe(200);
    } finally {
      await running.stop();
    }
  }, 15_000);
});
