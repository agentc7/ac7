/**
 * AgentTimeline — threaded view of an agent's activity stream.
 *
 * Renders the per-agent feed as a continuous chat transcript rather
 * than a list of expandable exchange cards. Successive llm_exchanges
 * share a growing prefix of messages (agent loops are prefix-stable),
 * so only the new tail is emitted per turn — the conversation reads
 * top-to-bottom without the redundancy of "each call carries its
 * whole history."
 *
 * Opaque HTTP events and objective open/close markers interleave
 * chronologically as gutter asides between messages.
 *
 * Filters:
 *   - `kindFilters` — per-event-kind toggles (LLM, HTTP, obj open,
 *     obj close). Hidden kinds are dropped before threading.
 *   - `objectiveFilter` — clip to rows that occurred while a chosen
 *     objective was open. `null` means "show everything." Populated
 *     from the set of objectives observed in the stream.
 *
 * Context-break detection: if a new exchange's request messages do
 * not extend the running prefix, we assume the runner compacted or
 * swapped context and emit a `↺ context changed` divider rather than
 * rewinding the thread.
 */

import type {
  ActivityEvent,
  ActivityRow,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesEntry,
  AnthropicUsage,
} from '@agentc7/sdk/types';
import { signal } from '@preact/signals';
import { highlightXmlTags } from '../lib/channel-highlight.js';
import {
  loadOlderMemberActivity,
  memberActivityConnected,
  memberActivityExhausted,
  memberActivityLoading,
  memberActivityRows,
} from '../lib/member-activity.js';
import { dmOther, selectThreadMessage, threadMessages } from '../lib/messages.js';
import { selectObjectiveDetail, view } from '../lib/view.js';

type KindFilter = Record<ActivityEvent['kind'], boolean>;

const DEFAULT_FILTERS: KindFilter = {
  objective_open: true,
  objective_close: true,
  llm_exchange: true,
  opaque_http: true,
};

const kindFilters = signal<KindFilter>({ ...DEFAULT_FILTERS });

/** null = all activity; otherwise clip to windows where this objective was open. */
const objectiveFilter = signal<string | null>(null);

// ── Thread model ─────────────────────────────────────────────────

type ThreadItem =
  | {
      key: string;
      variant: 'message';
      ts: number;
      role: string;
      content: AnthropicContentBlock[];
    }
  | {
      key: string;
      variant: 'exchange';
      ts: number;
      model: string | null;
      duration: number;
      usage: AnthropicUsage | null;
      stopReason: string | null;
      status: number | null;
      entry: AnthropicMessagesEntry;
    }
  | {
      key: string;
      variant: 'context-break';
      ts: number;
      droppedCount: number;
    }
  | {
      key: string;
      variant: 'objective-open';
      ts: number;
      objectiveId: string;
    }
  | {
      key: string;
      variant: 'objective-close';
      ts: number;
      objectiveId: string;
      result: 'done' | 'cancelled' | 'reassigned' | 'runner_shutdown';
    }
  | {
      key: string;
      variant: 'http';
      ts: number;
      method: string;
      host: string;
      url: string;
      status: number | null;
    };

/**
 * Collapse a chronological row stream into thread items, with
 * successive LLM exchanges deduped against their running prefix.
 * Pure for testability. Input may be in any order — sorted by ts
 * ascending internally.
 */
