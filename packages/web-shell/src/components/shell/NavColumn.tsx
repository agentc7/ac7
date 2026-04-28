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

import type { ChannelSummary, Teammate } from '@agentc7/sdk/types';
import { hasPermission } from '@agentc7/sdk/types';
import type { ComponentChildren } from 'preact';
import { briefing } from '../../lib/briefing.js';
import { channels, joinedChannels } from '../../lib/channels.js';
import { embeddedShell, teamSettingsHandler } from '../../lib/embedded.js';
import { handleSignOut, hasSignOutHandler } from '../../lib/handlers.js';
import { inboxCount } from '../../lib/inbox.js';
import {
  channelThreadKey,
  dmThreadKey,
  GENERAL_CHANNEL_ID,
  GENERAL_THREAD,
  messagesByThread,
} from '../../lib/messages.js';
import { objectives } from '../../lib/objectives.js';
import { privilegeTag, summarizePermissions } from '../../lib/permissions.js';
import { roster } from '../../lib/roster.js';
import { currentTeam } from '../../lib/team.js';
import { lastReadByThread, unreadCount } from '../../lib/unread.js';
import {
  isSidebarOpen,
  selectAccount,
  selectChannel,
  selectChannelCreate,
  selectChannelsBrowse,
  selectDmWith,
  selectFiles,
  selectInbox,
  selectMembers,
  selectObjectivesList,
  selectOverview,
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
  const drawerOpen = isSidebarOpen.value;
  const isAdmin = b !== null && hasPermission(b.permissions, 'members.manage');
  const activeObjectiveCount = objectives.value.filter(
    (o) => o.assignee === viewer && (o.status === 'active' || o.status === 'blocked'),
  ).length;
  const channelList = joinedChannels();
  const channelsLoaded = channels.value !== null;
  const browseActive = v.kind === 'channels-browse';
  const createActive = v.kind === 'channel-create';

  // The shared `.drawer-backdrop` rendered in AppShell handles the
  // click-out dismissal for both navcol and inspector. NavColumn no
  // longer renders its own backdrop button — that was a duplicate
  // surface that conflicted with the shared layer.
  return (
    <nav
      class={`nav-drawer flex-shrink-0 flex-col
          md:static md:flex md:w-56 md:translate-x-0 md:shadow-none md:z-0
          fixed top-0 left-0 z-50 w-[85vw] max-w-72 transition-transform duration-200
          ${drawerOpen ? 'is-open translate-x-0 flex shadow-2xl' : '-translate-x-full hidden md:flex md:-translate-x-0'}`}
      style="background:var(--paper);border-right:1px solid var(--rule);padding-left:env(safe-area-inset-left);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);bottom:0"
    >
      <TeamHeader />

      {/* ── Work section ─────────────────────────────────────────── */}
      <div style="padding:8px 0;border-bottom:1px solid var(--rule)">
        <NavItem
          label="Home"
          glyph="⌂"
          active={homeActive}
          onClick={selectOverview}
          ariaLabel="Open team home"
        />
        <NavItem
          label="Inbox"
          glyph="✎"
          active={inboxActive}
          onClick={selectInbox}
          ariaLabel={inbox > 0 ? `Open inbox (${inbox} items)` : 'Open inbox'}
          trailing={inbox > 0 && !inboxActive ? <UnreadBadge count={inbox} /> : undefined}
        />
        <NavItem
          label="Objectives"
          glyph="◇"
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
          glyph="▤"
          active={filesActive}
          onClick={() => selectFiles(`/${viewer}`)}
          ariaLabel="Browse files"
        />
        {isAdmin && (
          <NavItem
            label="Members"
            glyph="⊕"
            active={membersActive}
            onClick={selectMembers}
            ariaLabel="Manage members"
          />
        )}
      </div>

      {/* ── Channels + Direct sections ───────────────────────────── */}
      <ul
        class="flex-1 overflow-y-auto"
        style="padding:12px 0 8px;list-style:none;margin:0;-webkit-overflow-scrolling:touch;overscroll-behavior:none;touch-action:manipulation"
      >
        <li class="flex items-center justify-between" style="padding:0 12px 6px">
          <button
            type="button"
            onClick={selectChannelsBrowse}
            aria-label="Browse all channels"
            class="eyebrow"
            style={`margin:0;background:transparent;border:0;padding:0;cursor:pointer;letter-spacing:.16em;text-transform:uppercase;color:${browseActive ? 'var(--ink)' : 'var(--muted)'}`}
          >
            Channels
          </button>
          <button
            type="button"
            onClick={selectChannelCreate}
            aria-label="Create a channel"
            title="Create a channel"
            style="background:transparent;border:none;color:var(--muted);font-family:var(--f-mono);font-size:14px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:var(--r-xs)"
          >
            +
          </button>
        </li>
        {!channelsLoaded && (
          <li class="eyebrow" style="padding:4px 12px;font-style:italic;color:var(--muted)">
            loading…
          </li>
        )}
        {channelList.map((c) => (
          <li key={c.id}>
            <ChannelRow
              channel={c}
              active={isChannelActive(v, c)}
              viewer={viewer}
              lastRead={lastRead}
              msgMap={msgMap}
            />
          </li>
        ))}
        {createActive && (
          <li class="eyebrow" style="padding:4px 12px;color:var(--steel)" aria-hidden="true">
            + new channel
          </li>
        )}

        <li>
          <p class="eyebrow" style="padding:14px 12px 6px">
            Direct
          </p>
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

      {embeddedShell.value ? <TeamSettingsButton /> : <AccountSettingsButton />}
    </nav>
  );
}

