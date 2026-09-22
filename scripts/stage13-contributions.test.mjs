// Buttler 2.0 — Stage 13 contributions + moderation behaviour test.
//
// Proves the safe operational foundation: an authenticated, allow-listed
// contribution flow, an append-only moderation trail, and — critically — that
// nothing short of the explicitly-privileged canonical-apply path can change a
// canonical row. It runs the STAGED contribution schema (d1/contributions) on
// top of the real production migrations against a throwaway in-memory SQLite
// (the D1 engine). It NEVER touches the bound database, a Cloudflare account, or
// any secret.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage13-contributions.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  createContribution,
  getContribution,
  listMyContributions,
  moderationQueue,
  decideContribution,
  applyApprovedToCanonical,
} from "../functions/_lib/contributions-store.ts";
import { onRequestPost as createHandler } from "../functions/api/contributions.ts";
import { onRequestGet as moderationQueueHandler } from "../functions/api/moderation/contributions.ts";
import { validatePayload } from "../lib/contributions/contract.ts";
import { planCanonicalApply, renderApplyStatement, WRITABLE_CANONICAL_COLUMNS } from "../lib/contributions/apply.ts";
import { authorizeDecision, authorizeRead } from "../lib/contributions/authorize.ts";

const migrationsDir = new URL("../d1/migrations/", import.meta.url);
const stagedDir = new URL("../d1/contributions/", import.meta.url);

// --- Build the database: every committed migration, then the STAGED schema ---
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON;");
for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
}
sqlite.exec(readFileSync(new URL("0005_create_contributions.sql", stagedDir), "utf8"));

// Minimal D1-shaped adapter over node:sqlite so the store's real SQL runs here.
function makeD1(db) {
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
      };
      return api;
    },
  };
}
const db = makeD1(sqlite);

// --- Baselines captured from the real seed ---------------------------------
const count = (sql) => sqlite.prepare(sql).get().c;
const baselineCanonical = count("SELECT count(*) AS c FROM canonical_locations");
const baselineProvenance = count("SELECT count(*) AS c FROM location_provenance");
const baselineLegacy = count("SELECT count(*) AS c FROM restroom_locations");
// The prompt's production dataset; the local seed must reproduce it exactly.
assert.equal(baselineCanonical, 776, "canonical rows should match the 776-row dataset");
assert.equal(baselineProvenance, 845, "provenance links should match the 845-row dataset");
assert.equal(baselineLegacy, 1112, "legacy restroom rows should match the 1,112-row table");

const realId = sqlite
  .prepare("SELECT canonical_id AS id FROM canonical_locations ORDER BY canonical_id LIMIT 1")
  .get().id;
const realId2 = sqlite
  .prepare("SELECT canonical_id AS id FROM canonical_locations ORDER BY canonical_id LIMIT 1 OFFSET 1")
  .get().id;

const CANON = () =>
  sqlite
    .prepare("SELECT canonical_id, name, access, fee, bidet_presence, bidet_verification, record_status, updated_at FROM canonical_locations ORDER BY canonical_id")
    .all();

const contributor = { userId: "user_contrib_1", role: "contributor" };
const otherContributor = { userId: "user_contrib_2", role: "contributor" };
const moderator = { userId: "mod_primary", role: "moderator" };

// ===========================================================================
// 1. Unauthenticated contribution rejection (handler fails closed).
// ===========================================================================
const anonResponse = await createHandler({
  request: new Request("https://app.test/api/contributions", {
    method: "POST",
    body: JSON.stringify({ kind: "fee_update", target_canonical_id: realId, payload: { fee: "no" } }),
  }),
  env: { BUTTLER_DB: db },
  params: {},
});
assert.equal(anonResponse.status, 503, "no auth provider => refuse, never a silent write");
assert.equal(count("SELECT count(*) AS c FROM contributions"), 0, "rejected write created no row");

// ===========================================================================
// 2. Authenticated contribution acceptance + 3. server-assigned identity +
// 4. no impersonation + 21. pending does not alter canonical.
// ===========================================================================
const canonicalBefore2 = CANON();
const created = await createContribution(db, contributor, {
  kind: "fee_update",
  targetCanonicalId: realId,
  payload: { fee: "yes" },
  notes: "There is now a small fee at the door.",
  evidence: [{ type: "field_observation", detail: "I paid 10 pesos today" }],
});
assert.equal(created.ok, true, "valid authenticated submission accepted");
const newContributionId = created.value.contributionId;
assert.equal(created.value.status, "pending", "submissions always start pending");

const stored = sqlite
  .prepare("SELECT * FROM contributions WHERE contribution_id = ?")
  .get(newContributionId);
// 3: identity is the verified session user, 4: not anything a body could supply.
assert.equal(stored.contributor_user_id, contributor.userId);
assert.equal(stored.status, "pending");
assert.equal(stored.decided_at, null);
assert.equal(stored.decided_by, null);
// 21: pending contribution mutates nothing canonical.
assert.deepEqual(CANON(), canonicalBefore2, "pending contribution must not touch canonical");

