/**
 * `@ac7/sdk` — contract and runtime client for ac7.
 *
 * The root entry point re-exports everything for convenience. Consumers
 * that only want types or schemas should import the subpath entries:
 *
 *   import type { Agent, Message } from '@ac7/sdk/types';
 *   import { PushPayloadSchema } from '@ac7/sdk/schemas';
 *   import { DEFAULT_PORT, PATHS } from '@ac7/sdk/protocol';
 *   import { Client, ClientError } from '@ac7/sdk/client';
 */

export * from './client.js';
export * from './protocol.js';
export * from './schemas.js';
export * from './types.js';
