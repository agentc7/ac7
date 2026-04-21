# @agentc7/cli

IndividualContributor CLI for [ac7](https://github.com/agentc7/ac7),
an MCP-based agent team control plane.

This package provides the `ac7` binary, which hosts the individual contributor
entry points (`ac7 claude-code`, `ac7 serve`, etc.)
plus the internal `ac7 mcp-bridge` verb that `.mcp.json` entries
point at.

## Install

```bash
npm install -g @agentc7/cli
```

Or run without installing:

```bash
npx @agentc7/cli claude-code --doctor
```

## Commands

```
ac7 setup       [--config-path <path>]                                 first-run wizard (team + first admin + TOTP)
ac7 user        list | create | update | delete [--config-path <path>]   offline user management
ac7 enroll      --user <name> [--config-path <path>]                   (re-)enroll a user for web UI login
ac7 rotate      --user <name> [--config-path <path>]                   rotate a user's bearer token
ac7 claude-code [--no-trace] [--doctor] [-- <claude args>...]          spawn claude wrapped in a ac7 runner
ac7 push        --body <text> (--agent <id> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]...
ac7 roster                                                             list teammates, userType, and connection state
ac7 objectives  list | view | create | update | complete | cancel | reassign   team objectives
ac7 serve       [--config-path <path>] [--port <n>] [--host <h>] [--db <path>]
```

### `ac7 claude-code` (the headliner)

Spawns `claude` as a child of a long-lived **runner** process. The
runner:

- Fetches `/briefing` from the broker to learn this slot's
  name, role, authority, teammates, and open objectives
- Binds a Unix domain socket and starts an IPC server
- Starts the trace host: a loopback HTTP CONNECT proxy that
  terminates TLS with a per-session CA, reassembles HTTP/1.1
  exchanges, and streams activity events to the broker in real time
- Backs up `.mcp.json` and writes one pointing at `ac7 mcp-bridge`
- Spawns claude with `HTTPS_PROXY`, `HTTP_PROXY`, and
  `NODE_EXTRA_CA_CERTS` pointing at the per-session CA
- Forwards SSE channel events from the broker into the agent as
  MCP `notifications/claude/channel`
- Restores `.mcp.json` on any exit path (normal, signal, crash)

Flags:

- `--no-trace` — disable the trace subsystem entirely. Runner still
  handles SSE, objectives, and bridge IPC.
- `--doctor` — preflight check: claude binary, `$TMPDIR` writable,
  loopback bind, per-session CA generation. Exits 0 on pass, 1 on
  any FAIL (WARN doesn't fail the exit code).
- Everything after `--` is forwarded verbatim to the `claude`
  binary.

Example:

```bash
export AC7_TOKEN=ac7_your_slot_token
ac7 claude-code --doctor
ac7 claude-code
ac7 claude-code --no-trace -- --model claude-opus-4-6
```

### `ac7 mcp-bridge` (hidden internal verb)

The stdio MCP server that claude spawns via the `.mcp.json` entry
the runner wrote. Connects to the runner's UDS path from
`$AC7_RUNNER_SOCKET` and forwards every MCP request/response +
every runner-initiated notification. Not shown in `--help`;
individual contributors never invoke it directly.

## Environment

| Variable | Purpose |
|---|---|
| `AC7_URL` | Broker base URL (default `http://127.0.0.1:8717`) |
| `AC7_TOKEN` | Slot bearer token — required for `claude-code`, `push`, `roster`, `objectives` |
| `CLAUDE_PATH` | Override the claude binary path (otherwise `which claude`) |
| `AC7_RUNNER_SOCKET` | Set by the runner on the bridge's env; individual contributors never set this |

## Quick start

```bash
# 1. Start a broker (first run triggers the team setup wizard)
ac7 serve

# 2. In another terminal, set your user's bearer token
export AC7_TOKEN=ac7_your_bearer_token

# 3. Preflight check the environment
ac7 claude-code --doctor

# 4. Wrap claude
ac7 claude-code
```

To push a one-shot chat message without spawning claude:

```bash
ac7 roster
ac7 push --agent ALPHA-1 --body "ci failed on main" --level warning
```

To manage objectives from the terminal:

```bash
ac7 objectives list --assignee ALPHA-1 --status active
ac7 objectives create --assignee ALPHA-1 --title "…" --outcome "…"
ac7 objectives complete --id obj-xxx --result "shipped as PR #1245"
```

## License

Apache 2.0. See the [ac7 monorepo](https://github.com/agentc7/ac7)
for the full source.