export function buildThread(rows: ActivityRow[]): ThreadItem[] {
  const chron = [...rows].sort((a, b) => a.event.ts - b.event.ts);
  const thread: ThreadItem[] = [];
  let runningHashes: string[] = [];
  for (const row of chron) {
    const ev = row.event;
    switch (ev.kind) {
      case 'objective_open':
        thread.push({
          key: `r${row.id}-oo`,
          variant: 'objective-open',
          ts: ev.ts,
          objectiveId: ev.objectiveId,
        });
        break;
      case 'objective_close':
        thread.push({
          key: `r${row.id}-oc`,
          variant: 'objective-close',
          ts: ev.ts,
          objectiveId: ev.objectiveId,
          result: ev.result,
        });
        break;
      case 'opaque_http': {
        const e = ev.entry;
        thread.push({
          key: `r${row.id}-http`,
          variant: 'http',
          ts: ev.ts,
          method: e.method,
          host: e.host,
          url: e.url,
          status: e.status,
        });
        break;
      }
      case 'llm_exchange': {
        const entry = ev.entry;
        const reqMsgs = entry.request.messages;
        const reqHashes = reqMsgs.map(hashMessage);

        const isExtension =
          reqHashes.length >= runningHashes.length &&
          runningHashes.every((h, i) => h === reqHashes[i]);

        const startIdx = isExtension ? runningHashes.length : 0;
        if (!isExtension && runningHashes.length > 0) {
          thread.push({
            key: `r${row.id}-break`,
            variant: 'context-break',
            ts: ev.ts,
            droppedCount: runningHashes.length,
          });
        }
        for (let i = startIdx; i < reqMsgs.length; i++) {
          const m = reqMsgs[i];
          if (!m) continue;
          thread.push({
            key: `r${row.id}-req-${i}`,
            variant: 'message',
            ts: ev.ts,
            role: m.role,
            content: m.content,
          });
        }

        const respMsgs = entry.response?.messages ?? [];
        for (let i = 0; i < respMsgs.length; i++) {
          const m = respMsgs[i];
          if (!m) continue;
          thread.push({
            key: `r${row.id}-resp-${i}`,
            variant: 'message',
            ts: ev.ts,
            role: m.role,
            content: m.content,
          });
        }

        thread.push({
          key: `r${row.id}-ex`,
          variant: 'exchange',
          ts: ev.ts,
          model: entry.request.model,
          duration: ev.duration,
          usage: entry.response?.usage ?? null,
          stopReason: entry.response?.stopReason ?? null,
          status: entry.response?.status ?? null,
          entry,
        });

        runningHashes = [...reqHashes, ...respMsgs.map(hashMessage)];
        break;
      }
    }
  }
  return thread;
}

function hashMessage(m: AnthropicMessage): string {
  return `${m.role}:${JSON.stringify(m.content)}`;
}

export interface ObjectiveSeen {
  id: string;
  result: string | null;
}

/** Objectives that appeared in the row stream, first-seen order. */
export function objectivesSeen(rows: ActivityRow[]): ObjectiveSeen[] {
  const chron = [...rows].sort((a, b) => a.event.ts - b.event.ts);
  const out = new Map<string, ObjectiveSeen>();
  for (const row of chron) {
    const ev = row.event;
    if (ev.kind === 'objective_open' && !out.has(ev.objectiveId)) {
      out.set(ev.objectiveId, { id: ev.objectiveId, result: null });
    } else if (ev.kind === 'objective_close') {
      const entry = out.get(ev.objectiveId);
      if (entry) entry.result = ev.result;
      else out.set(ev.objectiveId, { id: ev.objectiveId, result: ev.result });
    }
  }
  return [...out.values()];
}

/**
 * Clip rows to windows where `objectiveId` was open. Open and close
 * markers for the target objective are always included; anything
 * strictly between a matching open and its close (non-inclusive on
 * the far side of interleaved opens for other objectives) is kept.
 * Input and output are newest-first.
 */
export function clipToObjective(rows: ActivityRow[], objectiveId: string | null): ActivityRow[] {
  if (objectiveId === null) return rows;
  const chron = [...rows].sort((a, b) => a.event.ts - b.event.ts);
  const out: ActivityRow[] = [];
  let active = false;
  for (const row of chron) {
    const ev = row.event;
    if (ev.kind === 'objective_open' && ev.objectiveId === objectiveId) {
      active = true;
      out.push(row);
    } else if (ev.kind === 'objective_close' && ev.objectiveId === objectiveId) {
      active = false;
      out.push(row);
    } else if (active) {
      out.push(row);
    }
  }
  return [...out].sort((a, b) => b.event.ts - a.event.ts);
}

// ── Rendering ────────────────────────────────────────────────────

