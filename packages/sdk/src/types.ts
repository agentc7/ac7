/**
 * Pure TypeScript types for the ac7 wire protocol.
 *
 * Zero runtime dependencies. Consumers that only want types should import
 * from `@agentc7/sdk/types`.
 */

export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

/**
 * Authority tier on a slot. Orthogonal to `role` (what you do vs. what
 * you can change). Most slots are plain `individual-contributor`; `manager` can
 * create and assign objectives; `director` can do everything including
 * edit team config and roles.
 */
export type Authority = 'director' | 'manager' | 'individual-contributor';

/**
 * A team is the top-level unit the server controls. One deployment
 * = one team. The team defines the directive and the context every
 * slot inherits. Multi-team lives at the SaaS layer.
 */
export interface Team {
  name: string;
  directive: string;
  brief: string;
}

/**
 * A named bundle of role-specific instructions. Roles are defined in
 * the server config and referenced by slots. Multiple slots can share
 * a role — e.g., two `implementer` slots running in parallel.
 *
 * Permission to edit team state comes from the slot's `authority`,
 * not from the role.
 */
export interface Role {
  description: string;
  instructions: string;
}

/**
 * A reserved position on the team. The token is the auth boundary;
 * the name is the team-context identity; the role is a key into
 * the team's roles map; the authority tier gates write access.
 *
 * On the wire, slots never carry their token — it's resolved by auth
 * and never returned in any response.
 */
export interface Slot {
  name: string;
  role: string;
  authority: Authority;
}

/** Projection of a slot for rendering in the roster / briefing. */
export interface Teammate {
  name: string;
  role: string;
  authority: Authority;
}

export interface Agent {
  agentId: string;
  /** Number of live SSE subscribers currently attached to this agent. */
  connected: number;
  createdAt: number;
  lastSeen: number;
  role: string | null;
  authority: Authority;
}

