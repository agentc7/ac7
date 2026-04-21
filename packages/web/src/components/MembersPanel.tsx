/**
 * MembersPanel — admin-only team-members surface.
 *
 * Lists every member on the team with role + permissions + TOTP
 * status, and offers the full lifecycle: create, update (role /
 * instructions / permissions), rotate bearer token, (re-)enroll
 * TOTP, delete.
 *
 * Sensitive operations — token rotation, TOTP enrollment, deletion —
 * all require inline confirmation. Tokens + TOTP secrets are
 * returned exactly once by the server and shown in a dismissible
 * banner; after dismiss there is no way to recover them.
 *
 * Non-admins who reach this view see a permission notice. The
 * Sidebar hides the entry point for non-admins, but we defend in
 * depth here too because the server will reject the underlying
 * /members requests anyway.
 */

import type {
  CreateMemberResponse,
  EnrollTotpResponse,
  Member,
  RotateTokenResponse,
} from '@agentc7/sdk/types';
import { hasPermission } from '@agentc7/sdk/types';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { getClient } from '../lib/client.js';
import { loadRoster } from '../lib/roster.js';

/** Full member list as returned by GET /members. Null until first load. */
const members = signal<Member[] | null>(null);
const loadError = signal<string | null>(null);
const actionBusy = signal<string | null>(null);

type Reveal =
  | { kind: 'create'; response: CreateMemberResponse }
  | { kind: 'rotate'; name: string; response: RotateTokenResponse }
  | { kind: 'totp'; name: string; response: EnrollTotpResponse };
const reveal = signal<Reveal | null>(null);

function revealTargetName(r: Reveal): string {
  return r.kind === 'create' ? r.response.member.name : r.name;
}

/** Panel-local "add member" form state. Reset after successful submit. */
const formOpen = signal(false);
const formName = signal('');
const formRoleTitle = signal('engineer');
const formRoleDescription = signal('');
const formInstructions = signal('');
const formPermissions = signal<string>(''); // preset name or empty
const formError = signal<string | null>(null);

