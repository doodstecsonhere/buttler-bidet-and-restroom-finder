// GATE 6 — "no-redeploy" proof.
//
// The whole point of Buttler 2.0 is that the database is the source of truth
// and the API is the stable contract. This test shows that a data change made
// only in the read model becomes visible through the exact production API
// projection WITHOUT rebuilding or redeploying the frontend. The shipped
// frontend only carries a generated snapshot of the pre-edit dataset, so any
// value the API serves that differs from that snapshot could only have come
// from the database.
//
// Everything runs against an isolated in-memory SQLite file. It never touches
// the bound D1 database, matching how the other migration tests run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  SELECT_PUBLIC_CANONICAL_LOCATIONS,
  toPublicRestroom,
} from "../functions/api/restrooms.ts";
import { BUNDLED_RESTROOMS } from "../lib/restroom-bundle.ts";
import { loadCanonicalDataset } from "./import-canonical.mjs";

const migrationsDir = new URL("../d1/migrations/", import.meta.url);
const ddlPath = new URL("0003_create_canonical_read_model.sql", migrationsDir);
// The seed arrives as an ordered set of Wrangler-safe chunk files.
const seedPaths = readdirSync(migrationsDir)
  .filter((name) => /^0004_seed_canonical_locations.*\.sql$/.test(name))
  .sort()
  .map((name) => new URL(name, migrationsDir));

// The built, minified production bundle. If it is missing, run the frontend
// production build first so this proof is meaningful.
const bundleDir = new URL(
  "../artifacts/buttler/dist/public/assets/",
  import.meta.url,
);
assert.ok(
  existsSync(bundleDir),
  "Frontend build not found. Run the buttler production build before this test.",
);
const bundleName = readdirSync(bundleDir).find(
  (name) => name.startsWith("index-") && name.endsWith(".js"),
);
assert.ok(bundleName, "Expected a built index-*.js bundle to inspect.");
const bundlePath = new URL(bundleName, bundleDir);
const bundleBefore = readFileSync(bundlePath);
const bundleHashBefore = createHash("sha256").update(bundleBefore).digest("hex");

// 1. Apply the schema + seed to an isolated database and read through the real
//    production projection.
const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON;");
database.exec(readFileSync(ddlPath, "utf8"));
for (const seedPath of seedPaths) database.exec(readFileSync(seedPath, "utf8"));

const serve = () =>
  database
    .prepare(SELECT_PUBLIC_CANONICAL_LOCATIONS)
    .all()
    .map((row) => toPublicRestroom(row));

const dataset = loadCanonicalDataset();
const target = dataset.canonical.find(
  (row) => !row.Bidet_Source_ID && row.Access === "unknown",
);
assert.ok(target, "Expected at least one unknown-access candidate to edit.");

const baseline = serve();
const baselineTarget = baseline.find(
  (r) => r.id === target.Canonical_Location_ID,
);
assert.ok(baselineTarget, "Target should be served before the edit.");
assert.equal(baselineTarget.access, "unknown");

// The shipped frontend only knows about this record through the generated
// offline snapshot. It must still hold the pre-edit value, so any changed
// value the API serves afterwards demonstrably came from the database.
const snapshotTarget = BUNDLED_RESTROOMS.find(
  (r) => r.id === target.Canonical_Location_ID,
);
assert.ok(snapshotTarget, "Offline snapshot should include the target.");
assert.equal(snapshotTarget.access, "unknown");

// 2. Simulate an approved backend data change. This is the ONLY mutation: the
//    frontend is never rebuilt, restarted, or redeployed between the two reads.
database
  .prepare(
    "UPDATE canonical_locations SET access = 'public', fee = 'no' WHERE canonical_id = ?",
  )
  .run(target.Canonical_Location_ID);

const afterEdit = serve();
const editedTarget = afterEdit.find(
  (r) => r.id === target.Canonical_Location_ID,
);
assert.ok(editedTarget, "Target should still be served after the edit.");
assert.equal(editedTarget.access, "public");
assert.equal(editedTarget.fee, "no");
// Same frontend bytes, new value: it could only have come from the database.
assert.equal(snapshotTarget.access, "unknown");

// 3. Simulate a brand-new record appearing without any frontend change.
const newId = "buttler_loc_gate6_newrecord0000";
assert.ok(
  !serve().some((r) => r.id === newId),
  "New probe record should be absent before insertion.",
);
database
  .prepare(
    `INSERT INTO canonical_locations (
       canonical_id, record_status, name, latitude, longitude,
       restroom_presence, bidet_presence, access, fee,
       restroom_verification, bidet_verification, source_count
     ) VALUES (?, 'verified', 'Gate 6 New Restroom', 9.3068, 123.3054,
       'Yes', 'Yes', 'public', 'no', 'osm_explicit', 'field_verified', 1)`,
  )
  .run(newId);

assert.ok(
  serve().some((r) => r.id === newId && r.bidet === true),
  "API did not serve the newly inserted record.",
);

// 4. Prove the frontend was never touched: the built bundle bytes are identical
//    before and after both database mutations.
const bundleHashAfter = createHash("sha256")
  .update(readFileSync(bundlePath))
  .digest("hex");
assert.equal(
  bundleHashAfter,
  bundleHashBefore,
  "The built frontend changed, which invalidates the no-redeploy proof.",
);

database.close();
console.log("NO_REDEPLOY_TEST_SUCCESS");
