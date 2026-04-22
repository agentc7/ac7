/**
 * Hono application factory for the ac7 broker.
 *
 * Routes:
 *   GET  /healthz         — unauthed, liveness probe
 *   POST /session/totp    — unauthed, exchange TOTP code for a session cookie
 *   POST /session/logout  — session-auth, clear the session
 *   GET  /session         — session-auth, return current session info
 *   GET  /briefing        — dual-auth, team-context packet for the user
 *   GET  /roster          — dual-auth, full teammate list + live connection state
 *   POST /push            — dual-auth, deliver a message to one teammate or broadcast
 *   GET  /subscribe       — dual-auth, WebSocket of live messages for a name
 *   GET  /history         — dual-auth, prior messages filtered by viewer scope
 *
 * Dual-auth = either `Authorization: Bearer <token>` (machine plane,
 * MCP link) or `Cookie: ac7_session=<id>` (human plane, web SPA).
 * Both resolve to the same `LoadedMember`, which downstream handlers
 * use to stamp authoritative `from` on pushes and to gate identity
 * checks on subscribe. All routes must carry `X-AC7-Protocol: 1` if
 * the header is present.
 */

import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { type Broker, clampQueryLimit } from '@agentc7/core';
import { PATHS, PROTOCOL_HEADER, PROTOCOL_VERSION } from '@agentc7/sdk/protocol';
import {
  ActivityKindSchema,
  CancelObjectiveRequestSchema,
  CompleteObjectiveRequestSchema,
  CreateMemberRequestSchema,
  CreateObjectiveRequestSchema,
  DiscussObjectiveRequestSchema,
  FsMkdirRequestSchema,
  FsMoveRequestSchema,
  FsPathSchema,
  FsWriteCollisionSchema,
  ListObjectivesQuerySchema,
  NameSchema,
  PushPayloadSchema,
  PushSubscriptionPayloadSchema,
  ReassignObjectiveRequestSchema,
  TotpLoginRequestSchema,
  UpdateMemberRequestSchema,
  UpdateObjectiveRequestSchema,
  UpdateWatchersRequestSchema,
  UploadActivityRequestSchema,
} from '@agentc7/sdk/schemas';
import type {
  ActivityEvent,
  Attachment,
  Message,
  Objective,
  ObjectiveEvent,
  ObjectiveEventKind,
  Permission,
  Role,
  Team,
  Teammate,
} from '@agentc7/sdk/types';
import { hasPermission } from '@agentc7/sdk/types';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { type Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { type AuthBindings, createAuthMiddleware } from './auth.js';
import { composeBriefing } from './briefing.js';
import { type FilesystemStore, FsError, type ViewerContext } from './files/index.js';
import type { Logger } from './logger.js';
import type { ActivityStore } from './member-activity.js';
import {
  generateMemberToken,
  type LoadedMember,
  MemberLoadError,
  type MemberStore,
  resolvePermissions,
  teammatesFromMembers,
  type UpdateMemberPatch,
} from './members.js';
import { ObjectivesError, type ObjectivesStore } from './objectives.js';
import type { PushSubscriptionStore } from './push/store.js';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, type SessionStore } from './sessions.js';
import { generateSecret, otpauthUri, verifyCode as verifyTotpCode } from './totp.js';

export interface AppOptions {
  broker: Broker;
  members: MemberStore;
  sessions: SessionStore;
  team: Team;
  /**
   * Objectives store — the server's authoritative task state. The
   * `/objectives*` endpoints are registered iff this is provided,
   * which lets tests opt out of the whole objectives surface when
   * they're only exercising chat paths.
   */
  objectives?: ObjectivesStore;
  /**
   * Per-member activity store — append-only timeline of LLM
   * exchanges, opaque HTTP, and objective lifecycle markers the
   * runner ships up via the streaming uploader. The
   * `/members/:name/activity*` endpoints are registered iff this is
   * provided, same opt-out pattern as `objectives`.
   */
  activityStore?: ActivityStore;
  version: string;
  logger: Logger;
  /**
   * Whether the server is listening over HTTPS. Controls the `Secure`
   * attribute on the session cookie — we MUST NOT set Secure on a
   * plain-HTTP listener (browsers drop the cookie on the next request),
   * and we MUST set it on HTTPS (sending a session cookie in cleartext
   * is a leak).
   */
  secureCookies?: boolean;
  /**
   * Triggered when the server is shutting down. Open WebSocket
   * connections listen for this so they can close cleanly and let
   * `http.Server.close()` complete.
   */
  shutdownSignal?: AbortSignal;
  /**
   * Absolute path to the directory containing the built `@agentc7/web`
   * bundle (index.html + assets/). When set, the server serves the
   * SPA at `/` plus SPA fallback for any non-API GET request. When
   * omitted or missing on disk, no SPA routes are registered — useful
   * for tests and for the machine-only auth plane where the web UI
   * isn't built.
   */
  publicRoot?: string;
  /**
   * Web Push subscription store + VAPID public key. When both are
   * present, the `/push/vapid-public-key` and `/push/subscriptions`
   * endpoints are registered and the `onPushed` hook fires push
   * dispatch for every message. Omit for tests or machine-only
   * deployments that don't need browser notifications.
   */
  pushStore?: PushSubscriptionStore;
  vapidPublicKey?: string;
  /**
   * Fired once per successful `/push` (or broker-level push) with the
   * stamped message. Runs in the background — do not await it in the
   * request path. The broker-fanout integration lives here so the
   * push-dispatch side effect stays out of the HTTP handler.
   */
  onPushed?: (message: Message) => void;
  /**
   * Virtual filesystem backing file attachments. The `/fs/*` endpoints
   * are registered iff this is provided, and `/push` gains attachment
   * validation + per-recipient grant materialization. Omit for
   * machine-only or chat-only deployments.
   */
  files?: FilesystemStore;
  /**
   * Per-file upload cap in bytes. Defaults to 25 MB. The broker caps
   * this at 1 GB regardless of config — tune upward with intent, not
   * by accident.
   */
  maxFileSize?: number;
  /**
   * Called after every successful member-store mutation (create /
   * update / delete / rotate-token / enroll-totp) with no arguments.
   * The runtime passes a closure that rewrites the on-disk team
   * config atomically; tests can pass a no-op when they don't care
   * about persistence. When omitted, member-mutation endpoints 501
   * rather than mutating in-memory without a durable backing.
   */
  persistMembers?: () => void;
  /**
   * Clock injection for tests — rate-limit book-keeping uses `now()`
   * so tests don't have to wall-clock-wait to see a lockout expire.
   */
  now?: () => number;
}

type AppBindings = AuthBindings;

/**
 * Rate-limit bucket for TOTP login attempts. Keyed by user name —
 * an attacker hammering one user can't accidentally lock a different
 * one out. In-memory, per-process; a restart clears the bucket, which
 * is acceptable at our scale (no distributed deployment yet).
 *
 * Sliding window: we count failures within `TOTP_LOCKOUT_WINDOW_MS`.
 * Lockout is implicit — when `failures >= TOTP_MAX_FAILURES` and the
 * window hasn't elapsed yet, any further attempt is rejected. Once
 * the window elapses the bucket is cleared and the user can try again.
 */
interface TotpLockout {
  failures: number;
  firstFailureAt: number;
}

// Per-user lockout — applies when the caller sent an explicit `user`
// hint (CLI / targeted login). Same 5/15min sliding window as before.
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

// Global codeless lockout — applies to the SPA's "just type a code"
// login path where the server iterates slots to find a match. With N
// enrolled slots each guess has N× the per-user hit chance, so we
// compensate with a tighter global cap in the same 15min window.
// 10 failures / 15min × 6-digit code space × ~10 enrolled slots works
// out to a multi-year expected-crack time, comparable to the old
// per-user flow.
const TOTP_CODELESS_MAX_FAILURES = 10;
const CODELESS_LOCKOUT_KEY = '__codeless__';

/**
 * The set of request paths we treat as "API." Any GET outside this
 * set falls through to the SPA fallback when `publicRoot` is set, so
 * client-side routes like `/login` or `/dm/build-bot` resolve to
 * `index.html` instead of 404. Keep in sync with `PATHS` + the
 * session endpoints.
 */
const API_PATH_PREFIXES = [
  PATHS.health,
  PATHS.briefing,
  PATHS.roster,
  PATHS.push,
  PATHS.subscribe,
  PATHS.history,
  PATHS.sessionTotp,
  PATHS.sessionLogout,
  PATHS.session,
  PATHS.pushVapidPublicKey,
  PATHS.pushSubscriptions,
  PATHS.objectives,
  '/agents',
  '/fs',
] as const;

