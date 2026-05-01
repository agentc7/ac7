/**
 * Subset of the codex app-server v2 JSON-RPC protocol that ac7 actually
 * uses. Mirrors `codex-rs/app-server-protocol/src/protocol/v2.rs` but
 * pulled in as raw types rather than imported — codex doesn't ship a
 * TS package for the protocol, only Rust + a generated TS mirror that
 * isn't published to npm.
 *
 * Wire format is newline-delimited JSON (see `transport/stdio.rs` in
 * codex). One JSON-RPC message per line.
 *
 * Method names match the wire-level strings codex expects (kebab/camel
 * mix is intentional and exactly matches the Rust `#[serde(rename)]`
 * tags on each variant).
 */
export const METHODS = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;

export const NOTIFICATIONS = {
  threadStarted: 'thread/started',
  threadStatusChanged: 'thread/status/changed',
  threadClosed: 'thread/closed',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  accountRateLimitsUpdated: 'account/rateLimits/updated',
  error: 'error',
  warning: 'warning',
} as const;

/**
 * Server-initiated requests we have to answer (the server is codex,
 * the client is us). All of these only fire if a thread is started
 * with `approval_policy != "never"` or with an MCP server whose
 * `default_tools_approval_mode != "never"`. We start threads with
 * `Never` everywhere, so these handlers exist as a defense-in-depth
 * fallback: if codex ever sends one anyway, we auto-respond with a
 * deny rather than letting the agent hang waiting for a reviewer
 * that doesn't exist.
 */
export const SERVER_REQUEST_METHODS = {
  commandExecutionRequestApproval: 'item/commandExecution/requestApproval',
  fileChangeRequestApproval: 'item/fileChange/requestApproval',
  permissionsRequestApproval: 'item/permissions/requestApproval',
  toolRequestUserInput: 'item/tool/requestUserInput',
  mcpServerElicitationRequest: 'mcpServer/elicitation/request',
} as const;

export interface InitializeParams {
  clientInfo: { name: string; version: string };
}

export interface InitializeResponse {
  /**
   * Codex returns various fields (server name/version, capabilities).
   * We don't introspect them — the response is just an acknowledgement
   * the server is alive and the protocol is the version we expect.
   */
  [key: string]: unknown;
}

/**
 * `thread/start` — open a fresh codex thread. Carries our composed
 * briefing as `developerInstructions`, pins the cwd, and forces
 * `approvalPolicy: "never"` + `sandbox: "workspace-write"` so headless
 * runs never block on a UI elicitation. See `protocol/v2.rs`
 * `ThreadStartParams`.
 */
export interface ThreadStartParams {
  cwd?: string;
  /**
   * Pre-message system prose. Codex stamps this into the model context
   * for every turn — analogous to claude-code's `--append-system-prompt`.
   */
  developerInstructions?: string;
  /** Optional override of the model name selected for the thread. */
  model?: string;
  /**
   * Approval policy. `never` enables headless operation.
   * Wire values are kebab-case (per `AskForApproval` in codex's
   * `protocol/v2.rs` with `#[serde(rename_all = "kebab-case")]`).
   */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  /**
   * Sandbox mode. `workspace-write` is the headless default.
   * Wire values are kebab-case (per `SandboxMode` in codex's
   * `protocol/v2.rs` with `#[serde(rename_all = "kebab-case")]`).
   */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** When true, codex won't persist the thread to its rollout store. */
  ephemeral?: boolean;
  /**
   * Whether this thread is being started fresh (`startup`) or after a
   * `/clear` reset (`clear`). Default is `startup`. Don't confuse with
   * `SessionSource` (the per-process `--session-source` CLI arg);
   * `ThreadStartSource` is thread-level lifecycle, not process-level
   * provenance.
   */
  sessionStartSource?: 'startup' | 'clear';
}

export interface Thread {
  id: string;
  /**
   * Initial runtime status of the thread. Populated on both
   * `thread/start` responses and `thread/started` notifications. We
   * read this rather than waiting for a `thread/status/changed`
   * notification — codex only emits status-changed on transitions, not
   * on the initial steady state, so the cached status would otherwise
   * sit at `notLoaded` until the first turn fires (or forever, if the
   * agent is left idle).
   */
  status?: ThreadStatus;
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread: Thread;
  [key: string]: unknown;
}

export interface ThreadResumeParams {
  threadId: string;
}

export interface UserInputText {
  type: 'text';
  text: string;
}

export type UserInput = UserInputText;

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
}

export interface Turn {
  id: string;
  [key: string]: unknown;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnSteerParams {
  threadId: string;
  input: UserInput[];
  /**
   * Required precondition. Codex rejects the steer if it doesn't
   * match the active turn id at the moment of dispatch — the channel
   * sink retries once on mismatch by re-reading the latest
   * `turn/started` notification.
   */
  expectedTurnId: string;
}

export interface TurnSteerResponse {
  turnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ─── Notifications ────────────────────────────────────────────────

export interface ThreadStartedNotification {
  thread: Thread;
}

/**
 * Codex's idle/working/blocked state machine. Drives presence on our
 * side and decides whether channel events flush to `turn/start` (Idle)
 * or `turn/steer` (Active).
 */
export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags?: Array<'waitingOnApproval' | 'waitingOnUserInput'> };

export interface ThreadStatusChangedNotification {
  threadId: string;
  status: ThreadStatus;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemStartedNotification {
  threadId: string;
  turnId: string;
  item: { type: string; id?: string; [key: string]: unknown };
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: { type: string; id?: string; [key: string]: unknown };
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ErrorNotification {
  message: string;
  [key: string]: unknown;
}
