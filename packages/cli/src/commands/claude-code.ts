/**
 * `ac7 claude-code` — wrap a Claude Code session in a ac7 runner.
 *
 * The runner is the parent process that owns all the heavyweight
 * state: the broker connection, the cached briefing, the SSE forwarder,
 * the objectives tracker, and the IPC socket that the MCP bridge
 * (spawned by claude-code as an MCP server via `.mcp.json`) connects
 * back to.
 *
 * Flow:
 *
 *   1. Validate args + locate the `claude` binary
 *   2. `startRunner()` — fetches briefing, binds the IPC socket, starts
 *      the forwarder. The socket path is passed into the .mcp.json
 *      bridge entry via the `AC7_RUNNER_SOCKET` env var.
 *   3. `prepareMcpConfig()` — back up the individual-contributor's `.mcp.json` and
 *      write one with a `ac7` entry that spawns `ac7 mcp-bridge`
 *      (pointed at this runner's socket).
 *   4. Spawn `claude <forwarded args>` with inherited stdio so the
 *      individual-contributor interacts with it directly in this terminal.
 *   5. On any exit path (normal, signal, claude crash, ENOENT), run
 *      the teardown: restore `.mcp.json`, shut down the runner, unlink
 *      the socket. Every teardown hook is idempotent so double-firing
 *      on SIGINT → process.exit() is safe.
 *
 * The runner never writes to stdout — stdout belongs to claude. All
 * runner diagnostics go to stderr as structured JSON, which interleaves
 * cleanly with claude's own stderr output.
 *
 * This verb is the individual-contributor entry point for Milestone A. Phase 5 adds
 * `--no-trace` / `--trace` flags and wires tracing into the spawn env;
 * for now the only knobs are `--url` / `--token` (with env fallback)
 * and the passthrough args after `--`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PORT, ENV } from '@agentc7/sdk/protocol';
import {
  ClaudeCodeAdapterError,
  findClaudeBinary,
  type McpConfigHandle,
  prepareMcpConfig,
} from '../runtime/agents/claude-code.js';
import { HUD_HEIGHT, startHud } from '../runtime/hud.js';
import { createPresence } from '../runtime/presence.js';
import { type RunnerHandle, RunnerStartupError, startRunner } from '../runtime/runner.js';
import { createSessionLog } from '../runtime/session-log.js';
import { UsageError } from './errors.js';

export { UsageError };

export interface ClaudeCodeCommandInput {
  url?: string;
  token?: string;
  /**
   * Claude args to forward. Everything after `--` on the command line
   * lands here verbatim, plus any positional args we don't recognize.
   */
  claudeArgs: string[];
  /**
   * Directory the runner runs in — this is also where the adapter
   * reads/writes `.mcp.json`. Defaults to `process.cwd()`. Tests
   * override this to isolate from the real repo.
   */
  cwd?: string;
  /** Optional logger override; defaults to stderr JSON lines. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Override the `command` + `args` written into `.mcp.json` for the
   * `ac7` MCP server entry. Defaults to `ac7 mcp-bridge`, which
   * assumes the `ac7` CLI is on PATH in whatever environment claude
   * runs. Tests override this to point at the built dist so they
   * don't depend on a global install.
   */
  bridgeCommand?: string;
  bridgeArgs?: string[];
  /**
   * Disable trace capture. When true, the runner skips starting the
   * SOCKS relay and keylog tailer and leaves the agent's network
   * environment untouched. `ac7 claude-code --no-trace` sets this.
   */
  noTrace?: boolean;
  /**
   * Opt-in escape hatch for packaged-binary Claude distributions that
   * can't honor `NODE_EXTRA_CA_CERTS`. When true, `NODE_TLS_REJECT_UNAUTHORIZED=0`
   * is set on the agent child, disabling all TLS validation there.
   * `ac7 claude-code --unsafe-tls` sets this. Default false.
   */
  unsafeTls?: boolean;
}

