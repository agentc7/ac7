/**
 * Header bar — identity + connection status.
 *
 * Layout (left → right):
 *   ☰  ▲ logo  │  NAME · authority · team-name   …   notif · ●ONLINE
 *
 * Surface is paper with a subtle bottom rule, matching the canonical
 * topbar treatment from theme.css. Connection state uses canonical
 * `.badge` semantics (soft pill, color shifts by state).
 */

import { briefing } from '../lib/briefing.js';
import { session } from '../lib/session.js';
import { streamBackfillError, streamConnected } from '../lib/sse.js';
import { isSidebarOpen, openSidebar } from '../lib/view.js';
import { NotificationToggle } from './NotificationToggle.js';

export function Header() {
  const s = session.value;
  const b = briefing.value;
  const connected = streamConnected.value;
  const backfillErr = streamBackfillError.value;
  if (s.status !== 'authenticated') return null;

  const drawerOpen = isSidebarOpen.value;

  return (
    <header
      class="flex items-center justify-between gap-3 flex-shrink-0 relative z-40"
      style="background:var(--paper);border-bottom:1px solid var(--rule);padding:12px max(0.75rem,env(safe-area-inset-right)) 12px max(0.75rem,env(safe-area-inset-left));padding-top:max(0.75rem,env(safe-area-inset-top))"
    >
      <div class="flex items-center gap-3 sm:gap-4 min-w-0">
        {/* Hamburger — visible below md only. 44×44 hit area. */}
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          class="md:hidden flex-shrink-0"
          style="color:var(--graphite);padding:10px;margin:-10px -6px -10px -10px"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-5 w-5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Heptagon mark — steel on paper. Matches favicon.svg, logo.svg,
            and the Classic-Mesh winner from logo-workshop-classic-mesh.html. */}
        <svg
          viewBox="0 0 120 120"
          class="h-7 w-7 flex-shrink-0"
          fill="none"
          stroke="var(--steel)"
          stroke-width="3"
          stroke-linejoin="round"
          aria-label="AgentC7"
          role="img"
        >
          <polygon points="60,15 95.18,31.94 103.87,70.01 79.52,100.54 40.48,100.54 16.13,70.01 24.82,31.94" />
          <circle cx="60" cy="15" r="10" fill="var(--steel)" stroke="none" />
          <circle cx="95.18" cy="31.94" r="10" fill="var(--steel)" stroke="none" />
          <circle cx="103.87" cy="70.01" r="10" fill="var(--steel)" stroke="none" />
          <circle cx="79.52" cy="100.54" r="10" fill="var(--steel)" stroke="none" />
          <circle cx="40.48" cy="100.54" r="10" fill="var(--steel)" stroke="none" />
          <circle cx="16.13" cy="70.01" r="10" fill="var(--steel)" stroke="none" />
          <circle cx="24.82" cy="31.94" r="10" fill="var(--steel)" stroke="none" />
        </svg>

        {/* Vertical divider matches the topbar lockup style */}
        <span
          class="hidden sm:block flex-shrink-0"
          style="width:1px;height:22px;background:var(--rule-strong)"
          aria-hidden="true"
        />

        <span
          class="font-display truncate"
          style="font-weight:700;font-size:18px;letter-spacing:-0.01em;color:var(--ink);line-height:1"
        >
          {s.slot}
        </span>

        {/* Authority pill — `.badge` from theme.css with state variants */}
        <span
          class={`badge ${s.authority === 'director' ? 'solid' : s.authority === 'manager' ? 'ember' : 'soft'} hidden sm:inline-flex flex-shrink-0`}
        >
          {formatAuthority(s.authority)}
        </span>

        {b && (
          <span
            class="hidden md:inline truncate flex-shrink min-w-0"
            style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase"
          >
            · {b.team.name}
          </span>
        )}
      </div>

      <div class="flex items-center gap-3 sm:gap-4 flex-shrink-0">
        <NotificationToggle />
        {/* Connection indicator — uses badge semantics so the state
            change reads as a deliberate brand pill, not ad-hoc text. */}
        <span
          class={`badge ${
            backfillErr !== null ? 'ember' : connected ? 'soft' : 'muted'
          } flex-shrink-0`}
          title={
            backfillErr !== null ? `reconnected — ${backfillErr}` : connected ? 'online' : 'offline'
          }
        >
          <span aria-hidden="true">{backfillErr !== null ? '◆' : connected ? '●' : '◇'}</span>
          <span class="hidden sm:inline">
            {backfillErr !== null ? 'BACKFILL FAIL' : connected ? 'ONLINE' : 'OFFLINE'}
          </span>
        </span>
      </div>
    </header>
  );
}

function formatAuthority(authority: string): string {
  if (authority === 'individual-contributor') return 'IC';
  return authority;
}
