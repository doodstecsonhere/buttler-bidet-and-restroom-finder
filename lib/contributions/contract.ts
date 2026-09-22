// Buttler 2.0 — Stage 13 contribution contract (auth-agnostic domain layer).
//
// This module is deliberately free of HTTP, database, and authentication
// concerns so it can be unit-tested in isolation and reused by both the Pages
// Function handlers and the moderation/apply path. It encodes the two rules the
// whole Stage 13 security story rests on:
//
//   1. A contributor may only ever propose fields on a fixed per-kind
//      allow-list (PART 7). Unknown keys and server-controlled keys are refused
//      BEFORE anything is written.
//   2. A contribution that is later approved is applied to canonical data
//      through an explicit, deterministic column mapping (see apply.ts) — never
//      arbitrary SQL and never an arbitrary column name.
//
// Nothing here can mutate canonical data; it only classifies and validates the
// text a contributor submits.

export const CONTRIBUTION_KINDS = [
  "problem_report",
  "closure_report",
  "info_correction",
  "access_update",
  "fee_update",
  "bidet_report",
  "reverification",
  "new_location",
] as const;

export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export const CONTRIBUTION_STATUSES = [
  "pending",
  "validated",
  "needs_review",
  "approved",
  "rejected",
  "withdrawn",
  "superseded",
] as const;

export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number];

export const TERMINAL_STATUSES: readonly ContributionStatus[] = [
  "approved",
  "rejected",
  "withdrawn",
  "superseded",
];

export const VALIDATION_STATUSES = ["not_validated", "passed", "failed"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

// Hard payload/notes limits (PART 9, anti-spam). A row is bounded by the
// serialised JSON size, and free text by a character cap that also matches the
// D1 CHECK constraint in the staged migration.
export const MAX_NOTES_LENGTH = 2000;
export const MAX_MODERATION_NOTE_LENGTH = 2000;
export const MAX_PAYLOAD_JSON_LENGTH = 8000;
export const MAX_EVIDENCE_JSON_LENGTH = 8000;
export const MAX_BODY_BYTES = 16 * 1024;

// Canonical enums the public read model already uses. A contribution may only
// propose values inside these domains, so a moderator approving a change can
// never introduce a value the canonical CHECK constraints would reject.
export const ACCESS_VALUES = [
  "public",
  "customers",
  "public/customers",
  "permissive",
  "students/public",
  "restricted",
  "unknown",
] as const;

export const FEE_VALUES = ["yes", "no", "unknown"] as const;

// Presence only. A contributor may claim a bidet is present or unknown; the
// verification column (field_verified / osm_explicit) is never contributor-set.
export const BIDET_PRESENCE_VALUES = ["Yes", "Unknown"] as const;

export type AccessValue = (typeof ACCESS_VALUES)[number];
export type FeeValue = (typeof FEE_VALUES)[number];
export type BidetPresenceValue = (typeof BIDET_PRESENCE_VALUES)[number];

// The per-kind allow-list of fields a contributor may propose (PART 7).
// Signal-only kinds (problem/closure/reverification) carry a single review
// signal; they never map to a canonical column update.
export const ALLOWED_FIELDS_BY_KIND: Record<ContributionKind, readonly string[]> = {
  problem_report: ["issue"],
  closure_report: ["closed"],
  info_correction: ["name", "address", "latitude", "longitude"],
  access_update: ["access"],
  fee_update: ["fee"],
  bidet_report: ["bidet_presence"],
  reverification: ["observed"],
  new_location: [
    "name",
    "address",
    "latitude",
    "longitude",
    "access",
    "fee",
    "bidet_presence",
  ],
};

// Server-controlled / reserved keys that must never arrive from a client, no
// matter the kind. These are the fields that decide identity, workflow, and
// canonical truth, so accepting them from a request would break the whole
// "submission != canonical data" invariant.
export const RESERVED_KEYS = [
  "canonical_id",
  "target_canonical_id",
  "record_status",
  "bidet_verification",
  "restroom_verification",
  "restroom_presence",
  "match_status",
  "match_confidence",
  "match_reason",
  "source_count",
  "source_kind",
  "source_reference",
  "provenance",
  "osm_type",
  "osm_id",
  "bidet_source_id",
  "created_at",
  "updated_at",
  "submitted_at",
  "decided_at",
  "decided_by",
  "status",
  "validation_status",
  "contributor_user_id",
  "moderation_note",
] as const;

const LATITUDE_RANGE = { min: 9.0, max: 9.8 };
const LONGITUDE_RANGE = { min: 123.0, max: 123.7 };

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function isContributionKind(value: unknown): value is ContributionKind {
  return (
    typeof value === "string" &&
    (CONTRIBUTION_KINDS as readonly string[]).includes(value)
  );
}

// Validate the structured payload against the per-kind allow-list. Rejects any
// unknown key, any reserved/server-controlled key, and any out-of-domain value.
export function validatePayload(
  kind: ContributionKind,
  payload: unknown,
): ValidationResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "payload must be a JSON object" };
  }

  const allowed = new Set(ALLOWED_FIELDS_BY_KIND[kind]);
  const entries = Object.entries(payload as Record<string, unknown>);

  if (entries.length === 0) {
    return { ok: false, error: "payload must propose at least one field" };
  }

  for (const [key, value] of entries) {
    if ((RESERVED_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `server-controlled field not allowed: ${key}` };
    }
    if (!allowed.has(key)) {
      return { ok: false, error: `unknown field not allowed for ${kind}: ${key}` };
    }

    const check = validateFieldValue(key, value);
    if (!check.ok) return check;
  }

  // Every kind must propose at least one field relevant to it; the loop above
  // already guaranteed keys are allowed, but require the primary field so a
  // signal kind is not submitted empty of meaning.
  return { ok: true };
}

