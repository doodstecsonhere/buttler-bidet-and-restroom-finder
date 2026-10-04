// Buttler 2.0 — Stage 13 contribution store (D1 data access + rules).
//
// All database reads/writes for contributions live here, expressed as
// parameterised D1 statements. The HTTP handlers in ../api/** are thin: they
// resolve an identity, parse the body, and delegate. Keeping the SQL in one
// file makes the security claims auditable:
//
//   * No function except `applyApprovedToCanonical` references
//     canonical_locations in a write. Contribution create/list/moderate touch
//     ONLY `contributions` and `contribution_events`.
//   * Every value is a `?` bind; no request text is concatenated into SQL.
//   * Server-controlled columns (status on submit, contributor id, decided_by,
//     all timestamps) are set from trusted arguments, never from request input.

import {
  MAX_MODERATION_NOTE_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PROMOTION_NOTE_LENGTH,
  isContributionKind,
  validatePayload,
  validateTargetForKind,
  type ContributionKind,
  type ContributionStatus,
  type ValidationStatus,
} from "../../lib/contributions/contract.ts";
import {
  authorizeCanonicalApply,
  authorizeCanonicalPromotion,
  authorizeDecision,
  authorizePromotionReversal,
  authorizeRead,
  authorizeWithdraw,
  statusForDecision,
  type Decision,
  type Identity,
} from "../../lib/contributions/authorize.ts";
import {
  executeCanonicalPromotionReversal,
  planAndExecuteCanonicalPromotion,
  type PromotionDatabase,
  type PromotionFailureReason,
  type ReversalFailureReason,
} from "./canonical-promotion.ts";

// A minimal D1 surface, matched by both the real Pages binding and the in-memory
// adapter the test suite injects.
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<{ results?: T[]; meta?: { changes?: number } }>;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
}

export interface ContributionRow {
  contribution_id: string;
  kind: ContributionKind;
  target_canonical_id: string | null;
  contributor_user_id: string | null;
  status: ContributionStatus;
  validation_status: ValidationStatus;
  payload_json: string;
  evidence_json: string | null;
  notes: string | null;
  moderation_note: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
  updated_at: string;
}

export type StoreResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      error: string;
      // Optional machine-readable reason + structured extras. Only the Stage
      // 14E promotion path populates these; every existing caller keeps the
      // plain `{ status, error }` shape, so widening is backward compatible.
      code?: string;
      details?: Record<string, unknown>;
    };

// Anti-spam: a bounded number of unresolved submissions per contributor, and a
// soft de-duplicate when the same claim is already open on the same place.
const MAX_OPEN_PER_CONTRIBUTOR = 10;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function canonicalTargetExists(value: string): boolean {
  return /^buttler_loc_[0-9a-f]{20}$/.test(value);
}

export interface SubmissionInput {
  kind: unknown;
  targetCanonicalId: unknown;
  payload: unknown;
  notes: unknown;
  evidence: unknown;
}

