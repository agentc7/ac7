/**
 * `ac7 user` — offline user management from the terminal.
 *
 * Subcommands:
 *   ac7 user list   [--config-path <path>]
 *   ac7 user create --name <n> --user-type <t> [--role <r>] [--config-path <path>]
 *   ac7 user update --name <n> [--user-type <t>] [--role <r>] [--config-path <path>]
 *   ac7 user delete --name <n> [--config-path <path>]
 *
 * These commands edit the team config file directly (atomic rewrite at
 * 0o600) rather than going through the HTTP `/users` API, so they work
 * without a running broker — the same posture as `ac7 setup`, `ac7
 * rotate`, and `ac7 enroll`. If the broker is running, it picks up the
 * changes on the next restart (the in-memory store is hydrated from
 * the file at boot).
 *
 * `create` prints the plaintext bearer token exactly once; it is never
 * persisted anywhere else. To (re-)enroll a user for web UI login, run
 * `ac7 enroll --user <name>` afterwards.
 */

import { parseArgs } from 'node:util';
import { ENV } from '@agentc7/sdk/protocol';
import { UsageError } from './errors.js';

const USER_TYPES = ['admin', 'operator', 'lead-agent', 'agent'] as const;
type CliUserType = (typeof USER_TYPES)[number];

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export interface UserCommandInput {
  configPath?: string;
}

export async function runUserCommand(
  args: string[],
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError('user subcommand required. Use: list | create | update | delete');
  }
  switch (sub) {
    case 'list':
      await runList(rest, stdout);
      return;
    case 'create':
      await runCreate(rest, stdout);
      return;
    case 'update':
      await runUpdate(rest, stdout);
      return;
    case 'delete':
    case 'remove':
      await runDelete(rest, stdout);
      return;
    default:
      throw new UsageError(`unknown user subcommand: ${sub}`);
  }
}

// ── subcommands ────────────────────────────────────────────────────

async function runList(args: string[], stdout: (line: string) => void): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'config-path': { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  });
  const server = await loadServerModule();
  const configPath = resolveConfigPath(values, server);
  const config = await loadConfig(server, configPath, 'list');

  const users = config.store.slots();
  if (users.length === 0) {
    stdout('(no users)');
    return;
  }
  const header = `${'name'.padEnd(20)}${'userType'.padEnd(14)}${'role'.padEnd(14)}totp`;
  stdout(header);
  for (const u of users) {
    const totp = u.totpSecret ? 'enrolled' : '—';
    stdout(`${u.name.padEnd(20)}${u.userType.padEnd(14)}${u.role.padEnd(14)}${totp}`);
  }
}

async function runCreate(args: string[], stdout: (line: string) => void): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      'user-type': { type: 'string' },
      role: { type: 'string' },
      'config-path': { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  });
  const name = stringOrUndef(values.name);
  const userTypeRaw = stringOrUndef(values['user-type']);
  const role = stringOrUndef(values.role) ?? inferDefaultRole(userTypeRaw);

  if (!name) throw new UsageError('user create: --name <name> is required');
  if (!NAME_REGEX.test(name)) {
    throw new UsageError(
      `user create: invalid --name '${name}' (must be alphanumeric with . _ - allowed)`,
    );
  }
  if (!userTypeRaw) {
    throw new UsageError(`user create: --user-type <${USER_TYPES.join('|')}> is required`);
  }
  const userType = assertUserType(userTypeRaw);
  if (!NAME_REGEX.test(role)) {
    throw new UsageError(
      `user create: invalid --role '${role}' (must be alphanumeric with . _ - allowed)`,
    );
  }

  const server = await loadServerModule();
  const configPath = resolveConfigPath(values, server);
  const config = await loadConfig(server, configPath, 'create');

  if (config.store.findByName(name)) {
    throw new UsageError(`user create: a user named '${name}' already exists in ${configPath}`);
  }
  if (!Object.hasOwn(config.roles, role)) {
    throw new UsageError(
      `user create: unknown role '${role}' in ${configPath}\n` +
        `  known roles: ${Object.keys(config.roles).join(', ') || '(none)'}`,
    );
  }

  const token = server.generateUserToken();
  config.store.addUser({ name, role, userType, token });
  server.persistUserStore(
    configPath,
    config.team,
    config.roles,
    config.store,
    config.https,
    config.webPush,
  );

  stdout('');
  stdout(`✓ created user '${name}' (${userType}, role=${role})`);
  stdout(`  config: ${configPath}`);
  stdout('');
  stdout('  ┌─ BEARER TOKEN — save this now; it is not persisted anywhere else ─┐');
  stdout(`  │ ${token}`);
  stdout('  └────────────────────────────────────────────────────────────────────┘');
  stdout('');
  if (userType === 'admin' || userType === 'operator') {
    stdout(`  To enable web UI login, run: ac7 enroll --user ${name}`);
    stdout('');
  }
}

