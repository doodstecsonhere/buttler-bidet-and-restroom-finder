// Buttler 2.0 — Stage 14C pure canonical-promotion planner test.
//
// The planner is the boundary that decides WHAT a promotion would change, before
// anything is allowed to write. This suite proves it is pure: no D1, no network,
// no HTTP, no environment, no filesystem, no mutation of its own inputs, and no
// SQL text in its output. It runs entirely in-process over plain fixtures — no
// database, no Cloudflare account, no production row, and no secret. Nothing
// here can change canonical data, because nothing here holds a connection.
//
// Rules under test are the frozen Stage 14A contract (docs/stage14a-canonical-
// promotion-contract.md): §8 bidet transitions, §11 empty-address rule, §12
// coordinate pair/bounds/evidence/proximity rules, §10 kind policy, §7 base
// snapshot, §3.2 redundant no-op.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage14c-promotion-planner.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  planCanonicalPromotion,
  PROMOTABLE_KINDS,
  NON_PROMOTABLE_KINDS,
  PROXIMITY_THRESHOLD_METERS,
} from "../lib/contributions/promotion-planner.ts";
import { WRITABLE_CANONICAL_COLUMNS } from "../lib/contributions/apply.ts";
import { CONTRIBUTION_KINDS } from "../lib/contributions/contract.ts";

// ---------------------------------------------------------------------------
// Fixtures (pure literals — never production data)
// ---------------------------------------------------------------------------

const TARGET_ID = "buttler_loc_0123456789abcdef0123";
const CONTRIBUTION_ID = "contrib_" + "a".repeat(32);
const SNAPSHOT_STAMP = "2026-10-01T00:00:00.000Z";

// A canonical row shaped like the fields a later executor would read at
// promotion time: the seven writable columns + updated_at, plus the two
// protected context columns the policy needs to know but may never write.
function targetRow(overrides = {}) {
  return {
    canonical_id: TARGET_ID,
    updated_at: SNAPSHOT_STAMP,
    access: "unknown",
    fee: "unknown",
    bidet_presence: "Unknown",
    name: "Sample Public Restroom",
    address: "Sample Street",
    latitude: 9.3068,
    longitude: 123.305,
    bidet_source_id: null,
    ...overrides,
  };
}

function contributionRow(overrides = {}) {
  return {
    contribution_id: CONTRIBUTION_ID,
    kind: "access_update",
    status: "approved",
    target_canonical_id: TARGET_ID,
    contributor_user_id: "auth0|contributor-example",
    payload_json: JSON.stringify({ access: "public" }),
    evidence_json: null,
    ...overrides,
  };
}

function planInput(contributionOverrides = {}, extra = {}) {
  return {
    contribution: contributionRow(contributionOverrides),
    target: targetRow(extra.targetOverrides ?? {}),
    ...(extra.nearbyLocations === undefined
      ? {}
      : { nearbyLocations: extra.nearbyLocations }),
    ...(extra.proximityThresholdMeters === undefined
      ? {}
      : { proximityThresholdMeters: extra.proximityThresholdMeters }),
  };
}

const COORD_EVIDENCE = JSON.stringify([
  { type: "field_observation", detail: "I stood at the new entrance today" },
]);

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function codeOf(result) {
  assert.equal(result.ok, false, "expected a planner rejection");
  assert.ok(result.error && typeof result.error.code === "string", "error.code");
  assert.ok(
    typeof result.error.message === "string" && result.error.message.length > 0,
    "error.message must be human-readable",
  );
  return result.error.code;
}

// ===========================================================================
// 1. The four promotable kinds each produce a valid plan
// ===========================================================================
{
  const cases = [
    { kind: "access_update", payload: { access: "public" }, column: "access" },
    { kind: "fee_update", payload: { fee: "yes" }, column: "fee" },
    { kind: "bidet_report", payload: { bidet_presence: "Yes" }, column: "bidet_presence" },
    { kind: "info_correction", payload: { name: "Renamed Place" }, column: "name" },
  ];
  assert.deepEqual(PROMOTABLE_KINDS.slice().sort(), cases.map((c) => c.kind).sort());
  for (const entry of cases) {
    const result = planCanonicalPromotion(
      planInput({ kind: entry.kind, payload_json: JSON.stringify(entry.payload) }),
    );
    assert.equal(result.ok, true, `${entry.kind} must plan`);
    assert.equal(result.plan.kind, entry.kind);
    assert.equal(result.plan.canonical_id, TARGET_ID);
    assert.equal(result.plan.contribution_id, CONTRIBUTION_ID);
    assert.deepEqual(result.plan.changed_columns, [entry.column]);
    assert.deepEqual(result.plan.resulting_values, { [entry.column]: Object.values(entry.payload)[0] });
  }
}

