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
  // Objectives — admin/operator/lead-agent create & assign, assignees execute.
  objectives: '/objectives',
  // Users — admin CRUD for team membership. Top-level GET is
  // dual-auth (everyone can read the teammate list); mutating verbs
  // are admin-only. The helpers below compose the `:name` subpaths.
  users: '/users',
  // Filesystem — per-user home directories with content-addressed blob
  // storage. The dedicated `read/*` catch-all supports friendly URLs
  // for <a href> and <img src>; other ops take path via query or body.
  fsList: '/fs/ls',
  fsStat: '/fs/stat',
  fsRead: '/fs/read',
  fsWrite: '/fs/write',
  fsMkdir: '/fs/mkdir',
  fsRm: '/fs/rm',
  fsMv: '/fs/mv',
  fsShared: '/fs/shared',
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
 * Path builders for per-user subresources.
 *
 *   PATCH  /users/:name                   — update (admin only)
 *   DELETE /users/:name                   — delete (admin only)
 *   POST   /users/:name/rotate-token      — rotate bearer token (admin or self)
 *   POST   /users/:name/enroll-totp       — (re-)enroll TOTP (admin or self, humans only)
 *   POST   /users/:name/activity          — append activity event (self only)
 *   GET    /users/:name/activity          — range query (self or admin)
 *   GET    /users/:name/activity/stream   — SSE live tail (self or admin)
 */
export const USER_PATHS = {
  one: (name: string) => `/users/${encodeURIComponent(name)}`,
  rotateToken: (name: string) => `/users/${encodeURIComponent(name)}/rotate-token`,
  enrollTotp: (name: string) => `/users/${encodeURIComponent(name)}/enroll-totp`,
  activity: (name: string) => `/users/${encodeURIComponent(name)}/activity`,
  activityStream: (name: string) => `/users/${encodeURIComponent(name)}/activity/stream`,
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
