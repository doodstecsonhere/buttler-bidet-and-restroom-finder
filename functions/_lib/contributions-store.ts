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
  isContributionKind,
  validatePayload,
  validateTargetForKind,
  type ContributionKind,
  type ContributionStatus,
  type ValidationStatus,
} from "../../lib/contributions/contract.ts";
import { planCanonicalApply, renderApplyStatement } from "../../lib/contributions/apply.ts";
import {
  authorizeCanonicalApply,
  authorizeDecision,
  authorizeRead,
  statusForDecision,
  type Decision,
  type Identity,
} from "../../lib/contributions/authorize.ts";

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
  | { ok: false; status: number; error: string };

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

// The privileged canonical write — the ONLY code in Stage 13 that updates
// canonical_locations. It requires an approved contribution and a moderator,
// then applies an allow-listed plan. Deliberately not exposed by any endpoint.
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

  const plan = planCanonicalApply(
    row.kind,
    row.target_canonical_id,
    JSON.parse(row.payload_json) as Record<string, unknown>,
  );
  if (plan.op === "noop") {
    return { ok: true, value: { applied: false } };
  }

  const { sql, values } = renderApplyStatement(plan);
  await db
    .prepare(sql)
    .bind(...values)
    .run();

  await recordEvent(db, {
    contributionId,
    eventType: "moderation_decision",
    actorType: "moderator",
    actorId: moderator.userId,
    detail: { action: "canonical_apply", columns: plan.sets.map((s) => s.column) },
  });

  return { ok: true, value: { applied: true } };
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
