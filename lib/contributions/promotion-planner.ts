// Buttler 2.0 — Stage 14C canonical promotion planner (pure boundary).
//
// This module answers exactly one question: "if this already-approved
// contribution were promoted, what would change?" It decides; it does not do.
// There is deliberately no database handle, no network call, no runtime
// configuration read, no clock, and no randomness here, so the same stored
// contribution always produces the same answer — which is what makes the
// decision reviewable before a single row is touched.
//
// It implements the frozen Stage 14A contract
// (docs/stage14a-canonical-promotion-contract.md):
//   §10  which kinds may be promoted at all (signal kinds stay signals)
//   §11  the empty-address rule the Stage 13 submit path still allows
//   §12  coordinate pair / service-area / evidence / proximity rules
//   §8   the bidet transition matrix (presence only, never verification)
//   §7   the base snapshot a later executor needs for compare-and-swap
//   §5.2 the three structures the promotion ledger will record
//   §3.2 a redundant payload is refused, never written as a no-op mutation
//
// Security posture inherited from Stages 12–13 and tightened here: a stored
// payload is re-validated at promotion time. Submit-time validation is NOT
// trusted — records can predate a rule change, and "approved" is a human
// judgement about a claim, not a guarantee that the JSON is safe to write. Only
// the seven contract-writable canonical columns are reachable; every other
// column name is refused with an explicit reason. No SQL text is ever produced
// here — translating a trusted plan into a parameterised transaction is Stage
// 14D's job, and authorization (§4) plus the endpoint (§15) are later stages.

import {
  MAX_EVIDENCE_JSON_LENGTH,
  MAX_PAYLOAD_JSON_LENGTH,
  RESERVED_KEYS,
  isContributionKind,
  validatePayload,
  type ContributionKind,
  type ContributionStatus,
} from "./contract.ts";
import { WRITABLE_CANONICAL_COLUMNS } from "./apply.ts";

// ---------------------------------------------------------------------------
// Kind policy (§10)
// ---------------------------------------------------------------------------

// The four kinds with a real column mapping. Everything else is a signal for a
// human, or (for `new_location`) the owner's manual import path.
export const PROMOTABLE_KINDS = [
  "access_update",
  "fee_update",
  "bidet_report",
  "info_correction",
] as const satisfies readonly ContributionKind[];

export const NON_PROMOTABLE_KINDS = [
  "problem_report",
  "closure_report",
  "reverification",
  "new_location",
] as const satisfies readonly ContributionKind[];

export type PromotableKind = (typeof PROMOTABLE_KINDS)[number];

function isPromotableKind(value: ContributionKind): value is PromotableKind {
  return (PROMOTABLE_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Column policy (§14 / apply.ts)
// ---------------------------------------------------------------------------

// Contributor-facing field name -> canonical column. This is the whole surface:
// anything not listed here cannot be written, and every value below is asserted
// against `WRITABLE_CANONICAL_COLUMNS` at plan time so this map cannot silently
// drift away from the Stage 13 apply boundary.
const PROMOTION_FIELD_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  access: "access",
  fee: "fee",
  bidet_presence: "bidet_presence",
  name: "name",
  address: "address",
  latitude: "latitude",
  longitude: "longitude",
});

// Canonical columns the read model has but promotion may never touch. Kept as
// explicit data (not "anything not allowed") so a protected key gets its own
// machine-readable reason instead of a generic "unknown field".
const NON_WRITABLE_CANONICAL_COLUMNS: readonly string[] = [
  "canonical_id",
  "record_status",
  "restroom_verification",
  "bidet_verification",
  "restroom_presence",
  "source_count",
  "osm_type",
  "osm_id",
  "bidet_source_id",
  "candidate_priority",
  "parent_venue",
  "match_status",
  "match_confidence",
  "match_reason",
  "last_checked",
  "notes",
  "created_at",
  "updated_at",
];

const PROTECTED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  ...NON_WRITABLE_CANONICAL_COLUMNS,
  ...RESERVED_KEYS,
]);

// The eight snapshot keys the §7 compare-and-swap guard needs, named exactly as
// the canonical columns so the executor can bind them without a rename table.
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

// ---------------------------------------------------------------------------
// Coordinate policy (§12)
// ---------------------------------------------------------------------------

// Same service-area box the submit-time contract uses, re-checked at promote
// time — it doubles as a wrong-continent typo guard.
const LATITUDE_BOUNDS = { min: 9.0, max: 9.8 };
const LONGITUDE_BOUNDS = { min: 123.0, max: 123.7 };

