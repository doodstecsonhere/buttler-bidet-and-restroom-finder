// Buttler 2.0 — Stage 14D transactional canonical-promotion executor test.
//
// Harness parity with Stage 13/14C (contract §17): the real committed
// migrations 0001–0007 (including the promotion ledger) are applied to a
// throwaway in-memory SQLite — the D1 engine — seeded with the real local
// dataset (777 canonical / 847 provenance / 1,112 legacy). It NEVER touches a
// bound database, a Cloudflare account, or any secret. Every contribution and
// canonical mutation here is a disposable local test record.
//
// Proven below (mission Phases 11–17): the eight-value NULL-safe
// compare-and-swap (drift on any of the seven writable fields OR updated_at
// => stale_snapshot, never a force), the UNIQUE(contribution_id) replay gate,
// the frozen §8/§11/§12/§13 policy matrix at execution time, the two-phase
// crash window with honest read-only reconciliation, the trust boundary (no
// smuggled column/value/target/contributor reaches SQL), the 0006 schema
// contract, and the architecture guards (no HTTP, no env, no provenance).
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage14d-promotion-executor.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  executeCanonicalPromotion,
  planAndExecuteCanonicalPromotion,
  reconcileCanonicalPromotions,
} from "../functions/_lib/canonical-promotion.ts";
import { planCanonicalPromotion } from "../lib/contributions/promotion-planner.ts";
import { WRITABLE_CANONICAL_COLUMNS } from "../lib/contributions/apply.ts";
import {
  createContribution,
  decideContribution,
} from "../functions/_lib/contributions-store.ts";

const PROMOTER = "auth0|promoter-test";

// ---------------------------------------------------------------------------
// Database: every committed migration through 0006 (fresh throwaway only)
// ---------------------------------------------------------------------------
const migrationsDir = new URL("../d1/migrations/", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON;");
for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
}

// D1-shaped adapter (prepare/bind/run/first/all + batch with D1's documented
// transaction semantics). Optional fault hooks inject phase failures so the
// crash window is executed, not theorised.
function makeD1(db, faults = {}) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let bound = [];
      const api = {
        bind(...values) {
          bound = values;
          return api;
        },
        async run() {
          if (faults.failCanonicalUpdate && /^\s*UPDATE canonical_locations/.test(sql)) {
            throw new Error("injected canonical UPDATE failure");
          }
          const info = stmt.run(...bound);
          return { results: [], meta: { changes: info.changes } };
        },
        async first(column) {
          const row = stmt.get(...bound);
          if (!row) return null;
          return column ? row[column] : row;
        },
        async all() {
          return { results: stmt.all(...bound) };
        },
        __sql: sql,
      };
      return api;
    },
    async batch(statements) {
      if (faults.failBatchOnce) {
        faults.failBatchOnce = false;
        throw new Error("injected phase-2 batch failure (simulated crash)");
      }
      db.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) {
          if (faults.failEventInsert && /contribution_events/.test(statement.__sql)) {
            throw new Error("injected event INSERT failure");
          }
          out.push(await statement.run());
        }
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
const db = makeD1(sqlite);

// ---------------------------------------------------------------------------
// Baselines and fixtures
// ---------------------------------------------------------------------------
const count = (sql, ...args) =>
  (args.length ? sqlite.prepare(sql).get(...args) : sqlite.prepare(sql).get()).c;

const baselineCanonical = count("SELECT count(*) AS c FROM canonical_locations");
const baselineProvenance = count("SELECT count(*) AS c FROM location_provenance");
const baselineLegacy = count("SELECT count(*) AS c FROM restroom_locations");
assert.equal(baselineCanonical, 777);
assert.equal(baselineProvenance, 847);
assert.equal(baselineLegacy, 1112);

const canonicalBaseline = new Map(
  sqlite
    .prepare("SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude FROM canonical_locations")
    .all()
    .map((row) => [row.canonical_id, row]),
);
const provenanceBaseline = JSON.stringify(
  sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all(),
);
// Stage 14M: the seeded rejected-lineage row, captured before any test runs,
// so the suite can prove the promotion path never touches it.
const pulantubigBaselineRow = JSON.stringify(
  sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get("buttler_loc_a962aa157dff936ae36a"),
);
const legacyBaseline = JSON.stringify(
  sqlite.prepare("SELECT * FROM restroom_locations ORDER BY rowid").all(),
);

// Canonical rows our tests are allowed to differ from baseline at the end.
const touchedIds = new Set();
// Stage 14M: the disposable row deliberately retired to rejected lineage.
let rejectedTargetId = null;
let rejectedContributionId = null;
let sectionContribs = 0;
// The deliberately crashed promotion (section 10), captured for the final
// integrity report (section 14).
let crashOrphanId = null;
// Refused-but-value-already-present contributions the read-only detector
// cannot distinguish from orphans by design (see §Phase 10 limitations).
const coincidentalOrphanIds = new Set();

function unsurveyedTargets(n, { excludeRejected = false } = {}) {
  // Stage 14M: the guard retires a row from the ACTIVE dataset, so a suite that
  // needs promotable targets must not silently pick one up. The seed itself
  // stays active until the 14M section retires its own disposable row.
  const rows = sqlite
    .prepare(
      `SELECT canonical_id AS id FROM canonical_locations WHERE bidet_source_id IS NULL ` +
      `${excludeRejected ? "AND record_status <> 'rejected' " : ""}ORDER BY canonical_id LIMIT ?`,
    )
    .all(n)
    .map((r) => r.id);
  assert.ok(rows.length >= n, `need ${n} unsurveyed canonical rows`);
  return rows;
}

const STAMP = "2026-01-01T00:00:00.000Z";

// Put one disposable target into a fully known state (coords untouched so
// real neighbourhood geometry stays honest for the proximity guard).
function prepTarget(id) {
  touchedIds.add(id);
  sqlite
    .prepare(
      `UPDATE canonical_locations SET access='unknown', fee='unknown', bidet_presence='Unknown', ` +
      `name='Prepared Test Place', address='Prepared Test Address', updated_at = ? WHERE canonical_id = ?`,
    )
    .run(STAMP, id);
}

function getCanonical(id) {
  return sqlite
    .prepare(
      `SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude, bidet_source_id ` +
      `FROM canonical_locations WHERE canonical_id = ?`,
    )
    .get(id);
}

let contribCounter = 0;
function nextContributionId() {
  contribCounter += 1;
  return `contrib_${contribCounter.toString(16).padStart(32, "0")}`;
}

// Insert a stored contribution directly (disposable test data). Used where a
// test needs a shape the submit-time validator would refuse — a legacy row
// predating a rule — which is exactly what the executor must re-validate.
function insertContribution({
  kind,
  target,
  payload,
  evidence = null,
  status = "approved",
  contributor = "auth0|contributor-test",
}) {
  const id = nextContributionId();
  const decidedAt = ["approved", "rejected", "withdrawn", "superseded"].includes(status)
    ? "2026-09-30T00:00:00.000Z"
    : null;
  sqlite
    .prepare(
      `INSERT INTO contributions (contribution_id, kind, target_canonical_id, contributor_user_id, status, validation_status, payload_json, evidence_json, decided_at)` +
      ` VALUES (?, ?, ?, ?, ?, 'passed', ?, ?, ?)`,
    )
    .run(id, kind, target, contributor, status, JSON.stringify(payload), evidence === null ? null : JSON.stringify(evidence), decidedAt);
  return id;
}

// Build a real Stage 14C plan for a stored contribution against current DB
// state — exactly what planAndExecuteCanonicalPromotion does internally.
function buildPlan(contributionId) {
  const row = sqlite.prepare("SELECT * FROM contributions WHERE contribution_id = ?").get(contributionId);
  const target = getCanonical(row.target_canonical_id);
  const payload = JSON.parse(row.payload_json);
  let nearby = null;
  if ("latitude" in payload && "longitude" in payload) {
    nearby = sqlite
      .prepare(
        `SELECT canonical_id, latitude, longitude FROM canonical_locations ` +
        `WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? AND canonical_id <> ? LIMIT 500`,
      )
      .all(payload.latitude - 0.0013, payload.latitude + 0.0013, payload.longitude - 0.0013, payload.longitude + 0.0013, target.canonical_id);
  }
  const result = planCanonicalPromotion({
    contribution: {
      contribution_id: row.contribution_id,
      kind: row.kind,
      status: row.status,
      target_canonical_id: row.target_canonical_id,
      contributor_user_id: row.contributor_user_id,
      payload_json: row.payload_json,
      evidence_json: row.evidence_json,
    },
    target,
    nearbyLocations: nearby,
  });
  assert.equal(result.ok, true, `fixture plan should be valid: ${result.ok ? "" : result.error.code}`);
  return result.plan;
}

