// Buttler 2.0 — Stage 14K.1 source/offline reconciliation parity suite.
//
// Proves the post-base reconciliation LAYER: the ordered ops in
// attached_assets/buttler_canonical_reconciliations.csv must produce an
// effective active catalogue that is byte-for-byte the same catalogue the
// live API projection serves once the mirrored D1 forward migration (0008)
// is applied. Historical migrations 0001-0007 stay frozen; the raw owner CSVs
// stay the cutover snapshot. Everything runs against throwaway in-memory
// SQLite; production is never touched.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  SELECT_PUBLIC_CANONICAL_LOCATIONS,
  toPublicRestroom,
} from "../functions/api/restrooms.ts";
import { BUNDLED_RESTROOMS } from "../lib/restroom-bundle.ts";
import {
  SUPPRESSED_RECORD_STATUS,
  applyCanonicalReconciliations,
  loadCanonicalDataset,
  loadCanonicalReconciliations,
  listCommittedSeedCanonicalIds,
  selectActiveCanonicalRows,
  validateDataset,
} from "./import-canonical.mjs";
import {
  generateBundledCatalogue,
  loadEffectiveActiveCatalogue,
} from "./generate-bundled-catalogue.mjs";

const SURVIVOR = "buttler_loc_a7db20b50c9993d58c0e";
const DUPLICATE = "buttler_loc_a962aa157dff936ae36a";
const SURVEY_ID = "bidet_survey_2fb2f828db6b507991d2";

const migrationsDir = new URL("../d1/migrations/", import.meta.url);
const bundlePath = new URL("../lib/restroom-bundle.ts", import.meta.url);
const normalize = (value) => value.replaceAll("\r\n", "\n");

// ---------------------------------------------------------------------------
// 1. Frozen history: the raw CSV dataset still satisfies every existing
//    invariant and the reconciliation ops cannot add or remove canonical ids,
//    so the droppedBaseIds frozen-base guard stays structurally satisfiable.
// ---------------------------------------------------------------------------
const dataset = loadCanonicalDataset();
const rawStats = validateDataset(dataset);
assert.equal(rawStats.canonical_rows, 777, "raw CSV keeps the 777-row cutover snapshot");
assert.equal(rawStats.provenance_rows, 847, "raw CSV keeps the 847-row provenance snapshot");

const baseIds = listCommittedSeedCanonicalIds(fileURLToPath(migrationsDir));
assert.ok(baseIds.has(SURVIVOR) && baseIds.has(DUPLICATE), "both Pulantubig ids stay in the frozen 0004 base");
const rawIds = new Set(dataset.canonical.map((row) => row.Canonical_Location_ID));
for (const id of baseIds) {
  assert.ok(rawIds.has(id), `frozen base id missing from CSV: ${id}`);
}

// ---------------------------------------------------------------------------
// 2. Ops contract: ordered, known operations referencing only existing rows;
//    suppression never deletes a physical row.
// ---------------------------------------------------------------------------
const ops = loadCanonicalReconciliations();
assert.ok(ops.length > 0, "at least the Stage 14K reconciliation is recorded");
const sequences = ops.map((op) => Number(op.Sequence));
assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), "ops load in Sequence order");
assert.equal(new Set(sequences).size, sequences.length, "no duplicate Sequence numbers");
for (const op of ops) {
  assert.ok(
    ["update", "reassign_provenance", "suppress"].includes(op.Operation),
    `unknown op kind: ${op.Operation}`,
  );
  assert.ok(rawIds.has(op.Target_Canonical_ID), `op ${op.Sequence} targets an unknown canonical id`);
}
const suppressions = ops.filter((op) => op.Operation === "suppress").map((op) => op.Target_Canonical_ID);
assert.ok(!suppressions.includes(SURVIVOR), "the survivor is never suppressed");
assert.deepEqual(suppressions, [DUPLICATE], "exactly the Stage 14K duplicate is suppressed");

