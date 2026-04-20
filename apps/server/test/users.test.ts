/**
 * End-to-end tests for the `/users/*` admin CRUD surface.
 *
 * Every test wires a fresh in-memory SQLite + stub `persistUsers`
 * through `createApp` so the full auth + schema + in-memory mutation
 * path runs. `persistUsers` is a vi.fn() so we can assert it fires
 * exactly once per successful mutation and never on 4xx/5xx.
 */

import { Broker, InMemoryEventLog } from '@agentc7/core';
import type { Role, Team, Teammate } from '@agentc7/sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { SessionStore } from '../src/sessions.js';
import { createUserStore } from '../src/slots.js';

const ADMIN_TOKEN = 'ac7_users_test_admin_token';
const OPERATOR_TOKEN = 'ac7_users_test_operator_token';
const AGENT_TOKEN = 'ac7_users_test_agent_token';

const TEAM: Team = {
  name: 'users-team',
  directive: 'Exercise user CRUD.',
  brief: '',
};

const ROLES: Record<string, Role> = {
  admin: { description: '', instructions: '' },
  worker: { description: '', instructions: '' },
  reviewer: { description: '', instructions: '' },
};

interface Harness {
  app: ReturnType<typeof createApp>;
  persistUsers: ReturnType<typeof vi.fn>;
  broker: Broker;
}

function makeApp(): Harness {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const slots = createUserStore([
    { name: 'alice', role: 'admin', userType: 'admin', token: ADMIN_TOKEN },
    { name: 'bob', role: 'worker', userType: 'operator', token: OPERATOR_TOKEN },
    { name: 'scout', role: 'worker', userType: 'agent', token: AGENT_TOKEN },
  ]);
  broker.seedUsers(slots.slots());
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const persistUsers = vi.fn();
  const app = createApp({
    broker,
    slots,
    sessions,
    team: TEAM,
    roles: ROLES,
    version: '0.0.0',
    persistUsers,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, persistUsers, broker };
}

function authed(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /users', () => {
  it('is dual-auth — any authenticated user can read the teammate list', async () => {
    const { app } = makeApp();
    const agentRes = await app.request('/users', { headers: authed(AGENT_TOKEN) });
    expect(agentRes.status).toBe(200);
    const body = (await agentRes.json()) as { users: Teammate[] };
    expect(body.users.map((u) => u.name).sort()).toEqual(['alice', 'bob', 'scout']);
    expect(body.users.find((u) => u.name === 'alice')?.userType).toBe('admin');
    expect(body.users.find((u) => u.name === 'scout')?.userType).toBe('agent');
  });

  it('401s without auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/users');
    expect(res.status).toBe(401);
  });
});

