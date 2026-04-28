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

export { RouteModal, type RouteModalProps } from './components/RouteModal.js';
export { ToastContainer } from './components/ui/ToastContainer.js';
export type { SignOutHandler, UnauthorizedHandler } from './lib/handlers.js';
export type { Identity } from './lib/identity.js';
export {
  closeInspector,
  isInspectorOpen,
  openInspector,
  toggleInspector,
} from './lib/inspector.js';
export { closeSidebar, isSidebarOpen, openSidebar } from './lib/view.js';
export {
  clearAllToasts,
  dismissToast,
  type Toast,
  type ToastAction,
  type ToastKind,
  type ToastOptions,
  toast,
  toasts,
} from './lib/toast.js';
export { TeamShell, type TeamShellProps } from './TeamShell.js';
