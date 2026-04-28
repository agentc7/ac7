/**
 * TeamShell — public entry point for @agentc7/web-shell.
 *
 * Renders the entire team-view surface: nav column, header, panels
 * for chat / roster / objectives / files / members, the command
 * palette, and the live-subscription lifecycle. Consumers (OSS SPA
 * and SaaS) wrap their own auth + cross-team chrome around it.
 *
 * Contract:
 *
 *   <TeamShell
 *     client={ac7Client}         // pre-authenticated SDK instance
 *     identity={{member, role,   // resolved by the host
 *                permissions}}
 *     onSignOut={...}            // optional — hides UI if omitted
 *     onUnauthorized={...}       // background 401 handling
 *   />
 *
 * On mount the shell:
 *   - Wires the client + identity + callbacks into internal signals.
 *   - Loads briefing, history, roster, objectives (non-fatal failures
 *     land in a dismissable banner; 401 triggers `onUnauthorized`).
 *   - Starts live WebSocket subscription and roster polling.
 *   - Installs global ⌘K / Ctrl-K to toggle the command palette.
 *
 * On unmount it disposes every subscription cleanly, so the SaaS can
 * swap teams by re-keying the shell and trust that nothing leaks.
 *
 * URL routing: the shell's router understands an optional `/t/:slug`
 * prefix (see `lib/routes.ts`). When the host passes the `teamSlug`
 * prop, every in-shell navigation nests under `/t/<slug>/...` (the
 * SaaS model); when omitted, URLs live at the origin root (the OSS
 * single-team model).
 */