// The contributor submission path. Forces status=pending and validation_status
// =not_validated regardless of input, stamps the contributor from the verified
// identity, and writes an append-only `submitted` event. It has no code path to
// canonical_locations.
export async function createContribution(
  db: D1Database,
  identity: Identity,
  input: SubmissionInput,
): Promise<StoreResult<{ contributionId: string; status: ContributionStatus }>> {
  if (!isContributionKind(input.kind)) {
    return { ok: false, status: 400, error: "unknown contribution kind" };
  }
  const kind = input.kind;

  const target =
    input.targetCanonicalId === undefined || input.targetCanonicalId === null
      ? null
      : String(input.targetCanonicalId);

  const targetCheck = validateTargetForKind(kind, target);
  if (!targetCheck.ok) {
    return { ok: false, status: 400, error: targetCheck.error };
  }
  if (target !== null && !canonicalTargetExists(target)) {
    return { ok: false, status: 400, error: "malformed canonical target id" };
  }
  // A real canonical id must actually exist (FK would also catch it; this gives
  // a clean 404-style message and no half-written row).
  if (target !== null) {
    const found = await db
      .prepare("SELECT canonical_id AS id FROM canonical_locations WHERE canonical_id = ?")
      .bind(target)
      .first<{ id: string }>();
    if (!found) {
      return { ok: false, status: 404, error: "target location not found" };
    }
  }

  const payloadCheck = validatePayload(kind, input.payload);
  if (!payloadCheck.ok) {
    return { ok: false, status: 400, error: payloadCheck.error };
  }

  const notes =
    input.notes === undefined || input.notes === null ? null : String(input.notes);
  if (notes !== null && notes.length > MAX_NOTES_LENGTH) {
    return { ok: false, status: 413, error: `notes exceed ${MAX_NOTES_LENGTH} characters` };
  }

  let evidenceJson: string | null = null;
  if (input.evidence !== undefined && input.evidence !== null) {
    if (!Array.isArray(input.evidence)) {
      return { ok: false, status: 400, error: "evidence must be an array" };
    }
    evidenceJson = JSON.stringify(input.evidence);
    if (evidenceJson.length > MAX_NOTES_LENGTH * 4) {
      return { ok: false, status: 413, error: "evidence too large" };
    }
  }

  // Per-contributor open cap.
  const open = await db
    .prepare(
      `SELECT count(*) AS c FROM contributions
       WHERE contributor_user_id = ? AND status IN ('pending','validated','needs_review')`,
    )
    .bind(identity.userId)
    .first<{ c: number }>();
  if ((open?.c ?? 0) >= MAX_OPEN_PER_CONTRIBUTOR) {
    return { ok: false, status: 429, error: "too many open contributions" };
  }

  // Soft duplicate detection against the same target + kind.
  if (target !== null) {
    const dup = await db
      .prepare(
        `SELECT count(*) AS c FROM contributions
         WHERE target_canonical_id = ? AND kind = ?
           AND status IN ('pending','validated','needs_review')`,
      )
      .bind(target, kind)
      .first<{ c: number }>();
    if ((dup?.c ?? 0) > 0) {
      return { ok: false, status: 409, error: "an open contribution for this already exists" };
    }
  }

  const contributionId = newId("contrib");
  const payloadJson = JSON.stringify(input.payload);

  await db
    .prepare(
      `INSERT INTO contributions
         (contribution_id, kind, target_canonical_id, contributor_user_id,
          status, validation_status, payload_json, evidence_json, notes)
       VALUES (?, ?, ?, ?, 'pending', 'not_validated', ?, ?, ?)`,
    )
    .bind(
      contributionId,
      kind,
      target,
      identity.userId,
      payloadJson,
      evidenceJson,
      notes,
    )
    .run();

  await recordEvent(db, {
    contributionId,
    eventType: "submitted",
    actorType: "contributor",
    actorId: identity.userId,
    toStatus: "pending",
  });

  return { ok: true, value: { contributionId, status: "pending" as const } };
}

export async function getContribution(
  db: D1Database,
  identity: Identity | null,
  contributionId: string,
): Promise<StoreResult<ContributionRow>> {
  const row = await loadContribution(db, contributionId);
  if (!row) return { ok: false, status: 404, error: "not found" };
  const auth = authorizeRead(identity, {
    contributor_user_id: row.contributor_user_id,
    status: row.status,
  });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
  return { ok: true, value: row };
}

export async function listMyContributions(
  db: D1Database,
  identity: Identity,
): Promise<ContributionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM contributions WHERE contributor_user_id = ? ORDER BY submitted_at DESC`,
    )
    .bind(identity.userId)
    .all<ContributionRow>();
  return results;
}

export async function moderationQueue(
  db: D1Database,
  statusFilter: ContributionStatus | null,
): Promise<ContributionRow[]> {
  if (statusFilter) {
    const { results } = await db
      .prepare(`SELECT * FROM contributions WHERE status = ? ORDER BY submitted_at ASC`)
      .bind(statusFilter)
      .all<ContributionRow>();
    return results;
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM contributions
       WHERE status IN ('pending','validated','needs_review')
       ORDER BY submitted_at ASC`,
    )
    .all<ContributionRow>();
  return results;
}

// Moderator decision. Records who/when and appends a moderation event. It does
// NOT touch canonical_locations — that is a separate, further-privileged step.
export async function decideContribution(
  db: D1Database,
  moderator: Identity,
  contributionId: string,
  decision: Decision,
  note: string | null,
): Promise<StoreResult<{ status: ContributionStatus }>> {
  if (note !== null && note.length > MAX_MODERATION_NOTE_LENGTH) {
    return { ok: false, status: 413, error: "moderation note too long" };
  }
  const row = await loadContribution(db, contributionId);
  if (!row) return { ok: false, status: 404, error: "not found" };

  const auth = authorizeDecision(moderator, {
    contributor_user_id: row.contributor_user_id,
    status: row.status,
  });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };

  const toStatus = statusForDecision(decision);
  await db
    .prepare(
      `UPDATE contributions
       SET status = ?, validation_status = ?, moderation_note = ?,
           decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           decided_by = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE contribution_id = ?`,
    )
    .bind(toStatus, "passed", note, moderator.userId, contributionId)
    .run();

  await recordEvent(db, {
    contributionId,
    eventType: "moderation_decision",
    actorType: "moderator",
    actorId: moderator.userId,
    fromStatus: row.status,
    toStatus,
    detail: note ? { note } : null,
  });

  return { ok: true, value: { status: toStatus } };
}

