/**
 * MCP tool surface tests.
 *
 * The agent-facing tool surface (`packages/cli/src/runtime/tools.ts`)
 * had no direct test coverage before — its handlers were exercised
 * indirectly through the smoke test. This file pins the new
 * channel-related tools (`channels_list`, `channels_post`, the
 * `channel` arg on `recent`) plus the `defineTools` output shape.
 *
 * The handlers all take a `BrokerClient`; we pass a minimal stub
 * implementing only the methods each handler touches so tests stay
 * tightly scoped.
 */

import type { Client as BrokerClient } from '@agentc7/sdk/client';
import type {
  BriefingResponse,
  ChannelSummary,
  GetChannelResponse,
  Message,
  PushPayload,
  PushResult,
} from '@agentc7/sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { defineTools, handleToolCall } from '../../src/runtime/tools.js';

const BRIEFING: BriefingResponse = {
  name: 'scout',
  role: { title: 'engineer', description: '' },
  permissions: [],
  instructions: '',
  team: {
    name: 'demo',
    directive: 'ship',
    context: '',
    permissionPresets: {},
  },
  teammates: [
    { name: 'scout', role: { title: 'engineer', description: '' }, permissions: [] },
    {
      name: 'director',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
    },
  ],
  openObjectives: [],
};

function makeBroker(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return overrides as BrokerClient;
}

function makeChannel(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: 'eng-id-123',
    slug: 'engineering',
    createdBy: 'director',
    createdAt: 1_700_000_000_000,
    archivedAt: null,
    joined: true,
    myRole: 'member',
    memberCount: 4,
    ...overrides,
  };
}

function getCallText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected text content');
  }
  return first.text;
}

// ─── tool definition surface ─────────────────────────────────────────

describe('defineTools — chat surface includes channel tools', () => {
  it('includes channels_list and channels_post', () => {
    const names = defineTools(BRIEFING).map((t) => t.name);
    expect(names).toContain('channels_list');
    expect(names).toContain('channels_post');
  });

  it('broadcast description mentions channels_post for non-general channels', () => {
    const broadcast = defineTools(BRIEFING).find((t) => t.name === 'broadcast');
    expect(broadcast).toBeDefined();
    expect(broadcast?.description).toMatch(/channels_post/);
    expect(broadcast?.description).toMatch(/general/i);
  });

  it('recent description and schema mention the channel arg', () => {
    const recent = defineTools(BRIEFING).find((t) => t.name === 'recent');
    expect(recent).toBeDefined();
    expect(recent?.description).toMatch(/channel/i);
    const props = recent?.inputSchema.properties as Record<string, unknown>;
    expect(props?.channel).toBeDefined();
    expect(props?.with).toBeDefined();
  });

  it('channels_post requires channel + body', () => {
    const post = defineTools(BRIEFING).find((t) => t.name === 'channels_post');
    expect(post?.inputSchema.required).toEqual(['channel', 'body']);
  });
});

// ─── channels_list handler ───────────────────────────────────────────

describe('channels_list handler', () => {
  it('renders joined channels first, then visible non-joined', async () => {
    const broker = makeBroker({
      listChannels: vi.fn(async () => [
        makeChannel({ slug: 'engineering', joined: true, myRole: 'admin', memberCount: 5 }),
        makeChannel({
          id: 'design-id',
          slug: 'design',
          joined: false,
          myRole: null,
          memberCount: 3,
        }),
        makeChannel({
          id: 'ops-id',
          slug: 'ops',
          joined: true,
          myRole: 'member',
          memberCount: 2,
        }),
      ]),
    });
    const result = await handleToolCall('channels_list', {}, broker, BRIEFING);
    const text = getCallText(
      result as unknown as { content: Array<{ type: string; text?: string }> },
    );
    // Joined section appears before non-joined.
    const engIdx = text.indexOf('#engineering');
    const opsIdx = text.indexOf('#ops');
    const designIdx = text.indexOf('#design');
    expect(engIdx).toBeGreaterThan(-1);
    expect(opsIdx).toBeGreaterThan(-1);
    expect(designIdx).toBeGreaterThan(engIdx);
    expect(text).toMatch(/admin/);
    expect(text).toMatch(/members=5/);
  });

  it('reports the empty case cleanly', async () => {
    const broker = makeBroker({
      listChannels: vi.fn(async () => []),
    });
    const result = await handleToolCall('channels_list', {}, broker, BRIEFING);
    const text = getCallText(
      result as unknown as { content: Array<{ type: string; text?: string }> },
    );
    expect(text).toMatch(/no channels/i);
  });
});

// ─── channels_post handler ──────────────────────────────────────────

