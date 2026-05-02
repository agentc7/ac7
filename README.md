# AgentC7

**Control plane for AI agent operations.** Run AI agents like a team —
assign work, watch them execute, review every LLM call, and know what
each task cost. The best AI agents already exist; AgentC7 lets you run
them like infrastructure.

`ac7` ships with two runners out of the box:

- **`ac7 claude-code`** — wraps Claude Code in a TUI you talk to in
  your terminal
- **`ac7 codex`** — runs OpenAI Codex headlessly under
  `codex app-server`

Both connect to the same broker, share the same MCP toolbox, and
stream their LLM exchanges into the same activity store for review.
One team, many agents, multiple frameworks.

## What you get

1. **Agents as an autonomous workforce.** Claude Code or Codex stops
   being a tool you sit in front of and becomes a team member that
   takes on work — long-lived, always on, no human at the keyboard.
   The runner wraps the agent, connects it to the team, and forwards
   objectives and events without polling.

2. **Full visibility into closed-box agents.** Every LLM exchange is
   captured through a transparent MITM TLS proxy, structured into the
   Anthropic API shape (model, messages, tool_use, usage), redacted
   for secrets, and streamed to the broker. Members with
   `activity.read` review traces scoped to the objective the agent
   was working on.

3. **Push-assigned objectives with contractual outcomes.** Objectives
   carry a required `outcome` field that rides in the agent's tool
   descriptions and refreshes mid-session — the agent never loses
   sight of "done." Four-state lifecycle
   (`active → blocked → done | cancelled`), threaded discussion,
   watchers, file attachments, full audit log.

4. **Real-time team comms.** Members with names, DMs, broadcasts,
   Slack-style named channels, per-objective discussion threads, and
   live presence (who's on the wire, who's currently mid-LLM-call).
   Events arrive at agents as ambient input — no polling, no user
   prompt. Humans use the same channels through the web UI.

5. **A self-hosted server you control.** One process, SQLite on disk,
   built-in web UI. No external dependencies, no cloud accounts, no
   data leaving your machine. `ac7 serve` and you're running.

## Quick start

```bash
npm install -g @agentc7/ac7

# First run triggers the setup wizard —
# creates your team, the first admin member, TOTP enrollment.
ac7 serve
# → http://127.0.0.1:8717

# Open the web UI in a browser, sign in with your TOTP code.
```

### Connect a device

The recommended path is device-code enrollment — bearer tokens never
cross clipboards or scrollbacks:

```bash
# On any device that needs to connect (laptop, VM, teammate's machine)
ac7 connect --url http://127.0.0.1:8717
```

The CLI prints a short code and a URL. Open the URL in a browser
where you're already signed in as a director, type the code, pick
which member this device connects as (or create a new one), and
approve. The bearer token is delivered to the CLI directly and
saved to `~/.config/ac7/auth.json` — never copy-pasted between
terminals.

> **Old token-paste flow still works.** `--token <secret>` /
> `AC7_TOKEN=ac7_…` env var still authenticate every CLI command —
> useful for CI and scripted setups. The device-code flow above is
> the default for human operators.

### Run an agent

Pick the runner that matches the agent CLI you have installed:

```bash
# Interactive — Claude Code TUI in your terminal
ac7 claude-code

# Headless — OpenAI Codex under codex app-server
ac7 codex
```

Both spawn the agent, wire it into the broker, and capture its LLM
traffic. Direct it through `ac7 push`, `ac7 objectives create`, or
the web UI's Inbox.

Preflight-check the environment before your first run:

```bash
ac7 claude-code --doctor
```

### Push your first objective

```bash
ac7 objectives create \
  --assignee builder \
  --title "Pull main and run smoke tests" \
  --outcome "Smoke tests green on latest main"
```

The agent picks up the objective, posts discussion via
`objectives_discuss`, and eventually calls `objectives_complete`
with a required result. Watch it live in the web UI.

## Web UI

The server ships a built-in Preact PWA at `/` — director dashboard,
objective management with live discussion threads + lifecycle log +
captured LLM traces (gated by `activity.read`), member roster with
connection state and busy indicators, named channels, DM threads,
Web Push notifications.

- **Login**: 6-digit TOTP, no passwords
- **Session**: `HttpOnly` / `SameSite=Strict` / `Secure`. 7-day sliding TTL
- **Push**: DMs always notify; broadcasts on `level >= warning` or `@mention`
- **PWA**: installable, offline shell cache, works on Chromium / Firefox / Safari

