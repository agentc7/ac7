/**
 * `ac7 serve` — start a local ac7 broker.
 *
 * Thin launcher. `@agentc7/server` is an *optional* peer dependency
 * of the CLI so that users who only ever push events don't drag in
 * Hono, node:sqlite, and the MCP server SDK. When the user invokes
 * `ac7 serve`, we dynamically import the server at runtime. If it
 * isn't installed, we exit with a friendly hint.
 *
 * Auth comes from a JSON team config file. The CLI forwards the
 * resolved path to the server module; on a missing file we drop into
 * the same first-run wizard `ac7-server` uses, so the two entry points
 * stay consistent.
 */

import { dirname } from 'node:path';
import { DEFAULT_PORT, ENV } from '@agentc7/sdk/protocol';

// Type-only import: compiles away, never loaded at runtime.
import type { RunningServer, RunServerOptions, TeamConfig } from '@agentc7/server';
import { UsageError } from './errors.js';

export { UsageError };

export interface ServeCommandInput {
  configPath?: string;
  port?: number;
  host?: string;
  dbPath?: string;
}

/**
 * Translate `ac7 serve` inputs + a loaded TeamConfig into the options
 * bag that `runServer` expects. Pure — no I/O — so the seam between
 * the CLI and the server is unit-testable.
 *
 * Threading every relevant TeamConfig field through is critical: the
 * server's `runServer` makes the `persistMembers` hook (the one that
 * rewrites the on-disk team config after every member mutation) only
 * when `configPath` is supplied. Drop `configPath` and every member-
 * mutation endpoint short-circuits with 501 — including the
 * "create-new-member" branch of `/enroll/approve`, which is the path
 * the web UI's enrollment-approval flow hits. The same goes for
 * `https`, `webPush`, and `jwt`: missing fields silently disable the
 * corresponding feature, so we forward whatever the team config has.
 */
export function buildServeRunOptions(args: {
  config: TeamConfig;
  configPath: string;
  port: number;
  host: string;
  dbPath: string;
  onListen: RunServerOptions['onListen'];
}): RunServerOptions {
  return {
    members: args.config.store,
    team: args.config.team,
    https: args.config.https,
    ...(args.config.webPush !== null ? { webPush: args.config.webPush } : {}),
    ...(args.config.jwt !== null ? { jwt: args.config.jwt } : {}),
    configPath: args.configPath,
    configDir: dirname(args.configPath),
    port: args.port,
    host: args.host,
    dbPath: args.dbPath,
    ...(args.config.files?.root !== undefined ? { filesRoot: args.config.files.root } : {}),
    ...(args.config.files?.maxFileSize !== undefined
      ? { maxFileSize: args.config.files.maxFileSize }
      : {}),
    onListen: args.onListen,
  };
}

export async function runServeCommand(
  input: ServeCommandInput,
  stdout: (line: string) => void,
): Promise<RunningServer> {
  const port = input.port ?? Number(process.env[ENV.port] ?? String(DEFAULT_PORT));
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    throw new UsageError(`serve: invalid port ${port}`);
  }
  const host = input.host ?? process.env[ENV.host] ?? '127.0.0.1';
  const dbPath = input.dbPath ?? process.env[ENV.dbPath] ?? ':memory:';

  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  const config = await loadOrCreateTeamConfig(server, configPath, stdout);

  const running = await server.runServer(
    buildServeRunOptions({
      config,
      configPath,
      port,
      host,
      dbPath,
      onListen: (info) => {
        stdout(
          `ac7-server listening on ${info.protocol}://${info.address}:${info.port}\n` +
            `  team:      ${config.team.name}\n` +
            `  directive: ${config.team.directive}\n` +
            `  config:    ${configPath}\n` +
            `  db:        ${dbPath}\n` +
            `  members:   ${config.store.size()} (${config.store.names().join(', ')})`,
        );
      },
    }),
  );

  return running;
}

async function loadOrCreateTeamConfig(
  server: typeof import('@agentc7/server'),
  configPath: string,
  stdout: (line: string) => void,
): Promise<TeamConfig> {
  // Resolve + install the KEK before loading. Auto-generates a key file
  // alongside the config on first boot; subsequent boots read the same
  // key. IndividualContributors who manage their own key injection set AC7_KEK
  // instead and this call returns the env-var-resolved buffer.
  try {
    server.setKek(server.resolveKek(configPath));
  } catch (err) {
    if (err instanceof server.KekResolutionError) {
      throw new UsageError(`serve: ${err.message}`);
    }
    throw err;
  }
  try {
    const config = server.loadTeamConfigFromFile(configPath);
    if (config.migrated > 0) {
      stdout(
        `ac7 serve: migrated ${config.migrated} plaintext field(s) in ${configPath} ` +
          '(token hashes, TOTP secrets, and/or VAPID private key)',
      );
    }
    return config;
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      return runWizardOrFail(server, configPath);
    }
    if (err instanceof server.MemberLoadError) {
      throw new UsageError(`serve: ${err.message}`);
    }
    throw err;
  }
}

async function runWizardOrFail(
  server: typeof import('@agentc7/server'),
  configPath: string,
): Promise<TeamConfig> {
  const { io, close } = server.createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    throw new UsageError(
      `serve: no config file at ${configPath}\n` +
        '  stdin is not a TTY, so the first-run wizard cannot prompt. Create\n' +
        '  the file yourself or pass --config-path to point at a file you already have.\n' +
        `  example config:\n\n${server.exampleConfig()}`,
    );
  }
  try {
    return await server.runFirstRunWizard({ configPath, io });
  } catch (err) {
    if (err instanceof server.MemberLoadError) {
      throw new UsageError(`serve: ${err.message}`);
    }
    throw err;
  } finally {
    close();
  }
}

/**
 * Dynamically resolve the full server module. If the package isn't
 * installed (it's an optional peer), throw a UsageError with install
 * instructions rather than a raw MODULE_NOT_FOUND trace.
 */
async function loadServerModule(): Promise<typeof import('@agentc7/server')> {
  try {
    return await import('@agentc7/server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'serve: @agentc7/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @agentc7/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @agentc7/ac7',
      );
    }
    throw err;
  }
}
