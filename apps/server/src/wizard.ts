/**
 * First-run interactive wizard for the ac7 broker.
 *
 * Triggered when the server boots without a config file at the
 * expected path AND stdin is a TTY. Walks the operator through
 * creating a team (name, directive, brief) and the first admin
 * member, generates a random bearer token, auto-enrolls the admin
 * in TOTP (admins need web UI login by default), writes a hashed
 * config to disk (0o600), and returns the loaded `TeamConfig`.
 *
 * Subsequent members are added by the admin through the web UI
 * (Members admin page) or the CLI (`ac7 member create`).
 */

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Permission, Role, Team } from '@agentc7/sdk/types';
import { PERMISSIONS } from '@agentc7/sdk/types';
// qrcode-terminal is CJS; default-import the namespace and destructure.
import qrcodeTerminal from 'qrcode-terminal';
import {
  createMemberStore,
  defaultHttpsConfig,
  MemberLoadError,
  type TeamConfig,
  writeTeamConfig,
} from './members.js';
import { generateSecret, otpauthUri, verifyCode } from './totp.js';

const { generate: generateQrCode, setErrorLevel } = qrcodeTerminal;

// `qrcode-terminal` lazily initializes its error-correction level and
// some code paths read it unset. Set at module load so generate() sees
// a valid state. 'L' = smallest (~7% recovery), compact enough for a
// terminal.
setErrorLevel('L');

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'ac7_';
const TOTP_ISSUER = 'ac7';
const TOTP_MAX_CONFIRM_ATTEMPTS = 3;

/**
 * Default permission presets shipped with every new team config.
 * The operator can edit after first boot — these are sensible
 * starting points for small teams.
 */
export const DEFAULT_PERMISSION_PRESETS: Record<string, Permission[]> = {
  admin: [...PERMISSIONS],
  operator: ['objectives.create', 'objectives.cancel', 'objectives.reassign'],
};

export interface WizardIO {
  prompt(question: string): Promise<string>;
  println(line: string): void;
  /** Best-effort wipe of the last N lines, for TOTP secret redaction. */
  redactLines?(count: number): void;
  isInteractive: boolean;
}

export interface RunWizardOptions {
  configPath: string;
  io: WizardIO;
  tokenFactory?: () => string;
  totpSecretFactory?: () => string;
  now?: () => number;
  qrRenderer?: (uri: string) => string;
}

/**
 * Drive the wizard to completion, write the config file, and return
 * the loaded team config. Throws `MemberLoadError` if IO is not
 * interactive — the CLI catches that and prints a non-interactive
 * hint instead.
 */
export async function runFirstRunWizard(options: RunWizardOptions): Promise<TeamConfig> {
  const { io, configPath } = options;
  const mintToken = options.tokenFactory ?? defaultTokenFactory;
  const mintTotpSecret = options.totpSecretFactory ?? generateSecret;
  const nowFn = options.now ?? Date.now;
  const renderQr = options.qrRenderer ?? defaultQrRenderer;

  if (!io.isInteractive) {
    throw new MemberLoadError(
      `no config file at ${configPath} and stdin is not a TTY. ` +
        'Create the file manually, pass --config-path, or re-run interactively.',
    );
  }

  io.println('');
  io.println('ac7: no config file found at');
  io.println(`  ${configPath}`);
  io.println('');
  io.println("Let's set up a team. We'll ask for team details + the first admin member's");
  io.println('name and role, generate a bearer token (shown once) and a TOTP secret for');
  io.println('web UI login. Save the token as it appears — it is hashed on disk and');
  io.println('cannot be recovered afterward.');
  io.println('');
  io.println('Once the server is running, the admin can add more members via the web');
  io.println('UI (Members page) or `ac7 member create` from the CLI.');
  io.println('');

  // ── Team ────────────────────────────────────────────────────
  io.println('-- team --');
  const team = await promptTeam(io);

  // ── First admin member ─────────────────────────────────────
  io.println('');
  io.println('-- first admin member --');
  const name = await promptName(io);
  const role = await promptRole(io);
  const token = mintToken();
  const bannerLines = printTokenBanner(io, name, role, token);
  await io.prompt('press enter once you have saved the token above ');
  io.redactLines?.(bannerLines + 1);

  // TOTP is always-on for the first admin — no yes/no prompt. The
  // wizard's whole point is to leave the operator with a working web
  // UI login.
  io.println('');
  io.println('-- TOTP enrollment --');
  io.println(`The admin signs into the web UI with a 6-digit code from an authenticator app.`);
  io.println('Scan the QR below and enter the current code to confirm pairing.');
  const totpSecret = await enrollTotp(io, name, {
    mintTotpSecret,
    now: nowFn,
    renderQr,
  });

  const fullTeam: Team = { ...team, permissionPresets: DEFAULT_PERMISSION_PRESETS };

  writeTeamConfig(configPath, fullTeam, [
    {
      name,
      role,
      instructions: '',
      permissions: ['admin'],
      token,
      totpSecret,
    },
  ]);

  io.println('');
  io.println(`wrote team '${team.name}' with 1 admin member (${name}) to`);
  io.println(`  ${configPath}`);
  io.println('file is chmod 600; the token is stored as a SHA-256 hash only.');
  io.println(`web UI login is enabled for ${name}.`);
  io.println('');
  io.println('Next steps:');
  io.println(`  • Sign in at the web UI as ${name} with the 6-digit code from your`);
  io.println('    authenticator app and use the Members page to add teammates.');
  io.println('  • Or run `ac7 member create --name <name> --title <title>` from the CLI.');
  io.println('');

  const store = createMemberStore([
    {
      name,
      role,
      instructions: '',
      permissions: DEFAULT_PERMISSION_PRESETS.admin ?? [],
      rawPermissions: ['admin'],
      token,
      totpSecret,
    },
  ]);
  return {
    team: fullTeam,
    store,
    https: defaultHttpsConfig(),
    webPush: null,
    files: null,
    jwt: null,
    migrated: 0,
  };
}

