/**
 * Pure TypeScript types for the ac7 wire protocol.
 *
 * Zero runtime dependencies. Consumers that only want types should import
 * from `@agentc7/sdk/types`.
 */

export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

// ─────────────────────────── Permissions ──────────────────────────────

/**
 * The set of elevated actions gated by membership policy. Baseline
 * participation (DM, posting to the primary thread, taking an assigned
 * objective, discussing on your own objectives, managing your own
 * files) is NOT a permission — it's what it means to be on the team.
 * Only actions that touch other members or shape the team itself are
 * permissions.
 *
 * Dotted noun-first naming groups permissions by resource so they
 * sort and scan naturally as the vocabulary grows.
 */
export const PERMISSIONS = [
  'team.manage',
  'members.manage',
  'objectives.create',
  'objectives.cancel',
  'objectives.reassign',
  'objectives.watch',
  'activity.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Team-level named bundles of permissions. Members reference them by
 * name in the raw config — the server resolves to a flat `Permission[]`
 * at load time.
 */
export type PermissionPresets = Record<string, Permission[]>;

/**
 * Check whether a resolved permission set grants a specific action.
 * Callers typically work with `Member.permissions`, which is already
 * resolved (presets expanded to leaves) by the time it leaves the
 * server.
 */
export function hasPermission(permissions: readonly Permission[], required: Permission): boolean {
  return permissions.includes(required);
}

// ─────────────────────────── Team / Member ────────────────────────────

/**
 * A team is the top-level unit the server controls. One deployment
 * = one team. The team defines the directive and the context every
 * member inherits, plus any reusable permission presets.
 */
export interface Team {
  name: string;
  directive: string;
  brief: string;
  /**
   * Named permission bundles members can reference instead of listing
   * every leaf permission. Always present (may be empty). Common
   * presets: `admin` (all permissions), `operator` (objectives-only).
   */
  permissionPresets: PermissionPresets;
}

/**
 * A role is a short label + prose description. Unlike the previous
 * role model, there's no instructions template here — instructions
 * are personal to each member. The role is shared public context:
 * what this member does on the team, visible to every teammate in
 * the roster and briefing.
 */
export interface Role {
  /** Short freeform label ("commander", "engineer", "qa-lead"). */
  title: string;
  /** Prose describing what this role does on the team. */
  description: string;
}

/**
 * Public projection of a team member — the subset visible to other
 * members in the roster and briefing. Omits personal fields
 * (`instructions`) that belong only to the member themselves and to
 * admins managing membership.
 */
export interface Teammate {
  name: string;
  role: Role;
  /** Resolved leaf permissions (presets expanded). */
  permissions: Permission[];
}

/**
 * Full member record — the shape an admin sees in the members admin
 * panel and the shape a member sees of themself in their briefing.
 * Adds `instructions` to the public `Teammate` projection.
 */
export interface Member extends Teammate {
  /**
   * Personal working directives + context for this member. Composed
   * into the member's own system prompt (for agents) or surfaced in
   * their briefing (for humans). Not visible to teammates — this is
   * private to the member and to admins.
   */
  instructions: string;
}

/**
 * Live connection state for one member. Presence describes any
 * member currently on the wire, whether they're a human with a
 * browser tab open or an agent with its MCP link alive.
 */
export interface Presence {
  name: string;
  /** Number of live SSE subscribers currently attached. */
  connected: number;
  createdAt: number;
  lastSeen: number;
  role: Role | null;
}

// ─────────────────────────── Messaging ────────────────────────────────

export interface PushPayload {
  /** Target member name, or null for a broadcast. */
  to?: string | null;
  title?: string | null;
  body: string;
  level?: LogLevel;
  data?: Record<string, unknown>;
  /**
   * Optional file attachments. Each entry is a reference to a path in
   * the ac7 virtual filesystem that the sender already owns write
   * access to. The broker validates each path exists and
   * materializes per-recipient grants so recipients can download the
   * file via `GET /fs/read/<path>`.
   */
  attachments?: Attachment[];
}

export interface Message {
  id: string;
  ts: number;
  /** Target member name, or null for a broadcast. */
  to: string | null;
  /**
   * Authoritative sender name, stamped by the broker based on the
   * caller's authenticated member. Never trusted from the request payload.
   */
  from: string | null;
  title: string | null;
  body: string;
  level: LogLevel;
  data: Record<string, unknown>;
  /**
   * Attachments associated with this message. Always an array — empty
   * when the message carries no files. Render inline for `image/*`
   * mime types; otherwise surface as download chips.
   */
  attachments: Attachment[];
}

export interface DeliveryReport {
  sse: number;
  targets: number;
}

export interface PushResult {
  delivery: DeliveryReport;
  message: Message;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}

// ─────────────────────────── Briefing / Session ───────────────────────

/**
 * Full team-context packet returned from `GET /briefing`. Used by
 * the runner and the web UI to initialize themselves with team/
 * role/permissions/objectives context. Extends `Member` so the
 * caller's own name/role/permissions/instructions are flat at the
 * top level — teammates appear in the `teammates` list as the
 * public `Teammate` projection.
 */
export interface BriefingResponse extends Member {
  team: Team;
  teammates: Teammate[];
  /** Objectives currently assigned to this member with status === 'active' or 'blocked'. */
  openObjectives: Objective[];
}

/** Response from `GET /roster`. */
export interface RosterResponse {
  teammates: Teammate[];
  connected: Presence[];
}

/** Query parameters for `GET /history`. */
export interface HistoryQuery {
  with?: string;
  limit?: number;
  before?: number;
}

export interface HistoryResponse {
  messages: Message[];
}

/**
 * Request body for `POST /session/totp`. The SPA submits a 6-digit
 * code and the server iterates enrolled members to find a match. The
 * optional `member` field is a CLI hint: when present, the server
 * skips iteration and verifies against that specific member only,
 * preserving the targeted-login flow for automation that already
 * knows which name is logging in.
 */
export interface TotpLoginRequest {
  code: string;
  member?: string;
}

export interface SessionResponse {
  /** Authenticated member name. */
  member: string;
  role: Role;
  permissions: Permission[];
  expiresAt: number;
}

export interface VapidPublicKeyResponse {
  publicKey: string;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushSubscriptionResponse {
  id: number;
  endpoint: string;
  createdAt: number;
}

// ─────────────────────────── Members ──────────────────────────────────

/**
 * `POST /members` body — requires `members.manage`. Server generates
 * the bearer token; the plaintext is returned exactly once in
 * `CreateMemberResponse` and never again. TOTP is optional and
 * enrolled separately via `POST /members/:name/enroll-totp` — it's
 * no longer gated by a type, anyone can enroll.
 *
 * `permissions` accepts either preset names or leaf permissions in a
 * flat array; the server resolves presets and validates every entry.
 */
export interface CreateMemberRequest {
  name: string;
  role: Role;
  instructions?: string;
  /** Each entry: preset name (resolved by server) or leaf permission. */
  permissions: string[];
}

/**
 * `POST /members` response. The plaintext `token` is shown to the
 * admin who created the member, then immediately hashed on disk.
 */
export interface CreateMemberResponse {
  member: Teammate;
  token: string;
}

/**
 * `PATCH /members/:name` body. Any subset of fields may be present;
 * omit a field to leave it alone. Changing permissions enforces the
 * "at least one member with `members.manage` must remain" invariant.
 */
export interface UpdateMemberRequest {
  role?: Role;
  instructions?: string;
  /** Same preset-or-leaf shape as CreateMemberRequest. */
  permissions?: string[];
}

/** `GET /members` response — requires `members.manage`. */
export interface ListMembersResponse {
  members: Member[];
}

/**
 * `POST /members/:name/rotate-token` response — requires
 * `members.manage` OR self. Returns the new plaintext token.
 */
export interface RotateTokenResponse {
  token: string;
}

/**
 * `POST /members/:name/enroll-totp` response — requires
 * `members.manage` OR self. Returns the new TOTP secret + otpauth
 * URI. Any member may enroll; there's no type gate.
 */
export interface EnrollTotpResponse {
  totpSecret: string;
  totpUri: string;
}

// ─────────────────────────── Objectives ───────────────────────────────

export type ObjectiveStatus = 'active' | 'blocked' | 'done' | 'cancelled';

/**
 * An objective is the apex task primitive on a team: push-assigned,
 * outcome-required, single-assignee. The `outcome` field is the tangible
 * definition of "done" that propagates into tool descriptions and channel
 * pushes so the assignee always has the acceptance criteria in front of them.
 */
export interface Objective {
  id: string;
  title: string;
  /** Optional longer context. */
  body: string;
  /** Required — the tangible outcome that defines "done". */
  outcome: string;
  status: ObjectiveStatus;
  assignee: string;
  originator: string;
  /**
   * Additional names that have been explicitly added to the
   * objective's discussion thread. Watchers receive every lifecycle
   * event and every discussion post on their SSE streams without
   * being the assignee. Members with `objectives.watch` can add
   * themselves or others; originators can manage their own
   * objectives' watchers. Members with `members.manage` are implicit
   * observers regardless and do NOT appear in this list.
   */
  watchers: string[];
  createdAt: number;
  updatedAt: number;
  /** Set iff status === 'done'. */
  completedAt: number | null;
  /** Required on completion; explains what was delivered. */
  result: string | null;
  /** Set while status === 'blocked'; cleared on unblock. */
  blockReason: string | null;
  /**
   * Files attached to the objective at creation time. Thread members
   * (originator, assignee, watchers) all receive read grants for each
   * attachment, so any thread-scoped UI can render them alongside
   * the objective body.
   */
  attachments: Attachment[];
}

/**
 * Events on an objective's audit log. Kinds split into two groups:
 *
 *   Lifecycle transitions (the state machine of the work):
 *     assigned | blocked | unblocked | completed | cancelled | reassigned
 *
 *   Membership changes (the audience of the thread):
 *     watcher_added | watcher_removed
 *
 * Discussion — ordinary conversation about the objective — lives in
 * the `obj:<id>` thread as regular messages and is NOT in the event
 * log. The event log is strictly auditable transitions.
 */
export type ObjectiveEventKind =
  | 'assigned'
  | 'blocked'
  | 'unblocked'
  | 'completed'
  | 'cancelled'
  | 'reassigned'
  | 'watcher_added'
  | 'watcher_removed';

export interface ObjectiveEvent {
  objectiveId: string;
  ts: number;
  actor: string;
  kind: ObjectiveEventKind;
  payload: Record<string, unknown>;
}

export interface CreateObjectiveRequest {
  title: string;
  outcome: string;
  body?: string;
  assignee: string;
  /**
   * Optional initial watchers (names that should be looped into
   * the objective's thread from the start). Duplicates and the
   * objective's own assignee/originator are de-duped server-side.
   * Every name must resolve to a known team member.
   */
  watchers?: string[];
  /**
   * Optional files to attach. The originator must have read access
   * to each path. Thread members receive automatic read grants as
   * part of the `assigned` event fanout.
   */
  attachments?: Attachment[];
}

/**
 * Add or remove watchers on an existing objective. Either field may
 * be omitted; both may be present for a combined add + remove.
 * Names that are already watchers are no-ops on `add`, and
 * names that aren't currently watchers are no-ops on `remove`.
 * Every name in both lists must resolve to a known team member.
 */
export interface UpdateWatchersRequest {
  add?: string[];
  remove?: string[];
}

export interface UpdateObjectiveRequest {
  status?: 'active' | 'blocked';
  blockReason?: string;
}

export interface CompleteObjectiveRequest {
  result: string;
}

export interface CancelObjectiveRequest {
  reason?: string;
}

export interface ReassignObjectiveRequest {
  to: string;
  note?: string;
}

/**
 * Post a discussion message into an objective's thread. Members of the
 * thread (originator, assignee, watchers) all receive it via their
 * SSE streams. The post is a normal team `Message` with thread
 * key `obj:<id>`, not an event-log entry.
 */
export interface DiscussObjectiveRequest {
  body: string;
  title?: string;
  /**
   * Optional files to attach to this discussion post. Resolved and
   * grant-propagated the same way attachments on `/push` are —
   * every thread member who receives the post also gets read
   * access to each attachment.
   */
  attachments?: Attachment[];
}

export interface ListObjectivesResponse {
  objectives: Objective[];
}

export interface GetObjectiveResponse {
  objective: Objective;
  events: ObjectiveEvent[];
}

export interface ListObjectivesQuery {
  assignee?: string;
  status?: ObjectiveStatus;
}

// ─────────────────────────── Activity / Traces ────────────────────────

/**
 * Trace capture — one structured trace entry recovered from the wire
 * via the runner's SOCKS relay + TLS keylog + tshark pipeline. Each
 * entry is a single HTTP exchange the agent made while working on an
 * objective. Anthropic `/v1/messages` calls are parsed into a typed
 * shape; everything else is kept opaque with headers + body preview.
 */
export type TraceEntry = AnthropicMessagesEntry | OpaqueHttpEntry;

export interface AnthropicMessagesEntry {
  kind: 'anthropic_messages';
  startedAt: number;
  endedAt: number;
  request: {
    model: string | null;
    maxTokens: number | null;
    temperature: number | null;
    system: string | null;
    messages: AnthropicMessage[];
    tools: AnthropicTool[] | null;
  };
  response: {
    stopReason: string | null;
    stopSequence: string | null;
    messages: AnthropicMessage[];
    usage: AnthropicUsage | null;
    status: number | null;
  } | null;
}

export interface AnthropicMessage {
  role: string;
  content: AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }
  | { type: 'image'; mediaType: string | null }
  | { type: 'thinking'; text: string }
  | { type: 'unknown'; raw: unknown };

export interface AnthropicTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

export interface AnthropicUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface OpaqueHttpEntry {
  kind: 'opaque_http';
  startedAt: number;
  endedAt: number;
  host: string;
  method: string;
  url: string;
  status: number | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodyPreview: string | null;
  responseBodyPreview: string | null;
}

/**
 * Activity event — one entry in the append-only timeline a member
 * streams to the server while their connection is alive. Humans
 * rarely emit these (no MCP runner); agents produce the bulk as
 * their MITM proxy captures outbound traffic.
 *
 * Activity is the source of truth for "what did this member actually
 * do" — LLM calls, opaque HTTP to non-Anthropic endpoints, and
 * objective lifecycle markers. Objective "traces" are a time-range
 * slice of this stream between `objective_open` and `objective_close`
 * markers for a given objectiveId.
 */
export type ActivityEvent =
  | ActivityObjectiveOpen
  | ActivityObjectiveClose
  | ActivityLlmExchange
  | ActivityOpaqueHttp;

export type ActivityKind = ActivityEvent['kind'];

export interface ActivityObjectiveOpen {
  readonly kind: 'objective_open';
  readonly ts: number;
  readonly objectiveId: string;
}

export interface ActivityObjectiveClose {
  readonly kind: 'objective_close';
  readonly ts: number;
  readonly objectiveId: string;
  /** Terminal state that caused the close. */
  readonly result: 'done' | 'cancelled' | 'reassigned' | 'runner_shutdown';
}

export interface ActivityLlmExchange {
  readonly kind: 'llm_exchange';
  /** Start of the request on the MITM wire. */
  readonly ts: number;
  /** Milliseconds between request start and response end. */
  readonly duration: number;
  readonly entry: AnthropicMessagesEntry;
}

export interface ActivityOpaqueHttp {
  readonly kind: 'opaque_http';
  readonly ts: number;
  readonly duration: number;
  readonly entry: OpaqueHttpEntry;
}

/**
 * One activity row as the server stores it — the upload event plus
 * the server-assigned id + member name.
 */
export interface ActivityRow {
  readonly id: number;
  readonly memberName: string;
  readonly event: ActivityEvent;
  readonly createdAt: number;
}

/**
 * Upload payload. Runners batch events and POST them in bursts of
 * up to a few dozen at a time. The server stamps each with an id
 * and broadcasts to any live SSE subscribers.
 */
export interface UploadActivityRequest {
  readonly events: ActivityEvent[];
}

export interface UploadActivityResponse {
  readonly accepted: number;
}

export interface ListActivityQuery {
  /** Inclusive lower bound on ts (ms since epoch). */
  readonly from?: number;
  /** Inclusive upper bound on ts (ms since epoch). */
  readonly to?: number;
  /** Filter by kind — single or array. Omit for all kinds. */
  readonly kind?: ActivityKind | ActivityKind[];
  /** Max rows to return. Default 200, max 1000. Newest first. */
  readonly limit?: number;
}

export interface ListActivityResponse {
  readonly activity: ActivityRow[];
}

// ─────────────────────────── Filesystem ───────────────────────────────

/**
 * One entry in the ac7 virtual filesystem — either a file or a
 * directory. Paths are absolute Unix-style; the first segment is
 * the owning member (`/<membername>/...`).
 *
 * For directories: `size`, `mimeType`, and `hash` are null.
 * For files: all three are populated; `hash` is SHA-256 hex of the
 * blob content and doubles as the dedup key for the blob store.
 */
export interface FsEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  owner: string;
  size: number | null;
  mimeType: string | null;
  hash: string | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
}

/**
 * Lightweight file reference embedded in a `Message` or an objective.
 * Recipients resolve downloads via `GET /fs/read/<path>`. The
 * accompanying `size` and `mimeType` let clients render previews
 * without an extra round-trip.
 */
export interface Attachment {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface FsListResponse {
  entries: FsEntry[];
}

export interface FsEntryResponse {
  entry: FsEntry;
}

export interface FsWriteResponse {
  entry: FsEntry;
  /** True when a collide-suffix strategy caused the final path to differ from the request. */
  renamed: boolean;
}

export interface FsMkdirRequest {
  path: string;
  recursive?: boolean;
}

export interface FsRemoveQuery {
  path: string;
  recursive?: boolean;
}

export interface FsMoveRequest {
  from: string;
  to: string;
}