// ---------------------------------------------------------------------------
// 3. Effective dataset: physical counts are UNCHANGED (lineage retained);
//    every invariant including the 99-survey population still holds.
// ---------------------------------------------------------------------------
const effective = applyCanonicalReconciliations(dataset, ops);
assert.equal(effective.canonical.length, 777, "reconciliation never removes a physical row");
assert.equal(effective.provenance.length, 847, "reconciliation never removes provenance");
const effectiveStats = validateDataset(effective);
assert.equal(effectiveStats.verified_bidet_records, 99, "survey-anchored population conserved");

const survivor = effective.canonical.find((row) => row.Canonical_Location_ID === SURVIVOR);
const duplicate = effective.canonical.find((row) => row.Canonical_Location_ID === DUPLICATE);
// Mission Phase 3: the effective survivor record.
assert.equal(survivor.Name, "Bahay Pamahalaan ng Barangay Pulantubig", "survivor name retained");
assert.equal(survivor.Address, "L. Rovira West Road, Dumaguete", "survivor address retained");
assert.equal(Number(survivor.Latitude), 9.3240755, "survivor OSM coordinate retained");
assert.equal(Number(survivor.Longitude), 123.2880588, "survivor OSM coordinate retained");
assert.equal(survivor.Access, "public", "survivor access=public");
assert.equal(survivor.Bidet_Presence, "Yes", "survivor bidet=Yes");
assert.equal(survivor.Bidet_Verification, "field_verified", "field-verified bidet semantics");
assert.equal(survivor.Restroom_Verification, "field_verified_via_bidet_survey", "field-verified restroom semantics");
assert.equal(survivor.Bidet_Source_ID, SURVEY_ID, "survey provenance attached to the survivor");
assert.equal(survivor.Fee, "unknown", "fee not overwritten by the merge");
// The duplicate is retained lineage, released from its evidentiary claims.
assert.equal(duplicate.record_status, "rejected", "duplicate kept as rejected lineage");
assert.equal(duplicate.Bidet_Source_ID, "", "duplicate released the survey");
assert.equal(duplicate.Bidet_Verification, "unknown", "verification follows its evidence");
assert.equal(duplicate.Name, "Pulantubig Barangay Hall", "lineage row keeps its audited identity");

// Provenance moved, not duplicated: no pair collisions, no orphans.
const pairs = effective.provenance.map((p) => `${p.Canonical_Location_ID}|${p.Source_Link_ID}`);
assert.equal(new Set(pairs).size, pairs.length, "no duplicate provenance pairs");
const effIds = new Set(effective.canonical.map((row) => row.Canonical_Location_ID));
assert.ok(pairs.every((pair) => effIds.has(pair.split("|")[0])), "no orphan provenance");
assert.ok(pairs.includes(`${SURVIVOR}|${SURVEY_ID}`), "survey provenance lives under the survivor");
assert.ok(!pairs.includes(`${DUPLICATE}|${SURVEY_ID}`), "duplicate no longer carries survey provenance");

// Replay-safety: applying the same ops to the same raw dataset again produces
// an identical effective dataset, and the ops file loads in the same order.
const replay = applyCanonicalReconciliations(loadCanonicalDataset(), loadCanonicalReconciliations());
assert.deepEqual(replay, effective, "reconciliation application is deterministic");

// ---------------------------------------------------------------------------
// 4. Offline bundle: committed bytes equal a fresh deterministic generation,
//    the active set excludes exactly the suppressed lineage row, and the
//    survivor appears exactly once with the merged public values.
// ---------------------------------------------------------------------------
const active = selectActiveCanonicalRows(effective);
assert.equal(active.length, 776, "776 active rows after reconciliation");
assert.equal(
  normalize(readFileSync(bundlePath, "utf8")),
  generateBundledCatalogue(loadEffectiveActiveCatalogue()),
  "lib/restroom-bundle.ts is byte-identical to a fresh deterministic generation",
);
assert.equal(BUNDLED_RESTROOMS.length, 776, "offline bundle carries the active catalogue");
const bundledSurvivor = BUNDLED_RESTROOMS.filter((record) => record.id === SURVIVOR);
assert.equal(bundledSurvivor.length, 1, "survivor appears exactly once offline");
assert.deepEqual(bundledSurvivor[0], {
  id: SURVIVOR,
  name: "Bahay Pamahalaan ng Barangay Pulantubig",
  latitude: 9.3240755,
  longitude: 123.2880588,
  address: "L. Rovira West Road, Dumaguete",
  access: "public",
  fee: "unknown",
  bidet: true,
  bidet_evidence: "field_verified",
});
assert.ok(
  !BUNDLED_RESTROOMS.some((record) => record.id === DUPLICATE),
  "the retired duplicate never appears as an active offline record",
);

