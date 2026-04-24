/**
 * Root component for @agentc7/web (OSS SPA).
 *
 * Owns the OSS-specific auth gate — session cookie bootstrap, TOTP
 * login screen, sign-out wiring — and then delegates the entire
 * in-team experience to `<TeamShell>` from @agentc7/web-shell.
 *
 * Gate states:
 *   - `loading`        → Boot splash while we call GET /session
 *   - `anonymous`      → Login screen (TOTP)
 *   - `authenticated`  → TeamShell, with OSS callbacks wired in
 */

import { TeamShell, ToastContainer } from '@agentc7/web-shell';
import { useEffect } from 'preact/hooks';
import { getClient } from './lib/client.js';
import { bootstrap, logout, session } from './lib/session.js';
import { Boot } from './routes/Boot.js';
import { Login } from './routes/Login.js';

export function App() {
  // Bootstrap once on mount. Empty dep array is intentional — we only
  // want this firing once per page load.
  useEffect(() => {
    void bootstrap();
  }, []);

  const state = session.value;
  if (state.status === 'loading') return <Boot />;
  if (state.status === 'anonymous') return <Login />;
  return (
    <>
      <TeamShell
        client={getClient()}
        identity={{
          member: state.member,
          role: state.role,
          permissions: state.permissions,
          expiresAt: state.expiresAt,
        }}
        onSignOut={() => logout()}
        onUnauthorized={(notice) => logout(notice)}
      />
      <ToastContainer />
    </>
  );
}
