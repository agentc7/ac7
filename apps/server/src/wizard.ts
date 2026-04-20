/**
 * First-run interactive wizard for the ac7 broker.
 *
 * Triggered when the server boots without a config file at the
 * expected path AND stdin is a TTY. Walks the operator through
 * creating a team (name, directive, brief) and the first admin user,
 * generates a random bearer token, auto-enrolls the admin in TOTP
 * (every admin is human by definition), writes a hashed config to
 * disk (0o600), and returns the loaded `TeamConfig`.
 *
 * Subsequent users are added by the admin through the web UI (Users
 * admin page) or the CLI (`ac7 user create`) — the wizard no longer
 * loops for multiple slots. This keeps first-run setup to a single
 * Y/n-style flow: team + first admin, done.
 */

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Role, Team } from '@agentc7/sdk/types';
// qrcode-terminal is CJS; default-import the namespace and destructure.
import qrcodeTerminal from 'qrcode-terminal';
import {
  createUserStore,
  defaultHttpsConfig,
  UserLoadError,
  type TeamConfig,
  writeTeamConfig,
} from './slots.js';
import { generateSecret, otpauthUri, verifyCode } from './totp.js';

const { generate: generateQrCode, setErrorLevel } = qrcodeTerminal;

// `qrcode-terminal` lazily initializes its internal error-correction
// level, and some code paths read the unset value before the first
// `setErrorLevel` call, throwing "bad rs block @ … errorCorrectLevel:
// undefined". Set it explicitly at module load so every subsequent
// generate() sees a valid state. 'L' is the smallest (~7% recovery)
// which keeps the QR compact enough to fit in a terminal.
setErrorLevel('L');

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const ROLE_KEY_REGEX = /^[a-zA-Z0-9._-]+$/;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'ac7_';
const TOTP_ISSUER = 'ac7';
const TOTP_MAX_CONFIRM_ATTEMPTS = 3;

interface WizardAdmin {
  name: string;
  role: string;
  token: string;
  totpSecret: string;
}

/**
 * The wizard's view of its terminal. Inject your own for tests.
 *
 * `prompt` returns a single line of input (no trailing newline).
 * `println` writes a line to the "terminal" (newline appended for you).
 * `redactLines` is an optional best-effort erase of the last N lines
 * of output so a printed token doesn't linger in scrollback; real
 * TTYs use ANSI escapes, tests no-op it. `isInteractive` gates whether
 * the caller should run the wizard at all.
 */
export interface WizardIO {
  prompt(question: string): Promise<string>;
  println(line: string): void;
  redactLines?(count: number): void;
  isInteractive: boolean;
}

export interface RunWizardOptions {
  configPath: string;
  io: WizardIO;
  /** Override token generation for tests. Defaults to random 32 bytes. */
  tokenFactory?: () => string;
  /** Override TOTP secret generation for tests. Defaults to 160-bit random. */
  totpSecretFactory?: () => string;
  /**
   * Clock injection for TOTP code verification during enrollment.
   * Tests use this to produce a predictable code for a fixed secret;
   * production uses `Date.now`.
   */
  now?: () => number;
  /**
   * Override the in-terminal QR renderer. Tests pass a no-op or
   * capture what would have been drawn. Production defaults to
   * `qrcode-terminal`'s `small: true` mode.
   */
  qrRenderer?: (uri: string) => string;
}

/**
 * Starter role definitions shipped with every new team config. Roles
 * are freeform labels that describe a user's job; userType is
 * orthogonal and controls permissions. A fresh config ships these
 * four as a starting vocabulary — the admin can edit / add / remove
 * them after first boot.
 */
