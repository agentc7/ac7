/**
 * AppShell — the top-level layout for the authenticated app.
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Header                                      │
 *   ├───────┬─────────────────────┬──────────────┤
 *   │ Nav   │ Main                │ Drawer?      │
 *   │       │                     │              │
 *   └───────┴─────────────────────┴──────────────┘
 *
 * Three slots: nav (mid-left), main (center), drawer (optional
 * right). Banners render between the header and the content row and
 * are typically transient (disconnect warning, mount-error surface).
 *
 * This component is intentionally dumb about its contents. It owns
 * the flex/grid structure and the bleed-through of safe-area insets;
 * children own their own padding and scroll behavior.
 */

import type { ComponentChildren } from 'preact';

export interface AppShellProps {
  header: ComponentChildren;
  nav: ComponentChildren;
  main: ComponentChildren;
  drawer?: ComponentChildren;
  /** Banner area between the header and the content row. */
  banner?: ComponentChildren;
}

export function AppShell({ header, nav, main, drawer, banner }: AppShellProps) {
  return (
    <>
      {header}
      <main class="flex flex-col min-h-0 flex-1 overflow-hidden">
        {banner}
        <div class="flex flex-1 min-h-0 overflow-hidden">
          {nav}
          <section class="flex-1 flex flex-col min-w-0 min-h-0">{main}</section>
          {drawer}
        </div>
      </main>
    </>
  );
}
