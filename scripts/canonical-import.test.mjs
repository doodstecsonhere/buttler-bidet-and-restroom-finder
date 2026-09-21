import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  EXPECTED_VERIFIED_BIDET_COUNT,
  PROTECTED_DISTINCT_ENTITIES,
  generateCanonicalDdlSql,
  generateCanonicalSeedSql,
  loadCanonicalDataset,
  validateDataset,
} from "./import-canonical.mjs";

const ddlPath = new URL(
  "../d1/migrations/0003_create_canonical_read_model.sql",
  import.meta.url,
);
const seedPath = new URL(
  "../d1/migrations/0004_seed_canonical_locations.sql",
  import.meta.url,
);
const normalize = (value) => value.replaceAll("\r\n", "\n");

// 1. The checked-in migrations match the generator and the source CSVs.
const dataset = loadCanonicalDataset();
const stats = validateDataset(dataset);
assert.equal(normalize(readFileSync(seedPath, "utf8")), normalize(generateCanonicalSeedSql(dataset.canonical, dataset.provenance, dataset.fingerprints)));
assert.equal(normalize(readFileSync(ddlPath, "utf8")), normalize(generateCanonicalDdlSql()));

// 2. Dataset invariants from the reconciliation summary.
assert.equal(stats.canonical_rows, 776);
assert.equal(stats.provenance_rows, 845);
assert.equal(stats.verified_bidet_records, EXPECTED_VERIFIED_BIDET_COUNT);

// 3. Apply the schema and seed to an isolated in-memory database.
const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON;");
database.exec(readFileSync(ddlPath, "utf8"));
database.exec(readFileSync(seedPath, "utf8"));

const countIn = (table) =>
  database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

assert.equal(countIn("canonical_locations"), 776);
assert.equal(countIn("location_provenance"), 845);

// 4. All 98 verified bidet records exist exactly once, with Yes/Yes and
//    field verification, and keep their surveyed names and coordinates.
const surveyStats = database
  .prepare(
    `SELECT
       count(*) AS rows,
       sum(bidet_presence = 'Yes') AS bidet_yes,
       sum(restroom_presence = 'Yes') AS restroom_yes,
       sum(restroom_verification = 'field_verified_via_bidet_survey') AS field_verified
     FROM canonical_locations
     WHERE bidet_source_id IS NOT NULL`,
  )
  .get();
assert.deepEqual({ ...surveyStats }, {
  rows: 98,
  bidet_yes: 98,
  restroom_yes: 98,
  field_verified: 98,
});
assert.equal(
  database
    .prepare(
      `SELECT count(*) AS n FROM (
         SELECT bidet_source_id FROM canonical_locations
         WHERE bidet_source_id IS NOT NULL
         GROUP BY bidet_source_id HAVING count(*) > 1
       )`,
    )
    .get().n,
  0,
);
for (const [index, source] of dataset.canonical
  .filter((row) => row.Bidet_Source_ID)
  .entries()) {
  const stored = database
    .prepare(
      "SELECT name, latitude, longitude FROM canonical_locations WHERE canonical_id = ?",
    )
    .get(source.Canonical_Location_ID);
  assert.equal(stored.name, source.Name, `survey name changed for row ${index}`);
  assert.equal(stored.latitude, Number(source.Latitude));
  assert.equal(stored.longitude, Number(source.Longitude));
}

// 5. Provenance exists for every verified survey and links agree.
assert.equal(
  database
    .prepare(
      `SELECT count(DISTINCT source_record_id) AS n FROM location_provenance
       WHERE source_type = 'field_survey_bidet_workbook'`,
    )
    .get().n,
  98,
);
assert.equal(
  database
    .prepare(
      `SELECT count(*) AS n FROM canonical_locations c
       WHERE c.bidet_source_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM location_provenance p
         WHERE p.canonical_id = c.canonical_id
           AND p.source_record_id = c.bidet_source_id
           AND p.source_type = 'field_survey_bidet_workbook'
       )`,
    )
    .get().n,
  0,
);