function failWith(result) {
  assert.equal(result.ok, false, "expected a structured refusal");
  return result;
}

const ledgerCount = () => count("SELECT count(*) AS c FROM canonical_promotions");
const ledgerFor = (contributionId) =>
  sqlite.prepare("SELECT * FROM canonical_promotions WHERE contribution_id = ?").get(contributionId);
const promotionEvents = (contributionId) =>
  sqlite
    .prepare(
      `SELECT * FROM contribution_events WHERE contribution_id = ? AND event_type = 'status_change' AND detail_json LIKE '%canonical_promoted%'`,
    )
    .all(contributionId);

const COORD_EVIDENCE = [{ type: "field_observation", detail: "verified the relocated entrance on site" }];

// ===========================================================================
// 1. Phase 12 — first promotion: canonical change + exactly one ledger row +
//    exactly one audit event, with the frozen ledger field contract.
// ===========================================================================
{
  const [target] = unsurveyedTargets(1);
  prepTarget(target);
  const before = getCanonical(target);
  const contributionId = insertContribution({ kind: "access_update", target, payload: { access: "public" } });
  const plan = buildPlan(contributionId);

  const result = await executeCanonicalPromotion(db, {
    contributionId,
    plan,
    promoterUserId: PROMOTER,
    promotionNote: "controlled local promotion",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.promotionId, /^promo_[0-9a-f]{32}$/);
  assert.deepEqual([...result.changedColumns], ["access"]);
  assert.ok(result.promotedAt.length > 0, "promotedAt comes from the ledger stamp");

  const after = getCanonical(target);
  assert.equal(after.access, "public", "writable column applied");
  assert.notEqual(after.updated_at, before.updated_at, "updated_at re-stamped");
  // Protected fields are never touched by promotion (§14).
  assert.equal(after.bidet_source_id, before.bidet_source_id);

  const ledger = ledgerFor(contributionId);
  assert.ok(ledger, "exactly one ledger row");
  assert.equal(ledger.status, "promoted");
  assert.equal(ledger.reversal_of, null);
  assert.equal(ledger.kind, "access_update");
  assert.equal(ledger.canonical_id, target);
  assert.equal(ledger.contributor_user_id, "auth0|contributor-test");
  assert.equal(ledger.promoter_user_id, PROMOTER);
  assert.equal(ledger.promotion_note, "controlled local promotion");
  assert.deepEqual(JSON.parse(ledger.changed_columns_json), ["access"]);
  assert.deepEqual(JSON.parse(ledger.resulting_values_json), { access: "public" });
  const snapshot = JSON.parse(ledger.base_snapshot_json);
  assert.deepEqual(Object.keys(snapshot).sort(), ["access", "address", "bidet_presence", "fee", "latitude", "longitude", "name", "updated_at"]);
  assert.equal(snapshot.access, "unknown", "base snapshot faithfully preserves the pre-update value");
  assert.equal(snapshot.updated_at, STAMP);
  // No protected field leaks into resulting_values_json (§: Phase 8).
  for (const key of Object.keys(JSON.parse(ledger.resulting_values_json))) {
    assert.ok(WRITABLE_CANONICAL_COLUMNS.includes(key));
  }

  // Audit event inside the EXISTING 0005 event-type domain (§6/§9: no new
  // event type, no contribution status invented).
  const events = promotionEvents(contributionId);
  assert.equal(events.length, 1, "exactly one promotion audit event");
  assert.equal(events[0].from_status, "approved");
  assert.equal(events[0].to_status, "approved");
  assert.equal(events[0].actor_type, "moderator");
  assert.equal(events[0].actor_id, PROMOTER);
  const detail = JSON.parse(events[0].detail_json);
  assert.equal(detail.action, "canonical_promoted");
  assert.equal(detail.promotion_id, result.promotionId);
  assert.equal(detail.canonical_id, target);
  assert.deepEqual(detail.changed_columns, ["access"]);

  // Contribution row immutability (§3.1): promotion never rewrites the claim.
  const stored = sqlite.prepare("SELECT * FROM contributions WHERE contribution_id = ?").get(contributionId);
  assert.equal(stored.status, "approved", "status unchanged by promotion");
  assert.equal(stored.decided_at, "2026-09-30T00:00:00.000Z");

  // 2. Replay: second identical attempt => already_promoted, zero effects.
  const canonicalAfterFirst = getCanonical(target);
  const ledgerBefore = ledgerCount();
  const eventsBefore = promotionEvents(contributionId).length;
  const replay = await executeCanonicalPromotion(db, {
    contributionId,
    plan,
    promoterUserId: PROMOTER,
  });
  assert.equal(failWith(replay).reason, "already_promoted");
  assert.deepEqual(getCanonical(target), canonicalAfterFirst, "replay performs no second canonical mutation");
  assert.equal(ledgerCount(), ledgerBefore, "replay creates no second ledger row");
  assert.equal(promotionEvents(contributionId).length, eventsBefore, "replay creates no second audit event");
}

// ===========================================================================
// 3. Phase 11 — concurrency matrix: drift on any of the eight CAS values =>
//    stale_snapshot with a machine-readable drift report; unchanged snapshot
//    succeeds; NULL-safe both ways.
// ===========================================================================
{
  const pool = unsurveyedTargets(14);

  // A. unchanged snapshot succeeds.
  const [a, b, c, d, e, f, g, h, i, j, k, l, m, n] = pool;
  const successCases = [
    [a, {}], // unchanged
    [l, {}], // identical NULL values (address set NULL on both sides)
  ];
  for (const [id] of successCases) prepTarget(id);
  // L: NULL address on BOTH snapshot and row — `IS` semantics must not see drift.
  sqlite.prepare("UPDATE canonical_locations SET address = NULL WHERE canonical_id = ?").run(l);

  // Drift cases: mutate exactly one CAS value after the plan's snapshot was
  // taken. `setup` (optional) runs BEFORE the plan is built; `mutate` runs
  // AFTER it, so the snapshot and the live row deliberately diverge.
  const mutations = [
    [b, (id) => sqlite.prepare("UPDATE canonical_locations SET updated_at = '2027-01-01T00:00:00.000Z' WHERE canonical_id = ?").run(id), "updated_at"],
    [c, (id) => sqlite.prepare("UPDATE canonical_locations SET access = 'restricted' WHERE canonical_id = ?").run(id), "access"],
    [d, (id) => sqlite.prepare("UPDATE canonical_locations SET fee = 'yes' WHERE canonical_id = ?").run(id), "fee"],
    [e, (id) => sqlite.prepare("UPDATE canonical_locations SET bidet_presence = 'Yes' WHERE canonical_id = ?").run(id), "bidet_presence"],
    [f, (id) => sqlite.prepare("UPDATE canonical_locations SET name = 'Renamed By Another Writer' WHERE canonical_id = ?").run(id), "name"],
    [g, (id) => sqlite.prepare("UPDATE canonical_locations SET address = 'Elsewhere 123' WHERE canonical_id = ?").run(id), "address"],
    [h, (id) => sqlite.prepare("UPDATE canonical_locations SET latitude = latitude + 0.001 WHERE canonical_id = ?").run(id), "latitude"],
    [i, (id) => sqlite.prepare("UPDATE canonical_locations SET longitude = longitude + 0.001 WHERE canonical_id = ?").run(id), "longitude"],
    // J. NULL -> value drift (address is NULL in the snapshot itself).
    [j,
      (id) => sqlite.prepare("UPDATE canonical_locations SET address = 'Filled In Later' WHERE canonical_id = ?").run(id),
      "address",
      (id) => sqlite.prepare("UPDATE canonical_locations SET address = NULL WHERE canonical_id = ?").run(id)],
    // K. value -> NULL drift.
    [k, (id) => sqlite.prepare("UPDATE canonical_locations SET address = NULL WHERE canonical_id = ?").run(id), "address"],
  ];
  for (const [id] of mutations) prepTarget(id);

  async function expectStale(id, expectedColumn, setup) {
    if (setup) setup(id);
    const contributionId = insertContribution({ kind: "access_update", target: id, payload: { access: "public" } });
    const plan = buildPlan(contributionId);
    const mutate = mutations.find((entry) => entry[0] === id);
    mutate[1](id);
    const result = failWith(await executeCanonicalPromotion(db, { contributionId, plan, promoterUserId: PROMOTER }));
    assert.equal(result.reason, "stale_snapshot", `${expectedColumn} drift must block promotion`);
    assert.ok(Array.isArray(result.details.drift), "drift report is machine-readable");
    assert.deepEqual(result.details.drift.map((d) => d.column), [expectedColumn]);
    assert.equal(ledgerFor(contributionId), undefined, "a refused promotion writes no ledger row");
    // The executor must never force: canonical keeps the newer value.
    const fresh = getCanonical(id);
    if (expectedColumn === "access") assert.equal(fresh.access, "restricted");
  }
  for (const [id, , column, setup] of mutations) await expectStale(id, column, setup);

  // A + L positives.
  for (const id of [a, l]) {
    const contributionId = insertContribution({ kind: "access_update", target: id, payload: { access: "public" } });
    const plan = buildPlan(contributionId);
    const result = await executeCanonicalPromotion(db, { contributionId, plan, promoterUserId: PROMOTER });
    assert.equal(result.ok, true, `unchanged snapshot (NULL-safe) should promote: ${JSON.stringify(result)}`);
  }

  // NULL-safe proof against naive `=`: identical NULL address must NOT be
  // drift (an `=` comparison would answer NULL IS NOT NULL = unknown/false).
  {
    prepTarget(n);
    const contributionId = insertContribution({ kind: "access_update", target: n, payload: { access: "public" } });
    sqlite.prepare("UPDATE canonical_locations SET address = NULL WHERE canonical_id = ?").run(n);
    const plan = buildPlan(contributionId);
    assert.equal(plan.base_snapshot.address, null, "fixture snapshot carries a real NULL");
    const result = await executeCanonicalPromotion(db, { contributionId, plan, promoterUserId: PROMOTER });
    assert.equal(result.ok, true, "NULL === NULL is not drift");
    // And the guarded UPDATE itself matched: the row moved.
    assert.equal(getCanonical(n).access, "public");
  }
}

// ===========================================================================
// 4. Phase 12 — racing attempts: the UNIQUE(contribution_id) gate + CAS mean
//    exactly one winner; the loser can never double-apply.
// ===========================================================================
{
  // A dedicated never-used row: a shared target would let this successful
  // promotion overwrite an earlier refused case's payload value and confuse
  // the final orphan report with a legitimate-looking coincidence.
  const id = unsurveyedTargets(17)[16];
  prepTarget(id);
  const contributionId = insertContribution({ kind: "access_update", target: id, payload: { access: "public" } });
  const plan = buildPlan(contributionId);
  const attempt = () => executeCanonicalPromotion(db, { contributionId, plan, promoterUserId: PROMOTER });
  const [r1, r2] = await Promise.all([attempt(), attempt()]);
  const oks = [r1, r2].filter((r) => r.ok);
  assert.equal(oks.length, 1, "exactly one concurrent attempt succeeds");
  const loser = [r1, r2].find((r) => !r.ok);
  assert.ok(["stale_snapshot", "already_promoted", "phase2_failed"].includes(loser.reason), `loser surfaced ${loser.reason}`);
  assert.equal(ledgerCount() && count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", contributionId), 1, "exactly one ledger row");
  assert.equal(promotionEvents(contributionId).length, 1, "exactly one audit event");
  assert.equal(getCanonical(id).access, "public", "the write happened once");
}

// ===========================================================================
// 5. Phase 13 — bidet policy matrix (§8), incl. the real DB CHECK.
// ===========================================================================
{
  // Unknown -> Yes permitted (unsurveyed) and verification never changes.
  const [target] = unsurveyedTargets(6).slice(5);
  prepTarget(target);
  const before = getCanonical(target);
  const contributionId = insertContribution({ kind: "bidet_report", target, payload: { bidet_presence: "Yes" } });
  const ok = await planAndExecuteCanonicalPromotion(db, { contributionId, promoterUserId: PROMOTER });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const after = getCanonical(target);
  assert.equal(after.bidet_presence, "Yes");
  assert.equal(after.bidet_verification, before.bidet_verification, "presence-only promotion (§8)");

  // Yes -> Unknown (unsurveyed) rejected.
  const t2 = unsurveyedTargets(8)[7];
  prepTarget(t2);
  sqlite.prepare("UPDATE canonical_locations SET bidet_presence='Yes' WHERE canonical_id = ?").run(t2);
  const c2 = insertContribution({ kind: "bidet_report", target: t2, payload: { bidet_presence: "Unknown" } });
  const r2 = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c2, promoterUserId: PROMOTER }));
  assert.equal(r2.reason, "bidet_downgrade_forbidden");

  // Yes -> Unknown on a SURVEYED row (bidet_source_id non-null) rejected with
  // the explanatory conflict, and the DB CHECK independently refuses.
  const surveyed = sqlite.prepare("SELECT canonical_id AS id FROM canonical_locations WHERE bidet_source_id IS NOT NULL LIMIT 1").get();
  assert.ok(surveyed, "fixture needs one surveyed row (99 exist locally)");
  touchedIds.add(surveyed.id);
  const c3 = insertContribution({ kind: "bidet_report", target: surveyed.id, payload: { bidet_presence: "Unknown" } });
  const r3 = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c3, promoterUserId: PROMOTER }));
  assert.equal(r3.reason, "bidet_survey_conflict");
  let checkCrashed = false;
  try {
    sqlite.prepare("UPDATE canonical_locations SET bidet_presence='Unknown' WHERE canonical_id = ?").run(surveyed.id);
  } catch {
    checkCrashed = true;
  }
  assert.ok(checkCrashed, "the canonical CHECK forbids surveyed downgrades structurally (§8)");

  // Yes -> Yes and Unknown -> Unknown are redundant no-ops, never written.
  const t4 = unsurveyedTargets(10)[9];
  prepTarget(t4);
  const c4 = insertContribution({ kind: "bidet_report", target: t4, payload: { bidet_presence: "Unknown" } });
  const r4 = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c4, promoterUserId: PROMOTER }));
  assert.equal(r4.details.planner_code, "redundant_noop", "Unknown->Unknown is a refused no-op");
  // Honest limitation (documented in the report): a refused no-op's payload
  // ALWAYS equals current canonical, so the read-only detector must classify
  // it as an ambiguity — value present, no ledger row. Owner inspection,
  // not automation, tells this apart from a crash orphan.
  coincidentalOrphanIds.add(c4);
}