// ===========================================================================
// 2. Every non-promotable kind is refused (and the eight kinds stay covered)
// ===========================================================================
{
  const refused = [];
  for (const kind of CONTRIBUTION_KINDS) {
    const result = planCanonicalPromotion(
      planInput({
        kind,
        payload_json: JSON.stringify({ access: "public" }),
        target_canonical_id: kind === "new_location" ? null : TARGET_ID,
      }),
    );
    if (!result.ok) refused.push([kind, codeOf(result)]);
  }
  assert.deepEqual(
    NON_PROMOTABLE_KINDS.slice().sort(),
    ["closure_report", "new_location", "problem_report", "reverification"],
  );
  const map = new Map(refused);
  assert.equal(map.get("problem_report"), "unsupported_kind");
  assert.equal(map.get("closure_report"), "unsupported_kind");
  assert.equal(map.get("reverification"), "unsupported_kind");
  assert.equal(map.get("new_location"), "unsupported_new_location");
}

// ===========================================================================
// 3. Blank / whitespace-only address is refused at promotion time
// ===========================================================================
{
  for (const value of ["", "   ", "\t \n"]) {
    const result = planCanonicalPromotion(
      planInput({
        kind: "info_correction",
        payload_json: JSON.stringify({ address: value }),
      }),
    );
    assert.equal(codeOf(result), "blank_address", `address ${JSON.stringify(value)}`);
  }
  // Setting a NULL snapshot address to a real value is permitted (contract §11).
  const fill = planCanonicalPromotion({
    contribution: contributionRow({
      kind: "info_correction",
      payload_json: JSON.stringify({ address: "12 Real Street" }),
    }),
    target: targetRow({ address: null }),
  });
  assert.equal(fill.ok, true, "NULL -> non-empty address is a supported promotion");
  assert.deepEqual(fill.plan.changed_columns, ["address"]);
}

// ===========================================================================
// 4 + 12 + 13 + 14. Protected / forbidden columns can never enter a plan
// ===========================================================================
{
  const protectedKeys = [
    "record_status",
    "bidet_verification",
    "restroom_verification",
    "restroom_presence",
    "source_count",
    "canonical_id",
    "updated_at",
    "bidet_source_id",
    "match_status",
    "last_checked",
    "notes",
    "provenance",
    "candidate_priority",
    "parent_venue",
  ];
  for (const key of protectedKeys) {
    const result = planCanonicalPromotion(
      planInput({
        kind: "access_update",
        payload_json: JSON.stringify({ access: "public", [key]: "verified" }),
      }),
    );
    assert.equal(codeOf(result), "forbidden_field", `${key} must be unreachable`);
  }
  // A legitimate plan names only allow-listed columns.
  const plan = planCanonicalPromotion(
    planInput({
      kind: "info_correction",
      payload_json: JSON.stringify({
        name: "Renamed Place",
        address: "9 New Street",
        latitude: 9.31,
        longitude: 123.31,
      }),
      evidence_json: COORD_EVIDENCE,
    }),
  );
  assert.equal(plan.ok, true);
  for (const column of plan.plan.changed_columns) {
    assert.ok(
      WRITABLE_CANONICAL_COLUMNS.includes(column),
      `planner must not name a non-writable column: ${column}`,
    );
  }
  assert.deepEqual(
    Object.keys(plan.plan.resulting_values).sort(),
    plan.plan.changed_columns.slice().sort(),
    "resulting values are keyed exactly by the changed columns",
  );
}