// A submitted event was appended.
assert.equal(
  sqlite.prepare("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ? AND event_type = 'submitted'").get(newContributionId).c,
  1,
);

// ===========================================================================
// 5. Invalid canonical id: malformed (400) and well-formed-but-absent (404).
// ===========================================================================
assert.equal(
  (await createContribution(db, contributor, { kind: "fee_update", targetCanonicalId: "nonsense", payload: { fee: "no" } })).status,
  400,
);
assert.equal(
  (await createContribution(db, contributor, { kind: "fee_update", targetCanonicalId: "buttler_loc_deadbeefdeadbeef0000", payload: { fee: "no" } })).status,
  404,
);

// ===========================================================================
// 6. new_location must not reference a canonical target.
// 7. existing-location kind requires a valid canonical target.
// ===========================================================================
assert.equal(
  (await createContribution(db, contributor, { kind: "new_location", targetCanonicalId: realId, payload: { name: "X", latitude: 9.3, longitude: 123.3 } })).status,
  400,
);
assert.equal(
  (await createContribution(db, contributor, { kind: "access_update", targetCanonicalId: null, payload: { access: "public" } })).status,
  400,
);

// A valid new_location with no target is accepted and creates NO canonical row.
const canonicalBeforeNew = count("SELECT count(*) AS c FROM canonical_locations");
const newLoc = await createContribution(db, contributor, {
  kind: "new_location",
  targetCanonicalId: null,
  payload: { name: "Proposed Seaside CR", latitude: 9.31, longitude: 123.31 },
});
assert.equal(newLoc.ok, true, "new_location proposal accepted");
assert.equal(count("SELECT count(*) AS c FROM canonical_locations"), canonicalBeforeNew, "new_location must NOT create a canonical placeholder");

// ===========================================================================
// 8. Unknown kind. 9. Unknown payload field. 10. Protected field.
// ===========================================================================
assert.equal((await createContribution(db, contributor, { kind: "vandalize", targetCanonicalId: realId, payload: {} })).status, 400);
assert.equal((await createContribution(db, contributor, { kind: "fee_update", targetCanonicalId: realId, payload: { bogus: "x" } })).status, 400);
assert.equal((await createContribution(db, contributor, { kind: "fee_update", targetCanonicalId: realId, payload: { fee: "no", bidet_verification: "field_verified" } })).status, 400);
assert.equal((await createContribution(db, contributor, { kind: "access_update", targetCanonicalId: realId, payload: { record_status: "verified" } })).status, 400);
// A contributor claim can never be phrased as field_verified even for bidets:
assert.equal(validatePayload("bidet_report", { bidet_verification: "field_verified" }).ok, false);

// ===========================================================================
// 11/12. Size limits.
// ===========================================================================
assert.equal((await createContribution(db, contributor, { kind: "problem_report", targetCanonicalId: realId, payload: { issue: true }, notes: "x".repeat(3000) })).status, 413);
const oversizedHandler = await createHandler({
  request: new Request("https://app.test/api/contributions", { method: "POST", body: JSON.stringify({ kind: "fee_update", target_canonical_id: realId, payload: { fee: "no" }, notes: "y".repeat(20000) }) }),
  env: { BUTTLER_DB: db },
  params: {},
});
assert.equal(oversizedHandler.status, 503, "still fails closed before body size when auth unconfigured");

// ===========================================================================
// 13/14/15. Authorization on decisions (pure + via store).
// ===========================================================================
// Contributor cannot change moderation status of their own or anyone's row:
assert.equal((await decideContribution(db, contributor, newContributionId, "approve", null)).status, 403);
// A different authenticated contributor (non-moderator) cannot either:
assert.equal((await decideContribution(db, otherContributor, newContributionId, "approve", null)).status, 403);
// Null identity cannot read someone else's contribution and gets a 404-style:
assert.equal(authorizeRead(null, { contributor_user_id: contributor.userId, status: "pending" }).status, 401);
assert.equal(authorizeRead(otherContributor, { contributor_user_id: contributor.userId, status: "pending" }).status, 404);
// Moderator cannot approve their OWN submission:
const selfSubmitted = await createContribution(db, moderator, { kind: "fee_update", targetCanonicalId: realId2, payload: { fee: "no" } });
assert.equal(selfSubmitted.ok, true, "moderator's own submission should be accepted");
assert.equal((await decideContribution(db, moderator, selfSubmitted.value.contributionId, "approve", null)).status, 403);
// Queue handler also fails closed without auth:
assert.equal((await moderationQueueHandler({ request: new Request("https://app.test/api/moderation/contributions"), env: { BUTTLER_DB: db }, params: {} })).status, 503);