async function promptTeam(
  io: WizardIO,
): Promise<{ name: string; directive: string; brief: string }> {
  const name = await promptRequired(io, 'team name [my-team]: ', 'my-team', (v) =>
    v.length > 0 && v.length <= 128 ? null : 'must be 1-128 characters',
  );
  const directive = await promptRequired(
    io,
    'directive (short, e.g. "Ship the payment service"): ',
    '',
    (v) => (v.length > 0 && v.length <= 512 ? null : 'directive is required, max 512 chars'),
  );
  const brief = (await io.prompt('brief (longer context, press enter to skip): ')).trim();
  return { name, directive, brief };
}

async function promptRequired(
  io: WizardIO,
  prompt: string,
  defaultValue: string,
  validate: (v: string) => string | null,
): Promise<string> {
  while (true) {
    const raw = (await io.prompt(prompt)).trim();
    const candidate = raw.length === 0 ? defaultValue : raw;
    const err = validate(candidate);
    if (err !== null) {
      io.println(`  ${err}`);
      continue;
    }
    return candidate;
  }
}

async function promptName(io: WizardIO): Promise<string> {
  const suggested = 'director-1';
  while (true) {
    const raw = (await io.prompt(`admin name [${suggested}]: `)).trim();
    const candidate = raw.length === 0 ? suggested : raw;
    if (!candidate) {
      io.println('  name cannot be empty');
      continue;
    }
    if (candidate.length > 128) {
      io.println('  name must be 128 characters or fewer');
      continue;
    }
    if (!NAME_REGEX.test(candidate)) {
      io.println('  name must be alphanumeric with . _ - allowed');
      continue;
    }
    return candidate;
  }
}

/**
 * Prompt for the first admin's role. Asks for a title and an
 * optional description; both are freeform team-defined labels. The
 * wizard picks sensible defaults.
 */
async function promptRole(io: WizardIO): Promise<Role> {
  const suggestedTitle = 'director';
  const title = await promptRequired(io, `role title [${suggestedTitle}]: `, suggestedTitle, (v) =>
    v.length > 0 && v.length <= 64 ? null : 'title must be 1-64 characters',
  );
  const rawDesc = (await io.prompt('role description (press enter to skip): ')).trim();
  const description = rawDesc.length > 0 ? rawDesc : '';
  return { title, description };
}

/**
 * Render the token banner and return the number of terminal lines
 * emitted so the caller can wipe scrollback cleanly.
 */
function printTokenBanner(io: WizardIO, name: string, role: Role, token: string): number {
  const bar = '='.repeat(68);
  const lines = [
    '',
    bar,
    `  ${name} (${role.title})`,
    '',
    `  ${token}`,
    bar,
    'save this token NOW — it will be hashed and removed from scrollback.',
  ];
  for (const line of lines) io.println(line);
  return lines.length;
}

async function enrollTotp(
  io: WizardIO,
  adminName: string,
  deps: {
    mintTotpSecret: () => string;
    now: () => number;
    renderQr: (uri: string) => string;
  },
): Promise<string> {
  let redactCount = 0;
  const printRedacted = (line: string) => {
    io.println(line);
    redactCount++;
  };

  const secret = deps.mintTotpSecret();
  const uri = otpauthUri({
    secret,
    issuer: TOTP_ISSUER,
    label: `${TOTP_ISSUER}:${adminName}`,
  });
  const qr = deps.renderQr(uri);

  printRedacted('');
  printRedacted('scan this QR code with Google Authenticator, Authy, 1Password, …');
  printRedacted('');
  for (const line of qr.split('\n')) printRedacted(line);
  printRedacted('');
  printRedacted('or paste this secret manually:');
  printRedacted(`  ${secret}`);
  printRedacted('');

  for (let attempt = 0; attempt < TOTP_MAX_CONFIRM_ATTEMPTS; attempt++) {
    const raw = (await io.prompt('enter the 6-digit code to confirm: ')).trim();
    redactCount += 1;
    const result = verifyCode(secret, raw, 0, deps.now());
    if (result.ok) {
      io.redactLines?.(redactCount);
      io.println(`  ✓ TOTP enrolled for ${adminName}`);
      return secret;
    }
    io.println(`  ${describeVerifyError(result.reason)} — try again`);
    redactCount += 1;
  }

  io.redactLines?.(redactCount);
  throw new MemberLoadError(
    'TOTP enrollment failed after 3 attempts. Re-run the wizard; the admin must ' +
      'enroll to sign into the web UI on first boot.',
  );
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

function defaultQrRenderer(uri: string): string {
  let out = '';
  generateQrCode(uri, { small: true }, (qr) => {
    out = qr;
  });
  return out;
}

function defaultTokenFactory(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function createTtyWizardIO(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): { io: WizardIO; close: () => void } {
  const rl = createInterface({ input: stdin, output: stdout });
  const isInteractive = Boolean(stdin.isTTY && stdout.isTTY);
  const io: WizardIO = {
    prompt: (question) => rl.question(question),
    println: (line) => {
      stdout.write(`${line}\n`);
    },
    redactLines: (count) => {
      if (!stdout.isTTY) return;
      try {
        stdout.moveCursor?.(0, -count);
        stdout.clearScreenDown?.();
      } catch {
        // best-effort
      }
    },
    isInteractive,
  };
  return { io, close: () => rl.close() };
}
