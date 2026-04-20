/**
 * Render the attachments of a message.
 *
 *   Image files → inline thumbnail (click to expand), capped at
 *                 a sensible display size so a chat doesn't become
 *                 a fullscreen gallery.
 *   Everything else → download chip with name, size, and a click-to-
 *                 download affordance.
 *
 * Download URLs hit `/fs/read/<path>` directly so the browser
 * handles the stream (including Content-Disposition, auth via the
 * session cookie, and caching). No SPA-side blob buffering.
 */

import { FS_PATHS } from '@agentc7/sdk/protocol';
import type { Attachment } from '@agentc7/sdk/types';

export interface MessageAttachmentsProps {
  attachments: Attachment[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** File-type glyph for non-image attachments. Pure ASCII to match brand. */
function fileGlyph(mimeType: string): string {
  if (mimeType === 'application/pdf') return '⧉';
  if (mimeType.startsWith('text/')) return '≡';
  if (mimeType.startsWith('audio/')) return '♪';
  if (mimeType.startsWith('video/')) return '▶';
  if (mimeType.startsWith('application/zip')) return '□';
  return '◆';
}

function ImageAttachment({ att }: { att: Attachment }) {
  return (
    <a
      href={FS_PATHS.read(att.path)}
      target="_blank"
      rel="noopener noreferrer"
      title={`${att.name} · ${formatSize(att.size)} · click to open`}
      style="display:inline-block;max-width:min(420px,100%);margin-top:6px;border:1px solid var(--rule);border-radius:6px;overflow:hidden;line-height:0"
    >
      <img
        src={FS_PATHS.read(att.path)}
        alt={att.name}
        loading="lazy"
        style="display:block;max-width:100%;max-height:320px;width:auto;height:auto;object-fit:contain;background:var(--bg-alt)"
      />
    </a>
  );
}

function FileChip({ att }: { att: Attachment }) {
  return (
    <a
      href={FS_PATHS.read(att.path)}
      download={att.name}
      title={`Download ${att.name}`}
      style="display:inline-flex;gap:8px;align-items:center;padding:8px 10px;margin-top:4px;background:var(--bg-alt);border:1px solid var(--rule);border-radius:6px;text-decoration:none;color:var(--ink);font-size:13px;max-width:360px"
    >
      <span
        aria-hidden="true"
        style="font-size:18px;line-height:1;flex-shrink:0;color:var(--steel)"
      >
        {fileGlyph(att.mimeType)}
      </span>
      <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
        <span style="font-weight:600;word-break:break-word">{att.name}</span>
        <span style="color:var(--muted);font-size:11px">{formatSize(att.size)}</span>
      </span>
    </a>
  );
}

export function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px">
      {attachments.map((att) =>
        isImage(att.mimeType) ? (
          <ImageAttachment key={att.path} att={att} />
        ) : (
          <FileChip key={att.path} att={att} />
        ),
      )}
    </div>
  );
}
