/**
 * Runtime validators for the ac7 wire protocol.
 *
 * Both the server and the client use these to validate messages crossing
 * the network boundary. Pulling from `@agentc7/sdk/schemas` keeps zod
 * as an explicit runtime dependency for consumers that want it.
 */

import { z } from 'zod';
import { PERMISSIONS } from './types.js';

export const LogLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']);

/**
 * Member names — alphanumeric plus `.`, `_`, `-`, 1-128 chars.
 */
export const NameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, 'name must be alphanumeric with . _ - allowed');

/** One of the seven gated permissions. Extend `PERMISSIONS` to grow. */
export const PermissionSchema = z.enum(PERMISSIONS);

/**
 * Team-level named permission bundles. Keys are preset names
 * (short freeform strings), values are arrays of resolved leaf
 * permissions. Members reference preset names; the server resolves
 * at load time.
 */
export const PermissionPresetsSchema = z.record(
  z.string().min(1).max(64),
  z.array(PermissionSchema),
);

/**
 * A role is a short label + prose description, per-member. Unlike
 * the previous role model, there's no instructions template here —
 * instructions are personal to the member.
 */
export const RoleSchema = z.object({
  title: z.string().min(1).max(64),
  description: z.string().max(512).default(''),
});

export const TeamSchema = z.object({
  name: z.string().min(1).max(128),
  directive: z.string().min(1).max(512),
  brief: z.string().max(4096).default(''),
  permissionPresets: PermissionPresetsSchema.default({}),
});

/**
 * Public projection of a team member — what teammates see in the
 * roster and briefing. Omits `instructions` (private to the member).
 */
export const TeammateSchema = z.object({
  name: NameSchema,
  role: RoleSchema,
  permissions: z.array(PermissionSchema),
});

/**
 * Full member record — includes the private `instructions` field.
 * Returned from self-scope briefing and admin-scope member listings.
 */
export const MemberSchema = TeammateSchema.extend({
  instructions: z.string().max(8192).default(''),
});

/**
 * Filesystem path: absolute, Unix-like, enforced shape matches the
 * server's `normalizePath` rules (alphanumerics + . _ - and single
 * spaces, no traversal). The server re-normalizes on ingest so this
 * schema is a first-pass filter only.
 */
export const FsPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(
    /^\/(?:[a-zA-Z0-9._\- ]+(?:\/[a-zA-Z0-9._\- ]+)*)?$/,
    'path must be absolute Unix-style with [a-zA-Z0-9._- ] segments',
  )
  .refine((p) => !p.split('/').some((s) => s === '.' || s === '..'), {
    message: 'path may not contain . or .. segments',
  });

export const AttachmentSchema = z.object({
  path: FsPathSchema,
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(255),
});

export const PushPayloadSchema = z.object({
  to: NameSchema.nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  body: z
    .string()
    .min(1)
    .max(64 * 1024),
  level: LogLevelSchema.default('info'),
  data: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(AttachmentSchema).max(64).optional(),
});

export const MessageSchema = z.object({
  id: z.string(),
  ts: z.number(),
  to: NameSchema.nullable(),
  from: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string(),
  level: LogLevelSchema,
  data: z.record(z.string(), z.unknown()),
  attachments: z.array(AttachmentSchema).default([]),
});

export const PresenceSchema = z.object({
  name: NameSchema,
  connected: z.number().int().nonnegative(),
  createdAt: z.number(),
  lastSeen: z.number(),
  role: RoleSchema.nullable(),
});

export const DeliveryReportSchema = z.object({
  live: z.number().int().nonnegative(),
  targets: z.number().int().nonnegative(),
});

export const PushResultSchema = z.object({
  delivery: DeliveryReportSchema,
  message: MessageSchema,
});

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});

// ───────────────────────── Objectives ─────────────────────────

export const ObjectiveStatusSchema = z.enum(['active', 'blocked', 'done', 'cancelled']);

export const ObjectiveSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().max(4096).default(''),
  outcome: z.string().min(1).max(2048),
  status: ObjectiveStatusSchema,
  assignee: NameSchema,
  originator: NameSchema,
  watchers: z.array(NameSchema).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  result: z.string().nullable(),
  blockReason: z.string().nullable(),
  attachments: z.array(AttachmentSchema).default([]),
});

