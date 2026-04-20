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
 *   GET  /subscribe       — dual-auth, long-lived SSE stream of messages for a name
 *   GET  /history         — dual-auth, prior messages filtered by viewer scope
 *
 * Dual-auth = either `Authorization: Bearer <token>` (machine plane,
 * MCP link) or `Cookie: ac7_session=<id>` (human plane, web SPA).
 * Both resolve to the same `LoadedUser`, which downstream handlers
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
  Role,
  Team,
} from '@agentc7/sdk/types';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import type { ActivityStore } from './agent-activity.js';
import { type AuthBindings, createAuthMiddleware } from './auth.js';
import { composeBriefing } from './briefing.js';
import { FsError, type FilesystemStore, type ViewerContext } from './files/index.js';
import type { Logger } from './logger.js';
import { ObjectivesError, type ObjectivesStore } from './objectives.js';
import type { PushSubscriptionStore } from './push/store.js';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, type SessionStore } from './sessions.js';
import { type LoadedUser, type UserStore, teammatesFromUsers } from './slots.js';
import { verifyCode as verifyTotpCode } from './totp.js';

export interface AppOptions {
  broker: Broker;
  slots: UserStore;
  sessions: SessionStore;
  team: Team;
  roles: Record<string, Role>;
  /**
   * Objectives store — the server's authoritative task state. The
   * `/objectives*` endpoints are registered iff this is provided,
   * which lets tests opt out of the whole objectives surface when
   * they're only exercising chat paths.
   */
  objectives?: ObjectivesStore;
  /**
   * Per-user agent activity store — append-only timeline of
   * LLM exchanges, opaque HTTP, and objective lifecycle markers
   * the runner ships up via the streaming uploader. The
   * `/agents/:name/activity*` endpoints are registered iff
   * this is provided, same opt-out pattern as `objectives`.
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
   * Triggered when the server is shutting down. Open SSE streams
   * listen for this so they can tear down cleanly and let
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

export function createApp(options: AppOptions): Hono<AppBindings> {
  const {
    broker,
    slots,
    sessions,
    team,
    roles,
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
  const { files } = options;
  const maxFileSize = Math.min(
    options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    HARD_CAP_MAX_FILE_SIZE,
  );
  const now = options.now ?? Date.now;
  const app = new Hono<AppBindings>();

  const auth = createAuthMiddleware({ slots, sessions, logger });

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
    const { user: providedName, code } = parsed.data;

    // Two paths:
    //   1. `user` was provided → targeted login (CLI, scripts that
    //      know their name). Uses the per-user rate-limit bucket.
    //   2. `user` was omitted → codeless login (SPA). Server iterates
    //      TOTP-enrolled slots to find a match. Uses the tighter
    //      global `__codeless__` rate-limit bucket to compensate for
    //      the multi-user effective attack surface.
    const lockoutKey = providedName ?? CODELESS_LOCKOUT_KEY;
    const lockout = checkTotpLockout(lockoutKey);
    if (lockout.locked) {
      return c.json(
        { error: 'too many attempts; try again later', retryAfter: lockout.retryAfter },
        429,
      );
    }

    // Resolve which user we're about to verify against.
    // Targeted: look up by name (returns null on unknown/unenrolled).
    // Codeless: iterate all TOTP-enrolled slots in config order and
    // pick the first match. We iterate the full enrolled set even on
    // success to keep the verify loop's timing signal low (teams
    // have a handful of slots, not thousands, so cost is negligible).
    let matchedSlot: LoadedUser | null = null;
    let matchedCounter = 0;

    if (providedName !== undefined) {
      const user = slots.findByName(providedName);
      if (user?.totpSecret) {
        const verify = verifyTotpCode(user.totpSecret, code, user.totpLastCounter ?? 0, now());
        if (verify.ok) {
          matchedSlot = user;
          matchedCounter = verify.counter;
        }
      }
    } else {
      // Codeless: iterate every enrolled user. First ok-verify wins.
      // Ambiguous collisions (two slots with the same current code in
      // the same window) are statistically ~1-in-20K at 10 slots and
      // resolve in 30s when codes rotate, so first-match is fine.
      for (const user of slots.slots()) {
        if (!user.totpSecret) continue;
        const verify = verifyTotpCode(user.totpSecret, code, user.totpLastCounter ?? 0, now());
        if (verify.ok) {
          matchedSlot = user;
          matchedCounter = verify.counter;
          break;
        }
      }
    }

    if (!matchedSlot) {
      recordTotpFailure(lockoutKey);
      logger.warn('totp login rejected', {
        path: providedName ? 'targeted' : 'codeless',
        ...(providedName ? { name: providedName } : {}),
      });
      return c.json({ error: 'invalid code' }, 401);
    }

    const matchedName = matchedSlot.name;

    // Accept: persist the new counter, clear both lockout buckets
    // (codeless on success + per-user in case the caller had been
    // failing on the targeted path), mint a session.
    slots.recordTotpAccept(matchedName, matchedCounter);
    clearTotpLockout(lockoutKey);
    // If the caller was on the codeless path, also clear any stray
    // per-user lockout for the matched user so a successful codeless
    // login unblocks a legit user who'd been fat-fingering via CLI.
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
      user: matchedName,
      role: matchedSlot.role,
      authority: matchedSlot.userType,
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
    const user = c.get('user');
    const sessionId = c.get('sessionId');
    // Cookie-auth requests have a sessionId so we can return expiresAt;
    // bearer-auth requests (machine plane) do not, and we report the
    // far future so clients don't infer a misleading expiry.
    const expiresAt = sessionId
      ? (sessions.get(sessionId)?.expiresAt ?? now() + SESSION_TTL_MS)
      : Number.MAX_SAFE_INTEGER;
    return c.json({
      user: user.name,
      role: user.role,
      authority: user.userType,
      expiresAt,
    });
  });

  // ─── Team endpoints (dual-auth) ────────────────────────────────

  app.get(PATHS.briefing, auth, (c) => {
    const user = c.get('user');
    const selfRole = roles[user.role];
    if (!selfRole) {
      // Shouldn't happen — config validation ensures every user role
      // key exists in the roles map. Surface clearly if it does.
      logger.error('briefing: unknown role for user', {
        name: user.name,
        role: user.role,
      });
      return c.json({ error: `unknown role '${user.role}' for user '${user.name}'` }, 500);
    }
    // Live open objectives for this user — included in the briefing so
    // the link can bake them into its tool descriptions at startup.
    // Active + blocked are both "on the plate"; done/cancelled drop off.
    const openObjectives: Objective[] = objectives
      ? [
          ...objectives.list({ assignee: user.name, status: 'active' }),
          ...objectives.list({ assignee: user.name, status: 'blocked' }),
        ]
      : [];
    const briefing = composeBriefing({
      self: user,
      selfRole,
      team,
      teammates: teammatesFromUsers(slots),
      openObjectives,
    });
    return c.json(briefing);
  });

  app.get(PATHS.roster, auth, (c) => {
    return c.json({
      teammates: teammatesFromUsers(slots),
      connected: broker.listPresences(),
    });
  });

  app.post(PATHS.push, auth, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = PushPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid push payload', details: parsed.error.issues }, 400);
    }
    if (parsed.data.to && !broker.hasUser(parsed.data.to)) {
      return c.json({ error: `no such agent: ${parsed.data.to}` }, 404);
    }
    const user = c.get('user');

    // Attachment validation: every path must resolve, must be a file,
    // and the sender must have read access. The wire `size` / `mime`
    // / `name` fields are re-derived from the stored entry so the
    // sender can't lie about what they're attaching.
    const pushAttachmentsResult = canonicalizeAttachments(
      parsed.data.attachments,
      toViewer(user),
      files,
    );
    if (!pushAttachmentsResult.ok) {
      return c.json({ error: pushAttachmentsResult.error }, pushAttachmentsResult.status);
    }
    const canonicalAttachments = pushAttachmentsResult.canonical;

    const payload = canonicalAttachments
      ? { ...parsed.data, attachments: canonicalAttachments }
      : parsed.data;

    const result = await broker.push(payload, { from: user.name });

    // Grant fanout — for every recipient that isn't the owner, record
    // a read grant keyed on the message id. The recipient set is the
    // push's audience: targeted = {target, sender}, broadcast = all
    // slots. Owner self-grants are dropped by `files.grant` so we
    // don't need to filter here.
    if (files && canonicalAttachments.length > 0) {
      const recipients = new Set<string>();
      if (result.message.to) {
        recipients.add(result.message.to);
        if (user.name !== result.message.to) recipients.add(user.name);
      } else {
        for (const s of slots.slots()) recipients.add(s.name);
      }
      grantAttachmentsTo(files, canonicalAttachments, recipients, result.message.id, logger);
    }

    logger.info('push delivered', {
      messageId: result.message.id,
      from: user.name,
      targetAgent: parsed.data.to ?? '*broadcast*',
      attachments: canonicalAttachments.length,
      sse: result.delivery.sse,
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
      const user = c.get('user');
      const userAgent = c.req.header('User-Agent') ?? null;
      const row = pushStore.upsert({
        userName: user.name,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent,
      });
      logger.info('push subscription registered', {
        name: user.name,
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
      const user = c.get('user');
      pushStore.deleteForUser(id, user.name);
      return c.body(null, 204);
    });
  }

  // ─── Objective endpoints ──────────────────────────────────────────
  // Registered iff an ObjectivesStore is provided — keeps chat-only
  // tests clean. Permission guards enforce the authority matrix:
  //   individual-contributor   — can see/update/complete objectives assigned to self
  //   manager — individual-contributor + create + cancel own-originated + see team
  //   director  — any mutation, see everything
  //
  // All mutations publish an `ObjectiveEvent` through the broker on
  // thread key `obj:<id>` so web clients + the link can react in
  // real time. The publish is fire-and-forget so an SSE failure
  // never blocks the HTTP response.
  if (objectives !== undefined) {
    /**
     * The set of names that belong to an objective's thread.
     * Originator + assignee + explicit watchers + every user with
     * director authority ("directors see everything in their
     * team"). For a `reassigned` event, also include the previous
     * assignee so they know the objective left their plate. For a
     * `watcher_removed` event, also include the removed watcher so
     * they get the exit notification before the next event skips
     * them entirely.
     *
     * This function is reused by the lifecycle-event publisher, the
     * `/discuss` endpoint, and the `/watchers` endpoint so every
     * surface that fans out a push uses the same membership rule.
     */
    const objectiveThreadMembers = (
      objective: Objective,
      extraEvent?: ObjectiveEvent,
    ): Set<string> => {
      const members = new Set<string>([objective.assignee, objective.originator]);
      for (const w of objective.watchers) members.add(w);
      for (const s of slots.slots()) {
        if (s.userType === 'admin') members.add(s.name);
      }
      if (extraEvent?.kind === 'reassigned') {
        const fromCs = extraEvent.payload.from;
        if (typeof fromCs === 'string') members.add(fromCs);
      }
      if (extraEvent?.kind === 'watcher_removed') {
        const cs = extraEvent.payload.name;
        if (typeof cs === 'string') members.add(cs);
      }
      return members;
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
        if (!broker.hasUser(target)) continue;
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
    // IndividualContributors see objectives they have any relationship with:
    // assigned, originated, or watching. Manager+ see team-wide.
    // When an individual-contributor passes an explicit `assignee` filter, it must
    // match their own name — they can't fish for other individual-contributors'
    // plates. The watching filter has no equivalent explicit param
    // today; watched objectives appear in the default list.
    app.get(PATHS.objectives, auth, (c) => {
      const user = c.get('user');
      const raw = {
        assignee: c.req.query('assignee'),
        status: c.req.query('status'),
      };
      const parsed = ListObjectivesQuerySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid query', details: parsed.error.issues }, 400);
      }
      const filter = parsed.data;

      if (user.userType === 'agent') {
        if (filter.assignee && filter.assignee !== user.name) {
          return c.json(
            { error: 'individual-contributors may only list their own objectives' },
            403,
          );
        }
        // Default scope for an 'individual-contributor': assigned OR originated OR watching.
        // App-level filter on the full list is fine at team scale
        // where objective counts are in the dozens, not thousands.
        const all = objectives.list(filter.status ? { status: filter.status } : {});
        const scoped = all.filter(
          (o) =>
            o.assignee === user.name ||
            o.originator === user.name ||
            o.watchers.includes(user.name),
        );
        return c.json({ objectives: scoped });
      }
      return c.json({ objectives: objectives.list(filter) });
    });

