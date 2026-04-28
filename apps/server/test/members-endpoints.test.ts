/**
 * End-to-end tests for the `/members/*` admin CRUD surface.
 *
 * Every test wires a fresh in-memory SQLite + stub `persistMembers`
 * through `createApp` so the full auth + schema + in-memory mutation
 * path runs. `persistMembers` is a vi.fn() so we can assert it fires
 * exactly once per successful mutation and never on 4xx/5xx.
 */

import { Broker, InMemoryEventLog } from '@agentc7/core';
import type { Member, Team, Teammate } from '@agentc7/sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';

const ADMIN_TOKEN = 'ac7_members_test_admin_token';
const OPERATOR_TOKEN = 'ac7_members_test_operator_token';
const AGENT_TOKEN = 'ac7_members_test_agent_token';

const TEAM: Team = {
  name: 'members-team',
  directive: 'Exercise member CRUD.',
  brief: '',
  permissionPresets: {
    admin: [
      'team.manage',
      'members.manage',
      'objectives.create',
      'objectives.cancel',
      'objectives.reassign',
      'objectives.watch',
      'activity.read',
    ],
    operator: ['objectives.create', 'objectives.cancel', 'objectives.reassign'],
  },
};

interface Harness {
  app: ReturnType<typeof createApp>['app'];
  persistMembers: ReturnType<typeof vi.fn>;
  broker: Broker;
  tokens: ReturnType<typeof createTokenStoreFromMembers>;
}

function makeApp(): Harness {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
    },
    {
      name: 'bob',
      role: { title: 'manager', description: '' },
      permissions: ['objectives.create', 'objectives.cancel', 'objectives.reassign'],
      token: OPERATOR_TOKEN,
    },
    {
      name: 'scout',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: AGENT_TOKEN,
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const persistMembers = vi.fn();
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    team: TEAM,
    version: '0.0.0',
    persistMembers,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, persistMembers, broker, tokens };
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

describe('GET /members', () => {
  it('returns a Member[] (with instructions) when the caller has members.manage', async () => {
    const { app } = makeApp();
    const res = await app.request('/members', { headers: authed(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Member[] };
    expect(body.members.map((m) => m.name).sort()).toEqual(['alice', 'bob', 'scout']);
    expect(body.members.find((m) => m.name === 'alice')?.permissions).toContain('members.manage');
  });

  it('returns the public Teammate[] projection for non-admins', async () => {
    const { app } = makeApp();
    const res = await app.request('/members', { headers: authed(AGENT_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Teammate[] };
    expect(body.members.map((m) => m.name).sort()).toEqual(['alice', 'bob', 'scout']);
  });

  it('401s without auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/members');
    expect(res.status).toBe(401);
  });
});

describe('POST /members', () => {
  it('creates a member and returns the plaintext token (admin only)', async () => {
    const { app, persistMembers, broker } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'newbie',
        role: { title: 'engineer', description: '' },
        permissions: [],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: Teammate; token: string };
    expect(body.member.name).toBe('newbie');
    expect(body.token).toMatch(/^ac7_/);
    expect(persistMembers).toHaveBeenCalledTimes(1);
    expect(broker.hasMember('newbie')).toBe(true);
  });

  it('rejects non-admins', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: { ...authed(OPERATOR_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'nope',
        role: { title: 'engineer', description: '' },
        permissions: [],
      }),
    });
    expect(res.status).toBe(403);
    expect(persistMembers).not.toHaveBeenCalled();
  });

  it('resolves preset names in the permissions field', async () => {
    const { app } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'helper',
        role: { title: 'manager', description: '' },
        permissions: ['operator'],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: Teammate; token: string };
    expect(body.member.permissions).toContain('objectives.create');
  });

  it('rejects unknown preset names', async () => {
    const { app } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'broken',
        role: { title: 'engineer', description: '' },
        permissions: ['nonexistent-preset'],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /members/:name', () => {
  it('refuses to delete the last admin', async () => {
    const { app } = makeApp();
    const res = await app.request('/members/alice', {
      method: 'DELETE',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(409);
  });
});