export const ObjectiveEventKindSchema = z.enum([
  'assigned',
  'blocked',
  'unblocked',
  'completed',
  'cancelled',
  'reassigned',
  'watcher_added',
  'watcher_removed',
]);

export const ObjectiveEventSchema = z.object({
  objectiveId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  actor: NameSchema,
  kind: ObjectiveEventKindSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const CreateObjectiveRequestSchema = z.object({
  title: z.string().min(1).max(200),
  outcome: z.string().min(1).max(2048),
  body: z.string().max(4096).optional(),
  assignee: NameSchema,
  watchers: z.array(NameSchema).max(64).optional(),
  attachments: z.array(AttachmentSchema).max(64).optional(),
});

export const UpdateWatchersRequestSchema = z
  .object({
    add: z.array(NameSchema).max(64).optional(),
    remove: z.array(NameSchema).max(64).optional(),
  })
  .refine(
    (v) => (v.add && v.add.length > 0) || (v.remove && v.remove.length > 0),
    'must include at least one of: add, remove',
  );

export const UpdateObjectiveRequestSchema = z
  .object({
    status: z.enum(['active', 'blocked']).optional(),
    blockReason: z.string().max(2048).optional(),
  })
  .refine(
    (v) => v.status !== undefined || v.blockReason !== undefined,
    'update must include at least one of: status, blockReason',
  );

export const DiscussObjectiveRequestSchema = z.object({
  body: z
    .string()
    .min(1)
    .max(16 * 1024),
  title: z.string().max(200).optional(),
  attachments: z.array(AttachmentSchema).max(64).optional(),
});

export const CompleteObjectiveRequestSchema = z.object({
  result: z.string().min(1).max(4096),
});

export const CancelObjectiveRequestSchema = z.object({
  reason: z.string().max(2048).optional(),
});

export const ReassignObjectiveRequestSchema = z.object({
  to: NameSchema,
  note: z.string().max(2048).optional(),
});

export const ListObjectivesResponseSchema = z.object({
  objectives: z.array(ObjectiveSchema),
});

export const GetObjectiveResponseSchema = z.object({
  objective: ObjectiveSchema,
  events: z.array(ObjectiveEventSchema),
});

export const ListObjectivesQuerySchema = z.object({
  assignee: NameSchema.optional(),
  status: ObjectiveStatusSchema.optional(),
});

// ───────────────────────── Channels ─────────────────────────
//
// Slack-style named team threads. Identified by an opaque immutable
// `id`; addressed in URLs and the UI by a mutable `slug`. Messages
// reference channels by id via `data.thread = 'chan:<id>'` so a
// rename never orphans history.

/**
 * Channel slug: 1–32 lowercase letters/digits/dashes, must start +
 * end alphanumeric, no consecutive dashes. Mirrors `validateSlug` on
 * the server.
 */
export const ChannelSlugSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/,
    'slug must be lowercase letters/digits/dashes, no consecutive dashes, no leading/trailing dash',
  );

export const ChannelMemberRoleSchema = z.enum(['admin', 'member']);

export const ChannelSchema = z.object({
  id: z.string().min(1),
  slug: ChannelSlugSchema,
  createdBy: z.string(),
  createdAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
});

export const ChannelMemberSchema = z.object({
  channelId: z.string().min(1),
  memberName: NameSchema,
  role: ChannelMemberRoleSchema,
  joinedAt: z.number().int().nonnegative(),
});

/**
 * One row in the per-viewer channel list. `joined` reflects whether
 * the caller is a member; `myRole` is non-null only when joined.
 * `general` is special-cased: every viewer sees `joined: true,
 * myRole: 'member'`. The list also reports `memberCount` so the UI
 * can render `(N members)` next to channel names.
 */
export const ChannelSummarySchema = ChannelSchema.extend({
  joined: z.boolean(),
  myRole: ChannelMemberRoleSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
});

export const ListChannelsResponseSchema = z.object({
  channels: z.array(ChannelSummarySchema),
});

export const GetChannelResponseSchema = z.object({
  channel: ChannelSummarySchema,
  members: z.array(ChannelMemberSchema),
});

export const CreateChannelRequestSchema = z.object({
  slug: ChannelSlugSchema,
});

export const RenameChannelRequestSchema = z.object({
  slug: ChannelSlugSchema,
});

export const AddChannelMemberRequestSchema = z.object({
  member: NameSchema,
  role: ChannelMemberRoleSchema.default('member'),
});

// ───────────────────────── Trace entries ─────────────────────
//
// Trace entries are produced by the runner's MITM proxy as
// captured HTTP/1.1 exchanges. They flow through the member
// activity stream (below) rather than a per-objective table.
// Schemas stay permissive because Anthropic's API shape evolves
// and opaque HTTP records can carry anything. The server stores
// them as JSON; the web UI walks them with its own renderer.

const AnthropicContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.unknown(),
    isError: z.boolean(),
  }),
  z.object({ type: z.literal('image'), mediaType: z.string().nullable() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('unknown'), raw: z.unknown() }),
]);

