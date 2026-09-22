// Buttler 2.0 — Stage 13 authentication boundary (the ONE swap point).
//
// This file is the entire seam between "the app has no secure identity yet" and
// "contributions are live." Everything else in Stage 13 treats an `Identity` as
// already-verified and trusted. Producing that `Identity` is THIS file's job,
// and it is the only place that knows how a request proves who it is.
//
// WHY IT SHIPS RETURNING `null` (reject):
//   The production Cloudflare Pages/D1 stack has no usable authentication. The
//   only identity system in the repo is the legacy Replit OIDC + Replit Postgres
//   backend, which Pages never calls. Standing up a new provider needs owner
//   configuration (a Cloudflare Access application, or an external IdP's OAuth
//   client id/secret), and per the project rules an agent must not invent
//   credentials or deploy a fake/insecure session. So the honest default is:
//   every protected endpoint refuses, rather than pretending to be secure.
//
// TO GO LIVE (owner decision required first): implement `verifySession` below
// for the chosen provider and set the two env var NAMES documented in
// docs/stage13-moderation-operations.md. No other file changes.

import type { Identity, Role } from "../../lib/contributions/authorize.ts";

// Env this layer reads. Names only — values are never logged or committed.
export interface AuthEnv {
  // Opaque comma-separated list of provider subject ids allowed to moderate.
  // Empty/absent means "no moderators", which fails closed. Not a secret, but
  // keep it server-side (it must not appear in any client-visible bundle).
  BUTTLER_MODERATOR_IDS?: string;
}

export type IdentityResolution =
  // A provider IS configured and this caller is (or is not) signed in.
  | { configured: true; identity: Identity | null }
  // No provider is wired yet: protected routes must fail closed with 503 so no
  // anonymous or fake-authenticated write can ever slip through.
  | { configured: false };

/**
 * Resolve the caller's verified identity from the request.
 *
 * Returns `{ configured: false }` while authentication is not yet wired, which
 * is the current production reality. A handler seeing that must answer 503
 * ("contributions are not open yet") rather than proceeding.
 *
 * Once a provider is chosen, this function becomes: read the session token
 * (cookie / bearer), call `verifySession`, map the subject id + role lookup to
 * an `Identity`, and return `{ configured: true, identity }`.
 */
export async function resolveIdentity(
  _request: Request,
  _env: AuthEnv,
): Promise<IdentityResolution> {
  // --- Provider integration point (intentionally unimplemented) ------------
  // const token = readSessionToken(_request);
  // if (!token) return { configured: true, identity: null };
  // const subjectId = await verifySession(token);            // see below
  // if (!subjectId) return { configured: true, identity: null };
  // return { configured: true, identity: { userId: subjectId, role: roleFor(subjectId, _env) } };
  // --------------------------------------------------------------------------
  return { configured: false };
}

/**
 * Turn a moderation decision into a `Role`. With no provider this is unused;
 * it exists so role assignment stays in one auditable spot: a subject id is a
 * moderator only if it appears in the server-side allow-list. Everyone signed
 * in is otherwise a contributor. There is deliberately no admin-vs-moderator
 * distinction beyond this list at Stage 13 scale.
 */
export function roleFor(subjectId: string, env: AuthEnv): Role {
  const moderators = (env.BUTTLER_MODERATOR_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return moderators.includes(subjectId) ? "moderator" : "contributor";
}

/**
 * The provider-specific token verification a real implementation would supply:
 * validate signature/nonce/expiry against the provider and return the stable
 * opaque subject id, or null. Left undefined so nobody mistakes a stub for a
 * working session — the build will not silently "auth" anyone.
 */
export type VerifySession = (token: string) => Promise<string | null>;
