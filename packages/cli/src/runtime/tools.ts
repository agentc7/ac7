/**
 * Tool definitions and handlers for the link's MCP server face.
 *
 * Chat tools (dynamic descriptions composed from the briefing):
 *   - roster         — list teammates
 *   - broadcast      — send to the general team channel
 *   - send           — DM a teammate by name
 *   - channels_list  — list named channels visible to this agent
 *   - channels_post  — post into a specific named channel by slug
 *   - recent         — fetch recent team-chat / DM / channel history
 *
 * Objective tools (descriptions composed from briefing + live open
 * objectives set so the sticky context stays fresh across compaction):
 *   - objectives_list     — the caller's active plate
 *   - objectives_view     — full detail on one objective
 *   - objectives_update   — report progress, flag block, post note
 *   - objectives_complete — mark done with required result
 *
 * No `objectives_create` tool in v1 — objectives are created by
 * directors / managers via CLI or web UI, never by agents.
 */

import type { Client as BrokerClient, ClientError } from '@agentc7/sdk/client';
import type {
  Attachment,
  BriefingResponse,
  FsEntry,
  LogLevel,
  Message,
  ObjectiveStatus,
} from '@agentc7/sdk/types';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];
const OBJECTIVE_STATUSES: readonly ObjectiveStatus[] = ['active', 'blocked', 'done', 'cancelled'];

const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 500;

/**
 * Build the tool set with descriptions composed from the briefing.
 * Tool descriptions are stable — objective state is delivered via
 * channel notifications, not baked into tool metadata.
 */