import type { Client } from '@agentc7/sdk/client';
import { effect, signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { AccountPanel } from './components/AccountPanel.js';
import { ActivityInspector } from './components/ActivityInspector.js';
import { ChannelBrowse } from './components/ChannelBrowse.js';
import { ChannelCreate } from './components/ChannelCreate.js';
import { ChannelHeader } from './components/ChannelHeader.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Composer } from './components/Composer.js';
import { DisconnectedBanner } from './components/DisconnectedBanner.js';
import { FilesPanel } from './components/FilesPanel.js';
import { Header } from './components/Header.js';
import { InboxPanel } from './components/InboxPanel.js';
import { MemberProfile } from './components/MemberProfile.js';
import { MembersPanel } from './components/MembersPanel.js';
import { ObjectiveCreate } from './components/ObjectiveCreate.js';
import { ObjectiveDetail } from './components/ObjectiveDetail.js';
import { ObjectivesPanel } from './components/ObjectivesPanel.js';
import { RouteModal } from './components/RouteModal.js';
import { AppShell, NavColumn } from './components/shell/index.js';
import { TeamHome } from './components/TeamHome.js';
import { Transcript } from './components/Transcript.js';
import { loadBriefing } from './lib/briefing.js';
import { channelBySlug, loadChannels } from './lib/channels.js';
import { setClient } from './lib/client.js';
import { setEmbeddedShell, setTeamSettingsHandler } from './lib/embedded.js';
import {
  handleUnauthorized,
  type SignOutHandler,
  setSignOutHandler,
  setUnauthorizedHandler,
  type UnauthorizedHandler,
} from './lib/handlers.js';
import { type Identity, setIdentity } from './lib/identity.js';
import { closeInspector } from './lib/inspector.js';
import { startSubscribe, streamConnected } from './lib/live.js';
import { appendMessages, dmOther, messagesByThread } from './lib/messages.js';
import { loadObjectives } from './lib/objectives.js';
import { closePalette, togglePalette } from './lib/palette.js';
import { initializePushState } from './lib/push.js';
import { loadRoster, startRosterPolling } from './lib/roster.js';
import { setRouterTeamSlug } from './lib/router.js';
import { initializeLastReadFromStore, markThreadRead } from './lib/unread.js';
import {
  closeModalView,
  closeSidebar,
  isModalView,
  lastNonModalView,
  type View,
  view,
} from './lib/view.js';

export interface TeamShellProps {
  client: Client;
  identity: Identity;
  /**
   * Invoked when the viewer clicks "Sign out" in the nav column.
   * Omit to hide the affordance entirely (the SaaS does this because
   * sign-out lives outside the embedded shell).
   */
  onSignOut?: SignOutHandler;
  /**
   * Invoked when a background fetch returns 401, typically because
   * the viewer's token/cookie has expired or been revoked. The host
   * is expected to clear local auth state and route to a login
   * screen; the `notice` argument is a user-facing reason.
   */
  onUnauthorized?: UnauthorizedHandler;
  /**
   * Optional team slug. When set, every in-shell navigation emits
   * URLs under `/t/<slug>/...` — e.g. the SaaS at
   * `app.agentc7.com/t/acme-robotics/objectives`. Omit for OSS
   * (single-team, URLs at origin root). Routes parsed from the URL
   * already recognize the `/t/:slug` prefix; setting this prop just
   * closes the loop so navigation emits the prefix back.
   */
  teamSlug?: string;
  /**
   * Optional outer rail rendered between the header and the nav
   * column — typically the multi-team switcher in the SaaS. Passing
   * this also flips the shell into "embedded" mode: Header drops its
   * profile button and NavColumn drops its user chip, since the
   * host's outer chrome already provides an identity anchor.
   */
  leftRail?: JSX.Element;
  /**
   * Invoked when the viewer clicks "Team settings" in the NavColumn
   * footer. Only shown in embedded mode (no `leftRail`, no button).
   */
  onTeamSettings?: () => void;
}

/**
 * Non-fatal mount-time errors — briefing/history/roster/objectives
 * failures land here instead of triggering a silent sign-out. The
 * shell still renders; the banner surfaces what broke so the viewer
 * isn't left wondering why their dashboard is empty. Auto-clears on
 * successful refresh.
 */
const mountError = signal<string | null>(null);

export function TeamShell(props: TeamShellProps): JSX.Element {
  // Wire props into module-level signals synchronously on every render
  // so panels see fresh client/identity/callbacks without waiting for
  // an effect. Signal writes are idempotent — a no-op when the value
  // didn't change — so this is cheap.
  setClient(props.client);
  setIdentity(props.identity);
  setSignOutHandler(props.onSignOut ?? null);
  setUnauthorizedHandler(props.onUnauthorized ?? null);
  setRouterTeamSlug(props.teamSlug ?? null);
  setEmbeddedShell(props.leftRail !== undefined);
  setTeamSettingsHandler(props.onTeamSettings ?? null);

  const viewer = props.identity.member;
  const v = view.value;
  // Modalized routes (today: just `account`) render the previous
  // non-modal view as the underlay so the chrome stays visible
  // behind the dialog. Closing the modal navigates back to that
  // route — see `closeModalView`.
  const modal = isModalView(v);
  const baseView = modal ? lastNonModalView.value : v;
  // The right-rail inspector mounts only on DM-thread views, with the
  // peer as the inspected agent. Team chat / panels don't have a single
  // "agent in focus," so the drawer slot stays empty there.
  const inspectedAgent = inspectableAgentFromView(baseView);

  useEffect(() => {
    let disposeSubscribe: (() => void) | null = null;
    let disposeRoster: (() => void) | null = null;
    let disposeAutoRead: (() => void) | null = null;
    let disposeReconnectRefetch: (() => void) | null = null;

    const failures: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: allow collecting mixed error values
    const recordFailure = (label: string, err: any) => {
      const detail = err instanceof Error && err.message ? err.message : String(err);
      failures.push(`${label}: ${detail}`);
      console.error(`${label} failed`, err);
    };

    const boot = async () => {
      try {
        await loadBriefing();
      } catch (err) {
        if (isUnauthorized(err)) {
          handleUnauthorized('Your session expired — please sign in again.');
          return;
        }
        recordFailure('briefing', err);
      }
      try {
        const history = await props.client.history({ limit: 100 });
        appendMessages(viewer, history);
        // Seed lastRead BEFORE the live stream opens so no incoming
        // message races with the seed and gets marked read-on-arrival.
        initializeLastReadFromStore();
      } catch (err) {
        if (isUnauthorized(err)) {
          handleUnauthorized('Your session expired — please sign in again.');
          return;
        }
        recordFailure('history', err);
      }
      try {
        await loadRoster();
      } catch (err) {
        if (isUnauthorized(err)) {
          handleUnauthorized('Your session expired — please sign in again.');
          return;
        }
        recordFailure('roster', err);
      }
      try {
        await loadObjectives();
      } catch (err) {
        if (isUnauthorized(err)) {
          handleUnauthorized('Your session expired — please sign in again.');
          return;
        }
        recordFailure('objectives', err);
      }
      try {
        await loadChannels();
      } catch (err) {
        if (isUnauthorized(err)) {
          handleUnauthorized('Your session expired — please sign in again.');
          return;
        }
        recordFailure('channels', err);
      }
      mountError.value = failures.length > 0 ? failures.join(' · ') : null;
      disposeRoster = startRosterPolling();
      disposeSubscribe = startSubscribe({
        name: viewer,
        historyLimit: 50,
        onError: (err) => {
          console.error('live stream error', err);
        },
      });

      // Auto-read the active thread: any time the view changes or a
      // new message lands, bump lastRead for the active thread so its
      // unread count stays at 0 while the viewer is watching it.
      disposeAutoRead = effect(() => {
        const current = view.value;
        const map = messagesByThread.value;
        if (current.kind !== 'thread') return;
        const messages = map.get(current.key) ?? [];
        if (messages.length === 0) return;
        const latest = messages[messages.length - 1];
        if (latest) markThreadRead(current.key, latest.ts);
      });

      // Presence-freshness hook: every time the live stream transitions
      // disconnected → connected (initial open or reconnect), refetch
      // the roster so "who came back online" surfaces without waiting
      // for the 10s polling tick.
      let wasConnected = false;
      disposeReconnectRefetch = effect(() => {
        const nowConnected = streamConnected.value;
        if (nowConnected && !wasConnected) {
          void loadRoster().catch(() => {
            /* next polling tick retries */
          });
        }
        wasConnected = nowConnected;
      });

      // Kick off push-state detection in parallel — cheap, no-op when
      // push is unsupported. Populates the signal the NotificationToggle
      // reads; errors inside are fully handled by initializePushState.
      void initializePushState();
    };

    void boot();

    return () => {
      disposeSubscribe?.();
      disposeRoster?.();
      disposeAutoRead?.();
      disposeReconnectRefetch?.();
    };
    // Re-run the whole bootstrap when the viewer changes (e.g., SaaS
    // swaps teams). Keying on the identity string keeps the dependency
    // shallow and stable.
  }, [viewer]);

  // Global ⌘K / Ctrl-K to toggle the command palette + Escape to
  // dismiss any open overlay (palette, navcol drawer, inspector
  // overlay). Installed once while the shell is mounted so it's only
  // live inside the authenticated app.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isK = e.key === 'k' || e.key === 'K';
      if ((e.metaKey || e.ctrlKey) && isK) {
        e.preventDefault();
        togglePalette();
      } else if (e.key === 'Escape') {
        closePalette();
        closeInspector();
        closeSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const mountErr = mountError.value;

  return (
    <>
      <AppShell
        header={<Header />}
        nav={<NavColumn viewer={viewer} />}
        banner={
          <>
            <DisconnectedBanner />
            {mountErr !== null && (
              <div
                role="alert"
                class="callout warn flex-shrink-0"
                style="border-radius:0;overflow-y:auto"
              >
                <div class="icon" aria-hidden="true">
                  ◆
                </div>
                <div class="body">
                  <div class="title">Some panels failed to load</div>
                  <div class="msg">{mountErr}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    mountError.value = null;
                  }}
                  aria-label="Dismiss"
                  class="close"
                >
                  ×
                </button>
              </div>
            )}
          </>
        }
        main={renderView(baseView, viewer)}
        drawer={inspectedAgent !== null ? <ActivityInspector agentName={inspectedAgent} /> : null}
        leftRail={props.leftRail}
      />
      {modal && (
        <RouteModal onClose={closeModalView} ariaLabel="Account settings" size="lg">
          <AccountPanel viewer={viewer} />
        </RouteModal>
      )}
      <CommandPalette />
    </>
  );
}