const AnthropicMessageSchema = z.object({
  role: z.string(),
  content: z.array(AnthropicContentBlockSchema),
});

const AnthropicUsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheCreationInputTokens: z.number().nullable(),
  cacheReadInputTokens: z.number().nullable(),
});

const AnthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
});

export const TraceEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anthropic_messages'),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
    request: z.object({
      model: z.string().nullable(),
      maxTokens: z.number().nullable(),
      temperature: z.number().nullable(),
      system: z.string().nullable(),
      messages: z.array(AnthropicMessageSchema),
      tools: z.array(AnthropicToolSchema).nullable(),
    }),
    response: z
      .object({
        stopReason: z.string().nullable(),
        stopSequence: z.string().nullable(),
        messages: z.array(AnthropicMessageSchema),
        usage: AnthropicUsageSchema.nullable(),
        status: z.number().nullable(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal('opaque_http'),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
    host: z.string(),
    method: z.string(),
    url: z.string(),
    status: z.number().nullable(),
    requestHeaders: z.record(z.string(), z.string()),
    responseHeaders: z.record(z.string(), z.string()),
    requestBodyPreview: z.string().nullable(),
    responseBodyPreview: z.string().nullable(),
  }),
]);

// Pull out the two concrete entry variants so activity events
// can reference them directly (an LLM exchange carries an
// AnthropicMessagesEntry; an opaque HTTP event carries an
// OpaqueHttpEntry).
const AnthropicMessagesEntrySchema = z.object({
  kind: z.literal('anthropic_messages'),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  request: z.object({
    model: z.string().nullable(),
    maxTokens: z.number().nullable(),
    temperature: z.number().nullable(),
    system: z.string().nullable(),
    messages: z.array(AnthropicMessageSchema),
    tools: z.array(AnthropicToolSchema).nullable(),
  }),
  response: z
    .object({
      stopReason: z.string().nullable(),
      stopSequence: z.string().nullable(),
      messages: z.array(AnthropicMessageSchema),
      usage: AnthropicUsageSchema.nullable(),
      status: z.number().nullable(),
    })
    .nullable(),
});

const OpaqueHttpEntrySchema = z.object({
  kind: z.literal('opaque_http'),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  host: z.string(),
  method: z.string(),
  url: z.string(),
  status: z.number().nullable(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()),
  requestBodyPreview: z.string().nullable(),
  responseBodyPreview: z.string().nullable(),
});

// ───────────────────────── Activity stream ──────────────────────

export const ActivityKindSchema = z.enum([
  'objective_open',
  'objective_close',
  'llm_exchange',
  'opaque_http',
]);

export const ActivityEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('objective_open'),
    ts: z.number().int().nonnegative(),
    objectiveId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('objective_close'),
    ts: z.number().int().nonnegative(),
    objectiveId: z.string().min(1),
    result: z.enum(['done', 'cancelled', 'reassigned', 'runner_shutdown']),
  }),
  z.object({
    kind: z.literal('llm_exchange'),
    ts: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    entry: AnthropicMessagesEntrySchema,
  }),
  z.object({
    kind: z.literal('opaque_http'),
    ts: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    entry: OpaqueHttpEntrySchema,
  }),
]);

