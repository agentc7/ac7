/**
 * FilesPanel — the top-level Files browser.
 *
 * Layout:
 *
 *   ┌─────────────────────────────────────────┐
 *   │  Breadcrumb: / > alice > uploads        │
 *   │  [ Upload ] [ New folder ] [ Shared ]   │
 *   ├─────────────────────────────────────────┤
 *   │  📁 reports                              │
 *   │  📁 drafts                               │
 *   │  📄 hello.txt    1.2 KB                  │
 *   │  🖼 logo.png     34 KB                   │
 *   └─────────────────────────────────────────┘
 *
 * Permissions follow the store: everyone sees their own home tree;
 * directors see every slot's home under `/`; non-owners see files
 * shared with them via the "Shared with me" toggle which hits
 * `/fs/shared`.
 */

import { signal } from '@preact/signals';
import type { FsEntry } from '@agentc7/sdk/types';
import { FS_PATHS } from '@agentc7/sdk/protocol';
import { getClient } from '../lib/client.js';
import { selectFiles } from '../lib/view.js';

interface PanelState {
  mode: 'tree' | 'shared';
  path: string;
  entries: FsEntry[] | null;
  loading: boolean;
  error: string | null;
}

const panelState = signal<PanelState>({
  mode: 'tree',
  path: '/',
  entries: null,
  loading: false,
  error: null,
});

async function refreshTree(path: string): Promise<void> {
  panelState.value = { ...panelState.value, mode: 'tree', path, loading: true, error: null };
  try {
    const entries = await getClient().fsList(path);
    panelState.value = { ...panelState.value, entries, loading: false };
  } catch (err) {
    panelState.value = {
      ...panelState.value,
      error: err instanceof Error ? err.message : 'failed to list directory',
      loading: false,
      entries: null,
    };
  }
}

