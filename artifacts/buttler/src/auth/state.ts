// Buttler 2.0 — Stage 13 frontend: authentication state machine.
//
// The React provider is intentionally thin; every decision about what state a
// given event produces lives here, because that is the part worth testing and
// the part that must never guess about permissions.
//
// AUTHENTICATION vs AUTHORIZATION (the line this file holds):
// Auth0 answers "who is this?" and Buttler answers "what may they do?". So the
// profile below is built from a small allow-list of ordinary OIDC identity
// claims, and roles, permissions, scopes, and any custom claim are DROPPED on
// purpose. Rendering "Signed in as Ada" is not the same as rendering a
// moderator button, and only `functions/_lib/identity.ts` +
// `BUTTLER_MODERATOR_IDS` may decide the latter. A frontend that trusts a
// client-side role claim is a frontend that can be edited by the user.

/** The five states the sign-in control can render. */
export type AuthStatus =
  // Waiting for the first answer from Auth0 (or for a redirect to finish).
  | "loading"
  // Public Auth0 configuration is absent, so sign-in is not offered at all.
  // This is Buttler's production state today and must stay visually inert.
  | "unconfigured"
  // Configured, and nobody is signed in.
  | "anonymous"
  // Configured, and a verified user is signed in.
  | "authenticated"
  // Configured but something failed (provider unreachable, spent code, blocked
  // silent renewal). The rest of the app must keep working normally.
  | "error";

/**
 * The only claim names ever read from an Auth0 user object.
 *
 * Anything else — `roles`, `permissions`, `scope`, `_permissions`, custom
 * namespaces — is not copied forward, so it cannot be mistaken for
 * authorization by a later reader of this code.
 */
export const SAFE_PROFILE_CLAIMS = [
  "sub",
  "name",
  "nickname",
  "picture",
  "updated_at",
] as const;

export interface AuthProfile {
  /** Best available human label, already chosen from safe claims only. */
  displayName: string;
  /** Auth0 subject id, kept for debugging display only; never an authorization input. */
  subject: string;
  /** Optional profile picture URL from the provider. */
  picture: string | null;
}

export interface AuthState {
  status: AuthStatus;
  profile: AuthProfile | null;
  /** Short, safe, human-readable reason for `status: "error"`. */
  error: string | null;
}

export type AuthEvent =
  | { type: "loading" }
  | { type: "unconfigured" }
  | { type: "signed-in"; profile: AuthProfile | null }
  | { type: "signed-out" }
  | { type: "error"; message: string };

/** The app starts by asking, never by assuming. */
export function initialAuthState(): AuthState {
  return { status: "loading", profile: null, error: null };
}

/**
 * The single state transition for authentication.
 *
 * Invariants the tests lock in:
 * - `signed-out` always clears the profile, so logging out cannot leave a stale
 *   identity on screen (the access token itself is cleared by the SDK).
 * - `error` clears the profile too — an error is never shown as "signed in".
 * - Every event other than `loading`/`unconfigured` leaves the catalogue and the
 *   rest of the UI untouched: this state machine has no power over them.
 */
export function reduceAuthState(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "loading":
      return { status: "loading", profile: null, error: null };
    case "unconfigured":
      return { status: "unconfigured", profile: null, error: null };
    case "signed-in":
      return {
        status: "authenticated",
        profile: event.profile,
        error: null,
      };
    case "signed-out":
      return { status: "anonymous", profile: null, error: null };
    case "error":
      return { status: "error", profile: null, error: event.message };
  }
}

/** Shape of the provider user object as far as this file is concerned. */
export interface IdentityClaims {
  sub?: string;
  name?: string;
  nickname?: string;
  picture?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * Build the display profile from safe claims only.
 *
 * Returns `null` without a `sub`: no subject means there is no identity to
 * show, and a label invented from an unverified claim would be worse than none.
 */
export function profileFromClaims(
  claims: IdentityClaims | null | undefined,
): AuthProfile | null {
  if (!claims) return null;
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!subject) return null;

  const candidates = [claims.name, claims.nickname];
  const displayName =
    candidates
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find((value) => value.length > 0) ?? "Signed-in contributor";

  const picture =
    typeof claims.picture === "string" && claims.picture.trim()
      ? claims.picture.trim()
      : null;

  return { displayName, subject, picture };
}
