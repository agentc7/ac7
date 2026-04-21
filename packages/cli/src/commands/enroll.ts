/**
 * `ac7 enroll` — rotate or add a TOTP secret for a user.
 *
 * The wizard auto-enrolls the first admin for TOTP during setup. This
 * command closes the loop for everyone else:
 *
 *   1. The admin created another human user via `ac7 user create` (or
 *      the web UI) and that user now needs to sign into the web UI.
 *   2. A user lost the device that had the authenticator app and
 *      needs to rotate the secret. The bearer token in ac7.json is
 *      the recovery capability for this path — whoever can read the
 *      config file can re-enroll, which is exactly the threat model
 *      we want (physical access to the server = trust).
 *
 * Flow (mirrors the wizard's prompt, but with rotation wording):
 *   1. Load the team config at the resolved path.
 *   2. Look up the user by name; error clearly if missing.
 *   3. Warn if the user already has a secret — re-enrollment will
 *      invalidate every authenticator currently bound to it.
 *   4. Generate a fresh secret + otpauth URI.
 *   5. Render a QR to the terminal and print the base32 fallback.
 *   6. Prompt for a live 6-digit confirmation code; retry on errors
 *      up to 3 times; empty input = abort with the config untouched.
 *   7. On success, call `enrollMemberTotp` to atomically rewrite the
 *      config with the new secret (and reset the replay counter).
 *
 * Agents (lead-agent, agent) don't sign into the web UI and don't
 * need TOTP; this command rejects them with a useful message.
 */

import { ENV } from '@agentc7/sdk/protocol';
import { UsageError } from './errors.js';

export { UsageError };

export interface EnrollCommandInput {
  /** Name of the user to (re-)enroll. Required. */
  user?: string;
  /** Override the config file location (defaults to $AC7_CONFIG_PATH → ./ac7.json). */
  configPath?: string;
}

const TOTP_ISSUER = 'ac7';
const MAX_CONFIRM_ATTEMPTS = 3;

export async function runEnrollCommand(
  input: EnrollCommandInput,
  stdout: (line: string) => void,
): Promise<void> {
  if (!input.user) {
    throw new UsageError('enroll: --user <name> is required');
  }

  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  // Install the KEK before loading so enc-v1 fields round-trip
  // through the enroll + config-rewrite path.
  try {
    server.setKek(server.resolveKek(configPath));
  } catch (err) {
    if (err instanceof server.KekResolutionError) {
      throw new UsageError(`enroll: ${err.message}`);
    }
    throw err;
  }

  // Load the existing config. Any failure here (missing, invalid)
  // gets mapped to a user-facing UsageError so the raw MemberLoadError
  // stack doesn't surface.
  let config: Awaited<ReturnType<typeof server.loadTeamConfigFromFile>>;
  try {
    config = server.loadTeamConfigFromFile(configPath);
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      throw new UsageError(
        `enroll: no config file at ${configPath}\n` +
          '  Run `pnpm wizard` (or `ac7 setup`) first to create one.',
      );
    }
    if (err instanceof server.MemberLoadError) {
      throw new UsageError(`enroll: ${err.message}`);
    }
    throw err;
  }

  const targetUser = config.store.findByName(input.user);
  if (!targetUser) {
    const known = config.store.names().join(', ');
    throw new UsageError(
      `enroll: no user with name '${input.user}' in ${configPath}\n` +
        `  known names: ${known || '(none)'}`,
    );
  }
  const alreadyEnrolled = Boolean(targetUser.totpSecret);
  if (alreadyEnrolled) {
    stdout('');
    stdout(`⚠  '${input.user}' is already enrolled for web UI login.`);
    stdout('   Re-enrolling rotates the secret and invalidates any authenticator');
    stdout('   currently bound to this user. If you proceed, the old device will');
    stdout('   stop working for sign-in on the next restart.');
    stdout('');
  }

  // The wizard IO abstraction is what gives us interactive prompts,
  // redactable scrollback, and the same TTY guard every CLI path uses.
  const { io, close } = server.createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    throw new UsageError(
      'enroll: stdin is not a TTY — this command needs interactive input.\n' +
        '  Run it in a real terminal (not piped / under turbo).',
    );
  }

  try {
    const secret = server.generateTotpSecret();
    const uri = server.otpauthUri({
      secret,
      issuer: TOTP_ISSUER,
      label: `${TOTP_ISSUER}:${input.user}`,
    });

    stdout('');
    stdout(`-- web UI login for ${input.user} --`);
    stdout(
      alreadyEnrolled
        ? 'Rotating the TOTP secret. Scan this with your authenticator app:'
        : 'This user can sign into the browser UI with a 6-digit authenticator code.',
    );
    if (!alreadyEnrolled) {
      stdout('Scan this with your authenticator app:');
    }
    stdout('');

    const qr = renderQr(uri);
    for (const line of qr.split('\n')) stdout(line);
    stdout('');
    stdout('or paste this secret manually:');
    stdout(`  ${secret}`);
    stdout('');

    // Prompt loop — mirrors the wizard's retry policy exactly.
    let confirmed = false;
    let lastCounter = 0;
    for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
      const raw = (await io.prompt('enter the 6-digit code to confirm: ')).trim();
      if (raw.length === 0) {
        stdout('  aborted — config not changed.');
        return;
      }
      const result = server.verifyTotpCode(secret, raw, lastCounter, Date.now());
      if (result.ok) {
        lastCounter = result.counter;
        confirmed = true;
        break;
      }
      stdout(`  ${describeVerifyError(result.reason)} — try again`);
    }

    if (!confirmed) {
      throw new UsageError('enroll: too many bad attempts — no changes written to the config.');
    }

    // Persist the new secret. enrollMemberTotp reloads the config file
    // defensively, patches the target user, and rewrites atomically
    // at 0o600, so a concurrent edit elsewhere in the file doesn't
    // get trampled.
    server.enrollMemberTotp(configPath, input.user, secret);

    stdout('');
    stdout(`✓ ${alreadyEnrolled ? 're-enrolled' : 'enrolled'} '${input.user}' for web UI login`);
    stdout(`  config: ${configPath}`);
    stdout('');
    if (alreadyEnrolled) {
      stdout('  The old authenticator is now invalid. Use the new one on your next sign-in.');
    }
    stdout('');
  } finally {
    close();
  }
}

