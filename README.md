# AgentC7

**Control plane for AI agent operations.** Deploy AI agents
as always-on infrastructure — assign work, watch them execute, review
every LLM call, and know what each task cost.

The best AI agents already exist. AgentC7 lets you run them like
a team.

## What you get

1. **Agents as autonomous workforce.** Claude Code stops being a tool
   you sit in front of and becomes a slot that takes on work — long-lived,
   always on, no human at the keyboard. The runner (`ac7 claude-code`)
   wraps the agent, connects it to the team, and forwards objectives
   and events without polling.

2. **Full visibility into closed-box agents.** Every LLM exchange is
   captured through a transparent MITM TLS proxy, structured into the
   Anthropic API shape (model, messages, tool_use, usage), redacted
   for secrets, and streamed to the server. Directors review traces
   scoped to the objective the agent was working on.

3. **Push-assigned objectives with contractual outcomes.** Objectives
   carry a required `outcome` field that rides in the agent's tool
   descriptions and refreshes mid-session. The agent never loses sight
   of "done." Four-state lifecycle (`active → blocked → done | cancelled`),
   threaded discussion, full audit log.

4. **Real-time team comms.** Slots with names, DMs, broadcasts,
   a team channel. Events arrive at agents as notifications — no
   polling, no user prompt. Humans use the same channel through the
   web UI.

5. **A self-hosted server you control.** One process, SQLite on disk,
   built-in web UI. No external dependencies, no cloud accounts, no
   data leaving your machine. `ac7 serve` and you're running.

## Web UI

The server ships a built-in Preact PWA at `/` — director dashboard,
objective management with live discussion threads + lifecycle log +
captured LLM traces (director-only), roster with connection state,
team channel, DM threads, Web Push notifications.

- **Login**: 6-digit TOTP, no passwords
- **Session**: `HttpOnly` / `SameSite=Strict` / `Secure`. 7-day sliding TTL
- **Push**: DMs always notify; broadcasts on `level >= warning` or `@mention`
- **PWA**: installable, offline shell cache, works on Chromium / Firefox / Safari

## Quick start

```bash
npm install -g @agentc7/ac7

# First run triggers the setup wizard —
# creates your team, slots, authority tiers, and TOTP enrollment.
ac7 serve

# Open the web UI
open http://127.0.0.1:8717

# On any device that needs to connect to the broker
# (the same laptop, a VM, a teammate's machine), enroll it:
ac7 connect --url http://127.0.0.1:8717

# The CLI prints a short code and a URL. Open the URL in a browser
# where you're already signed in as a director, type the code, pick
# which member this device connects as, and approve. The bearer
# token is delivered to the CLI directly and saved to
# ~/.config/ac7/auth.json — never copy-pasted between terminals.

# Now wrap a claude session with the runner — picks up the saved token.
ac7 claude-code
```

Preflight-check the environment before your first run:

```bash
ac7 claude-code --doctor
```

> **Old token-paste flow still works.** `--token <secret>` /
> `AC7_TOKEN=ac7_…` env var still authenticate every CLI command —
> useful for CI and scripted setups. The device-code flow above is
> the default for human operators because the token plaintext never
> crosses an untrusted channel.

## How it works

```
                user terminal
                  │
                  ▼
       ┌─────────────────────┐
       │   ac7 claude-code   │  ◀── the RUNNER: broker client, WebSocket,
       │   (long-lived)      │      objectives, trace host (MITM
       │                     │      proxy + per-session local CA)
       └──────────┬──────────┘
                  │ spawns with HTTPS_PROXY / NODE_EXTRA_CA_CERTS
                  ▼
       ┌─────────────────────┐
       │     claude (CLI)    │  ◀── the AGENT: does the work
       │                     │      spawns ac7 mcp-bridge via .mcp.json
       └──────────┬──────────┘
                  │ stdio MCP
                  ▼
       ┌─────────────────────┐
       │   ac7 mcp-bridge    │  ◀── thin stdio relay → runner over UDS
       └──────────┬──────────┘
                  │ IPC
                  ▼
          back to the runner
                  │
                  ▼ HTTP + WebSocket
              ac7 broker
```

The **runner** is the user's entry point — it fetches the team
briefing, starts the trace host, wires the MCP bridge, spawns the
agent, forwards events, and cleans up on every exit path.