/** Test helper — reset the mount-error signal between cases. */
export function __resetTeamShellForTests(): void {
  mountError.value = null;
}

/**
 * Route the current view kind to the right panel. Thread views wrap
 * Transcript + Composer; everything else renders a standalone panel
 * in the same flex region.
 */
function renderView(v: View, viewer: string) {
  switch (v.kind) {
    case 'thread': {
      // Channel threads get a header above the transcript with the
      // channel name + member count + admin gear. DMs and objective
      // threads don't (those have their own headers inside Transcript).
      const channel = v.channelSlug ? channelBySlug(v.channelSlug) : null;
      return (
        <>
          {channel !== null && <ChannelHeader channel={channel} viewer={viewer} />}
          <Transcript viewer={viewer} />
          <Composer viewer={viewer} />
        </>
      );
    }
    case 'overview':
      return <TeamHome viewer={viewer} />;
    case 'inbox':
      return <InboxPanel />;
    case 'account':
      return <AccountPanel viewer={viewer} />;
    case 'channels-browse':
      return <ChannelBrowse />;
    case 'channel-create':
      return <ChannelCreate />;
    case 'objectives-list':
      return <ObjectivesPanel viewer={viewer} />;
    case 'objective-detail':
      return <ObjectiveDetail id={v.id} viewer={viewer} />;
    case 'objective-create':
      return <ObjectiveCreate />;
    case 'member-profile':
      return <MemberProfile name={v.name} tab={v.tab} viewer={viewer} />;
    case 'files':
      return <FilesPanel viewer={viewer} path={v.path} />;
    case 'members':
      return <MembersPanel />;
  }
}

/**
 * Resolve the agent the right-rail inspector should mount for, given
 * the current view. Returns null when no single agent is in focus —
 * the drawer slot is then empty. Today only DM threads inspect; the
 * primary team thread spans many members and doesn't fit a per-agent
 * activity stream.
 */
function inspectableAgentFromView(v: View): string | null {
  if (v.kind !== 'thread') return null;
  return dmOther(v.key);
}

/** Narrow error to 401 — the SDK throws `ClientError` with `.status`. */
function isUnauthorized(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status: number }).status === 401
  );
}