async function refreshShared(): Promise<void> {
  panelState.value = { ...panelState.value, mode: 'shared', loading: true, error: null };
  try {
    const entries = await getClient().fsShared();
    panelState.value = { ...panelState.value, entries, loading: false };
  } catch (err) {
    panelState.value = {
      ...panelState.value,
      error: err instanceof Error ? err.message : 'failed to list shared files',
      loading: false,
      entries: null,
    };
  }
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function kindGlyph(entry: FsEntry): string {
  if (entry.kind === 'directory') return '▸';
  if (entry.mimeType?.startsWith('image/')) return '◈';
  if (entry.mimeType?.startsWith('text/')) return '≡';
  if (entry.mimeType === 'application/pdf') return '⧉';
  return '◆';
}

async function handleUpload(files: FileList | null, currentPath: string): Promise<void> {
  if (!files || files.length === 0) return;
  // Uploads land directly under the currently-viewed directory. If
  // the user is at root, we nudge them into their home first so
  // they don't create a directory at root (which would fail anyway).
  const targetDir = currentPath === '/' ? null : currentPath;
  if (!targetDir) {
    panelState.value = {
      ...panelState.value,
      error: 'Navigate into your home directory before uploading.',
    };
    return;
  }
  for (const file of Array.from(files)) {
    try {
      await getClient().fsWrite({
        path: `${targetDir.replace(/\/$/, '')}/${file.name}`,
        mimeType: file.type || 'application/octet-stream',
        source: file,
        collision: 'suffix',
      });
    } catch (err) {
      panelState.value = {
        ...panelState.value,
        error: `upload failed for ${file.name}: ${err instanceof Error ? err.message : err}`,
      };
      return;
    }
  }
  await refreshTree(targetDir);
}

async function handleDelete(entry: FsEntry): Promise<void> {
  if (!confirm(`Delete ${entry.path}?`)) return;
  try {
    await getClient().fsRm(entry.path, entry.kind === 'directory');
    if (panelState.value.mode === 'shared') {
      await refreshShared();
    } else {
      await refreshTree(panelState.value.path);
    }
  } catch (err) {
    panelState.value = {
      ...panelState.value,
      error: `delete failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

function Breadcrumb({ path }: { path: string }) {
  const segments = path === '/' ? [] : path.slice(1).split('/');
  return (
    <nav aria-label="path" style="font-family:var(--f-mono);font-size:12.5px">
      <button
        type="button"
        onClick={() => void refreshTree('/')}
        style="background:none;border:none;padding:4px 6px;cursor:pointer;color:var(--link);font-family:inherit;font-size:inherit"
      >
        /
      </button>
      {segments.map((seg, i) => {
        const subpath = `/${segments.slice(0, i + 1).join('/')}`;
        const isLast = i === segments.length - 1;
        return (
          <span key={subpath}>
            <span style="color:var(--muted);margin:0 2px">›</span>
            <button
              type="button"
              onClick={() => void refreshTree(subpath)}
              disabled={isLast}
              style={`background:none;border:none;padding:4px 6px;cursor:${isLast ? 'default' : 'pointer'};color:${isLast ? 'var(--ink)' : 'var(--link)'};font-family:inherit;font-size:inherit;font-weight:${isLast ? 700 : 500}`}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export interface FilesPanelProps {
  viewer: string;
  path: string;
}

export function FilesPanel({ viewer, path }: FilesPanelProps) {
  // Normalize the incoming path once per render and load lazily
  // when it changes. We compare against the current panelState to
  // avoid looping on our own signal updates.
  const current = panelState.value;
  if (
    current.mode === 'tree' &&
    current.path !== path &&
    !current.loading &&
    current.error === null
  ) {
    void refreshTree(path);
  }
  if (current.entries === null && !current.loading && current.error === null) {
    void refreshTree(path);
  }

  const entries = current.entries ?? [];

  return (
    <div class="flex-1 flex flex-col min-h-0" style="padding:16px;overflow-y:auto">
      <header
        style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--rule)"
      >
        <h2 style="margin:0;font-family:var(--f-display);letter-spacing:-.01em">Files</h2>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          {current.mode === 'tree' ? (
            <Breadcrumb path={current.path} />
          ) : (
            <span style="font-family:var(--f-mono);font-size:12.5px;color:var(--muted)">
              Shared with you
            </span>
          )}
          <div style="margin-left:auto;display:flex;gap:8px">
            <label
              class="btn"
              style="cursor:pointer;font-size:12px"
              title="Upload one or more files into the current directory"
            >
              Upload…
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void handleUpload(
                    (e.currentTarget as HTMLInputElement).files,
                    current.path,
                  );
                }}
              />
            </label>
            <button
              type="button"
              class="btn"
              style="font-size:12px"
              onClick={() => void refreshTree(`/${viewer}`)}
              title="Jump to your home"
            >
              Home
            </button>
            <button
              type="button"
              class={`btn${current.mode === 'shared' ? ' btn-primary' : ''}`}
              style="font-size:12px"
              onClick={() =>
                current.mode === 'shared' ? void refreshTree(current.path) : void refreshShared()
              }
              title="Show files other teammates have shared with you"
            >
              {current.mode === 'shared' ? 'Browse tree' : 'Shared with me'}
            </button>
          </div>
        </div>
      </header>

      {current.error && (
        <div role="alert" class="callout err" style="margin-bottom:10px">
          <div class="icon" aria-hidden="true">◆</div>
          <div class="body">
            <div class="msg">{current.error}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              panelState.value = { ...panelState.value, error: null };
            }}
            aria-label="Dismiss"
            class="close"
          >
            ×
          </button>
        </div>
      )}

      {current.loading && (
        <p style="color:var(--muted);font-size:13px">Loading…</p>
      )}

      {!current.loading && entries.length === 0 && !current.error && (
        <p style="color:var(--muted);font-size:13px">
          {current.mode === 'shared'
            ? 'Nothing has been shared with you yet.'
            : 'This directory is empty.'}
        </p>
      )}

      <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px">
        {entries.map((entry) => (
          <li
            key={entry.path}
            style="display:flex;gap:10px;align-items:center;padding:8px 10px;background:var(--bg-alt);border-radius:4px;font-size:13px"
          >
            <span
              aria-hidden="true"
              style="color:var(--steel);font-size:16px;line-height:1;width:18px;text-align:center"
            >
              {kindGlyph(entry)}
            </span>
            {entry.kind === 'directory' ? (
              <button
                type="button"
                onClick={() => {
                  // Navigating via a tree click updates both the url-
                  // like state and the shell view so deep-linking stays
                  // consistent with the Sidebar entry.
                  selectFiles(entry.path);
                  void refreshTree(entry.path);
                }}
                style="background:none;border:none;padding:0;cursor:pointer;color:var(--link);font-weight:600;text-align:left;flex:1;min-width:0;word-break:break-word"
              >
                {entry.name}/
              </button>
            ) : (
              <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
                <span style="font-weight:500;word-break:break-word">{entry.name}</span>
                <span style="color:var(--muted);font-size:11px">
                  {formatSize(entry.size)} · {entry.mimeType ?? 'unknown'}
                  {entry.owner !== viewer && ` · owned by ${entry.owner}`}
                </span>
              </span>
            )}
            {entry.kind === 'file' && (
              <a
                href={FS_PATHS.read(entry.path)}
                download={entry.name}
                class="btn"
                style="font-size:11px;padding:4px 8px"
              >
                Download
              </a>
            )}
            {current.mode !== 'shared' && entry.owner === viewer && (
              <button
                type="button"
                class="btn"
                style="font-size:11px;padding:4px 8px;color:var(--err)"
                onClick={() => void handleDelete(entry)}
                aria-label={`Delete ${entry.name}`}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Test reset. */
export function __resetFilesPanelForTests(): void {
  panelState.value = {
    mode: 'tree',
    path: '/',
    entries: null,
    loading: false,
    error: null,
  };
}