export function defineTools(briefing: BriefingResponse): Tool[] {
  const { name, role, team, teammates } = briefing;
  const identity = `${name} (role: ${role.title})`;
  const others = teammates.filter((t) => t.name !== name);
  const teammateList =
    others.length > 0
      ? others.map((t) => `${t.name} (${t.role.title})`).join(', ')
      : '(no other teammates currently defined)';

  return [
    {
      name: 'roster',
      description:
        `List all teammates currently on the ac7 net. You go by ${identity} in ` +
        `team ${team.name}. Directive: ${team.directive}. Returns each teammate's ` +
        `name, role, authority, and connection state.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'broadcast',
      description:
        `Broadcast a message to the ${team.name} team's general channel. Every teammate ` +
        `sees it in real time. Use this for team-wide announcements, status updates, and ` +
        `individual-contributor directives. For posts that should only reach a specific ` +
        `named channel's members, use \`channels_post\` instead — \`broadcast\` always goes ` +
        `to general. You go by ${identity}. Teammates: ${teammateList}. Optionally attach ` +
        `files from your home (\`/${name}/...\`); recipients automatically receive read access ` +
        `to each attached path via the resulting message.`,
      inputSchema: {
        type: 'object',
        properties: {
          body: { type: 'string', description: 'The message body the team will receive.' },
          title: { type: 'string', description: 'Optional short title / subject line.' },
          level: {
            type: 'string',
            enum: [...LEVELS],
            description: "Optional severity; defaults to 'info'.",
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Optional list of file paths (e.g. ['/<name>/uploads/report.pdf']). Each must already exist and be readable to you. Use `fs_write` to upload a new file first.",
          },
        },
        required: ['body'],
      },
    },
    {
      name: 'send',
      description:
        `Send a direct message to a specific teammate on ${team.name}. Messages are ` +
        `private to you and the target. You go by ${identity}. Available names: ` +
        `${teammateList}. Directive: ${team.directive}. Optionally attach files from ` +
        `your home; the recipient receives read access to each attached path.`,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The name of the teammate to message.' },
          body: { type: 'string', description: 'The message body.' },
          title: { type: 'string', description: 'Optional short title / subject line.' },
          level: {
            type: 'string',
            enum: [...LEVELS],
            description: "Optional severity; defaults to 'info'.",
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of file paths to attach. Each must already exist and be readable to you.',
          },
        },
        required: ['to', 'body'],
      },
    },
    {
      name: 'channels_list',
      description:
        `List named channels you have access to on team ${team.name}. Returns each ` +
        `channel's slug, member count, and whether you're an admin or a regular member. ` +
        `\`general\` is implicit and always included — it's the team-wide channel that ` +
        `\`broadcast\` writes into. To post into any other channel use \`channels_post\`; ` +
        `to read scrollback use \`recent\` with \`channel=<slug>\`. You can only see ` +
        `channels you've been added to (or that are public to the whole team).`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'channels_post',
      description:
        `Post a message into a specific named channel on ${team.name}. Only members of ` +
        `that channel receive it; non-members do not. Use this for scoped conversations — ` +
        `e.g., a #frontend channel for frontend work — instead of broadcasting to the whole ` +
        `team. You must already be a member of the channel; ask a director to add you if ` +
        `not. You go by ${identity}. Optionally attach files from your home; channel members ` +
        `receive read access to each attached path. To find available channels run ` +
        `\`channels_list\`. To post to the team-wide general channel use \`broadcast\`.`,
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel slug (e.g. "frontend", "ops"). Must be a channel you belong to.',
          },
          body: { type: 'string', description: 'The message body.' },
          title: { type: 'string', description: 'Optional short title / subject line.' },
          level: {
            type: 'string',
            enum: [...LEVELS],
            description: "Optional severity; defaults to 'info'.",
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of file paths to attach. Each must already exist and be readable to you.',
          },
        },
        required: ['channel', 'body'],
      },
    },
    {
      name: 'recent',
      description:
        `Fetch recent messages from the ${team.name} team's general channel, a specific ` +
        `DM thread, or a named channel. You go by ${identity}. Team directive: ` +
        `${team.directive}. Pass exactly one of: \`with=NAME\` for DMs with that teammate, ` +
        `\`channel=SLUG\` for a named channel's scrollback, or no scope arg for the general ` +
        `team channel. Returns messages newest-first up to ${DEFAULT_RECENT_LIMIT} by ` +
        `default (max ${MAX_RECENT_LIMIT}).`,
      inputSchema: {
        type: 'object',
        properties: {
          with: {
            type: 'string',
            description:
              'Optional teammate name — narrows to DMs with that teammate. Mutually exclusive with `channel`.',
          },
          channel: {
            type: 'string',
            description:
              'Optional channel slug — narrows to messages tagged for that channel. Mutually exclusive with `with`.',
          },
          limit: {
            type: 'number',
            description: `Max messages to return (default ${DEFAULT_RECENT_LIMIT}, max ${MAX_RECENT_LIMIT}).`,
          },
        },
      },
    },
    {
      name: 'objectives_list',
      description:
        `List objectives you have a relationship with on team ${team.name} — ` +
        `assigned to you, originated by you, or objectives you're watching. ` +
        `Use \`status\` to filter (active | blocked | done | cancelled); omit to see all ` +
        `statuses. Objectives always carry a required outcome — use \`objectives_view\` ` +
        `for full detail including the watcher list and audit log.`,
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...OBJECTIVE_STATUSES],
            description:
              'Filter by lifecycle status. Omit to return all statuses. Defaults to no filter.',
          },
        },
      },
    },
    {
      name: 'objectives_view',
      description:
        `Fetch the full state of a single objective including its outcome, current status, ` +
        `block reason (if any), and the append-only event history. Use this before calling ` +
        `\`objectives_update\` or \`objectives_complete\` so you have the latest acceptance ` +
        `criteria fresh in context.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id (e.g. obj-xxxxx-y).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'objectives_update',
      description:
        `Transition an objective's status. Use status='blocked' + blockReason when you're ` +
        `stuck and need a director to intervene. Use status='active' to resume after a ` +
        `block. This tool is for STATE transitions only — for progress notes, questions, ` +
        `intermediate findings, or any conversation about the objective, use ` +
        `\`objectives_discuss\` to post into the objective's discussion thread. This tool ` +
        `never transitions to 'done' — call \`objectives_complete\` for that.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          status: {
            type: 'string',
            enum: ['active', 'blocked'],
            description:
              "Required new status. Use 'blocked' + blockReason when stuck; 'active' to resume.",
          },
          blockReason: {
            type: 'string',
            description: 'Required when status=blocked. Concisely describe what is blocking you.',
          },
        },
        required: ['id', 'status'],
      },
    },
    {
      name: 'objectives_discuss',
      description:
        `Post a message into an objective's dedicated discussion thread. The thread ` +
        `members are the originator, the assignee, and all directors on the team — ` +
        `everyone who needs visibility into the work gets the message immediately on ` +
        `their live stream. Use this for progress updates, questions, intermediate ` +
        `findings, coordination with the originator, or acknowledgments — anything that's ` +
        `conversation rather than a state transition. Every post is archived alongside ` +
        `the objective's event log and is visible in the web UI's inline thread view. ` +
        `Optionally attach files from your home; thread members receive automatic read access.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          body: {
            type: 'string',
            description: 'The message body to post into the objective thread.',
          },
          title: {
            type: 'string',
            description: 'Optional short title / subject line.',
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of file paths to attach. Each must already exist and be readable to you.',
          },
        },
        required: ['id', 'body'],
      },
    },
    {
      name: 'objectives_complete',
      description:
        `Mark an objective as done with a required result summary. Call ` +
        `\`objectives_view\` first to refresh the acceptance criteria in context. The ` +
        `\`result\` should explicitly address whether the stated outcome was met and link ` +
        `or describe the deliverable. Only the current assignee may call this.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          result: {
            type: 'string',
            description:
              'Required summary of what was delivered and how it meets the stated outcome.',
          },
        },
        required: ['id', 'result'],
      },
    },
    // ── Filesystem tools ───────────────────────────────────────────
    //
    // Every slot has a home at `/<name>/` with full read/write access;
    // directors may also read/write anywhere. Reads outside your home
    // require either a grant (the file was attached to a message you
    // can see) or director authority. See `fs_shared` for a list of
    // files shared with you.
    ...buildFilesystemTools(name),
    // ── UserType-gated tools ────────────────────────────────────────
    //
    // These tools appear in the agent's toolbox only when their slot
    // holds the corresponding authority on the team. The server
    // enforces the same rules independently — if an individual-contributor somehow
    // invokes one (stale MCP client, prompt injection, etc.) the
    // request 403s — but keeping them out of the tool list is the
    // first line of defense and the natural UX.
    //
    //   director + manager: objectives_create, objectives_cancel,
    //                           objectives_watchers
    //   director only:         objectives_reassign
    //
    // For managers, `cancel` and `watchers` descriptions call out
    // the "only objectives you originated" rule so the agent doesn't
    // try to touch someone else's objective and eat a 403.
    ...buildAuthorityTools(briefing),
  ];
}

function buildFilesystemTools(name: string): Tool[] {
  const home = `/${name}`;
  return [
    {
      name: 'fs_ls',
      description:
        `List the contents of a directory in the ac7 virtual filesystem. ` +
        `Your home is \`${home}\`; passing "/" lists the set of homes you can see. ` +
        `Entries include per-item metadata (kind, size, mime type, owner).`,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: `Absolute path to list. Defaults to your home ("${home}").`,
          },
        },
      },
    },
    {
      name: 'fs_stat',
      description: `Fetch metadata for a single path. Returns null if the path does not exist.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to stat.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_read',
      description:
        `Read the contents of a file. Text-like files (mime \`text/*\` or \`application/json\`) ` +
        `are returned as UTF-8; everything else is returned as base64. The response ` +
        `always includes the path, size, mime type, and either \`text\` or \`base64\`.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to read.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_write',
      description:
        `Upload a file. Pass EITHER \`text\` (UTF-8 string) or \`base64\` (for binary ` +
        `content), never both. Parent directories are auto-created. By default errors on ` +
        `collision; use collide="suffix" to auto-rename ("foo.txt" → "foo-1.txt") or ` +
        `"overwrite" to replace the existing file. You go by ${name}; your home is ${home}.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: `Absolute path to write (must sit under ${home} unless you are a director).`,
          },
          mimeType: {
            type: 'string',
            description: 'MIME type of the uploaded file, e.g. "text/plain" or "image/png".',
          },
          text: {
            type: 'string',
            description: 'UTF-8 content. Exclusive with `base64`.',
          },
          base64: {
            type: 'string',
            description: 'Base64-encoded binary content. Exclusive with `text`.',
          },
          collide: {
            type: 'string',
            enum: ['error', 'suffix', 'overwrite'],
            description: "Collision behavior (default 'error').",
          },
        },
        required: ['path', 'mimeType'],
      },
    },
    {
      name: 'fs_mkdir',
      description:
        `Create a directory. Pass recursive=true to auto-create missing parents. ` +
        `You go by ${name}; your home is ${home}.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute directory path to create.' },
          recursive: { type: 'boolean', description: 'Create missing parents (default false).' },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_rm',
      description:
        `Remove a file or directory. Directories require recursive=true if non-empty. ` +
        `Deletion cascades blob refcounts — the underlying content is purged only when the ` +
        `last referencing entry across the filesystem goes away.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to remove.' },
          recursive: {
            type: 'boolean',
            description: 'Cascade-delete directory contents (default false).',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'fs_mv',
      description:
        `Rename / move a file. Directory moves are not currently supported. ` +
        `Both the source and destination must sit under a tree you own (or you must be a director).`,
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Current absolute path.' },
          to: { type: 'string', description: 'Destination absolute path.' },
        },
        required: ['from', 'to'],
      },
    },
    {
      name: 'fs_shared',
      description:
        `List every file that has been shared with you via a message or objective ` +
        `attachment. Owner-private files from other slots never appear here — only ones ` +
        `a teammate explicitly attached to a thread you can see.`,
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function buildAuthorityTools(briefing: BriefingResponse): Tool[] {
  const { permissions, team, name, teammates } = briefing;
  const canCreate = permissions.includes('objectives.create');
  const canCancel = permissions.includes('objectives.cancel');
  const canWatch = permissions.includes('objectives.watch');
  const canReassign = permissions.includes('objectives.reassign');
  const canManageMembers = permissions.includes('members.manage');
  if (!canCreate && !canCancel && !canWatch && !canReassign && !canManageMembers) {
    return [];
  }

  const others = teammates.filter((t) => t.name !== name);
  const teammateList =
    others.length > 0
      ? others.map((t) => `${t.name} (${t.role.title})`).join(', ')
      : '(no other teammates currently defined)';

  const tools: Tool[] = [];

  if (!canCreate) return tools;

  // objectives_create — requires objectives.create
  tools.push({
    name: 'objectives_create',
    description:
      `Create and assign a new objective on team ${team.name}. You can direct work ` +
      `to any teammate — the assignee receives an immediate channel push with the title, ` +
      `outcome, and originator stamped as you (${name}). The \`outcome\` field is ` +
      `contractual: it must state the tangible, verifiable result that defines "done", not ` +
      `just a vague intent. Optionally include a \`body\` for additional context and ` +
      `\`watchers\` (a list of names) to loop other teammates into the discussion thread ` +
      `from the start. Available assignees: ${teammateList}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short, specific title for the objective.',
        },
        outcome: {
          type: 'string',
          description:
            'Required. The tangible result that defines "done" — what specifically must be true for this objective to be marked complete.',
        },
        body: {
          type: 'string',
          description:
            'Optional longer context — constraints, scoping notes, links, reproductions.',
        },
        assignee: {
          type: 'string',
          description: 'Name of the teammate who will execute this objective.',
        },
        watchers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of teammate names to add as watchers on the objective thread from the start.',
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of file paths to attach to the objective. Every thread member (originator, assignee, watchers, directors) receives automatic read access. Use `fs_write` to upload a file first.',
        },
      },
      required: ['title', 'outcome', 'assignee'],
    },
  });

  // objectives_cancel — originator always, or members with objectives.cancel
  const cancelScope = canCancel
    ? 'You can cancel any non-terminal objective on the team.'
    : "You can cancel objectives you originated (created). Attempting to cancel someone else's objective will be refused by the server.";
  tools.push({
    name: 'objectives_cancel',
    description:
      `Terminally cancel an objective. Use this when work is no longer needed — priorities ` +
      `shifted, the problem went away, the assignee is overwhelmed, etc. Cancellation is ` +
      `terminal: a cancelled objective cannot be resumed (create a fresh one if you change ` +
      `your mind). ${cancelScope} Include a \`reason\` so the assignee and any watchers ` +
      `understand why.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The objective id.' },
        reason: {
          type: 'string',
          description:
            'Optional but strongly recommended — explain why the objective is being cancelled.',
        },
      },
      required: ['id'],
    },
  });

  // objectives_watchers — originator always, or members with objectives.watch
  const watchersScope = canWatch
    ? 'You can manage watchers on any objective on the team.'
    : "You can manage watchers on objectives you originated. Attempting to modify watchers on someone else's objective will be refused by the server.";
  tools.push({
    name: 'objectives_watchers',
    description:
      `Add or remove watchers on an objective's discussion thread. Watchers receive every ` +
      `lifecycle event and every discussion post on the objective — use this to loop in a ` +
      `reviewer, a subject-matter expert, or anyone who should have awareness without ` +
      `being the assignee. Directors are implicit members and never need to be added. ` +
      `${watchersScope} Pass \`add\` and/or \`remove\` as arrays of names.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The objective id.' },
        add: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of teammate names to add as watchers.',
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of teammate names to remove from watchers.',
        },
      },
      required: ['id'],
    },
  });

  // objectives_reassign — requires objectives.reassign
  if (canReassign) {
    tools.push({
      name: 'objectives_reassign',
      description:
        `Reassign a non-terminal objective to a different teammate. Both the previous and ` +
        `new assignee receive channel pushes — the previous one so they know the ` +
        `objective left their plate, the new one so they know they now own it. Use this ` +
        `when the initial assignee is overwhelmed, the wrong skill match, or unavailable. ` +
        `Director-only: managers cannot reassign.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          to: {
            type: 'string',
            description: 'Name of the new assignee.',
          },
          note: {
            type: 'string',
            description: 'Optional note explaining the reassignment.',
          },
        },
        required: ['id', 'to'],
      },
    });
  }

  return tools;
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const args = rawArgs ?? {};
  try {
    switch (name) {
      case 'roster':
        return await handleRoster(brokerClient, briefing);
      case 'broadcast':
        return await handleBroadcast(args, brokerClient);
      case 'send':
        return await handleSend(args, brokerClient);
      case 'channels_list':
        return await handleChannelsList(brokerClient, briefing);
      case 'channels_post':
        return await handleChannelsPost(args, brokerClient);
      case 'recent':
        return await handleRecent(args, brokerClient, briefing);
      case 'objectives_list':
        return await handleObjectivesList(args, brokerClient, briefing);
      case 'objectives_view':
        return await handleObjectivesView(args, brokerClient);
      case 'objectives_update':
        return await handleObjectivesUpdate(args, brokerClient);
      case 'objectives_discuss':
        return await handleObjectivesDiscuss(args, brokerClient);
      case 'objectives_complete':
        return await handleObjectivesComplete(args, brokerClient);
      case 'objectives_create':
        return await handleObjectivesCreate(args, brokerClient, briefing);
      case 'objectives_cancel':
        return await handleObjectivesCancel(args, brokerClient, briefing);
      case 'objectives_watchers':
        return await handleObjectivesWatchers(args, brokerClient, briefing);
      case 'objectives_reassign':
        return await handleObjectivesReassign(args, brokerClient, briefing);
      case 'fs_ls':
        return await handleFsLs(args, brokerClient, briefing);
      case 'fs_stat':
        return await handleFsStat(args, brokerClient);
      case 'fs_read':
        return await handleFsRead(args, brokerClient);
      case 'fs_write':
        return await handleFsWrite(args, brokerClient);
      case 'fs_mkdir':
        return await handleFsMkdir(args, brokerClient);
      case 'fs_rm':
        return await handleFsRm(args, brokerClient);
      case 'fs_mv':
        return await handleFsMv(args, brokerClient);
      case 'fs_shared':
        return await handleFsShared(brokerClient);
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (err) {
    const ce = err as ClientError;
    if (ce?.name === 'ClientError') {
      return errorResult(`broker error ${ce.status}: ${ce.body || ce.message}`);
    }
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

async function handleRoster(
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const roster = await brokerClient.roster();
  const connectedByName = new Map(roster.connected.map((a) => [a.name, a.connected]));
  if (roster.teammates.length === 0) {
    return textResult('team roster: (no slots defined)');
  }
  const lines = roster.teammates.map((t) => {
    const conn = connectedByName.get(t.name) ?? 0;
    const self = t.name === briefing.name ? ' (you)' : '';
    const state = conn > 0 ? `connected=${conn}` : 'offline';
    const auth = t.permissions.includes('members.manage')
      ? ' [admin]'
      : t.permissions.includes('objectives.create')
        ? ' [operator]'
        : '';
    return `- ${t.name}${self} [${t.role}]${auth} ${state}`;
  });
  return textResult(`team ${briefing.team.name} roster:\n${lines.join('\n')}`);
}

async function handleBroadcast(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const body = typeof args.body === 'string' ? args.body : '';
  if (!body) return errorResult('broadcast: `body` is required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`broadcast: ${levelResult.error}`);
  const title = typeof args.title === 'string' ? args.title : null;
  const attachments = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachments) return errorResult(`broadcast: ${attachments.error}`);
  const result = await brokerClient.push({
    body,
    title,
    level: levelResult.level,
    ...(attachments.list.length > 0 ? { attachments: attachments.list } : {}),
  });
  const attachmentSummary =
    attachments.list.length > 0 ? ` attachments=${attachments.list.length}` : '';
  return textResult(
    `broadcast delivered: live=${result.delivery.live} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}${attachmentSummary}`,
  );
}

async function handleSend(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const to = typeof args.to === 'string' ? args.to : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!to || !body) return errorResult('send: `to` and `body` are required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`send: ${levelResult.error}`);
  const title = typeof args.title === 'string' ? args.title : null;
  const attachments = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachments) return errorResult(`send: ${attachments.error}`);
  const result = await brokerClient.push({
    to,
    body,
    title,
    level: levelResult.level,
    ...(attachments.list.length > 0 ? { attachments: attachments.list } : {}),
  });
  const attachmentSummary =
    attachments.list.length > 0 ? ` attachments=${attachments.list.length}` : '';
  return textResult(
    `delivered to ${to}: live=${result.delivery.live} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}${attachmentSummary}`,
  );
}

/**
 * Turn the agent's string[] of paths into the full Attachment
 * objects the broker expects. Resolves each via `fsStat`, reports
 * the first failure by path so the agent can fix the offender.
 */
async function resolveAttachmentPaths(
  raw: unknown,
  brokerClient: BrokerClient,
): Promise<{ list: Attachment[] } | { error: string }> {
  if (raw === undefined || raw === null) return { list: [] };
  if (!Array.isArray(raw)) {
    return { error: '`attachments` must be an array of paths' };
  }
  const list: Attachment[] = [];
  for (const p of raw) {
    if (typeof p !== 'string' || p.length === 0) {
      return { error: '`attachments` entries must be non-empty path strings' };
    }
    try {
      const entry = await brokerClient.fsStat(p);
      if (!entry) return { error: `attachment not found: ${p}` };
      if (entry.kind !== 'file') return { error: `attachment is a directory: ${p}` };
      if (entry.size === null || entry.mimeType === null) {
        return { error: `attachment is corrupt: ${p}` };
      }
      list.push({
        path: entry.path,
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
      });
    } catch (err) {
      return { error: `attachment lookup failed for ${p}: ${String(err)}` };
    }
  }
  return { list };
}

async function handleRecent(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const withOther = typeof args.with === 'string' ? args.with : undefined;
  const channelSlug = typeof args.channel === 'string' ? args.channel : undefined;
  if (withOther && channelSlug) {
    return errorResult('recent: pass `with` OR `channel`, not both');
  }
  const limitRaw = typeof args.limit === 'number' ? args.limit : DEFAULT_RECENT_LIMIT;
  const limit = Math.min(Math.max(Math.floor(limitRaw), 1), MAX_RECENT_LIMIT);

  // Channel scoping needs slug → id resolution. The history endpoint
  // matches on the immutable channel id (slugs are renameable and
  // existing messages keep referencing the original id).
  let channelId: string | undefined;
  if (channelSlug) {
    try {
      const ch = await brokerClient.getChannel(channelSlug);
      channelId = ch.channel.id;
    } catch (err) {
      const ce = err as ClientError;
      if (ce?.name === 'ClientError' && ce.status === 404) {
        return errorResult(
          `recent: no channel '${channelSlug}'. Use \`channels_list\` to see available channels.`,
        );
      }
      throw err;
    }
  }

  const messages = await brokerClient.history({
    ...(withOther ? { with: withOther } : {}),
    ...(channelId ? { channel: channelId } : {}),
    limit,
  });

  if (messages.length === 0) {
    const scope = withOther
      ? `DM with ${withOther}`
      : channelSlug
        ? `channel #${channelSlug}`
        : `${briefing.team.name} team channel`;
    return textResult(`recent: no messages in ${scope}`);
  }

  const header = withOther
    ? `recent DMs with ${withOther} (${messages.length}):`
    : channelSlug
      ? `recent #${channelSlug} (${messages.length}):`
      : `recent ${briefing.team.name} team chat (${messages.length}):`;
  const lines = messages.map((m) => formatRecentLine(m));
  return textResult(`${header}\n${lines.join('\n')}`);
}

async function handleChannelsList(
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const channels = await brokerClient.listChannels();
  if (channels.length === 0) {
    return textResult(`team ${briefing.team.name}: no channels defined.`);
  }
  // Show joined channels first, then any visible non-joined ones, so
  // the agent's "what can I post into right now" is at the top.
  const joined = channels.filter((c) => c.joined);
  const others = channels.filter((c) => !c.joined);
  const fmt = (c: (typeof channels)[number]): string => {
    const role = c.myRole ? ` [${c.myRole}]` : '';
    const archived = c.archivedAt !== null ? ' (archived)' : '';
    return `- #${c.slug}${role}${archived}  members=${c.memberCount}`;
  };
  const sections: string[] = [];
  if (joined.length > 0) {
    sections.push(`channels you belong to (${joined.length}):\n${joined.map(fmt).join('\n')}`);
  }
  if (others.length > 0) {
    sections.push(
      `other visible channels (${others.length}, post requires joining first):\n` +
        others.map(fmt).join('\n'),
    );
  }
  return textResult(sections.join('\n\n'));
}

async function handleChannelsPost(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const slug = typeof args.channel === 'string' ? args.channel : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!slug) return errorResult('channels_post: `channel` is required (the channel slug)');
  if (!body) return errorResult('channels_post: `body` is required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`channels_post: ${levelResult.error}`);
  const title = typeof args.title === 'string' ? args.title : null;
  const attachments = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachments) return errorResult(`channels_post: ${attachments.error}`);

  // Resolve slug → id. The push routing on the server side keys on
  // `data.thread = 'chan:<id>'`, not slug, so renames don't break
  // mid-conversation references. The server also enforces that the
  // sender is a member of the channel; we surface a friendlier error
  // up front by checking the client-side membership flag, but the
  // 403 is the source of truth.
  let channelId: string;
  try {
    const ch = await brokerClient.getChannel(slug);
    channelId = ch.channel.id;
    if (!ch.channel.joined) {
      return errorResult(
        `channels_post: you are not a member of #${slug}. Ask a director to add you, or use \`broadcast\` for the general channel.`,
      );
    }
  } catch (err) {
    const ce = err as ClientError;
    if (ce?.name === 'ClientError' && ce.status === 404) {
      return errorResult(
        `channels_post: no channel '${slug}'. Use \`channels_list\` to see available channels.`,
      );
    }
    throw err;
  }

  const result = await brokerClient.push({
    body,
    title,
    level: levelResult.level,
    data: { thread: `chan:${channelId}` },
    ...(attachments.list.length > 0 ? { attachments: attachments.list } : {}),
  });
  const attachmentSummary =
    attachments.list.length > 0 ? ` attachments=${attachments.list.length}` : '';
  return textResult(
    `posted to #${slug}: live=${result.delivery.live} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}${attachmentSummary}`,
  );
}

// ── Objectives handlers ────────────────────────────────────────────

async function handleObjectivesList(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const status = typeof args.status === 'string' ? (args.status as ObjectiveStatus) : undefined;
  if (status !== undefined && !OBJECTIVE_STATUSES.includes(status)) {
    return errorResult(
      `objectives_list: invalid status '${String(args.status)}'. Must be one of: ${OBJECTIVE_STATUSES.join(', ')}.`,
    );
  }
  const list = await brokerClient.listObjectives({
    assignee: briefing.name,
    ...(status ? { status } : {}),
  });
  if (list.length === 0) {
    return textResult(
      status
        ? `no ${status} objectives assigned to ${briefing.name}`
        : `no objectives assigned to ${briefing.name}`,
    );
  }
  const lines = list.map(
    (o) =>
      `- ${o.id} [${o.status}] ${o.title}\n` +
      `    outcome: ${o.outcome}\n` +
      `    updated: ${formatAgentTimestamp(o.updatedAt)} (${formatRelativeAge(o.updatedAt)})`,
  );
  return textResult(`objectives for ${briefing.name}:\n${lines.join('\n')}`);
}

async function handleObjectivesView(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_view: `id` is required');
  const { objective, events } = await brokerClient.getObjective(id);
  const lines: string[] = [
    `${objective.id} [${objective.status}] ${objective.title}`,
    `assignee: ${objective.assignee}  originator: ${objective.originator}`,
    `outcome: ${objective.outcome}`,
    `created: ${formatAgentTimestamp(objective.createdAt)} (${formatRelativeAge(objective.createdAt)})`,
    `updated: ${formatAgentTimestamp(objective.updatedAt)} (${formatRelativeAge(objective.updatedAt)})`,
  ];
  if (objective.completedAt) {
    lines.push(
      `completed: ${formatAgentTimestamp(objective.completedAt)} (${formatRelativeAge(objective.completedAt)})`,
    );
  }
  if (objective.watchers.length > 0) {
    lines.push(`watchers: ${objective.watchers.join(', ')}`);
  }
  if (objective.body) lines.push(`body: ${objective.body}`);
  if (objective.blockReason) lines.push(`block reason: ${objective.blockReason}`);
  if (objective.result) lines.push(`result: ${objective.result}`);
  lines.push('events:');
  for (const ev of events) {
    const ts = formatAgentTimestamp(ev.ts);
    const age = formatRelativeAge(ev.ts);
    lines.push(`  ${ts} (${age}) ${ev.actor} ${ev.kind} ${JSON.stringify(ev.payload)}`);
  }
  return textResult(lines.join('\n'));
}

async function handleObjectivesUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_update: `id` is required');
  const statusArg = typeof args.status === 'string' ? args.status : undefined;
  if (statusArg !== 'active' && statusArg !== 'blocked') {
    return errorResult(
      `objectives_update: status is required and must be 'active' or 'blocked' (use objectives_complete for 'done' and objectives_discuss for progress notes)`,
    );
  }
  const blockReason = typeof args.blockReason === 'string' ? args.blockReason : undefined;
  if (statusArg === 'blocked' && (!blockReason || blockReason.trim().length === 0)) {
    return errorResult('objectives_update: blockReason is required when status=blocked');
  }
  const updated = await brokerClient.updateObjective(id, {
    status: statusArg,
    ...(blockReason !== undefined ? { blockReason } : {}),
  });
  return textResult(
    `updated ${updated.id}: status=${updated.status}${
      updated.blockReason ? ` blockReason="${updated.blockReason}"` : ''
    }`,
  );
}