/**
 * Decide whether this invocation should run inside a node-pty relay
 * with the HUD strip at the bottom, or fall back to the older
 * `stdio: 'inherit'` spawn. We need a TTY on both ends (stdin and
 * stdout) to own the user's terminal; otherwise (tests, CI, piped
 * input) we keep the old behavior so automation stays deterministic.
 *
 * Also returns `false` when `node-pty` isn't loadable — the package
 * is listed in `optionalDependencies` so it may be absent on hosts
 * that couldn't build the native binding (CI runners without
 * build-essential, uncommon platforms, etc.). In those environments
 * we transparently fall back to `stdio: 'inherit'` and skip the HUD.
 */
async function shouldUsePty(): Promise<boolean> {
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return false;
  try {
    await import('node-pty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide which flags to auto-inject into the claude invocation, given
 * the user's forwarded args and the briefing prose to pin into the
 * system prompt. Three flags are candidates:
 *
 *   --dangerously-skip-permissions
 *   --dangerously-load-development-channels server:ac7
 *   --append-system-prompt <briefing>
 *
 * Each is injected unless the user already passed it (or, for the
 * append-system-prompt case, the briefing is empty — which the runner
 * treats as "nothing to pin"). The user's args are kept verbatim and
 * placed AFTER our injected flags so the user-supplied tail wins on
 * any surface that resolves last-flag-wins.
 *
 * `summary` is the human-readable banner we print to stderr; it
 * shortens the briefing prose to a char-count so a 1–8K paragraph
 * doesn't drown the welcome banner.
 */
export function computeInjectedClaudeArgs(
  userArgs: readonly string[],
  briefingInstructions: string,
): { injected: string[]; summary: string[]; final: string[] } {
  const injected: string[] = [];
  const summary: string[] = [];
  const userPassedSkipPerms = userArgs.includes('--dangerously-skip-permissions');
  const userPassedDevChannels = userArgs.includes('--dangerously-load-development-channels');
  const userPassedAppendSysPrompt = userArgs.includes('--append-system-prompt');
  if (!userPassedSkipPerms) {
    injected.push('--dangerously-skip-permissions');
    summary.push('--dangerously-skip-permissions');
  }
  if (!userPassedDevChannels) {
    injected.push('--dangerously-load-development-channels', 'server:ac7');
    summary.push('--dangerously-load-development-channels server:ac7');
  }
  if (!userPassedAppendSysPrompt && briefingInstructions.length > 0) {
    injected.push('--append-system-prompt', briefingInstructions);
    summary.push(`--append-system-prompt <ac7 briefing, ${briefingInstructions.length} chars>`);
  }
  return { injected, summary, final: [...injected, ...userArgs] };
}

/**
 * Run a Claude Code session wrapped in a ac7 runner. Resolves with the
 * exit code of the claude subprocess (so the CLI entry can propagate
 * it via `process.exit`). Teardown is synchronous-best-effort so even
 * a crashing claude leaves the individual-contributor's `.mcp.json` in its original
 * state.
 */
export async function runClaudeCodeCommand(input: ClaudeCodeCommandInput): Promise<number> {
  // When the caller (tests, embedders) provides an explicit log, honor
  // it unchanged. Otherwise auto-route: if stderr is a TTY we'll be
  // running the pty + HUD path and stderr writes would corrupt claude's
  // frame, so structured logs go to ~/.cache/agentc7/session-<pid>.log
  // instead. `sessionLog.path` is printed on startup so the user
  // can `tail -f` it for live diagnostics.
  const ownedSessionLog = input.log ? null : createSessionLog({ component: 'claude-code' });
  const log = input.log ?? (ownedSessionLog as NonNullable<typeof ownedSessionLog>).log;
  const url = input.url ?? process.env[ENV.url] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
  const token = input.token ?? process.env[ENV.token];
  if (!token) {
    throw new UsageError(
      `--token or ${ENV.token} is required — run \`ac7 setup\` or pass the user's bearer token explicitly`,
    );
  }
  const cwd = input.cwd ?? process.cwd();

  // 1. Locate claude before we touch anything shared — if it's missing
  //    we want to bail without modifying `.mcp.json` or binding a socket.
  let claudeBinary: string;
  try {
    claudeBinary = findClaudeBinary();
  } catch (err) {
    if (err instanceof ClaudeCodeAdapterError) {
      throw new UsageError(err.message);
    }
    throw err;
  }

  // 2. Start the runner. If this fails we haven't touched `.mcp.json`
  //    yet either, so a failure here just propagates cleanly.
  const presence = createPresence();
  let runner: RunnerHandle;
  try {
    runner = await startRunner({
      url,
      token,
      log,
      presence,
      noTrace: input.noTrace,
      unsafeTls: input.unsafeTls,
    });
  } catch (err) {
    if (err instanceof RunnerStartupError) {
      ownedSessionLog?.close();
      throw new UsageError(err.message);
    }
    ownedSessionLog?.close();
    throw err;
  }
  log('claude-code: runner started', {
    socketPath: runner.socketPath,
    name: runner.briefing.name,
    role: runner.briefing.role,
    team: runner.briefing.team,
  });

  // 3. Back up `.mcp.json` and install our bridge entry. Any failure
  //    here tears down the runner before propagating so we don't leave
  //    an orphaned IPC socket.
  let mcpHandle: McpConfigHandle;
  // Auto-detect the bridge command from the currently-running cli
  // process. `process.execPath` is the node binary; `process.argv[1]`
  // is the absolute path to the cli's entry script (dist/index.js in
  // dev, the globally-installed cli in production). Baking these
  // into the `.mcp.json` entry means claude spawns the SAME cli that
  // spawned it — no PATH assumption, works identically whether the
  // individual-contributor ran `ac7 claude-code` via a shell alias, a pnpm script,
  // or a global npm install. Callers may still override via
  // `input.bridgeCommand`/`bridgeArgs` for tests that want explicit
  // paths.
  const detectedBridgeCommand = input.bridgeCommand ?? process.execPath;
  const detectedBridgeArgs =
    input.bridgeArgs ?? (process.argv[1] ? [process.argv[1], 'mcp-bridge'] : ['mcp-bridge']);

  // Human-readable CWD / .mcp.json disclosure on stderr. Dan's
  // 2026-04-16 audit Part-3 DX item #3: the runner rewrites `.mcp.json`
  // in the current working directory, and individual-contributors running from the
  // wrong directory don't notice until they see their MCP servers
  // "disappear" mid-session. Printing the absolute path up-front (and
  // flagging whether we're merging into an existing file or creating a
  // fresh one) makes the surface legible on turn 1.
  const mcpTargetPath = resolve(cwd, '.mcp.json');
  const mcpExistedPriorToRun = existsSync(mcpTargetPath);
  process.stderr.write(
    `ac7: runner cwd = ${cwd}\n` +
      `ac7: .mcp.json = ${mcpTargetPath}${
        mcpExistedPriorToRun ? ' (found — backing up and merging ac7 entry)' : ' (creating)'
      }\n` +
      (ownedSessionLog?.path ? `ac7: session log = ${ownedSessionLog.path}\n` : ''),
  );

  try {
    mcpHandle = prepareMcpConfig({
      cwd,
      runnerSocketPath: runner.socketPath,
      bridgeCommand: detectedBridgeCommand,
      bridgeArgs: detectedBridgeArgs,
    });
  } catch (err) {
    await runner.shutdown('mcp-config-failed').catch((shutdownErr) => {
      log('claude-code: runner shutdown failed during mcp-config cleanup', {
        error: shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr),
      });
    });
    if (err instanceof ClaudeCodeAdapterError) {
      throw new UsageError(err.message);
    }
    throw err;
  }
  log('claude-code: .mcp.json prepared', { path: mcpHandle.path });

  // 4. Spawn claude. In interactive sessions we route through a
  //    node-pty relay so we can (a) reserve the bottom `HUD_HEIGHT`
  //    rows for the ac7 status strip and (b) own the stream for
  //    later features (e.g. injecting `/compact` on demand). When
  //    stdout/stdin aren't TTYs (tests, piped input) we fall back
  //    to `stdio: 'inherit'` so automation stays byte-for-byte
  //    compatible.
  let teardownDone = false;
  let closeHud: (() => void) | null = null;
  const teardown = async (reason: string): Promise<void> => {
    if (teardownDone) return;
    teardownDone = true;
    log('claude-code: tearing down', { reason });
    try {
      closeHud?.();
    } catch {
      /* ignore */
    }
    try {
      mcpHandle.restore();
    } catch (err) {
      log('claude-code: mcp restore threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await runner.shutdown(reason).catch((err) => {
      log('claude-code: runner shutdown threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    ownedSessionLog?.close();
  };

  // Merge trace host env vars (ALL_PROXY / SSLKEYLOGFILE / NODE_OPTIONS)
  // into the child's environment when tracing is on. The trace host
  // returns a delta keyed off the caller's existing env so NODE_OPTIONS
  // gets appended rather than replaced.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (runner.traceHost !== null) {
    const traceEnv = runner.traceHost.envVars(process.env);
    for (const [k, v] of Object.entries(traceEnv)) {
      childEnv[k] = v;
    }
    log('claude-code: trace host armed', {
      proxy: runner.traceHost.proxy.proxyUrl,
      caCert: runner.traceHost.caCertPath,
      unsafeTls: input.unsafeTls === true,
    });
    if (input.unsafeTls === true) {
      // Prominent, unstructured warning to the individual-contributor's terminal.
      // Structured log above feeds telemetry; this line hits stderr
      // in plain text so it can't be missed in a scrollback review.
      process.stderr.write(
        '\n' +
          '  ┌─ UNSAFE-TLS MODE ──────────────────────────────────────────┐\n' +
          '  │ --unsafe-tls enabled: NODE_TLS_REJECT_UNAUTHORIZED=0 is    │\n' +
          '  │ set on the agent child. ALL TLS validation is off for the  │\n' +
          '  │ entire agent process — not just the MITM proxy leg.        │\n' +
          '  │ Use only when claude is a packaged binary that cannot      │\n' +
          '  │ honor NODE_EXTRA_CA_CERTS. Sunset-dated.                   │\n' +
          '  └────────────────────────────────────────────────────────────┘\n\n',
      );
    }
  }

  // Auto-inject the flags that ac7's bridge-based setup fundamentally
  // depends on:
  //
  //   --dangerously-skip-permissions
  //     ac7's MCP tools (broadcast, send, objectives_*, etc.) are
  //     supposed to be callable by the agent without a permission
  //     prompt per-call — the team authority model is the access
  //     control layer, not per-tool yes/no prompts. Skipping
  //     permissions is therefore a structural requirement, not a
  //     convenience.
  //
  //   --dangerously-load-development-channels server:ac7
  //     Enables claude's `claude/channel` experimental capability
  //     against our bridge (keyed `ac7` in the written .mcp.json).
  //     Without this, the bridge declares the capability but claude
  //     ignores it and push events never reach the agent — the
  //     whole "events arrive mid-session" value prop collapses.
  //
  //   --append-system-prompt <briefing>
  //     Pins the composed team briefing (ac7 framing + team name /
  //     directive / brief, role, personal instructions, teammates,
  //     objectives primer) into claude's system prompt for the whole
  //     session. The same prose is also delivered through the MCP
  //     `instructions` channel, but `--append-system-prompt` keeps it
  //     in EVERY turn's context — survives compaction and beats the
  //     "agent forgot who it is by turn 40" failure mode. Snapshot
  //     at startup: edits to role / personal instructions / team
  //     config require an agent rerun to take effect.
  //
  // We prepend the flags unconditionally. If the caller explicitly
  // passed any of them already, we de-dup so claude doesn't see them
  // twice. User-supplied args still end up on the command line, just
  // after ours.
  const {
    injected: injectedArgs,
    summary: injectedSummary,
    final: finalClaudeArgs,
  } = computeInjectedClaudeArgs(input.claudeArgs, runner.briefing.instructions);

  // Human-readable posture banner on stderr — stdout belongs to claude.
  // The two auto-injected flags meaningfully relax claude's default
  // per-call permission behavior. Dan's 2026-04-16 audit Part-3 item #5
  // flagged this as a "posture users need to notice on turn 1" — the
  // structured JSON log on its own doesn't make that visible enough,
  // because an individual-contributor skimming a fresh session sees the TUI first
  // and structured logs look like plumbing noise.
  //
  // Emitted only when we actually injected something; if the individual-contributor
  // passed the flags themselves, no banner fires (they already know).
  if (injectedSummary.length > 0) {
    const banner =
      `\nac7: auto-injected into claude invocation (team authority is the access control):\n` +
      injectedSummary.map((f) => `    ${f}\n`).join('') +
      `      (pass either flag yourself to suppress this line)\n\n`;
    process.stderr.write(banner);
  }

  const usePty = await shouldUsePty();
  // Heads-up to the user: claude-code's ink fork blocks its first
  // render on a terminal-capability probe (kitty-keyboard + DA1)
  // whose reply never materializes under a pty relay, so nothing
  // paints until it reads a byte from stdin. Any keypress works —
  // Enter is just the least surprising. We forward the keystroke
  // through to claude's stdin so the same Enter that unblocks the
  // TUI becomes a no-op submit against the welcome prompt. Only
  // shown when we're actually taking the pty path — the
  // stdio:'inherit' fallback doesn't have this quirk.
  if (usePty) {
    process.stderr.write('ac7: press Enter to render the Claude Code TUI.\n\n');
  }

  log('claude-code: spawning claude', {
    binary: claudeBinary,
    args: finalClaudeArgs,
    injected: injectedArgs,
    cwd,
    nodeOptions: childEnv.NODE_OPTIONS,
    sslKeylogFile: childEnv.SSLKEYLOGFILE,
    transport: usePty ? 'pty' : 'inherit',
  });

  // Last-ditch teardown if the node process itself is dying — we'd
  // rather the individual-contributor's `.mcp.json` be restored on an unhandled
  // crash than leave it modified.
  const onUncaught = (err: unknown): void => {
    log('claude-code: uncaught exception', {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    try {
      mcpHandle.restore();
    } catch {
      /* ignore */
    }
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  let onSigint: () => void = () => {};
  let onSigterm: () => void = () => {};

  const exitCode = await new Promise<number>((resolvePromise) => {
    if (usePty) {
      void runPty({
        claudeBinary,
        args: finalClaudeArgs,
        cwd,
        env: childEnv,
        presence,
        label: runner.briefing.name,
        log,
        onSigintRegister: (handler) => {
          onSigint = handler;
          process.on('SIGINT', onSigint);
        },
        onSigtermRegister: (handler) => {
          onSigterm = handler;
          process.on('SIGTERM', onSigterm);
        },
        onHudReady: (close) => {
          closeHud = close;
        },
      })
        .then(resolvePromise)
        .catch((err) => {
          log('claude-code: pty run failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          resolvePromise(1);
        });
      return;
    }

    // Fallback: stdio inherit. Used for tests and non-TTY contexts.
    const child = spawn(claudeBinary, finalClaudeArgs, {
      cwd,
      stdio: 'inherit',
      env: childEnv,
    });

    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      }
    };
    onSigint = (): void => forwardSignal('SIGINT');
    onSigterm = (): void => forwardSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.on('exit', (code, signal) => {
      const resolved = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0);
      resolvePromise(resolved);
    });
    child.on('error', (err) => {
      log('claude-code: failed to spawn claude', {
        error: err instanceof Error ? err.message : String(err),
      });
      resolvePromise(1);
    });
  });

  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);

  await teardown(`claude-exited-${exitCode}`);
  return exitCode;
}

/**
 * Map a signal name to its conventional exit-code offset. Claude
 * dying by SIGTERM should surface as `143` (128 + 15), not `0`.
 * Keeps the offsets small and correct for the signals we actually
 * forward; unknown signals fall back to `null` and we treat the
 * exit as a plain `0` rather than guessing.
 */
function signalNumber(signal: NodeJS.Signals): number | null {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    case 'SIGHUP':
      return 1;
    case 'SIGQUIT':
      return 3;
    default:
      return null;
  }
}

interface RunPtyOptions {
  claudeBinary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  presence: ReturnType<typeof createPresence>;
  label: string;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  onSigintRegister: (handler: () => void) => void;
  onSigtermRegister: (handler: () => void) => void;
  onHudReady: (close: () => void) => void;
}

/**
 * Spawn claude via node-pty, relaying stdin/stdout and reserving the
 * bottom `HUD_HEIGHT` rows for the ac7 status strip. Resolves with
 * the child's exit code.
 *
 * Key mechanics:
 *
 *   - The pty we give claude reports `rows - HUD_HEIGHT` via
 *     TIOCGWINSZ, so claude's ink renderer never paints into our
 *     panel rows. We still redraw the HUD after every chunk because
 *     claude's initial alt-screen entry issues `CSI 2J` which wipes
 *     the entire screen buffer, including our strip.
 *
 *   - SIGWINCH on the parent recalculates size and issues
 *     `pty.resize(cols, rows - HUD_HEIGHT)`. Claude picks up the new
 *     dims on its next render tick.
 *
 *   - We import `node-pty` lazily so the rest of the CLI (push,
 *     roster, setup, etc.) can run on systems where the native
 *     prebuild didn't install cleanly. Only this verb needs it.
 */
async function runPty(opts: RunPtyOptions): Promise<number> {
  const pty = await import('node-pty');

  const getSize = (): { rows: number; cols: number } => ({
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  });

  const { rows: realRows, cols: realCols } = getSize();
  const ptyRows = Math.max(4, realRows - HUD_HEIGHT);
  const ptyCols = realCols;

  const term = pty.spawn(opts.claudeBinary, opts.args, {
    name: opts.env.TERM ?? 'xterm-256color',
    cwd: opts.cwd,
    env: opts.env as { [key: string]: string },
    cols: ptyCols,
    rows: ptyRows,
  });

  const hud = startHud({
    presence: opts.presence,
    label: opts.label,
  });
  opts.onHudReady(hud.close);

  // Forward pty output → stdout, re-painting the HUD after every
  // chunk so `CSI 2J` / repaints from claude don't leave the panel
  // stale.
  term.onData((data) => {
    process.stdout.write(data);
    hud.redraw();
  });

  // Raw mode on stdin so individual keystrokes (arrow keys, Ctrl-C,
  // etc.) reach claude without the parent's line discipline eating
  // them. Restore cooked mode on exit. We attach the 'data' listener
  // BEFORE calling resume(): if the terminal sends a response to a
  // capability query claude fired during mount (DSR, DA, etc.),
  // attaching late risks the response being emitted into a void
  // and claude hanging on its own handshake.
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const forwardInput = (data: Buffer | string): void => {
    try {
      term.write(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      /* term may have exited */
    }
  };
  stdin.on('data', forwardInput);
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(true);
    } catch {
      /* some TTYs (e.g. some CI runners) don't support raw mode */
    }
  }
  stdin.resume();

  const onResize = (): void => {
    const { rows, cols } = getSize();
    try {
      term.resize(cols, Math.max(4, rows - HUD_HEIGHT));
    } catch {
      /* ignore race with pty exit */
    }
    hud.redraw();
  };
  process.stdout.on('resize', onResize);

  opts.onSigintRegister(() => {
    try {
      term.kill('SIGINT');
    } catch {
      /* ignore */
    }
  });
  opts.onSigtermRegister(() => {
    try {
      term.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  });

  const exitCode = await new Promise<number>((resolvePromise) => {
    term.onExit(({ exitCode: code, signal }) => {
      const resolved = code ?? (signal ? 128 + signal : 0);
      resolvePromise(resolved);
    });
  });

  // Stop forwarding stdin and restore cooked mode so the user's
  // shell doesn't inherit raw-mode terminal state after we exit.
  stdin.off('data', forwardInput);
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(wasRaw ?? false);
    } catch {
      /* ignore */
    }
  }
  stdin.pause();
  process.stdout.off('resize', onResize);
  hud.close();

  return exitCode;
}