// Stage 14N — contributor self-withdrawal. This reuses the SAME Stage 13
// lifecycle, identity, authorization, and event machinery as `decideContribution`
// rather than inventing a parallel one: the owner-only, pre-terminal rule lives
// in the pure `authorizeWithdraw` predicate (a moderator is NOT special here —
// they get a 404 for someone else's row exactly like any other non-owner), the
// row is only ever UPDATEd (never deleted), and the transition appends the
// existing `withdrawn` event. Nothing here can touch canonical_locations,
// canonical provenance, or the promotion ledger — withdrawal is purely a
// contribution-lifecycle status move that preserves the original payload, the
// canonical target reference, evidence, and contributor identity.
//
// The transition is a compare-and-swap: the UPDATE only lands while the row is
// still pre-terminal. A replay of an already-withdrawn row is refused earlier by
// `authorizeWithdraw` (a terminal status => 409), and a genuine race with a
// concurrent decision/withdrawal matches zero rows here, so a second `withdrawn`
// event can never be appended. `decided_at` is stamped because the schema CHECK
// requires a decision timestamp for every terminal status (incl. `withdrawn`);
// `decided_by` records the withdrawing contributor, not a moderator.
export async function withdrawContribution(
  db: D1Database,
  identity: Identity,
  contributionId: string,
): Promise<StoreResult<{ contributionId: string; status: ContributionStatus }>> {
  const row = await loadContribution(db, contributionId);
  if (!row) return { ok: false, status: 404, error: "not found" };

  const auth = authorizeWithdraw(identity, {
    contributor_user_id: row.contributor_user_id,
    status: row.status,
  });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };

  const result = await db
    .prepare(
      `UPDATE contributions
       SET status = 'withdrawn',
           decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           decided_by = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE contribution_id = ?
         AND status IN ('pending','validated','needs_review')`,
    )
    .bind(identity.userId, contributionId)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    // Lost a race against another transition between the load above and this
    // guarded UPDATE. Answer with the same deterministic conflict a terminal
    // state already yields — and append nothing.
    return { ok: false, status: 409, error: "cannot withdraw a decided submission" };
  }

  await recordEvent(db, {
    contributionId,
    eventType: "withdrawn",
    actorType: "contributor",
    actorId: identity.userId,
    fromStatus: row.status,
    toStatus: "withdrawn",
  });

  return { ok: true, value: { contributionId, status: "withdrawn" as const } };
}

// The privileged canonical write — the ONLY code path that updates
// canonical_locations. Stage 14D made this a thin wrapper over the authoritative
// executor (functions/_lib/canonical-promotion.ts): the Stage 13 shape is kept
// for its callers and the Stage 13 seam (moderator + approved + no self) still
// runs first, but the promotion itself now goes through the frozen contract
// machinery — Stage 14C planner, snapshot compare-and-swap, the
// canonical_promotions ledger, and the audit event — instead of the old
// column-only apply. There is deliberately no second promotion path to compete
// with the executor. Still inert: no HTTP endpoint calls this.
export async function applyApprovedToCanonical(
  db: D1Database,
  moderator: Identity,
  contributionId: string,
): Promise<StoreResult<{ applied: boolean }>> {
  const row = await loadContribution(db, contributionId);
  if (!row) return { ok: false, status: 404, error: "not found" };

  const auth = authorizeCanonicalApply(moderator, {
    contributor_user_id: row.contributor_user_id,
    status: row.status,
  });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
  if (row.target_canonical_id === null) {
    return { ok: false, status: 409, error: "new_location promotion is a manual owner import" };
  }

  // The real D1 binding always provides `batch` (contract §6 phase 2 needs
  // it); the narrow D1Database surface above simply never declared it.
  const result = await planAndExecuteCanonicalPromotion(db as unknown as PromotionDatabase, {
    contributionId,
    promoterUserId: moderator.userId,
  });
  if (result.ok) return { ok: true, value: { applied: true } };
  // The executor refused to write. Map its structured reasons back onto the
  // Stage 13 result shape; "nothing to do" stays a success-without-write,
  // every other refusal changes nothing canonical.
  if (result.reason === "invalid_plan") {
    return { ok: true, value: { applied: false } };
  }
  return { ok: false, status: 409, error: `${result.reason}: ${result.message}` };
}

