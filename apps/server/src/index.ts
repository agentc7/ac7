/**
 * `@agentc7/server` — CLI entry for the self-hosted broker.
 *
 * Thin wrapper around `runServer()` that reads config from env/argv,
 * loads the team config file (or drops into the first-run wizard
 * if the file is missing and stdin is a TTY), wires shutdown handlers,
 * and prints a startup banner. Import `runServer` directly if you
 * want to embed the broker in another Node process.
 */

import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, ENV } from '@agentc7/sdk/protocol';
import { KekResolutionError, resolveKek } from './kek.js';
import { logger } from './logger.js';
import {
  ConfigNotFoundError,
  defaultConfigPath,
  exampleConfig,
  type HttpsConfig,
  loadTeamConfigFromFile,
  MemberLoadError,
  setKek,
  type TeamConfig,
} from './members.js';
import { type ListenInfo, runServer } from './run.js';
import { createTtyWizardIO, runFirstRunWizard } from './wizard.js';

const USAGE = `ac7-server

usage:
  ac7-server [--config-path <path>]

options:
  --config-path <path>   path to the team config file
                         (default: ./ac7.json, or $AC7_CONFIG_PATH)
  -h, --help             print this message and exit

env:
  ${ENV.port}      TCP port to listen on (default: ${DEFAULT_PORT})
  ${ENV.host}      hostname to bind (default: 127.0.0.1)
  ${ENV.dbPath}    SQLite path (default: :memory:)
  ${ENV.configPath}  config file path (overridden by --config-path)
`;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Wrap IPv6 addresses in brackets for URL display. */
function formatHost(address: string): string {
  // IPv4 and hostnames pass through; IPv6 addresses contain ':'.
  return address.includes(':') ? `[${address}]` : address;
}

function parseServerArgs(argv: string[]): { configPath?: string; help: boolean } {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        'config-path': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
    return {
      configPath: typeof values['config-path'] === 'string' ? values['config-path'] : undefined,
      help: values.help === true,
    };
  } catch (err) {
    process.stderr.write(`ac7-server: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
}

async function loadOrCreateTeamConfig(configPath: string): Promise<TeamConfig> {
  try {
    const config = loadTeamConfigFromFile(configPath);
    if (config.migrated > 0) {
      process.stdout.write(
        `ac7-server: hashed ${config.migrated} plaintext token(s) in ${configPath}\n`,
      );
    }
    return config;
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      return runWizardOrFail(configPath);
    }
    if (err instanceof MemberLoadError) {
      process.stderr.write(`ac7-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function runWizardOrFail(configPath: string): Promise<TeamConfig> {
  const { io, close } = createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    process.stderr.write(
      `ac7-server: no config file at ${configPath}\n\n` +
        `stdin is not a TTY, so the first-run wizard can't prompt. Create\n` +
        `the file yourself with contents like:\n\n${exampleConfig()}\n\n` +
        `or pass --config-path to point at a file you already have.\n`,
    );
    process.exit(1);
  }
  try {
    return await runFirstRunWizard({ configPath, io });
  } catch (err) {
    if (err instanceof MemberLoadError) {
      process.stderr.write(`ac7-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  } finally {
    close();
  }
}

/**
 * Heuristic: if the bind host is neither a loopback nor a literal
 * 0.0.0.0/::, we assume the individual-contributor is trying to expose the server
 * on a LAN interface and we want HTTPS. Returns `null` for loopback
 * binds where HTTP is safe, or a non-null string (the LAN IP to use
 * as a SAN) when we should auto-flip to self-signed.
 */
function detectLanIpForSelfSign(host: string): string | null {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return null;
  if (host === '0.0.0.0' || host === '::') {
    // Bind-everything — pick the first non-loopback IPv4 interface
    // as the SAN. If we don't find one (containerized no-network
    // setups) return empty string so the caller still flips mode
    // but with no extra SAN.
    for (const iface of Object.values(networkInterfaces())) {
      for (const entry of iface ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          return entry.address;
        }
      }
    }
    return '';
  }
  // Explicit IP or hostname — treat as LAN, use it directly as SAN.
  return host;
}

async function main(): Promise<void> {
  const args = parseServerArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const port = Number(readEnv(ENV.port) ?? String(DEFAULT_PORT));
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    process.stderr.write(`ac7-server: invalid ${ENV.port}: ${readEnv(ENV.port)}\n`);
    process.exit(1);
  }

  const host = readEnv(ENV.host) ?? '127.0.0.1';
  const dbPath = readEnv(ENV.dbPath) ?? './ac7.db';
  const configPath = args.configPath ?? defaultConfigPath();

  // Install the KEK before any load / write. Required so the
  // encrypted-at-rest TOTP secrets and VAPID private key are
  // decrypted into the in-memory config (and so the wizard's first
  // write encrypts on the way out). Auto-generates a key file
  // alongside the config on first boot; subsequent boots read it.
  // Operators who manage their own key injection set AC7_KEK and
  // this call returns the env-resolved buffer instead.
  try {
    setKek(resolveKek(configPath));
  } catch (err) {
    if (err instanceof KekResolutionError) {
      process.stderr.write(`ac7-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const {
    store: members,
    team,
    https: httpsFromConfig,
    webPush,
    jwt,
  } = await loadOrCreateTeamConfig(configPath);

  // Auto-flip: if the user didn't explicitly configure HTTPS in the
  // config file AND is binding to a non-loopback interface, switch
  // from off → self-signed with an auto-detected LAN SAN. They can
  // still override by setting https.mode explicitly in the config.
  let https: HttpsConfig = httpsFromConfig;
  if (https.mode === 'off') {
    const lanIp = detectLanIpForSelfSign(host);
    if (lanIp !== null) {
      https = {
        ...https,
        mode: 'self-signed',
        selfSigned: { ...https.selfSigned, lanIp: lanIp || https.selfSigned.lanIp },
      };
      process.stdout.write(
        `ac7-server: host ${host} is non-loopback, auto-enabling self-signed HTTPS. ` +
          `Set \`https.mode\` in ${configPath} to override.\n`,
      );
    }
  }

  const running = await runServer({
    members,
    team,
    https,
    webPush,
    jwt,
    configPath,
    configDir: dirname(configPath),
    port,
    host,
    dbPath,
    onListen: (info: ListenInfo) => {
      const url = `${info.protocol}://${formatHost(info.address)}:${info.port}`;
      const lines: string[] = [`ac7-server listening on ${url}`];
      if (info.protocol === 'https' && info.cert) {
        lines.push(`  cert:    ${info.cert.source}`);
        if (info.cert.certPath) {
          lines.push(`  cert@:   ${info.cert.certPath}`);
        }
        if (info.cert.expiresAt) {
          lines.push(`  expires: ${new Date(info.cert.expiresAt).toISOString()}`);
        }
        if (info.redirectHttpPort !== undefined) {
          lines.push(`  redirect: http on :${info.redirectHttpPort} → 308 → ${url}`);
        }
      }
      lines.push(
        `  team:      ${team.name}`,
        `  directive: ${team.directive}`,
        `  config:    ${configPath}`,
        `  db:        ${dbPath}`,
        `  members:   ${members.size()} (${members.names().join(', ')})`,
      );
      process.stdout.write(`${lines.join('\n')}\n`);
    },
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info('shutting down', { signal });
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(
    `ac7-server: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
