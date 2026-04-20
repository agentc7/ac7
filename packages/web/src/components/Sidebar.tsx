/**
 * Sidebar — overview shortcut + presence list.
 *
 *   ┌───────────────────────┐
 *   │  ━━ COMMAND           │  section label (canonical .eyebrow)
 *   │  Overview             │  navitem (active = solid)
 *   │  Objectives  ▣ 3      │  navitem with badge
 *   ├───────────────────────┤
 *   │  ━━ TEAM          │
 *   │  Team Chat            │
 *   │  ● build-bot · D      │  presence dot + name + authority
 *   │  ○ scout              │
 *   │  …                    │
 *   ├───────────────────────┤
 *   │  ⏏  sign out          │
 *   └───────────────────────┘
 *
 * Uses canonical .navitem (theme.css) for primary nav rows. Presence
 * dot is the canonical .dot pattern. Unread badge is .badge.solid.
 */

import type { UserType, Teammate } from '@agentc7/sdk/types';
import { canManageUsers } from '@agentc7/sdk/types';
import type { ComponentChildren } from 'preact';
import { briefing } from '../lib/briefing.js';
import { dmThreadKey, messagesByThread, PRIMARY_THREAD } from '../lib/messages.js';
import { objectives } from '../lib/objectives.js';
import { roster } from '../lib/roster.js';
import { logout } from '../lib/session.js';
import { lastReadByThread, unreadCount } from '../lib/unread.js';
import {
  closeSidebar,
  isSidebarOpen,
  selectDmWith,
  selectFiles,
  selectObjectivesList,
  selectOverview,
  selectThread,
  selectUsers,
  view,
} from '../lib/view.js';

export interface SidebarProps {
  viewer: string;
}

