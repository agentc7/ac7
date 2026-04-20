/**
 * Composer — textarea + attach chips + send button at the bottom of the shell.
 *
 * Enter sends (without shift), Shift+Enter inserts a newline. Sends
 * route to /push with `agentId` derived from the current view:
 *   - primary thread → agentId omitted (broadcast)
 *   - dm:<other>     → agentId: other
 *   - dm:self        → agentId: viewer (self-DM)
 *
 * File attachments:
 *   - A paperclip button opens a multi-file picker; drag-and-drop
 *     onto the composer area works too.
 *   - Each file shows as a chip with name / size / status. While
 *     uploading, the send button is disabled. Failed uploads can be
 *     dismissed to retry manually.
 *   - Files auto-upload to `/<viewer>/uploads/<name>` with
 *     `collision: 'suffix'` so repeated uploads of the same name are
 *     silently renamed to `-1`, `-2`, etc.
 *   - Send assembles the text + finished-upload paths into a single
 *     `/push` request. The composer never sends when uploads are
 *     still in flight.
 *
 * On the server `/push` stamps the authoritative `from`, creates
 * per-recipient read grants on each attachment, and fans out to
 * subscribers; our own SSE stream echoes the message back.
 */

import { signal } from '@preact/signals';
import type { Attachment } from '@agentc7/sdk/types';
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { getClient } from '../lib/client.js';
import { appendMessages, messagesByThread, PRIMARY_THREAD } from '../lib/messages.js';
import { view } from '../lib/view.js';

interface PendingUpload {
  /** Local stable id for render keys + removal. */
  localId: string;
  file: File;
  status: 'uploading' | 'ready' | 'error';
  /** Populated on success; the authoritative attachment shape. */
  attachment?: Attachment;
  /** Populated on failure. */
  error?: string;
}

const draft = signal('');
const sending = signal(false);
const sendError = signal<string | null>(null);
const pending = signal<PendingUpload[]>([]);
const dragging = signal(false);

let optimisticSeq = 0;
let uploadSeq = 0;

