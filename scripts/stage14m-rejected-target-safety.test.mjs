// Buttler 2.0 — Stage 14M canonical promotion rejected-target safety test.
//
// Narrow regression suite for the safety hardening found during the Stage 14L
// read-only audit: a canonical promotion must NEVER land on a canonical row
// whose stored `record_status` is 'rejected'. Rejected rows are retained
// lineage (the Stage 14K Pulantubig duplicate merge) and are not part of the
// ACTIVE canonical dataset, so they cannot receive a community promotion.
//
// What this file proves, in one focused run:
//   1. the refusal sits at the executor / data-integrity boundary, so no
//      caller — HTTP route, the inert Stage 13 store seam, or a future
//      alternate caller — can route around it;
//   2. the refusal is explicit and machine-readable, not a silent "not found";
//   3. a refused promotion writes NOTHING: no canonical mutation, no
//      `canonical_promotions` ledger row, no `contribution_events` audit row;
//   4. the pre-existing guards still behave (compare-and-swap drift, replay);
//   5. planner policy is unchanged — the planner is intentionally unaware of
//      `record_status`, which is exactly why the guard belongs in the executor.
//
// Harness parity with Stage 13/14C/14D/14E: the real committed migrations are
// applied to a throwaway in-memory SQLite (the D1 engine) seeded with the real
// local dataset. It NEVER touches a bound database, a Cloudflare account, any
// secret, or production data, and performs zero network calls.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage14m-rejected-target-safety.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  executeCanonicalPromotion,
  planAndExecuteCanonicalPromotion,
} from "../functions/_lib/canonical-promotion.ts";
import { applyApprovedToCanonical } from "../functions/_lib/contributions-store.ts";
import { planCanonicalPromotion } from "../lib/contributions/promotion-planner.ts";

const PROMOTER = "auth0|promoter-14m";
const CONTRIBUTOR = "auth0|contributor-14m";
// The row the Stage 14K migration retired. Present in the local seed exactly
// as it is in production: rejected lineage, retained for FK + audit history.
const PULANTUBIG_DUPLICATE = "buttler_loc_a962aa157dff936ae36a";

// ---------------------------------------------------------------------------
// Throwaway database: every committed migration, in order
// ---------------------------------------------------------------------------
const migrationsDir = new URL("../d1/migrations/", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON;");
for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
}

// D1-shaped adapter (prepare/bind/run/first/all + batch), same contract the
// Stage 14D harness uses, so the executor runs against real SQLite semantics.
function makeD1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let bound = [];
      const api = {
        bind(...values) { bound = values; return api; },
        async run() {
          const info = stmt.run(...bound);
          return { results: [], meta: { changes: info.changes } };
        },
        async first(column) {
          const row = stmt.get(...bound);
          if (!row) return null;
          return column ? row[column] : row;
        },
        async all() { return { results: stmt.all(...bound) }; },
      };
      return api;
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
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
// Baselines — the suite must leave the dataset otherwise untouched
// ---------------------------------------------------------------------------
const count = (sql, ...a) => (a.length ? sqlite.prepare(sql).get(...a) : sqlite.prepare(sql).get()).c;
const physicalCanonical = count("SELECT count(*) AS c FROM canonical_locations");
const rejectedBefore = count("SELECT count(*) AS c FROM canonical_locations WHERE record_status = 'rejected'");
const provenanceBaseline = JSON.stringify(
  sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all(),
);
const legacyBaseline = JSON.stringify(
  sqlite.prepare("SELECT * FROM restroom_locations ORDER BY rowid").all(),
);
const pulantubigBaseline = JSON.stringify(
  sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(PULANTUBIG_DUPLICATE),
);
assert.equal(physicalCanonical, 777, "local dataset matches the audited physical canonical count");
assert.equal(rejectedBefore, 1, "exactly one rejected lineage row before this suite runs");
assert.equal(JSON.parse(pulantubigBaseline).record_status, "rejected", "the Pulantubig duplicate is rejected lineage");

// The retired row keeps its full-survivor absence: this suite only ever reads
// it, so a write anywhere in the promotion path shows up as a diff.
const fullRow = (id) => JSON.stringify(sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(id));

