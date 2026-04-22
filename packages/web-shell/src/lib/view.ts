/**
 * View signal — which thread or panel is active.
 *
 * `view` is now derived from the router's `currentRoute`. The URL is
 * the source of truth; this computed is a translation layer that lets
 * existing components keep reading a `View` discriminated-union
 * without caring about URL parsing.
 *
 * All the legacy `select*` helpers are preserved as thin wrappers
 * around `navigate(route)` so callers never touch the router module
 * directly. Each also closes the mobile sidebar drawer — tapping a
 * nav item and staring at the sidebar on top of the new view would
 * feel broken.
 */

import { computed, signal } from '@preact/signals';
import { DM_PREFIX, dmThreadKey, isDmThread, PRIMARY_THREAD } from './messages.js';
import { currentRoute, navigate } from './router.js';
import type { ProfileTab, Route } from './routes.js';

export type View =
  | { kind: 'thread'; key: string }
  | { kind: 'overview' }
  | { kind: 'inbox' }
  | { kind: 'account' }
  | { kind: 'objectives-list' }
  | { kind: 'objective-detail'; id: string }
  | { kind: 'objective-create' }
  | { kind: 'member-profile'; name: string; tab: ProfileTab }
  | { kind: 'files'; path: string }
  | { kind: 'members' };

export const view = computed<View>(() => viewFromRoute(currentRoute.value));

function viewFromRoute(route: Route): View {
  switch (route.kind) {
    case 'home':
      return { kind: 'overview' };
    case 'inbox':
      return { kind: 'inbox' };
    case 'account':
      return { kind: 'account' };
    case 'thread-primary':
      return { kind: 'thread', key: PRIMARY_THREAD };
    case 'thread-dm':
      return { kind: 'thread', key: dmThreadKey(route.name) };
    case 'objectives-list':
      return { kind: 'objectives-list' };
    case 'objective-create':
      return { kind: 'objective-create' };
    case 'objective-detail':
      return { kind: 'objective-detail', id: route.id };
    case 'members':
      return { kind: 'members' };
    case 'member-profile':
      return { kind: 'member-profile', name: route.name, tab: route.tab };
    case 'files':
      return { kind: 'files', path: route.path };
  }
}

/**
 * Mobile sidebar drawer — not routing state. The desktop sidebar is
 * always visible; on narrow viewports it becomes an overlay that
 * opens/closes independently of the active view.
 */
export const isSidebarOpen = signal(false);

export function openSidebar(): void {
  isSidebarOpen.value = true;
}

export function closeSidebar(): void {
  isSidebarOpen.value = false;
}

export function selectThread(key: string): void {
  if (key === PRIMARY_THREAD) {
    navigate({ kind: 'thread-primary' });
  } else if (isDmThread(key)) {
    navigate({ kind: 'thread-dm', name: key.slice(DM_PREFIX.length) });
  }
  // `obj:<id>` threads don't have a top-level URL — they surface
  // inside the objective detail view. Ignore the call; callers
  // asking for such a thread should route to the objective instead.
  isSidebarOpen.value = false;
}

export function selectDmWith(name: string): void {
  navigate({ kind: 'thread-dm', name });
  isSidebarOpen.value = false;
}

export function selectOverview(): void {
  navigate({ kind: 'home' });
  isSidebarOpen.value = false;
}

export function selectInbox(): void {
  navigate({ kind: 'inbox' });
  isSidebarOpen.value = false;
}

export function selectAccount(): void {
  navigate({ kind: 'account' });
  isSidebarOpen.value = false;
}

export function selectObjectivesList(): void {
  navigate({ kind: 'objectives-list' });
  isSidebarOpen.value = false;
}

export function selectObjectiveDetail(id: string): void {
  navigate({ kind: 'objective-detail', id });
  isSidebarOpen.value = false;
}

export function selectObjectiveCreate(): void {
  navigate({ kind: 'objective-create' });
  isSidebarOpen.value = false;
}

export function selectAgentDetail(name: string): void {
  selectMemberProfile(name);
}

export function selectMemberProfile(name: string, tab: ProfileTab = 'overview'): void {
  navigate({ kind: 'member-profile', name, tab });
  isSidebarOpen.value = false;
}

export function selectFiles(path: string): void {
  navigate({ kind: 'files', path });
  isSidebarOpen.value = false;
}

export function selectMembers(): void {
  navigate({ kind: 'members' });
  isSidebarOpen.value = false;
}

export function __resetViewForTests(): void {
  // Clearing the router to `/` maps to view { kind: 'overview' } via
  // the computed above. The shell tests were originally written
  // against a default of primary-thread; we preserve that by
  // navigating explicitly.
  navigate({ kind: 'thread-primary' }, { replace: true });
  isSidebarOpen.value = false;
}