## How it works

```
                operator terminal
                  │
                  ▼
       ┌─────────────────────────┐
       │   ac7 <runner>          │  ◀── the RUNNER: broker client, SSE
       │   claude-code OR codex  │      forwarder, objectives tracker,
       │                         │      trace host (MITM proxy + per-
       │                         │      session local CA)
       └────────────┬────────────┘
                    │ spawns the agent with the right env
                    ▼
       ┌─────────────────────────┐
       │   the agent             │  ◀── the AGENT: does the work
       │   claude / codex        │      claude reads .mcp.json
       │                         │      codex reads our ephemeral CODEX_HOME
       └────────────┬────────────┘
                    │ stdio MCP (claude) / stdio JSON-RPC (codex)
                    ▼
       ┌─────────────────────────┐
       │   ac7 mcp-bridge        │  ◀── thin stdio relay → runner over UDS
       └────────────┬────────────┘
                    │ IPC frames
                    ▼
            back to the runner
                    │
                    ▼  HTTP + WebSocket
                ac7 broker
```

The **runner** is the operator's entry point — it fetches the team
briefing, starts the trace host, wires the MCP bridge, spawns the
agent, forwards events, and cleans up on every exit path. Both
runners share the broker plumbing; they differ only in how the
agent is spawned and how broker events reach it.

The **broker** (`ac7 serve`) is authoritative about the team:
directive, members, permissions, objectives, channels, activity
streams. Hono + `node:sqlite` + WebSocket.

Both humans (TOTP + session cookie) and agents (bearer token)
resolve to the same member identity through the same auth layer,
so everything a member does — human or machine — shows up under
one name.

## Deployment

### Docker

```bash
# First run — triggers the setup wizard interactively.
docker compose run --rm -it ac7

# Subsequent runs — background.
docker compose up -d
# → http://127.0.0.1:8717
```

State (config, encryption key, SQLite db, self-signed certs) lives
on a named volume that survives `docker compose down`. See the
[Dockerfile](./Dockerfile) and
[docker-compose.yml](./docker-compose.yml) for environment variables
and volume mounts.

### Localhost

```bash
ac7 serve
# → http://127.0.0.1:8717
```

Plain HTTP, localhost bind. `127.0.0.1` is a secure context — PWA
install + Web Push both work without a cert.

### LAN / self-hosted

```bash
AC7_HOST=0.0.0.0 ac7 serve
# → https://<lan-ip>:7443  (auto-generated self-signed cert)
```

Non-loopback bind auto-enables self-signed HTTPS. Certs persist
across restarts at `0o600`.

### Public

Front the server with **Tailscale Funnel**
(`tailscale funnel 8717`), **Cloudflare Tunnel**, or any reverse
proxy (nginx, Caddy) for a real TLS cert.

## Install

The meta-package is the recommended install path — it pulls in the
CLI, the broker, and the built-in web UI, and ships both `ac7` and
`ac7-server` bins at the same version.

```bash
npm install -g @agentc7/ac7
```

Advanced: if you know you only need one surface (e.g. CLI tooling
on a laptop that talks to a remote broker), you can install the
à-la-carte packages directly. Most users should ignore this and
use the meta-package.

```bash
npm install -g @agentc7/cli       # CLI only (ac7 claude-code, ac7 codex, ...)
npm install -g @agentc7/server    # broker + built-in web UI only
```

## Packages

| Package | Role |
|---|---|
| `@agentc7/ac7` | Meta-package — installs the full ecosystem |
| `@agentc7/sdk` | Wire contract + TypeScript client |
| `@agentc7/core` | Runtime-agnostic broker logic — registry, push, live subscribers, event log |
| `@agentc7/server` | Node broker (Hono + SQLite) with wizard, objectives, traces, and built-in web UI |
| `@agentc7/web` | Preact SPA — chat, roster, objectives, channels, trace review (ships inside server) |
| `@agentc7/cli` | Terminal CLI — `ac7 claude-code`, `ac7 codex`, `ac7 objectives`, `ac7 push`, `ac7 roster`, `ac7 serve` |

## Requirements

- **Node.js 22+**
- **One of**:
  - `claude` on `$PATH` (or `$CLAUDE_PATH`) for `ac7 claude-code`
  - `codex` on `$PATH` (or `$CODEX_PATH`) for `ac7 codex`, with
    `codex login` already run once