async function refresh(): Promise<void> {
  loadError.value = null;
  try {
    members.value = await getClient().listMembers();
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

function summarizePermissions(perms: readonly string[]): string {
  if (perms.length === 0) return 'baseline';
  if (perms.includes('members.manage')) return 'admin';
  if (perms.includes('objectives.create')) return 'operator';
  return `${perms.length} leaf${perms.length === 1 ? '' : 's'}`;
}

export function MembersPanel() {
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

  if (!hasPermission(b.permissions, 'members.manage')) {
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
            <div class="msg">Managing members requires the members.manage permission.</div>
          </div>
        </div>
      </div>
    );
  }

  const list = members.value;
  const err = loadError.value;
  const revealed = reveal.value;
  const busy = actionBusy.value;
  const presetNames = Object.keys(b.team.permissionPresets);

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
            Members
          </h2>
        </div>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          onClick={() => {
            formOpen.value = true;
            formError.value = null;
            formName.value = '';
            formRoleTitle.value = 'engineer';
            formRoleDescription.value = '';
            formInstructions.value = '';
            formPermissions.value = '';
          }}
          disabled={busy !== null}
        >
          + New member
        </button>
      </div>

      {err !== null && (
        <div class="callout err" role="alert" style="margin-bottom:18px">
          <div class="icon" aria-hidden="true">
            ◆
          </div>
          <div class="body">
            <div class="title">Failed to load members</div>
            <div class="msg">{err}</div>
          </div>
        </div>
      )}

      {revealed !== null &&
        (list === null || !list.some((m) => m.name === revealTargetName(revealed))) && (
          <RevealBanner reveal={revealed} />
        )}

      {formOpen.value && <CreateMemberForm presetNames={presetNames} />}

      {list === null && err === null && (
        <div style="font-family:var(--f-sans);font-size:13.5px;color:var(--muted)">
          Loading members…
        </div>
      )}

      {list !== null && (
        <div class="panel">
          <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
            {list.map((m, idx) => (
              <MemberRow
                key={m.name}
                member={m}
                viewer={b.name}
                isLast={idx === list.length - 1}
                adminCount={list.filter((x) => x.permissions.includes('members.manage')).length}
                presetNames={presetNames}
                revealed={revealed && revealTargetName(revealed) === m.name ? revealed : null}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MemberRow({
  member,
  viewer,
  isLast,
  adminCount,
  presetNames,
  revealed,
}: {
  member: Member;
  viewer: string;
  isLast: boolean;
  adminCount: number;
  presetNames: string[];
  revealed: Reveal | null;
}) {
  const rowKey = member.name;
  const busy = actionBusy.value;
  const isSelf = member.name === viewer;
  const isAdmin = member.permissions.includes('members.manage');
  const isLastAdmin = isAdmin && adminCount <= 1;
  const border = isLast ? '' : 'border-bottom:1px solid var(--rule);';

  async function onChangePermissions(nextPreset: string): Promise<void> {
    const next = nextPreset.length > 0 ? [nextPreset] : [];
    if (isLastAdmin && !next.includes('admin')) {
      alert('Cannot demote the last admin. Promote another member to admin first.');
      return;
    }
    await withBusy(`update:${rowKey}`, async () => {
      try {
        await getClient().updateMember(member.name, { permissions: next });
        await refresh();
        await loadRoster();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onChangeRoleTitle(next: string): Promise<void> {
    const trimmed = next.trim();
    if (!trimmed || trimmed === member.role.title) return;
    await withBusy(`update:${rowKey}`, async () => {
      try {
        await getClient().updateMember(member.name, {
          role: { title: trimmed, description: member.role.description },
        });
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
        `Rotate bearer token for '${member.name}'?\n\nThe existing token will be invalidated immediately.`,
      )
    )
      return;
    await withBusy(`rotate:${rowKey}`, async () => {
      try {
        const response = await getClient().rotateToken(member.name);
        reveal.value = { kind: 'rotate', name: member.name, response };
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onEnrollTotp(): Promise<void> {
    if (
      !confirm(
        `(Re-)enroll TOTP for '${member.name}'?\n\nAny authenticator app currently bound to this member will stop working.`,
      )
    )
      return;
    await withBusy(`totp:${rowKey}`, async () => {
      try {
        const response = await getClient().enrollTotp(member.name);
        reveal.value = { kind: 'totp', name: member.name, response };
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onDelete(): Promise<void> {
    if (isLastAdmin) {
      alert('Cannot remove the last admin. Promote another member to admin first.');
      return;
    }
    if (isSelf) {
      if (!confirm(`Delete YOURSELF ('${member.name}')?\n\nYou will be signed out immediately.`))
        return;
    } else if (
      !confirm(
        `Delete member '${member.name}'?\n\nTheir bearer token and TOTP secret will be invalidated; their files and message history remain.`,
      )
    ) {
      return;
    }
    await withBusy(`delete:${rowKey}`, async () => {
      try {
        await getClient().deleteMember(member.name);
        await refresh();
        await loadRoster();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const disabled = busy !== null;
  const currentPreset = member.permissions.includes('members.manage')
    ? 'admin'
    : member.permissions.includes('objectives.create')
      ? 'operator'
      : '';

  return (
    <li class="flex flex-col" style={`padding:14px 16px;${border}`}>
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0 flex-wrap">
          <div class="min-w-0 flex flex-col gap-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span
                class="font-display"
                style="font-weight:700;letter-spacing:-0.01em;font-size:15px;color:var(--ink)"
              >
                {member.name}
              </span>
              {isSelf && (
                <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase">
                  (you)
                </span>
              )}
              <span
                class={`badge ${isAdmin ? 'solid' : member.permissions.includes('objectives.create') ? 'ember solid' : 'soft'}`}
              >
                {summarizePermissions(member.permissions)}
              </span>
            </div>
            <div class="flex items-center gap-2 flex-wrap" style="margin-top:2px">
              <label
                class="flex items-center gap-2"
                style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase"
              >
                <span>role</span>
                <input
                  class="input"
                  style="padding:3px 8px;font-size:12px;width:14ch"
                  defaultValue={member.role.title}
                  disabled={disabled}
                  onBlur={(e) =>
                    void onChangeRoleTitle((e.currentTarget as HTMLInputElement).value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  }}
                />
              </label>
              <label
                class="flex items-center gap-2"
                style="font-family:var(--f-mono);font-size:11px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase"
              >
                <span>perms</span>
                <select
                  class="select"
                  style="padding:3px 8px;font-size:12px"
                  value={currentPreset}
                  disabled={disabled}
                  onChange={(e) =>
                    void onChangePermissions((e.currentTarget as HTMLSelectElement).value)
                  }
                >
                  <option value="">baseline</option>
                  {presetNames.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {member.role.description.length > 0 && (
              <div style="font-family:var(--f-sans);font-size:12px;color:var(--graphite);margin-top:4px;line-height:1.5">
                {member.role.description}
              </div>
            )}
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
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void onEnrollTotp()}
            disabled={disabled}
            title="Generate a fresh TOTP secret for web UI login"
          >
            {busy === `totp:${rowKey}` ? '…' : 'Enroll TOTP'}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void onDelete()}
            disabled={disabled || isLastAdmin}
            style="color:var(--err, #b42b2b)"
            title={isLastAdmin ? 'Cannot delete the last admin' : 'Delete this member'}
          >
            {busy === `delete:${rowKey}` ? '…' : 'Delete'}
          </button>
        </div>
      </div>
      {revealed && (
        <div style="margin-top:12px">
          <RevealBanner reveal={revealed} />
        </div>
      )}
    </li>
  );
}

function CreateMemberForm({ presetNames }: { presetNames: string[] }) {
  const busy = actionBusy.value;
  const err = formError.value;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const name = formName.value.trim();
    const title = formRoleTitle.value.trim();
    const description = formRoleDescription.value.trim();
    const instructions = formInstructions.value.trim();
    const preset = formPermissions.value.trim();
    if (!name) {
      formError.value = 'Name is required.';
      return;
    }
    if (!title) {
      formError.value = 'Role title is required.';
      return;
    }
    await withBusy('create', async () => {
      try {
        const response = await getClient().createMember({
          name,
          role: { title, description },
          instructions,
          permissions: preset.length > 0 ? [preset] : [],
        });
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
    <form class="panel" onSubmit={(e) => void onSubmit(e)} style="padding:16px;margin-bottom:18px">
      <div class="eyebrow" style="margin-bottom:10px">
        New member
      </div>
      {err !== null && (
        <div class="callout err" role="alert" style="margin-bottom:10px">
          <div class="body">
            <div class="msg">{err}</div>
          </div>
        </div>
      )}
      <div style="display:flex;flex-direction:column;gap:10px">
        <Labeled label="Name" hint="Alphanumeric, . _ - allowed">
          <input
            class="input"
            value={formName.value}
            onInput={(e) => {
              formName.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="ALPHA-1"
          />
        </Labeled>
        <Labeled label="Role title" hint="Freeform — commander, engineer, qa-lead, …">
          <input
            class="input"
            value={formRoleTitle.value}
            onInput={(e) => {
              formRoleTitle.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </Labeled>
        <Labeled label="Role description" hint="What this role does on the team (public)">
          <textarea
            class="input"
            rows={2}
            value={formRoleDescription.value}
            onInput={(e) => {
              formRoleDescription.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          />
        </Labeled>
        <Labeled label="Instructions" hint="Personal working directives (private)">
          <textarea
            class="input"
            rows={3}
            value={formInstructions.value}
            onInput={(e) => {
              formInstructions.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          />
        </Labeled>
        <Labeled label="Permissions" hint="Pick a preset, or baseline for a plain member">
          <select
            class="select"
            value={formPermissions.value}
            onChange={(e) => {
              formPermissions.value = (e.currentTarget as HTMLSelectElement).value;
            }}
          >
            <option value="">baseline (no elevated permissions)</option>
            {presetNames.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Labeled>
      </div>
      <div class="flex items-center gap-2" style="margin-top:14px">
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy !== null}>
          {busy === 'create' ? 'Creating…' : 'Create member'}
        </button>
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
      </div>
    </form>
  );
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: preact.ComponentChildren;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input/select/textarea is passed in as a child
    <label style="display:flex;flex-direction:column;gap:4px">
      <div class="eyebrow">{label}</div>
      {children}
      <div style="font-family:var(--f-sans);font-size:11.5px;color:var(--muted);font-style:italic">
        {hint}
      </div>
    </label>
  );
}

function RevealBanner({ reveal: r }: { reveal: Reveal }) {
  let title: string;
  const fields: Array<{ label: string; value: string }> = [];
  if (r.kind === 'create') {
    title = `Created '${r.response.member.name}'`;
    fields.push({ label: 'Bearer token', value: r.response.token });
  } else if (r.kind === 'rotate') {
    title = `Rotated token for '${r.name}'`;
    fields.push({ label: 'Bearer token', value: r.response.token });
  } else {
    title = `Re-enrolled TOTP for '${r.name}'`;
    fields.push({ label: 'TOTP secret', value: r.response.totpSecret });
    fields.push({ label: 'otpauth URI', value: r.response.totpUri });
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
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
          {fields.map((f) => (
            <SecretField key={f.label} label={f.label} value={f.value} />
          ))}
        </div>
        <div style="margin-top:12px;font-family:var(--f-sans);font-size:12px;color:var(--muted);font-style:italic">
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

function SecretField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — user can still select once revealed */
    }
  };

  const display = shown ? value : '•'.repeat(32);
  const btnBase =
    'font-family:var(--f-sans);font-size:11.5px;background:var(--paper);border:none;border-left:1px solid var(--rule);padding:0 14px;cursor:pointer;letter-spacing:.04em;text-transform:uppercase;font-weight:600;white-space:nowrap';

  return (
    <div>
      <div style="font-family:var(--f-sans);font-size:11px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">
        {label}
      </div>
      <div style="display:flex;align-items:stretch;border:1px solid var(--rule);border-radius:var(--r-sm);overflow:hidden;background:var(--ice)">
        <input
          type="text"
          readOnly
          value={display}
          aria-label={shown ? label : `${label} (hidden)`}
          onFocus={(e) => {
            if (shown) (e.currentTarget as HTMLInputElement).select();
          }}
          style={`flex:1;font-family:var(--f-mono);font-size:12.5px;padding:8px 10px;background:transparent;color:var(--ink);border:none;outline:none;min-width:0;letter-spacing:${shown ? 'normal' : '1px'}`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          style={`${btnBase};color:var(--ink);min-width:68px`}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
          style={`${btnBase};color:${copied ? 'var(--ok,#2d6a4f)' : 'var(--ink)'};min-width:82px`}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function __resetMembersPanelForTests(): void {
  members.value = null;
  loadError.value = null;
  actionBusy.value = null;
  reveal.value = null;
  formOpen.value = false;
  formName.value = '';
  formRoleTitle.value = 'engineer';
  formRoleDescription.value = '';
  formInstructions.value = '';
  formPermissions.value = '';
  formError.value = null;
}