// ---------------------------------------------------------------------------
// 5. D1 mirror parity: seed a throwaway database with ALL committed migrations
//    (0001-0008) and prove the live API projection equals the offline bundle
//    row-for-row — the effective source layer and the D1 forward migration
//    describe the same reconciliation.
// ---------------------------------------------------------------------------
const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON;");
const allMigrationFiles = readdirSync(fileURLToPath(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();
for (const name of allMigrationFiles) {
  database.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
}

const served = database
  .prepare(SELECT_PUBLIC_CANONICAL_LOCATIONS)
  .all()
  .map((row) => toPublicRestroom(row));
assert.deepEqual(BUNDLED_RESTROOMS, served, "offline bundle equals the post-0008 live projection exactly");
assert.equal(served.length, 776, "online active catalogue is 776 rows");

// Physical versus active counts are DIFFERENT by design: rejected lineage rows
// stay in D1 (FK anchors for contributions, exact rollback), while both the
// API filter and the bundle generator exclude them from the active catalogue.
assert.equal(
  database.prepare("SELECT count(*) c FROM canonical_locations").get().c,
  777,
  "physical D1 canonical count is unchanged by the reconciliation",
);
assert.equal(
  database.prepare("SELECT count(*) c FROM canonical_locations WHERE record_status = 'rejected'").get().c,
  1,
  "exactly one rejected lineage row (the Pulantubig duplicate)",
);
assert.equal(
  database.prepare("SELECT count(*) c FROM location_provenance").get().c,
  847,
  "provenance moved, never deleted",
);
assert.equal(
  database.prepare("SELECT count(*) c FROM restroom_locations").get().c,
  1112,
  "legacy rows unchanged",
);
// Public projection semantics agree offline and online.
assert.equal(
  served.filter((record) => record.bidet && record.bidet_evidence === "field_verified").length,
  BUNDLED_RESTROOMS.filter((record) => record.bidet && record.bidet_evidence === "field_verified").length,
  "field-verified bidet population agrees online and offline",
);
assert.equal(
  served.filter((record) => record.bidet && record.bidet_evidence === "osm_explicit").length,
  16,
  "osm_explicit bidet population unchanged",
);

// ---------------------------------------------------------------------------
// 6. Unrelated rows: every active record except the reconciliation targets is
//    identical to the raw CSV projection (no collateral edits).
// ---------------------------------------------------------------------------
const rawActive = dataset.canonical.filter((row) => row.Canonical_Location_ID !== DUPLICATE);
const rawById = new Map(rawActive.map((row) => [row.Canonical_Location_ID, row]));
for (const record of served) {
  if (record.id === SURVIVOR) continue; // documented merge target
  const source = rawById.get(record.id);
  assert.ok(source, `served record not in the raw dataset: ${record.id}`);
  assert.equal(record.name, source.Name);
  assert.equal(record.latitude, Number(source.Latitude));
  assert.equal(record.longitude, Number(source.Longitude));
  assert.equal(record.access, source.Access);
  assert.equal(record.fee, source.Fee);
  assert.equal(record.bidet, source.Bidet_Presence === "Yes");
  assert.equal(record.bidet_evidence, source.Bidet_Verification);
}
assert.ok(!suppressions.some((id) => served.some((record) => record.id === id)), "no suppressed id served");

database.close();
console.log("STAGE14K1_RECONCILIATION_PARITY_TEST_SUCCESS");