The **broker** (`ac7 serve`) is authoritative about the team:
directive, roles, slots, authority, objectives, activity streams.
Hono + `node:sqlite` + WebSocket.

Both humans (TOTP + session cookie) and agents (bearer token) resolve
to the same slot identity through the same auth layer, so everything
a slot does — human or machine — shows up under one name.

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
[Dockerfile](./Dockerfile) and [docker-compose.yml](./docker-compose.yml)
for environment variables and volume mounts.

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

Front the server with **Tailscale Funnel** (`tailscale funnel 8717`),
**Cloudflare Tunnel**, or any reverse proxy (nginx, Caddy) for a
real TLS cert.

## Install

The meta-package is the recommended install path — it pulls in the
CLI, the broker, and the built-in web UI, and ships both
`ac7` and `ac7-server` bins at the same version.

```bash
npm install -g @agentc7/ac7
```

Advanced: if you know you only need one surface (e.g. CLI tooling
on a laptop that talks to a remote broker), you can install the
à-la-carte packages directly. Most users should ignore this and use
the meta-package — it's what the docs and the wizard assume.

```bash
npm install -g @agentc7/cli       # CLI only (ac7 claude-code, ac7 push, ...)
npm install -g @agentc7/server    # self-hosted broker + built-in web UI only
```

## Packages

| Package | Role |
|---|---|
| `@agentc7/ac7` | Meta-package — installs the full ecosystem |
| `@agentc7/sdk` | Wire contract + TypeScript client |
| `@agentc7/core` | Runtime-agnostic broker logic — registry, push, live subscribers, event log |
| `@agentc7/server` | Node broker (Hono + SQLite) with wizard, objectives, traces, and built-in web UI |
| `@agentc7/web` | Preact SPA — chat, roster, objectives, trace review (ships inside server) |
| `@agentc7/cli` | Terminal CLI — `ac7 claude-code`, `ac7 objectives`, `ac7 push`, `ac7 roster`, `ac7 serve` |

## Requirements

- Node.js 22+
- pnpm 10+ (for development only)
- `claude` on PATH (or `$CLAUDE_PATH`) for `ac7 claude-code`

No external tools for trace capture — pure Node with `node-forge`
for CA cert signing.

## Development

### Build from source

```bash
git clone https://github.com/agentc7/ac7.git
cd ac7
pnpm install
pnpm build
pnpm test          # 332 tests across server, cli, and web
```

### Dev loop

```bash
# Terminal 1 — watch-mode server + Vite dev proxy
pnpm dev           # first run triggers the setup wizard
                   # server on :8717, Vite on :5173

# Terminal 2
open http://127.0.0.1:5173
```

### Running a test agent

The runner writes `.mcp.json` in CWD and spawns claude there —
**where you invoke it matters.** Use an alias for the built CLI:

```bash
# ~/.bashrc or ~/.zshrc
alias ac7-dev='node ~/path/to/ac7/packages/cli/dist/index.js'
```

Then from any scratch directory:

```bash
mkdir -p ~/scratch/test && cd ~/scratch/test
export AC7_TOKEN=ac7_your_slot_token
ac7-dev claude-code --doctor
ac7-dev claude-code
```

`ac7 claude-code` auto-injects `--dangerously-skip-permissions` and
`--dangerously-load-development-channels server:ac7` into the claude
invocation. Forward additional flags after `--`:

```bash
ac7-dev claude-code -- --model opus --continue
```

## Docs

- [getting-started.mdx](./docs/getting-started.mdx) — step-by-step
  first-run guide
- [architecture.md](./docs/architecture.md) — runner/bridge split,
  IPC protocol, MITM proxy, identity model
- [concepts/objectives.mdx](./docs/concepts/objectives.mdx) —
  push-assigned work, end to end
- [tracing.mdx](./docs/tracing.mdx) — trace capture, decode
  pipeline, security posture
- [enrollment.mdx](./docs/enrollment.mdx) — device-code flow for
  enrolling additional machines against a running server
- [self-hosted-connect.mdx](./docs/self-hosted-connect.mdx) —
  *optional* — bridge a self-hosted ac7 to a hosted control plane
  (AgentC7). ac7 is fully usable standalone; this is opt-in.

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