function pushOk(): PushResult {
  return {
    message: {
      id: 'msg-x',
      ts: 1,
      to: null,
      from: 'scout',
      title: null,
      body: 'b',
      level: 'info',
      data: {},
      attachments: [],
    } as Message,
    delivery: { live: 1, targets: 1 },
  };
}

describe('channels_post handler', () => {
  it('resolves slug → id and stamps data.thread = chan:<id>', async () => {
    const push = vi.fn(async (_p: PushPayload): Promise<PushResult> => pushOk());
    const broker = makeBroker({
      getChannel: vi.fn(
        async (_slug: string): Promise<GetChannelResponse> => ({
          channel: makeChannel({ slug: 'engineering', joined: true, myRole: 'member' }),
          members: [],
        }),
      ),
      push,
    });
    const result = await handleToolCall(
      'channels_post',
      { channel: 'engineering', body: 'hi team' },
      broker,
      BRIEFING,
    );
    expect(getCallText(result as never)).toMatch(/posted to #engineering/);
    expect(push).toHaveBeenCalledTimes(1);
    const arg = push.mock.calls[0]?.[0] as PushPayload;
    expect(arg.body).toBe('hi team');
    expect((arg.data as { thread?: string })?.thread).toBe('chan:eng-id-123');
    // No `to` for channel posts — the broker resolves recipients
    // server-side from channel membership.
    expect(arg.to).toBeUndefined();
  });

  it('errors with a useful hint when channel does not exist', async () => {
    const broker = makeBroker({
      getChannel: vi.fn(async () => {
        const err = Object.assign(new Error('not found'), { name: 'ClientError', status: 404 });
        throw err;
      }),
    });
    const result = await handleToolCall(
      'channels_post',
      { channel: 'ghost', body: 'hi' },
      broker,
      BRIEFING,
    );
    const text = getCallText(result as never);
    expect(text).toMatch(/no channel/);
    expect(text).toMatch(/channels_list/);
  });

  it('errors when caller is not a member of the channel', async () => {
    const broker = makeBroker({
      getChannel: vi.fn(
        async (): Promise<GetChannelResponse> => ({
          channel: makeChannel({ slug: 'private', joined: false, myRole: null }),
          members: [],
        }),
      ),
    });
    const result = await handleToolCall(
      'channels_post',
      { channel: 'private', body: 'hi' },
      broker,
      BRIEFING,
    );
    expect(getCallText(result as never)).toMatch(/not a member/);
  });

  it('rejects missing required args', async () => {
    const broker = makeBroker({});
    const noChannel = await handleToolCall('channels_post', { body: 'x' }, broker, BRIEFING);
    expect(getCallText(noChannel as never)).toMatch(/channel/);
    const noBody = await handleToolCall(
      'channels_post',
      { channel: 'engineering' },
      broker,
      BRIEFING,
    );
    expect(getCallText(noBody as never)).toMatch(/body/);
  });
});

// ─── recent (extended with channel arg) ─────────────────────────────

describe('recent handler — channel arg', () => {
  it('resolves slug → id and queries history({channel: id})', async () => {
    const history = vi.fn(async () => [] as Message[]);
    const broker = makeBroker({
      getChannel: vi.fn(
        async (_slug: string): Promise<GetChannelResponse> => ({
          channel: makeChannel({ slug: 'engineering' }),
          members: [],
        }),
      ),
      history,
    });
    await handleToolCall('recent', { channel: 'engineering' }, broker, BRIEFING);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: 'eng-id-123' }));
    // `with` should NOT be set — channel + with are mutually exclusive.
    expect(history).toHaveBeenCalledWith(expect.not.objectContaining({ with: expect.anything() }));
  });

  it('rejects passing both `with` and `channel`', async () => {
    const broker = makeBroker({});
    const result = await handleToolCall(
      'recent',
      { with: 'director', channel: 'engineering' },
      broker,
      BRIEFING,
    );
    expect(getCallText(result as never)).toMatch(/with.*channel/i);
  });

  it('renders the empty-channel message with the slug', async () => {
    const broker = makeBroker({
      getChannel: vi.fn(
        async (): Promise<GetChannelResponse> => ({
          channel: makeChannel({ slug: 'engineering' }),
          members: [],
        }),
      ),
      history: vi.fn(async () => [] as Message[]),
    });
    const result = await handleToolCall('recent', { channel: 'engineering' }, broker, BRIEFING);
    expect(getCallText(result as never)).toMatch(/#engineering/);
  });

  it('returns a useful error when channel does not exist', async () => {
    const broker = makeBroker({
      getChannel: vi.fn(async () => {
        const err = Object.assign(new Error('nope'), { name: 'ClientError', status: 404 });
        throw err;
      }),
    });
    const result = await handleToolCall('recent', { channel: 'ghost' }, broker, BRIEFING);
    expect(getCallText(result as never)).toMatch(/no channel/);
  });
});
