import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const migrationDirectory = new URL("../d1/migrations/", import.meta.url);
const rollbackPath = new URL(
  "../d1/rollback/0001_drop_restroom_locations.sql",
  import.meta.url,
);
const database = new DatabaseSync(":memory:");

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

const insert = database.prepare(`
  INSERT INTO restroom_locations (
    id, name, latitude, longitude, address, access, fee, has_bidet,
    record_status, source_kind, verified_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insert.run(
  1,
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
  1,
);

assert.throws(
  () =>
    insert.run(
      2,
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
      3,
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
      4,
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
