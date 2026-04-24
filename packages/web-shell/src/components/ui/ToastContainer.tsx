/**
 * ToastContainer — fixed-position stack of in-app toasts.
 *
 * Reads from the `toasts` signal in `lib/toast.ts`. One instance
 * should be rendered near the root of the app (TeamShell already
 * mounts one). Each toast auto-dismisses after its `duration`; the
 * timer is cancelled if the user closes it manually or if a tagged
 * replacement pushes it out of the queue.
 *
 * Positioning: top-right on desktop, top-center on narrow viewports —
 * controlled from `theme.css` via `.toast-stack`. The container uses
 * `pointer-events:none` so the stack doesn't block clicks over empty
 * regions of the viewport; individual toasts re-enable pointer events
 * on themselves.
 */

import { useEffect } from 'preact/hooks';
import { dismissToast, type Toast, type ToastKind, toasts } from '../../lib/toast.js';

export function ToastContainer() {
  const queue = toasts.value;
  if (queue.length === 0) return null;
  return (
    <section class="toast-stack" aria-label="Notifications">
      {queue.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </section>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    if (toast.duration === null) return;
    const timer = window.setTimeout(() => dismissToast(toast.id), toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.duration]);

  const role = toast.kind === 'warn' || toast.kind === 'error' ? 'alert' : 'status';
  const variantClass = variantClassFor(toast.kind);

  return (
    <div class={`toast ${variantClass}`} role={role} aria-live="polite">
      <span class="icon" aria-hidden="true">
        {iconFor(toast.kind)}
      </span>
      <div class="body">
        {toast.title !== undefined && <div class="title">{toast.title}</div>}
        <div class="msg">{toast.body}</div>
        {toast.action !== undefined && (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            style="margin-top:6px"
            onClick={() => {
              toast.action?.onClick();
              dismissToast(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" class="x" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        ×
      </button>
    </div>
  );
}

function variantClassFor(kind: ToastKind): string {
  switch (kind) {
    case 'success':
      return 'success';
    case 'warn':
      return 'warn';
    case 'error':
      return 'err';
    default:
      return '';
  }
}

function iconFor(kind: ToastKind): string {
  switch (kind) {
    case 'success':
      return '✓';
    case 'warn':
      return '◆';
    case 'error':
      return '✕';
    default:
      return 'ℹ';
  }
}
