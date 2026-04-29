/**
 * ActivityInspector — right-rail chrome around the shared
 * `TimelineBody`. Where `<AgentTimeline />` is the per-member-profile
 * card view, this is the persistent inspector mounted alongside a
 * thread. The body (chip bar, scope picker, threaded feed) is the
 * same component; only the header differs.
 *
 *   ┌──────────────────────────────┐
 *   │ scout-analyst       ● live   │  ← feed-header (this file)
 *   ├──────────────────────────────┤
 *   │ [● LLM] [● HTTP] [○ obj…]    │  ← TimelineBody
 *   │ scope: all activity ▾        │
 *   │  ─────────────────────       │
 *   │  ▶ 14:02  2 tools · 4.6k tok │
 *   │  ▶ 14:03  ...                │
 *   └──────────────────────────────┘
 *
 * Owns the activity-stream subscription for the agent in focus —
 * `startMemberActivitySubscribe` is a single-active-subscription API,
 * so mounting this with a new `agentName` automatically tears down
 * any previous stream.
 *
 * Responsive behavior is driven by `theme.css` `.activity-inspector`
 * media queries: 380px above 1280, 320px between 1100 and 1280, and
 * a right-side overlay drawer below 1100. The `data-inspector-open`
 * attribute toggles the open/closed state of the overlay.
 */

import { useEffect } from 'preact/hooks';
import { closeInspector, isInspectorOpen } from '../lib/inspector.js';
import { memberActivityConnected, startMemberActivitySubscribe } from '../lib/member-activity.js';
import { TimelineBody } from './AgentTimeline.js';
import { X } from './icons/index.js';

interface ActivityInspectorProps {
  /** Display name shown in the feed-header. */
  agentName: string;
}

export function ActivityInspector({ agentName }: ActivityInspectorProps) {
  const connected = memberActivityConnected.value;
  const open = isInspectorOpen.value;

  useEffect(() => {
    return startMemberActivitySubscribe({ name: agentName });
  }, [agentName]);

  return (
    <aside
      class="activity-inspector flex flex-col flex-shrink-0"
      aria-label={`Activity for ${agentName}`}
      data-inspector-open={open ? 'true' : 'false'}
      style="height:100%;background:var(--paper);border-left:1px solid var(--rule)"
    >
      <header style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--rule);flex-shrink:0">
        <div style="min-width:0">
          <div style="font-family:var(--f-mono);font-weight:600;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {agentName}
          </div>
          <div style="font-family:var(--f-sans);font-size:11px;color:var(--muted)">
            activity stream
          </div>
        </div>
        <span
          title={connected ? 'Activity stream connected' : 'Activity stream offline'}
          style={`font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:${connected ? 'var(--steel)' : 'var(--muted)'};white-space:nowrap`}
        >
          ● {connected ? 'live' : 'offline'}
        </span>
        <button
          type="button"
          onClick={closeInspector}
          class="inspector-close items-center justify-center"
          aria-label="Close activity panel"
          title="Close (Esc)"
          style="width:28px;height:28px;background:var(--ice);border:1px solid var(--rule);color:var(--graphite);border-radius:var(--r-xs);cursor:pointer;flex-shrink:0;margin-left:4px"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </header>

      <div style="flex:1;min-height:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px">
        <TimelineBody />
      </div>
    </aside>
  );
}
