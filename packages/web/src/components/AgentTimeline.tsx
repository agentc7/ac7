/**
 * AgentTimeline — live feed of an agent's activity stream.
 *
 * Renders rows from `agentActivityRows` (newest-first) with visual
 * differentiation per event kind:
 *
 *   - `objective_open`  — green bracket marker
 *   - `objective_close` — muted bracket marker with the terminal
 *     reason (done / cancelled / reassigned / runner_shutdown)
 *   - `llm_exchange`    — expandable card with model, token
 *     usage, and the full message list (reuses the same content
 *     block renderer as TracePanel)
 *   - `opaque_http`     — one-line method / host / url / status
 *
 * The filter bar toggles kinds in the rendered output — the
 * underlying list isn't refetched, so toggling back shows
 * everything instantly without a round trip.
 *
 * "Load older" button at the bottom calls
 * `loadOlderAgentActivity()` which extends the list with a
 * time-range query against the server.
 *
 * All data comes from the `lib/agent-activity.js` signals —
 * component is dumb, just renders the current state.
 */

import type {
  AgentActivityEvent,
  AgentActivityLlmExchange,
  AgentActivityObjectiveClose,
  AgentActivityObjectiveOpen,
  AgentActivityOpaqueHttp,
  AgentActivityRow,
  AnthropicContentBlock,
  AnthropicMessagesEntry,
} from '@agentc7/sdk/types';
import { signal } from '@preact/signals';
import {
  agentActivityConnected,
  agentActivityExhausted,
  agentActivityLoading,
  agentActivityRows,
  loadOlderAgentActivity,
} from '../lib/agent-activity.js';
import { highlightXmlTags } from '../lib/channel-highlight.js';
import { selectObjectiveDetail } from '../lib/view.js';

type KindFilter = Record<AgentActivityEvent['kind'], boolean>;

const DEFAULT_FILTERS: KindFilter = {
  objective_open: true,
  objective_close: true,
  llm_exchange: true,
  opaque_http: true,
};

const kindFilters = signal<KindFilter>({ ...DEFAULT_FILTERS });

export function AgentTimeline() {
  const rows = agentActivityRows.value;
  const loading = agentActivityLoading.value;
  const connected = agentActivityConnected.value;
  const exhausted = agentActivityExhausted.value;
  const filters = kindFilters.value;

  const filteredRows = rows.filter((row) => filters[row.event.kind]);

  return (
    <section class="card" style="display:flex;flex-direction:column;gap:14px">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <div class="eyebrow" style="display:flex;align-items:center;gap:10px">
          <span>Activity ({filteredRows.length})</span>
          {!connected && (
            <span class="badge ember" style="font-size:10px">
              ◆ OFFLINE
            </span>
          )}
        </div>
        <FilterBar filters={filters} />
      </div>

      {rows.length === 0 && loading && <div class="eyebrow">Loading activity…</div>}
      {rows.length === 0 && !loading && (
        <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);font-style:italic">
          No activity yet — the runner hasn't observed any traffic for this slot.
        </div>
      )}

      <ol style="display:flex;flex-direction:column;gap:8px;list-style:none;padding:0;margin:0">
        {filteredRows.map((row) => (
          <li key={row.id}>
            <RowRenderer row={row} />
          </li>
        ))}
      </ol>

      {rows.length > 0 && !exhausted && (
        <div>
          <button
            type="button"
            onClick={() => void loadOlderAgentActivity()}
            disabled={loading}
            class="btn btn-ghost btn-sm"
          >
            {loading ? 'Loading…' : '↓ Load older'}
          </button>
        </div>
      )}
      {exhausted && rows.length > 0 && (
        <div style="font-family:var(--f-sans);font-size:12px;color:var(--muted);font-style:italic">
          — end of activity —
        </div>
      )}
    </section>
  );
}