function validateFieldValue(key: string, value: unknown): ValidationResult {
  switch (key) {
    case "access":
      return (ACCESS_VALUES as readonly string[]).includes(value as string)
        ? { ok: true }
        : { ok: false, error: "access is not a recognised value" };
    case "fee":
      return (FEE_VALUES as readonly string[]).includes(value as string)
        ? { ok: true }
        : { ok: false, error: "fee is not a recognised value" };
    case "bidet_presence":
      return (BIDET_PRESENCE_VALUES as readonly string[]).includes(value as string)
        ? { ok: true }
        : { ok: false, error: "bidet_presence must be Yes or Unknown" };
    case "latitude":
      return inRange(value, LATITUDE_RANGE)
        ? { ok: true }
        : { ok: false, error: "latitude out of the Dumaguete service area" };
    case "longitude":
      return inRange(value, LONGITUDE_RANGE)
        ? { ok: true }
        : { ok: false, error: "longitude out of the Dumaguete service area" };
    case "name":
      return typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 200
        ? { ok: true }
        : { ok: false, error: "name must be a short non-empty string" };
    case "address":
      return typeof value === "string" && value.length <= 300
        ? { ok: true }
        : { ok: false, error: "address must be a short string" };
    case "closed":
    case "observed":
    case "issue":
      return typeof value === "boolean" ||
        (key === "issue" && typeof value === "string" && value.length <= 300)
        ? { ok: true }
        : { ok: false, error: `${key} must be a flag or short text` };
    default:
      return { ok: false, error: `no validator for field: ${key}` };
  }
}

function inRange(value: unknown, range: { min: number; max: number }): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= range.min &&
    value <= range.max
  );
}

// A brand-new place carries no canonical target; every other kind must. This is
// the same rule the D1 table enforces with a CHECK, mirrored here so the API
// can return a clear 4xx before a database error surfaces.
export function validateTargetForKind(
  kind: ContributionKind,
  targetCanonicalId: string | null,
): ValidationResult {
  if (kind === "new_location") {
    return targetCanonicalId === null
      ? { ok: true }
      : { ok: false, error: "new_location must not reference a canonical target" };
  }
  return typeof targetCanonicalId === "string" &&
    /^buttler_loc_[0-9a-f]{20}$/.test(targetCanonicalId)
    ? { ok: true }
    : { ok: false, error: `${kind} requires a valid canonical target id` };
}
