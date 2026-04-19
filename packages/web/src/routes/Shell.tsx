/**
 * Authenticated shell — the main app surface.
 *
 * Layout (CSS grid):
 *
 *   ┌──────────────────────────────────────┐
 *   │ Header                               │
 *   ├──────────┬───────────────────────────┤
 *   │ Sidebar  │ Transcript / RosterPanel  │
 *   │          │                           │
 *   │          ├───────────────────────────┤
 *   │          │ Composer                  │
 *   └──────────┴───────────────────────────┘
 *
 * On mount: fetch briefing + history, open the SSE stream, start
 * the roster polling loop. On unmount: tear everything down.
 *
 * We intentionally don't guard the in-shell bootstrap behind its
 * own loading state — the header just renders once `briefing` is
 * populated, and the transcript falls back to "net is quiet" when
 * there are no messages yet. Progressive reveal avoids a flash of
 * spinner on fast networks.
 */

import { effect, signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { AgentPage } from '../components/AgentPage.js';
import { Composer } from '../components/Composer.js';
import { Header } from '../components/Header.js';
import { ObjectiveCreate } from '../components/ObjectiveCreate.js';
import { ObjectiveDetail } from '../components/ObjectiveDetail.js';
import { ObjectivesPanel } from '../components/ObjectivesPanel.js';
import { RosterPanel } from '../components/RosterPanel.js';
import { Sidebar } from '../components/Sidebar.js';
import { Transcript } from '../components/Transcript.js';
import { loadBriefing } from '../lib/briefing.js';
import { getClient } from '../lib/client.js';
import { appendMessages, messagesByThread } from '../lib/messages.js';
import { loadObjectives } from '../lib/objectives.js';
import { initializePushState } from '../lib/push.js';
import { loadRoster, startRosterPolling } from '../lib/roster.js';
import { logout, session } from '../lib/session.js';
import { startSubscribe, streamConnected } from '../lib/sse.js';
import { initializeLastReadFromStore, markThreadRead } from '../lib/unread.js';
import { type View, view } from '../lib/view.js';

/**
 * Non-fatal mount-time errors — briefing/history/roster/objectives
 * failures land here instead of triggering a silent logout. The shell
 * still renders; the banner surfaces what broke so the user isn't left
 * wondering why their dashboard is empty. Auto-clears on successful
 * refresh so a transient network blip resolves itself.
 */
const mountError = signal<string | null>(null);

export function Shell() {
  const s = session.value;
  const v = view.value;

  useEffect(() => {
    if (s.status !== 'authenticated') return;
    const name = s.slot;
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
        // A 401 here means the session expired between our last
        // /session check and this mount. Flip to anonymous and let
        // the App gate re-render the login screen.
        if (isUnauthorized(err)) {
          void logout('Your session expired — please sign in again.');
          return;
        }
        recordFailure('briefing', err);
      }
      try {
        const history = await getClient().history({ limit: 100 });
        appendMessages(name, history);
        // Seed lastRead BEFORE SSE opens so no incoming message can
        // race with the seed and get marked read-on-arrival.
        initializeLastReadFromStore();
      } catch (err) {
        if (isUnauthorized(err)) {
          void logout('Your session expired — please sign in again.');
          return;
        }
        recordFailure('history', err);
      }
      try {
        await loadRoster();
      } catch (err) {
        if (isUnauthorized(err)) {
          void logout('Your session expired — please sign in again.');
          return;
        }
        recordFailure('roster', err);
      }
      try {
        await loadObjectives();
      } catch (err) {
        if (isUnauthorized(err)) {
          void logout('Your session expired — please sign in again.');
          return;
        }
        // Non-fatal — the objectives panel will retry on mount.
        recordFailure('objectives', err);
      }
      mountError.value = failures.length > 0 ? failures.join(' · ') : null;
      disposeRoster = startRosterPolling();
      disposeSubscribe = startSubscribe({
        name,
        historyLimit: 50,
        onError: (err) => {
          console.error('sse error', err);
        },
      });

      // Auto-read the active thread: any time the view changes or a
      // new message lands, bump lastRead for the active thread to
      // its latest ts. Keeps the active thread's unread count at 0
      // while the user is watching it. `effect()` is from
      // @preact/signals — reads both signals in its body and
      // re-runs whenever either changes.
      disposeAutoRead = effect(() => {
        const v = view.value;
        const map = messagesByThread.value;
        if (v.kind !== 'thread') return;
        const messages = map.get(v.key) ?? [];
        if (messages.length === 0) return;
        const latest = messages[messages.length - 1];
        if (latest) markThreadRead(v.key, latest.ts);
      });

      // Presence-freshness hook: every time our own SSE stream goes
      // from disconnected → connected (initial open, or reconnect
      // after a drop), immediately refetch /roster. This catches the
      // "server restarted, we reconnected, now show who came back"
      // case without waiting for the 10s polling tick. The 10s
      // polling remains as a safety net for cases where presence
      // changed without our stream dropping (e.g. another client
      // disconnecting).
      //
      // We track the previous value inside the effect closure so a
      // false→true transition is distinguishable from steady-state.
      let wasConnected = false;
      disposeReconnectRefetch = effect(() => {
        const nowConnected = streamConnected.value;
        if (nowConnected && !wasConnected) {
          void loadRoster().catch(() => {
            // Swallow — the next polling tick will retry and the
            // roster signal stays at whatever it was.
          });
        }
        wasConnected = nowConnected;
      });

      // Kick off push-state detection in parallel — cheap, no-op if
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
    // We only want this effect firing when the authenticated slot
    // actually changes (logout → login as a different slot).
  }, [s.status === 'authenticated' ? s.slot : null]);

  if (s.status !== 'authenticated') return null;

  const mountErr = mountError.value;

  return (
    <>
      <Header />
      <main class="flex flex-col min-h-0 flex-1 overflow-hidden">
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
        <div class="flex flex-1 min-h-0 overflow-hidden">
          <Sidebar viewer={s.slot} />
          <section class="flex-1 flex flex-col min-w-0 min-h-0">{renderView(v, s.slot)}</section>
        </div>
      </main>
    </>
  );
}

/** Test reset for the mount-error signal. */
export function __resetShellForTests(): void {
  mountError.value = null;
}

/**
 * Route the current view kind to the right panel. Thread views wrap
 * Transcript + Composer; everything else renders a standalone panel
 * in the same flex region.
 */
function renderView(v: View, viewer: string) {
  switch (v.kind) {
    case 'thread':
      return (
        <>
          <Transcript viewer={viewer} />
          <Composer viewer={viewer} />
        </>
      );
    case 'overview':
      return <RosterPanel viewer={viewer} />;
    case 'objectives-list':
      return <ObjectivesPanel viewer={viewer} />;
    case 'objective-detail':
      return <ObjectiveDetail id={v.id} viewer={viewer} />;
    case 'objective-create':
      return <ObjectiveCreate />;
    case 'agent-detail':
      return <AgentPage name={v.name} viewer={viewer} />;
  }
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
