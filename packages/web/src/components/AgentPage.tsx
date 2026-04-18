/**
 * AgentPage — dedicated overview of a single slot.
 *
 *   ←  Overview › name
 *   name · authority · role · team · ●ONLINE
 *   ┌── Objectives ──┐ ┌── Activity ──┐
 *   │ Assigned (3)   │ │  live SSE    │
 *   │ Watching (1)   │ │  timeline    │
 *   └────────────────┘ └──────────────┘
 *
 * Director-gated. Non-directors who navigate here see a permission
 * notice via .callout.err.
 */

import type { Objective, Teammate } from '@agentc7/sdk/types';
import { useEffect } from 'preact/hooks';
import { agentActivityError, startAgentActivitySubscribe } from '../lib/agent-activity.js';
import { briefing } from '../lib/briefing.js';
import { objectives as objectivesSignal } from '../lib/objectives.js';
import { roster as rosterSignal } from '../lib/roster.js';
import { selectDmWith, selectObjectiveDetail, selectOverview } from '../lib/view.js';
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

  const isDirector = b?.authority === 'director';

  useEffect(() => {
    if (!isDirector) return;
    const teardown = startAgentActivitySubscribe({ name });
    return () => teardown();
  }, [name, isDirector]);

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

  if (!isDirector) {
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
            <div class="msg">Only directors may view another slot's activity timeline.</div>
          </div>
        </div>
      </div>
    );
  }

  const teammate: Teammate | undefined = rosterResp?.teammates.find((t) => t.name === name);
  const agent = rosterResp?.connected.find((c) => c.agentId === name);
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
          {teammate?.authority && (
            <span
              class={`badge ${teammate.authority === 'director' ? 'solid' : teammate.authority === 'manager' ? 'ember' : 'soft'}`}
            >
              {formatAuthority(teammate.authority)}
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
        {viewer !== name && (
          <button
            type="button"
            onClick={() => selectDmWith(name)}
            class="btn btn-ghost btn-sm"
            style="margin-top:14px"
          >
            → Open DM with {name}
          </button>
        )}
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

function formatAuthority(authority: string): string {
  if (authority === 'individual-contributor') return 'IC';
  return authority;
}
