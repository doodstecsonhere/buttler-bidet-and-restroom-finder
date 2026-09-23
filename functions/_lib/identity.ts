// Buttler 2.0 — Stage 13 authentication boundary (the ONE swap point).
//
// This file is the entire seam between "the app trusts nobody" and "we know who
// is asking." Everything else in Stage 13 treats an `Identity` as already
// verified and trusted; producing that `Identity` is THIS file's job and it is
// the only place that knows how a request proves who it is. The provider choice
// (Auth0, per docs/auth-provider-selection.md) is deliberately quarantined here
// so the rest of Buttler stays provider-independent.
//
// WHAT CHANGED AT THIS STEP (identity adapter only):
//   Auth0 is now the configured provider, but ONLY activates when the owner
//   supplies its non-secret configuration (AUTH0_DOMAIN + AUTH0_API_AUDIENCE).
//   Access to a protected route is granted by cryptographically verifying the
//   caller's Auth0 RS256 access token LOCALLY against Auth0's public JWKS — no
//   client secret, no Management-API call per request, no trusting any
//   caller-supplied id/role header.
//
// THE FAIL-CLOSED CONTRACT (unchanged, and the reason tests still see 503):
//   - No Auth0 config  -> `{ configured: false }`. Handlers answer 503
//     ("contributions are not open yet"). This is production reality until the
//     owner adds the env vars AND separately enables the contribution schema.
//   - Config present but the caller has no/invalid token -> `{ configured: true,
//     identity: null }`. Handlers answer 401. Never an anonymous pass.
//   - Config present and a valid token -> `{ configured: true, identity }` where
//     `identity.userId` is the immutable Auth0 `sub` and the role comes ONLY from
//     the server-side allow-list. Verifying identity does NOT by itself open
//     contribution writes: those still need the staged schema, which remains out
//     of d1/migrations/ and guarded by scripts/d1-schema.test.mjs.
//
// WHY NO `nonce` CHECK:
//   A nonce belongs to the browser-side OIDC flow (ID token). Here we verify an
//   OAuth2 *bearer access token* presented to the API, whose job is to prove
//   "this request is allowed to call the Buttler API." The claims that carry
//   that meaning are signature, iss, aud, and exp — all enforced below. Requiring
//   a nonce on an access token would reject valid tokens and buy no security.

import type { Identity, Role } from "../../lib/contributions/authorize.ts";

// Env this layer reads. Names only — values are never logged or committed.
export interface AuthEnv {
  // Opaque comma-separated list of provider subject ids allowed to moderate.
  // Empty/absent means "no moderators", which fails closed. Not a secret, but
  // keep it server-side (it must not appear in any client-visible bundle).
  BUTTLER_MODERATOR_IDS?: string;
  // Auth0 tenant domain, e.g. `your-tenant.region.auth0.com` (scheme optional).
  // Not a secret. Drives BOTH the expected issuer and the JWKS URL.
  AUTH0_DOMAIN?: string;
  // The Auth0 API identifier that the browser requests as the token `aud`.
  // Not a secret. Absent => the adapter reports "not configured" (fail closed).
  AUTH0_API_AUDIENCE?: string;
  // Public application client id. Not required to verify an access token; when
  // present it is cross-checked against the token's `azp` as defense-in-depth.
  AUTH0_CLIENT_ID?: string;
}

export type IdentityResolution =
  // A provider IS configured and this caller is (or is not) signed in.
  | { configured: true; identity: Identity | null }
  // No provider is wired yet: protected routes must fail closed with 503 so no
  // anonymous or fake-authenticated write can ever slip through.
  | { configured: false };

// --- Provider wiring -------------------------------------------------------