// §12 proximity guard. This is a configurable heuristic chosen to mean "roughly
// the same building/entrance at street scale"; it is NOT a scientific or
// regulatory authority, and v1 uses it only to refuse with information — it
// never auto-merges, auto-deletes, or lets a caller override the conflict by
// force-promoting.
export const PROXIMITY_THRESHOLD_METERS = 30;

// Evidence types that can justify moving a pin. A sighted claim about a fee is
// self-evidencing; a re-location is not (§12).
const COORDINATE_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "field_observation",
  "external_source",
]);

const CANONICAL_ID_RE = /^buttler_loc_[0-9a-f]{20}$/;

// PII-shaped names are refused at promote (§14). Deliberately narrow patterns:
// contact details pasted into a venue name, not ordinary punctuation.
const NAME_PII_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
  /\bhttps?:\/\/\S/i, // URL with scheme
  /\bwww\.[^\s]+\.[a-z]{2,}/i, // bare host
  /(?:\+?\d[\d\s().-]{7,}\d)/, // phone-shaped digit run
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CanonicalBaseSnapshot = {
  updated_at: string;
  access: string;
  fee: string;
  bidet_presence: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
};

export type CanonicalTargetRow = CanonicalBaseSnapshot & {
  canonical_id: string;
  // Presence-only context: a row carrying a bidet survey id is protected by the
  // canonical CHECK, so it can never be downgraded (§8). Never a writable column.
  bidet_source_id?: string | null;
};

export type ContributionSnapshotInput = {
  contribution_id: string;
  kind: unknown;
  status: unknown;
  target_canonical_id: unknown;
  contributor_user_id: unknown;
  payload_json: unknown;
  evidence_json?: unknown;
};

export type NearbyCanonicalRow = {
  canonical_id: string;
  latitude: number;
  longitude: number;
};

export type PromotionPlanInput = {
  contribution: ContributionSnapshotInput;
  target: CanonicalTargetRow | null;
  // The proximity guard needs neighbours, and the planner cannot query for
  // them — whoever wires this up (Stage 14D) supplies a candidate list. Absent
  // means "no neighbours supplied", which is treated as no conflict found.
  nearbyLocations?: readonly NearbyCanonicalRow[] | null;
  proximityThresholdMeters?: number;
};

export type EvidenceEntry = {
  type: string;
  detail?: string;
  observed_at?: string;
  source_url?: string;
};

export type PromotionPlan = {
  canonical_id: string;
  contribution_id: string;
  kind: PromotableKind;
  // Carried for the ledger row (contributor_user_id is NOT NULL there) and for
  // the caller's self-promotion check. The planner makes no authorization
  // decision about it.
  contributor_user_id: string | null;
  base_snapshot: CanonicalBaseSnapshot;
  changed_columns: readonly string[];
  resulting_values: Readonly<Record<string, string | number>>;
  evidence: readonly EvidenceEntry[];
  policy: {
    coordinate_change: boolean;
    coordinate_evidence_required: boolean;
    proximity_threshold_meters: number;
    presence_only_bidet: true;
    verification_columns_writable: false;
  };
};

export type PlannerErrorCode =
  | "unsupported_kind"
  | "unsupported_new_location"
  | "contribution_not_approved"
  | "canonical_target_required"
  | "invalid_target"
  | "invalid_payload"
  | "forbidden_field"
  | "blank_address"
  | "name_pii_shape"
  | "invalid_coordinates"
  | "incomplete_coordinate_pair"
  | "coordinate_evidence_required"
  | "proximity_conflict"
  | "bidet_downgrade_forbidden"
  | "redundant_noop";

export type PlannerError = {
  code: PlannerErrorCode;
  message: string;
  // Machine-readable extras (which column, which neighbour, drift candidates).
  // Stable keys so a later handler can format them without string matching.
  details?: Record<string, unknown>;
};