let contribCounter = 0;
function insertContribution({ kind, target, payload, status = "approved" }) {
  contribCounter += 1;
  const id = `contrib_${contribCounter.toString(16).padStart(32, "0")}`;
  sqlite
    .prepare(
      `INSERT INTO contributions (contribution_id, kind, target_canonical_id, contributor_user_id, ` +
      `status, validation_status, payload_json, evidence_json, decided_at) ` +
      `VALUES (?, ?, ?, ?, ?, 'passed', ?, NULL, ?)`,
    )
    .run(id, kind, target, CONTRIBUTOR, status, JSON.stringify(payload), status === "approved" ? "2026-09-30T00:00:00.000Z" : null);
  return id;
}

// Build a real Stage 14C plan from stored rows — what the authoritative entry
// point does internally. Deliberately planner-driven: the planner has no
// record_status concept, so a plan for a rejected target is produced normally.
function buildPlan(contributionId) {
  const row = sqlite.prepare("SELECT * FROM contributions WHERE contribution_id = ?").get(contributionId);
  const target = sqlite
    .prepare(
      `SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude, bidet_source_id ` +
      `FROM canonical_locations WHERE canonical_id = ?`,
    )
    .get(row.target_canonical_id);
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
    nearbyLocations: null,
  });
  assert.equal(result.ok, true, `fixture plan should be valid: ${result.ok ? "" : result.error.code}`);
  return result.plan;
}

const ledgerFor = (contributionId) =>
  sqlite.prepare("SELECT * FROM canonical_promotions WHERE contribution_id = ?").get(contributionId);
const eventsFor = (contributionId) =>
  sqlite.prepare("SELECT * FROM contribution_events WHERE contribution_id = ?").all(contributionId);
const refusal = (result) => {
  assert.equal(result.ok, false, `expected a structured refusal, got ${JSON.stringify(result)}`);
  return result;
};

// Retire one disposable active row so the suite can exercise the guard on a
// row it fully controls, without touching the seeded lineage row.
const [retiredTarget] = sqlite
  .prepare(
    `SELECT canonical_id AS id FROM canonical_locations WHERE bidet_source_id IS NULL ` +
    `AND record_status <> 'rejected' AND access <> 'restricted' ORDER BY canonical_id LIMIT 1`,
  )
  .all()
  .map((r) => r.id);
sqlite.prepare(`UPDATE canonical_locations SET record_status = 'rejected' WHERE canonical_id = ?`).run(retiredTarget);
const retiredBaseline = fullRow(retiredTarget);

// ===========================================================================
// 1. The seeded retired record (Pulantubig duplicate) can never be promoted
// ===========================================================================
{
  assert.equal(
    count("SELECT count(*) AS c FROM canonical_locations WHERE record_status = 'rejected'"),
    rejectedBefore + 1,
    "one seeded lineage row + this suite's one retired fixture",
  );

  const contributionId = insertContribution({
    kind: "fee_update",
    target: PULANTUBIG_DUPLICATE,
    payload: { fee: "yes" },
  });
  const plan = buildPlan(contributionId);

  // Direct executor call — the path a future alternate caller would use.
  const viaExecutor = refusal(await executeCanonicalPromotion(db, {
    contributionId, plan, promoterUserId: PROMOTER,
  }));
  assert.equal(viaExecutor.reason, "canonical_target_rejected", "explicit, not a silent not-found");
  assert.equal(viaExecutor.details.canonical_id, PULANTUBIG_DUPLICATE);
  assert.equal(viaExecutor.details.record_status, "rejected", "the stored status is reported back");

  // Authoritative entry point (plan + execute) — the path the real route uses.
  const viaEntry = refusal(await planAndExecuteCanonicalPromotion(db, {
    contributionId, promoterUserId: PROMOTER,
  }));
  assert.equal(viaEntry.reason, "canonical_target_rejected");

  // Nothing written: canonical, ledger, audit trail.
  assert.equal(fullRow(PULANTUBIG_DUPLICATE), pulantubigBaseline, "the retired production-lineage row is untouched");
  assert.equal(ledgerFor(contributionId), undefined, "no canonical_promotions row");
  assert.equal(count("SELECT count(*) AS c FROM canonical_promotions"), 0, "the ledger stayed empty");
  assert.equal(eventsFor(contributionId).length, 0, "no contribution_events row");
}