export const DEFAULT_ROLES: Record<string, Role> = {
  admin: {
    description: 'Leads the team, makes go/no-go calls, handles escalations.',
    instructions:
      'The admin role in this team sets direction, assigns objectives, and handles ' +
      'escalations. Issue clear directives and keep the team aligned on the team directive.',
  },
  implementer: {
    description: 'Writes and ships work — code, configuration, content.',
    instructions:
      'The implementer role in this team does the hands-on work. Take direction ' +
      'from your admin, report progress in the team channel, and use DMs for ' +
      'clarifications. When you finish an objective, mark it complete with a clear result.',
  },
  reviewer: {
    description: 'Checks implementer work before it ships.',
    instructions:
      'The reviewer role in this team verifies work before it ships. Read updates ' +
      'posted in the team channel, check for quality and correctness, and post ' +
      'approve or request-changes decisions with clear rationale.',
  },
  watcher: {
    description: 'Passively monitors team activity and flags anomalies.',
    instructions:
      'The watcher role in this team observes activity without initiating ' +
      'work. Surface unusual signals, blockers, or quiet stretches to your admin ' +
      'via DM. Stay out of the way unless you see something worth raising.',
  },
};

/**
 * Drive the wizard to completion, write the config file, and return
 * the loaded team config. Throws `UserLoadError` if the IO is not
 * interactive — the CLI catches that and prints a friendly
 * non-interactive hint instead.
 */
export async function runFirstRunWizard(options: RunWizardOptions): Promise<TeamConfig> {
  const { io, configPath } = options;
  const mintToken = options.tokenFactory ?? defaultTokenFactory;
  const mintTotpSecret = options.totpSecretFactory ?? generateSecret;
  const nowFn = options.now ?? Date.now;
  const renderQr = options.qrRenderer ?? defaultQrRenderer;

  if (!io.isInteractive) {
    throw new UserLoadError(
      `no config file at ${configPath} and stdin is not a TTY. ` +
        'Create the file manually, pass --config-path, or re-run interactively.',
    );
  }

  io.println('');
  io.println('ac7: no config file found at');
  io.println(`  ${configPath}`);
  io.println('');
  io.println("Let's set up a team. We'll ask for team details + the first admin's name,");
  io.println('then generate a bearer token (shown once) and auto-enroll a TOTP secret');
  io.println('so the admin can sign into the web UI. Save the token as it appears —');
  io.println("it's hashed on disk and can't be recovered afterward.");
  io.println('');
  io.println('Once the server is running, the admin can add more users (human or agent)');
  io.println('via the web UI or the `ac7 user create` CLI command.');
  io.println('');

  // ── Team ────────────────────────────────────────────────────
  io.println('-- team --');
  const team = await promptTeam(io);

  // ── Admin ───────────────────────────────────────────────────
  io.println('');
  io.println('-- first admin --');
  const name = await promptName(io);
  const role = await promptRole(io);
  const token = mintToken();
  const bannerLines = printTokenBanner(io, name, role, token);
  await io.prompt('press enter once you have saved the token above ');
  io.redactLines?.(bannerLines + 1);

  // TOTP is always-on for admins — no yes/no prompt. The wizard's
  // whole point is to leave you with a working web UI login.
  io.println('');
  io.println('-- TOTP enrollment --');
  io.println(`The admin signs into the web UI with a 6-digit code from an authenticator`);
  io.println('app. Scan the QR below and enter the current code to confirm pairing.');
  const totpSecret = await enrollTotp(io, name, {
    mintTotpSecret,
    now: nowFn,
    renderQr,
  });

  const admin: WizardAdmin = { name, role, token, totpSecret };

  // Start from the 4 default roles plus (if needed) a placeholder for
  // a custom role the admin selected.
  const roles: Record<string, Role> = { ...DEFAULT_ROLES };
  if (!Object.hasOwn(roles, admin.role)) {
    roles[admin.role] = {
      description: `(custom role defined by the wizard for ${admin.name}; edit me)`,
      instructions:
        `Custom role '${admin.role}' — replace this text with your own role notes. ` +
        'This is what the user will see as their role-specific briefing.',
    };
  }

  writeTeamConfig(configPath, team, roles, [
    {
      name: admin.name,
      role: admin.role,
      userType: 'admin',
      token: admin.token,
      totpSecret: admin.totpSecret,
    },
  ]);

  io.println('');
  io.println(`wrote team '${team.name}' with 1 admin (${admin.name}) to`);
  io.println(`  ${configPath}`);
  io.println('file is chmod 600; the token is stored as a SHA-256 hash only.');
  io.println(`web UI login is enabled for ${admin.name}.`);
  io.println('');
  io.println('Next steps:');
  io.println(`  • Sign in at the web UI as ${admin.name} with the 6-digit code from your`);
  io.println('    authenticator app and use the Users page to add operators / lead-agents / agents.');
  io.println('  • Or run `ac7 user create --name <name> --type agent --role implementer` from the CLI.');
  io.println('');

  const store = createUserStore([
    {
      name: admin.name,
      role: admin.role,
      userType: 'admin',
      token: admin.token,
      totpSecret: admin.totpSecret,
    },
  ]);
  return {
    team,
    roles,
    store,
    https: defaultHttpsConfig(),
    webPush: null,
    files: null,
    migrated: 0,
  };
}

