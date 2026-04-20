/**
 * Objectives list view — the full plate for a slot (or team-wide
 * for manager+). Click a row to open `ObjectiveDetail`. Directors and
 * managers get a "+ New" button at the top.
 *
 * Each row is a `.card` with status badge + title + assignee + outcome.
 * Status uses canonical `.badge` variants so Done / Cancelled don't
 * collide visually.
 */

import type { Objective, ObjectiveStatus } from '@agentc7/sdk/types';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { loadObjectives, objectives, objectivesLoaded } from '../lib/objectives.js';
import { selectObjectiveCreate, selectObjectiveDetail } from '../lib/view.js';

export interface ObjectivesPanelProps {
  viewer: string;
}

const STATUS_BADGE: Record<ObjectiveStatus, string> = {
  active: 'badge solid',
  blocked: 'badge ember solid',
  done: 'badge soft',
  cancelled: 'badge muted',
};

const panelError = signal<string | null>(null);

export function ObjectivesPanel({ viewer }: ObjectivesPanelProps) {
  const b = briefing.value;
  const list = objectives.value;
  const loaded = objectivesLoaded.value;
  const err = panelError.value;

  useEffect(() => {
    if (!loaded) {
      panelError.value = null;
      void loadObjectives().catch((e) => {
        panelError.value = e instanceof Error ? e.message : String(e);
      });
    }
  }, [loaded]);

  const canCreate = b !== null && (b.userType === 'admin' || b.userType === 'operator' || b.userType === 'lead-agent');

  if (!loaded && err === null) {
    return (
      <div
        class="flex-1 flex items-center justify-center"
        style="color:var(--muted);font-family:var(--f-mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase"
      >
        ━━ Loading objectives…
      </div>
    );
  }

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:24px max(1rem,env(safe-area-inset-right)) 24px max(1rem,env(safe-area-inset-left))"
    >
      <div
        class="flex flex-wrap items-end justify-between gap-3"
        style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--rule)"
      >
        <div class="min-w-0">
          <div class="eyebrow">Objectives</div>
          <h2
            class="font-display"
            style="font-size:30px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.1;margin-top:6px"
          >
            {list.length} on the board
          </h2>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={selectObjectiveCreate}
            class="btn btn-primary flex-shrink-0"
          >
            + New
          </button>
        )}
      </div>

      {err !== null && (
        <div role="alert" class="callout err" style="margin-bottom:16px">
          <div class="icon" aria-hidden="true">
            ◆
          </div>
          <div class="body">
            <div class="title">Couldn't load objectives</div>
            <div class="msg">{err}</div>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              style="margin-top:8px"
              onClick={() => {
                panelError.value = null;
                void loadObjectives().catch((e) => {
                  panelError.value = e instanceof Error ? e.message : String(e);
                });
              }}
            >
              ↻ Retry
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div class="empty">
          <h4>No objectives yet</h4>
          <p>{canCreate ? 'Click "+ New" to assign one.' : 'Nothing on your plate right now.'}</p>
        </div>
      ) : (
        <ul style="display:flex;flex-direction:column;gap:10px;list-style:none;padding:0;margin:0">
          {list.map((o) => (
            <ObjectiveRow key={o.id} objective={o} viewer={viewer} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function __resetObjectivesPanelForTests(): void {
  panelError.value = null;
}

function ObjectiveRow({ objective, viewer }: { objective: Objective; viewer: string }) {
  const isMine = objective.assignee === viewer;
  return (
    <li>
      <button
        type="button"
        onClick={() => selectObjectiveDetail(objective.id)}
        class="card hover-card w-full"
        style="text-align:left;padding:16px;display:block;cursor:pointer"
      >
        <div class="flex items-start justify-between gap-3 min-w-0">
          <div class="flex items-center gap-3 min-w-0 flex-wrap">
            <span class={STATUS_BADGE[objective.status]}>{objective.status}</span>
            <span
              class="truncate"
              style={`font-family:var(--f-display);font-weight:700;letter-spacing:-0.01em;color:var(--ink);font-size:15px;${objective.status === 'cancelled' ? 'text-decoration:line-through;color:var(--muted)' : ''}`}
            >
              {objective.title}
            </span>
          </div>
          {/* Assignee — hidden on narrow viewports; secondary line below on small. */}
          <span
            class="hidden sm:inline flex-shrink-0"
            style="font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;margin-top:2px"
          >
            {isMine ? '(you)' : `→ ${objective.assignee}`}
          </span>
        </div>
        <div
          class="truncate"
          style="font-family:var(--f-sans);font-size:13px;color:var(--graphite);margin-top:8px;line-height:1.4"
        >
          outcome: {objective.outcome}
        </div>
        <div
          class="sm:hidden"
          style="font-family:var(--f-mono);font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;margin-top:6px"
        >
          {isMine ? '(you)' : `→ ${objective.assignee}`}
        </div>
        {objective.blockReason && (
          <div style="font-family:var(--f-sans);font-size:13px;color:var(--ember);margin-top:6px;font-weight:500">
            ◆ blocked: {objective.blockReason}
          </div>
        )}
      </button>
    </li>
  );
}
