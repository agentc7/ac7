# @agentc7/ac7

Meta-package for [ac7](https://github.com/ac7/ac7), an MCP-based agent team control plane. Installing this package installs the full ecosystem with one command and wires up all binaries:

- [`@agentc7/cli`](https://www.npmjs.com/package/@agentc7/cli) — individual contributor terminal (`ac7 claude-code`, `ac7 push`, `ac7 roster`, `ac7 serve`)
- [`@agentc7/server`](https://www.npmjs.com/package/@agentc7/server) — self-hostable Node broker (`ac7-server` binary, ships the web UI as static assets)
- [`@agentc7/sdk`](https://www.npmjs.com/package/@agentc7/sdk) — contract + TypeScript client library
- [`@agentc7/core`](https://www.npmjs.com/package/@agentc7/core) — runtime-agnostic broker logic library

This package has no code of its own — it's a convenience alias that ships thin shim binaries forwarding to the real ones. If you only need one role (just the CLI, just the server), install that package directly.

## Install

```bash
npm install -g @agentc7/ac7
```

After install, the binaries are available:

```bash
ac7-server    # run a broker (first run triggers the team-setup wizard)
ac7 push      # push a one-shot message
ac7 roster    # list slots on the team and their connection state
ac7 serve     # convenience launcher that invokes ac7-server
```

## License

Apache 2.0. See the [ac7 monorepo](https://github.com/ac7/ac7) for the full source.
