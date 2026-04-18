/**
 * New-objective form — visible only to managers + directors.
 * Fields: title, outcome (required), body, assignee (from roster),
 * optional initial watchers.
 *
 * Uses canonical .field / .field-label / .input / .textarea / .select
 * patterns so the form looks identical to forms elsewhere in the
 * brand (component reference, marketing pages).
 */

import { signal } from '@preact/signals';
import { createObjective } from '../lib/objectives.js';
import { roster } from '../lib/roster.js';
import { selectObjectiveDetail, selectObjectivesList } from '../lib/view.js';

const title = signal('');
const outcome = signal('');
const body = signal('');
const assignee = signal('');
const watchers = signal<string[]>([]);
const busy = signal(false);
const err = signal<string | null>(null);

function resetForm(): void {
  title.value = '';
  outcome.value = '';
  body.value = '';
  assignee.value = '';
  watchers.value = [];
  err.value = null;
}

export function ObjectiveCreate() {
  const r = roster.value;
  const teammates = r?.teammates ?? [];
  const canSubmit =
    !busy.value &&
    title.value.trim().length > 0 &&
    outcome.value.trim().length > 0 &&
    assignee.value.length > 0;

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!canSubmit || busy.value) return;
    busy.value = true;
    err.value = null;
    try {
      const created = await createObjective({
        title: title.value.trim(),
        outcome: outcome.value.trim(),
        assignee: assignee.value,
        ...(body.value.trim() ? { body: body.value.trim() } : {}),
        ...(watchers.value.length > 0 ? { watchers: watchers.value } : {}),
      });
      selectObjectiveDetail(created.id);
      resetForm();
    } catch (e2) {
      err.value = e2 instanceof Error ? e2.message : String(e2);
    } finally {
      busy.value = false;
    }
  }

  return (
    <div
      class="flex-1 overflow-y-auto"
      style="padding:20px max(1rem,env(safe-area-inset-right)) 32px max(1rem,env(safe-area-inset-left))"
    >
      <nav aria-label="Breadcrumb" class="crumbs" style="margin-bottom:14px">
        <button type="button" onClick={selectObjectivesList} class="text-link">
          ← Objectives
        </button>
        <span class="sep" aria-hidden="true">
          ›
        </span>
        <span class="current">New</span>
      </nav>
      <div class="eyebrow">New objective</div>
      <h1
        class="font-display"
        style="font-size:30px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.1;margin-top:6px;margin-bottom:24px"
      >
        Create + assign
      </h1>

      <form onSubmit={onSubmit} style="display:flex;flex-direction:column;gap:18px;max-width:680px">
        <div class="field">
          <label class="field-label" for="obj-title">
            Title
          </label>
          <input
            id="obj-title"
            type="text"
            value={title.value}
            onInput={(e) => {
              title.value = (e.currentTarget as HTMLInputElement).value;
            }}
            placeholder="Fix the login redirect bug"
            class="input"
            // biome-ignore lint/a11y/noAutofocus: create-objective is a goal-oriented form; landing focus on the title skips one tab for every user
            autoFocus
          />
        </div>

        <div class="field">
          <label class="field-label" for="obj-outcome">
            Outcome <span class="req">*</span>
          </label>
          <div class="field-help">
            The tangible result that defines "done". Propagates to the assignee's tool descriptions
            and is surfaced when they go to mark complete.
          </div>
          <textarea
            id="obj-outcome"
            rows={3}
            value={outcome.value}
            onInput={(e) => {
              outcome.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="A user hitting /login while authenticated lands on /dashboard, not /login again."
            class="textarea"
            style="min-height:88px"
          />
        </div>

        <div class="field">
          <label class="field-label" for="obj-body">
            Body (optional)
          </label>
          <textarea
            id="obj-body"
            rows={4}
            value={body.value}
            onInput={(e) => {
              body.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="Additional context — links, reproductions, constraints."
            class="textarea"
          />
        </div>

        <div class="field">
          <label class="field-label" for="obj-assignee">
            Assignee
          </label>
          <select
            id="obj-assignee"
            value={assignee.value}
            onChange={(e) => {
              assignee.value = (e.currentTarget as HTMLSelectElement).value;
            }}
            class="select"
          >
            <option value="">Select a teammate…</option>
            {teammates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.role})
              </option>
            ))}
          </select>
        </div>

        <div class="field">
          <span class="field-label">Initial watchers (optional)</span>
          <div class="field-help">
            Teammates looped into the discussion thread from the start. They'll receive every
            lifecycle event and discussion post without being the assignee. Directors see everything
            automatically; don't add them here.
          </div>
          {watchers.value.length > 0 && (
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
              {watchers.value.map((w) => (
                <span key={w} class="chip">
                  <span>{w}</span>
                  <button
                    type="button"
                    class="x"
                    aria-label={`Remove watcher ${w}`}
                    style="background:transparent;border:0;padding:0;cursor:pointer"
                    onClick={() => {
                      watchers.value = watchers.value.filter((x) => x !== w);
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <select
            value=""
            onChange={(e) => {
              const cs = (e.currentTarget as HTMLSelectElement).value;
              if (!cs) return;
              if (!watchers.value.includes(cs) && cs !== assignee.value) {
                watchers.value = [...watchers.value, cs];
              }
              (e.currentTarget as HTMLSelectElement).value = '';
            }}
            class="select"
            style="margin-top:8px"
          >
            <option value="">Add a watcher…</option>
            {teammates
              .filter((t) => !watchers.value.includes(t.name) && t.name !== assignee.value)
              .map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.role})
                </option>
              ))}
          </select>
        </div>

        {err.value && (
          <div role="alert" class="callout err">
            <div class="icon" aria-hidden="true">
              ◆
            </div>
            <div class="body">
              <div class="msg">{err.value}</div>
            </div>
          </div>
        )}

        <div>
          <button type="submit" disabled={!canSubmit} class="btn btn-primary btn-lg">
            {busy.value ? 'Creating…' : 'Create + assign →'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function __resetObjectiveCreateForTests(): void {
  resetForm();
  busy.value = false;
}
