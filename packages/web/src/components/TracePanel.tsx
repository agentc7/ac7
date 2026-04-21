/**
 * TracePanel — admin-only view of captured LLM traces for an
 * objective.
 *
 * In the activity-stream architecture, an "objective trace" is a
 * **time-range slice** of the assignee's agent activity stream
 * rather than a separately-stored table. We query
 * `GET /users/<assignee>/activity` with:
 *
 *   - `from = objective.createdAt`
 *   - `to   = objective.completedAt ?? now`
 *   - `kind = llm_exchange`
 *
 * and render the resulting LLM exchanges.
 *
 * UserType gate is enforced in two places:
 *   - Client: the parent `ObjectiveDetail` only mounts us when
 *     `briefing.userType === 'admin'`.
 *   - Server: `GET /users/:name/activity` returns 403 to any
 *     non-admin reading another user.
 *
 * The trace content is already redacted at runner upload time.
 */

import type {
  ActivityLlmExchange,
  AnthropicContentBlock,
  AnthropicMessagesEntry,
  Objective,
} from '@agentc7/sdk/types';
import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { highlightXmlTags } from '../lib/channel-highlight.js';
import { getClient } from '../lib/client.js';

const exchanges = signal<ActivityLlmExchange[]>([]);
const loading = signal(false);
const loadError = signal<string | null>(null);
const expanded = signal(true);

async function loadExchanges(objective: Objective): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    // `completedAt` is set iff status === 'done'. For cancelled or
    // still-active objectives we widen the upper bound to "now"
    // so recent activity lands in the view.
    const to = objective.completedAt ?? Date.now();
    const rows = await getClient().listActivity(objective.assignee, {
      from: objective.createdAt,
      to,
      kind: 'llm_exchange',
      limit: 500,
    });
    // The server returns newest-first; we want to render
    // oldest-first so the conversation reads top-down.
    const ordered = [...rows].reverse();
    exchanges.value = ordered
      .map((row) => row.event)
      .filter((ev): ev is ActivityLlmExchange => ev.kind === 'llm_exchange');
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

export interface TracePanelProps {
  objective: Objective;
}

export function TracePanel({ objective }: TracePanelProps): JSX.Element {
  const list = exchanges.value;
  const isLoading = loading.value;
  const err = loadError.value;
  const isOpen = expanded.value;

  useEffect(() => {
    void loadExchanges(objective);
  }, [objective.id, objective.completedAt]);

  const header = (
    <button
      type="button"
      onClick={() => {
        expanded.value = !expanded.value;
      }}
      class="w-full flex items-center justify-between"
      style="background:transparent;padding:0"
    >
      <span class="eyebrow">LLM exchanges ({list.length})</span>
      <span style="font-family:var(--f-mono);font-size:14px;color:var(--muted)">
        {isOpen ? '−' : '+'}
      </span>
    </button>
  );

  return (
    <section style="display:flex;flex-direction:column;gap:12px">
      {header}
      {isOpen && (
        <div style="display:flex;flex-direction:column;gap:8px">
          {isLoading && <div class="eyebrow">Loading exchanges…</div>}
          {err !== null && (
            <div class="callout err" role="alert">
              <div class="icon" aria-hidden="true">
                ◆
              </div>
              <div class="body">
                <div class="msg">{err}</div>
              </div>
            </div>
          )}
          {!isLoading && err === null && list.length === 0 && (
            <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);font-style:italic">
              No LLM exchanges captured during this objective
            </div>
          )}
          {list.map((exchange, i) => (
            <ExchangeRow key={`${exchange.ts}-${i}`} exchange={exchange} />
          ))}
        </div>
      )}
    </section>
  );
}

function ExchangeRow({ exchange }: { exchange: ActivityLlmExchange }): JSX.Element {
  return (
    <div class="card" style="padding:12px">
      <div
        class="flex items-center justify-between"
        style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted)"
      >
        <span>
          {new Date(exchange.ts).toISOString().replace('T', ' ').slice(0, 19)} · {exchange.duration}
          ms
        </span>
      </div>
      <div style="margin-top:8px">
        <AnthropicEntryView entry={exchange.entry} />
      </div>
    </div>
  );
}

function AnthropicEntryView({ entry }: { entry: AnthropicMessagesEntry }): JSX.Element {
  const usage = entry.response?.usage;
  return (
    <div style="border-left:2px solid var(--steel);padding-left:8px">
      <div style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted)">
        <span style="color:var(--ink);font-weight:600">{entry.request.model ?? '?'}</span>
        {usage && (
          <span style="margin-left:8px">
            in={usage.inputTokens ?? '?'} out={usage.outputTokens ?? '?'}
            {usage.cacheReadInputTokens !== null && usage.cacheReadInputTokens > 0 && (
              <span> cache_hit={usage.cacheReadInputTokens}</span>
            )}
          </span>
        )}
        {entry.response?.stopReason && (
          <span style="margin-left:8px">stop={entry.response.stopReason}</span>
        )}
      </div>
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
      <details style="margin-top:4px" open>
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

function MessageBlock({
  role,
  content,
}: {
  role: string;
  content: AnthropicContentBlock[];
}): JSX.Element {
  return (
    <div style="border-left:1px solid var(--rule);padding-left:10px;font-size:12px">
      <div class="eyebrow">{role}</div>
      {content.map((block, i) => (
        <ContentBlock key={i} block={block} />
      ))}
    </div>
  );
}

function ContentBlock({ block }: { block: AnthropicContentBlock }): JSX.Element {
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
