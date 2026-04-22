/**
 * ErrorCallout — the canonical error banner. Wraps the `.callout.err`
 * class from theme.css with a consistent shape (icon + optional title
 * + message + optional retry/dismiss actions).
 */

import type { ComponentChildren } from 'preact';

export interface ErrorCalloutProps {
  title?: string;
  message: ComponentChildren;
  onRetry?: () => void;
  onDismiss?: () => void;
  style?: string;
}

export function ErrorCallout({ title, message, onRetry, onDismiss, style }: ErrorCalloutProps) {
  return (
    <div role="alert" class="callout err" style={style}>
      <div class="icon" aria-hidden="true">
        ◆
      </div>
      <div class="body">
        {title && <div class="title">{title}</div>}
        <div class="msg">{message}</div>
        {onRetry && (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            style="margin-top:8px"
            onClick={onRetry}
          >
            ↻ Retry
          </button>
        )}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" class="close">
          ×
        </button>
      )}
    </div>
  );
}
