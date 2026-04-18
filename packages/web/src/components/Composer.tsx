/**
 * Composer — textarea + send button at the bottom of the shell.
 *
 * Enter sends (without shift), Shift+Enter inserts a newline. Sends
 * route to /push with `agentId` derived from the current view:
 *   - primary thread → agentId omitted (broadcast)
 *   - dm:<other>     → agentId: other
 *   - dm:self        → agentId: viewer (self-DM)
 *
 * On the server `/push` stamps the authoritative `from` and fans out
 * to subscribers; our own SSE stream receives the echo and appends
 * it to the transcript, so we don't optimistic-append here.
 */

import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { getClient } from '../lib/client.js';
import { appendMessages, messagesByThread, PRIMARY_THREAD } from '../lib/messages.js';
import { view } from '../lib/view.js';

const draft = signal('');
const sending = signal(false);
const sendError = signal<string | null>(null);

/**
 * Monotonic counter for optimistic message ids. SSE echo replaces the
 * optimistic message by id via `appendMessages`' dedupe-by-id path —
 * the echo's real id will be different, so the optimistic row stays
 * and the echo appends beside it. We prefix with `optimistic-` so the
 * dedupe comparison keeps them distinct. On error we splice the
 * optimistic row out of the thread.
 */
let optimisticSeq = 0;

function targetAgentIdFor(key: string, viewer: string): string | undefined {
  if (key === PRIMARY_THREAD) return undefined;
  if (key === 'dm:self') return viewer;
  if (key.startsWith('dm:')) return key.slice(3);
  return undefined;
}

export interface ComposerProps {
  viewer: string;
}

export function Composer({ viewer }: ComposerProps) {
  const v = view.value;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  if (v.kind !== 'thread') return null;

  const threadKey = v.key;

  const send = async () => {
    const body = draft.value.trim();
    if (!body || sending.value) return;
    sending.value = true;
    sendError.value = null;
    // Optimistic append — the message lands in the local transcript
    // immediately so the user sees their input reflected even on a
    // slow network. The SSE echo arrives with a server id, appends
    // as a separate row next to the optimistic one, and the optimistic
    // row is then pruned by id (below) once the POST resolves.
    const agentId = targetAgentIdFor(threadKey, viewer);
    const optimisticId = `optimistic-${++optimisticSeq}`;
    appendMessages(viewer, [
      {
        id: optimisticId,
        ts: Date.now(),
        agentId: agentId ?? null,
        from: viewer,
        title: null,
        body,
        level: 'info',
        data: {},
      },
    ]);
    const clearedDraft = draft.value;
    draft.value = '';
    try {
      await getClient().push({ body, ...(agentId !== undefined ? { agentId } : {}) });
    } catch (err) {
      // Restore the user's draft so they don't lose it, and drop the
      // optimistic row so it doesn't sit there forever pretending to
      // be delivered.
      draft.value = clearedDraft;
      sendError.value = err instanceof Error ? err.message : 'send failed';
      pruneOptimistic(threadKey, optimisticId);
    } finally {
      sending.value = false;
    }
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const onInput = (event: JSX.TargetedInputEvent<HTMLTextAreaElement>) => {
    draft.value = event.currentTarget.value;
  };

  // On focus, scroll the composer into view. On iOS the soft keyboard
  // pushes the viewport up but the textarea itself may land under the
  // keyboard if the page was scrolled. `scrollIntoView` nudges it
  // into the visual viewport. No-op on desktop.
  const onFocus = () => {
    const el = textareaRef.current;
    if (!el) return;
    // Defer one frame — iOS adjusts the viewport after focus fires.
    setTimeout(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  };

  return (
    <div
      class="flex-shrink-0"
      style="background:var(--ice);border-top:1px solid var(--rule);padding:12px max(0.75rem,env(safe-area-inset-right)) max(0.75rem,env(safe-area-inset-bottom)) max(0.75rem,env(safe-area-inset-left))"
    >
      {sendError.value && (
        <div role="alert" class="callout err" style="margin-bottom:10px;padding:10px 12px">
          <div class="icon" aria-hidden="true">
            ◆
          </div>
          <div class="body">
            <div class="msg">{sendError.value}</div>
          </div>
        </div>
      )}
      <div class="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={2}
          value={draft.value}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          placeholder={
            threadKey === PRIMARY_THREAD
              ? 'Broadcast to #team — enter to send, shift+enter for newline'
              : `Message ${threadKey.slice(3)} — enter to send`
          }
          /*
           * `text-base` (16px) on mobile is load-bearing: iOS Safari
           * auto-zooms the viewport on focus for any input <16px.
           */
          class="textarea flex-1"
          style="min-height:auto;font-size:16px;resize:none"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending.value || draft.value.trim().length === 0}
          class="btn btn-primary flex-shrink-0"
        >
          {sending.value ? '…' : 'Send →'}
        </button>
      </div>
    </div>
  );
}

/**
 * Remove an optimistic row from its thread bucket after a failed POST.
 * Reaches into `messagesByThread` directly because `appendMessages`
 * is append-only; we need the inverse operation scoped to the single
 * id we just inserted.
 */
function pruneOptimistic(threadKey: string, id: string): void {
  const current = messagesByThread.value.get(threadKey);
  if (!current) return;
  const next = new Map(messagesByThread.value);
  next.set(
    threadKey,
    current.filter((m) => m.id !== id),
  );
  messagesByThread.value = next;
}

export function __resetComposerForTests(): void {
  draft.value = '';
  sending.value = false;
  sendError.value = null;
}