describe('POST /users', () => {
  it('creates a user and returns the plaintext token (admin only)', async () => {
    const { app, persistUsers, broker } = makeApp();
    const res = await app.request('/users', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'newbie', role: 'worker', userType: 'agent' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: Teammate;
      token: string;
      totpSecret?: string;
      totpUri?: string;
    };
    expect(body.user).toEqual({ name: 'newbie', role: 'worker', userType: 'agent' });
    expect(body.token).toMatch(/^ac7_/);
    // Agents don't get TOTP.
    expect(body.totpSecret).toBeUndefined();
    expect(body.totpUri).toBeUndefined();
    expect(persistUsers).toHaveBeenCalledTimes(1);
    // Roster reflects the new user immediately (no restart needed).
    expect(broker.hasUser('newbie')).toBe(true);
  });

  it('returns TOTP secret + uri for human user types', async () => {
    const { app } = makeApp();
    const res = await app.request('/users', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cara', role: 'admin', userType: 'operator' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: Teammate;
      token: string;
      totpSecret?: string;
      totpUri?: string;
    };
    expect(body.totpSecret).toBeDefined();
    expect(body.totpSecret).toMatch(/^[A-Z2-7]+$/);
    expect(body.totpUri).toMatch(/^otpauth:\/\//);
    expect(body.totpUri).toContain('cara');
    expect(body.totpUri).toContain('ac7-users-team');
  });

  it('403s for a non-admin caller', async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users', {
      method: 'POST',
      headers: { ...authed(OPERATOR_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', role: 'worker', userType: 'agent' }),
    });
    expect(res.status).toBe(403);
    expect(persistUsers).not.toHaveBeenCalled();
  });

  it('409s on duplicate name', async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob', role: 'worker', userType: 'agent' }),
    });
    expect(res.status).toBe(409);
    expect(persistUsers).not.toHaveBeenCalled();
  });

  it('400s on an unknown role', async () => {
    const { app } = makeApp();
    const res = await app.request('/users', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', role: 'phantom', userType: 'agent' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('400s on schema-invalid payload', async () => {
    const { app } = makeApp();
    const res = await app.request('/users', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'has spaces', role: 'worker', userType: 'agent' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /users/:name', () => {
  it('updates userType and role for an existing user (admin only)', async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users/scout', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userType: 'lead-agent', role: 'reviewer' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Teammate;
    expect(body).toEqual({ name: 'scout', role: 'reviewer', userType: 'lead-agent' });
    expect(persistUsers).toHaveBeenCalledTimes(1);
  });

  it('refuses to demote the last admin', async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users/alice', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userType: 'operator' }),
    });
    expect(res.status).toBe(409);
    expect(persistUsers).not.toHaveBeenCalled();
  });

  it('allows demoting an admin when another admin remains', async () => {
    const { app, persistUsers } = makeApp();
    await app.request('/users', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'second-admin', role: 'admin', userType: 'admin' }),
    });
    const res = await app.request('/users/alice', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userType: 'operator' }),
    });
    expect(res.status).toBe(200);
    // 1 create + 1 patch.
    expect(persistUsers).toHaveBeenCalledTimes(2);
  });

  it('403s for non-admin callers', async () => {
    const { app } = makeApp();
    const res = await app.request('/users/scout', {
      method: 'PATCH',
      headers: { ...authed(OPERATOR_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userType: 'operator' }),
    });
    expect(res.status).toBe(403);
  });

  it('404s on unknown user', async () => {
    const { app } = makeApp();
    const res = await app.request('/users/ghost', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userType: 'agent' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /users/:name', () => {
  it('deletes an existing non-admin user', async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users/scout', {
      method: 'DELETE',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(204);
    expect(persistUsers).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete the last admin', async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users/alice', {
      method: 'DELETE',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(409);
    expect(persistUsers).not.toHaveBeenCalled();
  });

  it('403s for non-admin callers', async () => {
    const { app } = makeApp();
    const res = await app.request('/users/scout', {
      method: 'DELETE',
      headers: authed(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /users/:name/rotate-token', () => {
  it("admin rotates another user's token and the old token stops resolving", async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users/scout/rotate-token', {
      method: 'POST',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^ac7_/);
    expect(persistUsers).toHaveBeenCalledTimes(1);

    // Old token is invalidated — scout can no longer authenticate with it.
    const stale = await app.request('/briefing', { headers: authed(AGENT_TOKEN) });
    expect(stale.status).toBe(401);

    // New token works.
    const fresh = await app.request('/briefing', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(fresh.status).toBe(200);
  });

  it('self can rotate their own token', async () => {
    const { app } = makeApp();
    const res = await app.request('/users/bob/rotate-token', {
      method: 'POST',
      headers: authed(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(200);
  });

  it('403s when a non-admin tries to rotate someone else', async () => {
    const { app } = makeApp();
    const res = await app.request('/users/scout/rotate-token', {
      method: 'POST',
      headers: authed(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /users/:name/enroll-totp', () => {
  it('admin enrolls a human user and returns the new secret + uri', async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users/bob/enroll-totp', {
      method: 'POST',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totpSecret: string; totpUri: string };
    expect(body.totpSecret).toMatch(/^[A-Z2-7]+$/);
    expect(body.totpUri).toMatch(/^otpauth:\/\//);
    expect(persistUsers).toHaveBeenCalledTimes(1);
  });

  it('409s when enrolling an agent', async () => {
    const { app, persistUsers } = makeApp();
    const res = await app.request('/users/scout/enroll-totp', {
      method: 'POST',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(409);
    expect(persistUsers).not.toHaveBeenCalled();
  });

  it('self can enroll themselves (when human)', async () => {
    const { app } = makeApp();
    const res = await app.request('/users/bob/enroll-totp', {
      method: 'POST',
      headers: authed(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(200);
  });
});

describe('persistUsers omitted', () => {
  it('all mutation endpoints 501 when persistUsers is not wired', async () => {
    const broker = new Broker({
      eventLog: new InMemoryEventLog(),
      now: () => 1_700_000_000_000,
      idFactory: () => 'msg-fixed',
    });
    const slots = createUserStore([
      { name: 'alice', role: 'admin', userType: 'admin', token: ADMIN_TOKEN },
    ]);
    broker.seedUsers(slots.slots());
    const db = openDatabase(':memory:');
    const app = createApp({
      broker,
      slots,
      sessions: new SessionStore(db),
      team: TEAM,
      roles: ROLES,
      version: '0.0.0',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // persistUsers intentionally omitted
    });

    for (const [method, path] of [
      ['POST', '/users'],
      ['PATCH', '/users/alice'],
      ['DELETE', '/users/alice'],
      ['POST', '/users/alice/rotate-token'],
      ['POST', '/users/alice/enroll-totp'],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
        body:
          method === 'DELETE'
            ? undefined
            : JSON.stringify({ name: 'x', role: 'admin', userType: 'agent' }),
      });
      expect(res.status).toBe(501);
    }
  });
});