/** Pill-shape unread counter. Caps at "99+". */
function UnreadBadge({ count }: { count: number }) {
  const label = count > 99 ? '99+' : String(count);
  return (
    <span
      class="badge solid"
      style="font-size:9.5px;padding:2px 6px;min-width:20px;justify-content:center"
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

/** Short tag for the teammate row. Plain agents have no tag. */
function userTypeBadge(userType: UserType): string | null {
  if (userType === 'admin') return 'A';
  if (userType === 'operator') return 'OP';
  if (userType === 'lead-agent') return 'LEAD';
  return null;
}

export function Sidebar({ viewer }: SidebarProps) {
  const v = view.value;
  const r = roster.value;
  const b = briefing.value;
  const lastRead = lastReadByThread.value;
  const msgMap = messagesByThread.value;

  const teammatesSource: Teammate[] = r?.teammates ?? b?.teammates ?? [];
  const teammates = teammatesSource.filter((t) => t.name !== viewer);

  const onlineByName = new Map<string, number>();
  if (r) {
    for (const a of r.connected) onlineByName.set(a.name, a.connected);
  }

  const overviewActive = v.kind === 'overview';
  const teamChatActive = v.kind === 'thread' && v.key === PRIMARY_THREAD;
  const teamChatUnread = unreadCount(PRIMARY_THREAD, viewer, lastRead, msgMap);
  const drawerOpen = isSidebarOpen.value;
  const objectivesActive =
    v.kind === 'objectives-list' || v.kind === 'objective-detail' || v.kind === 'objective-create';
  const filesActive = v.kind === 'files';
  const usersActive = v.kind === 'users';
  const isAdmin = b !== null && canManageUsers(b.userType);
  const activeObjectiveCount = objectives.value.filter(
    (o) => o.assignee === viewer && (o.status === 'active' || o.status === 'blocked'),
  ).length;

  return (
    <>
      {drawerOpen && (
        <button
          type="button"
          onClick={closeSidebar}
          aria-label="Close sidebar"
          class="md:hidden fixed inset-0 z-30"
          style="background:rgba(14,28,43,0.45)"
        />
      )}
      <nav
        class={`flex-shrink-0 flex-col
          md:static md:flex md:w-52 md:translate-x-0 md:shadow-none md:z-0
          fixed inset-y-0 left-0 z-50 w-[85vw] max-w-72 transition-transform duration-200
          ${drawerOpen ? 'translate-x-0 flex shadow-2xl' : '-translate-x-full hidden md:flex md:-translate-x-0'}`}
        style="background:var(--paper);border-right:1px solid var(--rule);padding-left:env(safe-area-inset-left);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)"
      >
        {/* ── Overview + Objectives ───────────────────────────────── */}
        {/* Section wrapper has NO horizontal padding so the active-row
            highlight can run edge-to-edge. Each navitem applies its own
            inner padding instead. */}
        <div style="padding:8px 0;border-bottom:1px solid var(--rule)">
          <NavLink
            label="Overview"
            active={overviewActive}
            onClick={selectOverview}
            ariaLabel="Open team overview"
          />
          <NavLink
            label="Objectives"
            active={objectivesActive}
            onClick={selectObjectivesList}
            ariaLabel={
              activeObjectiveCount > 0
                ? `Open objectives panel (${activeObjectiveCount} on your plate)`
                : 'Open objectives panel'
            }
            trailing={
              activeObjectiveCount > 0 && !objectivesActive ? (
                <UnreadBadge count={activeObjectiveCount} />
              ) : undefined
            }
          />
          <NavLink
            label="Files"
            active={filesActive}
            onClick={() => selectFiles(`/${viewer}`)}
            ariaLabel="Browse files"
          />
          {isAdmin && (
            <NavLink
              label="Users"
              active={usersActive}
              onClick={selectUsers}
              ariaLabel="Manage users"
            />
          )}
        </div>

        {/* ── Team section (Team Chat + DMs) ──────────────────── */}
        <ul
          class="flex-1 overflow-y-auto"
          style="padding:12px 0 8px;list-style:none;margin:0;-webkit-overflow-scrolling:touch;overscroll-behavior:none;touch-action:manipulation"
        >
          <li>
            <p class="eyebrow" style="padding:0 12px 6px">
              Team
            </p>
          </li>
          <li>
            <NavLink
              label="Team Chat"
              active={teamChatActive}
              onClick={() => selectThread(PRIMARY_THREAD)}
              ariaLabel={
                teamChatUnread > 0 ? `Open Team Chat (${teamChatUnread} unread)` : 'Open Team Chat'
              }
              trailing={
                teamChatUnread > 0 && !teamChatActive ? (
                  <UnreadBadge count={teamChatUnread} />
                ) : undefined
              }
            />
          </li>
          {teammates.map((t) => {
            const connected = onlineByName.get(t.name) ?? 0;
            const online = connected > 0;
            const active = v.kind === 'thread' && v.key === dmThreadKey(t.name);
            const unread = unreadCount(dmThreadKey(t.name), viewer, lastRead, msgMap);
            const auth = userTypeBadge(t.userType);
            return (
              <li key={t.name}>
                <button
                  type="button"
                  onClick={() => selectDmWith(t.name)}
                  aria-label={
                    unread > 0
                      ? `Message ${t.name} (${online ? 'online' : 'offline'}, ${unread} unread)`
                      : `Message ${t.name} (${online ? 'online' : 'offline'})`
                  }
                  title={`${t.name} · ${online ? 'online' : 'offline'} · ${t.role} · ${t.userType}`}
                  class={`navitem w-full${active ? ' active' : ''}`}
                  style={`text-align:left;font-weight:${active ? 700 : 500}`}
                >
                  <span class={`dot${online ? ' ok' : ' muted'}`} aria-hidden="true" />
                  <span
                    class={`truncate flex-1${unread > 0 && !active ? ' font-semibold' : ''}`}
                    style={unread > 0 && !active ? 'font-weight:700' : ''}
                  >
                    {t.name}
                  </span>
                  {auth !== null && (
                    <span
                      style={`font-family:var(--f-mono);font-size:9.5px;letter-spacing:.08em;color:${active ? 'var(--steel)' : 'var(--muted)'};font-weight:600`}
                      aria-hidden="true"
                    >
                      {auth}
                    </span>
                  )}
                  {unread > 0 && !active && <UnreadBadge count={unread} />}
                </button>
              </li>
            );
          })}
        </ul>

        {/* ── Sign-out footer ─────────────────────────────────────── */}
        <div style="padding:8px 0;border-top:1px solid var(--rule)">
          <button
            type="button"
            onClick={() => {
              void logout();
            }}
            class="navitem w-full"
            style="font-weight:500;color:var(--muted);justify-content:center;gap:8px"
            aria-label="Sign out"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4 w-4 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
            <span style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase">
              sign out
            </span>
          </button>
        </div>
      </nav>
    </>
  );
}

function NavLink({
  label,
  active,
  onClick,
  ariaLabel,
  trailing,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  ariaLabel?: string;
  trailing?: ComponentChildren;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      title={label}
      class={`navitem w-full${active ? ' active' : ''}`}
      style="text-align:left"
    >
      <span class="truncate flex-1">{label}</span>
      {trailing}
    </button>
  );
}
