/**
 * Transcript — scrolling message list for the current thread.
 *
 * Reads from the `messagesByThread` signal and the `view`
 * signal; both drive re-renders on change. Auto-scrolls to bottom
 * when a new message arrives AND the user is already near the bottom
 * — lets individual-contributors read history without being yanked back.
 */

import { useEffect, useRef } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { isInspectorOpen, toggleInspector } from '../lib/inspector.js';
import {
  dmOther,
  messagesByThread,
  PRIMARY_THREAD,
  selectThreadMessage,
  threadMessages,
} from '../lib/messages.js';
import { selectAgentDetail, view } from '../lib/view.js';
import { MessageLine } from './MessageLine.js';

const STICKY_BOTTOM_PX = 64;

export interface TranscriptProps {
  viewer: string;
}

export function Transcript({ viewer }: TranscriptProps) {
  // Subscribe to both signals by reading them in the render body.
  const v = view.value;
  const _map = messagesByThread.value;
  void _map;
  const b = briefing.value;
  const isDirector = b?.permissions.includes('members.manage') ?? false;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);

  const threadKey = v.kind === 'thread' ? v.key : null;
  const messages = threadKey ? threadMessages(threadKey) : [];
  const dmCounterpart = threadKey !== null ? dmOther(threadKey) : null;
  const showDmHeader =
    dmCounterpart !== null && dmCounterpart !== 'self' && dmCounterpart !== viewer;

  // Track whether the user is pinned to the bottom so we know whether
  // to auto-follow on new-message arrival.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = gap < STICKY_BOTTOM_PX;
  };

  // Auto-scroll after render when sticky. Depends on messages.length
  // so a thread switch and a new message both trigger the effect.
  useEffect(() => {
    if (!stickyRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, threadKey]);

  // Drop any inspector → thread selection when navigating away from
  // the thread it was anchored to. The selected message id is opaque
  // across threads, so leaving it set would highlight nothing
  // visible and confuse a return visit.
  useEffect(() => {
    selectThreadMessage(null);
  }, [threadKey]);

  if (v.kind !== 'thread' || threadKey === null) return null;

  return (
    <div class="flex-1 flex flex-col min-h-0">
      {/* DM header — only for direct-message threads with another
          user (not primary, not obj:<id>, not self). Shows the
          counterpart name and, for admins, a link to that user's
          detail page. */}
      {showDmHeader && dmCounterpart && (
        <div
          class="flex items-center justify-between flex-shrink-0"
          style="background:var(--ice);border-bottom:1px solid var(--rule);padding:10px max(0.75rem,env(safe-area-inset-right)) 10px max(0.75rem,env(safe-area-inset-left));gap:10px"
        >
          <div class="eyebrow flex-1 min-w-0 truncate">
            DM with <span style="color:var(--ink)">{dmCounterpart}</span>
          </div>
          {isDirector && (
            <button
              type="button"
              onClick={() => selectAgentDetail(dmCounterpart)}
              class="eyebrow text-link"
              style="padding:4px 8px"
            >
              → VIEW AGENT
            </button>
          )}
          {/* Inspector toggle — visible only at narrow widths where the
              inspector is an overlay; CSS hides it at ≥1100. */}
          <button
            type="button"
            onClick={toggleInspector}
            class="inspector-toggle items-center justify-center"
            aria-label={
              isInspectorOpen.value ? 'Close activity inspector' : 'Open activity inspector'
            }
            aria-pressed={isInspectorOpen.value}
            title="Activity inspector"
            style={`width:32px;height:32px;background:${isInspectorOpen.value ? 'var(--paper)' : 'transparent'};border:1px solid ${isInspectorOpen.value ? 'var(--rule)' : 'transparent'};color:${isInspectorOpen.value ? 'var(--steel)' : 'var(--graphite)'};border-radius:var(--r-sm);cursor:pointer;flex-shrink:0`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M15 3 L15 21" />
            </svg>
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={onScroll}
        aria-live="polite"
        aria-atomic="false"
        class="flex-1 overflow-y-auto"
        style="background:var(--paper);padding:18px max(0.75rem,env(safe-area-inset-right)) 18px max(0.75rem,env(safe-area-inset-left));-webkit-overflow-scrolling:touch;overscroll-behavior:none;touch-action:manipulation"
      >
        {messages.length === 0 ? (
          <EmptyState threadKey={threadKey} />
        ) : (
          messages.map((m, i) => (
            <MessageLine
              key={m.id}
              message={m}
              viewer={viewer}
              {...(i > 0 && messages[i - 1] ? { previousMessage: messages[i - 1] } : {})}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Empty-state copy varies by thread type so new users aren't left
 * staring at "net is quiet" on a DM they just opened and wondering
 * if the app is broken. `min-h-full` pins the message to the vertical
 * center of the scroll region so the first arrival doesn't push it
 * offscreen before the user can read it.
 */
function EmptyState({ threadKey }: { threadKey: string }) {
  if (threadKey === PRIMARY_THREAD) {
    return (
      <div class="min-h-full flex items-center justify-center">
        <div class="empty" style="border:none;background:transparent;padding:24px">
          <p>◇ Net is quiet</p>
        </div>
      </div>
    );
  }
  const other = dmOther(threadKey);
  if (other !== null && other !== 'self') {
    return (
      <div class="min-h-full flex items-center justify-center" style="padding:0 16px">
        <div class="empty" style="border:none;background:transparent;padding:24px">
          <p>
            ◇ No messages yet with <span style="color:var(--steel);font-weight:600">@{other}</span>{' '}
            — send one below to start
          </p>
        </div>
      </div>
    );
  }
  return (
    <div class="min-h-full flex items-center justify-center">
      <div class="empty" style="border:none;background:transparent;padding:24px">
        <p>◇ No messages yet</p>
      </div>
    </div>
  );
}
