/**
 * Tri-auth middleware: bearer token, session cookie, OR JWT, all
 * resolving to the same `LoadedMember`.
 *
 * ac7 has three auth planes:
 *   - machine (MCP link): `Authorization: Bearer ac7_...` — opaque,
 *     long-lived tokens in the config file, resolved via
 *     `members.resolve(raw)`.
 *   - human (web SPA):    `Cookie: ac7_session=...` — minted after TOTP
 *     verification, resolved via `sessions.get(id)` → `members.findByName`.
 *   - federated JWT:      `Authorization: Bearer <jwt>` — RS256 token
 *     minted by a trusted issuer (SaaS platform or self-hosted federator)
 *     and verified against the configured JWKS. The `member` claim names
 *     a roster entry; unknown names are hard-rejected (memberships are
 *     managed via the invite flow, never by JWT side channels).
 *
 * The JWT and opaque-bearer planes share the `Authorization: Bearer`
 * header — we disambiguate by shape. Opaque tokens never contain dots;
 * JWTs are always three dot-separated base64url segments. When a JWT
 * verifier is configured AND the header matches JWT structure we take
 * the JWT branch; otherwise we fall through to the opaque lookup. If
 * the JWT branch runs and verification fails we 401 — we do not fall
 * through, because a structurally-valid JWT that fails verify is an
 * auth error, not an "unknown opaque token".
 *
 * All three paths attach the same `LoadedMember` to `c.var.member`.
 * Downstream handlers (/briefing, /push, /subscribe, /history) don't
 * care which plane authenticated the request — the identity surface
 * is the member.
 */

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { type JwtVerifier, looksLikeJwt } from './jwt.js';
import type { Logger } from './logger.js';
import type { LoadedMember, MemberStore } from './members.js';
import { SESSION_COOKIE_NAME, type SessionStore } from './sessions.js';

export interface AuthDependencies {
  members: MemberStore;
  sessions: SessionStore;
  logger: Logger;
  /**
   * Optional JWKS-backed JWT verifier. When present, bearer tokens
   * that look structurally like JWTs are verified against this
   * issuer; when omitted, the JWT path is dormant and every bearer
   * token follows the opaque lookup. Wiring is config-gated in
   * `runServer`.
   */
  jwt?: JwtVerifier;
}

export type AuthBindings = {
  Variables: {
    member: LoadedMember;
    /** Id of the session that authenticated, if any. Null on bearer auth. */
    sessionId: string | null;
  };
};

/**
 * Build the auth middleware. Returns a 401 with a specific error
 * string for each failure mode so the SPA can distinguish "no
 * credentials" from "stale session" and redirect accordingly.
 */
export function createAuthMiddleware(deps: AuthDependencies): MiddlewareHandler<AuthBindings> {
  const { members, sessions, logger, jwt } = deps;

  return async (c, next) => {
    // Bearer token wins if present — keeps machine-path semantics
    // identical to the pre-TOTP era.
    const header = c.req.header('Authorization');
    if (header?.startsWith('Bearer ')) {
      const raw = header.slice('Bearer '.length).trim();
      if (raw.length === 0) {
        return c.json({ error: 'missing bearer token' }, 401);
      }

      // JWT branch: structurally a JWT AND a verifier is configured.
      // A well-formed-but-unverifiable JWT is a hard 401 — we never
      // fall through to the opaque-token path from here, because that
      // would make any attacker's expired/forged JWT check twice
      // against unrelated credential stores.
      if (jwt && looksLikeJwt(raw)) {
        try {
          const claims = await jwt.verify(raw);
          const member = members.findByName(claims.member);
          if (!member) {
            // Phase 4: hard reject unknown members. Adding a member
            // is an out-of-band invite flow; a JWT can't conjure one
            // into existence.
            logger.debug('jwt names unknown member', {
              member: claims.member,
              sub: claims.subject,
            });
            return c.json({ error: 'unknown member' }, 401);
          }
          c.set('member', member);
          c.set('sessionId', null);
          await next();
          return;
        } catch (err) {
          logger.debug('jwt verify failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: 'invalid jwt' }, 401);
        }
      }

      // Opaque bearer path — long-lived token from the team config.
      const member = members.resolve(raw);
      if (!member) {
        return c.json({ error: 'unknown token' }, 401);
      }
      c.set('member', member);
      c.set('sessionId', null);
      await next();
      return;
    }

    // Session cookie path — human web UI.
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        // Expired or revoked. Return a distinct error so the SPA knows
        // to drop its session signal and redirect to /login.
        return c.json({ error: 'session expired' }, 401);
      }
      const member = members.findByName(session.memberName);
      if (!member) {
        // Member was removed from config while a session was still live.
        // Nuke the session so subsequent requests don't keep hitting this.
        logger.warn('session references unknown member', {
          sessionId,
          name: session.memberName,
        });
        sessions.delete(sessionId);
        return c.json({ error: 'session member no longer exists' }, 401);
      }
      sessions.touch(sessionId);
      c.set('member', member);
      c.set('sessionId', sessionId);
      await next();
      return;
    }

    return c.json({ error: 'missing credentials' }, 401);
  };
}