async function runUpdate(args: string[], stdout: (line: string) => void): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      'user-type': { type: 'string' },
      role: { type: 'string' },
      'config-path': { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  });
  const name = stringOrUndef(values.name);
  const userTypeRaw = stringOrUndef(values['user-type']);
  const role = stringOrUndef(values.role);

  if (!name) throw new UsageError('user update: --name <name> is required');
  if (userTypeRaw === undefined && role === undefined) {
    throw new UsageError('user update: at least one of --user-type or --role is required');
  }
  const userType = userTypeRaw !== undefined ? assertUserType(userTypeRaw) : undefined;
  if (role !== undefined && !NAME_REGEX.test(role)) {
    throw new UsageError(
      `user update: invalid --role '${role}' (must be alphanumeric with . _ - allowed)`,
    );
  }

  const server = await loadServerModule();
  const configPath = resolveConfigPath(values, server);
  const config = await loadConfig(server, configPath, 'update');

  const existing = config.store.findByName(name);
  if (!existing) {
    const known = config.store.names().join(', ');
    throw new UsageError(
      `user update: no user with name '${name}' in ${configPath}\n` +
        `  known names: ${known || '(none)'}`,
    );
  }
  if (role !== undefined && !Object.hasOwn(config.roles, role)) {
    throw new UsageError(
      `user update: unknown role '${role}' in ${configPath}\n` +
        `  known roles: ${Object.keys(config.roles).join(', ') || '(none)'}`,
    );
  }

  // Last-admin protection: demoting the last admin would leave nobody
  // able to manage users. Block it with a useful message.
  if (userType !== undefined && userType !== 'admin' && existing.userType === 'admin') {
    const adminCount = config.store.slots().filter((u) => u.userType === 'admin').length;
    if (adminCount <= 1) {
      throw new UsageError(
        `user update: refusing to demote the last admin ('${name}').\n` +
          '  Promote another user to admin first, then retry.',
      );
    }
  }

  const patch: { role?: string; userType?: CliUserType } = {};
  if (role !== undefined) patch.role = role;
  if (userType !== undefined) patch.userType = userType;
  config.store.updateUser(name, patch);
  server.persistUserStore(
    configPath,
    config.team,
    config.roles,
    config.store,
    config.https,
    config.webPush,
  );

  const updated = config.store.findByName(name);
  stdout('');
  stdout(`✓ updated user '${name}' (${updated?.userType}, role=${updated?.role})`);
  stdout(`  config: ${configPath}`);
  stdout('');
}

async function runDelete(args: string[], stdout: (line: string) => void): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      'config-path': { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  });
  const name = stringOrUndef(values.name);
  if (!name) throw new UsageError('user delete: --name <name> is required');

  const server = await loadServerModule();
  const configPath = resolveConfigPath(values, server);
  const config = await loadConfig(server, configPath, 'delete');

  const existing = config.store.findByName(name);
  if (!existing) {
    const known = config.store.names().join(', ');
    throw new UsageError(
      `user delete: no user with name '${name}' in ${configPath}\n` +
        `  known names: ${known || '(none)'}`,
    );
  }
  if (existing.userType === 'admin') {
    const adminCount = config.store.slots().filter((u) => u.userType === 'admin').length;
    if (adminCount <= 1) {
      throw new UsageError(
        `user delete: refusing to remove the last admin ('${name}').\n` +
          '  Promote another user to admin first, then retry.',
      );
    }
  }

  config.store.removeUser(name);
  server.persistUserStore(
    configPath,
    config.team,
    config.roles,
    config.store,
    config.https,
    config.webPush,
  );

  stdout('');
  stdout(`✓ deleted user '${name}'`);
  stdout(`  config: ${configPath}`);
  stdout('');
  stdout('  Any bearer token and TOTP secret previously bound to this user are now invalid.');
  stdout('');
}

// ── helpers ────────────────────────────────────────────────────────

function resolveConfigPath(
  values: Record<string, unknown>,
  server: typeof import('@agentc7/server'),
): string {
  const fromFlag = stringOrUndef(values['config-path']) ?? stringOrUndef(values.config);
  return fromFlag ?? process.env[ENV.configPath] ?? server.defaultConfigPath();
}

async function loadConfig(
  server: typeof import('@agentc7/server'),
  configPath: string,
  verb: string,
): Promise<Awaited<ReturnType<typeof server.loadTeamConfigFromFile>>> {
  try {
    server.setKek(server.resolveKek(configPath));
  } catch (err) {
    if (err instanceof server.KekResolutionError) {
      throw new UsageError(`user ${verb}: ${err.message}`);
    }
    throw err;
  }
  try {
    return server.loadTeamConfigFromFile(configPath);
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      throw new UsageError(
        `user ${verb}: no config file at ${configPath}\n  Run \`ac7 setup\` first to create one.`,
      );
    }
    if (err instanceof server.UserLoadError) {
      throw new UsageError(`user ${verb}: ${err.message}`);
    }
    throw err;
  }
}

function assertUserType(v: string): CliUserType {
  if ((USER_TYPES as readonly string[]).includes(v)) return v as CliUserType;
  throw new UsageError(`unknown --user-type '${v}'. Must be one of: ${USER_TYPES.join(', ')}.`);
}

function inferDefaultRole(userType: string | undefined): string {
  switch (userType) {
    case 'admin':
    case 'operator':
      return 'admin';
    case 'lead-agent':
    case 'agent':
      return 'implementer';
    default:
      return 'implementer';
  }
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

async function loadServerModule(): Promise<typeof import('@agentc7/server')> {
  try {
    return await import('@agentc7/server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'user: @agentc7/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @agentc7/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @agentc7/ac7',
      );
    }
    throw err;
  }
}