// 6. Protected child locations remain distinct canonical entities.
for (const entity of PROTECTED_DISTINCT_ENTITIES) {
  assert.equal(
    database
      .prepare("SELECT count(*) AS n FROM canonical_locations WHERE name = ?")
      .get(entity).n,
    1,
    `protected entity missing or duplicated: ${entity}`,
  );
}

// 7. Unknown is never coerced to No.
assert.equal(
  database
    .prepare("SELECT count(*) AS n FROM canonical_locations WHERE bidet_presence = 'No' OR restroom_presence = 'No'")
    .get().n,
  0,
);
assert.equal(
  database.prepare("SELECT count(*) AS n FROM canonical_locations WHERE restroom_presence = 'Unknown'").get().n,
  625,
);
assert.equal(
  database.prepare("SELECT count(*) AS n FROM canonical_locations WHERE bidet_presence = 'Unknown'").get().n,
  662,
);

// 8. Import is idempotent: rerunning preserves counts, and a reviewed
//    record_status upgrade survives a re-import while field data refreshes.
database.exec(readFileSync(seedPath, "utf8"));
assert.equal(countIn("canonical_locations"), 776);
assert.equal(countIn("location_provenance"), 845);

const target = dataset.canonical.find((row) => !row.Bidet_Source_ID);
database
  .prepare("UPDATE canonical_locations SET record_status = 'verified', notes = 'reviewed' WHERE canonical_id = ?")
  .run(target.Canonical_Location_ID);
database.exec(readFileSync(seedPath, "utf8"));
const preserved = database
  .prepare("SELECT record_status FROM canonical_locations WHERE canonical_id = ?")
  .get(target.Canonical_Location_ID);
assert.equal(preserved.record_status, "verified");

// 9. Schema constraints reject invalid rows (fail-safe, not silent corruption).
const badInsert = (canonicalId, overrides = {}) => {
  database
    .prepare(
      `INSERT INTO canonical_locations (
         canonical_id, name, latitude, longitude, restroom_presence,
         bidet_presence, access, fee, restroom_verification,
         bidet_verification, source_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      canonicalId,
      overrides.name ?? "Constraint probe",
      overrides.latitude ?? 9.3068,
      overrides.longitude ?? 123.3054,
      overrides.restroom_presence ?? "Unknown",
      overrides.bidet_presence ?? "Unknown",
      overrides.access ?? "unknown",
      overrides.fee ?? "unknown",
      overrides.restroom_verification ?? "candidate_unverified",
      overrides.bidet_verification ?? "unknown",
      overrides.source_count ?? 1,
    );
};
assert.throws(() => badInsert("probe_lat", { latitude: 91 }), /constraint failed/i);
assert.throws(() => badInsert("probe_presence", { bidet_presence: "No" }), /constraint failed/i);
assert.throws(() => badInsert("probe_access", { access: "maybe" }), /constraint failed/i);
assert.throws(() => badInsert("probe_count", { source_count: 0 }), /constraint failed/i);
badInsert("probe_dup", {}); // first insert ok
assert.throws(() => badInsert("probe_dup", {}), /constraint failed/i); // PK duplicate
database.exec("DELETE FROM canonical_locations WHERE canonical_id LIKE 'probe_%'");

// Orphan provenance is rejected.
assert.throws(
  () =>
    database
      .prepare(
        `INSERT INTO location_provenance (
           canonical_id, source_link_id, source_type, source_record_id,
           evidence_role
         ) VALUES ('buttler_loc_does_not_exist', 'x/1', 'OSM', 'x/1', 'restroom_acquisition')`,
      )
      .run(),
  /constraint failed/i,
);

// 10. Survey identity cannot be downgraded inside the read model.
const surveyRow = dataset.canonical.find((row) => row.Bidet_Source_ID);
assert.throws(
  () =>
    database
      .prepare("UPDATE canonical_locations SET bidet_presence = 'Unknown' WHERE canonical_id = ?")
      .run(surveyRow.Canonical_Location_ID),
  /constraint failed/i,
);

database.close();
console.log("CANONICAL_IMPORT_TEST_SUCCESS");
