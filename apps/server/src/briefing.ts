/**
 * Team briefing composition.
 *
 * Turns the raw team config + a specific slot into a `BriefingResponse`
 * with a pre-composed `instructions` string ready for the MCP link to
 * hand to `new Server({instructions})`.
 *
 * Voice matters: the instructions are written to COMPLEMENT the
 * agent's base identity, not overwrite it. "In this team you go by
 * X" and "Your role here: Y" — team context layered on top of
 * whatever the agent already knows about itself.
 *
 * Why instructions carry the *mechanism* but not the *live objective
 * list*: MCP has no refresh hook for the `instructions` string passed
 * to `new Server()` — it's frozen for the session. If we wrote the
 * current open objectives into it at boot, that list would go stale
 * the moment a director assigns new work, and the agent would trust
 * a snapshot that silently drifts. The tool descriptions for
 * `objectives_list` + `objectives_complete` ARE refresh-enabled via
 * `tools/list_changed` and carry the live state. Instructions stay
 * stable, tool descriptions stay live — two surfaces, two purposes,
 * no conflict. `openObjectives` is still returned on the response
 * for non-briefing callers (the web UI + the link's initial tool
 * description build), but no longer rendered into the prose.
 */

import type { BriefingResponse, Role, Slot, Team, Teammate } from '@agentc7/sdk/types';

export interface ComposeBriefingInput {
  self: Slot;
  selfRole: Role;
  team: Team;
  /** Every teammate on the team, including the caller. */
  teammates: Teammate[];
  /**
   * Objectives currently assigned to the caller with status `active`
   * or `blocked`. Returned verbatim on `BriefingResponse.openObjectives`
   * so the link + web UI can seed their initial state without a
   * second round trip. NOT rendered into the instructions string —
   * see file header for the reasoning.
   */
  openObjectives: BriefingResponse['openObjectives'];
}

/**
 * Compose the briefing response for a slot. Returns the structured
 * data plus the pre-rendered `instructions` string.
 */
export function composeBriefing(input: ComposeBriefingInput): BriefingResponse {
  const { self, selfRole, team, teammates, openObjectives } = input;
  const others = teammates.filter((t) => t.name !== self.name);
  const instructions = composeInstructions(self, selfRole, team, others);

  return {
    name: self.name,
    role: self.role,
    authority: self.authority,
    team,
    teammates,
    openObjectives,
    instructions,
  };
}

function composeInstructions(self: Slot, selfRole: Role, team: Team, others: Teammate[]): string {
  const longestName = others.reduce((max, t) => Math.max(max, t.name.length), 0);
  const teammateLines = others.map(
    (t) =>
      `  ${t.name.padEnd(longestName)} — ${t.role}${
        t.authority !== 'individual-contributor' ? ` [${t.authority}]` : ''
      }`,
  );

  const parts: Array<string | false> = [
    `You've connected to the ac7 net. In this team you go by ${self.name}.`,
    `Your role here: ${self.role}`,
    // Always emit the authority line. Plain individual-contributors need to know
    // they're individual-contributors (and therefore can't create/cancel/reassign
    // objectives) as explicitly as directors and managers know
    // their own rank. Absence of a line is not self-knowledge.
    `Your rank: ${self.authority}`,
    ``,
    `Team: ${team.name}`,
    `Directive: ${team.directive}`,
    team.brief.trim().length > 0 && `Brief: ${team.brief}`,
    ``,
    `Role notes for ${self.role}:`,
    selfRole.instructions.trim().length > 0
      ? selfRole.instructions
      : `(no role-specific instructions defined for ${self.role})`,
    ``,
    others.length > 0 && `Teammates on the net:`,
    ...(others.length > 0 ? teammateLines : []),
    others.length > 0 && ``,
    `Events from the net arrive as <channel source="ac7" thread="primary|dm" from="NAME">body</channel>.`,
    `When thread="primary" it's the team channel — reply with \`broadcast\`.`,
    `When thread="dm" it's a direct message — reply with \`send\`.`,
    `Your own sends are suppressed by the link — you will not see echoes of your own broadcasts or DMs on the live stream. \`recent\` still returns them in scrollback.`,
    ``,
    `── Objectives ──`,
    `Objectives are the apex task primitive on the team. They are assigned TO you (never picked up) by a director or manager. Every objective has a required \`outcome\` — the tangible result that defines "done" — and that outcome is the contract you are executing against.`,
    ``,
    `When an objective is assigned, a channel event arrives with kind="objective" and event="assigned". The event body carries the id, title, outcome, and originator so you can act on it immediately. Subsequent lifecycle events (blocked, unblocked, completed, cancelled, reassigned) land on the same channel with the same shape.`,
    ``,
    `Workflow:`,
    `  - \`objectives_list\` — your current plate. The tool description refreshes live as your state changes, so the count and titles there are always current even across compaction.`,
    `  - \`objectives_view\` <id> — full detail plus the append-only event log when you need acceptance criteria or history fresh in context.`,
    `  - \`objectives_update\` <id> — report progress (note=...), flag a block (status=blocked, blockReason=...), or resume (status=active). Use this when you're stuck, pausing, or have something the originator should know mid-flight.`,
    `  - \`objectives_complete\` <id> — deliver the result when the outcome is met. A result summary is required; it should explicitly address whether the stated outcome was satisfied and describe or link the deliverable.`,
    ``,
    `The act of doing the work IS the update — the tools that do the work also touch the objective state. Do not wait for external permission to progress; own the execution and communicate via the objective's own surface.`,
    ``,
    `Directors and managers create objectives; individual-contributors execute them. Use \`roster\` to see who's currently on the net and \`recent\` to pull scrollback.`,
  ];

  return parts.filter((p): p is string => typeof p === 'string').join('\n');
}
