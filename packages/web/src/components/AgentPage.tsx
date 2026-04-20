/**
 * AgentPage — dedicated overview of a single user.
 *
 *   ←  Overview › name
 *   name · userType · role · team · ●ONLINE
 *   ┌── Objectives ──┐ ┌── Activity ──┐
 *   │ Assigned (3)   │ │  live SSE    │
 *   │ Watching (1)   │ │  timeline    │
 *   └────────────────┘ └──────────────┘
 *
 * Admin-gated. Non-admins who navigate here see a permission
 * notice via .callout.err.
 */

import type { Objective, Teammate } from '@agentc7/sdk/types';
import { useEffect } from 'preact/hooks';
import { agentActivityError, startAgentActivitySubscribe } from '../lib/agent-activity.js';
import { briefing } from '../lib/briefing.js';
import { objectives as objectivesSignal } from '../lib/objectives.js';
import { roster as rosterSignal } from '../lib/roster.js';
import {
  selectDmWith,
  selectFiles,
  selectObjectiveDetail,
  selectOverview,
} from '../lib/view.js';
import { AgentTimeline } from './AgentTimeline.js';

export interface AgentPageProps {
  name: string;
  viewer: string;
}

export function AgentPage({ name, viewer }: AgentPageProps) {
  const b = briefing.value;
  const rosterResp = rosterSignal.value;
  const objectives = objectivesSignal.value;
  const errorMessage = agentActivityError.value;

  const isAdmin = b?.userType === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    const teardown = startAgentActivitySubscribe({ name });
    return () => teardown();
  }, [name, isAdmin]);

  if (!b) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 18px max(1rem,env(safe-area-inset-left))"
      >
        <div class="eyebrow">Loading briefing…</div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div
        class="flex-1 overflow-y-auto"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 18px max(1rem,env(safe-area-inset-left));display:flex;flex-direction:column;gap:14px"
      >
        <Crumbs name={name} />
        <div class="callout err" role="alert">
          <div class="icon" aria-hidden="true">
            ◆
          </div>
          <div class="body">
            <div class="title">Restricted</div>
            <div class="msg">Only admins may view another user's activity timeline.</div>
          </div>
        </div>
      </div>
    );
  }

  const teammate: Teammate | undefined = rosterResp?.teammates.find((t) => t.name === name);
  const agent = rosterResp?.connected.find((c) => c.name === name);
  const isOnline = Boolean(agent && agent.connected > 0);

  const assigned = objectives.filter(
    (o) => o.assignee === name && o.status !== 'done' && o.status !== 'cancelled',
  );
  const watching = objectives.filter(
    (o) =>
      o.assignee !== name &&
      o.watchers.includes(name) &&
      o.status !== 'done' &&
      o.status !== 'cancelled',
  );

  return (
    <div class="flex-1 flex flex-col min-h-0">
      <div
        class="flex-shrink-0"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 16px max(1rem,env(safe-area-inset-left));border-bottom:1px solid var(--rule)"
      >
        <Crumbs name={name} />
        <div class="flex items-center gap-3 flex-wrap" style="margin-top:8px">
          <h1
            class="font-display"
            style="font-size:30px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.15"
          >
            {name}
          </h1>
          {teammate?.userType && (
            <span
              class={`badge ${teammate.userType === 'admin' ? 'solid' : teammate.userType === 'operator' || teammate.userType === 'lead-agent' ? 'ember' : 'soft'}`}
            >
              {formatUserType(teammate.userType)}
            </span>
          )}
          <span class={`badge ${isOnline ? 'soft' : 'muted'}`}>
            {isOnline ? '● ONLINE' : '◇ OFFLINE'}
          </span>
        </div>
        <div
          class="flex flex-wrap"
          style="gap:4px 14px;margin-top:10px;font-family:var(--f-sans);font-size:13.5px;color:var(--graphite)"
        >
          <span>
            role: <span style="color:var(--ink);font-weight:600">{teammate?.role ?? '—'}</span>
          </span>
          <span class="hidden sm:inline" style="color:var(--rule-strong)">
            ·
          </span>
          <span>
            team: <span style="color:var(--ink);font-weight:600">{b.team.name}</span>
          </span>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
          {viewer !== name && (
            <button
              type="button"
              onClick={() => selectDmWith(name)}
              class="btn btn-ghost btn-sm"
            >
              → Open DM with {name}
            </button>
          )}
          <button
            type="button"
            onClick={() => selectFiles(`/${name}`)}
            class="btn btn-ghost btn-sm"
            title={`Browse ${name}'s files`}
          >
            → Browse files
          </button>
        </div>
      </div>

      <div
        class="flex-1 overflow-y-auto"
        style="padding:18px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left));display:flex;flex-direction:column;gap:14px"
      >
        <section class="card">
          <div class="eyebrow" style="margin-bottom:12px">
            Objectives
          </div>
          <ObjectiveRefList label="Assigned" objectives={assigned} emptyLabel="none assigned" />
          <div style="margin-top:14px">
            <ObjectiveRefList label="Watching" objectives={watching} emptyLabel="none" />
          </div>
        </section>

        {errorMessage && (
          <div class="callout err" role="alert">
            <div class="icon" aria-hidden="true">
              ◆
            </div>
            <div class="body">
              <div class="msg">{errorMessage}</div>
            </div>
          </div>
        )}

        <AgentTimeline />
      </div>
    </div>
  );
}

function Crumbs({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" class="crumbs">
      <button type="button" onClick={selectOverview} class="text-link">
        ← Overview
      </button>
      <span class="sep" aria-hidden="true">
        ›
      </span>
      <span class="current">{name}</span>
    </nav>
  );
}

function ObjectiveRefList({
  label,
  objectives,
  emptyLabel,
}: {
  label: string;
  objectives: Objective[];
  emptyLabel: string;
}) {
  return (
    <div>
      <div style="font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;margin-bottom:6px">
        {label} ({objectives.length})
      </div>
      {objectives.length === 0 ? (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);font-style:italic">
          {emptyLabel}
        </div>
      ) : (
        <ul style="display:flex;flex-direction:column;gap:4px;list-style:none;padding:0;margin:0">
          {objectives.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => selectObjectiveDetail(o.id)}
                class="text-link-steel"
                style="font-family:var(--f-sans);font-size:14px;text-align:left;padding:0"
              >
                {o.id} — {o.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatUserType(userType: string): string {
  if (userType === 'lead-agent') return 'LEAD';
  if (userType === 'operator') return 'OP';
  return userType.toUpperCase();
}