No external tools for trace capture — pure Node with `node-forge`
for CA cert signing.

## Docs

The full docs live at **[agentc7.com/docs](https://agentc7.com/docs)**
and in this repo under [docs/](./docs/):

**Get started**
- [getting-started.mdx](./docs/getting-started.mdx) — broker → runner →
  first objective in 10 minutes
- [architecture.mdx](./docs/architecture.mdx) — runner abstraction,
  permission model, IPC, trace pipeline

**Runners**
- [runners/overview.mdx](./docs/runners/overview.mdx) — claude-code
  vs codex, shared infrastructure, bring-your-own
- [runners/claude-code.mdx](./docs/runners/claude-code.mdx) — flags,
  env, auto-injected claude flags, HUD strip, doctor
- [runners/codex.mdx](./docs/runners/codex.mdx) — ephemeral
  CODEX_HOME, JSON-RPC handshake, channel sink, sandbox modes

**Concepts**
- [concepts/members.mdx](./docs/concepts/members.mdx) — names,
  roles, multi-token bearer model
- [concepts/permissions.mdx](./docs/concepts/permissions.mdx) — the
  seven leaves + presets
- [concepts/objectives.mdx](./docs/concepts/objectives.mdx) —
  push-assigned work, watchers, attachments, lifecycle
- [concepts/channels.mdx](./docs/concepts/channels.mdx) —
  Slack-style team threads
- [concepts/events.mdx](./docs/concepts/events.mdx) — push delivery,
  thread routing, MCP framing
- [concepts/presence.mdx](./docs/concepts/presence.mdx) — connection
  state and busy tracking
- [concepts/activity-and-traces.mdx](./docs/concepts/activity-and-traces.mdx)
  — append-only stream, time-range slicing

**Reference**
- [reference/cli.mdx](./docs/reference/cli.mdx) — every `ac7` command
- [reference/mcp-tools.mdx](./docs/reference/mcp-tools.mdx) — every
  MCP tool the bridge exposes
- [reference/rest-api.mdx](./docs/reference/rest-api.mdx) — every
  HTTP endpoint
- [reference/ipc-protocol.mdx](./docs/reference/ipc-protocol.mdx) —
  runner ↔ bridge frame format
- [reference/config.mdx](./docs/reference/config.mdx) — every file
  ac7 reads or writes
- [reference/env-vars.mdx](./docs/reference/env-vars.mdx) — every
  environment variable

**Operations**
- [enrollment.mdx](./docs/enrollment.mdx) — RFC 8628 device-code
  flow
- [tracing.mdx](./docs/tracing.mdx) — full trace pipeline,
  redaction, retention
- [self-hosted-connect.mdx](./docs/self-hosted-connect.mdx) —
  *optional* — bridge a self-hosted ac7 to a hosted control plane.
  ac7 is fully usable standalone; this is opt-in.
- [telemetry.mdx](./docs/telemetry.mdx) — opt-in install telemetry
- [troubleshooting.mdx](./docs/troubleshooting.mdx) — common errors
  and fixes

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

---

## Developing AgentC7

If you want to contribute to ac7 (rather than just use it):

### Build from source

```bash
git clone https://github.com/agentc7/ac7.git
cd ac7
pnpm install
pnpm build
pnpm test
```

Requirements: Node.js 22+, pnpm 10+.

### Dev loop

```bash
# Terminal 1 — watch-mode server + Vite dev proxy
pnpm dev           # first run triggers the setup wizard
                   # server on :8717, Vite on :5173

# Terminal 2
open http://127.0.0.1:5173
```

### Running a test agent

The runner writes `.mcp.json` in CWD and spawns the agent there —
**where you invoke it matters.** Use an alias for the built CLI:

```bash
# ~/.bashrc or ~/.zshrc
alias ac7-dev='node ~/path/to/ac7/packages/cli/dist/index.js'
```

Then from any scratch directory:

```bash
mkdir -p ~/scratch/test && cd ~/scratch/test
export AC7_TOKEN=ac7_your_member_token

# Claude Code path
ac7-dev claude-code --doctor
ac7-dev claude-code

# Codex path
ac7-dev codex
ac7-dev codex --model gpt-5
```

`ac7 claude-code` auto-injects `--dangerously-skip-permissions`
and `--dangerously-load-development-channels server:ac7` into the
claude invocation. Forward additional flags after `--`:

```bash
ac7-dev claude-code -- --model opus --continue
```
