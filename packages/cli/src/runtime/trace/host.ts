/**
 * TraceHost — ties the MITM TLS proxy relay, the local CA, and the
 * streaming activity uploader into one handle the runner owns.
 *
 * The runner constructs a `TraceHost` at startup when tracing is
 * enabled, bakes its `envVars()` into the agent child's environment,
 * and calls `noteObjective{Open,Close}()` from the objectives
 * tracker when SSE objective events arrive. HTTPS flows to known LLM-
 * provider hosts (see `known-hosts.ts`) are MITM-decrypted and the
 * resulting HTTP/1.1 exchanges stream up to the broker via the
 * activity uploader in real time. Traffic to non-allowlisted hosts
 * passes through the proxy as a raw TCP tunnel — the agent's TLS
 * client talks to the real upstream cert end-to-end, system trust
 * applies, no plaintext is observed.
 *
 * There's no TraceBuffer, no span boundary, no per-objective
 * copying. The agent's activity log is the source of truth; per-
 * objective views are just time-range queries.
 *
 * Everything is loopback-only and scoped to the runner's lifetime.
 * On `close()` the uploader drains (best-effort), the proxy relay
 * is torn down, and the CA cert file is deleted.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client as BrokerClient } from '@agentc7/sdk/client';
import type { ActivityEvent, TraceEntry } from '@agentc7/sdk/types';
import { ActivityUploader } from './activity-uploader.js';
import { extractEntries, type HttpExchange } from './anthropic.js';
import { type BusySignal, createBusySignal } from './busy.js';
import { type HookServer, startHookServer } from './hook-server.js';
import { type Http1Exchange, Http1Reassembler } from './http1-reassembler.js';
import { isKnownLlmHost } from './known-hosts.js';
import { type CertPool, createCertPool, createTraceCa, type TraceCa } from './mitm/ca.js';
import { type ProxyRelay, startProxyRelay } from './proxy.js';
import { looksLikeSseStream, reassembleAnthropicSse } from './sse.js';

export interface TraceHostOptions {
  brokerClient: BrokerClient;
  name: string;
  /**
   * Where the CA cert PEM lives on disk. Defaults to a pid-scoped
   * path under `$TMPDIR`. Tests override this to isolate from real
   * runs.
   */
  caCertPath?: string;
  /**
   * Opt-in escape hatch: set `NODE_TLS_REJECT_UNAUTHORIZED=0` on the
   * agent child. Only useful for packaged-binary Node distributions
   * (pkg / sea / yao-pkg) that ship their own bundled cert store
   * which `NODE_EXTRA_CA_CERTS` cannot extend.
   *
   * **Do not enable this for normal Claude installs.** Disables
   * ALL TLS validation in the agent child process — including upstreams
   * that bypass the MITM proxy. Present only so a packaged Claude can
   * still be traced; sunset-dated, to be removed once a kernel-level
   * interception path (or trust-store injection) lands.
   *
   * Default: `false` — the agent child validates TLS normally, trusting
   * our MITM CA via `NODE_EXTRA_CA_CERTS`.
   */
  unsafeTls?: boolean;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface TraceHost {
  readonly proxy: ProxyRelay;
  readonly ca: TraceCa;
  readonly certPool: CertPool;
  /** Path on disk where the CA cert PEM is written, for NODE_EXTRA_CA_CERTS. */
  readonly caCertPath: string;
  /**
   * "Agent is working" signal driven by in-flight upstream HTTP
   * requests captured through the MITM proxy. The runner subscribes
   * to this and reports the boolean state to the broker so the web UI
   * can render a spinner next to the agent's name.
   */
  readonly busy: BusySignal;
  /**
   * Loopback HTTP endpoint URL that Claude Code hooks should POST to.
   * Used by the `claude-code` adapter to write a `type: "http"` hook
   * config into `.claude/settings.json` so PreToolUse / PostToolUse
   * events drive `busy('tool_inflight')`.
   *
   * Co-located with the trace host because the lifecycles are identical
   * (started together, torn down together, shares the busy signal).
   * Null is impossible here — when tracing is enabled, hooks are
   * available — but the field exists so callers can plumb without
   * a separate option.
   */
  readonly hookEndpointUrl: string;
  /**
   * Env vars to merge into the agent child's environment (see the
   * comment on the implementation for the full list). Returns a
   * delta, not a full replacement.
   */
  envVars(existingEnv?: NodeJS.ProcessEnv): Record<string, string>;
  /** Record an objective_open event in the agent's activity stream. */
  noteObjectiveOpen(objectiveId: string): void;
  /** Record an objective_close event. */
  noteObjectiveClose(
    objectiveId: string,
    result: 'done' | 'cancelled' | 'reassigned' | 'runner_shutdown',
  ): void;
  /** Flush the activity uploader + tear down the proxy + delete the CA cert file. */
  close(): Promise<void>;
}

