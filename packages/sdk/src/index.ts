/**
 * `@agentc7/sdk` — contract and runtime client for ac7.
 *
 * The root entry point re-exports everything for convenience. Consumers
 * that only want types or schemas should import the subpath entries:
 *
 *   import type { Agent, Message } from '@agentc7/sdk/types';
 *   import { PushPayloadSchema } from '@agentc7/sdk/schemas';
 *   import { DEFAULT_PORT, PATHS } from '@agentc7/sdk/protocol';
 *   import { Client, ClientError } from '@agentc7/sdk/client';
 */

export * from './client.js';
export * from './protocol.js';
export * from './schemas.js';
export * from './types.js';