export function AgentTimeline() {
  const rows = memberActivityRows.value;
  const connected = memberActivityConnected.value;
  const filters = kindFilters.value;
  const objFilter = objectiveFilter.value;

  // Mirror TimelineBody's filter pipeline so the eyebrow count
  // reflects what the user actually sees rendered.
  const filteredCount = clipToObjective(rows, objFilter).filter(
    (row) => filters[row.event.kind],
  ).length;

  return (
    <section class="card" style="display:flex;flex-direction:column;gap:14px">
      <div class="eyebrow" style="display:flex;align-items:center;gap:10px">
        <span>Activity ({filteredCount})</span>
        {!connected && (
          <span class="badge ember" style="font-size:10px">
            ◆ OFFLINE
          </span>
        )}
      </div>
      <TimelineBody />
    </section>
  );
}

/**
 * The chip bar + scope picker + threaded feed + paging affordances.
 * Extracted so `<AgentTimeline />` (member-profile card) and
 * `<ActivityInspector />` (TeamShell right rail) can share rendering
 * while supplying their own header chrome.
 */
export function TimelineBody() {
  const rows = memberActivityRows.value;
  const loading = memberActivityLoading.value;
  const exhausted = memberActivityExhausted.value;
  const filters = kindFilters.value;
  const objFilter = objectiveFilter.value;

  const clipped = clipToObjective(rows, objFilter);
  const filteredRows = clipped.filter((row) => filters[row.event.kind]);
  const thread = buildThread(filteredRows);
  const objectives = objectivesSeen(rows);

  return (
    <>
      <div class="flex items-center gap-2 flex-wrap">
        {objectives.length > 0 && <ObjectiveSelect objectives={objectives} current={objFilter} />}
        <FilterBar filters={filters} />
      </div>

      {rows.length === 0 && loading && <div class="eyebrow">Loading activity…</div>}
      {rows.length === 0 && !loading && (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);font-style:italic">
          No activity yet — the runner hasn't observed any traffic for this slot.
        </div>
      )}

      {rows.length > 0 && !exhausted && (
        <div>
          <button
            type="button"
            onClick={() => void loadOlderMemberActivity()}
            disabled={loading}
            class="btn btn-ghost btn-sm"
          >
            {loading ? 'Loading…' : '↑ Load older'}
          </button>
        </div>
      )}

      <ol style="display:flex;flex-direction:column;gap:4px;list-style:none;padding:0;margin:0">
        {thread.map((item) => (
          <li key={item.key}>
            <ThreadItemView item={item} />
          </li>
        ))}
      </ol>

      {exhausted && rows.length > 0 && (
        <div style="font-family:var(--f-sans);font-size:12px;color:var(--muted);font-style:italic">
          — end of activity —
        </div>
      )}
    </>
  );
}

function ObjectiveSelect({
  objectives,
  current,
}: {
  objectives: ObjectiveSeen[];
  current: string | null;
}) {
  return (
    <select
      aria-label="Objective filter"
      value={current ?? ''}
      onChange={(e) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        objectiveFilter.value = v === '' ? null : v;
      }}
      style="font-family:var(--f-mono);font-size:12px;padding:2px 6px;border:1px solid var(--rule);background:var(--ice);color:var(--ink);border-radius:var(--r-sm)"
    >
      <option value="">all activity</option>
      {objectives.map((o) => (
        <option key={o.id} value={o.id}>
          {o.id} · {o.result ?? 'open'}
        </option>
      ))}
    </select>
  );
}

function FilterBar({ filters }: { filters: KindFilter }) {
  const kinds: Array<{ key: ActivityEvent['kind']; label: string }> = [
    { key: 'llm_exchange', label: 'LLM' },
    { key: 'opaque_http', label: 'HTTP' },
    { key: 'objective_open', label: 'obj open' },
    { key: 'objective_close', label: 'obj close' },
  ];
  return (
    <div class="flex items-center gap-2 flex-wrap">
      {kinds.map(({ key, label }) => {
        const on = filters[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => {
              kindFilters.value = { ...filters, [key]: !on };
            }}
            class={`badge ${on ? 'solid' : 'soft'}`}
            style="cursor:pointer"
          >
            {on ? '●' : '○'} {label}
          </button>
        );
      })}
    </div>
  );
}