async function handleObjectivesDiscuss(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!id || !body) {
    return errorResult('objectives_discuss: both `id` and `body` are required');
  }
  const title = typeof args.title === 'string' ? args.title : undefined;
  const attachmentsResult = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachmentsResult) {
    return errorResult(`objectives_discuss: ${attachmentsResult.error}`);
  }
  const message = await brokerClient.discussObjective(id, {
    body,
    ...(title !== undefined ? { title } : {}),
    ...(attachmentsResult.list.length > 0 ? { attachments: attachmentsResult.list } : {}),
  });
  const attachmentNote =
    attachmentsResult.list.length > 0 ? ` attachments=${attachmentsResult.list.length}` : '';
  return textResult(
    `posted to objective ${id} thread: msg=${message.id}${attachmentNote} (fanned out to thread members)`,
  );
}

async function handleObjectivesComplete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  const result = typeof args.result === 'string' ? args.result : '';
  if (!id || !result) {
    return errorResult('objectives_complete: both `id` and `result` are required');
  }
  const updated = await brokerClient.completeObjective(id, result);
  return textResult(`completed ${updated.id}. Result recorded and originator notified.`);
}

// ── UserType-gated handlers (defensive re-checks) ────────────────────
// The server is authoritative on permissions — if an individual-contributor somehow
// invokes one of these tools we'll get a 403 at the broker. But a
// fast local authority check gives a better error message and avoids
// a round trip. The tool list generation already prevents individual-contributors
// from seeing these tools; the handler-level check defends against a
// stale MCP client or prompt injection that name-calls the tool.