function targetAgentIdFor(key: string, viewer: string): string | undefined {
  if (key === PRIMARY_THREAD) return undefined;
  if (key === 'dm:self') return viewer;
  if (key.startsWith('dm:')) return key.slice(3);
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function startUpload(file: File, viewer: string): PendingUpload {
  const entry: PendingUpload = {
    localId: `upload-${++uploadSeq}`,
    file,
    status: 'uploading',
  };
  pending.value = [...pending.value, entry];

  void (async () => {
    try {
      const result = await getClient().fsWrite({
        path: `/${viewer}/uploads/${file.name}`,
        mimeType: file.type || 'application/octet-stream',
        source: file,
        collision: 'suffix',
      });
      pending.value = pending.value.map((p) =>
        p.localId === entry.localId
          ? {
              ...p,
              status: 'ready',
              attachment: {
                path: result.entry.path,
                name: result.entry.name,
                size: result.entry.size ?? file.size,
                mimeType: result.entry.mimeType ?? 'application/octet-stream',
              },
            }
          : p,
      );
    } catch (err) {
      pending.value = pending.value.map((p) =>
        p.localId === entry.localId
          ? {
              ...p,
              status: 'error',
              error: err instanceof Error ? err.message : 'upload failed',
            }
          : p,
      );
    }
  })();

  return entry;
}

function dismissUpload(localId: string): void {
  pending.value = pending.value.filter((p) => p.localId !== localId);
}

export interface ComposerProps {
  viewer: string;
}

export function Composer({ viewer }: ComposerProps) {
  const v = view.value;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  if (v.kind !== 'thread') return null;

  const threadKey = v.key;
  const pendingList = pending.value;
  const anyUploading = pendingList.some((p) => p.status === 'uploading');
  const readyAttachments = pendingList
    .filter((p) => p.status === 'ready' && p.attachment)
    .map((p) => p.attachment as Attachment);

  const canSend =
    !sending.value &&
    !anyUploading &&
    (draft.value.trim().length > 0 || readyAttachments.length > 0);

  const send = async () => {
    const body = draft.value.trim();
    if (!canSend) return;
    sending.value = true;
    sendError.value = null;
    const agentId = targetAgentIdFor(threadKey, viewer);
    const optimisticId = `optimistic-${++optimisticSeq}`;
    // We allow empty body when there's at least one attachment — a
    // picture/file can be its own message. The server accepts it
    // because PushPayloadSchema.body only requires min(1), but we
    // guard by substituting a single space so the server doesn't
    // reject the payload. Trim on render keeps the UI clean.
    const effectiveBody = body.length > 0 ? body : ' ';
    appendMessages(viewer, [
      {
        id: optimisticId,
        ts: Date.now(),
        agentId: agentId ?? null,
        from: viewer,
        title: null,
        body: effectiveBody,
        level: 'info',
        data: {},
        attachments: readyAttachments,
      },
    ]);
    const clearedDraft = draft.value;
    draft.value = '';
    // Grab the current pending list before we clear it so the
    // optimistic append has stable references even if more uploads
    // start before the response returns.
    const clearedPending = pendingList;
    pending.value = [];
    try {
      const result = await getClient().push({
        body: effectiveBody,
        ...(agentId !== undefined ? { agentId } : {}),
        ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
      });
      pruneOptimistic(threadKey, optimisticId);
      appendMessages(viewer, [result.message]);
    } catch (err) {
      draft.value = clearedDraft;
      pending.value = clearedPending;
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

  const onFocus = () => {
    const el = textareaRef.current;
    if (!el) return;
    setTimeout(() => {
      el.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }, 300);
  };

  const onFilesChosen = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) startUpload(f, viewer);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragging.value = false;
    onFilesChosen(event.dataTransfer?.files ?? null);
  };

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (!dragging.value) dragging.value = true;
  };

  const onDragLeave = () => {
    dragging.value = false;
  };

  return (
    <div
      class="flex-shrink-0"
      style={`background:${dragging.value ? 'var(--bg-alt)' : 'var(--ice)'};border-top:1px solid var(--rule);padding:12px max(0.75rem,env(safe-area-inset-right)) max(0.75rem,env(safe-area-inset-bottom)) max(0.75rem,env(safe-area-inset-left));overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:none;touch-action:manipulation;transition:background 120ms`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {sendError.value && (
        <div role="alert" class="callout err" style="margin-bottom:10px;padding:10px 12px">
          <div class="icon" aria-hidden="true">◆</div>
          <div class="body">
            <div class="msg">{sendError.value}</div>
          </div>
        </div>
      )}

      {pendingList.length > 0 && (
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
          {pendingList.map((p) => (
            <span
              key={p.localId}
              style={`display:inline-flex;gap:6px;align-items:center;padding:4px 8px;border-radius:4px;font-size:11.5px;background:${p.status === 'error' ? 'rgba(211,47,47,0.1)' : 'var(--bg-alt)'};border:1px solid ${p.status === 'error' ? 'var(--err, #d32f2f)' : 'var(--rule)'}`}
              title={p.error ?? `${p.file.name} · ${formatSize(p.file.size)}`}
            >
              <span
                aria-hidden="true"
                style={`color:${
                  p.status === 'ready'
                    ? 'var(--ok, #2e7d32)'
                    : p.status === 'error'
                      ? 'var(--err, #d32f2f)'
                      : 'var(--muted)'
                };font-weight:700`}
              >
                {p.status === 'uploading' ? '…' : p.status === 'ready' ? '✓' : '!'}
              </span>
              <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                {p.file.name}
              </span>
              <span style="color:var(--muted)">{formatSize(p.file.size)}</span>
              <button
                type="button"
                onClick={() => dismissUpload(p.localId)}
                aria-label={`Remove ${p.file.name}`}
                style="background:none;border:none;padding:0 0 0 4px;cursor:pointer;color:var(--muted);font-size:14px;line-height:1"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div class="flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          class="btn flex-shrink-0"
          title="Attach files"
          style="padding:6px 10px;font-size:16px"
          aria-label="Attach files"
        >
          ⎌
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => onFilesChosen((e.currentTarget as HTMLInputElement).files)}
        />
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
          class="textarea flex-1"
          style="min-height:auto;font-size:16px;resize:none"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          class="btn btn-primary flex-shrink-0"
        >
          {sending.value ? '…' : anyUploading ? 'Uploading…' : 'Send →'}
        </button>
      </div>
    </div>
  );
}

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
  pending.value = [];
  dragging.value = false;
}
