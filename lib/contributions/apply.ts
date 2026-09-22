// Buttler 2.0 — Stage 13 canonical-apply boundary.
//
// This is the single place where an *approved* contribution is turned into a
// change to canonical data. The rule it enforces (PART "CANONICAL APPLY
// BOUNDARY") is absolute: approval never becomes arbitrary SQL or an arbitrary
// JSON patch. A plan names only columns from a fixed allow-list and only the
// value types the canonical schema already accepts, so it is impossible for a
// contributor or a moderator to reach a protected column (record_status, the
// verification columns, provenance, timestamps, ids) through this path.
//
// The store layer executes a plan with a parameterised statement built from one
// of two FIXED templates. Column names come from `column` below, which is a
// hard-coded constant — never from request input.
//
// IMPORTANT: applying to canonical is the most privileged Stage 13 action and
// ships inert. No HTTP endpoint calls it; it is exercised only by the test
// suite until the owner separately approves both an authentication provider and
// enabling promotion.

import type { ContributionKind } from "./contract.ts";

// Contributor-proposed field -> canonical column, and ONLY for the kinds the
// read model can actually represent. Signal kinds (problem/closure/
// reverification) intentionally have no mapping: they inform a human, they do
// not edit truth.
const APPLY_FIELD_COLUMNS: Record<
  ContributionKind,
  Partial<Record<string, string>>
> = {
  access_update: { access: "access" },
  fee_update: { fee: "fee" },
  bidet_report: { bidet_presence: "bidet_presence" },
  info_correction: {
    name: "name",
    address: "address",
    latitude: "latitude",
    longitude: "longitude",
  },
  problem_report: {},
  closure_report: {},
  reverification: {},
  new_location: {},
};

// The exhaustive set of canonical columns this module may ever write. Anything
// outside it is structurally unreachable. Note what is deliberately absent:
// bidet_verification, restroom_verification, record_status, every id, and every
// timestamp.
export const WRITABLE_CANONICAL_COLUMNS: readonly string[] = [
  "access",
  "fee",
  "bidet_presence",
  "name",
  "address",
  "latitude",
  "longitude",
];

export type CanonicalUpdate = {
  column: string;
  value: string | number;
};

export type ApplyPlan =
  | { op: "update"; canonicalId: string; sets: CanonicalUpdate[] }
  | { op: "noop"; reason: string };

// Build the deterministic, auditable plan for applying one approved
// contribution. Returns `noop` for signal-only kinds and for new_location
// (promoting a proposed place to a canonical row is the owner import path, kept
// separate and explicitly out of the automated apply boundary).
export function planCanonicalApply(
  kind: ContributionKind,
  targetCanonicalId: string,
  payload: Record<string, unknown>,
): ApplyPlan {
  const mapping = APPLY_FIELD_COLUMNS[kind] ?? {};
  const sets: CanonicalUpdate[] = [];

  for (const [field, value] of Object.entries(payload)) {
    const column = mapping[field];
    // Unknown / unmapped / signal-only fields never become a write.
    if (!column) continue;
    if (!WRITABLE_CANONICAL_COLUMNS.includes(column)) {
      throw new Error(`apply boundary refusing non-writable column: ${column}`);
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`apply boundary refusing non-scalar value for ${field}`);
    }
    sets.push({ column, value });
  }

  if (sets.length === 0) {
    return { op: "noop", reason: `${kind} carries no canonical field change` };
  }

  // Defensive: columns are the only dynamic token in the statement, so assert
  // each is a bare identifier before it is ever used.
  for (const update of sets) {
    if (!/^[a-z_]+$/.test(update.column)) {
      throw new Error(`invalid canonical column identifier: ${update.column}`);
    }
  }

  return { op: "update", canonicalId: targetCanonicalId, sets };
}

// Render a plan into the fixed parameterised UPDATE statement + bind values the
// store executes. The SQL text only ever interpolates identifiers already
// validated above; every value is a `?` bind. `updated_at` is stamped by the
// database default expression, not by request input.
export function renderApplyStatement(plan: Extract<ApplyPlan, { op: "update" }>): {
  sql: string;
  values: (string | number)[];
} {
  const assignments = plan.sets.map(({ column }) => `${column} = ?`);
  const sql =
    `UPDATE canonical_locations SET ${assignments.join(", ")}, ` +
    `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ` +
    `WHERE canonical_id = ?`;
  const values = [...plan.sets.map(({ value }) => value), plan.canonicalId];
  return { sql, values };
}
