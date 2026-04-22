/**
 * Host-provided callbacks — sign-out and background-401 handling.
 *
 * The shell can detect these conditions (user clicks "Sign out",
 * a background fetch returns 401) but can't act on them alone:
 *
 *   - OSS clears the session cookie via `POST /session/logout`.
 *   - SaaS calls Clerk's `useClerk().signOut()` + bounces to the
 *     dashboard.
 *
 * Both live outside the embedded shell. The host wires a callback
 * into TeamShell; the shell calls it at the right moment and trusts
 * the host to figure out where the user should end up.
 */

import { signal } from '@preact/signals';

export type SignOutHandler = () => void | Promise<void>;
export type UnauthorizedHandler = (notice?: string) => void;

const signOutRef = signal<SignOutHandler | null>(null);
const unauthorizedRef = signal<UnauthorizedHandler | null>(null);

/**
 * Read-only signal for "is sign-out available?" — panels render the
 * affordance conditionally so the SaaS (which owns sign-out outside
 * the shell) can suppress it by omitting the handler prop.
 */
export const hasSignOutHandler = signOutRef;

export function setSignOutHandler(h: SignOutHandler | null): void {
  signOutRef.value = h;
}

export function setUnauthorizedHandler(h: UnauthorizedHandler | null): void {
  unauthorizedRef.value = h;
}

/**
 * Invoked by the shell when the viewer clicks "Sign out." No-ops if
 * no handler is registered — the host omits it when sign-out is
 * managed entirely outside the shell (e.g., a SaaS that hides the
 * affordance via `slots`).
 */
export function handleSignOut(): void {
  const h = signOutRef.value;
  if (h === null) return;
  void h();
}

/**
 * Invoked when a background fetch surfaces 401. The host typically
 * routes the user to a login screen and surfaces `notice` so they
 * know why.
 */
export function handleUnauthorized(notice?: string): void {
  const h = unauthorizedRef.value;
  if (h === null) return;
  h(notice);
}

/** Test helpers — keep call sites isolated across test cases. */
export function __resetHandlersForTests(): void {
  signOutRef.value = null;
  unauthorizedRef.value = null;
}
