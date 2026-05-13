/**
 * Allowlist of hosts whose HTTPS traffic the trace proxy decrypts.
 *
 * The proxy itself is host-agnostic: it accepts `CONNECT host:port`,
 * dials upstream, and pipes bytes. The decision of "decrypt this
 * session" vs "pass it through unmodified" is gated by the predicate
 * exported here. Hosts that match get MITM'd — the proxy terminates
 * TLS on both sides, captures plaintext, and runs the request/response
 * pair through the reassembler + decoders. Hosts that don't match get
 * a raw TCP tunnel: the agent's TLS client talks to the real upstream
 * cert end-to-end, system trust applies, no plaintext is observed.
 *
 * Why an allowlist instead of decrypting everything:
 *   - The honest privacy claim is "ac7 decrypts traffic to known LLM
 *     providers." That's only defensible if non-LLM hosts genuinely
 *     bypass our TLS termination.
 *   - Non-LLM HTTPS calls (git fetch, package installs, telemetry,
 *     arbitrary curl/wget from agents) "just work" with system trust
 *     and don't require us to ship CA-bundle env vars per-tool.
 *   - The activity feed only shows traffic we actually want to inspect.
 *
 * The bar for adding a host:
 *   The agent (or its bundled tools) makes inference-related calls to
 *   it — model invocations, token refresh against the same provider,
 *   provider-specific telemetry that the trace pipeline knows how to
 *   parse. Hosts we just "happen to see" because the agent shells out
 *   to them do NOT belong here.
 *
 * Patterns match the CONNECT target hostname (no port, no scheme).
 * Use `(?:^|\.)domain$` to match the apex and any subdomain.
 */

export const KNOWN_LLM_HOST_PATTERNS: readonly RegExp[] = [
  // Anthropic — `api.anthropic.com` for /v1/messages, plus auth/console
  // subdomains used during token refresh.
  /(?:^|\.)anthropic\.com$/i,
  // OpenAI — `api.openai.com` for chat/completions, `auth.openai.com`
  // for codex token refresh. The wildcard covers both without listing
  // each subdomain.
  /(?:^|\.)openai\.com$/i,
  // Azure OpenAI — customer-specific subdomains under
  // `*.openai.azure.com`.
  /(?:^|\.)openai\.azure\.com$/i,
];

/**
 * True if `host` is on the LLM allowlist and should be MITM-decrypted.
 *
 * Accepts the raw hostname from a CONNECT line (no port, no scheme).
 * Falls back to literal compare so callers don't have to worry about
 * regex specials in `host`.
 */
export function isKnownLlmHost(host: string): boolean {
  if (host.length === 0) return false;
  for (const pattern of KNOWN_LLM_HOST_PATTERNS) {
    if (pattern.test(host)) return true;
  }
  return false;
}