interface JsonWebKey2048 {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface Jwks {
  keys: JsonWebKey2048[];
}

// Injection seam so the automated tests can verify real RS256 signatures against
// a locally generated key set WITHOUT contacting the live Auth0 tenant. The
// production path supplies a cached network fetcher; nothing else differs.
export interface IdentityDeps {
  fetchJwks: (url: string, force?: boolean) => Promise<Jwks>;
}

const ALGORITHMS = new Set(["RS256"]); // asymmetric-only; never HS*/"none"
const CLOCK_TOLERANCE_SECONDS = 60; // small leeway for skew
const JWKS_TTL_MS = 60_000; // cache signing keys; refetch on rotation

/**
 * Resolve the caller's verified identity from the request.
 *
 * Returns `{ configured: false }` while Auth0 is not configured, which is the
 * current production reality. A handler seeing that must answer 503
 * ("contributions are not open yet") rather than proceeding.
 */
export async function resolveIdentity(
  request: Request,
  env: AuthEnv,
  deps: IdentityDeps = defaultDeps,
): Promise<IdentityResolution> {
  const domain = normalizeDomain(env.AUTH0_DOMAIN);
  const audience = (env.AUTH0_API_AUDIENCE ?? "").trim();
  // Both are required to safely verify anything. Without them we are "not
  // configured," which the handlers turn into a 503 rather than a silent pass.
  if (!domain || !audience) return { configured: false };

  const token = readBearerToken(request);
  if (!token) return { configured: true, identity: null };

  const subject = await verifyAccessToken(token, { domain, audience, clientId: normalize(env.AUTH0_CLIENT_ID) }, deps);
  if (!subject) return { configured: true, identity: null };

  return { configured: true, identity: { userId: subject, role: roleFor(subject, env) } };
}

/**
 * Turn a moderation decision into a `Role`. A subject id is a moderator only if
 * it appears in the server-side allow-list. Everyone signed in is otherwise a
 * contributor. There is deliberately no admin-vs-moderator distinction beyond
 * this list at Stage 13 scale, and no client-trusted role field.
 */
export function roleFor(subjectId: string, env: AuthEnv): Role {
  const moderators = (env.BUTTLER_MODERATOR_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return moderators.includes(subjectId) ? "moderator" : "contributor";
}

// Retained for documentation/parity with the original seam notes: the provider
// verification step returns the stable opaque subject id, or null. Kept as a
// type so nothing mistakes the shape for a cookie-session verifier.
export type VerifySession = (token: string) => Promise<string | null>;

// --- Auth0 access-token verification (the security-critical path) ----------

interface VerifyConfig {
  domain: string;
  audience: string;
  clientId: string;
}

/**
 * Verify an Auth0 RS256 bearer access token locally and return its `sub`, or
 * null on ANY failure. Every branch returns null rather than throwing so a
 * verification error can never be mistaken for authenticated access.
 */
async function verifyAccessToken(
  token: string,
  config: VerifyConfig,
  deps: IdentityDeps,
): Promise<string | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = decodeJsonSegment(encodedHeader);
    if (!header || typeof header.alg !== "string" || !ALGORITHMS.has(header.alg)) return null;
    if (header.typ !== undefined && String(header.typ).toLowerCase() !== "jwt") return null;
    if (typeof header.kid !== "string" || header.kid.length === 0) return null;

    const claims = decodeJsonSegment(encodedPayload);
    if (!claims) return null;

    // Signature first: no point validating claims a key did not endorse.
    const verified = await verifySignature(header.kid, config.domain, `${encodedHeader}.${encodedPayload}`, encodedSignature, deps);
    if (!verified) return null;

    // Issuer: exactly the single tenant derived from AUTH0_DOMAIN. Never a set
    // of "known good" issuers, so a token from any other tenant is rejected.
    if (claims.iss !== issuerFor(config.domain)) return null;

    // Audience: the token must be minted for the Buttler API identifier. Auth0
    // may send `aud` as a string or an array.
    if (!audienceMatches(claims.aud, config.audience)) return null;

    // Authorized party (defense-in-depth): if we know our client id and the
    // token names one, they must agree.
    if (config.clientId && typeof claims.azp === "string" && claims.azp !== config.clientId) return null;

    // Time validity.
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_TOLERANCE_SECONDS <= now) return null;
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_TOLERANCE_SECONDS > now) return null;

    // Stable identity key: the Auth0 subject. Email is never used as a key.
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

async function verifySignature(
  kid: string,
  domain: string,
  signingInput: string,
  encodedSignature: string,
  deps: IdentityDeps,
): Promise<boolean> {
  const key = await resolveSigningKey(kid, domain, deps);
  if (!key) return false;
  const signature = decodeBytesSegment(encodedSignature);
  const data = new TextEncoder().encode(signingInput);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature.buffer as ArrayBuffer,
    data.buffer as ArrayBuffer,
  );
}

// Resolve the public key for `kid`, refetching past the cache once so a rotated
// signing key is picked up without embedding any key in source.
async function resolveSigningKey(
  kid: string,
  domain: string,
  deps: IdentityDeps,
): Promise<CryptoKey | null> {
  const url = jwksUrlFor(domain);
  let match = await findKey(deps, url, false, kid);
  if (!match) match = await findKey(deps, url, true, kid);
  if (!match || match.kty !== "RSA" || !match.n || !match.e) return null;
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: match.n, e: match.e, alg: "RS256", ext: false } as unknown as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

async function findKey(
  deps: IdentityDeps,
  url: string,
  force: boolean,
  kid: string,
): Promise<JsonWebKey2048 | undefined> {
  try {
    const jwks = await deps.fetchJwks(url, force);
    return jwks.keys.find((entry) => entry.kid === kid);
  } catch {
    return undefined;
  }
}

// --- Small helpers (all fail-safe / throw-free from the caller's view) -----

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

function issuerFor(domain: string): string {
  // Auth0's documented issuer for a tenant domain is `https://<domain>/` (with
  // the trailing slash). We derive exactly one and compare by equality.
  return `https://${domain}/`;
}

function jwksUrlFor(domain: string): string {
  return `https://${domain}/.well-known/jwks.json`;
}

function normalizeDomain(raw: string | undefined): string {
  let value = normalize(raw);
  value = value.replace(/^https:\/\//i, "");
  value = value.replace(/\/+$/, "");
  return value;
}

function normalize(raw: string | undefined): string {
  return (raw ?? "").trim();
}

// Only ever trusts the Authorization bearer header. Deliberately ignores any
// X-User-ID / body-supplied identity so a caller cannot choose who they are.
function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const text = new TextDecoder().decode(decodeBytesSegment(segment));
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeBytesSegment(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Default (production) deps: fetch + cache Auth0's public JWKS ----------

function createDefaultDeps(): IdentityDeps {
  let cache: { keys: JsonWebKey2048[]; at: number } | null = null;
  return {
    async fetchJwks(url: string, force = false): Promise<Jwks> {
      const now = Date.now();
      if (!force && cache && now - cache.at < JWKS_TTL_MS) {
        return { keys: cache.keys };
      }
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("JWKS fetch failed");
      const body = (await response.json()) as Partial<Jwks>;
      const keys = Array.isArray(body?.keys) ? body.keys : [];
      cache = { keys, at: now };
      return { keys };
    },
  };
}

const defaultDeps = createDefaultDeps();
