/**
 * `ac7 member` — offline team-member management from the terminal.
 *
 * Subcommands:
 *   ac7 member list   [--config-path <path>]
 *   ac7 member create --name <n> --title <t> [--description <d>] [--instructions <i>]
 *                     [--permissions <preset>] [--config-path <path>]
 *   ac7 member update --name <n> [--title <t>] [--description <d>] [--instructions <i>]
 *                     [--permissions <preset>] [--config-path <path>]
 *   ac7 member delete --name <n> [--config-path <path>]
 *
 * These commands edit the team config file directly (atomic rewrite
 * at 0o600) rather than going through the HTTP `/members` API, so
 * they work without a running broker. If the broker is running, it
 * picks up the changes on the next restart.
 *
 * `create` prints the plaintext bearer token exactly once. To
 * (re-)enroll a member for web UI login, run `ac7 enroll --member
 * <name>` afterwards.
 */

import { parseArgs } from 'node:util';
import { ENV } from '@agentc7/sdk/protocol';
import { UsageError } from './errors.js';

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export async function runMemberCommand(
  args: string[],
  stdout: (line: string) => void,
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help') {
    throw new UsageError('member subcommand required. Use: list | create | update | delete');
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
      throw new UsageError(`unknown member subcommand: ${sub}`);
  }
}

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

  const all = config.store.members();
  if (all.length === 0) {
    stdout('(no members)');
    return;
  }
  stdout(`${'name'.padEnd(20)}${'role'.padEnd(18)}${'permissions'.padEnd(24)}totp`);
  for (const m of all) {
    const totp = m.totpSecret ? 'enrolled' : '—';
    const perms = m.rawPermissions.length === 0 ? 'baseline' : m.rawPermissions.join(',');
    stdout(`${m.name.padEnd(20)}${m.role.title.padEnd(18)}${perms.padEnd(24)}${totp}`);
  }
}

async function runCreate(args: string[], stdout: (line: string) => void): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      permissions: { type: 'string' },
      'config-path': { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  });
  const name = stringOrUndef(values.name);
  const title = stringOrUndef(values.title);
  const description = stringOrUndef(values.description) ?? '';
  const instructions = stringOrUndef(values.instructions) ?? '';
  const permsRaw = stringOrUndef(values.permissions);

  if (!name) throw new UsageError('member create: --name <name> is required');
  if (!NAME_REGEX.test(name)) {
    throw new UsageError(
      `member create: invalid --name '${name}' (must be alphanumeric with . _ - allowed)`,
    );
  }
  if (!title) throw new UsageError('member create: --title <role-title> is required');

  const server = await loadServerModule();
  const configPath = resolveConfigPath(values, server);
  const config = await loadConfig(server, configPath, 'create');

  if (config.store.findByName(name)) {
    throw new UsageError(`member create: a member named '${name}' already exists in ${configPath}`);
  }

  const rawPermissions = permsRaw
    ? permsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  let resolvedPermissions: ReturnType<typeof server.resolvePermissions>;
  try {
    resolvedPermissions = server.resolvePermissions(
      rawPermissions,
      config.team.permissionPresets,
      `member create '${name}'`,
    );
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const token = server.generateMemberToken();
  config.store.addMember({
    name,
    role: { title, description },
    instructions,
    rawPermissions,
    permissions: resolvedPermissions,
    token,
  });
  server.persistMemberStore(configPath, config.team, config.store, config.https, config.webPush);

  stdout('');
  stdout(
    `✓ created member '${name}' (role=${title}, permissions=${rawPermissions.join(',') || 'baseline'})`,
  );
  stdout(`  config: ${configPath}`);
  stdout('');
  stdout('  ┌─ BEARER TOKEN — save this now; it is not persisted anywhere else ─┐');
  stdout(`  │ ${token}`);
  stdout('  └────────────────────────────────────────────────────────────────────┘');
  stdout('');
  stdout(`  To enable web UI login, run: ac7 enroll --member ${name}`);
  stdout('');
}

