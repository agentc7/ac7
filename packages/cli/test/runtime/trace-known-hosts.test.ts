/**
 * Allowlist predicate tests — pin the hostnames the trace proxy is
 * willing to MITM-decrypt. The proxy itself takes the predicate by
 * injection, but the production wiring (`host.ts`) uses this exact
 * function; if the predicate's behavior changes silently, agents stop
 * generating structured LLM traces or, worse, the proxy starts
 * decrypting hosts we promised it wouldn't.
 */

import { describe, expect, it } from 'vitest';
import { isKnownLlmHost, KNOWN_LLM_HOST_PATTERNS } from '../../src/runtime/trace/known-hosts.js';

describe('isKnownLlmHost', () => {
  it('matches the Anthropic apex and its subdomains', () => {
    expect(isKnownLlmHost('anthropic.com')).toBe(true);
    expect(isKnownLlmHost('api.anthropic.com')).toBe(true);
    expect(isKnownLlmHost('console.anthropic.com')).toBe(true);
    expect(isKnownLlmHost('auth.anthropic.com')).toBe(true);
  });

  it('matches the OpenAI apex and its subdomains', () => {
    expect(isKnownLlmHost('openai.com')).toBe(true);
    expect(isKnownLlmHost('api.openai.com')).toBe(true);
    expect(isKnownLlmHost('auth.openai.com')).toBe(true);
  });

  it('matches Azure OpenAI customer subdomains', () => {
    expect(isKnownLlmHost('example.openai.azure.com')).toBe(true);
    expect(isKnownLlmHost('my-deployment.openai.azure.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isKnownLlmHost('API.ANTHROPIC.COM')).toBe(true);
    expect(isKnownLlmHost('Api.Openai.Com')).toBe(true);
  });

  it('rejects hosts not on the allowlist', () => {
    expect(isKnownLlmHost('github.com')).toBe(false);
    expect(isKnownLlmHost('api.github.com')).toBe(false);
    expect(isKnownLlmHost('example.com')).toBe(false);
    expect(isKnownLlmHost('telemetry.example.com')).toBe(false);
    expect(isKnownLlmHost('registry.npmjs.org')).toBe(false);
  });

  it('does NOT match suffix tricks (anthropic.com-as-prefix attacks)', () => {
    // `anthropic.com.evil.com` ends with `.com`, not `anthropic.com`.
    // The regex anchors the apex on the right and requires either
    // line-start or a `.` separator on the left.
    expect(isKnownLlmHost('anthropic.com.evil.com')).toBe(false);
    expect(isKnownLlmHost('evil-anthropic.com')).toBe(false);
    expect(isKnownLlmHost('xanthropic.com')).toBe(false);
    expect(isKnownLlmHost('openai.com.attacker.net')).toBe(false);
  });

  it('rejects empty / malformed input safely', () => {
    expect(isKnownLlmHost('')).toBe(false);
  });

  it('exports the underlying patterns so callers can introspect', () => {
    expect(KNOWN_LLM_HOST_PATTERNS.length).toBeGreaterThan(0);
    // Sanity: each pattern is a RegExp.
    for (const p of KNOWN_LLM_HOST_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});