async function promptTeam(io: WizardIO): Promise<Team> {
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
  const suggested = 'admin';
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

async function promptRole(io: WizardIO): Promise<string> {
  const suggested = 'admin';
  const defaultNames = Object.keys(DEFAULT_ROLES).join(', ');
  while (true) {
    const raw = (await io.prompt(`role [${suggested}]: `)).trim().toLowerCase();
    const candidate = raw.length === 0 ? suggested : raw;
    if (candidate.length === 0 || candidate.length > 64) {
      io.println('  role must be 1-64 characters');
      continue;
    }
    if (!ROLE_KEY_REGEX.test(candidate)) {
      io.println('  role must be alphanumeric with . _ - allowed');
      continue;
    }
    if (!Object.hasOwn(DEFAULT_ROLES, candidate)) {
      io.println(
        `  note: '${candidate}' is a custom role — the generated config ships with ` +
          `${defaultNames}. The wizard will add a placeholder roles.${candidate} entry ` +
          "you can edit later.",
      );
    }
    return candidate;
  }
}

/**
 * Render the token banner and return the number of terminal lines
 * emitted. The caller passes the count to `redactLines` so the wipe
 * stays in sync with the banner if its shape is edited later.
 */
function printTokenBanner(io: WizardIO, name: string, role: string, token: string): number {
  const bar = '='.repeat(68);
  const lines = [
    '',
    bar,
    `  ${name} (${role})`,
    '',
    `  ${token}`,
    bar,
    'save this token NOW — it will be hashed and removed from scrollback.',
  ];
  for (const line of lines) io.println(line);
  return lines.length;
}

/**
 * Generate a TOTP secret, show the QR + base32, verify the admin
 * can produce a current code, and return the secret on success.
 * Throws `UserLoadError` if the admin fails verification — TOTP is
 * non-negotiable for the first admin, so there's no "skip" branch.
 */
async function enrollTotp(
  io: WizardIO,
  adminName: string,
  deps: {
    mintTotpSecret: () => string;
    now: () => number;
    renderQr: (uri: string) => string;
  },
): Promise<string> {
  // Track every printed line so we can wipe the sensitive block
  // cleanly from scrollback after a successful verify.
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
    // readline writes the prompt + user's echoed input + newline as
    // a single visual line.
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
  throw new UserLoadError(
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

/**
 * Default in-terminal QR renderer using `qrcode-terminal` in small
 * (half-block) mode so a typical 33-module TOTP QR fits in 40 cols.
 * Synchronous wrapper around the library's callback-based generator —
 * the callback is always invoked synchronously on the same tick.
 */
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

/**
 * Build a TTY-backed `WizardIO` that reads from stdin, writes to
 * stdout, and uses ANSI escapes to wipe the token banner from visible
 * scrollback after the user confirms they've saved it. Returns both
 * the `io` and a `close` function that releases the underlying
 * readline interface — callers should always invoke `close` in a
 * `finally`.
 *
 * Scrollback redaction is best-effort. A terminal recorder, a tmux
 * buffer, a long-lived SSH session, or the OS clipboard will still
 * see the token if the operator copied it. This is a usability
 * nicety, not a security boundary.
 */
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
        // best-effort — some non-TTY wrappers that set isTTY=true
        // still lack moveCursor.
      }
    },
    isInteractive,
  };
  return { io, close: () => rl.close() };
}
