// Buttler 2.0 — Stage 14D transactional canonical-promotion executor.
//
// This module is the single authoritative execution path that turns ONE
// trusted Stage 14C plan into (a) one guarded canonical UPDATE, (b) one
// append-only `canonical_promotions` ledger row, and (c) one audit event —
// or writes nothing at all. It implements the frozen Stage 14A contract
// (docs/stage14a-canonical-promotion-contract.md) §6 (two-phase atomicity),
// §7 (optimistic compare-and-swap on updated_at + the seven writable
// fields, NULL-safe `IS`), §8 (bidet transition matrix), §11 (blank
// address), §12 (coordinate pair / bounds / evidence / 30 m proximity),
// §5.2 (ledger fields, promo_<32 hex> ids), §9 (provenance is NEVER
// written), and §16 (the failure matrix).
//
// What this module deliberately is NOT (Stage 14D scope):
//   * NOT an HTTP endpoint. No Request/Response, no routing, no status
//     codes — the route architecture (§15) is frozen but stays unexposed;
//     wiring is a later stage with its own owner approval.
//   * NOT an authorization decision. It reads no environment variable and
//     never touches BUTTLER_PROMOTER_IDS (§4). `promoterUserId` is passed
//     in by the (future) authorization seam; the executor only records it.
//   * NOT a planner. Every "may this change happen at all" decision is
//     Stage 14C's (`planCanonicalPromotion`); this file consumes a plan,
//     revalidates it against stored rows, and performs the database-side
//     safety checks the contract requires at execution time.
//   * NOT a catalogue reader. It never serves the public list; the read model
//     keeps its own activation rule (§2 / Stage 14K).
//
// Stage 14M hardened the ACTIVE-target rule at THIS boundary: a canonical row
// whose stored `record_status` is 'rejected' is retained lineage (Stage 14K
// Pulantubig merge), not an active catalogue record, and can never receive a
// promotion. The refusal lives in the executor that every promotion path goes
// through, so a future alternate caller cannot route around it.
//
// Trust boundary (contract §4 / mission Phases 2–3, 16): the executor
// accepts NO caller-supplied canonical column names, values, contributor
// id, target id, kind, changed columns, or snapshot. Everything it writes
// is re-derived from the stored contribution row and the planner output
// built from it, and every value that reaches SQL is either a `?` bind or
// a fixed string looked up from an allow-list map — never interpolated
// input. The guarded UPDATE compares all eight snapshot values with NULL-
// safe `IS` semantics; zero affected rows means drift (`stale_snapshot`),
// never a force.
//
// The crash window (contract §6, mission Phase 10): phase 1 (canonical
// UPDATE) and phase 2 (ledger + event batch) are two separate commits —
// D1 gives no cross-batch atomicity, and this module does not pretend
// otherwise. If phase 2 fails, the executor returns a `phase2_failed`
// result (success is never claimed), and `reconcileCanonicalPromotions`
// below is the read-only detector that classifies such orphans. It never
// reconstructs or invents a missing ledger row; healing is a human
// decision, per the mission's honest-reconciliation mandate.

import {
  ACCESS_VALUES,
  FEE_VALUES,
  BIDET_PRESENCE_VALUES,
  type ContributionKind,
  type ContributionStatus,
} from "../../lib/contributions/contract.ts";
import { WRITABLE_CANONICAL_COLUMNS } from "../../lib/contributions/apply.ts";
import {
  planCanonicalPromotion,
  sameValue,
  findProximityConflict,
  PROXIMITY_THRESHOLD_METERS,
  PROMOTABLE_KINDS,
  type CanonicalTargetRow,
  type NearbyCanonicalRow,
  type PromotionPlan,
} from "../../lib/contributions/promotion-planner.ts";
import type { D1Database, D1Statement } from "./contributions-store.ts";

// ---------------------------------------------------------------------------
// Database surface
// ---------------------------------------------------------------------------

// The store's minimal D1 surface plus `batch`, which real D1 provides and the
// contract (§6) mandates for the phase-2 ledger+event commit. The test
// harness implements the exact same shape over node:sqlite with
// BEGIN/COMMIT/ROLLBACK, so the atomicity claim is executed, not assumed.
export interface PromotionDatabase extends D1Database {
  batch<T = unknown>(statements: D1Statement[]): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Fixed policy data (never derived from input)
// ---------------------------------------------------------------------------

// Canonical columns that promotion may write, as a frozen lookup keyed by the
// exact column name. The SET fragment for a column is ONLY ever produced by
// looking the column up here — an input string can never become SQL text.
const SET_FRAGMENTS: Readonly<Record<string, string>> = Object.freeze({
  access: "access = ?",
  fee: "fee = ?",
  bidet_presence: "bidet_presence = ?",
  name: "name = ?",
  address: "address = ?",
  latitude: "latitude = ?",
  longitude: "longitude = ?",
});

// The eight compare-and-swap values (contract §7): updated_at plus the seven
// writable fields, in a fixed order.
const SNAPSHOT_COLUMNS: readonly string[] = [
  "updated_at",
  "access",
  "fee",
  "bidet_presence",
  "name",
  "address",
  "latitude",
  "longitude",
];

// Which columns each promotable kind may change. Mirrors the §10 matrix; a
// plan that names a column outside its kind's set is a smuggled change and
// is refused before any write.
const KIND_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  access_update: ["access"],
  fee_update: ["fee"],
  bidet_report: ["bidet_presence"],
  info_correction: ["name", "address", "latitude", "longitude"],
});

// Service-area bounds re-checked at execution time (§12; same box the submit
// contract and the planner use).
const LATITUDE_BOUNDS = { min: 9.0, max: 9.8 };
const LONGITUDE_BOUNDS = { min: 123.0, max: 123.7 };

const CANONICAL_ID_RE = /^buttler_loc_[0-9a-f]{20}$/;
const CONTRIBUTION_ID_RE = /^contrib_[0-9a-f]{32}$/;
const COORDINATE_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "field_observation",
  "external_source",
]);

// Ledger `promotion_note` cap, matching the 0006 CHECK.
const MAX_PROMOTION_NOTE_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Result types (structured, HTTP-free — 14E will map these to §15/§16 codes)
// ---------------------------------------------------------------------------

export type PromotionFailureReason =
  | "not_found" // contribution row missing
  | "canonical_target_not_found"
  // Stage 14M: the target row exists but is rejected lineage, so it is outside
  // the ACTIVE canonical dataset. Distinct from "not found" on purpose — the
  // caller must be able to tell "wrong id" from "that record was retired".
  | "canonical_target_rejected"
  | "not_approved"
  | "kind_not_promotable"
  | "manual_import_only" // new_location (§13)
  | "already_promoted" // replay gate (§5.2/§6)
  | "invalid_plan" // structural / smuggle check failed
  | "stale_snapshot" // drift on any of the eight CAS values (§7)
  | "address_blank" // §11
  | "bidet_downgrade_forbidden" // §8
  | "bidet_survey_conflict" // §8 surveyed row
  | "coordinates_partial" // §12 pair rule
  | "coordinate_out_of_bounds" // §12 service area
  | "coordinate_evidence_required" // §12 evidence
  | "proximity_conflict" // §12 30 m guard
  | "phase2_failed"; // crash window: canonical changed, ledger/event not committed

export type DriftEntry = {
  column: string;
  base_value: unknown;
  current_value: unknown;
};

export type PromotionResult =
  | {
      ok: true;
      promotionId: string;
      canonicalId: string;
      changedColumns: readonly string[];
      promotedAt: string;
    }
  | {
      ok: false;
      reason: PromotionFailureReason;
      message: string;
      // Machine-readable extras: drift report, conflicting neighbour ids…
      details?: Record<string, unknown>;
    };