// ===========================================================================
// 5. Malformed / unsupported stored payloads are refused
// ===========================================================================
{
  const bad = [
    ["unparseable json", "{not json"],
    ["json array", JSON.stringify(["access"])],
    ["json scalar", JSON.stringify("public")],
    ["empty object", JSON.stringify({})],
    ["unknown field", JSON.stringify({ access: "public", nickname: "x" })],
    ["invalid enum", JSON.stringify({ access: "sidewalk" })],
    ["invalid bidet enum", JSON.stringify({ bidet_presence: "No" })],
    ["oversized name", JSON.stringify({ name: "n".repeat(201) })],
    ["oversized address", JSON.stringify({ address: "a".repeat(301) })],
    ["non-scalar value", JSON.stringify({ access: { deep: "public" } })],
    ["missing payload", null],
  ];
  for (const [label, payloadJson] of bad) {
    const result = planCanonicalPromotion(
      planInput({ kind: "access_update", payload_json: payloadJson }),
    );
    assert.equal(codeOf(result), "invalid_payload", label);
  }
  // Malformed evidence is a stored-structure problem too.
  const badEvidence = planCanonicalPromotion(
    planInput(
      {
        kind: "info_correction",
        payload_json: JSON.stringify({ latitude: 9.31, longitude: 123.31 }),
        evidence_json: "{oops",
      },
      {},
    ),
  );
  assert.equal(codeOf(badEvidence), "invalid_payload");
}

// ===========================================================================
// 6. Coordinates promote as a pair or not at all (contract §12)
// ===========================================================================
{
  for (const payload of [{ latitude: 9.31 }, { longitude: 123.31 }]) {
    const result = planCanonicalPromotion(
      planInput({
        kind: "info_correction",
        payload_json: JSON.stringify(payload),
        evidence_json: COORD_EVIDENCE,
      }),
    );
    assert.equal(codeOf(result), "incomplete_coordinate_pair", JSON.stringify(payload));
  }
  // A coordinate pair alongside a good field is still refused, not half-applied.
  const mixed = planCanonicalPromotion(
    planInput({
      kind: "info_correction",
      payload_json: JSON.stringify({ name: "Renamed", latitude: 9.31 }),
    }),
  );
  assert.equal(codeOf(mixed), "incomplete_coordinate_pair");
}

// ===========================================================================
// 7. Coordinate changes require field_observation / external_source evidence
// ===========================================================================
{
  const pair = JSON.stringify({ latitude: 9.31, longitude: 123.31 });
  const withoutEvidence = planCanonicalPromotion(
    planInput({ kind: "info_correction", payload_json: pair }),
  );
  assert.equal(codeOf(withoutEvidence), "coordinate_evidence_required");

  for (const type of ["field_observation", "external_source"]) {
    const ok = planCanonicalPromotion(
      planInput({
        kind: "info_correction",
        payload_json: pair,
        evidence_json: JSON.stringify([{ type, detail: "checked today" }]),
      }),
    );
    assert.equal(ok.ok, true, `${type} evidence satisfies §12`);
  }

  // user_note / photo_reference are sighted claims, not re-location evidence.
  for (const type of ["user_note", "photo_reference"]) {
    const weak = planCanonicalPromotion(
      planInput({
        kind: "info_correction",
        payload_json: pair,
        evidence_json: JSON.stringify([{ type, detail: "just a note" }]),
      }),
    );
    assert.equal(codeOf(weak), "coordinate_evidence_required", `${type} is not enough`);
  }

  // Presence/enum updates need no evidence at all (contract §12).
  const fee = planCanonicalPromotion(
    planInput({ kind: "fee_update", payload_json: JSON.stringify({ fee: "no" }) }),
  );
  assert.equal(fee.ok, true, "fee_update needs no evidence");

  // The evidence that justified the decision travels with the plan.
  assert.deepEqual(
    fee.plan.evidence,
    [],
    "no evidence supplied means an empty list, not undefined",
  );
}

// ===========================================================================
// 8. Out-of-bounds / non-finite coordinates are refused
// ===========================================================================
{
  const badPairs = [
    { latitude: 0, longitude: 0 },
    { latitude: 9.9, longitude: 123.31 },
    { latitude: 9.31, longitude: 124.5 },
    { latitude: "9.31", longitude: "123.31" },
    { latitude: null, longitude: null },
  ];
  for (const payload of badPairs) {
    const result = planCanonicalPromotion(
      planInput({
        kind: "info_correction",
        payload_json: JSON.stringify(payload),
        evidence_json: COORD_EVIDENCE,
      }),
    );
    assert.equal(codeOf(result), "invalid_coordinates", JSON.stringify(payload));
  }
}