async function handleObjectivesCreate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  if (
    !briefing.permissions.includes('members.manage') &&
    !briefing.permissions.includes('objectives.create') &&
    !briefing.permissions.includes('objectives.create')
  ) {
    return errorResult('objectives_create: requires director or manager authority on the team');
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const outcome = typeof args.outcome === 'string' ? args.outcome.trim() : '';
  const assignee = typeof args.assignee === 'string' ? args.assignee : '';
  if (!title) return errorResult('objectives_create: `title` is required');
  if (!outcome) return errorResult('objectives_create: `outcome` is required');
  if (!assignee) return errorResult('objectives_create: `assignee` is required');
  const body = typeof args.body === 'string' ? args.body : undefined;
  // Watchers: accept only an array of strings; silently filter out
  // anything else so a misshapen payload doesn't poison the request.
  let watchers: string[] | undefined;
  if (Array.isArray(args.watchers)) {
    watchers = args.watchers.filter((v): v is string => typeof v === 'string');
  }
  const attachmentsResult = await resolveAttachmentPaths(args.attachments, brokerClient);
  if ('error' in attachmentsResult) {
    return errorResult(`objectives_create: ${attachmentsResult.error}`);
  }
  const created = await brokerClient.createObjective({
    title,
    outcome,
    assignee,
    ...(body ? { body } : {}),
    ...(watchers && watchers.length > 0 ? { watchers } : {}),
    ...(attachmentsResult.list.length > 0 ? { attachments: attachmentsResult.list } : {}),
  });
  return textResult(
    `created ${created.id} assigned to ${created.assignee}: ${created.title}\n` +
      `outcome: ${created.outcome}\n` +
      (created.watchers.length > 0
        ? `watchers: ${created.watchers.join(', ')}`
        : 'watchers: (none)') +
      (created.attachments.length > 0
        ? `\nattachments: ${created.attachments.map((a) => a.path).join(', ')}`
        : ''),
  );
}