    // GET /objectives/:id
    //
    // An individual-contributor can view an objective if they're the assignee, the
    // originator, or in the watcher list. Manager+ can view any.
    app.get(`${PATHS.objectives}/:id`, auth, (c) => {
      const user = c.get('user');
      const id = c.req.param('id');
      const obj = objectives.get(id);
      if (!obj) return c.json({ error: `no such objective: ${id}` }, 404);
      if (
        user.userType === 'agent' &&
        obj.assignee !== user.name &&
        obj.originator !== user.name &&
        !obj.watchers.includes(user.name)
      ) {
        return c.json(
          {
            error:
              'individual-contributors may only view objectives they are assigned, originated, or watching',
          },
          403,
        );
      }
      return c.json({ objective: obj, events: objectives.events(id) });
    });

    // POST /objectives (manager+)
    app.post(PATHS.objectives, auth, async (c) => {
      const user = c.get('user');
      if (user.userType === 'agent') {
        return c.json({ error: 'creating objectives requires manager or director' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid objective payload', details: parsed.error.issues }, 400);
      }
      // Assignee must be a known user on the team.
      if (!slots.findByName(parsed.data.assignee)) {
        return c.json({ error: `unknown assignee: ${parsed.data.assignee}` }, 400);
      }
      // Every initial watcher must also resolve — catch typos at
      // creation time, not on the first fanout attempt.
      if (Array.isArray(parsed.data.watchers)) {
        for (const w of parsed.data.watchers) {
          if (!slots.findByName(w)) {
            return c.json({ error: `unknown watcher: ${w}` }, 400);
          }
        }
      }
      const createAttachmentsResult = canonicalizeAttachments(
        parsed.data.attachments,
        toViewer(user),
        files,
      );
      if (!createAttachmentsResult.ok) {
        return c.json(
          { error: createAttachmentsResult.error },
          createAttachmentsResult.status,
        );
      }
      const inputWithCanonical = createAttachmentsResult.canonical.length > 0
        ? { ...parsed.data, attachments: createAttachmentsResult.canonical }
        : parsed.data;
      try {
        const { objective: created, events } = objectives.create(inputWithCanonical, user.name);
        logger.info('objective created', {
          id: created.id,
          originator: user.name,
          assignee: created.assignee,
          attachments: created.attachments.length,
        });
        // Grant every initial thread member access to the attachments.
        // `objectiveThreadMembers` already knows the originator,
        // assignee, explicit watchers, and all directors — so one
        // call covers everyone who should see these files.
        if (files && created.attachments.length > 0) {
          const members = objectiveThreadMembers(created);
          grantAttachmentsTo(
            files,
            created.attachments,
            members,
            `obj:${created.id}`,
            logger,
          );
        }
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(created, ev, user.name);
          }
        });
        return c.json(created);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // PATCH /objectives/:id (assignee OR director)
    app.patch(`${PATHS.objectives}/:id`, auth, async (c) => {
      const user = c.get('user');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (current.assignee !== user.name && user.userType !== 'admin') {
        return c.json({ error: 'only the assignee or a director may update this objective' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid update payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.update(id, parsed.data, user.name);
        // `events` can have 0-2 entries: 0 for a no-op (status=current,
        // no note), 1 for a single status transition or a note-only
        // update, 2 for a status transition + note in the same call.
        // Publish each one individually so each landing push carries
        // its own structured body — the note's note, the block's
        // block reason, etc.
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, user.name);
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
      const user = c.get('user');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (current.assignee !== user.name) {
        return c.json({ error: 'only the assignee may complete this objective' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = CompleteObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid complete payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.complete(id, parsed.data, user.name);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, user.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/cancel (originator manager+ or director)
    app.post(`${PATHS.objectives}/:id/cancel`, auth, async (c) => {
      const user = c.get('user');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      const isOriginator = current.originator === user.name;
      const isDirector = user.userType === 'admin';
      const isManager = (user.userType === 'operator' || user.userType === 'lead-agent');
      if (!(isDirector || (isManager && isOriginator))) {
        return c.json(
          { error: 'only the originating manager or a director may cancel this objective' },
          403,
        );
      }
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CancelObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid cancel payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.cancel(id, parsed.data, user.name);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, user.name);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/reassign (director only)
    app.post(`${PATHS.objectives}/:id/reassign`, auth, async (c) => {
      const user = c.get('user');
      if (user.userType !== 'admin') {
        return c.json({ error: 'only a director may reassign objectives' }, 403);
      }
      const id = c.req.param('id');
      const raw = await c.req.json().catch(() => null);
      const parsed = ReassignObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid reassign payload', details: parsed.error.issues }, 400);
      }
      if (!slots.findByName(parsed.data.to)) {
        return c.json({ error: `unknown assignee: ${parsed.data.to}` }, 400);
      }
      try {
        const { objective: updated, events } = objectives.reassign(id, parsed.data, user.name);
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
            void publishObjectiveEvent(updated, ev, user.name);
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
    //   - any director (team-wide admin)
    //   - the originating manager (they own the objective they made)
    // Every name in both `add` and `remove` must resolve to a
    // known user. Watcher mutations produce `watcher_added` and
    // `watcher_removed` audit events that fan out to the full
    // post-change thread membership (plus removed parties so they
    // get the exit notification).
    app.post(`${PATHS.objectives}/:id/watchers`, auth, async (c) => {
      const user = c.get('user');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);

      const isOriginator = current.originator === user.name;
      const isDirector = user.userType === 'admin';
      const isManager = (user.userType === 'operator' || user.userType === 'lead-agent');
      if (!(isDirector || (isManager && isOriginator))) {
        return c.json(
          {
            error:
              'only a director or the originating manager may change watchers on this objective',
          },
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
        if (!slots.findByName(cs)) {
          return c.json({ error: `unknown watcher: ${cs}` }, 400);
        }
      }
      for (const cs of parsed.data.remove ?? []) {
        if (!slots.findByName(cs)) {
          return c.json({ error: `unknown watcher: ${cs}` }, 400);
        }
      }

      try {
        const { objective: updated, events } = objectives.updateWatchers(
          id,
          parsed.data,
          user.name,
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
            grantAttachmentsTo(
              files,
              updated.attachments,
              addedNames,
              `obj:${updated.id}`,
              logger,
            );
          }
        }
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, user.name);
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
      const user = c.get('user');
      const id = c.req.param('id');
      const objective = objectives.get(id);
      if (!objective) return c.json({ error: `no such objective: ${id}` }, 404);

      const members = objectiveThreadMembers(objective);
      if (!members.has(user.name)) {
        return c.json(
          { error: `user '${user.name}' is not a member of objective ${id}'s thread` },
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
        toViewer(user),
        files,
      );
      if (!discussAttachmentsResult.ok) {
        return c.json(
          { error: discussAttachmentsResult.error },
          discussAttachmentsResult.status,
        );
      }
      const discussAttachments = discussAttachmentsResult.canonical;

      const threadKey = `obj:${id}`;
      let canonical: Message | null = null;
      for (const target of members) {
        if (!broker.hasUser(target)) continue;
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
            { from: user.name },
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
        // `broker.hasUser` should be true for any active name.
        // Return 202 semantics as 200 with an empty-ish body rather
        // than faking a Message shape.
        return c.json({ error: 'no thread members are currently registered with the broker' }, 503);
      }
      return c.json(canonical);
    });
  }

  app.get(PATHS.subscribe, auth, (c) => {
    const targetName = c.req.query('name');
    if (!targetName) {
      return c.json({ error: 'name query parameter is required' }, 400);
    }
    const user = c.get('user');

    // Identity check has to happen BEFORE we hand the stream to
    // streamSSE; otherwise the client sees 200 + an empty SSE stream
    // when we should be returning 403. `name` MUST equal the
    // caller's authenticated user name.
    if (targetName !== user.name) {
      logger.warn('subscribe rejected: identity mismatch', {
        targetName,
        name: user.name,
      });
      return c.json(
        {
          error:
            `user '${user.name}' cannot subscribe to '${targetName}'; ` +
            "the name query parameter must equal the caller's authenticated name",
        },
        403,
      );
    }

    return streamSSE(c, async (stream) => {
      // Identity was already verified above, so `broker.subscribe`
      // cannot throw AgentIdentityError here. If the pre-stream check
      // is ever relaxed, that's a bug — we'd serve 200 + empty-body.
      // Keep the check above watertight and don't add a redundant
      // post-stream catch that would hide the regression.
      const unsubscribe = broker.subscribe(
        targetName,
        async (message) => {
          try {
            await stream.writeSSE({
              id: message.id,
              data: JSON.stringify(message),
            });
          } catch (err) {
            logger.warn('sse write failed', {
              targetName,
              messageId: message.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        { role: user.role, name: user.name },
      );

      // Shutdown signal aborts all live streams so `http.Server.close()`
      // can finish. Without this, an idle SSE client would pin the
      // server open indefinitely and SIGTERM would hang.
      const onShutdown = () => {
        stream.abort();
      };
      shutdownSignal?.addEventListener('abort', onShutdown, { once: true });

      stream.onAbort(() => {
        unsubscribe();
        shutdownSignal?.removeEventListener('abort', onShutdown);
        logger.info('sse stream closed', { targetName, by: user.name });
      });

      logger.info('sse stream opened', { targetName, by: user.name });

      // Initial comment so clients see the connection immediately, even
      // if no push arrives for a while.
      await stream.writeSSE({ event: 'connected', data: targetName });

      // Comms check — push a message through the normal channel so
      // the agent's first turn includes it in context. If the agent
      // has active objectives, the runner's context watchdog will
      // detect whether they're still in the LLM context after this
      // exchange and re-push them if not.
      if (objectives) {
        const active = [
          ...objectives.list({ assignee: user.name, status: 'active' }),
          ...objectives.list({ assignee: user.name, status: 'blocked' }),
        ];
        const body =
          active.length > 0
            ? `${user.name} online. ${active.length} active objective(s) on your plate.`
            : `${user.name} online. No active objectives.`;
        void broker.push(
          { to: user.name, body, title: 'comms check', level: 'info' },
          { from: 'ac7' },
        );
      }

      // Keep the handler alive until the client disconnects or the
      // server is shutting down; send a periodic keepalive so idle
      // proxies don't drop us.
      while (!stream.aborted && !shutdownSignal?.aborted) {
        await stream.sleep(15_000);
        if (stream.aborted || shutdownSignal?.aborted) break;
        await stream.writeSSE({ event: 'keepalive', data: '' });
      }
    });
  });

  app.get(PATHS.history, auth, async (c) => {
    const user = c.get('user');

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
      viewer: user.name,
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
  //   POST /agents/:name/activity          — self upload only
  //   GET  /agents/:name/activity          — self OR director
  //   GET  /agents/:name/activity/stream   — SSE live tail, self OR director
  //
  // The POST-self gate is strict: a user can only append its OWN
  // activity, regardless of authority. Directors read via GET,
  // they don't write on behalf of other slots. The GET gate
  // allows self (so the user can introspect its own history) OR
  // director (for team-wide observability).
  if (activityStore) {
    // Note: `AGENT_PATHS.activity` URL-encodes its argument (for
    // SDK client use), so we can't call it with `:name` here
    // — Hono would see `%3Acallsign` and never bind a param. Use
    // the literal path for server-side route registration.
    app.post('/users/:name/activity', auth, async (c) => {
      const user = c.get('user');
      const callsignRaw = c.req.param('name');
      const parsedName = NameSchema.safeParse(callsignRaw);
      if (!parsedName.success) {
        return c.json({ error: 'invalid name' }, 400);
      }
      const name = parsedName.data;
      if (name !== user.name) {
        return c.json(
          {
            error: `user '${user.name}' cannot upload activity for '${name}'`,
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

    app.get('/users/:name/activity', auth, (c) => {
      const user = c.get('user');
      const callsignRaw = c.req.param('name');
      const parsedName = NameSchema.safeParse(callsignRaw);
      if (!parsedName.success) {
        return c.json({ error: 'invalid name' }, 400);
      }
      const name = parsedName.data;
      const isSelf = name === user.name;
      const isDirector = user.userType === 'admin';
      if (!isSelf && !isDirector) {
        return c.json({ error: 'only the user itself or a director may read this activity' }, 403);
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
        userName: name,
        from,
        to,
        kinds: kinds.length > 0 ? kinds : undefined,
        limit,
      });
      return c.json({ activity });
    });

    app.get('/users/:name/activity/stream', auth, (c) => {
      const user = c.get('user');
      const callsignRaw = c.req.param('name');
      const parsedName = NameSchema.safeParse(callsignRaw);
      if (!parsedName.success) {
        return c.json({ error: 'invalid name' }, 400);
      }
      const name = parsedName.data;
      const isSelf = name === user.name;
      const isDirector = user.userType === 'admin';
      if (!isSelf && !isDirector) {
        return c.json(
          { error: 'only the user itself or a director may stream this activity' },
          403,
        );
      }
      return streamSSE(c, async (stream) => {
        const unsubscribe = activityStore.subscribe(name, async (row) => {
          try {
            await stream.writeSSE({
              id: String(row.id),
              data: JSON.stringify(row),
            });
          } catch (err) {
            logger.warn('agent activity sse write failed', {
              name,
              id: row.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
        const onShutdown = (): void => {
          stream.abort();
        };
        shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
        stream.onAbort(() => {
          unsubscribe();
          shutdownSignal?.removeEventListener('abort', onShutdown);
          logger.info('agent activity sse stream closed', { name, by: user.name });
        });
        logger.info('agent activity sse stream opened', {
          name,
          by: user.name,
        });
        await stream.writeSSE({ event: 'connected', data: name });
        while (!stream.aborted && !shutdownSignal?.aborted) {
          await stream.sleep(15_000);
          if (stream.aborted || shutdownSignal?.aborted) break;
          await stream.writeSSE({ event: 'keepalive', data: '' });
        }
      });
    });
  }

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
        const entries = fsStore.list(parsedPath.data, toViewer(c.get('user')));
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
        const entry = fsStore.stat(parsedPath.data, toViewer(c.get('user')));
        if (!entry) return c.json({ error: `no such path: ${parsedPath.data}` }, 404);
        return c.json({ entry });
      } catch (err) {
        return mapFsError(c, err);
      }
    });

    app.get(PATHS.fsShared, auth, (c) => {
      const entries = fsStore.listShared(toViewer(c.get('user')));
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
        const { entry, stream } = fsStore.openReadStream(parsedPath.data, toViewer(c.get('user')));
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
        return c.json(
          { error: `invalid collide strategy: ${collideRaw}` },
          400,
        );
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
          writer: toViewer(c.get('user')),
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
        const entry = fsStore.mkdir(parsed.data.path, toViewer(c.get('user')), { recursive });
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
        await fsStore.remove(parsedPath.data, toViewer(c.get('user')), { recursive });
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
        const entry = fsStore.move(parsed.data.from, parsed.data.to, toViewer(c.get('user')));
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

  return app;
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

/** Re-export so `LoadedUser` consumers don't have to dig into slots.ts. */
export type { LoadedUser };

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
 * Project a LoadedUser onto the smaller shape the filesystem layer
 * consumes. The store only needs name + authority for permission
 * checks — keeping the surface lean makes it trivial to unit-test
 * without constructing a full user record.
 */
function toViewer(user: LoadedUser): ViewerContext {
  return { name: user.name, userType: user.userType };
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
  return c.json(
    { error: err instanceof Error ? err.message : String(err) },
    500,
  );
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