type Fail = Extract<PromotionResult, { ok: false }>;

function fail(
  reason: PromotionFailureReason,
  message: string,
  details?: Record<string, unknown>,
): Fail {
  return details === undefined ? { ok: false, reason, message } : { ok: false, reason, message, details };
}

// ---------------------------------------------------------------------------
// Stored-row shapes (SELECT surface kept minimal and explicit)
// ---------------------------------------------------------------------------

type StoredContribution = {
  contribution_id: string;
  kind: ContributionKind;
  target_canonical_id: string | null;
  contributor_user_id: string | null;
  status: ContributionStatus;
  payload_json: string;
  evidence_json: string | null;
};

type FreshCanonicalRow = {
  canonical_id: string;
  updated_at: string;
  access: string;
  fee: string;
  bidet_presence: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  bidet_source_id: string | null;
  // Stage 14M: the stored activation status. Read-only context for the
  // active-target guard, exactly like `bidet_source_id` above — it is not in
  // the writable allow-list and never reaches a SET fragment.
  record_status: string | null;
};

const CONTRIBUTION_SELECT =
  `SELECT contribution_id, kind, target_canonical_id, contributor_user_id, status, ` +
  `payload_json, evidence_json FROM contributions WHERE contribution_id = ?`;

// The snapshot columns plus the two protected context columns the bidet policy
// and the Stage 14M active-target guard need to READ (never write). The
// `record_status` column is why the guard can trust stored database state: the
// value the executor compares is selected here, never accepted from a caller.
const CANONICAL_SELECT =
  `SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, ` +
  `latitude, longitude, bidet_source_id, record_status FROM canonical_locations WHERE canonical_id = ?`;

// The one activation value that retires a canonical row from the active
// catalogue while keeping it as lineage (Stage 14K). Same value the public read
// model excludes with `WHERE record_status <> 'rejected'`; any other status
// ('candidate', 'community-submitted', 'verified', 'disputed', 'outdated')
// stays promotable, because retiring a record is an owner decision, not a
// promotion-time one.
const REJECTED_RECORD_STATUS = "rejected";

async function loadContribution(
  db: D1Database,
  contributionId: string,
): Promise<StoredContribution | null> {
  if (!CONTRIBUTION_ID_RE.test(contributionId)) return null;
  return db.prepare(CONTRIBUTION_SELECT).bind(contributionId).first<StoredContribution>();
}

async function loadCanonical(db: D1Database, canonicalId: string): Promise<FreshCanonicalRow | null> {
  if (!CANONICAL_ID_RE.test(canonicalId)) return null;
  return db.prepare(CANONICAL_SELECT).bind(canonicalId).first<FreshCanonicalRow>();
}

// Bounding-box neighbour fetch for the execution-time proximity re-check.
// Degrees are derived generously from the metre threshold; the precise
// haversine decision stays in the planner's exported helper.
async function loadNearby(
  db: D1Database,
  latitude: number,
  longitude: number,
  excludeId: string,
  thresholdMeters: number,
): Promise<NearbyCanonicalRow[]> {
  const latPad = thresholdMeters / 100_000 + 0.001;
  const lonPad = thresholdMeters / 100_000 + 0.001;
  const { results } = await db
    .prepare(
      `SELECT canonical_id, latitude, longitude FROM canonical_locations
       WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
         AND canonical_id <> ?
       LIMIT 500`,
    )
    .bind(latitude - latPad, latitude + latPad, longitude - lonPad, longitude + lonPad, excludeId)
    .all<NearbyCanonicalRow>();
  return results;
}

