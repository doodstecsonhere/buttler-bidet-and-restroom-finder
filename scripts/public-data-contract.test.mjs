// Stage 5B — public data contract gate.
//
// Proves the public projection (API shape), the generated offline bundle, and
// the canonical D1 read model agree on exactly one catalogue: the 776-row
// canonical dataset with its approved semantics. It never touches production:
// everything runs against an isolated in-memory SQLite database seeded from
// the committed migrations, the same way the other data tests run.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  SELECT_PUBLIC_CANONICAL_LOCATIONS,
  toPublicRestroom,
} from "../functions/api/restrooms.ts";
import { BUNDLED_RESTROOMS } from "../lib/restroom-bundle.ts";
import { RESTROOMS as LEGACY_RESTROOMS } from "../lib/restroom-data.ts";
import { loadCanonicalDataset } from "./import-canonical.mjs";

const migrationsDir = new URL("../d1/migrations/", import.meta.url);
const ddlPath = new URL("0003_create_canonical_read_model.sql", migrationsDir);
// The seed arrives as an ordered set of Wrangler-safe chunk files; applying
// them in name order keeps locations before their provenance links.
const seedPaths = readdirSync(migrationsDir)
  .filter((name) => /^0004_seed_canonical_locations.*\.sql$/.test(name))
  .sort()
  .map((name) => new URL(name, migrationsDir));

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON;");
database.exec(readFileSync(ddlPath, "utf8"));
for (const seedPath of seedPaths) database.exec(readFileSync(seedPath, "utf8"));

const served = database
  .prepare(SELECT_PUBLIC_CANONICAL_LOCATIONS)
  .all()
  .map((row) => toPublicRestroom(row));

// 1. The full canonical catalogue is public, including the 625 discovery
//    candidates whose restroom presence is Unknown. Nothing is filtered out
//    merely for being uncertain.
assert.equal(served.length, 776);

// 2. Canonical string ids are served untouched; no numeric coercion.
for (const record of served) {
  assert.equal(typeof record.id, "string");
  assert.match(record.id, /^buttler_loc_[0-9a-f]{20}$/);
}

// 3. Bidet evidence: exactly the owner-approved split, derived from the
//    existing verification column. No invented classifications.
const bidetRecords = served.filter((record) => record.bidet);
assert.equal(bidetRecords.length, 114);
assert.equal(
  bidetRecords.filter((record) => record.bidet_evidence === "field_verified")
    .length,
  98,
);
assert.equal(
  bidetRecords.filter((record) => record.bidet_evidence === "osm_explicit")
    .length,
  16,
);
for (const record of served.filter((record) => !record.bidet)) {
  assert.equal(record.bidet_evidence, "unknown");
}

// 4. Fee information is preserved from the canonical source, never flattened
//    into a lossy yes/no domain.
const dataset = loadCanonicalDataset();
const feeBySourceId = new Map(
  dataset.canonical.map((row) => [
    row.Canonical_Location_ID,
    { access: row.Access, fee: row.Fee },
  ]),
);
for (const record of served) {
  assert.ok(
    ["yes", "no", "unknown"].includes(record.fee),
    `fee left the canonical domain: ${record.fee}`,
  );
  const source = feeBySourceId.get(record.id);
  assert.equal(record.fee, source.fee, `fee changed for ${record.id}`);
  assert.equal(record.access, source.access, `access changed for ${record.id}`);
}
assert.ok(served.some((record) => record.fee === "unknown"));

// 5. Access semantics: stored values survive projection verbatim. "unknown"
//    is never rewritten to "customers"; only exact "public" exists as public.
assert.ok(served.some((record) => record.access === "unknown"));
assert.ok(served.some((record) => record.access === "public"));

// 6. The offline bundle is the same catalogue as the live projection — same
//    rows, same order, same values — so online and offline can never silently
//    be two different catalogues.
assert.deepEqual(BUNDLED_RESTROOMS, served);

// 7. The superseded legacy 1,112-row catalogue must not sneak back into the
//    offline path.
assert.equal(LEGACY_RESTROOMS.length, 1112); // legacy array kept only as the off-stack seed
assert.notEqual(BUNDLED_RESTROOMS.length, LEGACY_RESTROOMS.length);
for (const record of BUNDLED_RESTROOMS) {
  assert.equal(typeof record.id, "string");
  assert.ok(record.id.startsWith("buttler_loc_"));
}

database.close();
console.log("PUBLIC_DATA_CONTRACT_TEST_SUCCESS");
