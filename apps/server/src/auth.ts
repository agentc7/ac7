/**
 * Dual-auth middleware: bearer token OR session cookie, both resolving
 * to the same `LoadedUser`.
 *
 * ac7 has two auth planes:
 *   - machine (MCP link): `Authorization: Bearer ac7_...` — long-lived
 *     tokens in the config file, resolved via `slots.resolve(raw)`
 *   - human (web SPA):    `Cookie: ac7_session=...` — minted after TOTP
 *     verification, resolved via `sessions.get(id)` → `slots.findByName`
 *
 * Both paths attach the same `LoadedUser` to `c.var.user`. Downstream
 * handlers (/briefing, /push, /subscribe, /history) don't care which
 * plane authenticated the request — the identity surface is the user.
 *
 * Why a session *and* bearer token on the same request should never
 * happen in practice: the SPA only sends the cookie, the MCP link only
 * sends the bearer. If both appear, bearer wins (more specific), and
 * we log a debug note — this is almost certainly a dev-tool issue
 * rather than an attack.
 */

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Logger } from './logger.js';
import { SESSION_COOKIE_NAME, type SessionStore } from './sessions.js';
import type { LoadedUser, UserStore } from './slots.js';

export interface AuthDependencies {
  slots: UserStore;
  sessions: SessionStore;
  logger: Logger;
}

export type AuthBindings = {
  Variables: {
    user: LoadedUser;
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
  const { slots, sessions, logger } = deps;

  return async (c, next) => {
    // Bearer token wins if present — keeps machine-path semantics
    // identical to the pre-TOTP era.
    const header = c.req.header('Authorization');
    if (header?.startsWith('Bearer ')) {
      const raw = header.slice('Bearer '.length).trim();
      if (raw.length === 0) {
        return c.json({ error: 'missing bearer token' }, 401);
      }
      const user = slots.resolve(raw);
      if (!user) {
        return c.json({ error: 'unknown token' }, 401);
      }
      c.set('user', user);
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
      const user = slots.findByName(session.userName);
      if (!user) {
        // User was removed from config while a session was still live.
        // Nuke the session so subsequent requests don't keep hitting this.
        logger.warn('session references unknown user', {
          sessionId,
          name: session.userName,
        });
        sessions.delete(sessionId);
        return c.json({ error: 'session user no longer exists' }, 401);
      }
      sessions.touch(sessionId);
      c.set('user', user);
      c.set('sessionId', sessionId);
      await next();
      return;
    }

    return c.json({ error: 'missing credentials' }, 401);
  };
}