// ---------------------------------------------------------------------------
// Stage 14E — the promoter-facing canonical promotion (contract §4 / §15 / §16)
// ---------------------------------------------------------------------------

// The success projection the endpoint returns (frozen §15 shape). Nothing here
// is caller-influenceable: every field is derived from stored data by the
// Stage 14D executor.
export type PromotionSuccess = {
  promotionId: string;
  canonicalId: string;
  changedColumns: readonly string[];
  promotedAt: string;
};

// Maps the executor's HTTP-free failure reasons onto the contract §16 status
// classes. Kept as one exhaustive switch so a new executor reason is a
// compile-time error here rather than a silent 500.
function promotionFailure(result: {
  reason: PromotionFailureReason;
  message: string;
  details?: Record<string, unknown>;
}): { status: number; error: string; code: string; details?: Record<string, unknown> } {
  let status: number;
  switch (result.reason) {
    case "not_found":
    case "canonical_target_not_found":
      status = 404;
      break;
    case "not_approved":
    case "kind_not_promotable":
    case "manual_import_only":
    case "already_promoted":
    case "stale_snapshot":
    case "proximity_conflict":
    case "bidet_downgrade_forbidden":
    case "bidet_survey_conflict":
    // Stage 14M: the target exists but is rejected lineage. Not a 404 — the
    // row is real data, it is simply outside the active canonical dataset, so
    // this is the same class of "refused, changes nothing" conflict as drift.
    case "canonical_target_rejected":
      status = 409;
      break;
    case "address_blank":
    case "coordinates_partial":
    case "coordinate_out_of_bounds":
    case "coordinate_evidence_required":
    case "invalid_plan":
      status = 422;
      break;
    case "phase2_failed":
      status = 500;
      break;
    default: {
      // Exhaustiveness guard: an unhandled reason must not compile silently.
      const _exhaustive: never = result.reason;
      status = 500;
      void _exhaustive;
    }
  }
  return {
    status,
    error: result.message,
    code: result.reason,
    ...(result.details ? { details: result.details } : {}),
  };
}

// The Stage 14E store entry point behind POST .../promotion. Unlike the inert
// moderator-shaped `applyApprovedToCanonical`, this authorizes against the
// SEPARATE promoter allow-list and an explicit no-self-promotion rule, then
// hands only trusted inputs (the stored contribution id + the verified
// promoter subject) to the frozen Stage 14D executor. The executor derives the
// target, kind, changed columns, and snapshot from stored data — a caller can
// never smuggle any of them. Authorization is decided here; the canonical write
// is done solely by the executor.
export async function promoteApprovedToCanonical(
  db: D1Database,
  identity: Identity,
  contributionId: string,
  promoterUserIds: readonly string[],
  promotionNote: string | null,
): Promise<StoreResult<PromotionSuccess>> {
  if (promotionNote !== null && promotionNote.length > MAX_PROMOTION_NOTE_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: `promotion_note exceeds ${MAX_PROMOTION_NOTE_LENGTH} characters`,
      code: "promotion_note_too_long",
    };
  }

  // loadContribution treats a malformed id as not-found (no DB hit), matching
  // the §16 "missing / malformed id => 404" row.
  const row = await loadContribution(db, contributionId);
  if (!row) {
    return { ok: false, status: 404, error: "not found", code: "not_found" };
  }

  const auth = authorizeCanonicalPromotion(
    identity,
    { contributor_user_id: row.contributor_user_id, status: row.status },
    promoterUserIds,
  );
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error, code: auth.code };
  }

  // The real D1 binding always provides `batch` (the executor's phase-2 write
  // needs it); the narrow D1Database surface simply never declared it. This is
  // the same cast `applyApprovedToCanonical` uses.
  const result = await planAndExecuteCanonicalPromotion(db as unknown as PromotionDatabase, {
    contributionId,
    promoterUserId: identity.userId,
    promotionNote,
  });
  if (result.ok) {
    return {
      ok: true,
      value: {
        promotionId: result.promotionId,
        canonicalId: result.canonicalId,
        changedColumns: result.changedColumns,
        promotedAt: result.promotedAt,
      },
    };
  }
  return { ok: false, ...promotionFailure(result) };
}