async function handleObjectivesCancel(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  if (
    !briefing.permissions.includes('members.manage') &&
    !briefing.permissions.includes('objectives.create') &&
    !briefing.permissions.includes('objectives.create')
  ) {
    return errorResult('objectives_cancel: requires director or manager authority on the team');
  }
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_cancel: `id` is required');
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  const updated = await brokerClient.cancelObjective(id, reason ? { reason } : {});
  return textResult(`cancelled ${updated.id}: ${updated.title}`);
}

async function handleObjectivesWatchers(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  if (
    !briefing.permissions.includes('members.manage') &&
    !briefing.permissions.includes('objectives.create') &&
    !briefing.permissions.includes('objectives.create')
  ) {
    return errorResult('objectives_watchers: requires director or manager authority on the team');
  }
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_watchers: `id` is required');
  const add = Array.isArray(args.add)
    ? args.add.filter((v): v is string => typeof v === 'string')
    : undefined;
  const remove = Array.isArray(args.remove)
    ? args.remove.filter((v): v is string => typeof v === 'string')
    : undefined;
  if ((!add || add.length === 0) && (!remove || remove.length === 0)) {
    return errorResult('objectives_watchers: must include at least one of `add` or `remove`');
  }
  const updated = await brokerClient.updateObjectiveWatchers(id, {
    ...(add && add.length > 0 ? { add } : {}),
    ...(remove && remove.length > 0 ? { remove } : {}),
  });
  return textResult(
    `updated ${updated.id} watchers: ${
      updated.watchers.length > 0 ? updated.watchers.join(', ') : '(none)'
    }`,
  );
}

