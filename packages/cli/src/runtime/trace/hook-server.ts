/**
 * Loopback HTTP endpoint for Claude Code hook events.
 *
 * Claude Code's hook system fires lifecycle callbacks at points in the
 * agent loop the MITM proxy can't see (tool execution windows that
 * don't generate LLM calls). We bind a small HTTP server here, write
 * its URL into `.claude/settings.json` as a `type: "http"` hook target,
 * and let Claude Code POST to us on PreToolUse / PostToolUse /
 * PostToolUseFailure.
 *
 * Why HTTP and not `type: "command"`:
 *   - Each `type: "command"` hook forks a process per event. With ~50
 *     tool calls per turn over a session, that's hundreds of Node
 *     startups for what should be a counter bump.
 *   - HTTP hooks are single localhost round-trips — sub-millisecond on
 *     loopback.
 *   - We already bind two listeners (the MITM proxy, the runner IPC
 *     socket); a third is cheap.
 *
 * The server is single-purpose: bumps `busy('tool_inflight')` on
 * PreToolUse, decrements on PostToolUse / PostToolUseFailure. It
 * keeps a per-`tool_use_id` map of busy handles so out-of-order
 * matching (e.g., a hook event arrives twice or out of sequence)
 * stays correct: PreToolUse for an id we already have is a no-op;
 * PostToolUse for an id we don't have is a no-op; double Post
 * decrements at most once.
 *
 * On close, all outstanding handles are drained so a torn-down runner
 * can't leave the indicator wedged at "busy".
 */

import { createServer, type Server } from 'node:http';
import type { BusySignal } from './busy.js';

export type ClaudeHookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch';

interface HookRequestBody {
  hook_event_name?: string;
  tool_use_id?: string;
  tool_name?: string;
}

export interface HookServer {
  /** The full URL that goes into the `type: "http"` hook config. */
  readonly url: string;
  /** Live count of outstanding tool handles. Useful for diagnostics. */
  readonly inFlight: number;
  /** Tear down: drain any remaining handles, close the listener. */
  close(): Promise<void>;
}

export interface HookServerOptions {
  busy: BusySignal;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'hook-server', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });

  // Per-tool-use-id handles. The same id appears in PreToolUse and
  // PostToolUse, so the matching is exact when Claude Code is
  // well-behaved. If we get an unexpected duplicate or out-of-order
  // event we err on the side of "do nothing surprising" rather than
  // double-bump or under-decrement.
  const handles = new Map<string, { finish: () => void }>();

  const readBody = (req: NodeJS.ReadableStream): Promise<string> =>
    new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      let total = 0;
      // 64 KB is far more than any hook payload should be; cap to
      // defang slow-loris / oversized-body adversaries even on
      // loopback. A real claude payload is ~1-2 KB.
      const cap = 64 * 1024;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > cap) {
          req.removeAllListeners('data');
          req.removeAllListeners('end');
          reject(new Error('hook payload exceeded 64 KB cap'));
          return;
        }
        parts.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });

  const server: Server = createServer(async (req, res) => {
    // Liveness only — anything except POST /hook/tool-event gets a 404
    // so misconfiguration is loud.
    if (req.method !== 'POST' || req.url !== '/hook/tool-event') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    let body: HookRequestBody;
    try {
      const raw = await readBody(req);
      const parsed = raw.length === 0 ? {} : JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('hook body is not a JSON object');
      }
      body = parsed as HookRequestBody;
    } catch (err) {
      log('hook-server: bad request', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
      return;
    }

    const event = body.hook_event_name;
    const toolUseId = body.tool_use_id;
    if (typeof event !== 'string' || typeof toolUseId !== 'string' || toolUseId.length === 0) {
      // Missing essentials. Don't 4xx — Claude Code might keep
      // retrying. 2xx with a no-op semantics is safer.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: false, reason: 'missing fields' }));
      return;
    }

    if (event === 'PreToolUse') {
      // Duplicate PreToolUse for the same id is a no-op — keep the
      // first handle so the matching Post still finds something.
      if (!handles.has(toolUseId)) {
        handles.set(toolUseId, options.busy.start('tool_inflight'));
      }
    } else if (
      event === 'PostToolUse' ||
      event === 'PostToolUseFailure' ||
      event === 'PostToolBatch'
    ) {
      const handle = handles.get(toolUseId);
      if (handle) {
        handle.finish();
        handles.delete(toolUseId);
      }
      // Note: PostToolBatch may carry a synthetic batch id rather than
      // a real tool_use_id; we still try to drain the matching handle
      // in case Claude Code uses the same id space. Missing matches
      // are silent (no-op).
    }
    // Any other event (SessionStart, Stop, etc.) is accepted but
    // doesn't drive busy. We ignore them politely so the user can
    // share one hook config block across multiple events without
    // worrying about which ones we care about.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err) => reject(err));
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('hook-server: server.address() returned non-TCP binding');
  }
  const url = `http://127.0.0.1:${address.port}/hook/tool-event`;
  log('hook-server: listening', { url });

  return {
    url,
    get inFlight() {
      return handles.size;
    },
    async close(): Promise<void> {
      if (handles.size > 0) {
        log('hook-server: draining handles at close', { count: handles.size });
        for (const handle of handles.values()) handle.finish();
        handles.clear();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