// ===========================================================================
// 9. Proximity guard (contract §12) — informative refusal, never auto-merge
// ===========================================================================
{
  assert.equal(
    PROXIMITY_THRESHOLD_METERS,
    30,
    "30 m is the frozen default heuristic (not a scientific authority)",
  );
  const pair = JSON.stringify({ latitude: 9.31, longitude: 123.31 });
  const near = planCanonicalPromotion(
    planInput(
      { kind: "info_correction", payload_json: pair, evidence_json: COORD_EVIDENCE },
      {
        nearbyLocations: [
          { canonical_id: "buttler_loc_99999999999999999999", latitude: 9.310005, longitude: 123.31 },
        ],
      },
    ),
  );
  assert.equal(codeOf(near), "proximity_conflict");
  assert.ok(
    near.error.details.nearby_canonical_ids.includes("buttler_loc_99999999999999999999"),
    "the refusal names the neighbouring row so a human can reconcile",
  );

  // The target row itself is never a proximity conflict.
  const self = planCanonicalPromotion(
    planInput(
      { kind: "info_correction", payload_json: pair, evidence_json: COORD_EVIDENCE },
      { nearbyLocations: [{ canonical_id: TARGET_ID, latitude: 9.31, longitude: 123.31 }] },
    ),
  );
  assert.equal(self.ok, true, "a row is not near its own new position");

  // Just outside the threshold is allowed.
  const justOutside = planCanonicalPromotion(
    planInput(
      { kind: "info_correction", payload_json: pair, evidence_json: COORD_EVIDENCE },
      { nearbyLocations: [{ canonical_id: "buttler_loc_99999999999999999999", latitude: 9.3104, longitude: 123.31 }] },
    ),
  );
  assert.equal(justOutside.ok, true, "≈44 m away is beyond the guard");

  // The threshold is a configurable heuristic, not a hard-coded constant.
  const tighter = planCanonicalPromotion(
    planInput(
      { kind: "info_correction", payload_json: pair, evidence_json: COORD_EVIDENCE },
      {
        nearbyLocations: [{ canonical_id: "buttler_loc_99999999999999999999", latitude: 9.3104, longitude: 123.31 }],
        proximityThresholdMeters: 100,
      },
    ),
  );
  assert.equal(codeOf(tighter), "proximity_conflict", "caller may raise the guard");
}

// ===========================================================================
// 10 + 11. Bidet transition matrix (contract §8)
// ===========================================================================
{
  const bidet = (presence, overrides = {}) =>
    planCanonicalPromotion(
      planInput({ kind: "bidet_report", payload_json: JSON.stringify({ bidet_presence: presence }) }, overrides),
    );

  // Unknown -> Yes is the core community value.
  const upgrade = bidet("Yes");
  assert.equal(upgrade.ok, true, "Unknown -> Yes is promotable");
  assert.deepEqual(upgrade.plan.changed_columns, ["bidet_presence"]);
  assert.equal(upgrade.plan.resulting_values.bidet_presence, "Yes");

  // Yes -> Unknown is prohibited, surveyed row or not.
  const downgradeSurveyed = bidet("Unknown", {
    targetOverrides: { bidet_presence: "Yes", bidet_source_id: "bidet_survey_abc" },
  });
  assert.equal(codeOf(downgradeSurveyed), "bidet_downgrade_forbidden");
  assert.equal(downgradeSurveyed.error.details.surveyed, true, "must explain the DB invariant");
  const downgradeCommunity = bidet("Unknown", {
    targetOverrides: { bidet_presence: "Yes" },
  });
  assert.equal(codeOf(downgradeCommunity), "bidet_downgrade_forbidden");
  assert.equal(downgradeCommunity.error.details.surveyed, false, "reversal is the exit");

  // Yes -> Yes and Unknown -> Unknown are redundant, never a mutation plan.
  assert.equal(codeOf(bidet("Yes", { targetOverrides: { bidet_presence: "Yes" } })), "redundant_noop");
  assert.equal(codeOf(bidet("Unknown")), "redundant_noop");
}