function ThreadItemView({ item }: { item: ThreadItem }) {
  switch (item.variant) {
    case 'objective-open':
      return (
        <div
          class="flex items-center gap-3"
          style="font-family:var(--f-mono);font-size:12px;color:var(--steel);border-left:2px solid var(--steel);padding:6px 12px"
        >
          <span>{formatTs(item.ts)}</span>
          <span>▼</span>
          <button
            type="button"
            onClick={() => selectObjectiveDetail(item.objectiveId)}
            style="background:transparent;color:var(--steel);font-family:inherit;font-size:inherit;padding:0"
          >
            {item.objectiveId}
          </button>
          <span style="color:var(--muted)">opened</span>
        </div>
      );
    case 'objective-close':
      return (
        <div
          class="flex items-center gap-3"
          style="font-family:var(--f-mono);font-size:12px;color:var(--muted);border-left:2px solid var(--rule);padding:6px 12px"
        >
          <span>{formatTs(item.ts)}</span>
          <span>▲</span>
          <button
            type="button"
            onClick={() => selectObjectiveDetail(item.objectiveId)}
            style="background:transparent;color:var(--ink);font-family:inherit;font-size:inherit;padding:0"
          >
            {item.objectiveId}
          </button>
          <span>closed ({item.result})</span>
        </div>
      );
    case 'http':
      return (
        <div style="font-family:var(--f-mono);font-size:12px;border-left:2px solid var(--rule-strong);padding:6px 12px">
          <span style="color:var(--muted)">{formatTs(item.ts)}</span>{' '}
          <span style="color:var(--ink)">{item.method}</span>{' '}
          <span style="color:var(--muted)">{item.host}</span>
          <span style="color:var(--ink)">{item.url}</span>
          {item.status !== null && (
            <span style="margin-left:8px;color:var(--steel)">{item.status}</span>
          )}
        </div>
      );
    case 'context-break':
      return (
        <div style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);padding:8px 0;border-top:1px dashed var(--rule);border-bottom:1px dashed var(--rule);margin:6px 0;text-align:center;font-style:italic">
          ↺ context changed — {item.droppedCount} prior message
          {item.droppedCount === 1 ? '' : 's'} dropped from thread
        </div>
      );
    case 'exchange':
      return <ExchangeMarker item={item} />;
    case 'message':
      return <ThreadMessage role={item.role} content={item.content} />;
  }
}

function ThreadMessage({ role, content }: { role: string; content: AnthropicContentBlock[] }) {
  return (
    <div style={`border-left:2px solid ${roleBorder(role)};padding:6px 10px`}>
      <div class="eyebrow" style="margin-bottom:3px">
        {role}
      </div>
      {content.map((block, i) => (
        <ContentBlock key={i} block={block} />
      ))}
    </div>
  );
}

function roleBorder(role: string): string {
  if (role === 'user') return 'var(--steel)';
  if (role === 'assistant') return 'var(--ember)';
  if (role === 'system') return 'var(--muted)';
  return 'var(--rule-strong)';
}

function ExchangeMarker({ item }: { item: Extract<ThreadItem, { variant: 'exchange' }> }) {
  return (
    <details style="margin:4px 0;padding:4px 0;border-top:1px dashed var(--rule);border-bottom:1px dashed var(--rule)">
      <summary
        class="flex items-center gap-3 flex-wrap"
        style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer;padding:2px 0"
        onClick={() => jumpToMessageForExchange(item.ts, item.duration)}
      >
        <span>
          {formatTs(item.ts)} · {item.duration}ms
        </span>
        <span style="color:var(--ink);font-weight:600">{item.model ?? '?'}</span>
        {item.usage && (
          <span>
            in={item.usage.inputTokens ?? '?'} out={item.usage.outputTokens ?? '?'}
            {item.usage.cacheReadInputTokens !== null && item.usage.cacheReadInputTokens > 0 && (
              <> cache_hit={item.usage.cacheReadInputTokens}</>
            )}
          </span>
        )}
        {item.stopReason && <span>stop={item.stopReason}</span>}
        {item.status !== null && item.status !== 200 && (
          <span style="color:var(--err)">status={item.status}</span>
        )}
      </summary>
      <div style="margin-top:6px;padding:6px 0;font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);display:flex;flex-direction:column;gap:4px">
        {item.entry.request.system && (
          <details>
            <summary style="cursor:pointer;color:var(--muted)">system prompt</summary>
            <pre style="white-space:pre-wrap;margin-top:4px;color:var(--ink)">
              {item.entry.request.system}
            </pre>
          </details>
        )}
        <div>
          max_tokens={item.entry.request.maxTokens ?? '?'}, temperature=
          {item.entry.request.temperature ?? '?'}
        </div>
        {item.entry.request.tools && item.entry.request.tools.length > 0 && (
          <details>
            <summary style="cursor:pointer;color:var(--muted)">
              {item.entry.request.tools.length} tool
              {item.entry.request.tools.length === 1 ? '' : 's'}
            </summary>
            <pre style="white-space:pre-wrap;margin-top:4px">
              {item.entry.request.tools.map((t) => t.name).join(', ')}
            </pre>
          </details>
        )}
      </div>
    </details>
  );
}

