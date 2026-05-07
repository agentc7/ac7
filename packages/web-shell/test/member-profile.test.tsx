/**
 * MemberProfile + AgentTimeline render tests.
 *
 * Covers:
 *   - Non-admin sees a profile (Overview/Objectives/Files) but no Activity tab
 *   - Admin sees the full page (header, metadata, activity, manage)
 *   - AgentTimeline renders each event kind correctly
 *   - Filter bar toggles hide/show per-kind rows
 *   - Empty state shows the "no activity" placeholder
 *
 * Real WebSocket behavior (connect / reconnect / dedup) is covered
 * at the lib level rather than through a rendered component; driving
 * a live WebSocket through jsdom is flaky.
 */

import type { ActivityRow, BriefingResponse, Objective, RosterResponse } from '@agentc7/sdk/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetAgentTimelineForTests, AgentTimeline } from '../src/components/AgentTimeline.js';
import { MemberProfile } from '../src/components/MemberProfile.js';
import { briefing } from '../src/lib/briefing.js';
import { __resetClientForTests } from '../src/lib/client.js';
import {
  __resetMemberActivityForTests,
  memberActivityLoading,
  memberActivityName,
  memberActivityRows,
} from '../src/lib/member-activity.js';
import { objectives as objectivesSignal } from '../src/lib/objectives.js';
import { roster } from '../src/lib/roster.js';

const originalFetch = globalThis.fetch;

const COMMANDER_BRIEFING: BriefingResponse = {
  name: 'director-1',
  role: { title: 'director', description: '' },
  permissions: ['members.manage'],
  team: { name: 'demo-team', directive: 'Ship it', context: '', permissionPresets: {} },
  teammates: [
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
    },
    { name: 'engineer-1', role: { title: 'engineer', description: '' }, permissions: [] },
  ],
  openObjectives: [],
  instructions: 'Lead the team.',
};

const OPERATOR_BRIEFING: BriefingResponse = {
  ...COMMANDER_BRIEFING,
  name: 'engineer-1',
  role: { title: 'engineer', description: '' },
  permissions: [],
};

const ROSTER: RosterResponse = {
  teammates: [
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
    },
    { name: 'engineer-1', role: { title: 'engineer', description: '' }, permissions: [] },
  ],
  connected: [
    {
      name: 'engineer-1',
      connected: 1,
      createdAt: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      role: { title: 'engineer', description: '' },
    },
  ],
};

const OBJECTIVE: Objective = {
  id: 'obj-1',
  title: 'Ship the feature',
  body: '',
  outcome: 'Feature shipped',
  status: 'active',
  assignee: 'engineer-1',
  originator: 'director-1',
  watchers: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  completedAt: null,
  result: null,
  blockReason: null,
  attachments: [],
};

const LLM_ROW: ActivityRow = {
  id: 1,
  memberName: 'engineer-1',
  createdAt: 1_700_000_000_500,
  event: {
    kind: 'llm_exchange',
    ts: 1_700_000_000_000,
    duration: 200,
    entry: {
      kind: 'anthropic_messages',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_200,
      request: {
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        temperature: null,
        system: null,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: null,
      },
      response: {
        stopReason: 'end_turn',
        stopSequence: null,
        status: 200,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'pong' }] }],
        usage: {
          inputTokens: 3,
          outputTokens: 1,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
      },
    },
  },
};

const OPAQUE_ROW: ActivityRow = {
  id: 2,
  memberName: 'engineer-1',
  createdAt: 1_700_000_001_000,
  event: {
    kind: 'opaque_http',
    ts: 1_700_000_000_500,
    duration: 10,
    entry: {
      kind: 'opaque_http',
      startedAt: 1_700_000_000_500,
      endedAt: 1_700_000_000_510,
      host: 'telemetry.example.com',
      method: 'POST',
      url: '/ping',
      status: 204,
      requestHeaders: {},
      responseHeaders: {},
      requestBodyPreview: null,
      responseBodyPreview: null,
    },
  },
};

const OPEN_ROW: ActivityRow = {
  id: 3,
  memberName: 'engineer-1',
  createdAt: 1_700_000_002_000,
  event: { kind: 'objective_open', ts: 1_700_000_001_000, objectiveId: 'obj-1' },
};

const CLOSE_ROW: ActivityRow = {
  id: 4,
  memberName: 'engineer-1',
  createdAt: 1_700_000_003_000,
  event: {
    kind: 'objective_close',
    ts: 1_700_000_002_000,
    objectiveId: 'obj-1',
    result: 'done',
  },
};

/**
 * Minimal WebSocket stub — jsdom doesn't ship one, and the lib's
 * `startMemberActivitySubscribe` needs to construct one. Records
 * all constructions so tests can verify the URL, but never fires
 * real open/message/close events.
 */
