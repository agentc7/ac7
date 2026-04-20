/**
 * UsersPanel — admin-only users admin surface.
 *
 * Lists every user on the team with userType + role + TOTP status, and
 * offers the full lifecycle: create, update (role / userType), rotate
 * bearer token, (re-)enroll TOTP for humans, delete.
 *
 * Sensitive operations — token rotation, TOTP enrollment, deletion —
 * all require inline confirmation. Tokens + TOTP secrets are returned
 * exactly once by the server and shown in a dismissible banner; after
 * dismiss there is no way to recover them.
 *
 * Non-admins who reach this view see a permission notice. The Sidebar
 * hides the entry point for non-admins, but we defend in depth here
 * too because the server will reject the underlying /users requests
 * anyway.
 */

import type {
  CreateUserResponse,
  EnrollTotpResponse,
  RotateTokenResponse,
  Teammate,
  UserType,
} from '@agentc7/sdk/types';
import { canManageUsers, isHuman } from '@agentc7/sdk/types';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { getClient } from '../lib/client.js';
import { loadRoster } from '../lib/roster.js';

const USER_TYPES: UserType[] = ['admin', 'operator', 'lead-agent', 'agent'];

/** Full user list as returned by GET /users. Null until first load. */
const users = signal<Teammate[] | null>(null);
const loadError = signal<string | null>(null);
const actionBusy = signal<string | null>(null);

type Reveal =
  | { kind: 'create'; response: CreateUserResponse }
  | { kind: 'rotate'; name: string; response: RotateTokenResponse }
  | { kind: 'totp'; name: string; response: EnrollTotpResponse };
const reveal = signal<Reveal | null>(null);

/** Panel-local "add user" form state. Reset after successful submit. */
const formOpen = signal(false);
const formName = signal('');
const formUserType = signal<UserType>('agent');
const formRole = signal('implementer');
const formError = signal<string | null>(null);

