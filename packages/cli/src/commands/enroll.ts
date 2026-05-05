/**
 * `ac7 enroll` — rotate or add a TOTP secret for a member.
 *
 * Calls `POST /members/:name/enroll-totp` on the running broker.
 * Authenticated as the caller; requires `members.manage` (admin
 * enrolling someone else) or self (re-enrolling your own auth).
 *
 * The server generates and persists a fresh secret immediately on the
 * call — the response carries the new `totpSecret` + `totpUri` for
 * the QR render. Any authenticator currently bound to a previous
 * secret stops working as of that moment, so the user's next sign-in
 * must use the new code.
 */

import type { Client } from '@agentc7/sdk/client';
import { UsageError } from './errors.js';

export { UsageError };

export interface EnrollCommandInput {
  /** Name of the member to (re-)enroll. Required. */
  user?: string;
}

export async function runEnrollCommand(
  input: EnrollCommandInput,
  client: Client,
  stdout: (line: string) => void,
): Promise<void> {
  if (!input.user) {
    throw new UsageError('enroll: --user <name> is required');
  }

  const result = await client.enrollTotp(input.user);

  stdout('');
  stdout(`✓ enrolled '${input.user}' for web UI login`);
  stdout('');
  stdout('Scan this QR with your authenticator app (Google Authenticator, Authy,');
  stdout('1Password, etc.) — or paste the secret below manually.');
  stdout('');

  const qr = renderQr(result.totpUri);
  for (const line of qr.split('\n')) stdout(line);
  stdout('');
  stdout('or paste this secret manually:');
  stdout(`  ${result.totpSecret}`);
  stdout('');
  stdout('  Any authenticator previously bound to this user is now invalid.');
  stdout('  The next web UI sign-in must use a 6-digit code from the new secret.');
  stdout('');
}

/**
 * Render an `otpauth://` URI as a terminal QR code using
 * `qrcode-terminal`'s small (half-block) mode. Resolved lazily from
 * `@agentc7/server`'s node_modules so the CLI doesn't ship a direct
 * dep on a package most paths never load.
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

function nodeRequire(moduleId: string): unknown {
  const { createRequire } = require('node:module') as typeof import('node:module');
  const base = createRequire(import.meta.url);
  // Try the server's node_modules first (where qrcode-terminal lives as
  // a transitive dep); fall back to direct resolution if the user has
  // it installed elsewhere in the CLI's resolution scope.
  try {
    const serverPkgPath = base.resolve('@agentc7/server/package.json');
    const fromServer = createRequire(serverPkgPath);
    return fromServer(moduleId);
  } catch {
    return base(moduleId);
  }
}
