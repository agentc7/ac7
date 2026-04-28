/**
 * Boot screen — rendered while the session signal is in `loading`
 * state on initial mount. Deliberately tiny; no spinner animation
 * dependency, no layout shift when it disappears.
 *
 * Failsafe: if `bootstrap()` hangs (server unreachable, DNS stall,
 * proxy misconfigured) we'd normally leave the user staring at the
 * pulse forever. After 8s the component surfaces a retry affordance
 * that reloads the page.
 */

import { useEffect, useState } from 'preact/hooks';

const STUCK_AFTER_MS = 8000;

export function Boot() {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <main
      class="min-h-screen flex flex-col items-center justify-center text-center"
      style="padding:24px;gap:18px"
    >
      <svg
        viewBox="0 0 120 120"
        style="height:56px;width:56px;opacity:.85"
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
      <div style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);display:inline-flex;align-items:center;gap:10px">
        <span
          class="dot pulse"
          style="background:var(--steel);box-shadow:0 0 0 0 rgba(62,92,118,0.5)"
        />
        AgentC7 · standing up
      </div>
      {stuck && (
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:10px;max-width:24rem">
          <div style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ember)">
            ◆ Taking longer than expected
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            class="btn btn-ghost btn-sm"
          >
            ↻ Reload
          </button>
        </div>
      )}
    </main>
  );
}
