/**
 * DisconnectedBanner — surfaces stream-health problems.
 *
 * The shell no longer shows a persistent "ONLINE" indicator — connected
 * is the assumed default and we only surface UI when something is
 * wrong. Two states land here:
 *
 *   - Was connected, now disconnected → "Disconnected — trying to reconnect…"
 *   - Reconnected with backfill gap   → "Reconnected but missed X"
 *
 * We deliberately gate the disconnected message behind
 * `streamEverConnected` — the signal starts `false` on mount and stays
 * that way until the WebSocket's first `open` event fires, which
 * would otherwise cause a false-positive banner for the 50-500ms
 * between Shell mount and the first open. Once we've seen a live
 * stream, subsequent drops are real and surface immediately.
 */

import { streamBackfillError, streamConnected, streamEverConnected } from '../lib/live.js';

export function DisconnectedBanner() {
  const connected = streamConnected.value;
  const everConnected = streamEverConnected.value;
  const backfillErr = streamBackfillError.value;

  // Healthy steady state — nothing to show.
  if (connected && backfillErr === null) return null;

  // Haven't managed an initial open yet. Don't shout "disconnected"
  // during the normal connect race; once the stream is live, any
  // subsequent drop will surface immediately.
  if (!connected && !everConnected) return null;

  if (!connected) {
    return (
      <div role="status" class="callout warn flex-shrink-0" style="border-radius:0;overflow-y:auto">
        <div class="icon" aria-hidden="true">
          ◆
        </div>
        <div class="body">
          <div class="title">Disconnected</div>
          <div class="msg">The live update stream is offline — trying to reconnect…</div>
        </div>
      </div>
    );
  }

  // Connected again, but backfill failed — we're live but may have
  // missed some messages that landed during the outage.
  return (
    <div role="status" class="callout warn flex-shrink-0" style="border-radius:0;overflow-y:auto">
      <div class="icon" aria-hidden="true">
        ◆
      </div>
      <div class="body">
        <div class="title">Reconnected</div>
        <div class="msg">
          Live stream is back but missed some history: {backfillErr}. Refresh to catch up.
        </div>
      </div>
    </div>
  );
}