export async function startTraceHost(options: TraceHostOptions): Promise<TraceHost> {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'trace-host', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });

  const caCertPath =
    options.caCertPath ??
    join(tmpdir(), `ac7-trace-ca-${process.pid}-${randomBytes(4).toString('hex')}.pem`);

  // Generate a fresh per-session CA + shared leaf keypair. The CA
  // cert (public) goes to disk so the agent can pick it up via
  // `NODE_EXTRA_CA_CERTS`. Private keys never touch disk.
  const ca = createTraceCa();
  await fs.writeFile(caCertPath, ca.caCertPem, { mode: 0o600 });
  const certPool = createCertPool(ca);

  // Streaming activity uploader — batches events, ships to broker.
  const uploader = new ActivityUploader({
    brokerClient: options.brokerClient,
    name: options.name,
    log,
  });

  // "Agent is working" signal — bumped on each in-flight HTTP
  // request that lands in the reassembler, dropped when the
  // matching response (or session-close request-only flush)
  // completes the exchange. Pending → finish handles are stored by
  // sessionId+startedAt so we can decrement at exchange time.
  // Pass the host's structured logger through so handle auto-finish
  // warnings (stuck handles tripping the max-age safety net) land in
  // the same stream the rest of the trace layer logs into.
  const busy = createBusySignal({ log });
  const pendingHandles = new Map<string, { finish: () => void }>();
  const handleKey = (sessionId: number, startedAt: number): string => `${sessionId}:${startedAt}`;

  // Incremental HTTP/1.1 reassembler — turns plaintext proxy
  // chunks into completed request/response exchanges. Each
  // exchange is translated to an activity event and handed to
  // the uploader.
  const reassembler = new Http1Reassembler({
    log,
    onRequestStart: ({ sessionId, startedAt }) => {
      pendingHandles.set(handleKey(sessionId, startedAt), busy.start('llm_inflight'));
    },
    onExchange: (exchange) => {
      const handle = pendingHandles.get(handleKey(exchange.sessionId, exchange.startedAt));
      if (handle) {
        handle.finish();
        pendingHandles.delete(handleKey(exchange.sessionId, exchange.startedAt));
      }
      const event = exchangeToActivity(exchange);
      if (event) uploader.enqueue(event);
    },
  });

  const proxy = await startProxyRelay({
    log,
    certPool,
    // Scoped MITM: only allowlisted LLM-provider hosts get TLS-
    // terminated and parsed. Everything else flows through the proxy
    // as a raw TCP tunnel so the agent's standard system trust store
    // applies — we never see plaintext for non-LLM traffic, which
    // both keeps the privacy posture honest and avoids breaking
    // curl/git/python/etc. that don't honor NODE_EXTRA_CA_CERTS.
    shouldMitm: isKnownLlmHost,
    onChunk: (chunk) => reassembler.ingest(chunk),
    onSessionEnd: (session) => reassembler.closeSession(session.id),
  });

  // Loopback HTTP endpoint for Claude Code hook events. The runner
  // writes its URL into `.claude/settings.json` so PreToolUse /
  // PostToolUse callbacks bump the same `busy` signal the MITM uses.
  // For codex this is unused — codex feeds busy via JSON-RPC
  // notifications on the app-server stream.
  const hookServer: HookServer = await startHookServer({ busy, log });

  log('trace-host: started', {
    proxyUrl: proxy.proxyUrl,
    hookUrl: hookServer.url,
    caCertPath,
    name: options.name,
  });

  let closed = false;

  return {
    proxy,
    ca,
    certPool,
    caCertPath,
    busy,
    hookEndpointUrl: hookServer.url,
    /**
     * Env vars the agent child needs to route through us and trust
     * our MITM CA. Under scoped MITM (see `known-hosts.ts`), only the
     * LLM-host allowlist gets TLS-terminated, so we deliberately do
     * NOT inject the universal CA-bundle vars (`SSL_CERT_FILE`,
     * `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`):
     *
     *   - For allowlisted hosts, the agent's Node TLS client honors
     *     `NODE_EXTRA_CA_CERTS` and accepts our leaf certs. Agents
     *     that use a non-Node TLS stack (e.g. codex via reqwest) get
     *     adapter-specific translation in their spawn paths.
     *   - For non-allowlisted hosts, the proxy is a raw TCP tunnel —
     *     the agent sees the real upstream cert, system trust
     *     applies, our CA is irrelevant. Setting `SSL_CERT_FILE`
     *     universally would actively break curl/git/python by
     *     replacing the system trust store with our single-CA pem.
     */
    envVars(existingEnv: NodeJS.ProcessEnv = {}): Record<string, string> {
      const existingNoProxy = existingEnv.NO_PROXY ?? existingEnv.no_proxy ?? '';
      const noProxyHosts = ['localhost', '127.0.0.1', '::1'];
      const mergedNoProxy = existingNoProxy
        ? `${existingNoProxy},${noProxyHosts.join(',')}`
        : noProxyHosts.join(',');
      const env: Record<string, string> = {
        HTTPS_PROXY: proxy.proxyUrl,
        HTTP_PROXY: proxy.proxyUrl,
        ALL_PROXY: proxy.proxyUrl,
        NO_PROXY: mergedNoProxy,
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: caCertPath,
      };
      if (options.unsafeTls === true) {
        // Opt-in escape hatch for packaged-binary Node distros that
        // can't pick up `NODE_EXTRA_CA_CERTS`. Disables ALL TLS
        // validation in the child; individual-contributor opted in via --unsafe-tls.
        env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      }
      return env;
    },
    noteObjectiveOpen(objectiveId) {
      uploader.enqueue({
        kind: 'objective_open',
        ts: Date.now(),
        objectiveId,
      });
    },
    noteObjectiveClose(objectiveId, result) {
      uploader.enqueue({
        kind: 'objective_close',
        ts: Date.now(),
        objectiveId,
        result,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      reassembler.closeAll();
      await uploader.close().catch((err: unknown) => {
        log('trace-host: uploader close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await proxy.close().catch((err: unknown) => {
        log('trace-host: proxy close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await hookServer.close().catch((err: unknown) => {
        log('trace-host: hook server close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Final safety net for the busy signal. Sub-system closes above
      // (reassembler flush, hook server drain, codex sniff drain at
      // its own teardown) should have drained every handle they own.
      // If anything slipped through — a keep-alive socket that never
      // emitted onSessionEnd, a dropped item/completed notification,
      // a hook event that never fired — this guarantees the indicator
      // goes idle before the runner exits rather than waiting on the
      // 30s server-side TTL.
      //
      // Snapshot per-source counts BEFORE the drain so the diagnostic
      // log tells us which source leaked (the counts are all zero
      // after forceFinishAll, which would be useless on its own).
      const leakedCounts = busy.getSourceCounts();
      const drained = busy.forceFinishAll();
      if (drained > 0) {
        log('trace-host: force-drained leaked busy handles at teardown', {
          drained,
          sourceCounts: leakedCounts,
        });
      }
      try {
        await fs.unlink(caCertPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('trace-host: ca cert unlink failed', {
            path: caCertPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      log('trace-host: closed');
    },
  };
}

/**
 * Turn a raw HTTP/1.1 exchange from the reassembler into an
 * `ActivityEvent` the uploader can ship. This runs the
 * existing anthropic extractor + redaction pipeline on each
 * exchange individually, so secrets are scrubbed before any bytes
 * leave the runner process.
 */
function exchangeToActivity(exchange: Http1Exchange): ActivityEvent | null {
  const httpExchange: HttpExchange = {
    request: {
      method: exchange.request.method,
      url: exchange.request.target,
      host: exchange.request.headers.host ?? exchange.upstream.host,
      headers: exchange.request.headers,
      body: decodeBodyForExchange(exchange.request.decodedBody),
    },
    response: exchange.response
      ? {
          status: exchange.response.status,
          headers: exchange.response.headers,
          body: decodeBodyForExchange(exchange.response.decodedBody),
        }
      : null,
    startedAt: exchange.startedAt,
    endedAt: exchange.endedAt,
  };
  const entries: TraceEntry[] = extractEntries([httpExchange]);
  const entry = entries[0];
  if (!entry) return null;
  const duration = Math.max(0, exchange.endedAt - exchange.startedAt);
  if (entry.kind === 'anthropic_messages') {
    return {
      kind: 'llm_exchange',
      ts: exchange.startedAt,
      duration,
      entry,
    };
  }
  return {
    kind: 'opaque_http',
    ts: exchange.startedAt,
    duration,
    entry,
  };
}

function decodeBodyForExchange(body: Buffer): unknown {
  if (body.length === 0) return null;
  const text = body.toString('utf8');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
  }
  // Anthropic `/v1/messages` with `stream: true` returns an SSE
  // body. Reassemble it into the same JSON shape the non-streaming
  // path would have produced so `buildAnthropicEntry` can read
  // `usage`, `content`, and `stop_reason` the same way.
  if (looksLikeSseStream(text)) {
    const reassembled = reassembleAnthropicSse(text);
    if (reassembled) return reassembled;
  }
  return text;
}