// ===========================================================================
// 6. Phase 13 — coordinate rules (§12): pair, bounds, evidence, proximity.
// ===========================================================================
{
  // Half pair rejected — even smuggled through a stored legacy payload.
  const [t1] = unsurveyedTargets(2);
  prepTarget(t1);
  const c1 = insertContribution({ kind: "info_correction", target: t1, payload: { latitude: 9.31 } });
  assert.equal(failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c1, promoterUserId: PROMOTER })).reason, "coordinates_partial");

  // Out of bounds rejected.
  const [t2] = unsurveyedTargets(4);
  prepTarget(t2);
  const c2 = insertContribution({ kind: "info_correction", target: t2, payload: { latitude: 10.5, longitude: 123.3 }, evidence: COORD_EVIDENCE });
  assert.equal(failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c2, promoterUserId: PROMOTER })).reason, "coordinate_out_of_bounds");

  // Coordinate pair without acceptable evidence rejected.
  const [t3] = unsurveyedTargets(6);
  prepTarget(t3);
  const cur = getCanonical(t3);
  const c3 = insertContribution({ kind: "info_correction", target: t3, payload: { latitude: cur.latitude + 0.0005, longitude: cur.longitude }, evidence: [{ type: "comment", detail: "trust me" }] });
  assert.equal(failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c3, promoterUserId: PROMOTER })).reason, "coordinate_evidence_required");

  // Valid pair, empty neighbourhood, evidence present => promotes. Pick the
  // most isolated unsurveyed row in the real dataset, then move it a few
  // metres — Dumaguete's dataset is dense, so an arbitrary target's eight
  // compass offsets are not reliably quiet.
  const lonK = Math.cos((9.31 * Math.PI) / 180);
  const isolated = sqlite
    .prepare(
      `SELECT c.canonical_id AS id, c.latitude AS lat, c.longitude AS lon,
              (SELECT min((other.latitude - c.latitude) * (other.latitude - c.latitude)
                        + (other.longitude - c.longitude) * (other.longitude - c.longitude) * ?)
                 FROM canonical_locations other
                WHERE other.canonical_id <> c.canonical_id) AS nearest_sq
         FROM canonical_locations c
        WHERE c.bidet_source_id IS NULL
        ORDER BY nearest_sq DESC LIMIT 1`,
    )
    .get(lonK * lonK);
  assert.ok(isolated && isolated.nearest_sq > 0.0004 * 0.0004, `fixture needs an isolated unsurveyed row (nearest: ${isolated && Math.sqrt(isolated.nearest_sq) * 111000} m)`);
  const t4 = isolated.id;
  prepTarget(t4);
  // Find an offset direction with no canonical row within ~0.0004 deg.
  let moved = null;
  for (const [dLat, dLon] of [[0.0005, 0], [0, 0.0005], [-0.0005, 0], [0, -0.0005], [0.0005, 0.0005], [-0.0005, -0.0005], [0.001, 0.001], [-0.001, 0.001]]) {
    const lat = isolated.lat + dLat;
    const lon = isolated.lon + dLon;
    if (lat < 9.05 || lat > 9.7 || lon < 123.05 || lon > 123.6) continue;
    const near = count(
      "SELECT count(*) AS c FROM canonical_locations WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? AND canonical_id <> ?",
      lat - 0.0004, lat + 0.0004, lon - 0.0004, lon + 0.0004, t4,
    );
    if (near === 0) {
      moved = { lat, lon };
      break;
    }
  }
  assert.ok(moved, "fixture needs at least one quiet spot in the service area");
  const c4 = insertContribution({ kind: "info_correction", target: t4, payload: { latitude: moved.lat, longitude: moved.lon }, evidence: COORD_EVIDENCE });
  const ok4 = await planAndExecuteCanonicalPromotion(db, { contributionId: c4, promoterUserId: PROMOTER });
  assert.equal(ok4.ok, true, JSON.stringify(ok4));
  const after4 = getCanonical(t4);
  assert.equal(after4.latitude, moved.lat);
  assert.equal(after4.longitude, moved.lon);

  // Proximity guard: a seeded neighbour ~12 m away makes the same move a
  // conflict — informative refusal, never an auto-merge (§12).
  const neighbourId = "buttler_loc_" + "f".repeat(20);
  sqlite
    .prepare(
      `INSERT INTO canonical_locations (canonical_id, name, latitude, longitude, address, restroom_presence, bidet_presence, access, fee, restroom_verification, bidet_verification, source_count, record_status)` +
      ` VALUES (?, 'Proximity Guard Neighbour', ?, ?, 'Nowhere Test Lane', 'Unknown', 'Unknown', 'unknown', 'unknown', 'candidate_unverified', 'unknown', 1, 'candidate')`,
    )
    .run(neighbourId, moved.lat + 0.0001, moved.lon);
  touchedIds.add(neighbourId);
  const [t5] = unsurveyedTargets(10);
  prepTarget(t5);
  // aim t5's new position right at the neighbour
  const c5 = insertContribution({ kind: "info_correction", target: t5, payload: { latitude: moved.lat + 0.0001, longitude: moved.lon }, evidence: COORD_EVIDENCE });
  const r5 = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c5, promoterUserId: PROMOTER }));
  assert.equal(r5.reason, "proximity_conflict");
  assert.ok(r5.details.nearby_canonical_ids.includes(neighbourId), "conflict names the neighbour");
  assert.equal(ledgerFor(c5), undefined, "a proximity conflict writes nothing");
  // Executor-time re-check too: a hand-built plan (empty nearby at plan time)
  // is still refused by the execution-time guard.
  const t5row = getCanonical(t5);
  const plan5 = {
    canonical_id: t5,
    contribution_id: c5,
    kind: "info_correction",
    contributor_user_id: "auth0|contributor-test",
    base_snapshot: {
      updated_at: t5row.updated_at,
      access: t5row.access,
      fee: t5row.fee,
      bidet_presence: t5row.bidet_presence,
      name: t5row.name,
      address: t5row.address,
      latitude: t5row.latitude,
      longitude: t5row.longitude,
    },
    changed_columns: ["latitude", "longitude"],
    resulting_values: { latitude: moved.lat + 0.0001, longitude: moved.lon },
    evidence: COORD_EVIDENCE,
    policy: { coordinate_change: true, coordinate_evidence_required: true, proximity_threshold_meters: 30, presence_only_bidet: true, verification_columns_writable: false },
  };
  const r5b = failWith(await executeCanonicalPromotion(db, { contributionId: c5, plan: plan5, promoterUserId: PROMOTER }));
  assert.equal(r5b.reason, "proximity_conflict", "the guard re-runs against fresh DB neighbours");
}