function parseJsonOrNull(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function newPromotionId(): string {
  // §5.2 / mission Phase 8 format: promo_<32 hex characters> (38 chars, inside
  // the 8-64 length CHECK). Random UUID hex, matching the repo's existing
  // contribution/event id convention — NOT derived from the updated_at stamp
  // (see the module README note in the reconciliation section below).
  return `promo_${crypto.randomUUID().replace(/-/g, "")}`;
}

function newEventId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, "")}`;
}

// ---------------------------------------------------------------------------
// Phase 3 — structural plan validation (trust the planner only after this)
// ---------------------------------------------------------------------------

function validatePlanShape(plan: PromotionPlan): Fail | null {
  if (!plan || typeof plan !== "object") {
    return fail("invalid_plan", "executor needs a planner plan object");
  }
  if (typeof plan.canonical_id !== "string" || !CANONICAL_ID_RE.test(plan.canonical_id)) {
    return fail("invalid_plan", "plan canonical id is missing or malformed", {
      canonical_id: String(plan.canonical_id),
    });
  }
  if (typeof plan.contribution_id !== "string" || !CONTRIBUTION_ID_RE.test(plan.contribution_id)) {
    return fail("invalid_plan", "plan contribution id is missing or malformed");
  }
  if (
    typeof plan.kind !== "string" ||
    !(PROMOTABLE_KINDS as readonly string[]).includes(plan.kind)
  ) {
    return fail("kind_not_promotable", "a plan kind outside the four promotable kinds cannot execute", {
      kind: String(plan.kind),
    });
  }
  if (typeof plan.contributor_user_id !== "string" || plan.contributor_user_id.length === 0) {
    // The ledger's contributor_user_id is NOT NULL and traceability is the
    // point of the whole stage — an anonymous legacy claim is not promotable.
    return fail("invalid_plan", "plan carries no contributor id to attribute the promotion to");
  }

  const changed = plan.changed_columns;
  if (!Array.isArray(changed) || changed.length === 0) {
    return fail("invalid_plan", "plan changes nothing; a promotion must name at least one column");
  }
  const seen = new Set<string>();
  for (const column of changed) {
    if (typeof column !== "string" || !WRITABLE_CANONICAL_COLUMNS.includes(column)) {
      // Protected fields, SQL-shaped names, and unknown keys all land here:
      // nothing outside the frozen seven-column allow-list is ever reachable.
      return fail("invalid_plan", "plan names a column promotion may never write", { column: String(column) });
    }
    if (seen.has(column)) {
      return fail("invalid_plan", "plan changed_columns contains a duplicate", { column });
    }
    seen.add(column);
  }

  const resulting = plan.resulting_values;
  if (!resulting || typeof resulting !== "object" || Array.isArray(resulting)) {
    return fail("invalid_plan", "plan resulting_values must be an object");
  }
  const resultingKeys = Object.keys(resulting);
  if (
    resultingKeys.length !== changed.length ||
    !resultingKeys.every((key) => seen.has(key))
  ) {
    // Extra keys (smuggled protected writes) and missing keys are both fatal.
    return fail("invalid_plan", "plan resulting_values keys must match changed_columns exactly", {
      changed_columns: [...changed],
      resulting_keys: resultingKeys,
    });
  }

  const snapshot = plan.base_snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return fail("invalid_plan", "plan is missing its base snapshot");
  }
  const snapshotKeys = Object.keys(snapshot);
  if (
    snapshotKeys.length !== SNAPSHOT_COLUMNS.length ||
    !SNAPSHOT_COLUMNS.every((column) => column in snapshot)
  ) {
    return fail("invalid_plan", "plan base snapshot must carry exactly the eight CAS values", {
      expected: SNAPSHOT_COLUMNS,
      actual: snapshotKeys,
    });
  }
  if (typeof snapshot.updated_at !== "string" || snapshot.updated_at.length === 0) {
    return fail("invalid_plan", "plan base snapshot updated_at is missing");
  }

  // Per-column value domains, so an absurd plan fails as a clean structured
  // refusal instead of a raw database CHECK crash.
  for (const column of changed) {
    const value = resulting[column as keyof typeof resulting];
    const check = validateResultingValue(column, value);
    if (!check.ok) return fail(check.reason, check.message, { column });
  }
  return null;
}

function validateResultingValue(
  column: string,
  value: unknown,
): { ok: true } | { ok: false; reason: PromotionFailureReason; message: string } {
  switch (column) {
    case "access":
      return (ACCESS_VALUES as readonly string[]).includes(value as string)
        ? { ok: true }
        : { ok: false, reason: "invalid_plan", message: "resulting access is outside the canonical enum" };
    case "fee":
      return (FEE_VALUES as readonly string[]).includes(value as string)
        ? { ok: true }
        : { ok: false, reason: "invalid_plan", message: "resulting fee is outside the canonical enum" };
    case "bidet_presence":
      return (BIDET_PRESENCE_VALUES as readonly string[]).includes(value as string)
        ? { ok: true }
        : { ok: false, reason: "invalid_plan", message: "resulting bidet_presence is outside the canonical domain" };
    case "name":
      return typeof value === "string" && value.trim().length > 0 && value.length <= 200
        ? { ok: true }
        : { ok: false, reason: "invalid_plan", message: "resulting name must be a short non-empty string" };
    case "address":
      // §11 re-checked at execution time against whatever the plan proposes.
      return typeof value === "string" && value.trim().length > 0 && value.length <= 300
        ? { ok: true }
        : { ok: false, reason: "address_blank", message: "a promoted address must be non-empty and non-whitespace" };
    case "latitude":
      return typeof value === "number" && Number.isFinite(value) && value >= LATITUDE_BOUNDS.min && value <= LATITUDE_BOUNDS.max
        ? { ok: true }
        : { ok: false, reason: "coordinate_out_of_bounds", message: "resulting latitude is outside the Dumaguete service area" };
    case "longitude":
      return typeof value === "number" && Number.isFinite(value) && value >= LONGITUDE_BOUNDS.min && value <= LONGITUDE_BOUNDS.max
        ? { ok: true }
        : { ok: false, reason: "coordinate_out_of_bounds", message: "resulting longitude is outside the Dumaguete service area" };
    default:
      return { ok: false, reason: "invalid_plan", message: "unknown column in plan" };
  }
}

// ---------------------------------------------------------------------------
// Phase 2 + 3 — stored-contribution revalidation against the plan
// ---------------------------------------------------------------------------

function planContributionMismatch(
  row: StoredContribution,
  plan: PromotionPlan,
): Fail | null {
  if (row.contribution_id !== plan.contribution_id) {
    return fail("invalid_plan", "plan contribution id does not match the stored row");
  }
  if (row.kind !== plan.kind) {
    return fail("invalid_plan", "plan kind does not match the stored contribution", {
      stored: row.kind,
      plan: plan.kind,
    });
  }
  if (row.target_canonical_id !== plan.canonical_id) {
    return fail("invalid_plan", "plan target does not match the stored contribution", {
      stored: String(row.target_canonical_id),
      plan: plan.canonical_id,
    });
  }
  if (row.contributor_user_id !== plan.contributor_user_id) {
    return fail("invalid_plan", "plan contributor does not match the stored contribution");
  }
  if (row.status !== "approved") {
    return fail("not_approved", "only an approved contribution can be promoted", {
      status: row.status,
    });
  }
  // Every planned write must be present, byte-equal, in the STORED payload.
  // A plan cannot introduce a value the contributor never proposed, and a
  // column outside the kind's §10 set can never reach SQL.
  const payload = parseJsonOrNull(row.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return fail("invalid_plan", "stored payload is not a JSON object");
  }
  const record = payload as Record<string, unknown>;
  const kindColumns = KIND_COLUMNS[plan.kind] ?? [];
  for (const column of plan.changed_columns) {
    if (!kindColumns.includes(column)) {
      return fail("invalid_plan", "plan changes a column its kind may never write", {
        kind: plan.kind,
        column,
      });
    }
    if (!(column in record) || record[column] !== plan.resulting_values[column as keyof PromotionPlan["resulting_values"]]) {
      return fail("invalid_plan", "plan value does not match the stored payload", { column });
    }
  }
  // §12 pair rule re-checked against the stored payload, not the plan: a
  // legacy row that predates the planner's rule still cannot half-move a pin.
  const hasLat = "latitude" in record;
  const hasLon = "longitude" in record;
  if (hasLat !== hasLon) {
    return fail("coordinates_partial", "stored payload proposes one coordinate without the other");
  }
  return null;
}

// §12 evidence re-check against the stored evidence_json (plan.evidence is
// whatever the caller handed the planner; the row is the authority).
function coordinateEvidenceCheck(row: StoredContribution, plan: PromotionPlan): Fail | null {
  const changesCoords =
    plan.changed_columns.includes("latitude") || plan.changed_columns.includes("longitude");
  if (!changesCoords) return null;
  const parsed = parseJsonOrNull(row.evidence_json ?? "[]");
  const entries = Array.isArray(parsed) ? parsed : [];
  const supporting = entries.filter(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { type?: unknown }).type === "string" &&
      COORDINATE_EVIDENCE_TYPES.has((entry as { type: string }).type),
  );
  if (supporting.length === 0) {
    return fail("coordinate_evidence_required", "a coordinate promotion needs field_observation or external_source evidence stored on the contribution");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 5 — NULL-safe fresh-vs-plan drift comparison
// ---------------------------------------------------------------------------

function computeDrift(plan: PromotionPlan, fresh: FreshCanonicalRow): DriftEntry[] {
  const drift: DriftEntry[] = [];
  for (const column of SNAPSHOT_COLUMNS) {
    const base = (plan.base_snapshot as unknown as Record<string, unknown>)[column];
    const current = (fresh as unknown as Record<string, unknown>)[column];
    if (!sameValue(base, current)) {
      drift.push({ column, base_value: base ?? null, current_value: current ?? null });
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Phase 6 — execution-time policy recheck against the fresh row
// ---------------------------------------------------------------------------

function freshRowPolicyCheck(plan: PromotionPlan, fresh: FreshCanonicalRow): Fail | null {
  // §8 bidet: a downgrade is never a promotion; a surveyed row is DB-protected
  // on top, and the executor says why before the CHECK has to crash.
  if (plan.changed_columns.includes("bidet_presence")) {
    const resulting = plan.resulting_values.bidet_presence;
    if (fresh.bidet_presence === "Yes" && resulting === "Unknown") {
      if (fresh.bidet_source_id !== null && fresh.bidet_source_id !== undefined) {
        return fail("bidet_survey_conflict", "the field survey recorded this bidet; only a re-survey may change it", {
          bidet_source_id: fresh.bidet_source_id,
        });
      }
      return fail("bidet_downgrade_forbidden", "a positive bidet claim is corrected by a reversal, never by a downgrading promotion");
    }
  }
  return null;
}

// Stage 14M — the activation guard, placed with the data-integrity checks the
// executor already performs on the freshly loaded canonical row. A rejected
// canonical row is retained lineage (Stage 14K Pulantubig merge) and is not
// part of the ACTIVE canonical dataset, so it can never be a promotion target.
// Deliberately an explicit refusal rather than a silent "not found": the row
// exists, the contribution's foreign key is still valid, and a promoter (or a
// future alternate caller) gets a machine-readable reason instead of a lookup
// that quietly contradicts the stored data.
function rejectedTargetCheck(fresh: FreshCanonicalRow): Fail | null {
  if (fresh.record_status !== REJECTED_RECORD_STATUS) return null;
  return fail(
    "canonical_target_rejected",
    "the canonical target is rejected lineage and is not part of the active dataset; a rejected record can never receive a promotion",
    {
      canonical_id: fresh.canonical_id,
      record_status: fresh.record_status,
    },
  );
}

async function proximityRecheck(
  db: PromotionDatabase,
  plan: PromotionPlan,
  fresh: FreshCanonicalRow,
): Promise<Fail | null> {
  const changesCoords =
    plan.changed_columns.includes("latitude") || plan.changed_columns.includes("longitude");
  if (!changesCoords) return null;
  const resulting = plan.resulting_values as Record<string, string | number>;
  // Final position after the write: planned values where present, else current.
  const latitude = typeof resulting.latitude === "number" ? resulting.latitude : fresh.latitude;
  const longitude = typeof resulting.longitude === "number" ? resulting.longitude : fresh.longitude;
  const threshold =
    typeof plan.policy?.proximity_threshold_meters === "number"
      ? plan.policy.proximity_threshold_meters
      : PROXIMITY_THRESHOLD_METERS;
  const nearby = await loadNearby(db, latitude, longitude, plan.canonical_id, threshold);
  const conflict = findProximityConflict(latitude, longitude, plan.canonical_id, nearby, threshold);
  if (conflict !== null) {
    // Informative refusal only — never an auto-merge, never an override (§12).
    return fail("proximity_conflict", "the promoted position lands within the proximity guard of another canonical place; a human must reconcile", {
      nearby_canonical_ids: conflict,
      threshold_meters: threshold,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 7 — the guarded canonical UPDATE (CAS)
// ---------------------------------------------------------------------------

// SQL text is fully static except for SET fragments looked up from the frozen
// SET_FRAGMENTS map (keys are the seven allow-list columns, verified earlier).
// Every value — SET values and all eight snapshot guards — is a `?` bind.
// The `IS` operator gives the NULL-safe comparison contract §7 requires;
// ordinary `=` would silently miss NULL<->value drift.
function buildGuardedUpdate(plan: PromotionPlan): { sql: string; values: unknown[] } {
  const orderedColumns = WRITABLE_CANONICAL_COLUMNS.filter((column) =>
    plan.changed_columns.includes(column),
  );
  const setParts = orderedColumns.map((column) => SET_FRAGMENTS[column]);
  const values: unknown[] = orderedColumns.map(
    (column) => plan.resulting_values[column as keyof PromotionPlan["resulting_values"]],
  );
  const snapshot = plan.base_snapshot as unknown as Record<string, unknown>;
  const sql =
    `UPDATE canonical_locations ` +
    `SET ${setParts.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ` +
    `WHERE canonical_id = ? ` +
    SNAPSHOT_COLUMNS.map((column) => `AND ${column} IS ?`).join(" ");
  values.push(plan.canonical_id);
  for (const column of SNAPSHOT_COLUMNS) values.push(snapshot[column] ?? null);
  return { sql, values };
}

// ---------------------------------------------------------------------------
// Phase 8 + 9 — ledger row + audit event, one atomic batch
// ---------------------------------------------------------------------------

function buildPhase2Statements(
  plan: PromotionPlan,
  args: {
    promotionId: string;
    promoterUserId: string;
    promotionNote: string | null;
  },
): { ledger: string; ledgerValues: unknown[]; event: string; eventValues: unknown[] } {
  const detail = {
    action: "canonical_promoted",
    promotion_id: args.promotionId,
    canonical_id: plan.canonical_id,
    changed_columns: [...plan.changed_columns],
  };
  // §6: a status_change event with from == to == 'approved' stays inside the
  // existing 0005 event_type CHECK — no new event type, no status invention,
  // and the contribution row itself is never written (§3.1 immutability).
  return {
    ledger:
      `INSERT INTO canonical_promotions ` +
      `(promotion_id, contribution_id, canonical_id, kind, contributor_user_id, promoter_user_id, ` +
      `base_snapshot_json, changed_columns_json, resulting_values_json, status, reversal_of, promotion_note) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'promoted', NULL, ?)`,
    ledgerValues: [
      args.promotionId,
      plan.contribution_id,
      plan.canonical_id,
      plan.kind,
      plan.contributor_user_id,
      args.promoterUserId,
      // The snapshot that the guarded UPDATE actually matched — exactly
      // restorable for a future reversal (§18), and only the seven frozen
      // fields + updated_at are serialized (§5.2).
      JSON.stringify(pickSnapshot(plan.base_snapshot)),
      JSON.stringify([...plan.changed_columns]),
      JSON.stringify(pickResulting(plan)),
      args.promotionNote,
    ],
    event:
      `INSERT INTO contribution_events ` +
      `(event_id, contribution_id, event_type, actor_type, actor_id, from_status, to_status, detail_json) ` +
      `VALUES (?, ?, 'status_change', 'moderator', ?, 'approved', 'approved', ?)`,
    eventValues: [
      newEventId(),
      plan.contribution_id,
      args.promoterUserId,
      JSON.stringify(detail),
    ],
  };
}

function pickSnapshot(snapshot: PromotionPlan["base_snapshot"]): Record<string, unknown> {
  const source = snapshot as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const column of SNAPSHOT_COLUMNS) out[column] = source[column] ?? null;
  return out;
}

function pickResulting(plan: PromotionPlan): Record<string, string | number> {
  // Only the changed writable fields, from the frozen allow-list — protected
  // fields can never appear here even by accident.
  const out: Record<string, string | number> = {};
  for (const column of plan.changed_columns) {
    out[column] = plan.resulting_values[column as keyof PromotionPlan["resulting_values"]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export type PromotionExecutionInput = {
  // The contribution to promote, by stored id. Nothing else about the change
  // is accepted from the caller: not columns, not values, not the target.
  contributionId: string;
  // A Stage 14C planner result for this exact contribution. The executor
  // treats it as trusted only after the Phase 3 structural checks below.
  plan: PromotionPlan;
  // Recorded for attribution; authorization is NOT decided here (14E seam).
  promoterUserId: string;
  promotionNote?: string | null;
};

export async function executeCanonicalPromotion(
  db: PromotionDatabase,
  input: PromotionExecutionInput,
): Promise<PromotionResult> {
  if (typeof input.promoterUserId !== "string" || input.promoterUserId.length === 0) {
    return fail("invalid_plan", "executor needs a promoter id to record for attribution");
  }
  const note = input.promotionNote ?? null;
  if (note !== null && (typeof note !== "string" || note.length > MAX_PROMOTION_NOTE_LENGTH)) {
    return fail("invalid_plan", "promotion note is missing or too long", {
      max: MAX_PROMOTION_NOTE_LENGTH,
    });
  }

  // Phase 3 — structural plan validation.
  const shapeError = validatePlanShape(input.plan);
  if (shapeError) return shapeError;
  const plan = input.plan;
  if (plan.contribution_id !== input.contributionId) {
    return fail("invalid_plan", "plan is for a different contribution than requested", {
      requested: input.contributionId,
      plan: plan.contribution_id,
    });
  }

  // Phase 2 — the stored contribution is the authority on approval, kind,
  // target, and contributor.
  const row = await loadContribution(db, input.contributionId);
  if (!row) return fail("not_found", "contribution not found");
  if (row.kind === "new_location") {
    return fail("manual_import_only", "new_location promotion is a manual owner import (§13)");
  }
  if (!(PROMOTABLE_KINDS as readonly string[]).includes(row.kind)) {
    return fail("kind_not_promotable", `${row.kind} is a signal for a human reviewer, not a promotable change`);
  }
  const storedError = planContributionMismatch(row, plan);
  if (storedError) return storedError;
  const evidenceError = coordinateEvidenceCheck(row, plan);
  if (evidenceError) return evidenceError;

  // Phase 4 — replay gate. UNIQUE(contribution_id) stays the final
  // database-level protection; this pre-check just makes the common replay a
  // clean, deterministic answer instead of a crashed batch.
  const existing = await db
    .prepare(`SELECT promotion_id FROM canonical_promotions WHERE contribution_id = ?`)
    .bind(plan.contribution_id)
    .first<{ promotion_id: string }>();
  if (existing) {
    return fail("already_promoted", "this contribution has already been promoted; replays change nothing", {
      promotion_id: existing.promotion_id,
    });
  }

  // Phase 5 — fresh snapshot vs the plan's base snapshot, NULL-safe.
  const fresh = await loadCanonical(db, plan.canonical_id);
  if (!fresh) return fail("canonical_target_not_found", "canonical target row no longer exists");
  // Stage 14M — before any value comparison or write, the target must be an
  // ACTIVE canonical record. The status is read from the stored row, so no
  // caller-supplied field can influence this decision.
  const rejectedError = rejectedTargetCheck(fresh);
  if (rejectedError) return rejectedError;
  const drift = computeDrift(plan, fresh);
  if (drift.length > 0) {
    // Never force, never auto-retry, never silently re-plan (§7): the caller
    // must decide about a fresh plan against the new state.
    return fail("stale_snapshot", "canonical data drifted from the plan's base snapshot", {
      drift,
    });
  }

  // Phase 6 — execution-time policy on the fresh row.
  const policyError = freshRowPolicyCheck(plan, fresh);
  if (policyError) return policyError;
  const proximityError = await proximityRecheck(db, plan, fresh);
  if (proximityError) return proximityError;

  // Phase 1 of the two-phase write: the guarded CAS UPDATE, alone in its own
  // statement (a single statement is atomic in SQLite/D1 — no RETURNING is
  // assumed or required).
  const { sql, values } = buildGuardedUpdate(plan);
  const updateResult = await db.prepare(sql).bind(...values).run();
  const changedRows = updateResult.meta?.changes ?? 0;
  if (changedRows !== 1) {
    // Drift landed between the snapshot read and the UPDATE — the guard did
    // its job. Re-read to report it honestly; nothing was written.
    const now = await loadCanonical(db, plan.canonical_id);
    return fail("stale_snapshot", "the compare-and-swap guard matched no rows; the snapshot changed concurrently", {
      drift: now ? computeDrift(plan, now) : [],
      concurrent: true,
    });
  }

  // Phase 2 of the two-phase write: ledger + event in ONE db.batch()
  // (contract §6) so the UNIQUE(contribution_id) replay gate and the audit
  // event commit together or not at all.
  const promotionId = newPromotionId();
  const built = buildPhase2Statements(plan, {
    promotionId,
    promoterUserId: input.promoterUserId,
    promotionNote: note,
  });
  try {
    await db.batch([
      db.prepare(built.ledger).bind(...built.ledgerValues),
      db.prepare(built.event).bind(...built.eventValues),
    ]);
  } catch (error) {
    // The crash window (§6 residual, Phase 10): canonical is changed and
    // committed, the evidence trail is not. Success is NEVER claimed; the
    // orphan is detectable by reconcileCanonicalPromotions below.
    return fail("phase2_failed", "canonical was updated but the ledger/event batch failed; the promotion must be reconciled", {
      canonical_id: plan.canonical_id,
      contribution_id: plan.contribution_id,
      expected_promotion_id: promotionId,
      changed_columns: [...plan.changed_columns],
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const promotedAtRow = await db
    .prepare(`SELECT promoted_at FROM canonical_promotions WHERE promotion_id = ?`)
    .bind(promotionId)
    .first<{ promoted_at: string }>();

  return {
    ok: true,
    promotionId,
    canonicalId: plan.canonical_id,
    changedColumns: [...plan.changed_columns],
    promotedAt: promotedAtRow?.promoted_at ?? "",
  };
}

// ---------------------------------------------------------------------------
// The single authoritative entry point
// ---------------------------------------------------------------------------

export type PlanAndExecuteInput = {
  contributionId: string;
  promoterUserId: string;
  promotionNote?: string | null;
};

// Maps the planner's stable error codes onto executor failure reasons so
// callers see one result vocabulary regardless of where the refusal happened.
function plannerFailure(error: { code: string; message: string; details?: Record<string, unknown> }): Fail {
  switch (error.code) {
    case "unsupported_new_location":
      return fail("manual_import_only", error.message, error.details);
    case "unsupported_kind":
      return fail("kind_not_promotable", error.message, error.details);
    case "contribution_not_approved":
      return fail("not_approved", error.message, error.details);
    case "canonical_target_required":
    case "invalid_target":
      return fail("canonical_target_not_found", error.message, error.details);
    case "blank_address":
      return fail("address_blank", error.message, error.details);
    case "incomplete_coordinate_pair":
      return fail("coordinates_partial", error.message, error.details);
    case "invalid_coordinates":
      return fail("coordinate_out_of_bounds", error.message, error.details);
    case "coordinate_evidence_required":
      return fail("coordinate_evidence_required", error.message, error.details);
    case "proximity_conflict":
      return fail("proximity_conflict", error.message, error.details);
    case "bidet_downgrade_forbidden":
      return fail(
        error.details?.surveyed === true ? "bidet_survey_conflict" : "bidet_downgrade_forbidden",
        error.message,
        error.details,
      );
    default:
      // redundant_noop, invalid_payload, forbidden_field, name_pii_shape:
      // nothing about these may reach the database, and each stays visible
      // as its own machine-readable reason inside details.
      return fail("invalid_plan", error.message, { planner_code: error.code, ...error.details });
  }
}

/**
 * The one authoritative promotion path: load the stored contribution, plan it
 * with the Stage 14C planner against the CURRENT canonical row (plus nearby
 * rows for the proximity guard), then execute the resulting plan. Callers
 * supply only ids and the promoter identity — never values, columns, targets,
 * or snapshots, all of which are read back from stored data.
 */
export async function planAndExecuteCanonicalPromotion(
  db: PromotionDatabase,
  input: PlanAndExecuteInput,
): Promise<PromotionResult> {
  const row = await loadContribution(db, input.contributionId);
  if (!row) return fail("not_found", "contribution not found");
  if (row.kind === "new_location") {
    return fail("manual_import_only", "new_location promotion is a manual owner import (§13)");
  }
  if (row.target_canonical_id === null) {
    return fail("canonical_target_not_found", "contribution carries no canonical target");
  }
  const fresh = await loadCanonical(db, row.target_canonical_id);
  if (!fresh) {
    return fail("canonical_target_not_found", "canonical target row no longer exists", {
      canonical_id: row.target_canonical_id,
    });
  }
  // Stage 14M — the plan is built from the current canonical row, so an
  // inactive target is refused here instead of being planned around. The
  // executor re-applies the same guard; this is an early exit on the
  // authoritative path, never a substitute for it.
  const rejectedError = rejectedTargetCheck(fresh);
  if (rejectedError) return rejectedError;

  // The planner needs candidate neighbours for §12; it cannot query. Fetch a
  // box only when the stored payload actually proposes a coordinate pair —
  // this is plumbing for the planner's rule, not a second copy of it.
  let nearby: NearbyCanonicalRow[] | null = null;
  const payload = parseJsonOrNull(row.payload_json);
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "latitude" in (payload as object) &&
    "longitude" in (payload as object)
  ) {
    const proposed = payload as { latitude: unknown; longitude: unknown };
    if (typeof proposed.latitude === "number" && typeof proposed.longitude === "number") {
      nearby = await loadNearby(db, proposed.latitude, proposed.longitude, fresh.canonical_id, PROXIMITY_THRESHOLD_METERS);
    }
  }

  const planned = planCanonicalPromotion({
    contribution: {
      contribution_id: row.contribution_id,
      kind: row.kind,
      status: row.status,
      target_canonical_id: row.target_canonical_id,
      contributor_user_id: row.contributor_user_id,
      payload_json: row.payload_json,
      evidence_json: row.evidence_json,
    },
    target: fresh as unknown as CanonicalTargetRow,
    nearbyLocations: nearby,
  });
  if (!planned.ok) return plannerFailure(planned.error);

  return executeCanonicalPromotion(db, {
    contributionId: input.contributionId,
    plan: planned.plan,
    promoterUserId: input.promoterUserId,
    promotionNote: input.promotionNote ?? null,
  });
}

// ---------------------------------------------------------------------------
// Stage 14 ownership completion — guarded promotion reversal (contract §18)
// ---------------------------------------------------------------------------

// The executor reasons a reversal can refuse for, kept in the same result
// vocabulary style as promotion so the HTTP seam maps them in one place.
export type ReversalFailureReason =
  | "not_found"                     // malformed / absent promotion id
  | "invalid_reversal"              // ledger row is structurally unusable
  | "already_reversed"              // §18: one forward append per promotion
  | "canonical_target_not_found"    // the promoted row no longer exists
  | "canonical_target_rejected"     // Stage 14M: retired lineage is not writable
  | "superseded_by_later_edit"      // §18: canonical drifted from resulting values
  | "phase2_failed";                // crash window, same residual as promotion

export type ReversalResult =
  | {
      ok: true;
      reversalId: string;
      reversesPromotionId: string;
      canonicalId: string;
      changedColumns: readonly string[];
      restoredValues: Readonly<Record<string, unknown>>;
      reversedAt: string;
    }
  | {
      ok: false;
      reason: ReversalFailureReason;
      message: string;
      details?: Record<string, unknown>;
    };

type FailReversal = Extract<ReversalResult, { ok: false }>;

function failReversal(
  reason: ReversalFailureReason,
  message: string,
  details?: Record<string, unknown>,
): FailReversal {
  return details === undefined ? { ok: false, reason, message } : { ok: false, reason, message, details };
}

const PROMOTION_ID_RE = /^promo_[0-9a-f]{32}$/;

// The stored ledger row, read back through the SAME fixed column surface as
// every other read here. Nothing about the restore is accepted from the
// caller: changed columns, base values, resulting values, and the target are
// exactly what the original promotion durably recorded.
type StoredPromotion = {
  promotion_id: string;
  contribution_id: string;
  canonical_id: string;
  kind: string;
  contributor_user_id: string;
  promoter_user_id: string;
  base_snapshot_json: string;
  changed_columns_json: string;
  resulting_values_json: string;
  reversal_of: string | null;
};

const PROMOTION_SELECT =
  `SELECT promotion_id, contribution_id, canonical_id, kind, contributor_user_id, ` +
  `promoter_user_id, base_snapshot_json, changed_columns_json, resulting_values_json, reversal_of ` +
  `FROM canonical_promotions WHERE promotion_id = ?`;

// Structural validation of the stored row against the frozen §5.2 rules. A
// ledger row that predates or disagrees with the contract (unknown column,
// unparsable JSON, empty change set) is refused explicitly — the executor
// never guesses at what a malformed historical row "probably" meant.
function validateStoredPromotion(original: StoredPromotion): FailReversal | null {
  const changed = parseJsonOrNull(original.changed_columns_json);
  if (!Array.isArray(changed) || changed.length === 0) {
    return failReversal("invalid_reversal", "the promotion's changed_columns_json is missing or empty", {
      promotion_id: original.promotion_id,
    });
  }
  for (const column of changed) {
    if (typeof column !== "string" || !WRITABLE_CANONICAL_COLUMNS.includes(column)) {
      return failReversal("invalid_reversal", "the promotion names a column reversal may never restore", {
        column: String(column),
      });
    }
  }
  if (new Set(changed).size !== changed.length) {
    return failReversal("invalid_reversal", "the promotion's changed_columns_json contains a duplicate");
  }
  const base = parseJsonOrNull(original.base_snapshot_json);
  const resulting = parseJsonOrNull(original.resulting_values_json);
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    return failReversal("invalid_reversal", "the promotion's base_snapshot_json is not a JSON object");
  }
  if (!resulting || typeof resulting !== "object" || Array.isArray(resulting)) {
    return failReversal("invalid_reversal", "the promotion's resulting_values_json is not a JSON object");
  }
  const baseRecord = base as Record<string, unknown>;
  const resultingRecord = resulting as Record<string, unknown>;
  for (const column of changed as string[]) {
    if (!(column in baseRecord) || !(column in resultingRecord)) {
      return failReversal("invalid_reversal", "the promotion's recorded values do not cover every changed column", {
        column,
      });
    }
    if (column === "latitude" || column === "longitude") {
      // §12 pair rule holds in reverse too: a coordinate half-restore can
      // strand the pin anywhere, and STRICT REAL binds reject non-numbers.
      if (typeof baseRecord[column] !== "number" || !Number.isFinite(baseRecord[column] as number)) {
        return failReversal("invalid_reversal", "the promotion's stored coordinate base value is not a finite number", {
          column,
        });
      }
    } else if (typeof baseRecord[column] !== "string") {
      return failReversal("invalid_reversal", "the promotion's stored base value is not a string", { column });
    }
  }
  // A reversal row must never itself be a reversal target of a reversal-of-
  // reversal chain check here — §18 permits the chain (each is a fresh
  // forward append); this guard only refuses restoring a row that was NOT a
  // real promotion (there is no such row today: status is CHECK-pinned).
  if (original.kind === "new_location") {
    return failReversal("invalid_reversal", "new_location has no promotion path, so it has no reversal path");
  }
  return null;
}

// Which of the eight CAS values currently differ from what the promotion
// recorded as its outcome. §18's restore precondition is exactly this set
// being empty for the CHANGED columns; drift elsewhere is caught by the
// guarded UPDATE as `stale_snapshot`-style refusal below.
function reversalOutcomeDrift(
  original: { changed_columns: string[]; resulting: Record<string, unknown> },
  fresh: FreshCanonicalRow,
): DriftEntry[] {
  const drift: DriftEntry[] = [];
  for (const column of original.changed_columns) {
    const expected = original.resulting[column];
    const current = (fresh as unknown as Record<string, unknown>)[column];
    if (!sameValue(expected, current)) {
      drift.push({ column, base_value: expected, current_value: current ?? null });
    }
  }
  return drift;
}

export type ReversalExecutionInput = {
  // The promotion to reverse, by stored ledger id. Nothing else about the
  // restore is accepted from the caller.
  promotionId: string;
  // Recorded for attribution; authorization is decided by the 14E-class seam,
  // not here (same split as promotion).
  promoterUserId: string;
  reversalNote?: string | null;
};

/**
 * The §18 guarded reversal: restore EXACTLY what one promotion changed, as a
 * new forward-appended ledger row. Two-phase write with the same documented
 * crash window as promotion (§6): a CAS-guarded canonical UPDATE alone, then
 * ONE db.batch() appending the ledger row (`reversal_of` linked, carrying its
 * own freshly-captured base snapshot) and the audit event. Refuses — and
 * writes nothing — unless the canonical row still equals the original
 * promotion's recorded outcome for every changed column, the target is still
 * an ACTIVE canonical record (Stage 14M), and no reversal of this promotion
 * exists yet. History is never edited or deleted: the original row stays.
 */
export async function executeCanonicalPromotionReversal(
  db: PromotionDatabase,
  input: ReversalExecutionInput,
): Promise<ReversalResult> {
  if (typeof input.promoterUserId !== "string" || input.promoterUserId.length === 0) {
    return failReversal("invalid_reversal", "executor needs a promoter id to record for attribution");
  }
  const note = input.reversalNote ?? null;
  if (note !== null && (typeof note !== "string" || note.length > MAX_PROMOTION_NOTE_LENGTH)) {
    return failReversal("invalid_reversal", "reversal note is missing or too long", {
      max: MAX_PROMOTION_NOTE_LENGTH,
    });
  }
  if (typeof input.promotionId !== "string" || !PROMOTION_ID_RE.test(input.promotionId)) {
    return failReversal("not_found", "promotion not found");
  }

  // 1. The original promotion row, read from the ledger (the sole authority).
  const original = await db.prepare(PROMOTION_SELECT).bind(input.promotionId).first<StoredPromotion>();
  if (!original) return failReversal("not_found", "promotion not found");
  const structural = validateStoredPromotion(original);
  if (structural) return structural;
  const changedColumns = parseJsonOrNull(original.changed_columns_json) as string[];
  const baseSnapshot = parseJsonOrNull(original.base_snapshot_json) as Record<string, unknown>;
  const resultingValues = parseJsonOrNull(original.resulting_values_json) as Record<string, unknown>;

  // 2. One §18 forward append per promotion. UNIQUE(contribution_id) was
  // relaxed by migration 0009 precisely so the reversal row can exist; this
  // pre-check keeps a second reversal of the SAME promotion a clean
  // deterministic refusal (the phase-2 batch below carries the guard into
  // the transaction for the race case).
  const existingReversal = await db
    .prepare(`SELECT promotion_id FROM canonical_promotions WHERE reversal_of = ?`)
    .bind(original.promotion_id)
    .first<{ promotion_id: string }>();
  if (existingReversal) {
    return failReversal("already_reversed", "this promotion has already been reversed; repeats change nothing", {
      reversal_id: existingReversal.promotion_id,
    });
  }

  // 3. Fresh canonical state: exists, is ACTIVE (Stage 14M), and still equals
  // the original promotion's recorded outcome (§18). Drift on the changed
  // columns is the contract's `superseded_by_later_edit` — the corrective-
  // contribution path takes over from there. Drift on the OTHER snapshot
  // values (updated_at etc.) is caught by the CAS guard in step 5.
  const fresh = await loadCanonical(db, original.canonical_id);
  if (!fresh) return failReversal("canonical_target_not_found", "canonical target row no longer exists");
  const rejectedError = rejectedTargetCheck(fresh);
  if (rejectedError) {
    return failReversal(
      "canonical_target_rejected",
      "the canonical target is rejected lineage and is not part of the active dataset; a rejected record can never be written by a reversal",
      rejectedError.details,
    );
  }
  const outcomeDrift = reversalOutcomeDrift(
    { changed_columns: changedColumns, resulting: resultingValues },
    fresh,
  );
  if (outcomeDrift.length > 0) {
    return failReversal("superseded_by_later_edit", "canonical data changed after this promotion; a reversal only restores an untouched outcome, so use a corrective contribution", {
      drift: outcomeDrift,
    });
  }

  // 4. Bi-directional §8 sanity (defense in depth; unreachable for rows this
  // executor promoted, because a promotion never writes a CHECK-violating
  // state): restoring the base values of a surveyed row cannot demote a
  // surveyed Yes.
  if (changedColumns.includes("bidet_presence")) {
    const restored = baseSnapshot.bidet_presence;
    if (fresh.bidet_source_id !== null && fresh.bidet_source_id !== undefined && restored === "Unknown") {
      return failReversal("invalid_reversal", "the stored base snapshot would downgrade a surveyed bidet; only a re-survey may do that");
    }
  }

  // 5. Phase 1: guarded CAS UPDATE. SET the changed columns back to their
  // stored base values; WHERE matches ALL EIGHT current snapshot values with
  // NULL-safe `IS` — the fresh row's values, which step 3 proved equal the
  // original outcome for the changed columns. Zero matches means a concurrent
  // write landed between the read and the UPDATE; never a force.
  const orderedColumns = WRITABLE_CANONICAL_COLUMNS.filter((column) => changedColumns.includes(column));
  const setParts = orderedColumns.map((column) => SET_FRAGMENTS[column]);
  const values: unknown[] = orderedColumns.map((column) => baseSnapshot[column] ?? null);
  const sql =
    `UPDATE canonical_locations ` +
    `SET ${setParts.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ` +
    `WHERE canonical_id = ? ` +
    SNAPSHOT_COLUMNS.map((column) => `AND ${column} IS ?`).join(" ");
  values.push(original.canonical_id);
  for (const column of SNAPSHOT_COLUMNS) {
    values.push((fresh as unknown as Record<string, unknown>)[column] ?? null);
  }
  const updateResult = await db.prepare(sql).bind(...values).run();
  if ((updateResult.meta?.changes ?? 0) !== 1) {
    const now = await loadCanonical(db, original.canonical_id);
    return failReversal("superseded_by_later_edit", "the compare-and-swap guard matched no rows; canonical changed concurrently", {
      drift: now
        ? SNAPSHOT_COLUMNS.filter((column) =>
            !sameValue(
              (now as unknown as Record<string, unknown>)[column],
              (fresh as unknown as Record<string, unknown>)[column],
            ),
          ).map((column) => ({
            column,
            base_value: (fresh as unknown as Record<string, unknown>)[column] ?? null,
            current_value: (now as unknown as Record<string, unknown>)[column] ?? null,
          }))
        : [],
      concurrent: true,
    });
  }

  // 6. Phase 2: ledger append + audit event, ONE atomic batch (same §6
  // semantics and the same residual crash window as promotion). The reversal
  // row carries ITS OWN freshly captured base snapshot (the values the CAS
  // just matched — `pickSnapshot`-shaped), the same changed columns, the
  // restored values, `reversal_of` linked, and a self-describing note so the
  // append is unambiguous even without the FK join. Concurrent double-reversal
  // is already prevented one layer up: only ONE reversal can win the phase-1
  // compare-and-swap (a second sees the flipped value and refuses as
  // `superseded_by_later_edit`), and a repeat AFTER commit is caught by the
  // step-2 `already_reversed` pre-check. So this event insert mirrors the
  // promotion path's plain atomic append — it needs no self-referential guard
  // (one would be self-defeating, since this very batch just wrote the
  // `reversal_of` link a NOT-EXISTS probe would then find).
  const reversalId = newPromotionId();
  const reversalLedgerNote = note ?? `Reversal of promotion ${original.promotion_id} (Stage 14 contract \u00a718).`;
  const eventDetail = {
    action: "canonical_promotion_reversed",
    reversal_id: reversalId,
    reverses_promotion_id: original.promotion_id,
    canonical_id: original.canonical_id,
    changed_columns: [...changedColumns],
  };
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO canonical_promotions ` +
        `(promotion_id, contribution_id, canonical_id, kind, contributor_user_id, promoter_user_id, ` +
        `base_snapshot_json, changed_columns_json, resulting_values_json, status, reversal_of, promotion_note) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'promoted', ?, ?)`,
      ).bind(
        reversalId,
        original.contribution_id,
        original.canonical_id,
        original.kind,
        original.contributor_user_id,
        input.promoterUserId,
        JSON.stringify(snapshotFromFreshRow(fresh)),
        JSON.stringify([...changedColumns]),
        JSON.stringify(restoredValuesMap(changedColumns, baseSnapshot)),
        original.promotion_id,
        reversalLedgerNote,
      ),
      db.prepare(
        `INSERT INTO contribution_events ` +
        `(event_id, contribution_id, event_type, actor_type, actor_id, from_status, to_status, detail_json) ` +
        `VALUES (?, ?, 'status_change', 'moderator', ?, 'approved', 'approved', ?)`,
      ).bind(
        newEventId(),
        original.contribution_id,
        input.promoterUserId,
        JSON.stringify(eventDetail),
      ),
    ]);
  } catch (error) {
    // Same crash window as promotion: canonical restored, evidence not
    // committed. Success is NEVER claimed; the read-only reconciliation
    // reports the mismatch honestly for a human to adjudicate.
    return failReversal("phase2_failed", "canonical was restored but the reversal ledger/event batch failed; the reversal must be reconciled", {
      canonical_id: original.canonical_id,
      expected_reversal_id: reversalId,
      reverses_promotion_id: original.promotion_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const reversedAtRow = await db
    .prepare(`SELECT promoted_at FROM canonical_promotions WHERE promotion_id = ?`)
    .bind(reversalId)
    .first<{ promoted_at: string }>();

  return {
    ok: true,
    reversalId,
    reversesPromotionId: original.promotion_id,
    canonicalId: original.canonical_id,
    changedColumns: [...changedColumns],
    restoredValues: restoredValuesMap(changedColumns, baseSnapshot),
    reversedAt: reversedAtRow?.promoted_at ?? "",
  };
}

// The eight CAS values of an already-loaded fresh row, in the same shape the
// promotion path serializes (so reversal rows are ledger-homogeneous).
function snapshotFromFreshRow(fresh: FreshCanonicalRow): Record<string, unknown> {
  const source = fresh as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const column of SNAPSHOT_COLUMNS) out[column] = source[column] ?? null;
  return out;
}

function restoredValuesMap(
  changedColumns: readonly string[],
  baseSnapshot: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of changedColumns) out[column] = baseSnapshot[column] ?? null;
  return out;
}