// ===========================================================================
// 2. The inert Stage 13 store seam refuses too — there is no second path
// ===========================================================================
{
  const contributionId = insertContribution({
    kind: "access_update",
    target: PULANTUBIG_DUPLICATE,
    payload: { access: "restricted" },
  });
  const applied = await applyApprovedToCanonical(
    db,
    { userId: PROMOTER, role: "moderator" },
    contributionId,
  );
  assert.equal(applied.ok, false, "the legacy seam does not promote lineage");
  assert.equal(applied.status, 409, "a refusal, not an accidental success");
  assert.match(applied.error, /canonical_target_rejected/, "the executor reason is carried through");
  assert.equal(fullRow(PULANTUBIG_DUPLICATE), pulantubigBaseline, "and it wrote nothing");
  assert.equal(ledgerFor(contributionId), undefined, "no ledger row through the seam");
  assert.equal(eventsFor(contributionId).length, 0, "no audit event through the seam");
}

// ===========================================================================
// 3. A retired row cannot be smuggled back into the active dataset
// ===========================================================================
{
  const contributionId = insertContribution({
    kind: "access_update",
    target: retiredTarget,
    payload: { access: "restricted" },
  });
  const plan = buildPlan(contributionId);
  const snapshot = plan.base_snapshot;

  const smuggles = [
    ["forged record_status", { ...plan, record_status: "candidate" }],
    ["record_status as a write", { ...plan, changed_columns: ["record_status"], resulting_values: { record_status: "verified" } }],
    ["forged snapshot values", { ...plan, base_snapshot: { ...snapshot, updated_at: "1999-01-01T00:00:00.000Z" } }],
    ["empty changed columns", { ...plan, changed_columns: [], resulting_values: {} }],
    ["wrong contributor", { ...plan, contributor_user_id: "auth0|someone-else" }],
    ["wrong kind", { ...plan, kind: "info_correction" }],
  ];
  for (const [label, forged] of smuggles) {
    const r = refusal(await executeCanonicalPromotion(db, {
      contributionId, plan: forged, promoterUserId: PROMOTER,
    }));
    assert.ok(
      ["canonical_target_rejected", "invalid_plan"].includes(r.reason),
      `${label}: refused, got ${r.reason}`,
    );
    assert.equal(fullRow(retiredTarget), retiredBaseline, `${label}: wrote nothing to the retired row`);
  }
  assert.equal(count("SELECT count(*) AS c FROM canonical_promotions"), 0, "no ledger row from any smuggle");
  assert.equal(count("SELECT count(*) AS c FROM contribution_events"), 0, "no audit event from any smuggle");

  // record_status is not in the executor's writable allow-list, so no plan can
  // ever turn it into SQL text.
  const { WRITABLE_CANONICAL_COLUMNS } = await import("../lib/contributions/apply.ts");
  assert.ok(!WRITABLE_CANONICAL_COLUMNS.includes("record_status"), "record_status is not promotion-writable");
}

// ===========================================================================
// 4. Guard precedence: activation is checked before drift, policy, and writes
// ===========================================================================
{
  const contributionId = insertContribution({
    kind: "access_update",
    target: retiredTarget,
    payload: { access: "restricted" },
  });
  const plan = buildPlan(contributionId);

  // A stale snapshot would ordinarily answer `stale_snapshot`; the retired
  // target answers activation instead, so drift reporting cannot be used to
  // probe or push lineage.
  const stale = refusal(await executeCanonicalPromotion(db, {
    contributionId,
    plan: { ...plan, base_snapshot: { ...plan.base_snapshot, updated_at: "2020-01-01T00:00:00.000Z" } },
    promoterUserId: PROMOTER,
  }));
  assert.equal(stale.reason, "canonical_target_rejected", "activation before CAS drift");
  assert.equal(fullRow(retiredTarget), retiredBaseline, "the guarded UPDATE never ran");

  // A missing canonical row is NOT reported as rejected lineage — the two
  // answers stay distinguishable.
  const ghost = "buttler_loc_" + "d".repeat(20);
  assert.equal(sqlite.prepare("SELECT canonical_id FROM canonical_locations WHERE canonical_id = ?").get(ghost), undefined);
  const missing = refusal(await executeCanonicalPromotion(db, {
    contributionId, plan: { ...plan, canonical_id: ghost }, promoterUserId: PROMOTER,
  }));
  assert.ok(
    ["invalid_plan", "canonical_target_not_found"].includes(missing.reason),
    `absent target is not "rejected" (got ${missing.reason})`,
  );
}