// ===========================================================================
// 7. Phase 13 — blank address (§11) and kind policy (§10/§13).
// ===========================================================================
{
  const [t1] = unsurveyedTargets(3);
  prepTarget(t1);
  for (const blank of ["", "   ", "\t\n "]) {
    const c = insertContribution({ kind: "info_correction", target: t1, payload: { address: blank } });
    const r = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c, promoterUserId: PROMOTER }));
    assert.equal(r.reason, "address_blank");
  }

  // Manual-import / signal kinds never reach the executor.
  const newLoc = insertContribution({ kind: "new_location", target: null, payload: { name: "Some New Place", latitude: 9.31, longitude: 123.31 } });
  assert.equal(failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: newLoc, promoterUserId: PROMOTER })).reason, "manual_import_only");
  const canonicalRowsBefore = count("SELECT count(*) AS c FROM canonical_locations");
  for (const kind of ["problem_report", "closure_report", "reverification"]) {
    const [t] = unsurveyedTargets(5);
    const c = insertContribution({ kind, target: t, payload: kind === "problem_report" ? { issue: true } : kind === "closure_report" ? { closed: true } : { observed: true } });
    const r = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c, promoterUserId: PROMOTER }));
    assert.equal(r.reason, "kind_not_promotable", `${kind} stays a signal`);
  }
  assert.equal(count("SELECT count(*) AS c FROM canonical_locations"), canonicalRowsBefore, "no promotion path inserts canonical rows (§13)");
}

// ===========================================================================
// 8. Phase 2 — lifecycle gate: only an approved contribution is promotable;
//    a missing one is a structured not-found. Statuses are never invented.
// ===========================================================================
{
  for (const status of ["pending", "validated", "needs_review", "rejected", "withdrawn", "superseded"]) {
    const [t] = unsurveyedTargets(7);
    const c = insertContribution({
      kind: "access_update",
      target: t,
      payload: { access: "public" },
      status: status === "pending" || status === "validated" || status === "needs_review" ? status : status,
    });
    // fix decided_at CHECK: non-terminal statuses need decided_at NULL
    if (["pending", "validated", "needs_review"].includes(status)) {
      sqlite.prepare("UPDATE contributions SET decided_at = NULL WHERE contribution_id = ?").run(c);
    }
    const r = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: c, promoterUserId: PROMOTER }));
    assert.equal(r.reason, "not_approved", `${status} must not promote`);
    assert.equal(ledgerFor(c), undefined);
  }
  const missing = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: "contrib_" + "9".repeat(32), promoterUserId: PROMOTER }));
  assert.equal(missing.reason, "not_found");
  const malformed = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: "DROP TABLE contributions", promoterUserId: PROMOTER }));
  assert.equal(malformed.reason, "not_found", "malformed ids never reach SQL");
}

