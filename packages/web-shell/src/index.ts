/**
 * Public API — @agentc7/web-shell.
 *
 * Everything a host needs to embed the shell:
 *   - `<TeamShell>` root component
 *   - `Identity` type for the identity prop
 *   - `SignOutHandler` / `UnauthorizedHandler` callback types
 *
 * Styles ship separately at `@agentc7/web-shell/styles.css`.
 *
 * Anything beyond this module is implementation detail. Consumers
 * should NOT deep-import lib/ or components/ directly — those file
 * paths are not a stable surface and may move without notice.
 */

export type { SignOutHandler, UnauthorizedHandler } from './lib/handlers.js';
export type { Identity } from './lib/identity.js';
export { TeamShell, type TeamShellProps } from './TeamShell.js';
