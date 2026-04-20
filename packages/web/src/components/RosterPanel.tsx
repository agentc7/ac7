/**
 * Roster panel — full teammate list with connection state + DM
 * initiation. Each non-self row is a button that opens a DM thread
 * with that name.
 *
 * Visual structure mirrors theme.css patterns:
 *   - .avatar for the name initial
 *   - .badge variants for userType
 *   - .dot for connection state
 */

import type { Presence } from '@agentc7/sdk/types';
import { briefing } from '../lib/briefing.js';
import { roster } from '../lib/roster.js';
import { senderTextClass } from '../lib/theme.js';
import { selectAgentDetail, selectDmWith } from '../lib/view.js';

export interface RosterPanelProps {
  viewer: string;
}

function userTypeBadgeClass(userType: string): string {
  if (userType === 'admin') return 'badge solid';
  if (userType === 'operator') return 'badge ember solid';
  if (userType === 'lead-agent') return 'badge ember soft';
  return 'badge soft';
}

function formatUserType(userType: string): string {
  if (userType === 'lead-agent') return 'LEAD';
  if (userType === 'operator') return 'OP';
  return userType.toUpperCase();
}

function avatarInitials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function RosterPanel({ viewer }: RosterPanelProps) {
  const r = roster.value;
  const b = briefing.value;
  if (!r) {
    return (
      <div
        class="flex-1 flex items-center justify-center"
        style="color:var(--muted);font-family:var(--f-mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase"
      >
        ━━ Loading roster…
      </div>
    );
  }
  const connectedByName = new Map<string, Presence>(r.connected.map((a) => [a.name, a]));
  const isAdmin = b?.userType === 'admin';

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      {b && (
        <div style="margin-bottom:24px;padding-bottom:18px;border-bottom:1px solid var(--rule)">
          <div class="eyebrow">Team</div>
          <h2
            class="font-display"
            style="font-size:30px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.1;margin-top:6px"
          >
            {b.team.name}
          </h2>
          {b.team.directive && (
            <div style="font-family:var(--f-sans);font-size:14.5px;color:var(--graphite);margin-top:10px;line-height:1.55;font-style:italic">
              {b.team.directive}
            </div>
          )}
          {b.team.brief && (
            <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);margin-top:8px;line-height:1.55;white-space:pre-wrap">
              {b.team.brief}
            </div>
          )}
        </div>
      )}

      <div class="eyebrow" style="margin-bottom:14px">
        Roster · click a teammate to DM
      </div>

      <div class="panel">
        <ul style="display:flex;flex-direction:column;list-style:none;padding:0;margin:0">
          {r.teammates.map((t, idx) => {
            const conn = connectedByName.get(t.name);
            const online = (conn?.connected ?? 0) > 0;
            const colorClass = senderTextClass(t.name, viewer);
            const isSelf = t.name === viewer;
            const isLast = idx === r.teammates.length - 1;
            const rowBorder = isLast ? '' : 'border-bottom:1px solid var(--rule);';

            const identityCluster = (
              <div class="flex items-center gap-3 min-w-0 flex-wrap">
                <span class="avatar" aria-hidden="true">
                  {avatarInitials(t.name)}
                </span>
                <div class="min-w-0 flex flex-col gap-0.5">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span
                      class={`${colorClass} font-display`}
                      style="font-weight:700;letter-spacing:-0.01em;font-size:15px;line-height:1.1"
                    >
                      {t.name}
                    </span>
                    {isSelf && (
                      <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase">
                        (you)
                      </span>
                    )}
                    <span class={userTypeBadgeClass(t.userType)}>
                      {formatUserType(t.userType)}
                    </span>
                  </div>
                  <div style="font-family:var(--f-mono);font-size:11px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase">
                    {t.role}
                  </div>
                </div>
              </div>
            );
            const statusCluster = (
              <span
                class="flex items-center gap-2 flex-shrink-0"
                style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase"
              >
                <span class={`dot${online ? ' ok' : ' muted'}`} aria-hidden="true" />
                <span style={`color:var(--${online ? 'steel' : 'muted'})`}>
                  {online ? `ONLINE · ${conn?.connected}` : 'OFFLINE'}
                </span>
              </span>
            );

            if (isSelf) {
              return (
                <li
                  key={t.name}
                  class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                  style={`padding:14px 16px;${rowBorder}`}
                >
                  {identityCluster}
                  {statusCluster}
                </li>
              );
            }

            return (
              <li key={t.name} class="flex flex-col sm:flex-row sm:items-stretch" style={rowBorder}>
                <button
                  type="button"
                  onClick={() => selectDmWith(t.name)}
                  class="hover-row flex-1 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3"
                  style="padding:14px 16px;background:transparent;text-align:left;cursor:pointer"
                  aria-label={`Message ${t.name}`}
                >
                  {identityCluster}
                  {statusCluster}
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => selectAgentDetail(t.name)}
                    aria-label={`View ${t.name} presence page`}
                    class="row-action flex-shrink-0"
                    style="padding:10px 16px;font-family:var(--f-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;border-top:1px solid var(--rule);text-align:left"
                  >
                    → Presence
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