// ===========================================================================
// 15 + 16. new_location stays a manual owner import; closure stays a signal
// ===========================================================================
{
  const newLoc = planCanonicalPromotion(
    planInput({
      kind: "new_location",
      target_canonical_id: null,
      payload_json: JSON.stringify({ name: "A New Place", latitude: 9.31, longitude: 123.31 }),
    }),
  );
  assert.equal(codeOf(newLoc), "unsupported_new_location");
  assert.match(newLoc.error.message, /manual owner import/i);

  for (const kind of ["closure_report", "problem_report", "reverification"]) {
    const signal = planCanonicalPromotion(
      planInput({ kind, payload_json: JSON.stringify({ closed: true }) }),
    );
    assert.equal(codeOf(signal), "unsupported_kind", `${kind} is signal-only`);
  }
}

// ===========================================================================
// 17. No-op proposals are deterministic and never become a mutation plan
// ===========================================================================
{
  const noops = [
    planInput({ kind: "access_update", payload_json: JSON.stringify({ access: "unknown" }) }),
    planInput({ kind: "fee_update", payload_json: JSON.stringify({ fee: "unknown" }) }),
    planInput({ kind: "info_correction", payload_json: JSON.stringify({ name: "Sample Public Restroom" }) }),
  ];
  for (const input of noops) {
    const first = planCanonicalPromotion(input);
    const second = planCanonicalPromotion(input);
    assert.equal(codeOf(first), "redundant_noop");
    assert.deepEqual(first, second, "the same input gives the same answer");
    assert.ok(!("plan" in first), "a no-op has no plan and therefore nothing to write");
  }
  // A partly-redundant payload keeps only the fields that actually change.
  const partial = planCanonicalPromotion(
    planInput({
      kind: "info_correction",
      payload_json: JSON.stringify({ name: "Sample Public Restroom", address: "9 New Street" }),
    }),
  );
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.plan.changed_columns, ["address"]);
}

// ===========================================================================
// 18. The base snapshot is exactly the seven writable fields plus updated_at
// ===========================================================================
{
  const result = planCanonicalPromotion(planInput());
  assert.equal(result.ok, true);
  assert.deepEqual(
    Object.keys(result.plan.base_snapshot).sort(),
    [
      "access",
      "address",
      "bidet_presence",
      "fee",
      "latitude",
      "longitude",
      "name",
      "updated_at",
    ],
    "the CAS snapshot carries the seven writable columns + updated_at and nothing else",
  );
  assert.deepEqual(result.plan.base_snapshot, {
    updated_at: SNAPSHOT_STAMP,
    access: "unknown",
    fee: "unknown",
    bidet_presence: "Unknown",
    name: "Sample Public Restroom",
    address: "Sample Street",
    latitude: 9.3068,
    longitude: 123.305,
  });
  assert.ok(!("bidet_source_id" in result.plan.base_snapshot));
  assert.ok(!("record_status" in result.plan.base_snapshot));
  assert.ok(!("canonical_id" in result.plan.base_snapshot));
  // A NULL address is preserved as NULL, not normalised to "" (contract §7).
  const nullAddress = planCanonicalPromotion({
    contribution: contributionRow({
      kind: "info_correction",
      payload_json: JSON.stringify({ address: "12 Real Street" }),
    }),
    target: targetRow({ address: null }),
  });
  assert.equal(nullAddress.plan.base_snapshot.address, null);
}

// ===========================================================================
// 19. The planner never mutates the objects it is given
// ===========================================================================
{
  const input = deepFreeze(
    planInput(
      {
        kind: "info_correction",
        payload_json: JSON.stringify({
          name: "Renamed Place",
          address: "9 New Street",
          latitude: 9.31,
          longitude: 123.31,
        }),
        evidence_json: COORD_EVIDENCE,
      },
      { nearbyLocations: [{ canonical_id: "buttler_loc_11111111111111111111", latitude: 9.5, longitude: 123.5 }] },
    ),
  );
  const before = structuredClone(input);
  const result = planCanonicalPromotion(input);
  assert.equal(result.ok, true, "deep-frozen input must still plan");
  assert.deepEqual(input, before, "input objects are byte-identical after planning");
  // A rejected path must not mutate either.
  const rejectedInput = deepFreeze(
    planInput({ kind: "access_update", payload_json: JSON.stringify({ access: "sidewalk" }) }),
  );
  const rejectedBefore = structuredClone(rejectedInput);
  assert.equal(codeOf(planCanonicalPromotion(rejectedInput)), "invalid_payload");
  assert.deepEqual(rejectedInput, rejectedBefore);
}