// ---------------------------------------------------------------------------
// Phase 10 — crash-window reconciliation (READ-ONLY)
// ---------------------------------------------------------------------------

export type ReconciliationReport = {
  // Promotions with a ledger row and canonical values still equal to what
  // the ledger says they produced. Fully accounted for.
  known_promotions: { promotion_id: string; contribution_id: string; canonical_id: string }[];
  // Promoted long enough ago that a later (legitimate) change overwrote the
  // values: ledger row exists, canonical differs. Informational only — a
  // later edit is not an orphan.
  modified_after_promotion: { promotion_id: string; canonical_id: string }[];
  // THE crash-window signal: an approved, promotable contribution whose
  // stored payload values are all present in canonical NOW, but which has no
  // ledger row. Either the phase-2 batch died after phase 1 committed, or
  // the same values arrived by owner import. Cannot be told apart from data
  // alone — that is the documented limitation — so a human must inspect.
  suspected_orphans: { contribution_id: string; canonical_id: string; kind: string }[];
  // Approved contributions not yet reflected in canonical: normal, awaiting
  // promotion. Legitimate pending state.
  not_promoted: { contribution_id: string; canonical_id: string }[];
  // Honest statement of what this report can and cannot conclude.
  limitations: readonly string[];
};

const RECONCILIATION_LIMITATIONS = [
  "Detection is heuristic: a canonical row matching an approved payload may also result from an owner import of the same values; only a human can tell an orphan from a coincidence.",
  "This report never writes, reconstructs, or invents a ledger row; healing an orphan is an owner-approved, explicit action.",
  "promotion_id values are random (promo_<32 hex>), matching the repository id convention; the contract §5.2 timestamp-derived lookup is NOT implemented — detection here compares stored payload against live canonical state instead, which does not depend on clock precision or id collisions.",
] as const;

