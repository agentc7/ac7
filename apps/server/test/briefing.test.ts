import type { Role, User, Team, Teammate } from '@agentc7/sdk/types';
import { describe, expect, it } from 'vitest';
import { composeBriefing } from '../src/briefing.js';

const TEAM: Team = {
  name: 'alpha-team',
  directive: 'Ship the payment service.',
  brief: 'We own the full lifecycle of the payment service.',
};

const OPERATOR_ROLE: Role = {
  description: 'Directs the team.',
  instructions: 'Lead the team and issue directives in the team channel.',
};

const IMPLEMENTER_ROLE: Role = {
  description: 'Writes code.',
  instructions: 'Take direction from command, ship code, report progress.',
};

const ACTUAL: User = { name: 'ACTUAL', role: 'individual-contributor', userType: 'admin' };
const ALPHA_1: User = {
  name: 'ALPHA-1',
  role: 'implementer',
  userType: 'agent',
};
const SIERRA: User = {
  name: 'SIERRA',
  role: 'implementer',
  userType: 'agent',
};

const TEAMMATES: Teammate[] = [
  { name: 'ACTUAL', role: 'individual-contributor', userType: 'admin' },
  { name: 'ALPHA-1', role: 'implementer', userType: 'agent' },
  { name: 'SIERRA', role: 'implementer', userType: 'agent' },
];

describe('composeBriefing', () => {
  it('includes name, role, userType, team, and teammates', () => {
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: OPERATOR_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.name).toBe('ACTUAL');
    expect(briefing.role).toBe('individual-contributor');
    expect(briefing.userType).toBe('admin');
    expect(briefing.team).toEqual(TEAM);
    expect(briefing.teammates).toEqual(TEAMMATES);
    expect(briefing.openObjectives).toEqual([]);
  });

  it('surfaces userType in the instructions when elevated', () => {
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: OPERATOR_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('Your rank: admin');
  });

  it('always surfaces rank in the instructions, including for plain individual-contributors', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    // Every agent should know its own rank explicitly — absence of
    // a line is not self-knowledge. IndividualContributors need to see
    // "Your rank: agent" as clearly as directors see theirs.
    expect(briefing.instructions).toContain('Your rank: agent');
  });

  it('renders complementary instructions that reference team context', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('you go by ALPHA-1');
    expect(briefing.instructions).toContain('Your role here: implementer');
    expect(briefing.instructions).toContain(TEAM.name);
    expect(briefing.instructions).toContain(TEAM.directive);
    expect(briefing.instructions).toContain(TEAM.brief);
    expect(briefing.instructions).toContain(IMPLEMENTER_ROLE.instructions);
  });

  it('lists other teammates and filters self out of the rendered list', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.teammates.some((t) => t.name === 'ALPHA-1')).toBe(true);
    const linesAfterHeader = briefing.instructions
      .split('\n')
      .slice(briefing.instructions.split('\n').indexOf('Teammates on the net:'))
      .join('\n');
    expect(linesAfterHeader).toContain('ACTUAL');
    expect(linesAfterHeader).toContain('SIERRA');
    expect(linesAfterHeader).not.toMatch(/^\s{2}ALPHA-1\s/m);
  });

  it('omits the brief line when team.brief is empty', () => {
    const teamNoBrief: Team = { ...TEAM, brief: '' };
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: OPERATOR_ROLE,
      team: teamNoBrief,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).not.toContain('Brief:');
    expect(briefing.instructions).toContain(`Directive: ${teamNoBrief.directive}`);
  });

  it('falls back to a placeholder when selfRole.instructions is empty', () => {
    const emptyRole: Role = { description: '', instructions: '' };
    const briefing = composeBriefing({
      self: ACTUAL,
      selfRole: emptyRole,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain(
      '(no role-specific instructions defined for individual-contributor)',
    );
  });

  it('notes that the link suppresses self-echoes on the live stream', () => {
    const briefing = composeBriefing({
      self: SIERRA,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    expect(briefing.instructions).toContain('Your own sends are suppressed by the link');
  });

  it('returns open objectives on the response but does NOT render them into instructions', () => {
    // MCP has no refresh hook for the `instructions` string, so we
    // deliberately keep the live list out of the prose — it would go
    // stale the moment a new objective was assigned mid-session. Tool
    // descriptions for `objectives_list` carry the live state via
    // `tools/list_changed`.
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [
        {
          id: 'obj-1',
          title: 'Fix the login redirect bug',
          body: '',
          outcome: 'Users hitting /login while authenticated land on /dashboard.',
          status: 'active',
          assignee: 'ALPHA-1',
          originator: 'ACTUAL',
          watchers: [],
          createdAt: 1,
          updatedAt: 1,
          completedAt: null,
          result: null,
          blockReason: null,
          attachments: [],
        },
      ],
    });
    // openObjectives surfaces on the response body for non-briefing callers.
    expect(briefing.openObjectives).toHaveLength(1);
    expect(briefing.openObjectives[0]?.id).toBe('obj-1');
    // But the ID / title / outcome never land in the prose.
    expect(briefing.instructions).not.toContain('obj-1');
    expect(briefing.instructions).not.toContain('Fix the login redirect bug');
    expect(briefing.instructions).not.toContain('Objectives on your plate');
  });

  it('teaches the objective mechanism in instructions regardless of current plate', () => {
    const briefing = composeBriefing({
      self: ALPHA_1,
      selfRole: IMPLEMENTER_ROLE,
      team: TEAM,
      teammates: TEAMMATES,
      openObjectives: [],
    });
    // The mechanism explanation + tool verbs are always present so
    // the agent knows what to do when an objective push arrives,
    // regardless of whether one is on the plate right now.
    expect(briefing.instructions).toContain('── Objectives ──');
    expect(briefing.instructions).toContain('kind="objective"');
    expect(briefing.instructions).toContain('objectives_list');
    expect(briefing.instructions).toContain('objectives_update');
    expect(briefing.instructions).toContain('objectives_complete');
    expect(briefing.instructions).toContain('required `outcome`');
  });
});