export const ActivityRowSchema = z.object({
  id: z.number().int().nonnegative(),
  memberName: NameSchema,
  event: ActivityEventSchema,
  createdAt: z.number().int().nonnegative(),
});

export const UploadActivityRequestSchema = z.object({
  events: z.array(ActivityEventSchema).min(1).max(500),
});

export const UploadActivityResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
});

export const ListActivityResponseSchema = z.object({
  activity: z.array(ActivityRowSchema),
});

export const ListActivityQuerySchema = z.object({
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  kind: z.union([ActivityKindSchema, z.array(ActivityKindSchema)]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

// ───────────────────────── Members ────────────────────────────

/**
 * Permission list as sent over the wire — each entry is either a
 * preset name (resolved by the server) or a leaf permission. The
 * server validates every entry resolves.
 */
const PermissionRefListSchema = z.array(z.string().min(1).max(64)).max(32);

export const CreateMemberRequestSchema = z.object({
  name: NameSchema,
  role: RoleSchema,
  instructions: z.string().max(8192).default(''),
  permissions: PermissionRefListSchema,
});

export const UpdateMemberRequestSchema = z
  .object({
    role: RoleSchema.optional(),
    instructions: z.string().max(8192).optional(),
    permissions: PermissionRefListSchema.optional(),
  })
  .refine(
    (v) => v.role !== undefined || v.instructions !== undefined || v.permissions !== undefined,
    { message: 'update must include at least one of: role, instructions, permissions' },
  );

export const CreateMemberResponseSchema = z.object({
  member: TeammateSchema,
  token: z.string(),
});

export const ListMembersResponseSchema = z.object({
  members: z.array(MemberSchema),
});

export const RotateTokenResponseSchema = z.object({
  token: z.string(),
});

export const EnrollTotpResponseSchema = z.object({
  totpSecret: z.string(),
  totpUri: z.string(),
});

// ───────────────────────── Briefing + session ─────────────────

export const BriefingResponseSchema = MemberSchema.extend({
  team: TeamSchema,
  teammates: z.array(TeammateSchema),
  openObjectives: z.array(ObjectiveSchema),
});

export const RosterResponseSchema = z.object({
  teammates: z.array(TeammateSchema),
  connected: z.array(PresenceSchema),
});

export const HistoryResponseSchema = z.object({
  messages: z.array(MessageSchema),
});

export const TotpLoginRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'code must be exactly 6 digits'),
  member: NameSchema.optional(),
});

export const SessionResponseSchema = z.object({
  member: NameSchema,
  role: RoleSchema,
  permissions: z.array(PermissionSchema),
  expiresAt: z.number().int().positive(),
});

export const VapidPublicKeyResponseSchema = z.object({
  publicKey: z.string().min(1),
});

export const PushSubscriptionPayloadSchema = z.object({
  endpoint: z.string().url('endpoint must be a URL').max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

export const PushSubscriptionResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  endpoint: z.string(),
  createdAt: z.number().int().nonnegative(),
});

// ───────────────────────── Filesystem ─────────────────────────

export const FsEntryKindSchema = z.enum(['file', 'directory']);

export const FsEntrySchema = z.object({
  path: FsPathSchema,
  name: z.string().min(1).max(255),
  kind: FsEntryKindSchema,
  owner: NameSchema,
  size: z.number().int().nonnegative().nullable(),
  mimeType: z.string().max(255).nullable(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'hash must be sha256 hex')
    .nullable(),
  createdAt: z.number().int().nonnegative(),
  createdBy: NameSchema,
  updatedAt: z.number().int().nonnegative(),
});

export const FsListResponseSchema = z.object({
  entries: z.array(FsEntrySchema),
});

export const FsEntryResponseSchema = z.object({
  entry: FsEntrySchema,
});

export const FsWriteResponseSchema = z.object({
  entry: FsEntrySchema,
  renamed: z.boolean(),
});

export const FsMkdirRequestSchema = z.object({
  path: FsPathSchema,
  recursive: z.boolean().optional(),
});

export const FsMoveRequestSchema = z.object({
  from: FsPathSchema,
  to: FsPathSchema,
});

export const FsWriteCollisionSchema = z.enum(['error', 'overwrite', 'suffix']);