// ===========================================================================
// 9. Phases 3/16 — trust boundary: a crafted or smuggled plan is refused
//    before any SQL sees it; only stored payload values can be written.
// ===========================================================================
{
  const [t] = unsurveyedTargets(9);
  prepTarget(t);
  const contributionId = insertContribution({ kind: "access_update", target: t, payload: { access: "public" } });
  const good = buildPlan(contributionId);
  const snapshot = good.base_snapshot;
  const base = (overrides) => ({ ...good, ...overrides });
  const smuggles = [
    ["protected column", base({ changed_columns: ["record_status"], resulting_values: { record_status: "verified" } })],
    ["verification column", base({ changed_columns: ["bidet_verification"], resulting_values: { bidet_verification: "field_verified" } })],
    ["SQL-ish column name", base({ changed_columns: ["access; DROP TABLE contributions;--"], resulting_values: { "access; DROP TABLE contributions;--": "x" } })],
    ["extra resulting key", base({ resulting_values: { access: "public", bidet_presence: "Yes" } })],
    ["duplicate changed column", base({ changed_columns: ["access", "access"] })],
    ["wrong contributor", base({ contributor_user_id: "auth0|someone-else" })],
    ["wrong target", base({ canonical_id: "buttler_loc_" + "e".repeat(20) })],
    ["wrong kind", base({ kind: "fee_update" })],
    ["value not in payload", base({ resulting_values: { access: "restricted" } })],
    // A snapshot that omits a CAS key entirely is a shape violation. (A
    // present-but-wrong value is instead caught safely as drift below.)
    ["snapshot missing a key", base({ base_snapshot: (() => { const { address, ...rest } = snapshot; return rest; })() })],
    ["empty changes", base({ changed_columns: [], resulting_values: {} })],
    ["cross-contribution plan", { ...good, contribution_id: "contrib_" + "7".repeat(32) }],
  ];
  for (const [label, plan] of smuggles) {
    const r = failWith(await executeCanonicalPromotion(db, { contributionId, plan, promoterUserId: PROMOTER }));
    assert.ok(["invalid_plan", "canonical_target_not_found", "kind_not_promotable", "not_found"].includes(r.reason), `${label}: got ${r.reason}`);
  }
  // A present-but-fabricated snapshot value is NOT a shape violation, but it
  // must still never force-write: the fresh compare refuses it as drift.
  const fabricated = base({ base_snapshot: { ...snapshot, updated_at: "2020-01-01T00:00:00.000Z" } });
  const rf = failWith(await executeCanonicalPromotion(db, { contributionId, plan: fabricated, promoterUserId: PROMOTER }));
  assert.equal(rf.reason, "stale_snapshot", "a forged snapshot cannot bypass the CAS guard");
  assert.equal(getCanonical(t).access, "unknown", "every smuggle attempt wrote nothing");
  assert.equal(ledgerCount(), count("SELECT count(*) AS c FROM canonical_promotions"), "sanity: ledger count is stable");
  assert.ok(count("SELECT count(*) AS c FROM contributions") > 0, "contributions table survived (no injected SQL ran)");

  // Legacy stored payloads with protected keys (predating submit validation)
  // are refused too — submit-time validation is not trusted (§4 mandate).
  const [t2] = unsurveyedTargets(11);
  prepTarget(t2);
  const legacy = nextContributionId();
  sqlite
    .prepare(`INSERT INTO contributions (contribution_id, kind, target_canonical_id, contributor_user_id, status, validation_status, payload_json, decided_at) VALUES (?, 'access_update', ?, 'auth0|contributor-test', 'approved', 'passed', ?, ?)`)
    .run(legacy, t2, JSON.stringify({ access: "public", bidet_verification: "field_verified" }), "2026-09-30T00:00:00.000Z");
  const r = failWith(await planAndExecuteCanonicalPromotion(db, { contributionId: legacy, promoterUserId: PROMOTER }));
  assert.equal(r.reason, "invalid_plan");
  assert.equal(r.details.planner_code, "forbidden_field");
}