async function handleObjectivesReassign(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  if (!briefing.permissions.includes('members.manage')) {
    return errorResult('objectives_reassign: requires director authority on the team');
  }
  const id = typeof args.id === 'string' ? args.id : '';
  const to = typeof args.to === 'string' ? args.to : '';
  if (!id || !to) return errorResult('objectives_reassign: both `id` and `to` are required');
  const note = typeof args.note === 'string' ? args.note : undefined;
  const updated = await brokerClient.reassignObjective(id, {
    to,
    ...(note ? { note } : {}),
  });
  return textResult(`reassigned ${updated.id} to ${updated.assignee}: ${updated.title}`);
}

// ── Filesystem handlers ────────────────────────────────────────────

const TEXT_MIME_RE = /^(text\/|application\/json\b|application\/xml\b)/i;

function formatFsEntry(entry: FsEntry): string {
  if (entry.kind === 'directory') {
    return `d  ${entry.path}/  owner=${entry.owner}`;
  }
  const sizeKb = entry.size !== null ? `${Math.max(entry.size, 0)}B` : '?';
  return `f  ${entry.path}  ${sizeKb}  ${entry.mimeType ?? 'unknown'}  owner=${entry.owner}`;
}

async function handleFsLs(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const raw = typeof args.path === 'string' ? args.path : `/${briefing.name}`;
  const entries = await brokerClient.fsList(raw);
  if (entries.length === 0) {
    return textResult(`${raw}: (empty)`);
  }
  return textResult(`${raw}:\n${entries.map((e) => `  ${formatFsEntry(e)}`).join('\n')}`);
}

