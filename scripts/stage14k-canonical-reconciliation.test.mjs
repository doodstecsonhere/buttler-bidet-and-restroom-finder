// Buttler 2.0 — Stage 14K canonical duplicate reconciliation test suite.
//
// Proves the Pulantubig merge migration against a throwaway in-memory SQLite
// database built from the committed migrations (0001-0007), never production.
// Covers the mission Phase 7 checks (1-15), rollback exactness, idempotence /
// replay behaviour, and static guarantees that the migration is narrow and
// non-destructive. Mirrors the harness style of scripts/canonical-import.test.mjs
// and scripts/d1-schema.test.mjs.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SURVIVOR = "buttler_loc_a7db20b50c9993d58c0e";
const DUPLICATE = "buttler_loc_a962aa157dff936ae36a";
const SURVEY_ID = "bidet_survey_2fb2f828db6b507991d2";

const migrationsDir = new URL("../d1/migrations/", import.meta.url);
const migrationsPath = fileURLToPath(migrationsDir);
const mergeSql = readFileSync(
  new URL("0008_reconcile_pulantubig_canonical_duplicate.sql", migrationsDir),
  "utf8",
);
const rollbackSql = readFileSync(
  new URL("../d1/rollback/0008_revert_pulantubig_canonical_duplicate.sql", import.meta.url),
  "utf8",
);

// Baseline migrations are everything EXCEPT the merge (0001-0007) applied in
// name order, so locations precede provenance and contributions follow their FK.
const baselineFiles = readdirSync(migrationsPath)
  .filter((name) => name.endsWith(".sql") && !name.startsWith("0008"))
  .sort();

function buildDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const name of baselineFiles) {
    database.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
  }
  return database;
}

const CANONICAL_COLUMNS = [
  "canonical_id", "name", "latitude", "longitude", "address",
  "restroom_presence", "bidet_presence", "access", "fee",
  "restroom_verification", "bidet_verification", "candidate_priority",
  "parent_venue", "source_count", "osm_type", "osm_id", "bidet_source_id",
  "match_status", "match_confidence", "match_reason", "last_checked", "notes",
  "record_status", "created_at", "updated_at",
];

function snapshotCanonical(database) {
  const rows = database
    .prepare(`SELECT ${CANONICAL_COLUMNS.join(", ")} FROM canonical_locations`)
    .all();
  const map = new Map();
  for (const row of rows) map.set(row.canonical_id, row);
  return map;
}

function snapshotProvenance(database) {
  const rows = database
    .prepare(
      `SELECT canonical_id, source_link_id, source_type, source_record_id,
              evidence_role, original_name, original_latitude, original_longitude,
              original_address, original_access, original_fee,
              original_restroom_presence, original_bidet_presence, verification,
              source_data_json
       FROM location_provenance`,
    )
    .all();
  const map = new Map();
  for (const row of rows) map.set(`${row.canonical_id}|${row.source_link_id}`, row);
  return map;
}

