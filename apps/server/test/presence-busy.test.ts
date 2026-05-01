/**
 * `POST /presence/busy` + roster integration tests.
 *
 * Pins:
 *   - Bearer-auth subscriber can report busy and the value surfaces on
 *     `/roster` as `connected[i].busy === true`.
 *   - Cookie-auth (web UI) callers receive 403 — the runner is the
 *     only thing that should be filing busy reports.
 *   - Reporting `busy: false` clears the entry immediately.
 *   - Stale entries (past the TTL) auto-clear on the next roster read.
 *   - Member deletion forgets any pending busy entry.
 */

import { Broker, InMemoryEventLog } from '@agentc7/core';
import type { RosterResponse, Team } from '@agentc7/sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { BUSY_TTL_MS } from '../src/busy-tracker.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';

const ADMIN_TOKEN = 'ac7_busy_test_admin_token';
const AGENT_TOKEN = 'ac7_busy_test_agent_token';

const TEAM: Team = {
  name: 'busy-test',
  directive: 'Verify busy presence flow.',
  brief: '',
  permissionPresets: {},
};

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface Harness {
  app: ReturnType<typeof createApp>['app'];
  sessions: SessionStore;
  advance: (ms: number) => void;
}

function makeApp(): Harness {
  let now = 1_700_000_000_000;
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => now,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'admin', description: '' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
    },
    {
      name: 'scout',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: AGENT_TOKEN,
    },
  ]);
  // Register so /roster sees them as recognized presences.
  for (const name of ['alice', 'scout']) void broker.register(name);
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
    now: () => now,
    logger: silentLogger(),
  });
  return {
    app,
    sessions,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function authBearer(token: string, body?: unknown, method = 'POST'): RequestInit {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

afterEach(() => vi.restoreAllMocks());

describe('POST /presence/busy', () => {
  it('accepts a bearer-auth busy report and surfaces it on /roster', async () => {
    const { app } = makeApp();

    const post = await app.request('/presence/busy', authBearer(AGENT_TOKEN, { busy: true }));
    expect(post.status).toBe(204);

    const roster = await app.request('/roster', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(roster.status).toBe(200);
    const body = (await roster.json()) as RosterResponse;
    const scout = body.connected.find((p) => p.name === 'scout');
    expect(scout?.busy).toBe(true);
    const alice = body.connected.find((p) => p.name === 'alice');
    expect(alice?.busy).toBeFalsy();
  });

  it('clears immediately on `busy: false`', async () => {
    const { app } = makeApp();
    await app.request('/presence/busy', authBearer(AGENT_TOKEN, { busy: true }));
    await app.request('/presence/busy', authBearer(AGENT_TOKEN, { busy: false }));

    const roster = await app.request('/roster', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await roster.json()) as RosterResponse;
    expect(body.connected.find((p) => p.name === 'scout')?.busy).toBeFalsy();
  });

  it('rejects a session-cookie caller with 403 (runner-only)', async () => {
    const { app, sessions } = makeApp();
    const session = sessions.create('alice', null);
    const res = await app.request('/presence/busy', {
      method: 'POST',
      headers: {
        Cookie: `ac7_session=${session.id}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ busy: true }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/runner-only/i);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const { app } = makeApp();
    const res = await app.request('/presence/busy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ busy: true }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed payload with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/presence/busy', authBearer(AGENT_TOKEN, { whatever: true }));
    expect(res.status).toBe(400);
  });

  it('TTL clears stale busy entries on the next roster read', async () => {
    const { app, advance } = makeApp();
    await app.request('/presence/busy', authBearer(AGENT_TOKEN, { busy: true }));

    // Advance past the TTL without a heartbeat.
    advance(BUSY_TTL_MS + 1);

    const roster = await app.request('/roster', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await roster.json()) as RosterResponse;
    expect(body.connected.find((p) => p.name === 'scout')?.busy).toBeFalsy();
  });

  it('member delete forgets any pending busy entry', async () => {
    const { app } = makeApp();
    // scout (the agent) reports busy.
    await app.request('/presence/busy', authBearer(AGENT_TOKEN, { busy: true }));
    // alice deletes scout.
    const del = await app.request('/members/scout', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(del.status).toBe(204);

    // Even if scout's bearer somehow re-authenticated (it's revoked,
    // but we want to confirm the busy state itself is cleared), the
    // roster shouldn't surface a busy entry for the deleted name.
    const roster = await app.request('/roster', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await roster.json()) as RosterResponse;
    expect(body.connected.find((p) => p.name === 'scout')?.busy).toBeFalsy();
  });
});