function TeamSettingsButton() {
  const handler = teamSettingsHandler.value;
  if (handler === null) return null;
  return (
    <div style="padding:10px 12px;border-top:1px solid var(--rule);flex-shrink:0">
      <button
        type="button"
        onClick={handler}
        aria-label="Team settings"
        class="navitem w-full"
        style="text-align:left"
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
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span class="truncate flex-1">Team settings</span>
      </button>
    </div>
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

/**
 * Standalone-mode footer (OSS, no host-provided rail). Visually
 * parallels the embedded `TeamSettingsButton`: a gear-iconed
 * "Account" button that opens the account settings modal, with a
 * quick-action sign-out icon next to it. The avatar+name presence
 * we used to render here was a duplicate identity anchor relative to
 * the Header's profile button (which has since been retired); the
 * gear keeps a single affordance in a single spot.
 */
function AccountSettingsButton() {
  const showSignOut = hasSignOutHandler.value !== null;
  return (
    <div
      class="flex items-center gap-2"
      style="padding:10px 12px;border-top:1px solid var(--rule);flex-shrink:0"
    >
      <button
        type="button"
        onClick={selectAccount}
        aria-label="Account settings"
        class="navitem flex-1"
        style="text-align:left"
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
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span class="truncate flex-1">Account</span>
      </button>
      {showSignOut && (
        <button
          type="button"
          onClick={() => {
            handleSignOut();
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
      )}
    </div>
  );
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
  glyph,
  active,
  onClick,
  ariaLabel,
  trailing,
  disabled,
}: {
  label: string;
  glyph?: string;
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
      {glyph !== undefined && (
        <span
          aria-hidden="true"
          style="color:var(--muted);font-family:var(--f-mono);font-size:12.5px;width:14px;text-align:center;flex:0 0 auto"
        >
          {glyph}
        </span>
      )}
      <span class="truncate flex-1">{label}</span>
      {trailing}
    </button>
  );
}

function isChannelActive(v: ReturnType<typeof view.peek>, c: ChannelSummary): boolean {
  if (v.kind !== 'thread') return false;
  if (c.id === GENERAL_CHANNEL_ID) return v.key === GENERAL_THREAD;
  return v.key === channelThreadKey(c.id);
}

function ChannelRow({
  channel,
  active,
  viewer,
  lastRead,
  msgMap,
}: {
  channel: ChannelSummary;
  active: boolean;
  viewer: string;
  lastRead: Map<string, number>;
  msgMap: Map<string, import('@agentc7/sdk/types').Message[]>;
}) {
  const threadKey =
    channel.id === GENERAL_CHANNEL_ID ? GENERAL_THREAD : channelThreadKey(channel.id);
  const unread = unreadCount(threadKey, viewer, lastRead, msgMap);
  return (
    <button
      type="button"
      onClick={() => selectChannel(channel.slug)}
      aria-label={unread > 0 ? `Open #${channel.slug} (${unread} unread)` : `Open #${channel.slug}`}
      title={`#${channel.slug}`}
      class={`navitem w-full${active ? ' active' : ''}`}
      style={`text-align:left;font-weight:${active ? 700 : 500}`}
    >
      <span
        aria-hidden="true"
        style="color:var(--muted);font-family:var(--f-mono);font-size:12.5px;width:14px;text-align:center;flex:0 0 auto"
      >
        #
      </span>
      <span
        class={`truncate flex-1${unread > 0 && !active ? ' font-semibold' : ''}`}
        style={unread > 0 && !active ? 'font-weight:700' : ''}
      >
        {channel.slug}
      </span>
      {unread > 0 && !active && <UnreadBadge count={unread} />}
    </button>
  );
}