const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
const HARD_CAP_MAX_FILE_SIZE = 1024 * 1024 * 1024;

function isApiPath(pathname: string): boolean {
  for (const p of API_PATH_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p)) {
      return true;
    }
  }
  return false;
}

export interface CreatedApp {
  /** The Hono application. Use `app.request(...)` in tests, or `app.fetch` as the server handler. */
  app: Hono<AppBindings>;
  /**
   * Wire WebSocket upgrade handling into the underlying Node HTTP
   * server so `/subscribe` and `/members/:name/activity/stream` can
   * upgrade. Call after `serve(...)` returns the server instance.
   */
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
}

export function createApp(options: AppOptions): CreatedApp {
  const {
    broker,
    members,
    sessions,
    team,
    objectives,
    activityStore,
    version,
    logger,
    shutdownSignal,
    secureCookies = false,
    publicRoot,
    pushStore,
    vapidPublicKey,
    onPushed,
  } = options;
  const { files, persistMembers } = options;
  const maxFileSize = Math.min(
    options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    HARD_CAP_MAX_FILE_SIZE,
  );
  const now = options.now ?? Date.now;
  const app = new Hono<AppBindings>();
  // WebSocket upgrade helper, bound to this app. Used by `/subscribe`
  // and `/members/:name/activity/stream`. The returned
  // `injectWebSocket` gets called by the server after `serve()` so
  // Node's HTTP server routes upgrade events to Hono.
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const auth = createAuthMiddleware({ members, sessions, logger });

  // Unified lockout map — per-user buckets keyed on name plus a
  // global "codeless" bucket keyed on a fixed sentinel. Both obey
  // the same sliding-window shape; they differ only in their
  // max-failures threshold (per-user = 5, codeless = 10).
  const totpLockouts = new Map<string, TotpLockout>();

  function maxFailuresFor(key: string): number {
    return key === CODELESS_LOCKOUT_KEY ? TOTP_CODELESS_MAX_FAILURES : TOTP_MAX_FAILURES;
  }

  function checkTotpLockout(key: string): { locked: boolean; retryAfter?: number } {
    const entry = totpLockouts.get(key);
    if (!entry) return { locked: false };
    const t = now();
    const elapsed = t - entry.firstFailureAt;
    if (elapsed >= TOTP_LOCKOUT_WINDOW_MS) {
      totpLockouts.delete(key);
      return { locked: false };
    }
    if (entry.failures >= maxFailuresFor(key)) {
      return {
        locked: true,
        retryAfter: Math.ceil((TOTP_LOCKOUT_WINDOW_MS - elapsed) / 1000),
      };
    }
    return { locked: false };
  }

  function recordTotpFailure(key: string): void {
    const t = now();
    const entry = totpLockouts.get(key);
    if (!entry || t - entry.firstFailureAt >= TOTP_LOCKOUT_WINDOW_MS) {
      totpLockouts.set(key, { failures: 1, firstFailureAt: t });
      return;
    }
    entry.failures += 1;
  }

  function clearTotpLockout(key: string): void {
    totpLockouts.delete(key);
  }

  // Enforce protocol version if the client sent the header. Missing header
  // is allowed for relaxed clients; wrong version is a 400.
  app.use('*', async (c, next) => {
    const header = c.req.header(PROTOCOL_HEADER);
    if (header && Number(header) !== PROTOCOL_VERSION) {
      return c.json(
        {
          error: `unsupported protocol version`,
          got: header,
          expected: PROTOCOL_VERSION,
        },
        400,
      );
    }
    await next();
  });

  app.get(PATHS.health, (c) => {
    return c.json({ status: 'ok' as const, version });
  });

  // ─── Session endpoints ────────────────────────────────────────────

  app.post(PATHS.sessionTotp, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = TotpLoginRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid login payload', details: parsed.error.issues }, 400);
    }
    const { member: providedName, code } = parsed.data;

    // Two paths:
    //   1. `member` was provided → targeted login (CLI, scripts that
    //      know their name). Uses the per-member rate-limit bucket.
    //   2. `member` was omitted → codeless login (SPA). Server
    //      iterates TOTP-enrolled members to find a match. Uses the
    //      tighter global `__codeless__` rate-limit bucket to
    //      compensate for the multi-member effective attack surface.
    const lockoutKey = providedName ?? CODELESS_LOCKOUT_KEY;
    const lockout = checkTotpLockout(lockoutKey);
    if (lockout.locked) {
      return c.json(
        { error: 'too many attempts; try again later', retryAfter: lockout.retryAfter },
        429,
      );
    }

    // Resolve which member we're about to verify against.
    let matched: LoadedMember | null = null;
    let matchedCounter = 0;

    if (providedName !== undefined) {
      const m = members.findByName(providedName);
      if (m?.totpSecret) {
        const verify = verifyTotpCode(m.totpSecret, code, m.totpLastCounter ?? 0, now());
        if (verify.ok) {
          matched = m;
          matchedCounter = verify.counter;
        }
      }
    } else {
      // Codeless: iterate every enrolled member. First ok-verify wins.
      for (const m of members.members()) {
        if (!m.totpSecret) continue;
        const verify = verifyTotpCode(m.totpSecret, code, m.totpLastCounter ?? 0, now());
        if (verify.ok) {
          matched = m;
          matchedCounter = verify.counter;
          break;
        }
      }
    }

    if (!matched) {
      recordTotpFailure(lockoutKey);
      logger.warn('totp login rejected', {
        path: providedName ? 'targeted' : 'codeless',
        ...(providedName ? { name: providedName } : {}),
      });
      return c.json({ error: 'invalid code' }, 401);
    }

    const matchedName = matched.name;

    members.recordTotpAccept(matchedName, matchedCounter);
    clearTotpLockout(lockoutKey);
    if (providedName === undefined) {
      clearTotpLockout(matchedName);
    }

    const userAgent = c.req.header('User-Agent') ?? null;
    const session = sessions.create(matchedName, userAgent);

    setCookie(c, SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

    logger.info('session created', {
      name: matchedName,
      path: providedName ? 'targeted' : 'codeless',
      expiresAt: session.expiresAt,
    });
    return c.json({
      member: matchedName,
      role: matched.role,
      permissions: matched.permissions,
      expiresAt: session.expiresAt,
    });
  });

  app.post(PATHS.sessionLogout, auth, (c) => {
    const sessionId = c.get('sessionId');
    if (sessionId) {
      sessions.delete(sessionId);
    }
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.body(null, 204);
  });

  app.get(PATHS.session, auth, (c) => {
    const member = c.get('member');
    const sessionId = c.get('sessionId');
    // Cookie-auth requests have a sessionId so we can return expiresAt;
    // bearer-auth requests (machine plane) do not, and we report the
    // far future so clients don't infer a misleading expiry.
    const expiresAt = sessionId
      ? (sessions.get(sessionId)?.expiresAt ?? now() + SESSION_TTL_MS)
      : Number.MAX_SAFE_INTEGER;
    return c.json({
      member: member.name,
      role: member.role,
      permissions: member.permissions,
      expiresAt,
    });
  });

  // ─── Team endpoints (dual-auth) ────────────────────────────────

  app.get(PATHS.briefing, auth, (c) => {
    const member = c.get('member');
    // Live open objectives for this member — included in the briefing
    // so the link can bake them into its tool descriptions at startup.
    // Active + blocked are both "on the plate"; done/cancelled drop off.
    const openObjectives: Objective[] = objectives
      ? [
          ...objectives.list({ assignee: member.name, status: 'active' }),
          ...objectives.list({ assignee: member.name, status: 'blocked' }),
        ]
      : [];
    const briefing = composeBriefing({
      self: member,
      team,
      teammates: teammatesFromMembers(members),
      openObjectives,
    });
    return c.json(briefing);
  });

  app.get(PATHS.roster, auth, (c) => {
    return c.json({
      teammates: teammatesFromMembers(members),
      connected: broker.listPresences(),
    });
  });

  app.post(PATHS.push, auth, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = PushPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid push payload', details: parsed.error.issues }, 400);
    }
    if (parsed.data.to && !broker.hasMember(parsed.data.to)) {
      return c.json({ error: `no such agent: ${parsed.data.to}` }, 404);
    }
    const member = c.get('member');

    // Attachment validation: every path must resolve, must be a file,
    // and the sender must have read access. The wire `size` / `mime`
    // / `name` fields are re-derived from the stored entry so the
    // sender can't lie about what they're attaching.
    const pushAttachmentsResult = canonicalizeAttachments(
      parsed.data.attachments,
      toViewer(member),
      files,
    );
    if (!pushAttachmentsResult.ok) {
      return c.json({ error: pushAttachmentsResult.error }, pushAttachmentsResult.status);
    }
    const canonicalAttachments = pushAttachmentsResult.canonical;

    const payload = canonicalAttachments
      ? { ...parsed.data, attachments: canonicalAttachments }
      : parsed.data;

    const result = await broker.push(payload, { from: member.name });

    // Grant fanout — for every recipient that isn't the owner, record
    // a read grant keyed on the message id. The recipient set is the
    // push's audience: targeted = {target, sender}, broadcast = all
    // slots. Owner self-grants are dropped by `files.grant` so we
    // don't need to filter here.
    if (files && canonicalAttachments.length > 0) {
      const recipients = new Set<string>();
      if (result.message.to) {
        recipients.add(result.message.to);
        if (member.name !== result.message.to) recipients.add(member.name);
      } else {
        for (const s of members.members()) recipients.add(s.name);
      }
      grantAttachmentsTo(files, canonicalAttachments, recipients, result.message.id, logger);
    }

    logger.info('push delivered', {
      messageId: result.message.id,
      from: member.name,
      targetAgent: parsed.data.to ?? '*broadcast*',
      attachments: canonicalAttachments.length,
      live: result.delivery.live,
      targets: result.delivery.targets,
    });
    // Fire-and-forget the push notification fanout. We don't await —
    // notification delivery shouldn't block the HTTP response, and
    // onPushed is responsible for its own error handling.
    if (onPushed) {
      queueMicrotask(() => {
        onPushed(result.message);
      });
    }
    return c.json(result);
  });

  // ─── Web Push endpoints ───────────────────────────────────────────

  if (vapidPublicKey !== undefined) {
    app.get(PATHS.pushVapidPublicKey, (c) => {
      return c.json({ publicKey: vapidPublicKey });
    });
  }

  if (pushStore !== undefined) {
    app.post(PATHS.pushSubscriptions, auth, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = PushSubscriptionPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid push subscription', details: parsed.error.issues }, 400);
      }
      const member = c.get('member');
      const userAgent = c.req.header('User-Agent') ?? null;
      const row = pushStore.upsert({
        memberName: member.name,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent,
      });
      logger.info('push subscription registered', {
        name: member.name,
        id: row.id,
      });
      return c.json({ id: row.id, endpoint: row.endpoint, createdAt: row.createdAt });
    });

    app.delete(`${PATHS.pushSubscriptions}/:id`, auth, (c) => {
      const idParam = c.req.param('id');
      const id = Number.parseInt(idParam, 10);
      if (!Number.isFinite(id) || id < 1) {
        return c.json({ error: 'invalid subscription id' }, 400);
      }
      const member = c.get('member');
      pushStore.deleteForMember(id, member.name);
      return c.body(null, 204);
    });
  }

  // ─── Objective endpoints ──────────────────────────────────────────
  // Registered iff an ObjectivesStore is provided — keeps chat-only
  // tests clean. Permission guards enforce the userType matrix:
  //   agent                 — see/update/complete objectives assigned to self
  //   operator / lead-agent — agent + create + cancel own-originated + see team
  //   admin                 — any mutation, see everything
  //
  // All mutations publish an `ObjectiveEvent` through the broker on
  // thread key `obj:<id>` so web clients + the link can react in
  // real time. The publish is fire-and-forget so an SSE failure
  // never blocks the HTTP response.
  if (objectives !== undefined) {
    /**
     * The set of names that belong to an objective's thread.
     * Originator + assignee + explicit watchers + every admin
     * ("admins see everything in their team"). For a `reassigned`
     * event, also include the previous assignee so they know the
     * objective left their plate. For a `watcher_removed` event,
     * also include the removed watcher so they get the exit
     * notification before the next event skips them entirely.
     *
     * This function is reused by the lifecycle-event publisher, the
     * `/discuss` endpoint, and the `/watchers` endpoint so every
     * surface that fans out a push uses the same membership rule.
     */
    const objectiveThreadMembers = (
      objective: Objective,
      extraEvent?: ObjectiveEvent,
    ): Set<string> => {
      const names = new Set<string>([objective.assignee, objective.originator]);
      for (const w of objective.watchers) names.add(w);
      // Members with `members.manage` are implicit thread participants
      // on every objective (observable-by-default for admins).
      for (const m of members.members()) {
        if (m.permissions.includes('members.manage')) names.add(m.name);
      }
      if (extraEvent?.kind === 'reassigned') {
        const fromCs = extraEvent.payload.from;
        if (typeof fromCs === 'string') names.add(fromCs);
      }
      if (extraEvent?.kind === 'watcher_removed') {
        const cs = extraEvent.payload.name;
        if (typeof cs === 'string') names.add(cs);
      }
      return names;
    };

    const publishObjectiveEvent = async (
      objective: Objective,
      event: ObjectiveEvent,
      actor: string,
    ): Promise<void> => {
      const threadKey = `obj:${objective.id}`;
      const primaryTargets = objectiveThreadMembers(objective, event);
      const body = systemMessageForEvent(objective, event.kind, event);
      for (const target of primaryTargets) {
        if (!broker.hasMember(target)) continue;
        try {
          await broker.push(
            {
              to: target,
              body,
              level: 'info',
              // Minimal machine meta: classification + ids for filtering.
              // The full objective state used to be serialized here as
              // `data.objective = JSON.stringify(...)`, but that landed
              // in the agent's channel-event envelope as a noisy XML
              // attribute. Agents read the human-readable `body` above
              // and call `objectives_view` for full state when they
              // need it — one extra tool call on the rare path, clean
              // events on the common path.
              data: {
                kind: 'objective',
                event: event.kind,
                objective_id: objective.id,
                objective_status: objective.status,
                thread: threadKey,
                actor,
              },
            },
            { from: actor },
          );
        } catch (err) {
          logger.warn('failed to fanout objective event', {
            objectiveId: objective.id,
            event: event.kind,
            target,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    function mapObjectivesError(err: unknown): { status: number; body: { error: string } } {
      if (err instanceof ObjectivesError) {
        const status =
          err.code === 'not_found'
            ? 404
            : err.code === 'terminal' || err.code === 'invalid_transition'
              ? 409
              : 400;
        return { status, body: { error: err.message } };
      }
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    // GET /objectives?assignee=&status=
    //
    // Agents see objectives they have any relationship with:
    // assigned, originated, or watching. Admins / operators /
    // lead-agents see team-wide. When an agent passes an explicit
    // `assignee` filter, it must match their own name — they can't
    // fish for other agents' plates. The watching filter has no
    // equivalent explicit param today; watched objectives appear in
    // the default list.
    app.get(PATHS.objectives, auth, (c) => {
      const member = c.get('member');
      const raw = {
        assignee: c.req.query('assignee'),
        status: c.req.query('status'),
      };
      const parsed = ListObjectivesQuerySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid query', details: parsed.error.issues }, 400);
      }
      const filter = parsed.data;

      const canListAny = hasPermission(member.permissions, 'objectives.create');
      if (!canListAny) {
        if (filter.assignee && filter.assignee !== member.name) {
          return c.json(
            { error: 'members without objectives.create may only list their own objectives' },
            403,
          );
        }
        // Default scope for a plain member: assigned OR originated OR watching.
        const all = objectives.list(filter.status ? { status: filter.status } : {});
        const scoped = all.filter(
          (o) =>
            o.assignee === member.name ||
            o.originator === member.name ||
            o.watchers.includes(member.name),
        );
        return c.json({ objectives: scoped });
      }
      return c.json({ objectives: objectives.list(filter) });
    });

    // GET /objectives/:id
    //
    // A thread participant (assignee, originator, watcher) can always
    // view. Anyone with `objectives.create` can view any.
    app.get(`${PATHS.objectives}/:id`, auth, (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const obj = objectives.get(id);
      if (!obj) return c.json({ error: `no such objective: ${id}` }, 404);
      const isParticipant =
        obj.assignee === member.name ||
        obj.originator === member.name ||
        obj.watchers.includes(member.name);
      if (!isParticipant && !hasPermission(member.permissions, 'objectives.create')) {
        return c.json(
          { error: 'not a thread participant; viewing requires objectives.create' },
          403,
        );
      }
      return c.json({ objective: obj, events: objectives.events(id) });
    });

    // POST /objectives — requires `objectives.create`.
    app.post(PATHS.objectives, auth, async (c) => {
      const member = c.get('member');
      if (!hasPermission(member.permissions, 'objectives.create')) {
        return c.json(
          { error: 'creating objectives requires the objectives.create permission' },
          403,
        );
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid objective payload', details: parsed.error.issues }, 400);
      }
      // Assignee must be a known user on the team.
      if (!members.findByName(parsed.data.assignee)) {
        return c.json({ error: `unknown assignee: ${parsed.data.assignee}` }, 400);
      }
      // Every initial watcher must also resolve — catch typos at
      // creation time, not on the first fanout attempt.
      if (Array.isArray(parsed.data.watchers)) {
        for (const w of parsed.data.watchers) {
          if (!members.findByName(w)) {
            return c.json({ error: `unknown watcher: ${w}` }, 400);
          }
        }
      }
      const createAttachmentsResult = canonicalizeAttachments(
        parsed.data.attachments,
        toViewer(member),
        files,
      );
      if (!createAttachmentsResult.ok) {
        return c.json({ error: createAttachmentsResult.error }, createAttachmentsResult.status);
      }
      const inputWithCanonical =
        createAttachmentsResult.canonical.length > 0
          ? { ...parsed.data, attachments: createAttachmentsResult.canonical }
          : parsed.data;
      try {
        const { objective: created, events } = objectives.create(inputWithCanonical, member.name);
        logger.info('objective created', {
          id: created.id,
          originator: member.name,
          assignee: created.assignee,
          attachments: created.attachments.length,
        });
        // Grant every initial thread member access to the attachments.
        // `objectiveThreadMembers` already knows the originator,
        // assignee, explicit watchers, and all admins — so one
        // call covers everyone who should see these files.
        if (files && created.attachments.length > 0) {
          const members = objectiveThreadMembers(created);
          grantAttachmentsTo(files, created.attachments, members, `obj:${created.id}`, logger);
        }
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(created, ev, member.name);
          }
        });
        return c.json(created);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // PATCH /objectives/:id — assignee, or a member with `objectives.cancel`.
    app.patch(`${PATHS.objectives}/:id`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (
        current.assignee !== member.name &&
        !hasPermission(member.permissions, 'objectives.cancel')
      ) {
        return c.json(
          {
            error: 'only the assignee or a member with objectives.cancel may update this objective',
          },
          403,
        );
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid update payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.update(id, parsed.data, member.name);
        // `events` can have 0-2 entries: 0 for a no-op (status=current,
        // no note), 1 for a single status transition or a note-only
        // update, 2 for a status transition + note in the same call.
        // Publish each one individually so each landing push carries
        // its own structured body — the note's note, the block's
        // block reason, etc.
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/complete (assignee only)
    app.post(`${PATHS.objectives}/:id/complete`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (current.assignee !== member.name) {
        return c.json({ error: 'only the assignee may complete this objective' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = CompleteObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid complete payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.complete(id, parsed.data, member.name);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/cancel — originator, or any member with `objectives.cancel`.
    app.post(`${PATHS.objectives}/:id/cancel`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      const isOriginator = current.originator === member.name;
      if (!(isOriginator || hasPermission(member.permissions, 'objectives.cancel'))) {
        return c.json({ error: 'cancel requires originator or objectives.cancel permission' }, 403);
      }
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CancelObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid cancel payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.cancel(id, parsed.data, member.name);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/reassign — requires `objectives.reassign`.
    app.post(`${PATHS.objectives}/:id/reassign`, auth, async (c) => {
      const member = c.get('member');
      if (!hasPermission(member.permissions, 'objectives.reassign')) {
        return c.json({ error: 'reassign requires the objectives.reassign permission' }, 403);
      }
      const id = c.req.param('id');
      const raw = await c.req.json().catch(() => null);
      const parsed = ReassignObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid reassign payload', details: parsed.error.issues }, 400);
      }
      if (!members.findByName(parsed.data.to)) {
        return c.json({ error: `unknown assignee: ${parsed.data.to}` }, 400);
      }
      try {
        const { objective: updated, events } = objectives.reassign(id, parsed.data, member.name);
        // Backfill attachment grants for the new assignee — they're
        // now a thread member and should be able to download
        // anything that was attached to the objective at creation.
        if (files && updated.attachments.length > 0) {
          grantAttachmentsTo(
            files,
            updated.attachments,
            [updated.assignee],
            `obj:${updated.id}`,
            logger,
          );
        }
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/watchers
    //
    // Add and/or remove watchers on an objective. Permitted to:
    //   - any admin (team-wide)
    //   - the originating operator / lead-agent (they own the
    //     objective they made)
    // Every name in both `add` and `remove` must resolve to a known
    // user. Watcher mutations produce `watcher_added` and
    // `watcher_removed` audit events that fan out to the full
    // post-change thread membership (plus removed parties so they
    // get the exit notification).
    app.post(`${PATHS.objectives}/:id/watchers`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);

      const isOriginator = current.originator === member.name;
      if (!(isOriginator || hasPermission(member.permissions, 'objectives.watch'))) {
        return c.json(
          { error: 'watcher changes require originator or objectives.watch permission' },
          403,
        );
      }

      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateWatchersRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid watchers payload', details: parsed.error.issues }, 400);
      }

      // Validate every name in both lists.
      for (const cs of parsed.data.add ?? []) {
        if (!members.findByName(cs)) {
          return c.json({ error: `unknown watcher: ${cs}` }, 400);
        }
      }
      for (const cs of parsed.data.remove ?? []) {
        if (!members.findByName(cs)) {
          return c.json({ error: `unknown watcher: ${cs}` }, 400);
        }
      }

      try {
        const { objective: updated, events } = objectives.updateWatchers(
          id,
          parsed.data,
          member.name,
        );
        // Every watcher_added event carries a name; backfill attachment
        // grants for each newly-added watcher so they can read files
        // that were attached to the objective before they joined the
        // thread.
        if (files && updated.attachments.length > 0) {
          const addedNames: string[] = [];
          for (const ev of events) {
            if (ev.kind === 'watcher_added' && typeof ev.payload.name === 'string') {
              addedNames.push(ev.payload.name);
            }
          }
          if (addedNames.length > 0) {
            grantAttachmentsTo(files, updated.attachments, addedNames, `obj:${updated.id}`, logger);
          }
        }
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, member.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/discuss (thread members only)
    //
    // Discussion posts are real team messages with thread key
    // `obj:<id>`. The server fans out to every thread member via
    // `broker.push` — one targeted push per member so the existing
    // single-`targetName` broker API still works. The message lands in
    // the event log alongside chat, visible in the web UI's inline
    // thread and in `recent`/`history` for anyone filtering by thread.
    //
    // The caller itself also receives its own message back via the
    // fanout (broker.push targets the sender). The link's self-echo
    // suppression DOES apply here — agents won't see their own
    // objective-discussion posts on the live stream — which is the
    // same behaviour as `broadcast`/`send`. The web client still
    // renders its own posts because the web SSE handler does NOT
    // suppress self-echoes.
    app.post(`${PATHS.objectives}/:id/discuss`, auth, async (c) => {
      const member = c.get('member');
      const id = c.req.param('id');
      const objective = objectives.get(id);
      if (!objective) return c.json({ error: `no such objective: ${id}` }, 404);

      const members = objectiveThreadMembers(objective);
      if (!members.has(member.name)) {
        return c.json(
          { error: `user '${member.name}' is not a member of objective ${id}'s thread` },
          403,
        );
      }

      const raw = await c.req.json().catch(() => null);
      const parsed = DiscussObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid discuss payload', details: parsed.error.issues }, 400);
      }

      const discussAttachmentsResult = canonicalizeAttachments(
        parsed.data.attachments,
        toViewer(member),
        files,
      );
      if (!discussAttachmentsResult.ok) {
        return c.json({ error: discussAttachmentsResult.error }, discussAttachmentsResult.status);
      }
      const discussAttachments = discussAttachmentsResult.canonical;

      const threadKey = `obj:${id}`;
      let canonical: Message | null = null;
      for (const target of members) {
        if (!broker.hasMember(target)) continue;
        try {
          const result = await broker.push(
            {
              to: target,
              body: parsed.data.body,
              title: parsed.data.title ?? null,
              level: 'info',
              data: {
                kind: 'objective_discuss',
                objective_id: id,
                thread: threadKey,
              },
              ...(discussAttachments.length > 0 ? { attachments: discussAttachments } : {}),
            },
            { from: member.name },
          );
          // Grab the first returned message as the canonical response
          // — every fanout push produces the same Message shape, and
          // callers just want to know "my post landed as msg X" so
          // they can dedupe. Subsequent fanouts reuse different ids
          // internally but that's the broker's concern.
          if (canonical === null) canonical = result.message;
        } catch (err) {
          logger.warn('failed to fanout objective discuss', {
            objectiveId: id,
            target,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Materialize grants for every thread member (minus the owner,
      // filtered inside files.grant). Use the message id so agents and
      // the Files panel can trace the grant back to a specific post.
      if (files && discussAttachments.length > 0 && canonical) {
        grantAttachmentsTo(files, discussAttachments, members, canonical.id, logger);
      }

      if (!canonical) {
        // Shouldn't happen — the caller is at least a member, and
        // `broker.hasMember` should be true for any active name.
        // Return 202 semantics as 200 with an empty-ish body rather
        // than faking a Message shape.
        return c.json({ error: 'no thread members are currently registered with the broker' }, 503);
      }
      return c.json(canonical);
    });
  }

  // `/subscribe` is a WebSocket endpoint — the browser / SDK open a
  // WS for their own member, and the server pipes every broker push
  // targeting them over `ws.send` as a JSON text frame. The pre-check
  // middleware below runs BEFORE the upgrade so a bad `name` or
  // identity mismatch returns a proper 400/403 HTTP response rather
  // than a half-upgraded socket.
  app.get(
    PATHS.subscribe,
    auth,
    async (c, next) => {
      const targetName = c.req.query('name');
      if (!targetName) {
        return c.json({ error: 'name query parameter is required' }, 400);
      }
      const member = c.get('member');
      if (targetName !== member.name) {
        logger.warn('subscribe rejected: identity mismatch', {
          targetName,
          name: member.name,
        });
        return c.json(
          {
            error:
              `user '${member.name}' cannot subscribe to '${targetName}'; ` +
              "the name query parameter must equal the caller's authenticated name",
          },
          403,
        );
      }
      await next();
    },
    upgradeWebSocket((c) => {
      // Pre-check middleware guaranteed a valid `name` and identity match.
      const targetName = c.req.query('name') as string;
      const member = c.get('member');
      let unsubscribe: (() => void) | null = null;
      let onShutdown: (() => void) | null = null;

      return {
        onOpen: (_evt, ws) => {
          unsubscribe = broker.subscribe(
            targetName,
            (message) => {
              try {
                ws.send(JSON.stringify(message));
              } catch (err) {
                logger.warn('ws send failed', {
                  targetName,
                  messageId: message.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            },
            { role: member.role, name: member.name },
          );

          // Shutdown fan-out: server.close() needs every live socket
          // to close before it returns. Without this, SIGTERM would
          // hang indefinitely on idle connections.
          onShutdown = () => {
            try {
              ws.close(1001, 'server shutting down');
            } catch {
              /* already closed */
            }
          };
          shutdownSignal?.addEventListener('abort', onShutdown, { once: true });

          logger.info('ws subscribe opened', { targetName, by: member.name });

          // Comms check — push a message through the normal channel so
          // the agent's first turn includes it in context. If the agent
          // has active objectives, the runner's context watchdog will
          // detect whether they're still in the LLM context after this
          // exchange and re-push them if not.
          if (objectives) {
            const active = [
              ...objectives.list({ assignee: member.name, status: 'active' }),
              ...objectives.list({ assignee: member.name, status: 'blocked' }),
            ];
            const body =
              active.length > 0
                ? `${member.name} online. ${active.length} active objective(s) on your plate.`
                : `${member.name} online. No active objectives.`;
            void broker.push(
              { to: member.name, body, title: 'comms check', level: 'info' },
              { from: 'ac7' },
            );
          }
        },
        onClose: () => {
          unsubscribe?.();
          if (onShutdown) {
            shutdownSignal?.removeEventListener('abort', onShutdown);
          }
          logger.info('ws subscribe closed', { targetName, by: member.name });
        },
        onError: (evt) => {
          logger.warn('ws subscribe error', {
            targetName,
            error: evt instanceof Error ? evt.message : 'ws error',
          });
        },
      };
    }),
  );

  app.get(PATHS.history, auth, async (c) => {
    const member = c.get('member');

    const withRaw = c.req.query('with');
    let withOther: string | undefined;
    if (withRaw !== undefined && withRaw.length > 0) {
      const parsed = NameSchema.safeParse(withRaw);
      if (!parsed.success) {
        return c.json({ error: '`with` must be a valid name', details: parsed.error.issues }, 400);
      }
      withOther = parsed.data;
    }

    const limitQuery = c.req.query('limit');
    const limit = clampQueryLimit(limitQuery === undefined ? undefined : Number(limitQuery));
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? Number(beforeRaw) : undefined;
    if (before !== undefined && !Number.isFinite(before)) {
      return c.json({ error: 'invalid `before` parameter' }, 400);
    }

    const eventLog = broker.getEventLog();
    const messages = await eventLog.query({
      viewer: member.name,
      with: withOther,
      limit,
      before,
    });
    return c.json({ messages });
  });

  // ─── Agent activity stream (registered iff `activityStore` is set) ──
  //
  // The runner streams decoded HTTP exchanges + objective lifecycle
  // markers here as they happen. Three endpoints:
  //
  //   POST /members/:name/activity          — self upload only
  //   GET  /members/:name/activity          — self OR admin
  //   GET  /members/:name/activity/stream   — WebSocket live tail, self OR admin
  //
  // The POST-self gate is strict: a user can only append its OWN
  // activity, regardless of userType. Admins read via GET; they
  // don't write on behalf of other users. The GET gate allows
  // self (so the user can introspect its own history) OR admin
  // (for team-wide observability).
  if (activityStore) {
    // Note: `AGENT_PATHS.activity` URL-encodes its argument (for
    // SDK client use), so we can't call it with `:name` here
    // — Hono would see `%3Aname` and never bind a param. Use
    // the literal path for server-side route registration.
    app.post('/members/:name/activity', auth, async (c) => {
      const member = c.get('member');
      const nameRaw = c.req.param('name');
      const parsedName = NameSchema.safeParse(nameRaw);
      if (!parsedName.success) {
        return c.json({ error: 'invalid name' }, 400);
      }
      const name = parsedName.data;
      if (name !== member.name) {
        return c.json(
          {
            error: `user '${member.name}' cannot upload activity for '${name}'`,
          },
          403,
        );
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = UploadActivityRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid activity payload', details: parsed.error.issues }, 400);
      }
      try {
        const rows = activityStore.append(name, parsed.data.events);

        // Objective context watchdog: after appending, check whether
        // any llm_exchange events are missing active objective IDs
        // from their context. If so, push a reminder so the agent
        // picks the objective back up.
        if (objectives) {
          checkObjectiveContext(parsed.data.events, name, objectives, broker, logger);
        }

        return c.json({ accepted: rows.length }, 201);
      } catch (err) {
        logger.warn('agent activity append failed', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: 'failed to append activity' }, 500);
      }
    });

    app.get('/members/:name/activity', auth, (c) => {
      const member = c.get('member');
      const nameRaw = c.req.param('name');
      const parsedName = NameSchema.safeParse(nameRaw);
      if (!parsedName.success) {
        return c.json({ error: 'invalid name' }, 400);
      }
      const name = parsedName.data;
      const isSelf = name === member.name;
      const canReadAny = hasPermission(member.permissions, 'activity.read');
      if (!isSelf && !canReadAny) {
        return c.json(
          { error: 'reading activity requires activity.read permission, or self' },
          403,
        );
      }
      const fromRaw = c.req.query('from');
      const toRaw = c.req.query('to');
      const limitRaw = c.req.query('limit');
      const kindRaw = c.req.queries('kind');

      const from = fromRaw !== undefined ? Number(fromRaw) : undefined;
      const to = toRaw !== undefined ? Number(toRaw) : undefined;
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (from !== undefined && !Number.isFinite(from)) {
        return c.json({ error: 'invalid `from` parameter' }, 400);
      }
      if (to !== undefined && !Number.isFinite(to)) {
        return c.json({ error: 'invalid `to` parameter' }, 400);
      }
      if (limit !== undefined && !Number.isFinite(limit)) {
        return c.json({ error: 'invalid `limit` parameter' }, 400);
      }
      // Validate each kind discriminator. Multiple ?kind= params
      // are AND-combined at query time, OR-combined at the store
      // level (row.kind IN (...)).
      const kinds: Array<'objective_open' | 'objective_close' | 'llm_exchange' | 'opaque_http'> =
        [];
      if (kindRaw) {
        for (const k of kindRaw) {
          const parsedKind = ActivityKindSchema.safeParse(k);
          if (!parsedKind.success) {
            return c.json({ error: `invalid kind: ${k}` }, 400);
          }
          kinds.push(parsedKind.data);
        }
      }
      const activity = activityStore.list({
        memberName: name,
        from,
        to,
        kinds: kinds.length > 0 ? kinds : undefined,
        limit,
      });
      return c.json({ activity });
    });

    // Activity tail — WebSocket. Every new row appended to the per-
    // member activity store is forwarded as a JSON text frame. The
    // pre-check middleware validates the name and permission so
    // rejection returns a proper HTTP error rather than a failed
    // upgrade handshake.
    const activity = activityStore;
    app.get(
      '/members/:name/activity/stream',
      auth,
      async (c, next) => {
        const member = c.get('member');
        const nameRaw = c.req.param('name');
        const parsedName = NameSchema.safeParse(nameRaw);
        if (!parsedName.success) {
          return c.json({ error: 'invalid name' }, 400);
        }
        const name = parsedName.data;
        const isSelf = name === member.name;
        const canReadAny = hasPermission(member.permissions, 'activity.read');
        if (!isSelf && !canReadAny) {
          return c.json(
            { error: 'streaming activity requires activity.read permission, or self' },
            403,
          );
        }
        await next();
      },
      upgradeWebSocket((c) => {
        const member = c.get('member');
        const name = NameSchema.parse(c.req.param('name'));
        let unsubscribe: (() => void) | null = null;
        let onShutdown: (() => void) | null = null;

        return {
          onOpen: (_evt, ws) => {
            unsubscribe = activity.subscribe(name, (row) => {
              try {
                ws.send(JSON.stringify(row));
              } catch (err) {
                logger.warn('activity ws send failed', {
                  name,
                  id: row.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            });
            onShutdown = () => {
              try {
                ws.close(1001, 'server shutting down');
              } catch {
                /* already closed */
              }
            };
            shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
            logger.info('activity ws opened', { name, by: member.name });
          },
          onClose: () => {
            unsubscribe?.();
            if (onShutdown) {
              shutdownSignal?.removeEventListener('abort', onShutdown);
            }
            logger.info('activity ws closed', { name, by: member.name });
          },
          onError: (evt) => {
            logger.warn('activity ws error', {
              name,
              error: evt instanceof Error ? evt.message : 'ws error',
            });
          },
        };
      }),
    );
  }

  // ─── User management endpoints ───────────────────────────────
  //
  // `GET /users` is dual-auth — every teammate can see who's on the
  // team. Mutating verbs are admin-only and require `persistMembers`
  // to be wired; without it, mutations would drift in-memory and lose
  // on restart so we 501 instead.
  //
  // The server generates the bearer token on create and rotate; the
  // plaintext is returned exactly once in the HTTP response. After
  // that only the hash lives on disk.
  //
  // Self-mutation exceptions: any authenticated member can rotate
  // their own token or (re-)enroll their own TOTP; members with
  // `members.manage` can do it on behalf of anyone else.

  app.get(PATHS.members, auth, (c) => {
    const member = c.get('member');
    // Full member records (with instructions) require members.manage;
    // otherwise return the public `Teammate` projection.
    if (hasPermission(member.permissions, 'members.manage')) {
      return c.json({ members: members.members().map(loadedToMember) });
    }
    return c.json({ members: teammatesFromMembers(members) });
  });

  app.post(PATHS.members, auth, async (c) => {
    const member = c.get('member');
    if (!hasPermission(member.permissions, 'members.manage')) {
      return c.json({ error: 'creating members requires the members.manage permission' }, 403);
    }
    if (!persistMembers) {
      return c.json(
        { error: 'member creation is not available (server missing persistMembers hook)' },
        501,
      );
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = CreateMemberRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid member payload', details: parsed.error.issues }, 400);
    }
    if (members.findByName(parsed.data.name)) {
      return c.json({ error: `member '${parsed.data.name}' already exists` }, 409);
    }
    let resolvedPerms: Permission[];
    try {
      resolvedPerms = resolvePermissions(
        parsed.data.permissions,
        team.permissionPresets,
        `create member '${parsed.data.name}'`,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const token = generateMemberToken();
    try {
      members.addMember({
        name: parsed.data.name,
        role: parsed.data.role,
        instructions: parsed.data.instructions ?? '',
        rawPermissions: [...parsed.data.permissions],
        permissions: resolvedPerms,
        token,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'failed to add member' }, 409);
    }
    persistMembers();
    const teammate: Teammate = {
      name: parsed.data.name,
      role: parsed.data.role,
      permissions: resolvedPerms,
    };
    broker.seedMembers([teammate]);
    logger.info('member created', {
      name: teammate.name,
      role: teammate.role,
      permissions: teammate.permissions,
      createdBy: member.name,
    });
    return c.json({ member: teammate, token });
  });

  app.patch(`${PATHS.members}/:name`, auth, async (c) => {
    const member = c.get('member');
    if (!hasPermission(member.permissions, 'members.manage')) {
      return c.json({ error: 'updating members requires the members.manage permission' }, 403);
    }
    if (!persistMembers) {
      return c.json({ error: 'member updates are not available (persistMembers missing)' }, 501);
    }
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);

    const raw = await c.req.json().catch(() => null);
    const parsed = UpdateMemberRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid update payload', details: parsed.error.issues }, 400);
    }
    // Guard the last-admin invariant when changing permissions.
    let nextPermissions: Permission[] | undefined;
    let nextRaw: string[] | undefined;
    if (parsed.data.permissions !== undefined) {
      try {
        nextPermissions = resolvePermissions(
          parsed.data.permissions,
          team.permissionPresets,
          `update member '${target.name}'`,
        );
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      nextRaw = [...parsed.data.permissions];
      const losingManage =
        target.permissions.includes('members.manage') &&
        !nextPermissions.includes('members.manage');
      if (losingManage) {
        const adminCount = members
          .members()
          .filter((m) => m.permissions.includes('members.manage')).length;
        if (adminCount <= 1) {
          return c.json(
            {
              error:
                'cannot remove members.manage from the last admin — promote someone else first',
            },
            409,
          );
        }
      }
    }
    const patch: UpdateMemberPatch = {};
    if (parsed.data.role !== undefined) patch.role = parsed.data.role;
    if (parsed.data.instructions !== undefined) patch.instructions = parsed.data.instructions;
    if (nextPermissions !== undefined) {
      patch.permissions = nextPermissions;
      patch.rawPermissions = nextRaw;
    }
    try {
      members.updateMember(parsedName.data, patch);
    } catch (err) {
      if (err instanceof MemberLoadError) return c.json({ error: err.message }, 400);
      throw err;
    }
    persistMembers();
    const updated = members.findByName(parsedName.data);
    if (!updated) {
      return c.json({ error: `member vanished after update: ${parsedName.data}` }, 500);
    }
    logger.info('member updated', { name: updated.name, patch, updatedBy: member.name });
    return c.json(loadedToMember(updated));
  });

  app.delete(`${PATHS.members}/:name`, auth, (c) => {
    const member = c.get('member');
    if (!hasPermission(member.permissions, 'members.manage')) {
      return c.json({ error: 'deleting members requires the members.manage permission' }, 403);
    }
    if (!persistMembers) {
      return c.json({ error: 'member deletion is not available (persistMembers missing)' }, 501);
    }
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);
    if (target.permissions.includes('members.manage')) {
      const adminCount = members
        .members()
        .filter((m) => m.permissions.includes('members.manage')).length;
      if (adminCount <= 1) {
        return c.json({ error: 'cannot delete the last admin — promote someone else first' }, 409);
      }
    }
    try {
      members.removeMember(parsedName.data);
    } catch (err) {
      if (err instanceof MemberLoadError) return c.json({ error: err.message }, 404);
      throw err;
    }
    persistMembers();
    logger.info('member deleted', { name: parsedName.data, deletedBy: member.name });
    return c.body(null, 204);
  });

  app.post(`${PATHS.members}/:name/rotate-token`, auth, (c) => {
    const member = c.get('member');
    if (!persistMembers) {
      return c.json({ error: 'rotate-token is not available (persistMembers missing)' }, 501);
    }
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);
    if (!hasPermission(member.permissions, 'members.manage') && member.name !== target.name) {
      return c.json({ error: 'rotate-token requires members.manage, or self' }, 403);
    }
    const token = generateMemberToken();
    try {
      members.rotateToken(parsedName.data, token);
    } catch (err) {
      if (err instanceof MemberLoadError) return c.json({ error: err.message }, 404);
      throw err;
    }
    persistMembers();
    logger.info('token rotated', { name: parsedName.data, rotatedBy: member.name });
    return c.json({ token });
  });

  app.post(`${PATHS.members}/:name/enroll-totp`, auth, (c) => {
    const member = c.get('member');
    if (!persistMembers) {
      return c.json({ error: 'enroll-totp is not available (persistMembers missing)' }, 501);
    }
    const targetRaw = c.req.param('name');
    const parsedName = NameSchema.safeParse(targetRaw);
    if (!parsedName.success) return c.json({ error: 'invalid member name' }, 400);
    const target = members.findByName(parsedName.data);
    if (!target) return c.json({ error: `no such member: ${parsedName.data}` }, 404);
    if (!hasPermission(member.permissions, 'members.manage') && member.name !== target.name) {
      return c.json({ error: 'enroll-totp requires members.manage, or self' }, 403);
    }
    const secret = generateSecret();
    members.setTotpSecret(parsedName.data, secret);
    persistMembers();
    logger.info('totp enrolled', { name: parsedName.data, enrolledBy: member.name });
    return c.json({
      totpSecret: secret,
      totpUri: otpauthUri({
        secret,
        issuer: `ac7-${team.name}`,
        label: target.name,
      }),
    });
  });

  // ─── Filesystem endpoints ─────────────────────────────────────
  //
  // Registered iff an FilesystemStore is provided. Permission checks
  // live in the store; this layer maps `FsError` codes onto HTTP
  // statuses and handles request/response plumbing (multipart vs raw
  // body, streaming downloads, JSON payload parsing).
  if (files) {
    const fsStore = files;

    app.get(PATHS.fsList, auth, (c) => {
      const pathRaw = c.req.query('path') ?? '/';
      const parsedPath = FsPathSchema.safeParse(pathRaw);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      try {
        const entries = fsStore.list(parsedPath.data, toViewer(c.get('member')));
        return c.json({ entries });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.get(PATHS.fsStat, auth, (c) => {
      const pathRaw = c.req.query('path');
      if (!pathRaw) return c.json({ error: '`path` query parameter is required' }, 400);
      const parsedPath = FsPathSchema.safeParse(pathRaw);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      try {
        const entry = fsStore.stat(parsedPath.data, toViewer(c.get('member')));
        if (!entry) return c.json({ error: `no such path: ${parsedPath.data}` }, 404);
        return c.json({ entry });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.get(PATHS.fsShared, auth, (c) => {
      const entries = fsStore.listShared(toViewer(c.get('member')));
      return c.json({ entries });
    });

    // `/fs/read/*` — catch-all, single URL-decoded segment per path
    // component so `<img src="/fs/read/alice/uploads/foo.png">` just
    // works. The `*` route lives in its own handler so Hono's
    // path-matcher treats it distinctly from /fs/read (no slash).
    app.get('/fs/read/*', auth, async (c) => {
      const rawPath = c.req.path.slice('/fs/read'.length);
      if (rawPath.length === 0 || rawPath === '/') {
        return c.json({ error: '`/fs/read/<path>` requires a file path' }, 400);
      }
      // Hono's URL already URL-decodes the path before we see it;
      // pass through to the store which does its own validation.
      const parsedPath = FsPathSchema.safeParse(rawPath);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      try {
        const { entry, stream } = fsStore.openReadStream(
          parsedPath.data,
          toViewer(c.get('member')),
        );
        const webStream = nodeStreamToWebStream(stream);
        return new Response(webStream, {
          status: 200,
          headers: {
            'Content-Type': entry.mimeType ?? 'application/octet-stream',
            ...(entry.size !== null ? { 'Content-Length': String(entry.size) } : {}),
            'Content-Disposition': `inline; filename="${encodeFilenameForHeader(entry.name)}"`,
          },
        });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.post(PATHS.fsWrite, auth, async (c) => {
      const pathRaw = c.req.query('path');
      const mime = c.req.query('mime');
      const collideRaw = c.req.query('collide') ?? 'error';
      if (!pathRaw) return c.json({ error: '`path` query parameter is required' }, 400);
      if (!mime) return c.json({ error: '`mime` query parameter is required' }, 400);
      const parsedPath = FsPathSchema.safeParse(pathRaw);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      const parsedCollide = FsWriteCollisionSchema.safeParse(collideRaw);
      if (!parsedCollide.success) {
        return c.json({ error: `invalid collide strategy: ${collideRaw}` }, 400);
      }
      const body = c.req.raw.body;
      if (!body) return c.json({ error: 'empty upload body' }, 400);
      const nodeStream = Readable.fromWeb(
        body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
      );
      try {
        const result = await fsStore.writeFile({
          path: parsedPath.data,
          mimeType: mime,
          writer: toViewer(c.get('member')),
          source: nodeStream,
          collision: parsedCollide.data,
          maxSize: maxFileSize,
        });
        return c.json(result);
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.post(PATHS.fsMkdir, auth, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = FsMkdirRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid mkdir payload', details: parsed.error.issues }, 400);
      }
      try {
        const recursive = parsed.data.recursive ?? false;
        const entry = fsStore.mkdir(parsed.data.path, toViewer(c.get('member')), { recursive });
        return c.json({ entry });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.delete(PATHS.fsRm, auth, async (c) => {
      const pathRaw = c.req.query('path');
      const recursiveRaw = c.req.query('recursive');
      if (!pathRaw) return c.json({ error: '`path` query parameter is required' }, 400);
      const parsedPath = FsPathSchema.safeParse(pathRaw);
      if (!parsedPath.success) {
        return c.json({ error: 'invalid path', details: parsedPath.error.issues }, 400);
      }
      const recursive = recursiveRaw === 'true' || recursiveRaw === '1';
      try {
        await fsStore.remove(parsedPath.data, toViewer(c.get('member')), { recursive });
        return c.body(null, 204);
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.post(PATHS.fsMv, auth, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = FsMoveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid move payload', details: parsed.error.issues }, 400);
      }
      try {
        const entry = fsStore.move(parsed.data.from, parsed.data.to, toViewer(c.get('member')));
        return c.json({ entry });
      } catch (err) {
        return mapFsError(c, err);
      }
    });
  }

  // ─── Static SPA serving (registered LAST so API routes match first) ─

  if (publicRoot && existsSync(publicRoot)) {
    // Absolute root works despite serveStatic's docstring — the
    // implementation uses `path.join(root, filename)` which handles
    // absolute `root` correctly. We guard `existsSync` up front so
    // a stale `publicRoot` prints a Hono warning at startup rather
    // than 404ing every request silently.
    //
    // Two-phase serving:
    //   1. Direct file match (assets, manifest, icons, the root index)
    //   2. SPA fallback — for any GET that isn't an API path AND
    //      wasn't a direct file hit, serve index.html so client-side
    //      routing (preact-iso) can take over.
    app.use('*', serveStatic({ root: publicRoot }));
    app.get('*', async (c, next) => {
      if (isApiPath(c.req.path)) return next();
      return serveStatic({ root: publicRoot, path: 'index.html' })(c, next);
    });
  }

  return { app, injectWebSocket };
}

/**
 * Objective context watchdog — scans uploaded LLM exchanges for
 * active objective IDs. If an objective is active for this user but
 * its ID doesn't appear anywhere in the exchange's system prompt or
 * messages, the agent has lost context (compaction, long session).
 * Pushes a reminder through the broker so the agent picks it back up.
 *
 * Debounced per user: only fires once per batch of uploads, and
 * only for the most recent exchange (checking every exchange in a
 * batch would spam on fast-uploading agents).
 */
const watchdogLastFired = new Map<string, number>();
const WATCHDOG_COOLDOWN_MS = 5 * 60 * 1000;

function checkObjectiveContext(
  events: ActivityEvent[],
  name: string,
  objectivesStore: ObjectivesStore,
  broker: Broker,
  logger: Logger,
): void {
  // Only inspect the most recent llm_exchange in this batch.
  const llmEvent = events.findLast((e) => e.kind === 'llm_exchange');
  if (!llmEvent || llmEvent.kind !== 'llm_exchange') return;

  const active = [
    ...objectivesStore.list({ assignee: name, status: 'active' }),
    ...objectivesStore.list({ assignee: name, status: 'blocked' }),
  ];
  if (active.length === 0) return;

  // Build a string from the full request context the agent sent to
  // the LLM: system prompt + all text content blocks.
  const entry = llmEvent.entry;
  const parts: string[] = [];
  if (entry.request.system) parts.push(entry.request.system);
  for (const m of entry.request.messages) {
    for (const block of m.content) {
      if ('text' in block && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  const contextText = parts.join(' ');

  const now = Date.now();
  const missing = active.filter((o) => {
    if (contextText.includes(o.id)) return false;
    const key = `${name}:${o.id}`;
    const last = watchdogLastFired.get(key) ?? 0;
    return now - last > WATCHDOG_COOLDOWN_MS;
  });
  if (missing.length === 0) return;

  const lines = missing.map((o) => `  ${o.id}: ${o.title}\n    outcome: ${o.outcome}`);
  const body =
    `You have ${missing.length} active objective(s) that are no longer in your context. ` +
    `Here they are — call \`objectives_view\` for full details:\n${lines.join('\n')}`;

  for (const o of missing) watchdogLastFired.set(`${name}:${o.id}`, now);

  void broker.push(
    { to: name, body, title: 'objective context reminder', level: 'notice' },
    { from: 'ac7' },
  );
  logger.info('objective context watchdog fired', {
    name,
    missing: missing.map((o) => o.id),
  });
}

/** Re-export so `LoadedMember` consumers don't have to dig into slots.ts. */
export type { LoadedMember };

/**
 * Validate + canonicalize a list of attachment claims. Server
 * re-derives name/size/mime from the stored entry so the caller
 * can't lie. Used by `/push`, `/objectives` create, and
 * `/objectives/:id/discuss` so every attachment-bearing path
 * shares the same resolver.
 *
 *   result.error      — a human-readable explanation; set iff
 *                       result.canonical is undefined
 *   result.status     — HTTP status to return alongside result.error
 *   result.canonical  — an array (possibly empty) of authoritative
 *                       Attachment objects to persist / fan out
 */
type CanonicalizeResult =
  | { ok: true; canonical: Attachment[] }
  | { ok: false; error: string; status: 400 | 403 };

function canonicalizeAttachments(
  claims: Attachment[] | undefined,
  viewer: ViewerContext,
  filesStore: FilesystemStore | undefined,
): CanonicalizeResult {
  if (!claims || claims.length === 0) return { ok: true, canonical: [] };
  if (!filesStore) {
    return {
      ok: false,
      error: 'file attachments are not enabled on this server',
      status: 400,
    };
  }
  const out: Attachment[] = [];
  for (const claim of claims) {
    try {
      const entry = filesStore.stat(claim.path, viewer);
      if (!entry) {
        return { ok: false, error: `attachment not found: ${claim.path}`, status: 400 };
      }
      if (entry.kind !== 'file') {
        return { ok: false, error: `attachment is a directory: ${claim.path}`, status: 400 };
      }
      if (entry.size === null || entry.mimeType === null) {
        return { ok: false, error: `attachment is corrupt: ${claim.path}`, status: 400 };
      }
      out.push({
        path: entry.path,
        name: entry.name,
        size: entry.size,
        mimeType: entry.mimeType,
      });
    } catch (err) {
      if (err instanceof FsError && err.code === 'forbidden') {
        return { ok: false, error: `no access to attachment: ${claim.path}`, status: 403 };
      }
      throw err;
    }
  }
  return { ok: true, canonical: out };
}

/**
 * Materialize read-grants for every (attachment, recipient) pair.
 * Owner self-grants are dropped inside `files.grant`, so callers
 * don't need to filter the recipient set.
 */
function grantAttachmentsTo(
  filesStore: FilesystemStore,
  attachments: Attachment[],
  recipients: Iterable<string>,
  grantKey: string,
  logger: Logger,
): void {
  for (const att of attachments) {
    for (const r of recipients) {
      try {
        filesStore.grant(att.path, r, grantKey);
      } catch (err) {
        logger.warn('failed to grant attachment access', {
          path: att.path,
          viewer: r,
          grantKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Project a LoadedMember onto the smaller shape the filesystem layer
 * consumes. The store only needs name + userType for permission
 * checks — keeping the surface lean makes it trivial to unit-test
 * without constructing a full user record.
 */
function toViewer(member: LoadedMember): ViewerContext {
  return { name: member.name, permissions: member.permissions };
}

/** Project a LoadedMember into the public `Member` wire shape. */
function loadedToMember(m: LoadedMember): {
  name: string;
  role: Role;
  permissions: readonly Permission[];
  instructions: string;
} {
  return {
    name: m.name,
    role: m.role,
    permissions: m.permissions,
    instructions: m.instructions,
  };
}

/**
 * Map an `FsError` to a Hono JSON response. Non-FsError throws
 * bubble up as 500s — the store never throws raw errors for
 * permission / shape issues.
 */
function mapFsError(c: Context<AppBindings>, err: unknown): Response {
  if (err instanceof FsError) {
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'forbidden'
          ? 403
          : err.code === 'too_large'
            ? 413
            : err.code === 'exists' ||
                err.code === 'not_a_directory' ||
                err.code === 'is_a_directory' ||
                err.code === 'not_empty'
              ? 409
              : 400;
    return c.json({ error: err.message, code: err.code }, status as 400 | 403 | 404 | 409 | 413);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

/**
 * Wrap a Node `Readable` into a web `ReadableStream<Uint8Array>` so
 * we can hand it to `new Response(...)`. `Readable.toWeb` returns a
 * loosely-typed stream; we narrow it at the boundary since every
 * value on the wire is a Uint8Array chunk.
 */
function nodeStreamToWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * RFC-5987 filename* encoding for Content-Disposition. Non-ASCII
 * characters are percent-encoded per UTF-8. Control characters and
 * the characters `"\` are replaced with `_` to keep the header safe.
 */
function encodeFilenameForHeader(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control chars from header values
  return name.replace(/[\x00-\x1f"\\]/g, '_');
}

/**
 * Render the human-readable body for a lifecycle event's channel push.
 * This is what the agent actually reads in its channel envelope — it
 * has to carry enough structured context that the agent can act on
 * the event without immediately calling `objectives_view`. Kept out of
 * the store so the store stays free of wire-format concerns.
 *
 * Format: a one-line header identifying the event, followed by a
 * structured block of `key: value` lines for the fields the agent
 * cares about. The lines are plain text (no JSON, no XML) so they
 * flow naturally in the agent's context window alongside chat.
 */
function systemMessageForEvent(
  objective: Objective,
  kind: ObjectiveEventKind,
  event: ObjectiveEvent | undefined,
): string {
  const header = `[objective ${kind}] ${objective.id}`;

  switch (kind) {
    case 'assigned': {
      return [
        header,
        `title:      ${objective.title}`,
        `outcome:    ${objective.outcome}`,
        `assignee:   ${objective.assignee}`,
        `originator: ${objective.originator}`,
        `status:     ${objective.status}`,
        objective.body ? `body:       ${objective.body}` : null,
      ]
        .filter((l): l is string => l !== null)
        .join('\n');
    }
    case 'blocked': {
      const reason =
        typeof event?.payload.reason === 'string' ? event.payload.reason : '(no reason given)';
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `reason:   ${reason}`,
      ].join('\n');
    }
    case 'unblocked': {
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `status:   active (resumed)`,
      ].join('\n');
    }
    case 'completed': {
      return [
        header,
        `title:    ${objective.title}`,
        `outcome:  ${objective.outcome}`,
        `assignee: ${objective.assignee}`,
        `result:   ${objective.result ?? ''}`,
      ].join('\n');
    }
    case 'cancelled': {
      const reason =
        typeof event?.payload.reason === 'string' ? event.payload.reason : '(no reason given)';
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `reason:   ${reason}`,
      ].join('\n');
    }
    case 'reassigned': {
      const from = typeof event?.payload.from === 'string' ? event.payload.from : '(unknown)';
      const to = typeof event?.payload.to === 'string' ? event.payload.to : objective.assignee;
      return [
        header,
        `title:   ${objective.title}`,
        `outcome: ${objective.outcome}`,
        `from:    ${from}`,
        `to:      ${to}`,
      ].join('\n');
    }
    case 'watcher_added': {
      const cs = typeof event?.payload.name === 'string' ? event.payload.name : '(unknown)';
      return [
        header,
        `title:    ${objective.title}`,
        `outcome:  ${objective.outcome}`,
        `watcher:  ${cs}`,
        `status:   ${objective.status}`,
      ].join('\n');
    }
    case 'watcher_removed': {
      const cs = typeof event?.payload.name === 'string' ? event.payload.name : '(unknown)';
      return [header, `title:   ${objective.title}`, `watcher: ${cs}`].join('\n');
    }
  }
}