class StubWebSocket {
  static instances: StubWebSocket[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(ev: Event) => void>>();
  constructor(url: string) {
    this.url = url;
    StubWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: Event) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  removeEventListener(): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
  send(_data: string): void {
    /* no-op */
  }
}

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  __resetClientForTests();
  __resetMemberActivityForTests();
  __resetAgentTimelineForTests();
  // Stub fetch so the lib's hydration call in useEffect doesn't 500
  // every test. We replay the same listAgentActivity response for
  // every call.
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ activity: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
  // Stub WebSocket — jsdom doesn't have one.
  StubWebSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
  roster.value = ROSTER;
  objectivesSignal.value = [OBJECTIVE];
});

afterEach(() => {
  cleanup();
  briefing.value = null;
  roster.value = null;
  objectivesSignal.value = [];
  __resetMemberActivityForTests();
  __resetAgentTimelineForTests();
  globalThis.fetch = originalFetch;
  if (originalWebSocket === undefined) {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  } else {
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
});

describe('MemberProfile', () => {
  it('non-admins see the profile but not the Activity or Manage tabs', () => {
    briefing.value = OPERATOR_BRIEFING;
    render(<MemberProfile name="engineer-1" tab="overview" viewer="engineer-1" />);
    expect(screen.getByRole('heading', { name: /engineer-1/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /activity/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /manage/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /overview/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /objectives/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /files/i })).toBeTruthy();
  });

  it('shows the member header and metadata for admins', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityName.value = 'engineer-1';
    render(<MemberProfile name="engineer-1" tab="overview" viewer="director-1" />);
    expect(screen.getByRole('heading', { name: /engineer-1/ })).toBeTruthy();
    expect(screen.getByText('ENGINEER')).toBeTruthy();
    expect(screen.getByText(/ONLINE/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /activity/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /manage/i })).toBeTruthy();
  });

  it('shows the "DM" shortcut when viewer is not the target member', () => {
    briefing.value = COMMANDER_BRIEFING;
    render(<MemberProfile name="engineer-1" tab="overview" viewer="director-1" />);
    expect(screen.getByText(/DM engineer-1/)).toBeTruthy();
  });

  it('does NOT show the DM shortcut when viewing your own profile', () => {
    briefing.value = COMMANDER_BRIEFING;
    render(<MemberProfile name="director-1" tab="overview" viewer="director-1" />);
    expect(screen.queryByText(/DM director-1/)).toBeNull();
  });

  it('switches to the objectives tab when that tab is active', () => {
    briefing.value = COMMANDER_BRIEFING;
    render(<MemberProfile name="engineer-1" tab="objectives" viewer="director-1" />);
    expect(screen.getByText(/Ship the feature/)).toBeTruthy();
  });
});

describe('AgentTimeline', () => {
  it('renders each event kind with distinct affordances', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [CLOSE_ROW, OPEN_ROW, OPAQUE_ROW, LLM_ROW];
    memberActivityLoading.value = false;
    const { container } = render(<AgentTimeline />);

    // LLM exchange: model name
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy();
    // Opaque HTTP rows are filtered out by default (the chip starts
    // off so the live tail isn't dominated by background traffic).
    // Click to enable so the renderer-affordance assertions below
    // have rows to match against.
    fireEvent.click(screen.getByRole('button', { name: /HTTP/ }));
    // Opaque HTTP: host + url as separate spans
    const text = container.textContent ?? '';
    expect(text).toContain('telemetry.example.com');
    expect(text).toContain('/ping');
    expect(text).toContain('204');
    // Objective open marker (▼) and close marker (▲)
    expect(text).toContain('▼');
    expect(text).toContain('▲');
    expect(text).toContain('closed (done)');
  });

  it('shows the empty placeholder when no rows are loaded', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [];
    memberActivityLoading.value = false;
    render(<AgentTimeline />);
    expect(screen.getByText(/No activity yet/i)).toBeTruthy();
  });

  it('filter toggle hides and shows the matching event kind', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [LLM_ROW, OPAQUE_ROW];
    memberActivityLoading.value = false;
    render(<AgentTimeline />);

    // Initial state: HTTP filter is OFF by default (the chip ships
    // unchecked), so telemetry rows are hidden. LLM rows show.
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy();
    const initialText = document.body.textContent ?? '';
    expect(initialText).not.toContain('telemetry.example.com');

    // Click the HTTP chip to turn it on; the row appears.
    const httpButton = screen.getByRole('button', { name: /HTTP/ });
    fireEvent.click(httpButton);
    const enabledText = document.body.textContent ?? '';
    expect(enabledText).toContain('telemetry.example.com');

    // Click again to turn it back off; the row hides again.
    fireEvent.click(httpButton);
    const disabledText = document.body.textContent ?? '';
    expect(disabledText).not.toContain('telemetry.example.com');
    // LLM row stays visible regardless.
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy();
  });
});