// ===========================================================================
// 5. Existing behavior is untouched: active rows promote, replays refuse,
//    and the planner keeps its own (record_status-blind) policy
// ===========================================================================
{
  // An ACTIVE row still promotes through the same executor, ledger and all.
  const [active] = sqlite
    .prepare(
      `SELECT canonical_id AS id FROM canonical_locations WHERE bidet_source_id IS NULL ` +
      `AND record_status <> 'rejected' AND access <> 'public' ORDER BY canonical_id LIMIT 1`,
    )
    .all()
    .map((r) => r.id);
  const before = sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(active);
  const contributionId = insertContribution({ kind: "access_update", target: active, payload: { access: "public" } });
  const ok = await planAndExecuteCanonicalPromotion(db, { contributionId, promoterUserId: PROMOTER });
  assert.equal(ok.ok, true, `active row still promotable: ${JSON.stringify(ok)}`);
  const after = sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(active);
  assert.equal(after.access, "public", "the writable column applied");
  assert.equal(after.bidet_presence, before.bidet_presence, "nothing else moved");
  assert.notEqual(after.updated_at, before.updated_at, "updated_at re-stamped");
  const ledger = ledgerFor(contributionId);
  assert.ok(ledger, "exactly one ledger row for the real promotion");
  assert.equal(ledger.status, "promoted");
  assert.equal(eventsFor(contributionId).filter((e) => e.event_type === "status_change").length, 1, "one audit event");

  // Replay of that promotion is still refused and writes no second row.
  const replay = refusal(await planAndExecuteCanonicalPromotion(db, { contributionId, promoterUserId: PROMOTER }));
  assert.ok(["already_promoted", "invalid_plan"].includes(replay.reason), `replay refused (got ${replay.reason})`);
  assert.equal(count("SELECT count(*) AS c FROM canonical_promotions"), 1, "still exactly one ledger row");

  // Planner policy is unchanged and deliberately record_status-blind: the only
  // place the planner mentions the column is the pre-existing NON_WRITABLE list
  // (it has always refused it as `forbidden_field`). It never reads the column,
  // so it produces the same plan for an active and a retired target — which is
  // exactly why the guard belongs in the executor.
  const plannerSource = readFileSync(new URL("../lib/contributions/promotion-planner.ts", import.meta.url), "utf8");
  assert.match(
    plannerSource,
    /NON_WRITABLE_CANONICAL_COLUMNS[\s\S]*?"record_status"/,
    "record_status stays a protected, non-writable column in the planner (untouched)",
  );
  // No record_status was added to the planner's target / snapshot contract.
  const targetBlock = plannerSource.slice(
    plannerSource.indexOf("export type CanonicalBaseSnapshot"),
    plannerSource.indexOf("export type ContributionSnapshotInput"),
  );
  assert.ok(!/record_status/.test(targetBlock), "planner target and snapshot types carry no record_status");
  const blindResult = planCanonicalPromotion({
    contribution: {
      contribution_id: "contrib_" + "a".repeat(27) + "9999",
      kind: "fee_update",
      status: "approved",
      target_canonical_id: retiredTarget,
      contributor_user_id: CONTRIBUTOR,
      payload_json: JSON.stringify({ fee: "yes" }),
    },
    // The same column list the planner has always accepted — no status field.
    target: sqlite
      .prepare(
        `SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude, bidet_source_id `
        + `FROM canonical_locations WHERE canonical_id = ?`,
      )
      .get(retiredTarget),
    nearbyLocations: null,
  });
  assert.equal(blindResult.ok, true, "the planner still plans a retired target — it is not the guard");

  // A payload that tries to make the planner write the status is refused with
  // its own pre-existing reason, not a new one.
  const forbidden = planCanonicalPromotion({
    contribution: {
      contribution_id: "contrib_" + "b".repeat(27) + "9998",
      kind: "info_correction",
      status: "approved",
      target_canonical_id: retiredTarget,
      contributor_user_id: CONTRIBUTOR,
      payload_json: JSON.stringify({ record_status: "candidate" }),
    },
    target: sqlite
      .prepare(
        `SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude, bidet_source_id `
        + `FROM canonical_locations WHERE canonical_id = ?`,
      )
      .get(retiredTarget),
    nearbyLocations: null,
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, "forbidden_field", "protected-column refusal is the planner's existing behavior");
  const planRetired = buildPlan(insertContribution({ kind: "fee_update", target: retiredTarget, payload: { fee: "yes" } }));
  assert.deepEqual(
    Object.keys(planRetired.base_snapshot).sort(),
    ["access", "address", "bidet_presence", "fee", "latitude", "longitude", "name", "updated_at"],
    "the plan snapshot keeps exactly the eight CAS values",
  );
  assert.ok(!("record_status" in planRetired.base_snapshot), "record_status never enters a plan snapshot");
}

// ===========================================================================
// 6. Architecture guard: the refusal is at the data-integrity boundary
// ===========================================================================
{
  const source = readFileSync(new URL("../functions/_lib/canonical-promotion.ts", import.meta.url), "utf8");
  assert.match(source, /record_status FROM canonical_locations/, "the stored row is the source of the status");
  assert.match(source, /canonical_target_rejected/, "the refusal is machine-readable");
  // The guard runs before the guarded UPDATE is ever built.
  const guardAt = source.indexOf("rejectedTargetCheck(fresh)");
  const updateAt = source.indexOf("const { sql, values } = buildGuardedUpdate(plan)");
  assert.ok(guardAt > 0 && updateAt > 0 && guardAt < updateAt, "the check precedes any canonical write");
  // The executor still exposes exactly its narrow API and holds no HTTP/env.
  const mod = await import("../functions/_lib/canonical-promotion.ts");
  assert.deepEqual(
    Object.keys(mod).sort(),
    ["executeCanonicalPromotion", "planAndExecuteCanonicalPromotion", "reconcileCanonicalPromotions"],
    "no new public surface",
  );
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/process\.env|ctx\.env/.test(executable), "executor reads no environment");
  assert.ok(!/location_provenance/i.test(executable), "executor never writes provenance (§9)");
}

