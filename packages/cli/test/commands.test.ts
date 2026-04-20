import { Client } from '@agentc7/sdk/client';
import type { Presence, Message, PushResult, Teammate } from '@agentc7/sdk/types';
import { describe, expect, it } from 'vitest';
import { buildPushPayload, runPushCommand, UsageError } from '../src/commands/push.js';
import { runRosterCommand } from '../src/commands/roster.js';

function mockFetch(handler: (url: URL, init: RequestInit) => Response): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('buildPushPayload', () => {
  it('rejects missing body', () => {
    expect(() => buildPushPayload({ body: '', to: 'a' })).toThrow(UsageError);
  });

  it('rejects when neither --agent nor --broadcast is set', () => {
    expect(() => buildPushPayload({ body: 'hi' })).toThrow(UsageError);
  });

  it('rejects when both --agent and --broadcast are set', () => {
    expect(() => buildPushPayload({ body: 'hi', to: 'a', broadcast: true })).toThrow(
      UsageError,
    );
  });

  it('rejects an invalid --level', () => {
    expect(() => buildPushPayload({ body: 'hi', to: 'a', level: 'bogus' })).toThrow(
      UsageError,
    );
  });

  it('targeted push produces an agentId payload', () => {
    const p = buildPushPayload({ body: 'hi', to: 'a1', title: 't' });
    expect(p.to).toBe('a1');
    expect(p.body).toBe('hi');
    expect(p.title).toBe('t');
    expect(p.level).toBe('info');
  });

  it('broadcast produces a null agentId payload', () => {
    const p = buildPushPayload({ body: 'hi', broadcast: true });
    expect(p.to).toBe(null);
  });

  it('honors a valid --level', () => {
    const p = buildPushPayload({ body: 'hi', broadcast: true, level: 'warning' });
    expect(p.level).toBe('warning');
  });
});

describe('runPushCommand', () => {
  it('issues a POST /push and returns a formatted summary', async () => {
    const fakeMessage: Message = {
      id: 'msg-x',
      ts: 1,
      to: 'a1',
      from: 'alice',
      title: null,
      body: 'hi',
      level: 'info',
      data: {},
      attachments: [],
    };
    const fakeResult: PushResult = {
      delivery: { sse: 2, targets: 1 },
      message: fakeMessage,
    };
    let captured: { method?: string; path?: string; body?: string } = {};
    const client = new Client({
      url: 'http://broker.test',
      token: 'secret',
      fetch: mockFetch((url, init) => {
        captured = {
          method: init.method ?? 'GET',
          path: url.pathname,
          body: typeof init.body === 'string' ? init.body : undefined,
        };
        return jsonResponse(fakeResult);
      }),
    });
    const out = await runPushCommand({ to: 'a1', body: 'hi' }, client);
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/push');
    expect(out).toContain('delivered to a1');
    expect(out).toContain('msg-x');
    expect(out).toContain('sse: 2');
    expect(out).toContain('targets: 1');
  });
});

describe('runRosterCommand', () => {
  it('renders a formatted table when teammates exist', async () => {
    const teammates: Teammate[] = [
      { name: 'ACTUAL', role: 'agent', userType: 'admin' },
      { name: 'ALPHA-1', role: 'implementer', userType: 'agent' },
    ];
    const connected: Presence[] = [
      {
        name: 'ACTUAL',
        connected: 1,
        createdAt: 1_700_000_000_000,
        lastSeen: 1_700_000_100_000,
        role: 'agent',
        userType: 'admin',
      },
    ];
    const client = new Client({
      url: 'http://broker.test',
      token: 'secret',
      fetch: mockFetch(() => jsonResponse({ teammates, connected })),
    });
    const out = await runRosterCommand(client);
    expect(out).toContain('name');
    expect(out).toContain('ACTUAL');
    expect(out).toContain('ALPHA-1');
    expect(out).toContain('agent');
    expect(out).toContain('implementer');
  });

  it('renders a friendly message when empty', async () => {
    const client = new Client({
      url: 'http://broker.test',
      token: 'secret',
      fetch: mockFetch(() => jsonResponse({ teammates: [], connected: [] })),
    });
    const out = await runRosterCommand(client);
    expect(out).toBe('no users defined');
  });
});
