/**
 * Router — browser history ↔ `currentRoute` signal.
 *
 * URL is the single source of truth for view state. On module load
 * we boot the signal from `window.location.pathname` and subscribe
 * to `popstate` so the back/forward buttons update the app state.
 * In-app navigation goes through `navigate(route)`, which pushes to
 * the History API and updates the signal.
 *
 * Derived concerns (the legacy `view` signal, drawer state, etc.)
 * read from `currentRoute` — they never set it directly. The only
 * writers are this module's `navigate` + the popstate listener.
 */

import { signal } from '@preact/signals';
import { formatRoute, parseRoute, type Route, routesEqual } from './routes.js';

function initialRoute(): Route {
  if (typeof window === 'undefined') return { kind: 'home' };
  return parseRoute(window.location.pathname);
}

export const currentRoute = signal<Route>(initialRoute());

let popstateInstalled = false;
function installPopstate(): void {
  if (popstateInstalled || typeof window === 'undefined') return;
  window.addEventListener('popstate', () => {
    currentRoute.value = parseRoute(window.location.pathname);
  });
  popstateInstalled = true;
}
installPopstate();

/**
 * In-app navigation. No-ops when the target matches the current
 * route (so repeated clicks on the same nav item don't pile history
 * entries). Pass `{ replace: true }` for redirects (e.g. mapping an
 * unknown URL to home without polluting the back stack).
 */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  if (routesEqual(currentRoute.value, route)) return;
  currentRoute.value = route;
  if (typeof window === 'undefined') return;
  const url = formatRoute(route);
  if (options.replace) {
    window.history.replaceState(null, '', url);
  } else {
    window.history.pushState(null, '', url);
  }
}

/**
 * Reset to the initial state — test-only. Restores the `/` URL and
 * resets the signal so each test starts from a clean slate.
 */
export function __resetRouterForTests(): void {
  currentRoute.value = { kind: 'home' };
  if (typeof window !== 'undefined') {
    window.history.replaceState(null, '', '/');
  }
}