// ===========================================================================
// 9A. Stage 14M — rejected canonical targets can never be promoted. A
//     rejected row is retained lineage (the Stage 14K Pulantubig merge pattern),
//     not part of the ACTIVE canonical dataset, so the executor must refuse it
//     at the data-integrity boundary — explicitly, machine-readably, and
//     without writing anything.
// ===========================================================================
{
  const target = unsurveyedTargets(17)[16];
  rejectedTargetId = target;
  prepTarget(target);
  const untouchedBaseline = getCanonical(target);
  sqlite.prepare(`UPDATE canonical_locations SET record_status = 'rejected' WHERE canonical_id = ?`).run(target);
  const rejectedBefore = sqlite
    .prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?")
    .get(target);
  const ledgerBefore = ledgerCount();
  const eventsBefore = count("SELECT count(*) AS c FROM contribution_events");
  const contribsBefore = count("SELECT count(*) AS c FROM contributions");

  const contributionId = insertContribution({ kind: "access_update", target, payload: { access: "public" } });
  rejectedContributionId = contributionId;
  sectionContribs += 1;
  // A plan built from a row that no longer belongs to the active dataset. The
  // planner itself has no notion of record_status (planner policy is unchanged
  // in Stage 14M), which is exactly why the guard must sit in the executor.
  const plan = buildPlan(contributionId);

  // A rejected target is refused with its own reason, not silently treated as
  // a missing row.
  const refused = failWith(await executeCanonicalPromotion(db, {
    contributionId,
    plan,
    promoterUserId: PROMOTER,
  }));
  assert.equal(refused.reason, "canonical_target_rejected", "explicit machine-readable refusal");
  assert.equal(refused.details.canonical_id, target);
  assert.equal(refused.details.record_status, "rejected", "the stored status is reported back");

  // The authoritative entry point refuses it too, before any plan is built.
  const viaEntry = failWith(await planAndExecuteCanonicalPromotion(db, {
    contributionId,
    promoterUserId: PROMOTER,
  }));
  assert.equal(viaEntry.reason, "canonical_target_rejected");

  // Nothing was written anywhere: canonical, ledger, audit events.
  assert.deepEqual(getCanonical(target), untouchedBaseline, "rejected row values untouched");
  assert.equal(JSON.stringify(sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(target)), JSON.stringify(rejectedBefore), "not even record_status moved");
  assert.equal(ledgerFor(contributionId), undefined, "no ledger row for a refused rejected-target promotion");
  assert.equal(ledgerCount(), ledgerBefore, "the ledger gained nothing");
  assert.equal(promotionEvents(contributionId).length, 0, "no audit event for the refused promotion");
  assert.equal(count("SELECT count(*) AS c FROM contribution_events"), eventsBefore, "the event table is untouched");

  // A caller cannot steer the guard with its own copy of record_status. The
  // plan type carries no such field, so a forged one is dead weight; the
  // server-side stored row decides. (It never reaches SQL: the guarded UPDATE
  // is built from the frozen seven-column allow-list, and a plan that names
  // record_status as a changed column is refused as a smuggle — see section 9.)
  const forged = { ...plan, record_status: "verified" };
  assert.equal(failWith(await executeCanonicalPromotion(db, {
    contributionId,
    plan: forged,
    promoterUserId: PROMOTER,
  })).reason, "canonical_target_rejected", "a smuggled record_status is not trusted");
  assert.equal(
    failWith(await executeCanonicalPromotion(db, {
      contributionId,
      plan: { ...forged, changed_columns: ["record_status"], resulting_values: { record_status: "verified" } },
      promoterUserId: PROMOTER,
    })).reason,
    "invalid_plan",
    "record_status is not a writable canonical column",
  );

  // Re-tagging a rejected row as active in the plan changes nothing: the guard
  // re-reads `record_status` from the stored row on every attempt, so a caller
  // has no input through which to flip a retired record back into the active
  // dataset. (A plan whose target disagrees with the stored contribution is
  // refused as `invalid_plan` — the existing section-9 smuggle matrix covers
  // that path; nothing here needs to weaken it.)
  assert.equal(
    failWith(await executeCanonicalPromotion(db, {
      contributionId,
      plan: { ...plan, record_status: "candidate", base_snapshot: { ...plan.base_snapshot, access: "unknown" } },
      promoterUserId: PROMOTER,
    })).reason,
    "canonical_target_rejected",
    "the stored row, not the caller, decides activation",
  );
  // Smuggling a rejected id as somebody else's target cannot redirect a
  // promotion onto lineage: the stored contribution owns the target, so the
  // mismatch is refused before any read of the forged id matters.
  const [redirectTarget] = unsurveyedTargets(18, { excludeRejected: true });
  prepTarget(redirectTarget);
  const redirectContrib = insertContribution({ kind: "access_update", target: redirectTarget, payload: { access: "public" } });
  sectionContribs += 1;
  const redirected = failWith(await executeCanonicalPromotion(db, {
    contributionId: redirectContrib,
    plan: { ...buildPlan(redirectContrib), canonical_id: target },
    promoterUserId: PROMOTER,
  }));
  assert.equal(redirected.reason, "invalid_plan", "a plan cannot retarget onto a rejected row");
  assert.equal(getCanonical(redirectTarget).access, "unknown", "the redirection wrote nothing");
  assert.equal(ledgerFor(redirectContrib), undefined, "and left no ledger row");

  assert.equal(
    sqlite.prepare("SELECT record_status FROM canonical_locations WHERE canonical_id = ?").get(target).record_status,
    "rejected",
    "the rejected row is still rejected",
  );

  // Only the ACTIVE dataset is promotable: every other status in the schema
  // domain keeps working through the same harness.
  for (const status of ["candidate", "community-submitted", "verified", "disputed", "outdated"]) {
    const [t] = unsurveyedTargets(19, { excludeRejected: true });
    prepTarget(t);
    sqlite.prepare("UPDATE canonical_locations SET record_status = ? WHERE canonical_id = ?").run(status, t);
    const c = insertContribution({ kind: "access_update", target: t, payload: { access: "public" } });
    sectionContribs += 1;
    const res = await planAndExecuteCanonicalPromotion(db, { contributionId: c, promoterUserId: PROMOTER });
    assert.equal(res.ok, true, `${status} stays promotable: ${JSON.stringify(res)}`);
    assert.equal(getCanonical(t).access, "public");
    sqlite.prepare("UPDATE canonical_locations SET record_status = 'candidate' WHERE canonical_id = ?").run(t);
  }

  // The real retired record from the dataset — the Stage 14K Pulantubig
  // duplicate — is refused too. Read-only: nothing about it is written.
  const PULANTUBIG_DUPLICATE = "buttler_loc_a962aa157dff936ae36a";
  const pulantubigBefore = sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(PULANTUBIG_DUPLICATE);
  assert.equal(pulantubigBefore.record_status, "rejected", "fixture: the merged duplicate is rejected lineage");
  const pulantubigContrib = insertContribution({ kind: "access_update", target: PULANTUBIG_DUPLICATE, payload: { access: "restricted" } });
  sectionContribs += 1;
  const pulantubig = failWith(await planAndExecuteCanonicalPromotion(db, {
    contributionId: pulantubigContrib,
    promoterUserId: PROMOTER,
  }));
  assert.equal(pulantubig.reason, "canonical_target_rejected");
  assert.equal(pulantubig.details.canonical_id, PULANTUBIG_DUPLICATE);
  assert.deepEqual(sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(PULANTUBIG_DUPLICATE), pulantubigBefore, "the retired row was not modified");
  assert.equal(ledgerFor(pulantubigContrib), undefined, "no ledger row against the retired row");

  // The guard reads the STORED row, not the snapshot: an up-to-date plan with
  // no drift at all is still refused, and a stale one is refused for the
  // activation reason rather than drift.
  const currentRow = getCanonical(target);
  const freshSnapshotPlan = {
    ...plan,
    base_snapshot: {
      updated_at: currentRow.updated_at,
      access: currentRow.access,
      fee: currentRow.fee,
      bidet_presence: currentRow.bidet_presence,
      name: currentRow.name,
      address: currentRow.address,
      latitude: currentRow.latitude,
      longitude: currentRow.longitude,
    },
  };
  assert.equal(failWith(await executeCanonicalPromotion(db, {
    contributionId,
    plan: freshSnapshotPlan,
    promoterUserId: PROMOTER,
  })).reason, "canonical_target_rejected", "a perfectly matching plan still cannot promote lineage");
  const stalePlan = { ...plan, base_snapshot: { ...plan.base_snapshot, updated_at: "2020-01-01T00:00:00.000Z" } };
  assert.equal(failWith(await executeCanonicalPromotion(db, {
    contributionId,
    plan: stalePlan,
    promoterUserId: PROMOTER,
  })).reason, "canonical_target_rejected", "activation is checked before drift");

  // Existing gates keep their precedence and still write nothing.
  const replayContrib = insertContribution({ kind: "fee_update", target, payload: { fee: "yes" } });
  sectionContribs += 1;
  const replayPlan = buildPlan(replayContrib);
  const brokenLedgerDb = makeD1(sqlite, { failBatchOnce: true });
  assert.equal(failWith(await executeCanonicalPromotion(brokenLedgerDb, { contributionId: replayContrib, plan: replayPlan, promoterUserId: PROMOTER })).reason, "canonical_target_rejected", "refused before the replay gate matters");
  assert.equal(ledgerFor(replayContrib), undefined);

  assert.equal(count("SELECT count(*) AS c FROM contributions"), contribsBefore + sectionContribs, "this section only added its own disposable contributions");
  assert.equal(
    count("SELECT count(*) AS c FROM canonical_locations"),
    baselineCanonical + 1,
    "the guard inserts and deletes no canonical rows",
  );
}

// ===========================================================================
// 9B. Stage 14M — how the new guard interacts with the gates that already
//     exist. The active-target check is additive: it never weakens CAS drift,
//     never swallows the planner's own policy refusals, and never turns a
//     genuinely missing target into a "rejected" answer.
// ===========================================================================
{
  const rejected = rejectedTargetId;
  const contributionId = rejectedContributionId;

  // A missing canonical row is still "not found", and a retired one is still
  // "rejected" — the two reasons stay distinguishable. (The FK on
  // contributions.target_canonical_id forbids inventing a claim against an
  // absent row, so the absence case is probed straight through the executor.)
  const ghost = "buttler_loc_" + "d".repeat(20);
  const rejectedPlan = buildPlan(contributionId);
  assert.equal(sqlite.prepare("SELECT canonical_id FROM canonical_locations WHERE canonical_id = ?").get(ghost), undefined, "fixture: the ghost id is absent");
  const missingResult = failWith(await executeCanonicalPromotion(db, {
    contributionId,
    plan: { ...rejectedPlan, canonical_id: ghost },
    promoterUserId: PROMOTER,
  }));
  assert.ok(
    ["invalid_plan", "canonical_target_not_found"].includes(missingResult.reason),
    `an absent target cannot be reported as rejected lineage (got ${missingResult.reason})`,
  );
  assert.equal(
    failWith(await executeCanonicalPromotion(db, {
      contributionId,
      plan: { ...rejectedPlan, canonical_id: rejected },
      promoterUserId: PROMOTER,
    })).reason,
    "canonical_target_rejected",
    "the rejected id is resolved against the stored row",
  );

  // Guard-vs-policy precedence: with the rejected row in a bidet-eligible
  // state, the executor still refuses on activation rather than running the
  // §8 check against retired lineage. Nothing is written either way.
  sqlite.prepare(`UPDATE canonical_locations SET bidet_presence = 'Yes', updated_at = ? WHERE canonical_id = ?`).run(STAMP, rejected);
  const downgrade = insertContribution({ kind: "bidet_report", target: rejected, payload: { bidet_presence: "Unknown" } });
  const dgRefused = failWith(await planAndExecuteCanonicalPromotion(db, {
    contributionId: downgrade, promoterUserId: PROMOTER,
  }));
  assert.equal(dgRefused.reason, "canonical_target_rejected", "activation is checked before write policy");
  assert.equal(getCanonical(rejected).bidet_presence, "Yes", "the downgrading promotion wrote nothing");

  // Guard-vs-CAS precedence: a stale snapshot for a rejected row is refused on
  // activation, so drift reporting cannot be used to probe or push lineage back
  // into the active set.
  const current = getCanonical(rejected);
  const casDrift = insertContribution({ kind: "access_update", target: rejected, payload: { access: "restricted" } });
  const casDriftPlan = buildPlan(casDrift);
  const driftRefused = failWith(await executeCanonicalPromotion(db, {
    contributionId: casDrift,
    plan: { ...casDriftPlan, base_snapshot: { ...casDriftPlan.base_snapshot, updated_at: "1999-01-01T00:00:00.000Z" } },
    promoterUserId: PROMOTER,
  }));
  assert.equal(driftRefused.reason, "canonical_target_rejected", "rejected target never reaches the CAS UPDATE");
  assert.equal(getCanonical(rejected).access, current.access, "no CAS write against lineage");
  assert.equal(ledgerFor(casDrift), undefined);

  // The planner keeps its own policy refusals for active rows — the guard did
  // not move them or soften them.
  const [{ id: surveyedId }] = sqlite.prepare("SELECT canonical_id AS id FROM canonical_locations WHERE bidet_source_id IS NOT NULL ORDER BY canonical_id LIMIT 1").all();
  const surveyed = getCanonical(surveyedId);
  const downgradeSurveyed = insertContribution({ kind: "bidet_report", target: surveyedId, payload: { bidet_presence: "Unknown" } });
  const svRefused = failWith(await planAndExecuteCanonicalPromotion(db, {
    contributionId: downgradeSurveyed, promoterUserId: PROMOTER,
  }));
  assert.equal(svRefused.reason, "bidet_survey_conflict", "surveyed-row policy unchanged for an ACTIVE target");
  assert.deepEqual(getCanonical(surveyedId), surveyed, "surveyed row untouched");
}