/**
 * Render an `otpauth://` URI as a terminal QR code using
 * `qrcode-terminal`'s small (half-block) mode.
 *
 * `qrcode-terminal` is a transitive dep of `@agentc7/server`, not a
 * direct CLI dep — we resolve it lazily via `createRequire` scoped at
 * the server module's location. This keeps the CLI's dep tree lean
 * (users who never run `ac7 enroll` never load it) and avoids
 * duplicating the package between CLI and server node_modules.
 *
 * `qrcode-terminal` is CJS with a lazily-initialized internal error
 * level — calling `setErrorLevel('L')` up front is required to
 * avoid "bad rs block @ errorCorrectLevel: undefined" on the first
 * generate() call. The wizard has the same guard for the same reason.
 */
function renderQr(uri: string): string {
  const req = nodeRequire('qrcode-terminal');
  const qrcode = req as {
    generate: (text: string, opts: { small: boolean }, cb: (out: string) => void) => void;
    setErrorLevel: (level: 'L' | 'M' | 'Q' | 'H') => void;
  };
  qrcode.setErrorLevel('L');
  let out = '';
  qrcode.generate(uri, { small: true }, (q) => {
    out = q;
  });
  return out;
}

/**
 * Build a `require` scoped to the resolved `@agentc7/server`
 * package, so we can pull in `qrcode-terminal` from the server's
 * node_modules without declaring it as a direct CLI dep.
 */
function nodeRequire(moduleId: string): unknown {
  // Lazy `require('node:module')` inside an ESM file — the CJS
  // interop keeps `node:module` out of the CLI's startup graph for
  // users who never invoke `ac7 enroll`.
  const { createRequire } = require('node:module') as typeof import('node:module');
  // import.meta.resolve isn't available in all Node versions we support;
  // resolve through a stable anchor (this file) instead.
  const base = createRequire(import.meta.url);
  const serverPkgPath = base.resolve('@agentc7/server/package.json');
  const fromServer = createRequire(serverPkgPath);
  return fromServer(moduleId);
}

function describeVerifyError(reason: 'malformed' | 'invalid' | 'replay'): string {
  switch (reason) {
    case 'malformed':
      return 'that code is not 6 digits';
    case 'invalid':
      return 'that code is incorrect';
    case 'replay':
      return 'that code is expired (enter the next one your app shows)';
  }
}

async function loadServerModule(): Promise<typeof import('@agentc7/server')> {
  try {
    return await import('@agentc7/server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'enroll: @agentc7/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @agentc7/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @agentc7/ac7',
      );
    }
    throw err;
  }
}
