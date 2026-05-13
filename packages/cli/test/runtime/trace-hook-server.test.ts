/**
 * Hook server tests.
 *
 * Pins the busy-signal contract the Claude Code hook endpoint
 * implements:
 *
 *   - PreToolUse bumps tool_inflight by tool_use_id
 *   - PostToolUse / PostToolUseFailure decrement the matching handle
 *   - Mismatched events (Post without a prior Pre, duplicate Pre, etc.)
 *     do not corrupt the count
 *   - Bad bodies are rejected with 4xx
 *   - close() drains every outstanding handle so a torn-down runner
 *     can't leave the indicator wedged
 *
 * The HTTP server binds on 127.0.0.1:0 (random ephemeral port) so the
 * tests are hermetic and don't collide with anything else listening.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createBusySignal } from '../../src/runtime/trace/busy.js';
import { type HookServer, startHookServer } from '../../src/runtime/trace/hook-server.js';

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('hook server', () => {
  let server: HookServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close().catch(() => {});
      server = null;
    }
  });

  it('PreToolUse bumps tool_inflight; PostToolUse drains it', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    expect(busy.getSourceCounts().tool_inflight).toBe(0);

    const r1 = await postJson(server.url, {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
    });
    expect(r1.status).toBe(200);
    expect(busy.busy).toBe(true);
    expect(busy.getSourceCounts().tool_inflight).toBe(1);

    const r2 = await postJson(server.url, {
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tool-1',
      tool_name: 'Bash',
    });
    expect(r2.status).toBe(200);
    expect(busy.busy).toBe(false);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('counts overlapping tool calls correctly', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'a' });
    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'b' });
    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'c' });
    expect(busy.getSourceCounts().tool_inflight).toBe(3);

    await postJson(server.url, { hook_event_name: 'PostToolUse', tool_use_id: 'b' });
    expect(busy.getSourceCounts().tool_inflight).toBe(2);
    expect(busy.busy).toBe(true);

    await postJson(server.url, { hook_event_name: 'PostToolUse', tool_use_id: 'a' });
    await postJson(server.url, { hook_event_name: 'PostToolUseFailure', tool_use_id: 'c' });
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
    expect(busy.busy).toBe(false);
  });

  it('duplicate PreToolUse for the same id is a no-op', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'dup' });
    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'dup' });
    expect(busy.getSourceCounts().tool_inflight).toBe(1);

    await postJson(server.url, { hook_event_name: 'PostToolUse', tool_use_id: 'dup' });
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('PostToolUse for an unknown id is silently ignored (no underflow)', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    const res = await postJson(server.url, {
      hook_event_name: 'PostToolUse',
      tool_use_id: 'never-saw-this',
    });
    expect(res.status).toBe(200);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('non-tool events (SessionStart, Stop, etc.) are accepted without bumping', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'SessionStart' });
    await postJson(server.url, { hook_event_name: 'Stop' });
    await postJson(server.url, { hook_event_name: 'UserPromptSubmit' });
    expect(busy.busy).toBe(false);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('rejects malformed bodies with 400', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('returns 200 with accepted=false when fields are missing (avoid retry storms)', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    const res = await postJson(server.url, { hook_event_name: 'PreToolUse' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.accepted).toBe(false);
  });

  it('non-matching routes return 404', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    const res = await fetch(server.url.replace('/hook/tool-event', '/something-else'));
    expect(res.status).toBe(404);
  });

  it('close() drains outstanding handles so busy unwedges', async () => {
    const busy = createBusySignal();
    server = await startHookServer({ busy, log: () => {} });

    await postJson(server.url, { hook_event_name: 'PreToolUse', tool_use_id: 'left-dangling' });
    expect(busy.busy).toBe(true);

    await server.close();
    server = null;
    expect(busy.busy).toBe(false);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });
});
