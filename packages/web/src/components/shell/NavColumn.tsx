/**
 * NavColumn — the one left column.
 *
 *   ┌───────────────────────┐
 *   │  ▲ demo-team         │  team header
 *   │    ship the thing…    │
 *   ├───────────────────────┤
 *   │  Home                 │
 *   │  Inbox          ⓫     │
 *   │  Objectives     ⓷     │
 *   │  Files                │
 *   │  Members              │  admin only
 *   ├───────────────────────┤
 *   │  ━━ CHAT              │
 *   │  # Team Chat    ⓶     │
 *   │  ● alice             │
 *   │  ○ bob           ⓷    │
 *   ├───────────────────────┤
 *   │  [AV] alice        ⏏  │  user chip (click name → profile)
 *   └───────────────────────┘
 *
 * Team identity lives at the top, the viewer's own identity at the
 * bottom. The narrow-viewport drawer behavior is unchanged — the
 * whole column slides in driven by `isSidebarOpen`.
 */

import type { Teammate } from '@agentc7/sdk/types';
import { hasPermission } from '@agentc7/sdk/types';
import type { ComponentChildren } from 'preact';
import { briefing } from '../../lib/briefing.js';
import { inboxCount } from '../../lib/inbox.js';
import { dmThreadKey, messagesByThread, PRIMARY_THREAD } from '../../lib/messages.js';
import { objectives } from '../../lib/objectives.js';
import { privilegeTag, summarizePermissions } from '../../lib/permissions.js';
import { roster } from '../../lib/roster.js';
import { logout } from '../../lib/session.js';
import { currentTeam } from '../../lib/team.js';
import { lastReadByThread, unreadCount } from '../../lib/unread.js';
import {
  closeSidebar,
  isSidebarOpen,
  selectDmWith,
  selectFiles,
  selectInbox,
  selectMemberProfile,
  selectMembers,
  selectObjectivesList,
  selectOverview,
  selectThread,
  view,
} from '../../lib/view.js';

export interface NavColumnProps {
  viewer: string;
}