// ===========================================================================
// 7. Global integrity: only this suite's own disposable rows differ
// ===========================================================================
{
  assert.equal(count("SELECT count(*) AS c FROM canonical_locations"), physicalCanonical, "no canonical row added or removed");
  assert.equal(
    count("SELECT count(*) AS c FROM canonical_locations WHERE record_status = 'rejected'"),
    rejectedBefore + 1,
    "rejected lineage = the seeded row + this suite's one retired fixture",
  );
  assert.equal(fullRow(PULANTUBIG_DUPLICATE), pulantubigBaseline, "the seeded lineage row is byte-identical");
  assert.equal(
    JSON.stringify(sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all()),
    provenanceBaseline,
    "location_provenance byte-identical (§9)",
  );
  assert.equal(
    JSON.stringify(sqlite.prepare("SELECT * FROM restroom_locations ORDER BY rowid").all()),
    legacyBaseline,
    "legacy restroom_locations byte-identical",
  );
  assert.equal(count("SELECT count(*) AS c FROM canonical_promotions"), 1, "exactly the one legitimate promotion is ledged");
  assert.equal(count("SELECT count(*) AS c FROM canonical_promotions WHERE canonical_id IN (SELECT canonical_id FROM canonical_locations WHERE record_status = 'rejected')"), 0, "no ledger row ever named a rejected target");

  sqlite.close();
  console.log("STAGE14M_REJECTED_TARGET_SAFETY_TEST_SUCCESS");
  console.log(`  canonical ${physicalCanonical} / provenance / legacy byte-identical; rejected lineage preserved`);
}
