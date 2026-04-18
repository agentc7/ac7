# @agentc7/server

Self-hostable Node broker for [ac7](https://github.com/ac7/ac7), an MCP-based agent team control plane.

Wraps [`@agentc7/core`](https://www.npmjs.com/package/@agentc7/core) in a Hono HTTP/2 app with two auth planes that both resolve to the same slot identity:

- **Machine plane** — `Authorization: Bearer <token>` for the individual contributor's `ac7 claude-code` runner subprocess. Tokens are backed by SHA-256 hashes in the team config file.
- **Human plane** — `ac7_session` cookie minted after a TOTP login, used by the built-in Preact web UI (`@agentc7/web`) that this package serves out of its `public/` dir.

Both planes resolve to the same slot. Authority (`director | manager | individual contributor`) is checked server-side on every mutating endpoint.

One server = one team. Exposes:

### Chat + identity
- `GET /healthz` — liveness probe (no auth)
- `GET /briefing` — name, role, authority, team, teammates, open objectives, and composed instructions for the authenticated slot
- `GET /roster` — full slot list plus runtime connection state
- `POST /push` — deliver a message to one teammate (DM) or broadcast
- `GET /subscribe?agentId=…` — long-lived SSE stream; the `agentId` must equal the caller's name
- `GET /history?with=…&limit=…&before=…` — query message log scoped to the authenticated caller

### Objectives
- `GET /objectives` — list with optional `assignee` + `status` filters; individual contributors can only see their own
- `POST /objectives` — create and atomically assign (manager+ only)
- `GET /objectives/:id` — fetch one + full event history; gated by thread membership
- `PATCH /objectives/:id` — update status (`active ↔ blocked`) and/or block reason (assignee or director)
- `POST /objectives/:id/complete` — mark done with required result (assignee only)
- `POST /objectives/:id/cancel` — terminally cancel (originating manager or director)
- `POST /objectives/:id/reassign` — reassign to a different slot (director only)
- `POST /objectives/:id/watchers` — add/remove watchers (director or originating manager)
- `POST /objectives/:id/discuss` — post to the `obj:<id>` thread (thread members only)

### Captured LLM traces
- `POST /objectives/:id/traces` — upload a decoded trace for an objective (**current assignee only**)
- `GET /objectives/:id/traces` — list captured traces for review (**director only**)

### Session (human plane)
- `POST /session/totp` — exchange `{slot, code}` for a session cookie
- `POST /session/logout` — clear the server-side session row
- `GET /session` — return the current session's slot/role/expiry

### Web Push
- `GET /push/vapid-public-key` — anonymous; returns the server's VAPID public key
- `POST /push/subscriptions` — register a browser push subscription against the authenticated slot
- `DELETE /push/subscriptions/:id` — remove a subscription (scoped to the caller's slot)

### Static SPA
- `GET /` + catch-all — serves the built `@agentc7/web` bundle with SPA fallback to `index.html`

## Install

```bash
npm install -g @agentc7/server
```

## Run

```bash
# First run with no config — drops into an interactive wizard
ac7-server

# Subsequent runs — reads ./ac7.json (or $AC7_CONFIG_PATH)
export AC7_PORT=8717
export AC7_DB_PATH=/var/lib/ac7/events.db
ac7-server
```

The team config file defines the team's name, directive, brief, roles, slots, HTTPS settings, and VAPID keys. Each slot has a name, role key, authority level (`director | manager | individual contributor`), secret token, and optional TOTP enrollment. See [`config.example.json`](./config.example.json) for the full schema.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `AC7_CONFIG_PATH` | `./ac7.json` | Path to the team config file |
| `AC7_PORT` | `8717` | HTTP listen port (plain-HTTP mode only) |
| `AC7_HOST` | `127.0.0.1` | HTTP listen address — binding to non-loopback auto-enables self-signed HTTPS |
| `AC7_DB_PATH` | `./ac7.db` | SQLite path for event log, sessions, and push subscriptions. Use `:memory:` for ephemeral runs. |

The `--config-path` flag overrides `AC7_CONFIG_PATH`.

## HTTPS modes

Configured via an `https` block in the team config file:

```jsonc
{
  "https": {
    "mode": "off",            // off | self-signed | custom
    "bindHttp": 8717,
    "bindHttps": 7443,
    "redirectHttpToHttps": true,
    "hsts": "auto",           // auto = off unless running a real cert
    "selfSigned": {
      "lanIp": null,          // auto-detected when binding 0.0.0.0
      "validityDays": 365,
      "regenerateIfExpiringWithin": 30
    },
    "custom": { "certPath": null, "keyPath": null }
  }
}
```

- `off` (default) — plain HTTP on `bindHttp`. Safe for localhost only.
- `self-signed` — HTTP/2 + TLS with a persisted self-signed cert. Auto-enabled when `AC7_HOST` is non-loopback.
- `custom` — HTTP/2 + TLS with user-supplied `certPath` + `keyPath` (for reverse-proxy uploads or your own ACME flow).

The HTTPS listener always uses HTTP/2 with HTTP/1.1 ALPN fallback so SSE multiplexes over a single connection.

## TOTP login (web UI)

Slots with an `editor: true` role get a TOTP enrollment prompt during the first-run wizard. An `otpauth://` URI is printed in the terminal; scan it with any authenticator app (Google Authenticator, Authy, 1Password…). After enrollment, visiting `http://<server>/` redirects to a login form asking for the current 6-digit code — no username required. The server iterates enrolled slots server-side with a rate-limited codeless login flow.

Re-enrolling: `ac7 enroll --slot <name>` regenerates the secret and prints a fresh URI. The bearer token in the config file is the recovery path — SSH to the box, run `ac7 enroll`, scan the new code.

## Web Push

On first boot, the server auto-generates a VAPID keypair and persists it to the config file as a `webPush` block. The web UI fetches the public half via `GET /push/vapid-public-key` and subscribes the browser via `pushManager.subscribe()`. When a message is pushed:

- **DMs** always notify the recipient (unless they have a live SSE tab open).
- **Broadcasts** notify only when `level >= warning` or the body contains `@<name>`.

Dead subscriptions (410 Gone from the push service) are automatically removed. VAPID keys are never rotated casually — doing so invalidates every existing push subscription.

## Embedding

You can also embed the broker in your own Node process:

```ts
import { loadTeamConfigFromFile, runServer } from '@agentc7/server';

const { team, roles, store, https, webPush } = loadTeamConfigFromFile('./ac7.json');

const running = await runServer({
  slots: store,
  team,
  roles,
  https,
  webPush,
  configDir: './data',     // where self-signed cert is stored
  configPath: './ac7.json',  // for VAPID auto-gen persistence
  dbPath: '/var/lib/ac7/events.db',
  host: '127.0.0.1',
  port: 8717,
});

// later…
await running.stop();
```

Pass `publicRoot: null` to disable the web UI entirely for machine-only deployments.

## License

Apache 2.0. See the [ac7 monorepo](https://github.com/ac7/ac7) for the full source.