export function NavColumn({ viewer }: NavColumnProps) {
  const v = view.value;
  const r = roster.value;
  const b = briefing.value;
  const lastRead = lastReadByThread.value;
  const msgMap = messagesByThread.value;

  const teammatesSource: Teammate[] = r?.teammates ?? b?.teammates ?? [];
  const teammates = teammatesSource.filter((t) => t.name !== viewer);

  const onlineByName = new Map<string, number>();
  if (r) for (const a of r.connected) onlineByName.set(a.name, a.connected);

  const homeActive = v.kind === 'overview';
  const inboxActive = v.kind === 'inbox';
  const objectivesActive =
    v.kind === 'objectives-list' || v.kind === 'objective-detail' || v.kind === 'objective-create';
  const filesActive = v.kind === 'files';
  const membersActive = v.kind === 'members';
  const inbox = inboxCount.value;
  const teamChatActive = v.kind === 'thread' && v.key === PRIMARY_THREAD;
  const teamChatUnread = unreadCount(PRIMARY_THREAD, viewer, lastRead, msgMap);
  const drawerOpen = isSidebarOpen.value;
  const isAdmin = b !== null && hasPermission(b.permissions, 'members.manage');
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
          md:static md:flex md:w-56 md:translate-x-0 md:shadow-none md:z-0
          fixed inset-y-0 left-0 z-50 w-[85vw] max-w-72 transition-transform duration-200
          ${drawerOpen ? 'translate-x-0 flex shadow-2xl' : '-translate-x-full hidden md:flex md:-translate-x-0'}`}
        style="background:var(--paper);border-right:1px solid var(--rule);padding-left:env(safe-area-inset-left);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)"
      >
        <TeamHeader />

        {/* ── Work section ─────────────────────────────────────────── */}
        <div style="padding:8px 0;border-bottom:1px solid var(--rule)">
          <NavItem
            label="Home"
            active={homeActive}
            onClick={selectOverview}
            ariaLabel="Open team home"
          />
          <NavItem
            label="Inbox"
            active={inboxActive}
            onClick={selectInbox}
            ariaLabel={inbox > 0 ? `Open inbox (${inbox} items)` : 'Open inbox'}
            trailing={inbox > 0 && !inboxActive ? <UnreadBadge count={inbox} /> : undefined}
          />
          <NavItem
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
          <NavItem
            label="Files"
            active={filesActive}
            onClick={() => selectFiles(`/${viewer}`)}
            ariaLabel="Browse files"
          />
          {isAdmin && (
            <NavItem
              label="Members"
              active={membersActive}
              onClick={selectMembers}
              ariaLabel="Manage members"
            />
          )}
        </div>

        {/* ── Chat section ─────────────────────────────────────────── */}
        <ul
          class="flex-1 overflow-y-auto"
          style="padding:12px 0 8px;list-style:none;margin:0;-webkit-overflow-scrolling:touch;overscroll-behavior:none;touch-action:manipulation"
        >
          <li>
            <p class="eyebrow" style="padding:0 12px 6px">
              Chat
            </p>
          </li>
          <li>
            <NavItem
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
            const auth = privilegeTag(
              summarizePermissions(t.permissions, b?.team.permissionPresets ?? {}),
            );
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
                  title={`${t.name} · ${online ? 'online' : 'offline'} · ${t.role.title}`}
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

        <UserChip viewer={viewer} />
      </nav>
    </>
  );
}

function TeamHeader() {
  const team = currentTeam.value;
  if (!team) {
    return (
      <div style="padding:14px 14px 12px;border-bottom:1px solid var(--rule);min-height:58px" />
    );
  }
  return (
    <button
      type="button"
      onClick={selectOverview}
      aria-label={`${team.name} home`}
      class="w-full flex items-center gap-2"
      style="padding:12px 14px;border-bottom:1px solid var(--rule);background:transparent;border:none;border-bottom:1px solid var(--rule);text-align:left;cursor:pointer"
    >
      <svg
        viewBox="0 0 120 120"
        class="h-5 w-5 flex-shrink-0"
        fill="none"
        stroke="var(--steel)"
        stroke-width="5"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polygon points="60,15 95.18,31.94 103.87,70.01 79.52,100.54 40.48,100.54 16.13,70.01 24.82,31.94" />
      </svg>
      <div class="min-w-0">
        <div
          class="font-display truncate"
          style="font-size:14.5px;font-weight:700;letter-spacing:-0.01em;color:var(--ink);line-height:1.1"
        >
          {team.name}
        </div>
        {team.directive && (
          <div
            class="truncate"
            style="font-family:var(--f-sans);font-size:11px;color:var(--muted);line-height:1.2;margin-top:2px;font-style:italic"
          >
            {team.directive}
          </div>
        )}
      </div>
    </button>
  );
}

function UserChip({ viewer }: { viewer: string }) {
  return (
    <div
      class="flex items-center gap-2"
      style="padding:10px 12px;border-top:1px solid var(--rule);flex-shrink:0"
    >
      <button
        type="button"
        onClick={() => selectMemberProfile(viewer)}
        aria-label={`Open your profile (${viewer})`}
        class="flex items-center gap-2 min-w-0 flex-1"
        style="background:transparent;border:none;padding:0;cursor:pointer;text-align:left"
      >
        <span class="avatar" aria-hidden="true" style="width:28px;height:28px;font-size:11px">
          {chipInitials(viewer)}
        </span>
        <span
          class="truncate"
          style="font-family:var(--f-sans);font-size:13px;font-weight:600;color:var(--ink)"
        >
          {viewer}
        </span>
      </button>
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
        aria-label="Sign out"
        title="Sign out"
        class="flex-shrink-0 flex items-center justify-center"
        style="width:28px;height:28px;background:transparent;border:none;color:var(--muted);cursor:pointer;border-radius:6px"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-4 w-4"
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
      </button>
    </div>
  );
}

function chipInitials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
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

function NavItem({
  label,
  active,
  onClick,
  ariaLabel,
  trailing,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  ariaLabel?: string;
  trailing?: ComponentChildren;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      aria-disabled={disabled ? 'true' : undefined}
      title={label}
      class={`navitem w-full${active ? ' active' : ''}${disabled ? ' is-disabled' : ''}`}
      style={`text-align:left${disabled ? ';color:var(--muted);cursor:default' : ''}`}
      tabIndex={disabled ? -1 : 0}
    >
      <span class="truncate flex-1">{label}</span>
      {trailing}
    </button>
  );
}
