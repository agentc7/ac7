/**
 * Wire-protocol constants for ac7.
 *
 * Everything that defines the contract between a broker and its clients
 * lives here. Bump PROTOCOL_VERSION on any breaking wire change.
 */

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_HEADER = 'X-AC7-Protocol' as const;
export const AUTH_HEADER = 'Authorization' as const;

export const PATHS = {
  health: '/healthz',
  briefing: '/briefing',
  roster: '/roster',
  push: '/push',
  subscribe: '/subscribe',
  history: '/history',
  // Human-plane session management (TOTP login + session cookie).
  sessionTotp: '/session/totp',
  sessionLogout: '/session/logout',
  session: '/session',
  // Web Push (browser) — VAPID public key + per-device subscriptions.
  pushVapidPublicKey: '/push/vapid-public-key',
  pushSubscriptions: '/push/subscriptions',
  // Objectives — members with `objectives.create` post and assign,
  // assignees execute, watchers observe.
  objectives: '/objectives',
  // Channels — Slack-style named team threads. Anyone can create;
  // admins (creator-by-default) manage. The `general` channel is
  // synthetic and seeded server-side; everyone is implicitly a
  // member.
  channels: '/channels',
  // Members — requires `members.manage` for mutations. Top-level GET
  // is dual-auth (everyone can read the teammate list); mutating verbs
  // gate on the permission. The helpers below compose the `:name`
  // subpaths.
  members: '/members',
  // Filesystem — per-member home directories with content-addressed
  // blob storage. The dedicated `read/*` catch-all supports friendly
  // URLs for <a href> and <img src>; other ops take path via query or body.
  fsList: '/fs/ls',
  fsStat: '/fs/stat',
  fsRead: '/fs/read',
  fsWrite: '/fs/write',
  fsMkdir: '/fs/mkdir',
  fsRm: '/fs/rm',
  fsMv: '/fs/mv',
  fsShared: '/fs/shared',
  // Device-code enrollment (RFC 8628-shaped). `enroll` mints a
  // device_code/user_code pair; `enrollPoll` is the device-side poll;
  // `enrollPending` lists requests waiting for director approval;
  // `enrollApprove` and `enrollReject` are director actions.
  enroll: '/enroll',
  enrollPoll: '/enroll/poll',
  enrollPending: '/enroll/pending',
  enrollApprove: '/enroll/approve',
  enrollReject: '/enroll/reject',
  /**
   * The web-UI route an operator visits to enter a user code. Lives
   * on the SPA, not the API — but pinned here so the broker can
   * include the same canonical path in the device-authorization
   * response without each consumer hard-coding it.
   */
  enrollVerify: '/enroll',
  // The helpers below compose `:id` / `:name` paths at runtime
  // rather than templating here, since `PATHS` is keyed by
  // identifier not URL.
} as const;

/** Path builders for objective subresources (the `:id` segment varies). */
export const OBJECTIVE_PATHS = {
  one: (id: string) => `/objectives/${encodeURIComponent(id)}`,
  complete: (id: string) => `/objectives/${encodeURIComponent(id)}/complete`,
  cancel: (id: string) => `/objectives/${encodeURIComponent(id)}/cancel`,
  reassign: (id: string) => `/objectives/${encodeURIComponent(id)}/reassign`,
  discuss: (id: string) => `/objectives/${encodeURIComponent(id)}/discuss`,
  watchers: (id: string) => `/objectives/${encodeURIComponent(id)}/watchers`,
} as const;

/**
 * Path builders for channel subresources. Channels are addressed by
 * slug (URL-facing, mutable); the server resolves slug → id on each
 * call so renames don't break URLs already in flight.
 *
 *   GET    /channels                              — list (per viewer)
 *   POST   /channels                              — create
 *   GET    /channels/:slug                        — detail + members
 *   PATCH  /channels/:slug                        — rename
 *   DELETE /channels/:slug                        — archive
 *   POST   /channels/:slug/members                — add member (admin)
 *                                                   or self-join
 *   DELETE /channels/:slug/members/:name          — remove member
 *                                                   (admin) or self-leave
 */
export const CHANNEL_PATHS = {
  one: (slug: string) => `/channels/${encodeURIComponent(slug)}`,
  members: (slug: string) => `/channels/${encodeURIComponent(slug)}/members`,
  member: (slug: string, name: string) =>
    `/channels/${encodeURIComponent(slug)}/members/${encodeURIComponent(name)}`,
} as const;

/**
 * Path builders for per-member subresources.
 *
 *   PATCH  /members/:name                   — update (members.manage)
 *   DELETE /members/:name                   — delete (members.manage)
 *   POST   /members/:name/rotate-token      — rotate bearer token (members.manage or self)
 *   POST   /members/:name/enroll-totp       — (re-)enroll TOTP (members.manage or self)
 *   POST   /members/:name/activity          — append activity event (self only)
 *   GET    /members/:name/activity          — range query (self or activity.read)
 *   GET    /members/:name/activity/stream   — SSE live tail (self or activity.read)
 */
export const MEMBER_PATHS = {
  one: (name: string) => `/members/${encodeURIComponent(name)}`,
  rotateToken: (name: string) => `/members/${encodeURIComponent(name)}/rotate-token`,
  enrollTotp: (name: string) => `/members/${encodeURIComponent(name)}/enroll-totp`,
  activity: (name: string) => `/members/${encodeURIComponent(name)}/activity`,
  activityStream: (name: string) => `/members/${encodeURIComponent(name)}/activity/stream`,
  /** GET — list this member's active bearer tokens (members.manage or self). */
  tokens: (name: string) => `/members/${encodeURIComponent(name)}/tokens`,
  /** DELETE — revoke a specific token row by id (members.manage or self). */
  token: (name: string, tokenId: string) =>
    `/members/${encodeURIComponent(name)}/tokens/${encodeURIComponent(tokenId)}`,
} as const;

/**
 * Path builder for the `/fs/read/<path>` download endpoint. The
 * server treats the trailing segment as a catch-all so friendly URLs
 * like `/fs/read/alice/uploads/foo.pdf` work directly in `<a href>`
 * and `<img src>`. Each segment is URL-encoded individually so names
 * with spaces or special characters stay safe.
 */
export const FS_PATHS = {
  read: (virtualPath: string): string => {
    const segments = virtualPath.split('/').filter((s) => s.length > 0);
    return `/fs/read/${segments.map(encodeURIComponent).join('/')}`;
  },
} as const;

export const DEFAULT_PORT = 8717 as const;

export const ENV = {
  // Client-side: broker URL + bearer token held in env for `ac7` subcommands.
  url: 'AC7_URL',
  token: 'AC7_TOKEN',
  // Server-side: where to find the team config file + listener config.
  configPath: 'AC7_CONFIG_PATH',
  port: 'AC7_PORT',
  host: 'AC7_HOST',
  dbPath: 'AC7_DB_PATH',
} as const;

export const MCP_CHANNEL_CAPABILITY = 'claude/channel' as const;
export const MCP_CHANNEL_NOTIFICATION = 'notifications/claude/channel' as const;