// ===========================================================================
// 16/17/20. Moderator reviews a different contributor's submission.
// ===========================================================================
const canonicalBeforeReject = CANON();
const decided = await decideContribution(db, moderator, newContributionId, "reject", "Insufficient detail; please add the fee amount.");
assert.equal(decided.ok, true, "moderator decision accepted");
assert.equal(decided.value.status, "rejected");
const rejectedRow = sqlite.prepare("SELECT * FROM contributions WHERE contribution_id = ?").get(newContributionId);
assert.equal(rejectedRow.decided_by, moderator.userId);
assert.notEqual(rejectedRow.decided_at, null);
assert.equal(rejectedRow.moderation_note, "Insufficient detail; please add the fee amount.");
// 17: append-only event recorded.
assert.equal(
  sqlite.prepare("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ? AND event_type = 'moderation_decision' AND actor_type = 'moderator'").get(newContributionId).c,
  1,
);
// 20: rejection changed nothing canonical.
assert.deepEqual(CANON(), canonicalBeforeReject, "rejected contribution must not touch canonical");

// ===========================================================================
// 18/19. Canonical mutation ONLY through the approved apply path.
// ===========================================================================
// Create + approve an access_update on a canonical row that is currently
// 'unknown' access so we can observe exactly one controlled column change.
const target = sqlite.prepare("SELECT canonical_id AS id, access FROM canonical_locations WHERE access = 'unknown' ORDER BY canonical_id LIMIT 1").get();
assert.ok(target, "expected at least one unknown-access canonical row");
const accessSub = await createContribution(db, contributor, { kind: "access_update", targetCanonicalId: target.id, payload: { access: "public" } });
const accessId = accessSub.value.contributionId;

// Before approval, apply is refused and nothing changes.
assert.equal((await applyApprovedToCanonical(db, moderator, accessId)).status, 409, "pending cannot apply");
const beforeApply = sqlite.prepare("SELECT access, bidet_verification, record_status FROM canonical_locations WHERE canonical_id = ?").get(target.id);

// Approve (decision) — still no canonical write.
assert.equal((await decideContribution(db, moderator, accessId, "approve", "Confirmed public.")).ok, true);
const afterApprove = sqlite.prepare("SELECT access, bidet_verification, record_status FROM canonical_locations WHERE canonical_id = ?").get(target.id);
assert.deepEqual(afterApprove, beforeApply, "approval is a decision, not a write");

// Contributor cannot apply; only a moderator can, via the privileged function.
assert.equal((await applyApprovedToCanonical(db, contributor, accessId)).status, 403);

// The privileged apply path performs the single allowed column change.
const applied = await applyApprovedToCanonical(db, moderator, accessId);
assert.equal(applied.ok, true);
assert.equal(applied.value.applied, true);
const afterApply = sqlite.prepare("SELECT access, bidet_verification, record_status FROM canonical_locations WHERE canonical_id = ?").get(target.id);
assert.equal(afterApply.access, "public", "allow-listed access column applied");
assert.equal(afterApply.bidet_verification, beforeApply.bidet_verification, "verification is NEVER changed by apply");
assert.equal(afterApply.record_status, beforeApply.record_status, "record_status is NEVER changed by apply");
// Row count unchanged (an update, not an insert/delete); provenance & legacy intact.
assert.equal(count("SELECT count(*) AS c FROM canonical_locations"), baselineCanonical);
assert.equal(count("SELECT count(*) AS c FROM location_provenance"), baselineProvenance);
assert.equal(count("SELECT count(*) AS c FROM restroom_locations"), baselineLegacy);

// 18: apply can only ever target allow-listed columns; unmapped/protected keys
// are ignored, so a crafted payload can never reach a forbidden column.
const sneakyPlan = planCanonicalApply("access_update", target.id, { access: "public", bidet_verification: "field_verified", record_status: "verified" });
assert.equal(sneakyPlan.op, "update");
assert.deepEqual(sneakyPlan.sets.map((s) => s.column), ["access"], "only the allow-listed column is planned");
assert.ok(renderApplyStatement({ op: "update", canonicalId: "x", sets: [{ column: "access", value: "public" }] }).sql.includes("access = ?"));
assert.deepEqual(
  WRITABLE_CANONICAL_COLUMNS.filter((c) => ["record_status", "bidet_verification", "canonical_id"].includes(c)),
  [],
  "protected columns must never be writable",
);

// ===========================================================================
// 22/23/24. Canonical/provenance/legacy row counts remain intact.
// ===========================================================================
assert.equal(count("SELECT count(*) AS c FROM canonical_locations"), baselineCanonical);
assert.equal(count("SELECT count(*) AS c FROM location_provenance"), baselineProvenance);
assert.equal(count("SELECT count(*) AS c FROM restroom_locations"), baselineLegacy);

// Contributor's own history is scoped to them.
const mine = await listMyContributions(db, contributor);
assert.ok(mine.length >= 1);
assert.ok(mine.every((r) => r.contributor_user_id === contributor.userId));
const notMine = await listMyContributions(db, otherContributor);
assert.ok(notMine.every((r) => r.contributor_user_id === otherContributor.userId));

sqlite.close();
console.log("STAGE13_CONTRIBUTIONS_TEST_SUCCESS");
console.log(`  canonical ${baselineCanonical} / provenance ${baselineProvenance} / legacy ${baselineLegacy} intact`);
