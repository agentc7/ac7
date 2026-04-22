/**
 * JWKS-backed JWT verification for team-scoped access tokens.
 *
 * ac7 is Clerk-agnostic: we trust any issuer that publishes an
 * RS256 JWKS at a URL we hold in config. Today the SaaS platform
 * (app.agentc7.com) is the expected issuer, but self-hosted ac7
 * instances use the same middleware against whatever JWKS URL
 * their operator pins. The OSS server itself doesn't know or care
 * that Clerk exists.
 *
 * Scope: verification only. Minting tokens is the SaaS's job; the
 * OSS broker never holds a signing key.
 *
 * Claim contract (locked in `SAAS-PLATFORM.md §3`):
 *   - iss      — matches config.issuer
 *   - aud      — matches config.audience (typically `team:<team-id>`)
 *   - sub      — Clerk user id (logged for audit; no local meaning)
 *   - member   — the member name inside this team; must exist in the
 *                roster or the request is rejected
 *   - role     — informational; authorization still runs off the
 *                resolved LoadedMember's permission grants
 *   - iat/exp/nbf/jti — standard JWT metadata
 *
 * Why name-based `member` instead of a stable id: the SaaS already
 * mints `member` against `LoadedMember.name`, and tokens are
 * short-lived, so the rename-invalidates-outstanding-tokens window
 * is a non-issue in practice. Switching to a stable id would add a
 * mapping layer on both sides for no user-visible win.
 */

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

export interface JwtConfig {
  /** Expected `iss` claim — e.g., `https://app.agentc7.com`. */
  issuer: string;
  /** Expected `aud` claim — typically `team:<this-team-id>`. */
  audience: string;
  /** Absolute URL of the issuer's JWKS document. */
  jwksUrl: string;
}

export interface JwtVerifier {
  verify(token: string): Promise<VerifiedClaims>;
}

export interface VerifiedClaims {
  /** The `member` claim — resolves to a LoadedMember by name. */
  member: string;
  /** The `sub` claim — opaque account identifier, logged for audit. */
  subject: string;
  /** Raw payload, for callers that want the whole object. */
  payload: JWTPayload;
}

export class JwtClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtClaimError';
  }
}

/**
 * Build a verifier against a remote JWKS. The JWKS is fetched lazily
 * on first use and cached internally by `jose` (keyed on `kid`). A
 * signing key rotation on the issuer side is picked up automatically
 * — `jose` refetches when it sees a kid it doesn't know.
 *
 * Throws on verification failure (bad signature, wrong iss/aud,
 * expired, not-yet-valid). The caller is expected to return 401.
 */
export function createJwtVerifier(config: JwtConfig): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  return {
    async verify(token: string): Promise<VerifiedClaims> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
      });
      const member = payload.member;
      if (typeof member !== 'string' || member.length === 0) {
        throw new JwtClaimError('jwt missing `member` claim');
      }
      const subject = payload.sub;
      if (typeof subject !== 'string' || subject.length === 0) {
        throw new JwtClaimError('jwt missing `sub` claim');
      }
      return { member, subject, payload };
    },
  };
}

/**
 * Cheap structural check: true iff the string looks like three
 * base64url-encoded segments joined by dots. Used to disambiguate
 * opaque ac7 bearer tokens from JWTs inside the same
 * `Authorization: Bearer` header. Opaque tokens never contain dots,
 * so the test is exact in practice.
 */
const JWT_STRUCTURE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function looksLikeJwt(raw: string): boolean {
  return JWT_STRUCTURE.test(raw);
}