async function handleFsStat(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return errorResult('fs_stat: `path` is required');
  const entry = await brokerClient.fsStat(path);
  if (!entry) return textResult(`${path}: not found`);
  return textResult(formatFsEntry(entry));
}

async function handleFsRead(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return errorResult('fs_read: `path` is required');
  const entry = await brokerClient.fsStat(path);
  if (!entry) return errorResult(`fs_read: not found: ${path}`);
  if (entry.kind !== 'file') return errorResult(`fs_read: not a file: ${path}`);
  const blob = await brokerClient.fsRead(path);
  const buffer = Buffer.from(await blob.arrayBuffer());
  const mime = entry.mimeType ?? 'application/octet-stream';
  const header = `path=${entry.path}\nsize=${entry.size ?? 0}\nmime=${mime}`;
  if (TEXT_MIME_RE.test(mime)) {
    return textResult(`${header}\ntext:\n${buffer.toString('utf8')}`);
  }
  return textResult(`${header}\nbase64:\n${buffer.toString('base64')}`);
}

async function handleFsWrite(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  const mimeType = typeof args.mimeType === 'string' ? args.mimeType : '';
  if (!path || !mimeType) return errorResult('fs_write: `path` and `mimeType` are required');
  const text = typeof args.text === 'string' ? args.text : undefined;
  const b64 = typeof args.base64 === 'string' ? args.base64 : undefined;
  if ((text === undefined && b64 === undefined) || (text !== undefined && b64 !== undefined)) {
    return errorResult('fs_write: provide exactly one of `text` or `base64`');
  }
  const collideRaw = typeof args.collide === 'string' ? args.collide : 'error';
  if (collideRaw !== 'error' && collideRaw !== 'overwrite' && collideRaw !== 'suffix') {
    return errorResult(`fs_write: invalid collide strategy '${collideRaw}'`);
  }
  const source =
    text !== undefined ? Buffer.from(text, 'utf8') : Buffer.from(b64 as string, 'base64');
  const result = await brokerClient.fsWrite({
    path,
    mimeType,
    source: new Uint8Array(source),
    collision: collideRaw,
  });
  const renamedNote = result.renamed ? ` (renamed to ${result.entry.path})` : '';
  return textResult(
    `wrote ${result.entry.path}${renamedNote}: size=${result.entry.size ?? source.length} mime=${result.entry.mimeType}`,
  );
}

