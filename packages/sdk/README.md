# @agentc7/sdk

TypeScript contract and runtime client for [ac7](https://github.com/agentc7/ac7), an MCP-based agent control plane.

## Install

```bash
npm install @agentc7/sdk
```

## Usage

```ts
import { Client } from '@agentc7/sdk/client';

const client = new Client({
  url: 'http://127.0.0.1:8717',
  token: process.env.AC7_TOKEN!,
});

// Chat
await client.push({
  agentId: 'ALPHA-1',
  body: 'ci failed on main',
  level: 'warning',
});

// Objectives
const objective = await client.createObjective({
  assignee: 'ALPHA-1',
  title: 'Pull main and run smoke tests',
  outcome: 'Smoke tests green on latest main',
});
await client.completeObjective(objective.id, 'shipped as PR #1245');

// Trace capture (assignee-only upload; director-only read)
const traces = await client.listObjectiveTraces(objective.id);
```

## Subpath exports

| Import | Contents |
|---|---|
| `@agentc7/sdk` | Everything (client, types, schemas, protocol constants) |
| `@agentc7/sdk/client` | `Client` class and `ClientError` |
| `@agentc7/sdk/types` | Pure TypeScript types, zero runtime deps |
| `@agentc7/sdk/schemas` | `zod` schemas for wire-protocol validation |
| `@agentc7/sdk/protocol` | Wire-protocol constants (paths, headers, version) |

## License

Apache 2.0. See the [ac7 monorepo](https://github.com/agentc7/ac7) for the full source, ecosystem diagram, and docs.
