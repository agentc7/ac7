/**
 * Header — slim top bar: brand left, search centered, profile right.
 *
 *   ☰  ▲                   [⌕  Jump to…   ⌘K]                  [AV]
 *
 * The search pill is the visual anchor — prominent, centered, and
 * the same ⌘K launcher that's available globally. Clicking the
 * avatar on the right jumps to the viewer's own profile (a quick
 * path that doesn't require scrolling to the NavColumn footer).
 *
 * Connection health surfaces only via `DisconnectedBanner` when
 * something is wrong — no persistent "ONLINE" pill in chrome.
 */

import { openPalette } from '../lib/palette.js';
import { session } from '../lib/session.js';
import { isSidebarOpen, openSidebar, selectAccount } from '../lib/view.js';

export function Header() {
  const s = session.value;
  if (s.status !== 'authenticated') return null;
  const drawerOpen = isSidebarOpen.value;

  return (
    <header
      class="flex items-center flex-shrink-0 relative z-40 gap-2"
      style="background:var(--paper);border-bottom:1px solid var(--rule);padding:10px max(0.75rem,env(safe-area-inset-right)) 10px max(0.75rem,env(safe-area-inset-left));padding-top:max(0.5rem,env(safe-area-inset-top))"
    >
      <div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
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

        <svg
          viewBox="0 0 120 120"
          class="h-6 w-6 flex-shrink-0"
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
      </div>

      <div class="flex justify-center flex-shrink-0" style="flex:2 1 auto;max-width:480px">
        <SearchButton />
      </div>

      <div class="flex items-center justify-end flex-1 min-w-0">
        <ProfileButton name={s.member} />
      </div>
    </header>
  );
}

/**
 * Search affordance. On ≥sm renders as a mock input with the ⌘K
 * hint; on mobile it collapses to just an icon. Clicking opens the
 * palette — the real input lives inside the modal.
 */
function SearchButton() {
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Open command palette"
      title="Search and jump (⌘K)"
      class="flex items-center gap-2 w-full"
      style="background:var(--ice);border:1px solid var(--rule);border-radius:8px;padding:6px 12px;color:var(--muted);cursor:pointer;font-family:var(--f-sans);font-size:13px;max-width:100%"
    >
      <span aria-hidden="true">⌕</span>
      <span class="hidden sm:inline flex-1" style="text-align:left">
        Jump to member, objective, thread…
      </span>
      <span class="sm:hidden flex-1" style="text-align:left">
        Search…
      </span>
      <span
        class="hidden sm:inline flex-shrink-0"
        style="font-family:var(--f-mono);font-size:10.5px;letter-spacing:.06em;color:var(--muted);background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:1px 5px"
      >
        ⌘K
      </span>
    </button>
  );
}

function ProfileButton({ name }: { name: string }) {
  return (
    <button
      type="button"
      onClick={selectAccount}
      aria-label={`Open account settings (${name})`}
      title={`Account settings (@${name})`}
      class="flex items-center justify-center flex-shrink-0"
      style="background:transparent;border:none;padding:0;cursor:pointer"
    >
      <span class="avatar" aria-hidden="true" style="width:32px;height:32px;font-size:12px">
        {initials(name)}
      </span>
    </button>
  );
}

function initials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