async function runUpdate(args: string[], stdout: (line: string) => void): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      permissions: { type: 'string' },
      'config-path': { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  });
  const name = stringOrUndef(values.name);
  const title = stringOrUndef(values.title);
  const description = stringOrUndef(values.description);
  const instructions = stringOrUndef(values.instructions);
  const permsRaw = stringOrUndef(values.permissions);

  if (!name) throw new UsageError('member update: --name <name> is required');
  if (
    title === undefined &&
    description === undefined &&
    instructions === undefined &&
    permsRaw === undefined
  ) {
    throw new UsageError(
      'member update: at least one of --title, --description, --instructions, --permissions is required',
    );
  }

  const server = await loadServerModule();
  const configPath = resolveConfigPath(values, server);
  const config = await loadConfig(server, configPath, 'update');

  const current = config.store.findByName(name);
  if (!current) {
    throw new UsageError(`member update: no member named '${name}' in ${configPath}`);
  }

  const patch: Parameters<typeof config.store.updateMember>[1] = {};
  if (title !== undefined || description !== undefined) {
    patch.role = {
      title: title ?? current.role.title,
      description: description ?? current.role.description,
    };
  }
  if (instructions !== undefined) patch.instructions = instructions;

  if (permsRaw !== undefined) {
    const rawPermissions = permsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    let resolved: ReturnType<typeof server.resolvePermissions>;
    try {
      resolved = server.resolvePermissions(
        rawPermissions,
        config.team.permissionPresets,
        `member update '${name}'`,
      );
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    if (current.permissions.includes('members.manage') && !resolved.includes('members.manage')) {
      const adminCount = config.store
        .members()
        .filter((m) => m.permissions.includes('members.manage')).length;
      if (adminCount <= 1) {
        throw new UsageError(
          'member update: cannot remove members.manage from the last admin — promote someone else first',
        );
      }
    }
    patch.permissions = resolved;
    patch.rawPermissions = rawPermissions;
  }

  config.store.updateMember(name, patch);
  server.persistMemberStore(configPath, config.team, config.store, config.https, config.webPush);

  stdout(`✓ updated member '${name}'`);
  stdout(`  config: ${configPath}`);
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
  if (!name) throw new UsageError('member delete: --name <name> is required');

  const server = await loadServerModule();
  const configPath = resolveConfigPath(values, server);
  const config = await loadConfig(server, configPath, 'delete');

  const target = config.store.findByName(name);
  if (!target) {
    throw new UsageError(`member delete: no member named '${name}' in ${configPath}`);
  }
  if (target.permissions.includes('members.manage')) {
    const adminCount = config.store
      .members()
      .filter((m) => m.permissions.includes('members.manage')).length;
    if (adminCount <= 1) {
      throw new UsageError(
        'member delete: cannot delete the last admin — promote someone else first',
      );
    }
  }

  config.store.removeMember(name);
  server.persistMemberStore(configPath, config.team, config.store, config.https, config.webPush);
  stdout(`✓ deleted member '${name}'`);
  stdout(`  config: ${configPath}`);
}

// ── helpers ────────────────────────────────────────────────────

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function resolveConfigPath(
  values: { 'config-path'?: unknown; config?: unknown },
  server: { defaultConfigPath(): string },
): string {
  const explicit = stringOrUndef(values['config-path']) ?? stringOrUndef(values.config);
  return explicit ?? process.env[ENV.configPath] ?? server.defaultConfigPath();
}

async function loadConfig(
  server: typeof import('@agentc7/server'),
  configPath: string,
  verb: string,
): Promise<ReturnType<typeof server.loadTeamConfigFromFile>> {
  try {
    server.setKek(server.resolveKek(configPath));
  } catch (err) {
    if (err instanceof server.KekResolutionError) {
      throw new UsageError(`member ${verb}: ${err.message}`);
    }
    throw err;
  }
  try {
    return server.loadTeamConfigFromFile(configPath);
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      throw new UsageError(
        `member ${verb}: no team config file at ${configPath}. Run \`ac7 setup\` first.`,
      );
    }
    if (err instanceof server.MemberLoadError) {
      throw new UsageError(`member ${verb}: ${err.message}`);
    }
    throw err;
  }
}

async function loadServerModule(): Promise<typeof import('@agentc7/server')> {
  try {
    return await import('@agentc7/server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'member: @agentc7/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @agentc7/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @agentc7/ac7',
      );
    }
    throw err;
  }
}