// ===========================================================================
// 10. Phase 14 — failure and crash-window tests with fault injection.
// ===========================================================================
{
  // A canonical UPDATE failure prevents the ledger insertion.
  {
    const [t] = unsurveyedTargets(13);
    prepTarget(t);
    const c = insertContribution({ kind: "access_update", target: t, payload: { access: "public" } });
    const plan = buildPlan(c);
    const brokenDb = makeD1(sqlite, { failCanonicalUpdate: true });
    await assert.rejects(
      () => executeCanonicalPromotion(brokenDb, { contributionId: c, plan, promoterUserId: PROMOTER }),
      /injected canonical UPDATE failure/,
    );
    assert.equal(ledgerFor(c), undefined, "no ledger row after a failed UPDATE");
    assert.equal(getCanonical(t).access, "unknown", "no canonical change after a failed UPDATE");
  }

  // Crash between phase 1 and phase 2: canonical changed, evidence trail
  // missing => phase2_failed (success is never claimed) + detectable.
  const orphanTarget = unsurveyedTargets(15)[14];
  prepTarget(orphanTarget);
  const orphanContribution = insertContribution({ kind: "fee_update", target: orphanTarget, payload: { fee: "yes" } });
  crashOrphanId = orphanContribution;
  {
    const plan = buildPlan(orphanContribution);
    const crashDb = makeD1(sqlite, { failBatchOnce: true });
    const r = failWith(await executeCanonicalPromotion(crashDb, { contributionId: orphanContribution, plan, promoterUserId: PROMOTER }));
    assert.equal(r.reason, "phase2_failed", "the crash window surfaces as an explicit failure");
    assert.equal(getCanonical(orphanTarget).fee, "yes", "phase 1 did commit (two-phase, not atomic)");
    assert.equal(ledgerFor(orphanContribution), undefined, "phase 2 did not commit");
    assert.equal(promotionEvents(orphanContribution).length, 0, "no orphan audit event either");
  }
  // Replaying the crashed promotion is safe: the planner would now answer
  // redundant_noop (the value is already applied), and a hand-carried PRE-CRASH
  // plan hits the CAS guard as drift — the executor refuses instead of
  // re-writing or double-landing a ledger row.
  {
    const current = getCanonical(orphanTarget);
    // Exactly the state prepTarget stamped before the crashed execution.
    const forgedOldPlan = {
      canonical_id: orphanTarget,
      contribution_id: orphanContribution,
      kind: "fee_update",
      contributor_user_id: "auth0|contributor-test",
      base_snapshot: {
        updated_at: STAMP,
        access: "unknown",
        fee: "unknown",
        bidet_presence: "Unknown",
        name: "Prepared Test Place",
        address: "Prepared Test Address",
        latitude: current.latitude,
        longitude: current.longitude,
      },
      changed_columns: ["fee"],
      resulting_values: { fee: "yes" },
      evidence: null,
    };
    const r = failWith(await executeCanonicalPromotion(db, { contributionId: orphanContribution, plan: forgedOldPlan, promoterUserId: PROMOTER }));
    assert.equal(r.reason, "stale_snapshot", "post-crash replay with the old snapshot cannot double-apply");
    assert.ok(r.details.drift.some((d) => d.column === "fee"), "drift report names the already-applied column");
    assert.equal(ledgerFor(orphanContribution), undefined, "the replay still lands no ledger row");
  }

  // Audit-insert failure inside phase 2 rolls the whole batch back (ledger
  // AND event), still leaving a detectable state.
  {
    const [t] = unsurveyedTargets(16);
    prepTarget(t);
    const c = insertContribution({ kind: "access_update", target: t, payload: { access: "customers" } });
    const plan = buildPlan(c);
    const badEventDb = makeD1(sqlite, { failEventInsert: true });
    const r = failWith(await executeCanonicalPromotion(badEventDb, { contributionId: c, plan, promoterUserId: PROMOTER }));
    assert.equal(r.reason, "phase2_failed");
    assert.equal(ledgerFor(c), undefined, "the batch is atomic: no ledger survives a failed event insert");
    assert.equal(getCanonical(t).access, "customers", "phase 1 remains committed — the honest limitation");
  }

  // Phase 10 reconciliation classifies the states WITHOUT inventing rows.
  const report = await reconcileCanonicalPromotions(db);
  assert.ok(report.suspected_orphans.some((o) => o.contribution_id === orphanContribution && o.canonical_id === orphanTarget), "the orphan is detected");
  assert.ok(report.known_promotions.some((p) => p.contribution_id && report.known_promotions.length >= 1), "known promotions are reported");
  assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 2, "limitations are explicit");
  assert.equal(ledgerFor(orphanContribution), undefined, "reconciliation wrote nothing");
  const orphanCanonicalRow = getCanonical(orphanTarget);
  assert.equal(orphanCanonicalRow.fee, "yes", "reconciliation did not touch canonical either");
}

// ===========================================================================
// 11. Real store seam: the Stage 13 wrapper is inert-but-delegating; one
//     authoritative path exists and the old column-only apply is gone.
// ===========================================================================
{
  const contributor = { userId: "auth0|real-contributor", role: "contributor" };
  const moderator = { userId: "auth0|real-moderator", role: "moderator" };
  const [t] = unsurveyedTargets(12);
  prepTarget(t);
  const created = await createContribution(db, contributor, {
    kind: "fee_update",
    targetCanonicalId: t,
    payload: { fee: "no" },
    notes: "Real-path fixture via the Stage 13 submit seam.",
    evidence: null,
  });
  assert.equal(created.ok, true);
  const decided = await decideContribution(db, moderator, created.value.contributionId, "approve", "Credible.");
  assert.equal(decided.ok, true);

  const { applyApprovedToCanonical } = await import("../functions/_lib/contributions-store.ts");
  const applied = await applyApprovedToCanonical(db, moderator, created.value.contributionId);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.value.applied, true);
  assert.equal(getCanonical(t).fee, "no");
  const ledger = ledgerFor(created.value.contributionId);
  assert.ok(ledger, "the wrapper goes through the executor: a ledger row exists");
  assert.equal(ledger.promoter_user_id, moderator.userId);

  // Replay through the wrapper: the canonical value is already applied, so no
  // plan exists; nothing is written a second time.
  const again = await applyApprovedToCanonical(db, moderator, created.value.contributionId);
  assert.equal(
    ledgerFor(created.value.contributionId).promotion_id,
    ledger.promotion_id,
    "no second ledger row through the wrapper",
  );
  assert.ok(!again.ok || again.value?.applied !== true, "replay never reports a fresh application");
}