export type PlannerResult =
  | { ok: true; plan: PromotionPlan }
  | { ok: false; error: PlannerError };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reject(
  code: PlannerErrorCode,
  message: string,
  details?: Record<string, unknown>,
): PlannerResult {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJson(text: unknown): { ok: boolean; value: unknown } {
  if (typeof text !== "string") return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

// NULL-safe equality, mirroring SQLite `IS` so a NULL address compares as a
// value rather than being "unknown not equal to unknown". Exported so the
// Stage 14D executor compares snapshots with the exact same semantics instead
// of a second implementation that could drift from this one.
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return a === b;
}

function inBounds(value: number, bounds: { min: number; max: number }): boolean {
  return value >= bounds.min && value <= bounds.max;
}

// Great-circle distance in metres. Pure arithmetic — no dependency, no clock.
function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371008.8;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/**
 * Decide whether one stored contribution can be promoted, and if so, produce
 * the trusted data a later executor needs. Pure and deterministic: it reads
 * only its argument, mutates nothing, and writes nothing.
 */
export function planCanonicalPromotion(
  input: PromotionPlanInput,
): PlannerResult {
  const contribution = input && typeof input === "object" ? input.contribution : null;
  if (!contribution || typeof contribution !== "object") {
    return reject("invalid_payload", "planner needs a contribution record");
  }

  const kind = contribution.kind;
  if (!isContributionKind(kind)) {
    return reject("unsupported_kind", "contribution kind is not recognised");
  }
  // §13: inserting a new place is the owner's manual import path, never a
  // promotion — it would have to write protected columns.
  if (kind === "new_location") {
    return reject(
      "unsupported_new_location",
      "new_location promotion is a manual owner import, not a canonical field change",
    );
  }
  // §10: problem / closure / reverification carry no column meaning; promoting
  // them would silently turn a signal into an edit.
  if (!isPromotableKind(kind)) {
    return reject(
      "unsupported_kind",
      `${kind} is a signal for a human reviewer, not a promotable change`,
      { kind },
    );
  }

  // §3.2: only an approved claim enters this gate. Approval is a moderation
  // judgement; it is still not a write.
  if (contribution.status !== "approved") {
    return reject(
      "contribution_not_approved",
      "only an approved contribution can be planned for promotion",
      { status: String(contribution.status ?? "") },
    );
  }

  if (
    typeof contribution.contribution_id !== "string" ||
    contribution.contribution_id.length === 0
  ) {
    return reject("invalid_payload", "contribution id is missing");
  }

  const targetId = contribution.target_canonical_id;
  if (targetId === null || targetId === undefined) {
    return reject(
      "canonical_target_required",
      `${kind} must reference the canonical place it proposes to change`,
    );
  }
  if (typeof targetId !== "string" || !CANONICAL_ID_RE.test(targetId)) {
    return reject("invalid_target", "canonical target id is malformed", {
      target_canonical_id: String(targetId),
    });
  }
  const target = input.target;
  if (!target || typeof target !== "object") {
    return reject(
      "canonical_target_required",
      "the planner needs the current canonical row; it does not read a database",
      { canonical_id: targetId },
    );
  }
  if (target.canonical_id !== targetId) {
    return reject("invalid_target", "canonical target does not match the contribution", {
      expected: targetId,
      actual: String(target.canonical_id),
    });
  }
  const baseValues = target as unknown as Record<string, unknown>;
  const baseSnapshot: Record<string, unknown> = {};
  for (const column of SNAPSHOT_COLUMNS) {
    const value = baseValues[column];
    if (value === undefined) {
      return reject("invalid_target", `canonical row is missing ${column}`);
    }
    baseSnapshot[column] = value;
  }

  // ------------------------------------------------------------------
  // Re-validate the stored payload at promotion time (§4 mandate: submit-time
  // validation is not trusted). Order matters: the specific policy reasons are
  // checked first so a reviewer sees the real problem, and the general
  // contract validator runs last as the catch-all.
  // ------------------------------------------------------------------
  if (typeof contribution.payload_json !== "string") {
    return reject("invalid_payload", "contribution payload is missing");
  }
  if (contribution.payload_json.length > MAX_PAYLOAD_JSON_LENGTH) {
    return reject("invalid_payload", "contribution payload is oversized", {
      max: MAX_PAYLOAD_JSON_LENGTH,
    });
  }
  const parsedPayload = parseJson(contribution.payload_json);
  if (!parsedPayload.ok) {
    return reject("invalid_payload", "stored payload is not valid JSON");
  }
  const payload = asObject(parsedPayload.value);
  if (!payload) {
    return reject("invalid_payload", "stored payload is not a JSON object");
  }

  for (const key of Object.keys(payload)) {
    if (PROTECTED_PAYLOAD_KEYS.has(key)) {
      return reject(
        "forbidden_field",
        `promotion may never write the protected column ${key}`,
        { field: key },
      );
    }
    // Any other unknown key falls through to the contract validator below.
  }

  const proposesLatitude = "latitude" in payload;
  const proposesLongitude = "longitude" in payload;
  const coordinateChange = proposesLatitude && proposesLongitude;

  // §12 pair rule: a half-relocation can move a pin anywhere while each single
  // value still looks in-range. Contributors may still *report* one bad value;
  // the planner simply refuses to apply it alone.
  if (proposesLatitude !== proposesLongitude) {
    return reject(
      "incomplete_coordinate_pair",
      "latitude and longitude must be promoted together or not at all",
      { has_latitude: proposesLatitude, has_longitude: proposesLongitude },
    );
  }

  if (payload.address !== undefined) {
    // §11: Stage 13 submit accepts "" for address, so the promotion gate is the
    // line of defense. Clearing an address is not a supported promotion.
    if (typeof payload.address !== "string" || payload.address.trim().length === 0) {
      return reject(
        "blank_address",
        "an address promotion must be a non-empty, non-whitespace value",
      );
    }
  }

  if (typeof payload.name === "string") {
    for (const pattern of NAME_PII_PATTERNS) {
      if (pattern.test(payload.name)) {
        return reject(
          "name_pii_shape",
          "a name carrying contact details or a link is not a venue name",
        );
      }
    }
  }

  let coords: { latitude: number; longitude: number } | null = null;
  if (coordinateChange) {
    const candidateLatitude = payload.latitude;
    const candidateLongitude = payload.longitude;
    const badNumber = (field: string) =>
      reject(
        "invalid_coordinates",
        `${field} must be a finite number inside the Dumaguete service area`,
        { field },
      );
    if (
      typeof candidateLatitude !== "number" ||
      !Number.isFinite(candidateLatitude) ||
      !inBounds(candidateLatitude, LATITUDE_BOUNDS)
    ) {
      return badNumber("latitude");
    }
    if (
      typeof candidateLongitude !== "number" ||
      !Number.isFinite(candidateLongitude) ||
      !inBounds(candidateLongitude, LONGITUDE_BOUNDS)
    ) {
      return badNumber("longitude");
    }
    coords = { latitude: candidateLatitude, longitude: candidateLongitude };
  }

  // General contract rules (per-kind allow-list, enums, size caps) re-applied.
  const contractCheck = validatePayload(kind, payload);
  if (!contractCheck.ok) {
    return reject("invalid_payload", `stored payload fails the contract: ${contractCheck.error}`);
  }

  const evidence = parseEvidence(contribution.evidence_json);
  if (!evidence.ok) {
    return reject("invalid_payload", evidence.message);
  }

  // Non-null exactly when a valid coordinate pair was proposed.
  if (coords !== null) {
    const supporting = evidence.entries.filter((entry) =>
      COORDINATE_EVIDENCE_TYPES.has(entry.type),
    );
    if (supporting.length === 0) {
      return reject(
        "coordinate_evidence_required",
        "a coordinate change needs at least one field_observation or external_source evidence entry",
        { available_types: evidence.entries.map((entry) => entry.type) },
      );
    }
    const threshold = resolveThreshold(input.proximityThresholdMeters);
    const conflict = findProximityConflict(
      coords.latitude,
      coords.longitude,
      targetId,
      input.nearbyLocations,
      threshold,
    );
    if (conflict !== null) {
      return reject(
        "proximity_conflict",
        "the proposed position lands on top of another canonical place; a human must reconcile",
        {
          nearby_canonical_ids: conflict,
          threshold_meters: threshold,
        },
      );
    }
  }

  // §8 bidet matrix. Presence only — and a downgrade is never a promotion,
  // because a surveyed row's CHECK forbids it and a community-set `Yes` must be
  // corrected by a reversal, not by silently erasing the claim.
  if (payload.bidet_presence !== undefined) {
    const current = baseSnapshot.bidet_presence;
    if (current === "Yes" && payload.bidet_presence === "Unknown") {
      const surveyed = target.bidet_source_id !== null && target.bidet_source_id !== undefined;
      return reject(
        "bidet_downgrade_forbidden",
        surveyed
          ? "this bidet was recorded by the field survey; the canonical schema forbids downgrading it, and only a re-survey may change it"
          : "a positive bidet claim is corrected by reversing its promotion, never by a downgrading report",
        { surveyed, current_bidet_presence: "Yes" },
      );
    }
  }

  // ------------------------------------------------------------------
  // Build the plan: only allow-listed columns, only values that actually
  // differ. §3.2: a payload that changes nothing is refused, because writing a
  // no-op creates drift noise and an audit trail of nothing happening.
  // ------------------------------------------------------------------
  const changedColumns: string[] = [];
  const resultingValues: Record<string, string | number> = {};
  for (const key of Object.keys(payload)) {
    const column = PROMOTION_FIELD_COLUMNS[key];
    if (column === undefined) continue;
    const value = payload[key];
    if (typeof value !== "string" && typeof value !== "number") {
      return reject("invalid_payload", `${key} must be a scalar value`);
    }
    // Belt-and-braces against the Stage 13 apply boundary. Unreachable today
    // because the maps agree; if they ever drift, refusing beats writing.
    if (!WRITABLE_CANONICAL_COLUMNS.includes(column)) {
      return reject("forbidden_field", `column ${column} is not promotion-writable`, {
        field: key,
        column,
      });
    }
    if (sameValue(value, baseSnapshot[column])) continue;
    changedColumns.push(column);
    resultingValues[column] = value;
  }

  if (changedColumns.length === 0) {
    const currentBidet = baseSnapshot.bidet_presence;
    const alreadyMarked =
      kind === "bidet_report" && currentBidet === "Yes"
        ? " this place is already marked as having a bidet"
        : "";
    return reject(
      "redundant_noop",
      `every proposed value already matches canonical data, so promoting would write nothing.${alreadyMarked}`.trim(),
      {
        examined_columns: Object.keys(payload)
          .map((key) => PROMOTION_FIELD_COLUMNS[key])
          .filter((column): column is string => typeof column === "string"),
      },
    );
  }

  return {
    ok: true,
    plan: {
      canonical_id: targetId,
      contribution_id: contribution.contribution_id,
      kind,
      contributor_user_id:
        typeof contribution.contributor_user_id === "string"
          ? contribution.contributor_user_id
          : null,
      base_snapshot: baseSnapshot as unknown as CanonicalBaseSnapshot,
      changed_columns: changedColumns,
      resulting_values: resultingValues,
      evidence: evidence.entries,
      policy: {
        coordinate_change: coordinateChange,
        coordinate_evidence_required: coordinateChange,
        proximity_threshold_meters: resolveThreshold(input.proximityThresholdMeters),
        presence_only_bidet: true,
        verification_columns_writable: false,
      },
    },
  };
}

function parseEvidence(value: unknown):
  | { ok: true; entries: EvidenceEntry[] }
  | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return { ok: true, entries: [] };
  }
  if (typeof value === "string" && value.length > MAX_EVIDENCE_JSON_LENGTH) {
    return { ok: false, message: "stored evidence is oversized" };
  }
  // Accept either the stored JSON text or an already-parsed array, so the
  // planner stays usable from a row-shaped caller without coupling to one.
  const parsed = Array.isArray(value) ? { ok: true, value } : parseJson(value);
  if (!parsed.ok) return { ok: false, message: "stored evidence is not valid JSON" };
  if (!Array.isArray(parsed.value)) {
    return { ok: false, message: "stored evidence is not a JSON array" };
  }
  const entries: EvidenceEntry[] = [];
  for (const raw of parsed.value) {
    const entry = asObject(raw);
    if (!entry || typeof entry.type !== "string") {
      return { ok: false, message: "each evidence entry needs a string type" };
    }
    const shaped: EvidenceEntry = { type: entry.type };
    for (const optional of ["detail", "observed_at", "source_url"] as const) {
      const field = entry[optional];
      if (typeof field === "string") {
        if (optional === "detail") shaped.detail = field;
        if (optional === "observed_at") shaped.observed_at = field;
        if (optional === "source_url") shaped.source_url = field;
      }
    }
    entries.push(shaped);
  }
  return { ok: true, entries };
}

function resolveThreshold(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return PROXIMITY_THRESHOLD_METERS;
}

// Exported for the Stage 14D executor, which re-runs the §12 proximity guard
// against freshly-queried neighbours at execution time — the same arithmetic,
// from the same source, never a copy.
export function findProximityConflict(
  latitude: number,
  longitude: number,
  targetId: string,
  nearby: readonly NearbyCanonicalRow[] | null | undefined,
  thresholdMeters: number,
): string[] | null {
  if (!Array.isArray(nearby) || nearby.length === 0) return null;
  const hits: string[] = [];
  for (const row of nearby) {
    if (!row || typeof row.canonical_id !== "string") continue;
    // The row being promoted is not its own neighbour.
    if (row.canonical_id === targetId) continue;
    if (
      typeof row.latitude !== "number" ||
      typeof row.longitude !== "number" ||
      !Number.isFinite(row.latitude) ||
      !Number.isFinite(row.longitude)
    ) {
      continue;
    }
    if (
      haversineMeters(latitude, longitude, row.latitude, row.longitude) <= thresholdMeters
    ) {
      hits.push(row.canonical_id);
    }
  }
  return hits.length > 0 ? hits : null;
}
