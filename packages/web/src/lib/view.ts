/**
 * View signal — which thread or panel is active in the shell.
 *
 * Signal-based rather than URL routing: single-page chat app with
 * no deep-link requirement. A router can layer on later if needed.
 *
 * `overview` is the team-overview panel: team name, directive, brief,
 * and the full roster with click-to-DM. The component is still
 * called `RosterPanel` since its dominant content is the teammate
 * list.
 */

import { signal } from '@preact/signals';
import { dmThreadKey, PRIMARY_THREAD } from './messages.js';

export type View =
  | { kind: 'thread'; key: string }
  | { kind: 'overview' }
  | { kind: 'objectives-list' }
  | { kind: 'objective-detail'; id: string }
  | { kind: 'objective-create' }
  | { kind: 'agent-detail'; name: string }
  | { kind: 'files'; path: string }
  | { kind: 'users' };

export const view = signal<View>({ kind: 'thread', key: PRIMARY_THREAD });

/**
 * Sidebar drawer open state — only meaningful at narrow widths where
 * the sidebar is an overlay rather than a static column. At md+ the
 * Sidebar ignores this signal entirely. Kept alongside `view`
 * because every view change should also close the drawer — it'd be
 * weird to tap a thread and stay staring at the sidebar on top of it.
 */
export const isSidebarOpen = signal(false);

export function openSidebar(): void {
  isSidebarOpen.value = true;
}

export function closeSidebar(): void {
  isSidebarOpen.value = false;
}

export function selectThread(key: string): void {
  view.value = { kind: 'thread', key };
  isSidebarOpen.value = false;
}

/**
 * Open (or switch to) a DM thread with the given counterpart
 * name. Used by RosterPanel clicks — the one concrete "start a
 * new conversation" entry point in the SPA. If no messages have
 * been exchanged yet, Sidebar still shows the thread via its
 * view-union logic, and Transcript renders a fresh-DM empty
 * state until the first message lands.
 */
export function selectDmWith(name: string): void {
  view.value = { kind: 'thread', key: dmThreadKey(name) };
  isSidebarOpen.value = false;
}

export function selectOverview(): void {
  view.value = { kind: 'overview' };
  isSidebarOpen.value = false;
}

export function selectObjectivesList(): void {
  view.value = { kind: 'objectives-list' };
  isSidebarOpen.value = false;
}

export function selectObjectiveDetail(id: string): void {
  view.value = { kind: 'objective-detail', id };
  isSidebarOpen.value = false;
}

export function selectObjectiveCreate(): void {
  view.value = { kind: 'objective-create' };
  isSidebarOpen.value = false;
}

/**
 * Open the agent detail page for a given name — metadata +
 * live activity timeline. Admin-gated server-side, but the UI
 * also only surfaces entry points (roster rows, objective
 * assignee fields, DM headers) when the viewer is an admin.
 * Non-admins who navigate here anyway see a permission-denied
 * inline error from the page itself.
 */
export function selectAgentDetail(name: string): void {
  view.value = { kind: 'agent-detail', name };
  isSidebarOpen.value = false;
}

/**
 * Open the Files browser at an explicit path. Use `/<viewer>/` to
 * land on the caller's own home; admins can pass any user's home.
 * The panel keeps its own breadcrumb state; this action is the
 * single entry point from outside.
 */
export function selectFiles(path: string): void {
  view.value = { kind: 'files', path };
  isSidebarOpen.value = false;
}

/** Open the Users admin page. Admin-only; sidebar hides it for others. */
export function selectUsers(): void {
  view.value = { kind: 'users' };
  isSidebarOpen.value = false;
}

export function __resetViewForTests(): void {
  view.value = { kind: 'thread', key: PRIMARY_THREAD };
  isSidebarOpen.value = false;
}