// ===========================================================================
// 12. Phase 15 — the 0006 schema contract holds on this database.
// ===========================================================================
{
  const columns = sqlite.prepare("PRAGMA table_info(canonical_promotions)").all().map((c) => c.name);
  assert.deepEqual(columns, [
    "promotion_id", "contribution_id", "canonical_id", "kind", "contributor_user_id",
    "promoter_user_id", "promoted_at", "base_snapshot_json", "changed_columns_json",
    "resulting_values_json", "status", "reversal_of", "promotion_note",
  ]);
  const indexes = sqlite.prepare("PRAGMA index_list(canonical_promotions)").all();
  assert.ok(indexes.some((i) => i.unique === 1 && sqlite.prepare(`PRAGMA index_info('${i.name}')`).all().some((c) => c.name === "contribution_id")), "UNIQUE(contribution_id) replay gate exists");

  const anyPromotion = sqlite.prepare("SELECT contribution_id, canonical_id, kind, contributor_user_id, promoter_user_id, base_snapshot_json, changed_columns_json, resulting_values_json FROM canonical_promotions LIMIT 1").get();
  assert.throws(() =>
    sqlite.prepare(
      `INSERT INTO canonical_promotions (promotion_id, contribution_id, canonical_id, kind, contributor_user_id, promoter_user_id, base_snapshot_json, changed_columns_json, resulting_values_json) VALUES ('promo_' || '00000000000000000000000000000000', ?, ?, ?, 'x', 'y', '{}', '[]', '{}')`,
    ).run(anyPromotion.contribution_id, anyPromotion.canonical_id, anyPromotion.kind),
  /UNIQUE/i, "a second ledger row for one contribution is impossible at the DB level");
  assert.throws(() =>
    sqlite.prepare(
      `INSERT INTO canonical_promotions (promotion_id, contribution_id, canonical_id, kind, contributor_user_id, promoter_user_id, base_snapshot_json, changed_columns_json, resulting_values_json, status) VALUES ('promo_' || '11111111111111111111111111111111', 'contrib_' || '22222222222222222222222222222222', ?, 'access_update', 'x', 'y', '{}', '[]', '{}', 'reversed')`,
    ).run(anyPromotion.canonical_id),
  /CHECK/i, "status is pinned to 'promoted' — append-only, no history rewrite");
}

// ===========================================================================
// 13. Phase 17 — architecture guards (behavioural first, then source scope).
// ===========================================================================
{
  const source = readFileSync(new URL("../functions/_lib/canonical-promotion.ts", import.meta.url), "utf8");
  // No HTTP surface, no environment reads, no promoter authorization (§4/§15).
  assert.ok(!/BUTTLER_PROMOTER_IDS/.test(source.replace(/\/\/[^\n]*/g, "")), "executor must not read promoter env (mentions in comments only)");
  assert.ok(!/process\.env|ctx\.env|env\[|Deno\.env/.test(source), "executor reads no environment");
  assert.ok(!/Request|Response|onRequest|fetch\(/.test(source.replace(/\/\/[^\n]*/g, "")), "executor contains no HTTP code");
  const mod = await import("../functions/_lib/canonical-promotion.ts");
  assert.deepEqual(
    Object.keys(mod).sort(),
    ["executeCanonicalPromotion", "planAndExecuteCanonicalPromotion", "reconcileCanonicalPromotions"],
    "the executor exposes exactly its narrow API",
  );
  // Enumerate every file under functions/api for the endpoint-scope guard below.
  const walk = (dir, seen = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(p, seen);
      else seen.push(p);
    }
    return seen;
  };
  const apiFiles = walk(new URL("../functions/api", import.meta.url).pathname.replace(/^\//, ""));
  // Stage 14D asserted no promotion endpoint existed. Stage 14E legitimately
  // adds exactly ONE thin HTTP boundary; the durable invariant is that the
  // EXECUTOR above still contains none of that surface (§4/§15 guards) and the
  // endpoint is a separate, dedicated route. Pin it to the single 14E file
  // rather than forbidding its existence.
  assert.deepEqual(
    apiFiles.filter((f) => /promotion/i.test(f)).map((f) => f.split(/[\\/]/).pop()).sort(),
    ["promotion.ts"],
    "the only promotion endpoint is the single Stage 14E boundary route (executor stays HTTP-free)",
  );
  // No DELETE / INSERT into canonical / provenance writes in the executor.
  // Strip block comments and line comments so guards scan executable code only.
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(!/DELETE FROM/i.test(executableSource), "executor contains no DELETE");
  assert.ok(!/INSERT INTO canonical_locations/i.test(executableSource), "executor never inserts canonical rows");
  assert.ok(!/location_provenance/i.test(executableSource), "executor never writes provenance (§9)");
  assert.ok(!/restroom_locations/i.test(executableSource), "executor never touches the legacy table");
}

// ===========================================================================
// 14. Global integrity: provenance + legacy byte-identical, only tested
//     canonical rows differ, no orphan beyond the injected crash fixture.
// ===========================================================================
{
  // Stage 14M: the retired Pulantubig duplicate must still be exactly what the
  // Stage 14K migration left it — the executor never promoted or edited it.
  assert.equal(
    JSON.stringify(sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get("buttler_loc_a962aa157dff936ae36a")),
    pulantubigBaselineRow,
    "the seeded rejected row is byte-identical to its pre-suite state",
  );
  assert.equal(
    count("SELECT count(*) AS c FROM canonical_locations WHERE record_status = 'rejected'"),
    2,
    "rejected lineage = the seeded Pulantubig duplicate + this suite's one disposable row",
  );
  assert.equal(
    count("SELECT count(*) AS c FROM canonical_locations"),
    baselineCanonical + 1,
    "row count = baseline + exactly the ONE seeded proximity fixture (the executor itself never inserts or deletes canonical rows)",
  );
  assert.equal(
    count("SELECT count(*) AS c FROM canonical_locations WHERE canonical_id = ?", "buttler_loc_" + "f".repeat(20)),
    1,
    "the single extra row is the hand-inserted test neighbour",
  );
  assert.equal(
    JSON.stringify(sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all()),
    provenanceBaseline,
    "location_provenance is byte-identical before/after the whole suite (§9)",
  );
  assert.equal(
    JSON.stringify(sqlite.prepare("SELECT * FROM restroom_locations ORDER BY rowid").all()),
    legacyBaseline,
    "legacy restroom_locations is byte-identical (§ canonical integrity)",
  );
  const current = sqlite
    .prepare("SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude FROM canonical_locations")
    .all();
  const changed = current.filter((row) => JSON.stringify(canonicalBaseline.get(row.canonical_id)) !== JSON.stringify(row));
  const unexpected = changed.filter((row) => !touchedIds.has(row.canonical_id));
  // Stage 14M retires one disposable row to rejected lineage. That is a
  // record_status change only — the values compared above stay untouched.
  if (rejectedTargetId) touchedIds.add(rejectedTargetId);
  assert.deepEqual(unexpected.map((r) => r.canonical_id), [], "no canonical row outside the tested set was modified");

  const finalReport = await reconcileCanonicalPromotions(db);
  // Every known promotion reconciles; the only suspected orphans are the
  // deliberately injected crash and the documented refused-noop coincidence.
  assert.ok(finalReport.suspected_orphans.some((o) => o.contribution_id === crashOrphanId), "the injected crash is still detected");
  assert.ok(
    finalReport.suspected_orphans.every((o) => o.contribution_id === crashOrphanId || coincidentalOrphanIds.has(o.contribution_id)),
    `no unexplained orphans: ${JSON.stringify(finalReport.suspected_orphans)} vs crash ${crashOrphanId} + coincidences ${[...coincidentalOrphanIds]}`,
  );
  assert.ok(finalReport.known_promotions.length >= 5, "the successful promotions are all accounted for");
  assert.ok(finalReport.not_promoted.length >= 1, "unpromoted approved claims are visible as normal pending state");

  sqlite.close();
  console.log("STAGE14D_EXECUTOR_TEST_SUCCESS");
  console.log(`  canonical ${baselineCanonical} / provenance ${baselineProvenance} / legacy ${baselineLegacy} — provenance+legacy byte-identical`);
  console.log(`  promotions ledged: ${finalReport.known_promotions.length}; injected orphan detected: 1`);
}
