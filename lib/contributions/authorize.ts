// Buttler 2.0 — Stage 13 authorization decisions (pure, side-effect free).
//
// Every protected behaviour in Stage 13 funnels its "may this actor do this?"
// question through these functions, so the rules live in exactly one testable
// place. The HTTP handlers do NOT decide anything themselves: they resolve an
// identity, then call these. That is what "hiding a button is not
// authorization" (AGENTS.md) means in code — the check runs server-side, on the
// trustworthiest value available (the resolved identity), never a client field.

import type { ContributionStatus } from "./contract.ts";
import { TERMINAL_STATUSES } from "./contract.ts";

export type Role = "contributor" | "moderator" | "admin";

// The identity the auth layer vouches for. `userId` is an opaque provider
// subject id, assigned by the server from a verified session — never read from
// the request body (PART "Never trusted inputs").
export type Identity = {
  userId: string;
  role: Role;
};

// The minimum view of a contribution needed to make an authorization call.
export type ContributionRef = {
  contributor_user_id: string | null;
  status: ContributionStatus;
};

export type Decision = "approve" | "reject";

export type AuthzResult = { ok: true } | { ok: false; status: number; error: string };

export function isModerator(identity: Identity | null): boolean {
  return !!identity && (identity.role === "moderator" || identity.role === "admin");
}

// A contribution is visible only to its owner or a moderator. Everyone else
// gets a 404 (not 403) so ids never leak the existence of other people's
// submissions.
export function authorizeRead(
  identity: Identity | null,
  contribution: ContributionRef,
): AuthzResult {
  if (!identity) return { ok: false, status: 401, error: "authentication required" };
  if (isModerator(identity)) return { ok: true };
  if (
    contribution.contributor_user_id !== null &&
    contribution.contributor_user_id === identity.userId
  ) {
    return { ok: true };
  }
  return { ok: false, status: 404, error: "not found" };
}

// Only a moderator may move a contribution toward a decision, and a moderator
// may never decide their own submission.
export function authorizeDecision(
  identity: Identity | null,
  contribution: ContributionRef,
): AuthzResult {
  if (!identity) return { ok: false, status: 401, error: "authentication required" };
  if (!isModerator(identity)) {
    return { ok: false, status: 403, error: "moderator role required" };
  }
  if (
    contribution.contributor_user_id !== null &&
    contribution.contributor_user_id === identity.userId
  ) {
    return { ok: false, status: 403, error: "cannot moderate your own submission" };
  }
  if (TERMINAL_STATUSES.includes(contribution.status)) {
    return { ok: false, status: 409, error: "contribution is already decided" };
  }
  return { ok: true };
}

// The canonical-apply step is even more privileged than a decision, and it is
// the ONLY path allowed to mutate canonical_locations. It requires a moderator
// identity and an already-approved contribution. It ships un-wired from any
// endpoint until the owner separately approves promotion.
export function authorizeCanonicalApply(
  identity: Identity | null,
  contribution: ContributionRef,
): AuthzResult {
  if (!identity) return { ok: false, status: 401, error: "authentication required" };
  if (!isModerator(identity)) {
    return { ok: false, status: 403, error: "moderator role required" };
  }
  if (
    contribution.contributor_user_id !== null &&
    contribution.contributor_user_id === identity.userId
  ) {
    return { ok: false, status: 403, error: "cannot apply your own submission" };
  }
  // Applying is only ever valid on an already-approved contribution; unlike a
  // decision, an approved (terminal) state is a precondition here, not a
  // reason to refuse.
  if (contribution.status !== "approved") {
    return { ok: false, status: 409, error: "only an approved contribution may apply" };
  }
  return { ok: true };
}

// Contributor-side withdrawal: own submission, and only from a pre-terminal
// state.
export function authorizeWithdraw(
  identity: Identity | null,
  contribution: ContributionRef,
): AuthzResult {
  if (!identity) return { ok: false, status: 401, error: "authentication required" };
  if (
    contribution.contributor_user_id === null ||
    contribution.contributor_user_id !== identity.userId
  ) {
    return { ok: false, status: 404, error: "not found" };
  }
  if (TERMINAL_STATUSES.includes(contribution.status)) {
    return { ok: false, status: 409, error: "cannot withdraw a decided submission" };
  }
  return { ok: true };
}

export function statusForDecision(decision: Decision): ContributionStatus {
  return decision === "approve" ? "approved" : "rejected";
}