async function handleFsMkdir(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return errorResult('fs_mkdir: `path` is required');
  const recursive = args.recursive === true;
  const entry = await brokerClient.fsMkdir(path, recursive);
  return textResult(`mkdir ${entry.path} (owner=${entry.owner})`);
}

async function handleFsRm(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return errorResult('fs_rm: `path` is required');
  const recursive = args.recursive === true;
  await brokerClient.fsRm(path, recursive);
  return textResult(`rm ${path}${recursive ? ' (recursive)' : ''}`);
}

async function handleFsMv(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const from = typeof args.from === 'string' ? args.from : '';
  const to = typeof args.to === 'string' ? args.to : '';
  if (!from || !to) return errorResult('fs_mv: both `from` and `to` are required');
  const entry = await brokerClient.fsMv(from, to);
  return textResult(`mv ${from} → ${entry.path}`);
}

async function handleFsShared(brokerClient: BrokerClient): Promise<CallToolResult> {
  const entries = await brokerClient.fsShared();
  if (entries.length === 0) {
    return textResult('no files currently shared with you');
  }
  return textResult(
    `files shared with you:\n${entries.map((e) => `  ${formatFsEntry(e)}`).join('\n')}`,
  );
}

function formatRecentLine(m: Message): string {
  const ts = formatAgentTimestamp(m.ts);
  const from = m.from ?? '?';
  const target = m.to ? ` → ${m.to}` : '';
  const title = m.title ? ` [${m.title}]` : '';
  return `  ${ts} ${from}${target}${title}: ${m.body}`;
}

/**
 * Format a unix-ms timestamp for agent consumption. Shape:
 *   04/15/26 14:23:45 UTC
 *
 * Rationale: agents receive timestamps in channel metadata and tool
 * output inline with text they're reading. A raw unix-ms number or a
 * bare `HH:MM` string forces them to run a tool (or guess) to figure
 * out when something happened. This format is:
 *
 *   - Unambiguous about timezone (UTC label)
 *   - Dated (mm/dd/yy so the agent can tell "today" vs "three weeks ago")
 *   - Precise to the second (distinguishes near-simultaneous events,
 *     which happens in rapid objective lifecycle transitions)
 *   - Fixed-width (21 chars) so columns line up cleanly in tables
 *
 * We intentionally don't include milliseconds — the second granularity
 * is enough for human-reasoning and avoids noise. We don't include
 * day-of-week because it's redundant with the date and bloats the line.
 */
export function formatAgentTimestamp(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yy} ${hh}:${min}:${ss} UTC`;
}

/**
 * Format a relative time hint from a unix-ms timestamp. Used in the
 * objective event log to answer "how long ago was that?" at a glance
 * without making the agent do subtraction. Caller supplies `now` so
 * tests can pin time; production uses Date.now.
 *
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "future".
 */
export function formatRelativeAge(ms: number, now: number = Date.now()): string {
  const delta = now - ms;
  if (delta < 0) return 'future';
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

function parseLevel(
  raw: unknown,
): { level: LogLevel; error?: undefined } | { error: string; level?: undefined } {
  if (raw === undefined || raw === null) return { level: 'info' };
  if (isLogLevel(raw)) return { level: raw };
  return {
    error: `unknown level '${String(raw)}'. Must be one of: ${LEVELS.join(', ')}.`,
  };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