async function refresh(): Promise<void> {
  loadError.value = null;
  try {
    users.value = await getClient().listUsers();
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

async function withBusy<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  if (actionBusy.value !== null) return null;
  actionBusy.value = key;
  try {
    return await fn();
  } finally {
    actionBusy.value = null;
  }
}

function formatUserType(u: UserType): string {
  if (u === 'lead-agent') return 'LEAD';
  if (u === 'operator') return 'OP';
  return u.toUpperCase();
}

function userTypeBadgeClass(u: UserType): string {
  if (u === 'admin') return 'badge solid';
  if (u === 'operator') return 'badge ember solid';
  if (u === 'lead-agent') return 'badge ember soft';
  return 'badge soft';
}

export function UsersPanel() {
  const b = briefing.value;

  useEffect(() => {
    void refresh();
  }, []);

  if (!b) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
      >
        <div class="eyebrow">Loading briefing…</div>
      </div>
    );
  }

  if (!canManageUsers(b.userType)) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
      >
        <div class="callout err" role="alert">
          <div class="icon" aria-hidden="true">
            ◆
          </div>
          <div class="body">
            <div class="title">Restricted</div>
            <div class="msg">Only admins may manage team users.</div>
          </div>
        </div>
      </div>
    );
  }

  const list = users.value;
  const err = loadError.value;
  const revealed = reveal.value;
  const busy = actionBusy.value;

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <div class="flex items-center justify-between gap-3 flex-wrap" style="margin-bottom:18px">
        <div>
          <div class="eyebrow">Team</div>
          <h2
            class="font-display"
            style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.1;margin-top:4px"
          >
            Users
          </h2>
        </div>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={() => {
            formOpen.value = true;
            formError.value = null;
            formName.value = '';
            formUserType.value = 'agent';
            formRole.value = 'implementer';
          }}
          disabled={busy !== null}
        >
          + New user
        </button>
      </div>

      {err !== null && (
        <div class="callout err" role="alert" style="margin-bottom:18px">
          <div class="icon" aria-hidden="true">
            ◆
          </div>
          <div class="body">
            <div class="title">Failed to load users</div>
            <div class="msg">{err}</div>
          </div>
        </div>
      )}

      {revealed !== null && <RevealBanner reveal={revealed} />}

      {formOpen.value && <CreateUserForm />}

      {list === null && err === null && (
        <div style="font-family:var(--f-sans);font-size:13.5px;color:var(--muted)">
          Loading users…
        </div>
      )}

      {list !== null && (
        <div class="panel">
          <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
            {list.map((u, idx) => (
              <UserRow
                key={u.name}
                user={u}
                viewer={b.name}
                isLast={idx === list.length - 1}
                totalAdmins={list.filter((x) => x.userType === 'admin').length}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserRow({
  user,
  viewer,
  isLast,
  totalAdmins,
}: {
  user: Teammate;
  viewer: string;
  isLast: boolean;
  totalAdmins: number;
}) {
  const rowKey = user.name;
  const busy = actionBusy.value;
  const isSelf = user.name === viewer;
  const isLastAdmin = user.userType === 'admin' && totalAdmins <= 1;
  const border = isLast ? '' : 'border-bottom:1px solid var(--rule);';

  async function onChangeUserType(next: UserType): Promise<void> {
    if (next === user.userType) return;
    if (isLastAdmin && next !== 'admin') {
      alert('Cannot demote the last admin. Promote another user to admin first.');
      return;
    }
    await withBusy(`update:${rowKey}`, async () => {
      try {
        await getClient().updateUser(user.name, { userType: next });
        await refresh();
        await loadRoster();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onChangeRole(next: string): Promise<void> {
    const trimmed = next.trim();
    if (!trimmed || trimmed === user.role) return;
    await withBusy(`update:${rowKey}`, async () => {
      try {
        await getClient().updateUser(user.name, { role: trimmed });
        await refresh();
        await loadRoster();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onRotate(): Promise<void> {
    if (
      !confirm(
        `Rotate bearer token for '${user.name}'?\n\nThe existing token will be invalidated immediately. Any process using it will need the new value.`,
      )
    )
      return;
    await withBusy(`rotate:${rowKey}`, async () => {
      try {
        const response = await getClient().rotateToken(user.name);
        reveal.value = { kind: 'rotate', name: user.name, response };
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onEnrollTotp(): Promise<void> {
    if (!isHuman(user.userType)) {
      alert('Only admin and operator users use web UI login (TOTP).');
      return;
    }
    if (
      !confirm(
        `(Re-)enroll TOTP for '${user.name}'?\n\nAny authenticator app currently bound to this user will stop working on the next sign-in.`,
      )
    )
      return;
    await withBusy(`totp:${rowKey}`, async () => {
      try {
        const response = await getClient().enrollTotp(user.name);
        reveal.value = { kind: 'totp', name: user.name, response };
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onDelete(): Promise<void> {
    if (isLastAdmin) {
      alert('Cannot remove the last admin. Promote another user to admin first.');
      return;
    }
    if (isSelf) {
      if (!confirm(`Delete YOURSELF ('${user.name}')?\n\nYou will be signed out immediately.`))
        return;
    } else if (
      !confirm(
        `Delete user '${user.name}'?\n\nTheir bearer token and TOTP secret will be invalidated; their files and message history remain.`,
      )
    ) {
      return;
    }
    await withBusy(`delete:${rowKey}`, async () => {
      try {
        await getClient().deleteUser(user.name);
        await refresh();
        await loadRoster();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const disabled = busy !== null;

  return (
    <li
      class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
      style={`padding:14px 16px;${border}`}
    >
      <div class="flex items-center gap-3 min-w-0 flex-wrap">
        <div class="min-w-0 flex flex-col gap-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span
              class="font-display"
              style="font-weight:700;letter-spacing:-0.01em;font-size:15px;color:var(--ink)"
            >
              {user.name}
            </span>
            {isSelf && (
              <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase">
                (you)
              </span>
            )}
            <span class={userTypeBadgeClass(user.userType)}>{formatUserType(user.userType)}</span>
          </div>
          <div class="flex items-center gap-2 flex-wrap" style="margin-top:2px">
            <label
              class="flex items-center gap-2"
              style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase"
            >
              <span>userType</span>
              <select
                class="select"
                style="padding:3px 8px;font-size:12px"
                value={user.userType}
                disabled={disabled}
                onChange={(e) =>
                  void onChangeUserType((e.currentTarget as HTMLSelectElement).value as UserType)
                }
              >
                {USER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label
              class="flex items-center gap-2"
              style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase"
            >
              <span>role</span>
              <input
                class="input"
                style="padding:3px 8px;font-size:12px;width:12ch"
                defaultValue={user.role}
                disabled={disabled}
                onBlur={(e) => void onChangeRole((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                }}
              />
            </label>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 flex-wrap flex-shrink-0">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => void onRotate()}
          disabled={disabled}
          title="Mint a new bearer token (invalidates the current one)"
        >
          {busy === `rotate:${rowKey}` ? '…' : 'Rotate token'}
        </button>
        {isHuman(user.userType) && (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void onEnrollTotp()}
            disabled={disabled}
            title="Generate a fresh TOTP secret for web UI login"
          >
            {busy === `totp:${rowKey}` ? '…' : 'Enroll TOTP'}
          </button>
        )}
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => void onDelete()}
          disabled={disabled || isLastAdmin}
          style="color:var(--err, #b42b2b)"
          title={isLastAdmin ? 'Cannot delete the last admin' : 'Delete this user'}
        >
          {busy === `delete:${rowKey}` ? '…' : 'Delete'}
        </button>
      </div>
    </li>
  );
}

function CreateUserForm() {
  const busy = actionBusy.value;
  const err = formError.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const name = formName.value.trim();
    const userType = formUserType.value;
    const role = formRole.value.trim();
    if (!name) {
      formError.value = 'Name is required.';
      return;
    }
    if (!role) {
      formError.value = 'Role is required.';
      return;
    }
    await withBusy('create', async () => {
      try {
        const response = await getClient().createUser({ name, userType, role });
        reveal.value = { kind: 'create', response };
        formOpen.value = false;
        await refresh();
        await loadRoster();
      } catch (ex) {
        formError.value = ex instanceof Error ? ex.message : String(ex);
      }
    });
  }

  return (
    <form
      class="panel"
      style="padding:16px;margin-bottom:18px;display:flex;flex-direction:column;gap:12px"
      onSubmit={(e) => void onSubmit(e)}
    >
      <div class="eyebrow">New user</div>
      {err !== null && (
        <div
          class="callout err"
          role="alert"
          style="margin:0;padding:8px 12px;font-size:13px"
        >
          <div class="body">
            <div class="msg">{err}</div>
          </div>
        </div>
      )}
      <label class="field">
        <span class="field-label">Name</span>
        <input
          class="input"
          type="text"
          value={formName.value}
          onInput={(e) => {
            formName.value = (e.currentTarget as HTMLInputElement).value;
          }}
          placeholder="alice"
          autoFocus
          required
        />
      </label>
      <label class="field">
        <span class="field-label">User type</span>
        <select
          class="select"
          value={formUserType.value}
          onChange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value as UserType;
            formUserType.value = v;
            // Suggest a sensible default role when userType changes.
            if (v === 'admin' || v === 'operator') formRole.value = 'admin';
            else formRole.value = 'implementer';
          }}
        >
          {USER_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span class="field-label">Role</span>
        <input
          class="input"
          type="text"
          value={formRole.value}
          onInput={(e) => {
            formRole.value = (e.currentTarget as HTMLInputElement).value;
          }}
          required
        />
      </label>
      <div class="flex gap-2 justify-end">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => {
            formOpen.value = false;
            formError.value = null;
          }}
          disabled={busy !== null}
        >
          Cancel
        </button>
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
          {busy === 'create' ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </form>
  );
}

function RevealBanner({ reveal: r }: { reveal: Reveal }) {
  let title: string;
  let lines: string[];
  if (r.kind === 'create') {
    title = `Created '${r.response.user.name}' (${r.response.user.userType})`;
    lines = [`bearer token: ${r.response.token}`];
    if (r.response.totpSecret) lines.push(`totp secret: ${r.response.totpSecret}`);
    if (r.response.totpUri) lines.push(`otpauth uri:  ${r.response.totpUri}`);
  } else if (r.kind === 'rotate') {
    title = `Rotated token for '${r.name}'`;
    lines = [`bearer token: ${r.response.token}`];
  } else {
    title = `Re-enrolled TOTP for '${r.name}'`;
    lines = [
      `totp secret: ${r.response.totpSecret}`,
      `otpauth uri:  ${r.response.totpUri}`,
    ];
  }

  return (
    <div
      class="callout"
      role="alert"
      style="margin-bottom:18px;background:var(--paper);border:1px solid var(--ink);padding:14px 16px;display:flex;gap:12px;align-items:flex-start"
    >
      <div class="icon" aria-hidden="true">
        ✓
      </div>
      <div class="body" style="flex:1;min-width:0">
        <div class="title">{title}</div>
        <div
          class="msg"
          style="font-family:var(--f-mono);font-size:12px;white-space:pre-wrap;word-break:break-all;margin-top:6px"
        >
          {lines.join('\n')}
        </div>
        <div
          style="margin-top:8px;font-family:var(--f-sans);font-size:12px;color:var(--muted);font-style:italic"
        >
          Save these now — they are not persisted anywhere else. Dismissing this banner hides them
          forever.
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          reveal.value = null;
        }}
        aria-label="Dismiss"
        class="close"
      >
        ×
      </button>
    </div>
  );
}

export function __resetUsersPanelForTests(): void {
  users.value = null;
  loadError.value = null;
  actionBusy.value = null;
  reveal.value = null;
  formOpen.value = false;
  formName.value = '';
  formUserType.value = 'agent';
  formRole.value = 'implementer';
  formError.value = null;
}