function FilterBar({ filters }: { filters: KindFilter }) {
  const kinds: Array<{ key: AgentActivityEvent['kind']; label: string }> = [
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

function RowRenderer({ row }: { row: AgentActivityRow }) {
  const event = row.event;
  switch (event.kind) {
    case 'objective_open':
      return <ObjectiveOpenRow event={event} />;
    case 'objective_close':
      return <ObjectiveCloseRow event={event} />;
    case 'llm_exchange':
      return <LlmExchangeRow event={event} />;
    case 'opaque_http':
      return <OpaqueHttpRow event={event} />;
  }
}

function ObjectiveOpenRow({ event }: { event: AgentActivityObjectiveOpen }) {
  return (
    <div
      class="flex items-center gap-3"
      style="font-family:var(--f-mono);font-size:12px;color:var(--steel);border-left:2px solid var(--steel);padding:6px 12px"
    >
      <span>{formatTs(event.ts)}</span>
      <span>▼</span>
      <button
        type="button"
        onClick={() => selectObjectiveDetail(event.objectiveId)}
        style="background:transparent;color:var(--steel);font-family:inherit;font-size:inherit;padding:0"
      >
        {event.objectiveId}
      </button>
      <span style="color:var(--muted)">opened</span>
    </div>
  );
}

function ObjectiveCloseRow({ event }: { event: AgentActivityObjectiveClose }) {
  return (
    <div
      class="flex items-center gap-3"
      style="font-family:var(--f-mono);font-size:12px;color:var(--muted);border-left:2px solid var(--rule);padding:6px 12px"
    >
      <span>{formatTs(event.ts)}</span>
      <span>▲</span>
      <button
        type="button"
        onClick={() => selectObjectiveDetail(event.objectiveId)}
        style="background:transparent;color:var(--ink);font-family:inherit;font-size:inherit;padding:0"
      >
        {event.objectiveId}
      </button>
      <span>closed ({event.result})</span>
    </div>
  );
}

function LlmExchangeRow({ event }: { event: AgentActivityLlmExchange }) {
  const usage = event.entry.response?.usage;
  return (
    <div style="border:1px solid var(--rule);border-radius:var(--r-sm);background:var(--ice);padding:12px">
      <div
        class="flex items-center justify-between"
        style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);flex-wrap:wrap;gap:6px"
      >
        <span>
          {formatTs(event.ts)} · {event.duration}ms
        </span>
        <span>
          <span style="color:var(--ink);font-weight:600">{event.entry.request.model ?? '?'}</span>
          {usage && (
            <span style="margin-left:8px">
              in={usage.inputTokens ?? '?'} out={usage.outputTokens ?? '?'}
              {usage.cacheReadInputTokens !== null && usage.cacheReadInputTokens > 0 && (
                <span> cache_hit={usage.cacheReadInputTokens}</span>
              )}
            </span>
          )}
          {event.entry.response?.stopReason && (
            <span style="margin-left:8px">stop={event.entry.response.stopReason}</span>
          )}
        </span>
      </div>
      <div style="margin-top:8px">
        <AnthropicEntryView entry={event.entry} />
      </div>
    </div>
  );
}

function OpaqueHttpRow({ event }: { event: AgentActivityOpaqueHttp }) {
  const entry = event.entry;
  return (
    <div style="font-family:var(--f-mono);font-size:12px;border-left:2px solid var(--rule-strong);padding:6px 12px">
      <span style="color:var(--muted)">{formatTs(event.ts)}</span>{' '}
      <span style="color:var(--ink)">{entry.method}</span>{' '}
      <span style="color:var(--muted)">{entry.host}</span>
      <span style="color:var(--ink)">{entry.url}</span>
      {entry.status !== null && (
        <span style="margin-left:8px;color:var(--steel)">{entry.status}</span>
      )}
    </div>
  );
}

// ── Shared Anthropic entry renderer ──────────────────────────────
//
// Duplicated from TracePanel.tsx to keep the two components
// independent. A later refactor can hoist these into a shared
// `AnthropicEntryView` module; for now the duplication is ~80 lines
// and isn't hurting anything.

function AnthropicEntryView({ entry }: { entry: AnthropicMessagesEntry }) {
  return (
    <div style="border-left:2px solid var(--steel);padding-left:8px">
      {entry.request.system && (
        <details style="margin-top:4px">
          <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
            system prompt
          </summary>
          <pre style="font-family:var(--f-mono);font-size:11.5px;color:var(--ink);white-space:pre-wrap;margin-top:4px">
            {entry.request.system}
          </pre>
        </details>
      )}
      <details style="margin-top:4px">
        <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
          messages ({entry.request.messages.length + (entry.response?.messages.length ?? 0)})
        </summary>
        <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
          {entry.request.messages.map((m, i) => (
            <MessageBlock key={`req-${i}`} role={m.role} content={m.content} />
          ))}
          {entry.response?.messages.map((m, i) => (
            <MessageBlock key={`resp-${i}`} role={m.role} content={m.content} />
          ))}
        </div>
      </details>
    </div>
  );
}

function MessageBlock({ role, content }: { role: string; content: AnthropicContentBlock[] }) {
  return (
    <div style="border-left:1px solid var(--rule);padding-left:10px;font-size:12px">
      <div class="eyebrow">{role}</div>
      {content.map((block, i) => (
        <ContentBlock key={i} block={block} />
      ))}
    </div>
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

/** Test-only reset for filters so unit tests start clean. */
export function __resetAgentTimelineForTests(): void {
  kindFilters.value = { ...DEFAULT_FILTERS };
}