function ContentBlock({ block }: { block: AnthropicContentBlock }) {
  if (block.type === 'text') {
    const highlighted = highlightXmlTags(block.text);
    if (highlighted !== null) {
      return (
        <pre
          style="font-family:var(--f-mono);font-size:12px;color:var(--ink);white-space:pre-wrap"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      );
    }
    return (
      <pre style="font-family:var(--f-mono);font-size:12px;color:var(--ink);white-space:pre-wrap">
        {block.text}
      </pre>
    );
  }
  if (block.type === 'tool_use') {
    return (
      <div style="font-size:12px">
        <span style="color:var(--steel)">tool_use</span>{' '}
        <span style="color:var(--ink)">{block.name}</span>{' '}
        <span style="color:var(--muted)">({block.id})</span>
        <pre style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap;margin-top:2px">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === 'tool_result') {
    return (
      <div style="font-size:12px">
        <span style={`color:var(${block.isError ? '--err' : '--steel'})`}>tool_result</span>{' '}
        <span style="color:var(--muted)">({block.toolUseId})</span>
        <pre style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap;margin-top:2px">
          {typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === 'thinking') {
    return (
      <div style="font-size:12px;color:var(--muted);font-style:italic">
        thinking:{' '}
        <pre style="white-space:pre-wrap;font-family:var(--f-mono);display:inline">
          {block.text}
        </pre>
      </div>
    );
  }
  if (block.type === 'image') {
    return (
      <div style="font-size:12px;color:var(--muted);font-style:italic">
        [image{block.mediaType ? ` ${block.mediaType}` : ''}]
      </div>
    );
  }
  return (
    <div style="font-size:12px;color:var(--muted);font-style:italic">
      [unknown block: {JSON.stringify(block.raw).slice(0, 60)}…]
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(11, 19);
}

/**
 * Heuristic mapping from an `llm_exchange` row to the agent's
 * outgoing thread message. We don't store an exchange-id on the
 * Message, so we match by closeness in time: the agent posts to the
 * thread right after generating, so the right message is the inspected
 * peer's earliest message at or after the exchange's end time.
 *
 * Noops outside DM threads — the activity feed also renders inside
 * member-profile cards where there's no thread to jump into.
 */
const SELECTION_WINDOW_MS = 60_000;
function jumpToMessageForExchange(exchangeTs: number, duration: number): void {
  const v = view.peek();
  if (v.kind !== 'thread') return;
  const peer = dmOther(v.key);
  if (peer === null) return;
  const target = exchangeTs + duration;
  let best: { id: string; diff: number } | null = null;
  for (const m of threadMessages(v.key)) {
    if (m.from !== peer) continue;
    const diff = Math.abs(m.ts - target);
    if (diff > SELECTION_WINDOW_MS) continue;
    if (best === null || diff < best.diff) best = { id: m.id, diff };
  }
  selectThreadMessage(best?.id ?? null);
}

/** Test-only reset so unit tests start clean. */
export function __resetAgentTimelineForTests(): void {
  kindFilters.value = { ...DEFAULT_FILTERS };
  objectiveFilter.value = null;
}