export interface PushPayload {
  agentId?: string | null;
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
  /** Target agent name, or null for a broadcast. */
  agentId: string | null;
  /**
   * Authoritative sender name, stamped by the broker based on the
   * caller's authenticated slot. Never trusted from the request payload.
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

/**
 * Full team-context packet returned from `GET /briefing`. Used by
 * the runner and the web UI to initialize themselves with team/
 * role/directive/objectives context. The `instructions` string is pre-composed
 * server-side and passed verbatim into the MCP `Server({instructions})`
 * init.
 */
export interface BriefingResponse {
  name: string;
  role: string;
  authority: Authority;
  team: Team;
  teammates: Teammate[];
  /** Objectives currently assigned to this slot with status === 'active' or 'blocked'. */
  openObjectives: Objective[];
  instructions: string;
}

/** Response from `GET /roster`. */
export interface RosterResponse {
  teammates: Teammate[];
  connected: Agent[];
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
 * code and the server iterates enrolled slots to find a match. The
 * optional `slot` field is a legacy + CLI hint: when present, the
 * server skips iteration and verifies against that specific slot
 * only, preserving the targeted-login flow for automation that
 * already knows which name is logging in.
 */
export interface TotpLoginRequest {
  code: string;
  slot?: string;
}

export interface SessionResponse {
  slot: string;
  role: string;
  authority: Authority;
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

// ───────────────────────── Objectives ─────────────────────────

export type ObjectiveStatus = 'active' | 'blocked' | 'done' | 'cancelled';

/**
 * An objective is the apex task primitive on a team: push-assigned,
 * outcome-required, single-assignee. The `outcome` field is the tangible
 * definition of "done" that propagates into tool descriptions and channel
 * pushes so the agent always has the acceptance criteria in front of them.
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
   * objective's discussion thread by the director or originator.
   * Watchers receive every lifecycle event and every discussion post
   * on their SSE streams without being the assignee. Use this for
   * "keep me in the loop" awareness — reviewers tracking a feature,
   * ops watching a blocker, a subject-matter expert who may be asked
   * to weigh in. Directors are implicit members regardless and do
   * NOT appear in this list; only explicit non-director watchers.
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
   * (originator, assignee, watchers, directors) all receive read
   * grants for each attachment, so any thread-scoped UI can render
   * them alongside the objective body. New watchers added later and
   * reassigned assignees backfill their grants via the respective
   * mutation handlers so access tracks thread membership.
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
   * Every name must resolve to a known team slot.
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
 * Every name in both lists must resolve to a known team slot.
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
 * thread (originator, assignee, directors) all receive it via their
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
 * Agent activity event — one entry in the append-only timeline the
 * runner streams to the server while its agent is alive.
 *
 * Activity is the source of truth for "what did this agent actually
 * do" — LLM calls, opaque HTTP to non-Anthropic endpoints, and
 * objective lifecycle markers. Objective "traces" are no longer a
 * separate table; they're a time-range slice of this stream
 * between `objective_open` and `objective_close` markers for a
 * given objectiveId.
 *
 * Kinds:
 *   - `objective_open`  — the slot just took ownership of an objective
 *   - `objective_close` — the slot released it (done/cancelled/reassigned)
 *   - `llm_exchange`    — a parsed Anthropic API request/response pair
 *   - `opaque_http`     — a non-Anthropic HTTP exchange captured by the
 *                         MITM proxy (telemetry, update checks, etc.)
 */
export type AgentActivityEvent =
  | AgentActivityObjectiveOpen
  | AgentActivityObjectiveClose
  | AgentActivityLlmExchange
  | AgentActivityOpaqueHttp;

export type AgentActivityKind = AgentActivityEvent['kind'];

export interface AgentActivityObjectiveOpen {
  readonly kind: 'objective_open';
  readonly ts: number;
  readonly objectiveId: string;
}

export interface AgentActivityObjectiveClose {
  readonly kind: 'objective_close';
  readonly ts: number;
  readonly objectiveId: string;
  /** Terminal state that caused the close. */
  readonly result: 'done' | 'cancelled' | 'reassigned' | 'runner_shutdown';
}

export interface AgentActivityLlmExchange {
  readonly kind: 'llm_exchange';
  /** Start of the request on the MITM wire. */
  readonly ts: number;
  /** Milliseconds between request start and response end. */
  readonly duration: number;
  readonly entry: AnthropicMessagesEntry;
}

export interface AgentActivityOpaqueHttp {
  readonly kind: 'opaque_http';
  readonly ts: number;
  readonly duration: number;
  readonly entry: OpaqueHttpEntry;
}

/**
 * One activity row as the server stores it — the upload event plus
 * the server-assigned id + slot name.
 */
export interface AgentActivityRow {
  readonly id: number;
  readonly slotName: string;
  readonly event: AgentActivityEvent;
  readonly createdAt: number;
}

/**
 * Upload payload. Runners batch events and POST them in bursts of
 * up to a few dozen at a time. The server stamps each with an id
 * and broadcasts to any live SSE subscribers.
 */
export interface UploadAgentActivityRequest {
  readonly events: AgentActivityEvent[];
}

export interface UploadAgentActivityResponse {
  readonly accepted: number;
}

export interface ListAgentActivityQuery {
  /** Inclusive lower bound on ts (ms since epoch). */
  readonly from?: number;
  /** Inclusive upper bound on ts (ms since epoch). */
  readonly to?: number;
  /** Filter by kind — single or array. Omit for all kinds. */
  readonly kind?: AgentActivityKind | AgentActivityKind[];
  /** Max rows to return. Default 200, max 1000. Newest first. */
  readonly limit?: number;
}

export interface ListAgentActivityResponse {
  readonly activity: AgentActivityRow[];
}

// ───────────────────────── Filesystem ─────────────────────────

/**
 * One entry in the ac7 virtual filesystem — either a file or a
 * directory. Paths are absolute Unix-style; the first segment is
 * the owning slot (`/<slotname>/...`).
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