// A minimal, valid contribution row so we can prove the merge leaves
// contributions untouched and keeps their foreign key resolvable.
function seedProbeContributions(database) {
  const insert = database.prepare(
    `INSERT INTO contributions (
       contribution_id, kind, target_canonical_id, contributor_user_id,
       payload_json, notes
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    "contrib_14k_probe_dup_closure0", "closure_report", DUPLICATE,
    "probe-contributor", '{"closed":true}',
    "Stage 14K probe: closure of the duplicate as its survivor's duplicate",
  );
  insert.run(
    "contrib_14k_probe_surv_access1", "access_update", SURVIVOR,
    "probe-contributor", '{"access":"public"}', null,
  );
}

function contributionSnapshot(database) {
  return database
    .prepare(
      `SELECT contribution_id, kind, target_canonical_id, contributor_user_id,
              status, validation_status, payload_json, notes
       FROM contributions ORDER BY contribution_id`,
    )
    .all();
}

const equal = (left, right, label) =>
  assert.deepEqual(left, right, label);

// Drop the volatile apply-time stamp so rows can be compared on data columns.
const stripTs = (row) => {
  const copy = { ...row };
  delete copy.updated_at;
  return copy;
};

// ---- Static guarantees: the migration is narrow and non-destructive --------
// Scan only the executable statements. The migration header deliberately names
// the tables it must NOT touch (contributions, canonical_promotions,
// restroom_locations) to document intent, so comments are stripped first.
const stripSqlComments = (sql) =>
  sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
const mergeStatements = stripSqlComments(mergeSql);
const lower = mergeStatements.toLowerCase();
assert.ok(!/\bdelete\b/.test(lower), "merge must not DELETE anything");
assert.ok(!/\binsert\b/.test(lower), "merge must not INSERT new rows");
assert.ok(!/\bdrop\b/.test(lower), "merge must not DROP anything");
assert.ok(!/contributions/.test(lower), "merge must not touch contributions");
assert.ok(!/canonical_promotions/.test(lower), "merge must not touch the promotion ledger");
assert.ok(!/restroom_locations/.test(lower), "merge must not touch the legacy table");
assert.ok(!/alter\s+table/.test(lower), "merge must not alter the schema");
// Only two tables may be written: canonical_locations and location_provenance.
for (const match of mergeStatements.matchAll(/UPDATE\s+([a-z_]+)/gi)) {
  assert.ok(
    ["canonical_locations", "location_provenance"].includes(match[1]),
    `unexpected UPDATE target: ${match[1]}`,
  );
}
// No invented record_status value: the only status written is 'rejected'.
assert.ok(/record_status = 'rejected'/.test(lower), "duplicate must be rejected");
assert.ok(!/record_status = '(superseded|hidden|deleted)'/.test(lower),
  "must not invent an out-of-domain canonical status");

// ---- Build baseline and capture pre-merge state ----------------------------
const database = buildDatabase();
seedProbeContributions(database);

const preCanonical = snapshotCanonical(database);
const preProvenance = snapshotProvenance(database);
const preContributions = contributionSnapshot(database);
const preCounts = {
  canonical: preCanonical.size,
  provenance: preProvenance.size,
  legacy: database.prepare("SELECT count(*) c FROM restroom_locations").get().c,
  promotions: database.prepare("SELECT count(*) c FROM canonical_promotions").get().c,
  surveyHolders: database
    .prepare("SELECT count(*) c FROM canonical_locations WHERE bidet_source_id IS NOT NULL")
    .get().c,
  bidetFieldVerified: database
    .prepare("SELECT count(*) c FROM canonical_locations WHERE bidet_verification = 'field_verified'")
    .get().c,
};
assert.equal(preCounts.canonical, 777, "baseline canonical rows");
assert.equal(preCounts.provenance, 847, "baseline provenance rows");
assert.equal(preCounts.legacy, 1112, "baseline legacy rows");
assert.equal(preCounts.promotions, 0, "baseline promotions");
// The survey-anchored invariant the owner CSV guard enforces: exactly 99
// records carry a bidet source id, and each field-verified bidet is backed by
// one. Establish it on the baseline before testing what the merge preserves.
assert.equal(preCounts.surveyHolders, 99, "baseline survey-anchored bidet records");

const preSurvivor = preCanonical.get(SURVIVOR);
const preDuplicate = preCanonical.get(DUPLICATE);
assert.equal(preSurvivor.bidet_presence, "Unknown");
assert.equal(preSurvivor.bidet_source_id, null);
assert.equal(preDuplicate.bidet_source_id, SURVEY_ID);
assert.equal(preDuplicate.record_status, "candidate");

// ---- Apply the merge -------------------------------------------------------
database.exec(mergeSql);

const postCanonical = snapshotCanonical(database);
const postProvenance = snapshotProvenance(database);
const survivor = postCanonical.get(SURVIVOR);
const duplicate = postCanonical.get(DUPLICATE);

// Check 1: exactly one ACTIVE canonical representation of the facility.
const activeFacility = [...postCanonical.values()].filter(
  (row) =>
    (row.canonical_id === SURVIVOR || row.canonical_id === DUPLICATE) &&
    row.record_status !== "rejected",
);
assert.equal(activeFacility.length, 1, "exactly one active canonical row");
// Check 2: the survivor is the retained id.
assert.equal(activeFacility[0].canonical_id, SURVIVOR, "retained canonical id");
// Check 3: address is the Bahay Pamahalaan address (retained).
assert.equal(survivor.address, "L. Rovira West Road, Dumaguete", "retained address");
assert.equal(survivor.name, "Bahay Pamahalaan ng Barangay Pulantubig", "retained name");
assert.equal(survivor.latitude, preSurvivor.latitude, "coordinate retained (lat)");
assert.equal(survivor.longitude, preSurvivor.longitude, "coordinate retained (lon)");
// Check 4: access is the duplicate's value.
assert.equal(survivor.access, "public", "merged access");
// Check 5: bidet is the duplicate's verified value; fee preserved (unknown).
assert.equal(survivor.bidet_presence, "Yes", "merged bidet presence");
assert.equal(survivor.fee, "unknown", "fee not overwritten");
// Check 6: field verification preserved, never downgraded.
assert.equal(survivor.bidet_verification, "field_verified", "field_verified kept");
assert.equal(
  survivor.restroom_verification, "field_verified_via_bidet_survey",
  "restroom field verification kept",
);
assert.equal(survivor.restroom_presence, "Yes", "restroom presence merged");
assert.equal(survivor.bidet_source_id, SURVEY_ID, "authoritative survey source kept");
assert.equal(survivor.source_count, 2, "survivor now carries two sources");

// The duplicate is marked (not deleted) and released from the unique index.
assert.equal(duplicate.record_status, "rejected", "duplicate rejected, row kept");
assert.equal(duplicate.bidet_source_id, null, "duplicate freed the unique slot");
// Verification follows its evidence: having handed the survey to the survivor,
// the duplicate must no longer claim a field verification it cannot back up.
assert.equal(
  duplicate.bidet_verification, "unknown",
  "duplicate released the bidet verification claim with the survey",
);
assert.equal(
  duplicate.restroom_verification, "candidate_unverified",
  "duplicate released the survey-derived restroom verification claim",
);
// Facts a rejection must not disturb: identity, location and observed presence.
assert.equal(duplicate.name, preDuplicate.name, "rejected row keeps its audited name");
assert.equal(duplicate.address, preDuplicate.address, "rejected row keeps its audited address");
assert.equal(duplicate.latitude, preDuplicate.latitude, "rejected row keeps its coordinate");
assert.equal(duplicate.longitude, preDuplicate.longitude, "rejected row keeps its coordinate");
assert.equal(duplicate.restroom_presence, preDuplicate.restroom_presence,
  "rejected row keeps its observed presence");
assert.equal(duplicate.bidet_presence, preDuplicate.bidet_presence,
  "rejected row keeps its observed bidet presence");
assert.equal(duplicate.access, preDuplicate.access, "rejected row keeps its access");
assert.equal(duplicate.fee, preDuplicate.fee, "rejected row keeps its fee");
assert.equal(duplicate.created_at, preDuplicate.created_at, "created_at never rewritten");

// Only one row may hold the survey id (unique index integrity).
const surveyHolders = [...postCanonical.values()].filter(
  (row) => row.bidet_source_id === SURVEY_ID,
);
assert.equal(surveyHolders.length, 1, "survey id held by exactly one row");

// Check 7: useful provenance preserved under the survivor, with lineage.
const survivorProv = [...postProvenance.values()].filter(
  (row) => row.canonical_id === SURVIVOR,
);
assert.equal(survivorProv.length, 2, "survivor keeps OSM + survey provenance");
const movedSurvey = postProvenance.get(`${SURVIVOR}|${SURVEY_ID}`);
assert.ok(movedSurvey, "survey provenance reassociated to survivor");
assert.equal(movedSurvey.original_name, "Pulantubig Barangay Hall",
  "merged record's original identity preserved in provenance");
assert.equal(movedSurvey.original_address, preDuplicate.address,
  "merged record's original address preserved");

// Check 8: no duplicate provenance pairs.
const pairCount = new Map();
for (const row of postProvenance.values()) {
  const key = `${row.canonical_id}|${row.source_link_id}`;
  pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
}
for (const [key, count] of pairCount) {
  assert.ok(count === 1, `duplicate provenance pair ${key}`);
}
assert.equal(postProvenance.size, preCounts.provenance,
  "provenance total unchanged (moved, not deleted)");

// Check 9: no orphan provenance (FK enforced + explicit query).
const orphans = database
  .prepare(
    `SELECT count(*) c FROM location_provenance p
     WHERE NOT EXISTS (SELECT 1 FROM canonical_locations c WHERE c.canonical_id = p.canonical_id)`,
  )
  .get().c;
assert.equal(orphans, 0, "no orphan provenance");

// Check 10: every UNRELATED canonical row is byte-identical.
for (const [id, row] of postCanonical) {
  if (id === SURVIVOR || id === DUPLICATE) continue;
  equal(row, preCanonical.get(id), `unrelated canonical row ${id} changed`);
}
assert.equal(postCanonical.size, preCounts.canonical, "canonical total unchanged");

// Check 11 + 14: unrelated contributions unchanged; none auto-decided.
const postContributions = contributionSnapshot(database);
equal(postContributions, preContributions, "contributions untouched");
for (const row of postContributions) {
  assert.equal(row.status, "pending", "contribution status not auto-changed");
}

// Check 12: contributions that targeted the duplicate stay FK-valid/auditable.
const fkCheck = database
  .prepare(
    `SELECT count(*) c FROM contributions co
     WHERE co.target_canonical_id = ?
       AND EXISTS (SELECT 1 FROM canonical_locations cl WHERE cl.canonical_id = co.target_canonical_id)`,
  )
  .get(DUPLICATE).c;
assert.ok(fkCheck >= 1, "contribution targeting the duplicate still resolves");

// Check 13: no fabricated canonical_promotions rows.
assert.equal(
  database.prepare("SELECT count(*) c FROM canonical_promotions").get().c, 0,
  "no promotion ledger rows created",
);

// Check 15: legacy table untouched.
assert.equal(
  database.prepare("SELECT count(*) c FROM restroom_locations").get().c, 1112,
  "legacy rows untouched",
);

// Verified-bidet population invariants. The merge moves ONE field survey from
// the duplicate to the survivor, so the survey-anchored population is EXACTLY
// conserved: 99 records hold a bidet source id and 99 claim a field-verified
// bidet, before and after. Nothing is added, lost, or duplicated, and the
// verification↔evidence coupling stays intact in both directions (no row claims
// field_verified without a survey, no survey-backed row loses its claim).
const postSurveyHolders = database
  .prepare("SELECT count(*) c FROM canonical_locations WHERE bidet_source_id IS NOT NULL")
  .get().c;
assert.equal(postSurveyHolders, 99, "survey-anchored bidet count unchanged at 99");
const postFieldVerified = database
  .prepare("SELECT count(*) c FROM canonical_locations WHERE bidet_verification = 'field_verified'")
  .get().c;
assert.equal(postFieldVerified, 99, "field-verified bidet count unchanged at 99");
assert.equal(postFieldVerified, preCounts.bidetFieldVerified,
  "field-verified bidet population conserved");
// Every field-verified bidet is still backed by a survey source id (no
// verification without evidence was introduced).
assert.equal(
  database
    .prepare(
      `SELECT count(*) c FROM canonical_locations
       WHERE bidet_verification = 'field_verified'
         AND bidet_source_id IS NULL`,
    )
    .get().c,
  0,
  "no field-verified bidet lacks its survey source",
);
// And the reverse direction: no survey-backed row lost its field claim.
assert.equal(
  database
    .prepare(
      `SELECT count(*) c FROM canonical_locations
       WHERE bidet_source_id IS NOT NULL
         AND bidet_verification <> 'field_verified'`,
    )
    .get().c,
  0,
  "no survey-backed bidet lost its field verification",
);

// ---- Idempotence / replay --------------------------------------------------
const replayBefore = {
  survivor: postCanonical.get(SURVIVOR),
  duplicate: postCanonical.get(DUPLICATE),
  provenance: [...postProvenance.keys()].sort(),
  canonicalCount: postCanonical.size,
};
database.exec(mergeSql); // replay the merge a second time
const replay = snapshotCanonical(database);
equal(replay.get(SURVIVOR).bidet_source_id, SURVEY_ID, "replay keeps survey id on survivor");
equal(replay.get(DUPLICATE).record_status, "rejected", "replay keeps duplicate rejected");
// A replay must converge, not drift: every data column on both affected rows is
// identical to the first apply (only updated_at may advance, being re-stamped).
equal(stripTs(replay.get(SURVIVOR)), stripTs(replayBefore.survivor),
  "replay leaves the survivor's data unchanged");
equal(stripTs(replay.get(DUPLICATE)), stripTs(replayBefore.duplicate),
  "replay leaves the duplicate's data unchanged");
const replayProv = [...snapshotProvenance(database).keys()].sort();
equal(replayProv, replayBefore.provenance, "replay does not duplicate provenance");
assert.equal(
  database.prepare("SELECT count(*) c FROM canonical_locations").get().c,
  replayBefore.canonicalCount,
  "replay changes no row count",
);

// ---- Rollback restores the exact pre-merge snapshot ------------------------
// (Timestamps are created at migration-apply time in this throwaway harness, so
// the two merge-affected rows are compared on every column EXCEPT updated_at;
// the rollback's hardcoded updated_at restore is asserted separately below.)
database.exec(rollbackSql);
const rbCanonical = snapshotCanonical(database);
const rbProvenance = snapshotProvenance(database);
equal(stripTs(rbCanonical.get(SURVIVOR)), stripTs(preSurvivor),
  "rollback restores survivor exactly (ex updated_at)");
equal(stripTs(rbCanonical.get(DUPLICATE)), stripTs(preDuplicate),
  "rollback restores duplicate exactly (ex updated_at)");
// The rollback stamps the known-good production pre-merge instant.
assert.equal(rbCanonical.get(SURVIVOR).updated_at, "2026-09-22T16:48:11.465Z",
  "rollback restores the recorded pre-merge updated_at (survivor)");
assert.equal(rbCanonical.get(DUPLICATE).updated_at, "2026-09-22T16:48:11.465Z",
  "rollback restores the recorded pre-merge updated_at (duplicate)");

// Provenance fully back on the duplicate, survivor back to OSM-only.
assert.ok(rbProvenance.get(`${DUPLICATE}|${SURVEY_ID}`),
  "rollback moves survey provenance back to duplicate");
assert.ok(!rbProvenance.get(`${SURVIVOR}|${SURVEY_ID}`),
  "rollback removes survey provenance from survivor");
assert.equal(rbProvenance.size, preCounts.provenance, "rollback provenance count restored");

// After rollback the whole canonical table equals the pre-merge baseline on all
// non-timestamp columns for both rows, and unrelated rows were never touched.
for (const [id, row] of rbCanonical) {
  if (id === SURVIVOR || id === DUPLICATE) continue;
  equal(row, preCanonical.get(id), `rollback changed unrelated row ${id}`);
}
// Contributions and the promotion ledger survived the round trip untouched.
equal(contributionSnapshot(database), preContributions, "contributions intact after rollback");
assert.equal(
  database.prepare("SELECT count(*) c FROM canonical_promotions").get().c, 0,
  "still no promotion ledger rows after rollback",
);

database.close();
console.log("STAGE14K_RECONCILIATION_TEST_SUCCESS");
