import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { RESTROOMS } from "../lib/restroom-data.ts";
import { generateSeedSql } from "./generate-d1-seed.mjs";
const migrationDirectory = new URL("../d1/migrations/", import.meta.url);
const rollbackPath = new URL(
  "../d1/rollback/0001_drop_restroom_locations.sql",
  import.meta.url,
);
const database = new DatabaseSync(":memory:");
const seedPath = new URL(
  "../d1/migrations/0002_seed_restroom_locations.sql",
  import.meta.url,
);

assert.equal(readFileSync(seedPath, "utf8"), generateSeedSql());

for (const filename of readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
}

const tables = database
  .prepare(
    `
  SELECT name
  FROM sqlite_schema
  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`,
  )
  .all();

assert.deepEqual(
  tables.map(({ name }) => name),
  ["restroom_locations"],
);

const indexes = database
  .prepare(
    `
  SELECT name
  FROM sqlite_schema
  WHERE type = 'index' AND tbl_name = 'restroom_locations'
  ORDER BY name
`,
  )
  .all();

assert.deepEqual(
  indexes.map(({ name }) => name),
  [
    "idx_restroom_locations_coordinates",
    "idx_restroom_locations_name",
    "idx_restroom_locations_public_filter",
  ],
);

const seededRows = database
  .prepare(
    `
    SELECT id, name, latitude, longitude, address, access, fee, has_bidet,
           record_status, source_kind, source_reference, verified_at
    FROM restroom_locations
    ORDER BY id
  `,
  )
  .all();

assert.equal(seededRows.length, RESTROOMS.length);

const sortedRestrooms = [...RESTROOMS].sort(
  (left, right) => left.id - right.id,
);
for (const [index, row] of seededRows.entries()) {
  const source = sortedRestrooms[index];
  assert.deepEqual(
    { ...row },
    {
      id: source.id,
      name: source.name,
      latitude: source.latitude,
      longitude: source.longitude,
      address: source.address,
      access: source.access,
      fee: source.fee,
      has_bidet: source.bidet ? 1 : 0,
      record_status: "candidate",
      source_kind: "imported",
      source_reference: "bundled-catalogue",
      verified_at: null,
    },
  );
}

database.exec(readFileSync(seedPath, "utf8"));
assert.equal(
  database.prepare("SELECT count(*) AS count FROM restroom_locations").get()
    .count,
  RESTROOMS.length,
);

const insert = database.prepare(`
  INSERT INTO restroom_locations (
    id, name, latitude, longitude, address, access, fee, has_bidet,
    record_status, source_kind, verified_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const testId = Math.max(...RESTROOMS.map(({ id }) => id)) + 1;
insert.run(
  testId,
  "Verified test restroom",
  9.3068,
  123.3054,
  null,
  "public",
  "no",
  1,
  "verified",
  "owner-vetted",
  "2026-08-24T00:00:00Z",
);

assert.equal(
  database.prepare("SELECT count(*) AS count FROM restroom_locations").get()
    .count,
  RESTROOMS.length + 1,
);

assert.throws(
  () =>
    insert.run(
      testId + 1,
      "Invalid latitude",
      91,
      123.3,
      null,
      "public",
      "no",
      0,
      "candidate",
      "owner-vetted",
      null,
    ),
  /constraint failed/i,
);

assert.throws(
  () =>
    insert.run(
      testId + 2,
      "Invalid status",
      9.3,
      123.3,
      null,
      "public",
      "no",
      0,
      "unreviewed",
      "owner-vetted",
      null,
    ),
  /constraint failed/i,
);

assert.throws(
  () =>
    insert.run(
      testId + 3,
      "Unverified verified row",
      9.3,
      123.3,
      null,
      "public",
      "no",
      0,
      "verified",
      "owner-vetted",
      null,
    ),
  /constraint failed/i,
);

database.exec(readFileSync(rollbackPath, "utf8"));

assert.equal(
  database
    .prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'restroom_locations'",
    )
    .get().count,
  0,
);

database.close();
console.log("D1_SCHEMA_TEST_SUCCESS");