/**
 * Read-only orphan detector for the §6 crash window. Answers: "is there
 * canonical data that a promotion attempt changed for which no ledger row
 * exists?" — and separates that from normal pending promotions and later
 * legitimate edits. Never mutates anything.
 */
export async function reconcileCanonicalPromotions(
  db: PromotionDatabase,
): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    known_promotions: [],
    modified_after_promotion: [],
    suspected_orphans: [],
    not_promoted: [],
    limitations: RECONCILIATION_LIMITATIONS,
  };

  const { results: ledgerRows } = await db
    .prepare(
      `SELECT p.promotion_id, p.contribution_id, p.canonical_id, p.resulting_values_json, ` +
      `c.status AS contribution_status ` +
      `FROM canonical_promotions p JOIN contributions c ON c.contribution_id = p.contribution_id`,
    )
    .all<{
      promotion_id: string;
      contribution_id: string;
      canonical_id: string;
      resulting_values_json: string;
      contribution_status: string;
    }>();

  const promotedContributionIds = new Set<string>();
  for (const entry of ledgerRows ?? []) {
    promotedContributionIds.add(entry.contribution_id);
    const fresh = await loadCanonical(db, entry.canonical_id);
    const resulting = parseJsonOrNull(entry.resulting_values_json);
    let matches = false;
    if (fresh && resulting && typeof resulting === "object" && !Array.isArray(resulting)) {
      const record = resulting as Record<string, unknown>;
      matches = Object.keys(record).every((column) =>
        sameValue(record[column], (fresh as unknown as Record<string, unknown>)[column]),
      );
    }
    if (matches) {
      report.known_promotions.push({
        promotion_id: entry.promotion_id,
        contribution_id: entry.contribution_id,
        canonical_id: entry.canonical_id,
      });
    } else {
      // Ledger exists; canonical moved on (later promotion, corrective
      // contribution, or owner edit). Not an orphan — flag for information.
      report.modified_after_promotion.push({
        promotion_id: entry.promotion_id,
        canonical_id: entry.canonical_id,
      });
    }
  }

  const { results: approved } = await db
    .prepare(
      `SELECT contribution_id, kind, target_canonical_id, payload_json FROM contributions ` +
      `WHERE status = 'approved' AND kind IN ('access_update','fee_update','bidet_report','info_correction')`,
    )
    .all<{
      contribution_id: string;
      kind: string;
      target_canonical_id: string | null;
      payload_json: string;
    }>();

  for (const row of approved ?? []) {
    if (promotedContributionIds.has(row.contribution_id)) continue;
    if (row.target_canonical_id === null) continue;
    const fresh = await loadCanonical(db, row.target_canonical_id);
    if (!fresh) continue;
    const payload = parseJsonOrNull(row.payload_json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    const kindColumns = KIND_COLUMNS[row.kind] ?? [];
    const proposing = kindColumns.filter((column) => column in record);
    if (proposing.length === 0) continue;
    const applied = proposing.every((column) =>
      sameValue(record[column], (fresh as unknown as Record<string, unknown>)[column]),
    );
    if (applied) {
      report.suspected_orphans.push({
        contribution_id: row.contribution_id,
        canonical_id: row.target_canonical_id,
        kind: row.kind,
      });
    } else {
      report.not_promoted.push({
        contribution_id: row.contribution_id,
        canonical_id: row.target_canonical_id,
      });
    }
  }

  return report;
}