// ===========================================================================
// 20. Repeated calls with identical input return equivalent results
// ===========================================================================
{
  const input = planInput({
    kind: "info_correction",
    payload_json: JSON.stringify({ latitude: 9.31, longitude: 123.31 }),
    evidence_json: COORD_EVIDENCE,
  });
  const a = planCanonicalPromotion(input);
  const b = planCanonicalPromotion(input);
  assert.deepEqual(a, b, "planning is deterministic — no clock, no randomness");
  assert.notEqual(a.plan, b.plan, "each call returns its own object (no shared mutable state)");
}

// ===========================================================================
// Lifecycle + target preconditions (contract §16 matrix, planner side)
// ===========================================================================
{
  for (const status of ["pending", "validated", "needs_review", "rejected", "withdrawn", "superseded"]) {
    const result = planCanonicalPromotion(planInput({ status }));
    assert.equal(codeOf(result), "contribution_not_approved", status);
  }
  const noTarget = planCanonicalPromotion(
    planInput({ target_canonical_id: null }),
  );
  assert.equal(codeOf(noTarget), "canonical_target_required");
  const noRow = planCanonicalPromotion({
    contribution: contributionRow(),
    target: null,
  });
  assert.equal(codeOf(noRow), "canonical_target_required");
  for (const id of ["buttler_loc_short", "not_an_id", "buttler_loc_ZZZZZZZZZZZZZZZZZZZZ"]) {
    const bad = planCanonicalPromotion(
      planInput({ target_canonical_id: id }, { targetOverrides: { canonical_id: id } }),
    );
    assert.equal(codeOf(bad), "invalid_target", id);
  }
  // A target row for a different place than the contribution names is a bug,
  // not a promotion.
  const mismatch = planCanonicalPromotion({
    contribution: contributionRow(),
    target: targetRow({ canonical_id: "buttler_loc_99999999999999999999" }),
  });
  assert.equal(codeOf(mismatch), "invalid_target");
}

// ===========================================================================
// Purity / boundary hygiene of the planner module itself
// ===========================================================================
{
  const source = readFileSync(
    fileURLToPath(new URL("../lib/contributions/promotion-planner.ts", import.meta.url)),
    "utf8",
  );
  const forbidden = [
    "node:sqlite",
    "DatabaseSync",
    "wrangler",
    "D1Database",
    "fetch(",
    "crypto.",
    "process.env",
    "env.",
    "BUTTLER_PROMOTER_IDS",
    "node:fs",
    "node:http",
    "Response",
    "UPDATE canonical_locations",
    "INSERT INTO",
  ];
  for (const needle of forbidden) {
    assert.ok(!source.includes(needle), `planner source must not reference ${needle}`);
  }
  // No SQL, no SQL fragments, and no caller-supplied column names in a plan.
  const plan = planCanonicalPromotion(planInput()).plan;
  const serialised = JSON.stringify(plan);
  for (const needle of ["UPDATE", "INSERT", "SELECT", "DELETE", "=", "?"]) {
    assert.ok(!serialised.includes(needle), `plan must not carry SQL-ish text: ${needle}`);
  }
  assert.equal(
    typeof plan.canonical_id,
    "string",
    "the plan is data the executor later binds — never a statement",
  );
}

// ===========================================================================
// Name PII shape (contract §14) — refused at promote
// ===========================================================================
{
  const pii = ["hit me at someone@example.com", "https://spam.example", "www.spam.example", "+63 917 555 0123"];
  for (const name of pii) {
    const result = planCanonicalPromotion(
      planInput({ kind: "info_correction", payload_json: JSON.stringify({ name }) }),
    );
    assert.equal(codeOf(result), "name_pii_shape", name);
  }
  const clean = planCanonicalPromotion(
    planInput({ kind: "info_correction", payload_json: JSON.stringify({ name: "City Hall CR" }) }),
  );
  assert.equal(clean.ok, true, "an ordinary venue name is not PII-shaped");
}

console.log("STAGE14C_PLANNER_TEST_SUCCESS");
console.log(`  ${CONTRIBUTION_KINDS.length} kinds classified, ${WRITABLE_CANONICAL_COLUMNS.length} writable columns enforced`);
