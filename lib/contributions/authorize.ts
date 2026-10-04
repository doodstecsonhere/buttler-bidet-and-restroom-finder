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

// The promotion predicate returns a machine-readable `code` alongside the
// Stage 13 `status`/`error` shape so the 14E endpoint can surface a stable
// reason without a caller parsing prose. It is additive — the existing
// AuthzResult used by read/decision/apply is untouched.
export type PromotionAuthzResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string };

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

// Stage 14E promotion gate (contract §4). Deliberately narrower than a
// moderator decision: promotion turns an approved observation into a canonical
// write, so it requires membership in a SEPARATE server-side promoter
// allow-list (`BUTTLER_PROMOTER_IDS`), enforced here as an EXACT id match — no
// wildcard, no substring, no client-supplied identity, and moderator status
// alone never implies promoter status. It also refuses self-promotion (the
// promoter `sub` must differ from the contributor) and any contribution that
// is not already approved. This predicate decides *who may promote what* and
// performs no write; kind eligibility, the ledger replay gate, drift, and the
// §8/§11/§12 policy matrix stay the Stage 14D executor's job, so the trust
// boundary and the execution engine never duplicate each other.
export function authorizeCanonicalPromotion(
  identity: Identity | null,
  contribution: ContributionRef,
  promoterUserIds: readonly string[],
): PromotionAuthzResult {
  if (!identity) {
    return { ok: false, status: 401, error: "authentication required", code: "authentication_required" };
  }
  // The verified subject must be a non-empty string; the auth layer already
  // guarantees this, but the gate fails closed rather than trusting it.
  if (typeof identity.userId !== "string" || identity.userId.length === 0) {
    return { ok: false, status: 401, error: "authenticated identity has no subject", code: "identity_missing" };
  }
  // Promoter membership: exact comparison only. An empty list can never match
  // (the HTTP seam maps an absent/malformed allow-list to 503 before this).
  if (!promoterUserIds.includes(identity.userId)) {
    return { ok: false, status: 403, error: "promoter authorization required", code: "promoter_required" };
  }
  // No self-promotion — even a promoter who is also the approving moderator.
  if (
    contribution.contributor_user_id !== null &&
    contribution.contributor_user_id === identity.userId
  ) {
    return { ok: false, status: 403, error: "cannot promote your own submission", code: "self_promotion" };
  }
  if (contribution.status !== "approved") {
    return { ok: false, status: 409, error: "only an approved contribution may be promoted", code: "not_approved" };
  }
  return { ok: true };
}

// Stage 14 ownership completion — reversal authorization (contract §18).
// A reversal is promoter-gated and authenticated, exactly like a promotion,
// so the allow-list and identity rules are IDENTICAL to
// `authorizeCanonicalPromotion`. The one deliberate difference is that the
// no-self rule does NOT apply: reversal never rewrites history and restores
// the guarded pre-promotion snapshot, so a promoter who happens to also be
// the contributor may still reverse their own promoted change — the
// safeguard there is §18's drift refusal (`superseded_by_later_edit`), not
// identity separation. Which promotion exists, whether its canonical row
// still matches its resulting values, and whether it was already reversed
// are the executor's questions, not this predicate's.
export type ReversalAuthzResult = PromotionAuthzResult;

export function authorizePromotionReversal(
  identity: Identity | null,
  promoterUserIds: readonly string[],
): ReversalAuthzResult {
  if (!identity) {
    return { ok: false, status: 401, error: "authentication required", code: "authentication_required" };
  }
  if (typeof identity.userId !== "string" || identity.userId.length === 0) {
    return { ok: false, status: 401, error: "authenticated identity has no subject", code: "identity_missing" };
  }
  // Exact comparison only — same fail-closed semantics as promotion.
  if (!promoterUserIds.includes(identity.userId)) {
    return { ok: false, status: 403, error: "promoter authorization required", code: "promoter_required" };
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