// Stage 14 ownership completion — the promoter-facing reversal (§18). Same
// seam shape as `promoteApprovedToCanonical`: authorize against the SEPARATE
// promoter allow-list with the pure `authorizePromotionReversal` predicate
// (identity from the verified token only), then hand the executor nothing but
// the stored promotion id and the verified promoter subject. Changed columns,
// base values, resulting values, and the canonical target are read back from
// the ledger row itself — a caller can never smuggle a restore spec through
// this boundary any more than a promotion spec.
export type ReversalSuccess = {
  reversalId: string;
  reversesPromotionId: string;
  canonicalId: string;
  changedColumns: readonly string[];
  restoredValues: Readonly<Record<string, unknown>>;
  reversedAt: string;
};

// §18 failure classes mapped onto HTTP, mirroring `promotionFailure`.
function reversalFailure(result: {
  reason: ReversalFailureReason;
  message: string;
  details?: Record<string, unknown>;
}): { status: number; error: string; code: string; details?: Record<string, unknown> } {
  let status: number;
  switch (result.reason) {
    case "not_found":
      status = 404;
      break;
    case "already_reversed":
    case "superseded_by_later_edit":
    case "canonical_target_rejected":
      status = 409;
      break;
    case "canonical_target_not_found":
    case "invalid_reversal":
      status = 422;
      break;
    case "phase2_failed":
      status = 500;
      break;
    default: {
      const _exhaustive: never = result.reason;
      status = 500;
      void _exhaustive;
    }
  }
  return {
    status,
    error: result.message,
    code: result.reason,
    ...(result.details ? { details: result.details } : {}),
  };
}

export async function reverseCanonicalPromotion(
  db: D1Database,
  identity: Identity,
  promotionId: string,
  promoterUserIds: readonly string[],
  reversalNote: string | null,
): Promise<StoreResult<ReversalSuccess>> {
  if (reversalNote !== null && reversalNote.length > MAX_PROMOTION_NOTE_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: `reversal_note exceeds ${MAX_PROMOTION_NOTE_LENGTH} characters`,
      code: "reversal_note_too_long",
    };
  }

  const auth = authorizePromotionReversal(identity, promoterUserIds);
  if (!auth.ok) {
    return { ok: false, status: auth.status, error: auth.error, code: auth.code };
  }

  // The real D1 binding always provides `batch` (the phase-2 append needs it);
  // the narrow D1Database surface simply never declared it. Same cast as the
  // promotion path.
  const result = await executeCanonicalPromotionReversal(db as unknown as PromotionDatabase, {
    promotionId,
    promoterUserId: identity.userId,
    reversalNote,
  });
  if (result.ok) {
    return {
      ok: true,
      value: {
        reversalId: result.reversalId,
        reversesPromotionId: result.reversesPromotionId,
        canonicalId: result.canonicalId,
        changedColumns: result.changedColumns,
        restoredValues: result.restoredValues,
        reversedAt: result.reversedAt,
      },
    };
  }
  return { ok: false, ...reversalFailure(result) };
}

async function loadContribution(
  db: D1Database,
  contributionId: string,
): Promise<ContributionRow | null> {
  if (!/^contrib_[0-9a-f]{32}$/.test(contributionId)) {
    // Not a well-formed id: treat as not-found rather than hitting the DB.
    return null;
  }
  return db
    .prepare(`SELECT * FROM contributions WHERE contribution_id = ?`)
    .bind(contributionId)
    .first<ContributionRow>();
}

type EventType =
  | "submitted"
  | "validated"
  | "flagged"
  | "status_change"
  | "comment"
  | "moderation_decision"
  | "withdrawn"
  | "superseded";

async function recordEvent(
  db: D1Database,
  event: {
    contributionId: string;
    eventType: EventType;
    actorType: "system" | "contributor" | "moderator";
    actorId: string | null;
    fromStatus?: ContributionStatus;
    toStatus?: ContributionStatus;
    detail?: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO contribution_events
         (event_id, contribution_id, event_type, actor_type, actor_id,
          from_status, to_status, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("evt"),
      event.contributionId,
      event.eventType,
      event.actorType,
      event.actorId,
      event.fromStatus ?? null,
      event.toStatus ?? null,
      event.detail === undefined ? null : JSON.stringify(event.detail),
    )
    .run();
}
