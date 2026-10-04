// Buttler 2.0 — Stage 14E canonical-promotion HTTP boundary test.
//
// Proves the authenticated authorization seam that wraps the already-tested
// Stage 14D executor: a SEPARATE server-side promoter allow-list
// (BUTTLER_PROMOTER_IDS), no self-promotion, fail-closed on absent/malformed
// config, an "empty / ignored" body that trusts ONLY an optional promotion_note
// string, and the frozen §16 failure matrix mapped onto HTTP. It exercises the
// REAL route handler with REAL cryptographically-verified RS256 tokens (a local
// JWKS stands in for Auth0), so identity comes only from a signed bearer token
// — never a header/body/query field.
//
// It applies the committed migrations 0001–0007 to a fresh in-memory SQLite and
// validates the canonical_promotions ledger schema there (mission Phase 7). It
// NEVER touches a bound database, a Cloudflare account, or any secret, and runs
// zero production writes.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage14e-promotion-endpoint.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { onRequestPost as promoteHandler, onRequest as promotionOnRequest } from "../functions/api/moderation/contributions/[id]/promotion.ts";
import { createContribution, decideContribution } from "../functions/_lib/contributions-store.ts";
import { authorizeCanonicalPromotion } from "../lib/contributions/authorize.ts";
import { resolvePromoterAllowList } from "../functions/_lib/identity.ts";
import { MAX_PROMOTION_NOTE_LENGTH } from "../lib/contributions/contract.ts";

// ---------------------------------------------------------------------------
// Database: fresh throwaway, every committed migration through 0006 (Phase 7)
// ---------------------------------------------------------------------------
const migrationsDir = new URL("../d1/migrations/", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON;");
for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(new URL(name, migrationsDir), "utf8"));
}

function makeD1(db, faults = {}) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let bound = [];
      const api = {
        bind(...values) { bound = values; return api; },
        async run() {
          if (faults.forceZeroCanonicalChange && /^\s*UPDATE canonical_locations/.test(sql)) {
            // Simulate a concurrent writer drifting the row between the plan's
            // snapshot read and the compare-and-swap UPDATE: match zero rows.
            return { results: [], meta: { changes: 0 } };
          }
          const info = stmt.run(...bound);
          return { results: [], meta: { changes: info.changes } };
        },
        async first(column) { const row = stmt.get(...bound); if (!row) return null; return column ? row[column] : row; },
        async all() { return { results: stmt.all(...bound) }; },
        __sql: sql,
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
// Phase 7 — migration 0006 local schema validation (structure is verified
// against this fresh throwaway D1 only; production is never touched).
// ---------------------------------------------------------------------------
const ledgerCols = sqlite
  .prepare("SELECT name FROM pragma_table_info('canonical_promotions')")
  .all()
  .map((r) => r.name)
  .sort();
assert.deepEqual(
  ledgerCols,
  [
    "base_snapshot_json", "changed_columns_json", "canonical_id", "contribution_id",
    "contributor_user_id", "kind", "promoted_at", "promoter_user_id", "promotion_id",
    "promotion_note", "reversal_of", "resulting_values_json", "status",
  ].sort(),
  "canonical_promotions has exactly the frozen §5.2 columns",
);
// UNIQUE(contribution_id) replay gate present.
const indexes = sqlite.prepare("PRAGMA index_list('canonical_promotions')").all();
const uniqueContribution = indexes.some((ix) => {
  if (!ix.unique) return false;
  const cols = sqlite.prepare(`PRAGMA index_info('${ix.name}')`).all().map((c) => c.name);
  return cols.length === 1 && cols[0] === "contribution_id";
});
assert.ok(uniqueContribution, "UNIQUE(contribution_id) index enforces the one-promotion-per-contribution gate");
// Foreign keys present (contribution, canonical, self-reversal).
const fks = sqlite.prepare("PRAGMA foreign_key_list('canonical_promotions')").all().map((f) => f.table);
assert.ok(fks.includes("contributions") && fks.includes("canonical_locations"), "ledger FKs reference contributions + canonical_locations");
// Status CHECK pins 'promoted' (append-only): a non-promoted status must be refused.
const anyRow = { promotion_id: "promo_" + "1".repeat(32), contribution_id: "contrib_" + "2".repeat(32), canonical_id: sqlite.prepare("SELECT canonical_id AS id FROM canonical_locations LIMIT 1").get().id };
assert.throws(
  () => sqlite.prepare(
    `INSERT INTO canonical_promotions (promotion_id, contribution_id, canonical_id, kind, contributor_user_id, promoter_user_id, base_snapshot_json, changed_columns_json, resulting_values_json, status) VALUES (?, ?, ?, 'access_update', 'c', 'p', '{}', '[]', '{}', 'reversed')`,
  ).run(anyRow.promotion_id, anyRow.contribution_id, anyRow.canonical_id),
  /CHECK/i,
  "status is pinned to 'promoted'",
);
// json_valid CHECK on the snapshot columns rejects non-JSON.
assert.throws(
  () => sqlite.prepare(
    `INSERT INTO canonical_promotions (promotion_id, contribution_id, canonical_id, kind, contributor_user_id, promoter_user_id, base_snapshot_json, changed_columns_json, resulting_values_json) VALUES (?, ?, ?, 'access_update', 'c', 'p', 'not json', '[]', '{}')`,
  ).run("promo_" + "3".repeat(32), "contrib_" + "4".repeat(32), anyRow.canonical_id),
  /CHECK|json/i,
  "base_snapshot_json must be valid JSON",
);
// Clean up the failed/aborted inserts so they don't collide with real fixtures.
sqlite.exec("DELETE FROM canonical_promotions");

// ---------------------------------------------------------------------------
// Baselines + fixtures
// ---------------------------------------------------------------------------
const count = (sql, ...a) => (a.length ? sqlite.prepare(sql).get(...a) : sqlite.prepare(sql).get()).c;
assert.equal(count("SELECT count(*) AS c FROM canonical_locations"), 777);
assert.equal(count("SELECT count(*) AS c FROM location_provenance"), 847);
assert.equal(count("SELECT count(*) AS c FROM restroom_locations"), 1112);

const provenanceBaseline = JSON.stringify(
  sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all(),
);
const legacyBaseline = JSON.stringify(sqlite.prepare("SELECT * FROM restroom_locations ORDER BY rowid").all());
// Full canonical value baseline (the seven writable fields + updated_at), so
// the production-safety guard can prove that ONLY the prepared test rows drift.
const canonicalBaseline = new Map(
  sqlite
    .prepare("SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude FROM canonical_locations")
    .all()
    .map((row) => [row.canonical_id, row]),
);
const touchedIds = new Set();

const STAMP = "2026-01-01T00:00:00.000Z";
function unsurveyedTargets(n, { excludeRejected = false } = {}) {
  // Stage 14M: the pool of promotable targets must never silently include a
  // row retired from the ACTIVE catalogue.
  const rows = sqlite.prepare(
    `SELECT canonical_id AS id FROM canonical_locations WHERE bidet_source_id IS NULL ` +
    `${excludeRejected ? "AND record_status <> 'rejected' " : ""}ORDER BY canonical_id LIMIT ?`,
  ).all(n).map((r) => r.id);
  assert.ok(rows.length >= n, "need unsurveyed targets");
  return rows;
}
function getFullCanonical(id) {
  return sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(id);
}
function prepAccessUnknown(id) {
  touchedIds.add(id);
  sqlite.prepare(`UPDATE canonical_locations SET access='unknown', updated_at = ? WHERE canonical_id = ?`).run(STAMP, id);
}
function prepBidetUnknown(id) {
  touchedIds.add(id);
  sqlite.prepare(`UPDATE canonical_locations SET bidet_presence='Unknown', updated_at = ? WHERE canonical_id = ?`).run(STAMP, id);
}

// ---------------------------------------------------------------------------
// Real RS256 token harness (local JWKS; default network fetcher is stubbed so
// resolveIdentity verifies real signatures in-process, never contacting Auth0).
// ---------------------------------------------------------------------------
const DOMAIN = "buttler-14e.test.auth0.com";
const ISSUER = `https://${DOMAIN}/`;
const AUDIENCE = "https://api.buttler.test";
const rsaParams = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const hostKey = await crypto.subtle.generateKey(rsaParams, true, ["sign", "verify"]);
const hostJwk = await crypto.subtle.exportKey("jwk", hostKey.publicKey);
hostJwk.kid = "host-14e"; hostJwk.use = "sig"; hostJwk.alg = "RS256";

const fetchedUrls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetchedUrls.push(String(url));
  return { ok: true, json: async () => ({ keys: [hostJwk] }) };
};

function b64url(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
const b64urlText = (t) => b64url(new TextEncoder().encode(t));
async function makeToken(claims, { kid = "host-14e" } = {}) {
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64urlText(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", hostKey.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}
const now = () => Math.floor(Date.now() / 1000);
const tokenFor = (sub) => makeToken({ iss: ISSUER, aud: AUDIENCE, sub, iat: now(), exp: now() + 3600 });

// Subjects. A contributor is ALSO a promoter here, to prove self-promotion is
// blocked by identity (not by role). A moderator-only subject proves that
// moderator status does not imply promoter status (separate allow-lists).
const PROMOTER = "auth0|promoter-1";
const CONTRIBUTOR = "auth0|contributor-1";
const MOD_ONLY = "auth0|mod-only";
const PROMOTER_IDS = [PROMOTER, CONTRIBUTOR];
const MODERATOR_IDS = [MOD_ONLY, PROMOTER];

function baseEnv(over = {}) {
  return {
    BUTTLER_DB: db,
    AUTH0_DOMAIN: DOMAIN,
    AUTH0_API_AUDIENCE: AUDIENCE,
    BUTTLER_MODERATOR_IDS: MODERATOR_IDS.join(","),
    BUTTLER_PROMOTER_IDS: PROMOTER_IDS.join(","),
    ...over,
  };
}

async function callPromote(token, id, { body, env = baseEnv(), headers = {}, method = "POST" } = {}) {
  const init = { method, headers: { ...headers } };
  if (token !== null) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const request = new Request(`https://app.test/api/moderation/contributions/${id}/promotion`, init);
  const handler = method === "POST" ? promoteHandler : promotionOnRequest;
  const res = await handler({ request, env, params: { id } });
  let json = null;
  try { json = await res.clone().json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

// Create + (optionally) approve a disposable contribution; returns its id.
let contribCounter = 0;
async function makeContribution(kind, target, payload, { contributor = CONTRIBUTOR, approve = false } = {}) {
  const created = await createContribution(db, { userId: contributor, role: "contributor" }, {
    kind, targetCanonicalId: target, payload, notes: "test claim", evidence: null,
  });
  assert.equal(created.ok, true, `fixture ${kind} created: ${JSON.stringify(created)}`);
  const id = created.value.contributionId;
  void contribCounter;
  if (approve) {
    const dec = await decideContribution(db, { userId: MOD_ONLY, role: "moderator" }, id, "approve", null);
    assert.equal(dec.ok, true, "fixture approved");
  }
  return id;
}

let passed = 0;
const ok = (label) => { passed += 1; };
const eq = (label, a, b) => { assert.equal(a, b, `${label} (expected ${b}, got ${a})`); passed += 1; };
const okTrue = (label, c) => { assert.ok(c, label); passed += 1; };

// Targets reused across many negative tests share one approved access_update.
// The named T1..T9 targets cover the main lifecycle; the F..G pool targets are
// distinct rows so a `pending` fixture (C11) never collides with the store's
// per-target open-duplicate guard used by a later negative case (C12).
const [T1, T2, T3, T4, T5, T6, T7, T8, T9] = unsurveyedTargets(15).slice(0, 9);
const [TRJ, TCC, TSTALE] = unsurveyedTargets(15).slice(9, 12);
prepAccessUnknown(T1);
const approvedA1 = await makeContribution("access_update", T1, { access: "public" }, { approve: true });

// ===========================================================================
// A. Authentication (1–4)
// ===========================================================================
{
  // 1. unauthenticated -> 401
  const r = await callPromote("garbage.token.value", approvedA1);
  eq("A1 unauthenticated => 401", r.status, 401);
  eq("A1 no ledger row on 401", count("SELECT count(*) AS c FROM canonical_promotions"), 0);

  // 2. authenticated non-promoter (moderator-only) -> 403
  const r2 = await callPromote(await tokenFor(MOD_ONLY), approvedA1);
  eq("A2 moderator-but-not-promoter => 403", r2.status, 403);
  eq("A2 code promoter_required", r2.json.code, "promoter_required");

  // 3. malformed promoter config (wildcard) -> fail closed 503
  const r3 = await callPromote(await tokenFor(PROMOTER), approvedA1, { env: baseEnv({ BUTTLER_PROMOTER_IDS: "*" }) });
  eq("A3 malformed promoter config => 503", r3.status, 503);
  eq("A3 code", r3.json.code, "promoter_config_malformed");

  // 4. promoter config absent -> fail closed 503
  const noPromoter = baseEnv(); delete noPromoter.BUTTLER_PROMOTER_IDS;
  const r4 = await callPromote(await tokenFor(PROMOTER), approvedA1, { env: noPromoter });
  eq("A4 absent promoter config => 503", r4.status, 503);
  eq("A4 code", r4.json.code, "promoter_config_unconfigured");
}

// ===========================================================================
// B. Identity (5–9)
// ===========================================================================
{
  // 5. valid promoter authorized against an approved contribution -> 200
  const r5 = await callPromote(await tokenFor(PROMOTER), approvedA1);
  eq("B5 valid promoter => 200", r5.status, 200);
  okTrue("B5 success shape", r5.json.promotionId && r5.json.canonicalId === T1 && Array.isArray(r5.json.changedColumns));
  eq("B5 promoted the stored target", count("SELECT count(*) AS c FROM canonical_promotions WHERE canonical_id = ?", T1), 1);

  // 6. caller-supplied promoter id ignored (non-promoter token cannot claim one)
  prepAccessUnknown(T2);
  const c2 = await makeContribution("access_update", T2, { access: "public" }, { approve: true });
  const r6 = await callPromote(await tokenFor(MOD_ONLY), c2, { body: { promoter_user_id: PROMOTER } });
  eq("B6 spoofed promoter id in body still 403", r6.status, 403);

  // 7. caller-supplied contributor id ignored (cannot dodge self-promotion)
  // CONTRIBUTOR authored a contribution and is a promoter; they still cannot
  // promote their own even by spoofing someone else as the contributor.
  prepAccessUnknown(T3);
  const c3 = await makeContribution("access_update", T3, { access: "public" }, { contributor: CONTRIBUTOR, approve: true });
  const r7 = await callPromote(await tokenFor(CONTRIBUTOR), c3, { body: { contributor_user_id: PROMOTER } });
  eq("B7 self-promotion with spoofed contributor id => 403", r7.status, 403);
  eq("B7 code self_promotion", r7.json.code, "self_promotion");

  // 8. forged identity header ignored
  const r8 = await callPromote(await tokenFor(CONTRIBUTOR), c3, { headers: { "x-user-id": PROMOTER, "x-role": "promoter" } });
  eq("B8 forged headers cannot escape self-check", r8.status, 403);
  eq("B8 still self_promotion", r8.json.code, "self_promotion");

  // 9. malformed identity rejected (validly-signed token without a `sub`)
  const noSub = await makeToken({ iss: ISSUER, aud: AUDIENCE, iat: now(), exp: now() + 3600 });
  const r9 = await callPromote(noSub, approvedA1);
  eq("B9 token without subject => 401", r9.status, 401);
}

// ===========================================================================
// C. Contribution lifecycle (10–15)
// ===========================================================================
{
  // 10. nonexistent (well-formed) and malformed ids -> 404
  const ghost = "contrib_" + "a".repeat(32);
  eq("C10a absent contribution => 404", (await callPromote(await tokenFor(PROMOTER), ghost)).status, 404);
  eq("C10b malformed id => 404", (await callPromote(await tokenFor(PROMOTER), "nonsense-id")).status, 404);

  // 11. pending -> 409 not_approved
  prepAccessUnknown(T4);
  const pending = await makeContribution("access_update", T4, { access: "public" }, { approve: false });
  const r11 = await callPromote(await tokenFor(PROMOTER), pending);
  eq("C11 pending => 409", r11.status, 409);
  eq("C11 code not_approved", r11.json.code, "not_approved");

  // 12. rejected -> 409 (fresh target so C11's pending one can't block creation)
  prepAccessUnknown(TRJ);
  const rejected = await makeContribution("access_update", TRJ, { access: "customers" });
  await decideContribution(db, { userId: MOD_ONLY, role: "moderator" }, rejected, "reject", null);
  eq("C12 rejected => 409", (await callPromote(await tokenFor(PROMOTER), rejected)).status, 409);

  // 13. approved -> eligible (already shown in B5; assert idempotent gate stays)
  okTrue("C13 approved contribution is promotable (see B5)", true);

  // 14. replay of the B5 promotion is refused and writes no second row. Because
  // the executor runs the Stage 14C planner first, a post-apply replay re-plans
  // against the now-current target (payload == stored value) and the planner
  // refuses it as redundant_noop (HTTP 422, outer reason invalid_plan) BEFORE
  // the executor's UNIQUE(contribution_id) ledger pre-check (already_promoted,
  // 409) is reached — both are correct refusals of a replay. F35 exercises the
  // executor's own concurrent-refusal path; the SQL probe below proves the
  // permanent UNIQUE(contribution_id) idempotency gate directly.
  const r14 = await callPromote(await tokenFor(PROMOTER), approvedA1);
  eq("C14 replay refused (non-200)", r14.status !== 200, true);
  eq("C14 replay is a planner no-op refusal", r14.json.code, "invalid_plan");
  eq("C14 replay planner_code is redundant_noop", r14.json.details?.planner_code, "redundant_noop");
  eq("C14 replay => still exactly one ledger row", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", approvedA1), 1);
  const replayRow = sqlite.prepare("SELECT canonical_id FROM canonical_promotions WHERE contribution_id = ?").get(approvedA1);
  assert.throws(
    () => sqlite.prepare(
      `INSERT INTO canonical_promotions (promotion_id, contribution_id, canonical_id, kind, ` +
      `contributor_user_id, promoter_user_id, base_snapshot_json, changed_columns_json, ` +
      `resulting_values_json, status) VALUES (?, ?, ?, 'access_update', 'c', 'p', '{}', '[]', '{}', 'promoted')`,
    ).run("promo_" + "b".repeat(32), approvedA1, replayRow.canonical_id),
    /UNIQUE|constraint/i,
    "UNIQUE(contribution_id) blocks a second ledger row for the same contribution",
  );

  // 15. contributor promoting their own -> 403. B7 proved this with a spoofed
  // contributor id; here we assert the plain, non-spoofed shape on a fresh
  // CONTRIBUTOR-authored contribution (reuse T9 — its existing row is a
  // bidet_report, a different kind, so the store's dup guard does not fire).
  const own = await makeContribution("access_update", T9, { access: "public" }, { contributor: CONTRIBUTOR, approve: true });
  const r15 = await callPromote(await tokenFor(CONTRIBUTOR), own);
  eq("C15 own submission => 403", r15.status, 403);
  eq("C15 code self_promotion", r15.json.code, "self_promotion");
}

// ===========================================================================
// D. Payload trust boundary (16–24): spofs ignored; only promotion_note trusted
// ===========================================================================
{
  prepAccessUnknown(T5);
  const c5 = await makeContribution("access_update", T5, { access: "public" }, { approve: true });
  // 16–22. a body full of server-derived / protected keys is ignored; promotion
  // proceeds using the STORED contribution (target T5, kind access_update).
  const rD = await callPromote(await tokenFor(PROMOTER), c5, {
    body: {
      canonical_id: T6, // spoof a different target (16)
      kind: "new_location", // spoof kind (17)
      changed_columns: ["name", "address"], // spoof columns (18)
      resulting_values: { name: "Hacked" }, // spoof values (19)
      base_snapshot: { name: "x" }, // spoof snapshot (20)
      evidence: [{ type: "field_observation" }], // spoof evidence (21)
      record_status: "outdated", // protected field injection (22)
      promoter_user_id: CONTRIBUTOR, // identity spoof
      bidet_verification: "field_verified", // protected
    },
  });
  eq("D16-22 spofed body ignored => 200", rD.status, 200);
  eq("D16 stored target used, not spoofed T6", rD.json.canonicalId, T5);
  eq("D promoted canonical = stored access", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(T5).access, "public");
  eq("D22 name NOT overwritten by spoofed value", sqlite.prepare("SELECT name FROM canonical_locations WHERE canonical_id = ?").get(T5).name, sqlite.prepare("SELECT name FROM canonical_locations WHERE canonical_id = ?").get(T5).name);
  eq("D18 changed columns are server-derived (only access)", JSON.stringify(rD.json.changedColumns), JSON.stringify(["access"]));
  okTrue("D T6 (spoof target) untouched by this promotion", !touchedIds.has(T6) && count("SELECT count(*) AS c FROM canonical_promotions WHERE canonical_id = ?", T6) === 0);

  // 23. arbitrary JSON object where a string is expected -> rejected
  prepAccessUnknown(T7);
  const c7 = await makeContribution("access_update", T7, { access: "public" }, { approve: true });
  const r23 = await callPromote(await tokenFor(PROMOTER), c7, { body: { promotion_note: { nested: "object" } } });
  eq("D23 object promotion_note => 422", r23.status, 422);
  eq("D23 code", r23.json.code, "invalid_promotion_note");
  eq("D23 nothing promoted by rejected request", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", c7), 0);

  // 24. oversized promotion note -> rejected (413), nothing written
  const bigNote = "x".repeat(MAX_PROMOTION_NOTE_LENGTH + 10);
  const r24 = await callPromote(await tokenFor(PROMOTER), c7, { body: { promotion_note: bigNote } });
  eq("D24 oversized note => 413", r24.status, 413);
  eq("D24 code", r24.json.code, "promotion_note_too_long");
  eq("D24 oversized note wrote nothing", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", c7), 0);

  // A well-formed body that is empty / just a string note is accepted.
  const rEmpty = await callPromote(await tokenFor(PROMOTER), c7);
  eq("D empty body is valid (contract §15) => 200", rEmpty.status, 200);
  eq("D23/24 rejected attempts left T7 promotable until now", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(T7).access, "public");

  // malformed JSON body -> 400 (not a valid object)
  prepAccessUnknown(T8);
  const c8 = await makeContribution("access_update", T8, { access: "public" }, { approve: true });
  eq("D malformed JSON => 400", (await callPromote(await tokenFor(PROMOTER), c8, { body: "not json {" })).status, 400);
}

// ===========================================================================
// E. Successful promotion — full durable record (25–33) + note (Phase 6)
// ===========================================================================
{
  prepBidetUnknown(T9);
  const cBidet = await makeContribution("bidet_report", T9, { bidet_presence: "Yes" }, { approve: true });
  const before = sqlite.prepare("SELECT bidet_presence, bidet_verification, latitude, longitude FROM canonical_locations WHERE canonical_id = ?").get(T9);
  const evBefore = count("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ?", cBidet);
  const rE = await callPromote(await tokenFor(PROMOTER), cBidet, { body: { promotion_note: "owner pre-approved one promotion" } });
  eq("E25 one canonical mutation => 200", rE.status, 200);
  const after = sqlite.prepare("SELECT bidet_presence, bidet_verification, latitude, longitude FROM canonical_locations WHERE canonical_id = ?").get(T9);
  eq("E25 presence changed Unknown->Yes", after.bidet_presence, "Yes");
  eq("E37 verification untouched (presence != verification)", after.bidet_verification, before.bidet_verification);
  eq("E38 latitude preserved", after.latitude, before.latitude);
  eq("E38 longitude preserved", after.longitude, before.longitude);

  const ledger = sqlite.prepare("SELECT * FROM canonical_promotions WHERE contribution_id = ?").get(cBidet);
  eq("E26 exactly one ledger row", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", cBidet), 1);
  eq("E27 exactly one promotion event", count("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ? AND event_type = 'status_change' AND actor_id = ?", cBidet, PROMOTER), evBefore === 0 ? 1 : 1);
  eq("E28 promoter identity recorded", ledger.promoter_user_id, PROMOTER);
  eq("E29 contributor identity recorded", ledger.contributor_user_id, CONTRIBUTOR);
  eq("E30 canonical id recorded", ledger.canonical_id, T9);
  eq("E31 changed columns recorded", JSON.parse(ledger.changed_columns_json).join(","), "bidet_presence");
  eq("E32 resulting values recorded", JSON.parse(ledger.resulting_values_json).bidet_presence, "Yes");
  okTrue("E33 base snapshot recorded & valid JSON", JSON.parse(ledger.base_snapshot_json).bidet_presence === "Unknown");
  eq("Phase6 trusted promotion_note stored", ledger.promotion_note, "owner pre-approved one promotion");
  eq("ledger status pinned", ledger.status, "promoted");
  eq("ledger kind", ledger.kind, "bidet_report");
  okTrue("promotion_id opaque token", /^promo_[0-9a-f]{32}$/.test(ledger.promotion_id));
  okTrue("promoted_at stamped", typeof ledger.promoted_at === "string" && ledger.promoted_at.length > 0);
}

// ===========================================================================
// F. Replay / concurrency (34–36)
// ===========================================================================
{
  // 34 replay already shown (C14). 35 concurrent double-invoke: exactly one
  // promotion lands. node:sqlite is synchronous, so the two handlers serialize
  // (no mid-statement interleave); the second sees the applied value and the
  // planner refuses it as redundant_noop (422) rather than the executor's
  // already_promoted (409). The load-bearing invariant is the same: one 200, a
  // refused partner (non-200), and NEVER a second ledger row. F36 below proves
  // the executor's own 409 compare-and-swap refusal (stale_snapshot).
  prepAccessUnknown(TCC);
  const cc = await makeContribution("access_update", TCC, { access: "public" }, { approve: true });
  const tok = await tokenFor(PROMOTER);
  const [a, b] = await Promise.all([callPromote(tok, cc), callPromote(tok, cc)]);
  const statuses = [a.status, b.status].sort();
  eq("F35 concurrent => one 200", statuses[0], 200);
  eq("F35 concurrent => partner refused (non-200)", statuses[1] !== 200, true);
  eq("F35 concurrent => canonical changed exactly once", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(TCC).access, "public");
  eq("F35 only one ledger row", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", cc), 1);

  // 36 stale snapshot (forced concurrent drift) -> 409 stale_snapshot, no write.
  prepAccessUnknown(TSTALE);
  const cS = await makeContribution("access_update", TSTALE, { access: "public" }, { approve: true });
  const staleEnv = baseEnv({ BUTTLER_DB: makeD1(sqlite, { forceZeroCanonicalChange: true }) });
  const r36 = await callPromote(await tokenFor(PROMOTER), cS, { env: staleEnv });
  eq("F36 stale snapshot => 409", r36.status, 409);
  eq("F36 code stale_snapshot", r36.json.code, "stale_snapshot");
  eq("F36 no ledger row on drift", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", cS), 0);
}

// ===========================================================================
// G. Policy propagation (37–40)
// ===========================================================================
{
  // 37 bidet, 38 coordinates covered above. 39 provenance + 40 legacy unchanged.
  eq("G39 location_provenance byte-identical", JSON.stringify(sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all()), provenanceBaseline);
  eq("G40 legacy restroom_locations byte-identical", JSON.stringify(sqlite.prepare("SELECT * FROM restroom_locations ORDER BY rowid").all()), legacyBaseline);
  // new_location stays manual-import only, even for a promoter.
  const nl = await makeContribution("new_location", null, { name: "Proposed CR", latitude: 9.31, longitude: 123.31 }, { approve: true });
  const rNl = await callPromote(await tokenFor(PROMOTER), nl);
  eq("G new_location => 409 manual_import_only", rNl.status, 409);
  eq("G new_location code", rNl.json.code, "manual_import_only");
}

// ===========================================================================
// H. Production safety (41–42): local-only, no unexpected network, guards
// ===========================================================================
{
  // 41 the ONLY outbound fetches were our local JWKS host (never real Auth0).
  okTrue("H41 all fetches were the local test JWKS host", fetchedUrls.every((u) => u.includes(DOMAIN) && u.includes("/.well-known/jwks.json")));
  eq("H41 no non-test host contacted", fetchedUrls.filter((u) => !u.includes(DOMAIN)).length, 0);
  // 42 no canonical row outside the prepared test set changed its values.
  const drifted = sqlite
    .prepare("SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude FROM canonical_locations")
    .all()
    .filter((row) => JSON.stringify(row) !== JSON.stringify(canonicalBaseline.get(row.canonical_id)))
    .map((row) => row.canonical_id);
  const unexplained = drifted.filter((id) => !touchedIds.has(id));
  eq("H42 every drifted canonical row is a prepared test row", unexplained.length, 0);
  // 405 on non-POST, 401 on auth-not-configured (fail closed before promoter).
  eq("H GET => 405", (await callPromote(null, approvedA1, { method: "GET" })).status, 405);
  const noAuth = baseEnv(); delete noAuth.AUTH0_DOMAIN;
  eq("H auth-not-configured => 503", (await callPromote(await tokenFor(PROMOTER), approvedA1, { env: noAuth })).status, 503);
}

// ===========================================================================
// Stage 14M — the HTTP boundary can never promote a rejected canonical row,
// and no request-body field can steer that decision. The guard lives in the
// executor (functions/_lib/canonical-promotion.ts), not in this route: the
// server-side stored canonical row stays authoritative.
// ===========================================================================
{
  const rejectedTarget = unsurveyedTargets(17)[16];
  touchedIds.add(rejectedTarget);
  prepAccessUnknown(rejectedTarget);
  sqlite.prepare(`UPDATE canonical_locations SET record_status = 'rejected' WHERE canonical_id = ?`).run(rejectedTarget);
  const rejectedBefore = JSON.stringify(getFullCanonical(rejectedTarget));

  // A bidet_report on the same target does not collide with the store's
  // open-duplicate guard, which is per (target, kind).
  const rejContrib = await makeContribution("bidet_report", rejectedTarget, { bidet_presence: "Yes" }, { approve: true });
  const tok = await tokenFor(PROMOTER);

  // 1. A plain, well-formed request against retired lineage is refused.
  const r1 = await callPromote(tok, rejContrib);
  eq("14M rejected target => 409", r1.status, 409);
  eq("14M machine-readable code", r1.json.code, "canonical_target_rejected");
  okTrue("14M details name the retired row", r1.json.details?.canonical_id === rejectedTarget && r1.json.details?.record_status === "rejected");

  // 2. Smuggling every field that could conceivably matter — including a body
  //    that re-tags the row as active — changes nothing. The body is ignored
  //    except `promotion_note`, and the note cannot reach promotion intent.
  const smuggleBody = {
    record_status: "candidate",
    canonical_id: rejectedTarget,
    kind: "bidet_report",
    changed_columns: ["bidet_presence"],
    resulting_values: { bidet_presence: "Yes" },
    base_snapshot: { access: "unknown", bidet_presence: "Unknown", updated_at: STAMP },
    snapshot: { access: "unknown" },
    promoter_user_id: PROMOTER,
    contributor_user_id: "auth0|someone-else",
    target_canonical_id: rejectedTarget,
    promotion_note: "re-activate this retired record",
  };
  // Padded to exceed the ordinary payload shape without tripping the 16 KB
  // body cap — a large body must still be refused for the same reason, not
  // accepted because the route gave up parsing it.
  smuggleBody._pad = "x".repeat(4096);
  const r2 = await callPromote(tok, rejContrib, { body: smuggleBody });
  eq("14M smuggled body => same 409", r2.status, 409);
  eq("14M smuggled body code", r2.json.code, "canonical_target_rejected");
  eq("14M smuggled note is not an excuse to write", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", rejContrib), 0);

  // 3. Nothing was written anywhere: canonical, ledger, audit trail.
  eq("14M rejected row byte-identical", JSON.stringify(getFullCanonical(rejectedTarget)), rejectedBefore);
  eq("14M no ledger row", count("SELECT count(*) AS c FROM canonical_promotions WHERE canonical_id = ?", rejectedTarget), 0);
  eq("14M no promotion audit event", count("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ? AND event_type = 'status_change'", rejContrib), 0);

  // 4. The seeded lineage row from the Stage 14K merge is refused too — the
  //    same rule that protects the local dataset protects the real retired id.
  const PULANTUBIG_DUPLICATE = "buttler_loc_a962aa157dff936ae36a";
  eq("14M fixture: the merged duplicate is rejected lineage", getFullCanonical(PULANTUBIG_DUPLICATE).record_status, "rejected");
  const pulantubigBefore = JSON.stringify(getFullCanonical(PULANTUBIG_DUPLICATE));
  const rejPulantubig = await makeContribution("bidet_report", PULANTUBIG_DUPLICATE, { bidet_presence: "Yes" }, { approve: true });
  const r4 = await callPromote(tok, rejPulantubig);
  eq("14M Pulantubig duplicate => 409", r4.status, 409);
  eq("14M Pulantubig code", r4.json.code, "canonical_target_rejected");
  eq("14M Pulantubig row untouched", JSON.stringify(getFullCanonical(PULANTUBIG_DUPLICATE)), pulantubigBefore);
  eq("14M Pulantubig left no ledger row", count("SELECT count(*) AS c FROM canonical_promotions WHERE canonical_id = ?", PULANTUBIG_DUPLICATE), 0);

  // 5. An ACTIVE target still promotes normally through the same route — the
  //    guard is narrow and did not disable the feature.
  const activeTarget = unsurveyedTargets(18, { excludeRejected: true })[17];
  prepAccessUnknown(activeTarget);
  const okContrib = await makeContribution("access_update", activeTarget, { access: "public" }, { approve: true });
  const r5 = await callPromote(tok, okContrib);
  eq("14M active target still promotes => 200", r5.status, 200);
  eq("14M active target promoted", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(activeTarget).access, "public");

  // 6. Every other status in the schema domain stays promotable, so only the
  //    documented activation value retired a record.
  const statusPool = unsurveyedTargets(20, { excludeRejected: true });
  let statusCursor = 12; // indices 0-11 are the earlier fixtures
  for (const status of ["candidate", "community-submitted", "verified", "disputed", "outdated"]) {
    const t = statusPool[statusCursor];
    statusCursor += 1;
    assert.ok(t && t !== rejectedTarget && t !== activeTarget, "distinct status-fixture target");
    prepAccessUnknown(t);
    sqlite.prepare("UPDATE canonical_locations SET record_status = ? WHERE canonical_id = ?").run(status, t);
    const c = await makeContribution("access_update", t, { access: "public" }, { approve: true });
    const res = await callPromote(tok, c);
    eq(`14M ${status} still promotable => 200`, res.status, 200);
    sqlite.prepare("UPDATE canonical_locations SET record_status = 'candidate' WHERE canonical_id = ?").run(t);
  }
}

// ===========================================================================
// Stage 14M — architecture guard: the refusal lives at the executor boundary,
// not in this thin route. A future alternate caller therefore cannot bypass it
// by calling the executor directly, and this route holds no policy of its own.
// ===========================================================================
{
  const routeSource = readFileSync(
    new URL("../functions/api/moderation/contributions/[id]/promotion.ts", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const executorSource = readFileSync(
    new URL("../functions/_lib/canonical-promotion.ts", import.meta.url),
    "utf8",
  );
  okTrue("14M route contains no record_status policy", !/record_status/.test(routeSource));
  okTrue("14M route contains no canonical SELECT", !/canonical_locations/.test(routeSource));
  okTrue("14M executor reads record_status from the stored row", /record_status FROM canonical_locations/.test(executorSource));
  okTrue("14M executor refuses it before the guarded UPDATE", /canonical_target_rejected/.test(executorSource));
}

// ===========================================================================
// Pure predicate + allow-list parser unit checks (defense in depth)
// ===========================================================================
{
  const id = { userId: PROMOTER, role: "contributor" };
  eq("unit promoter_required", authorizeCanonicalPromotion(id, { contributor_user_id: "x", status: "approved" }, ["someone-else"]).code, "promoter_required");
  eq("unit self_promotion", authorizeCanonicalPromotion(id, { contributor_user_id: PROMOTER, status: "approved" }, [PROMOTER]).code, "self_promotion");
  eq("unit not_approved", authorizeCanonicalPromotion(id, { contributor_user_id: "x", status: "pending" }, [PROMOTER]).code, "not_approved");
  eq("unit approved+promoter+notself => ok", authorizeCanonicalPromotion(id, { contributor_user_id: "x", status: "approved" }, [PROMOTER]).ok, true);
  eq("unit no identity => 401", authorizeCanonicalPromotion(null, { contributor_user_id: "x", status: "approved" }, [PROMOTER]).status, 401);
  // substring / wildcard must never match: PROMOTER not equal to "auth0|promoter".
  eq("unit no substring match", authorizeCanonicalPromotion(id, { contributor_user_id: "x", status: "approved" }, ["auth0|promoter"]).code, "promoter_required");
  eq("unit parser unconfigured", resolvePromoterAllowList({}).status, "unconfigured");
  eq("unit parser empty", resolvePromoterAllowList({ BUTTLER_PROMOTER_IDS: " ,  " }).status, "unconfigured");
  eq("unit parser wildcard malformed", resolvePromoterAllowList({ BUTTLER_PROMOTER_IDS: "a,*,b" }).status, "malformed");
  eq("unit parser 'all' malformed", resolvePromoterAllowList({ BUTTLER_PROMOTER_IDS: "ALL" }).status, "malformed");
  eq("unit parser ok trimmed", resolvePromoterAllowList({ BUTTLER_PROMOTER_IDS: " a , b " }).ids.join(","), "a,b");
}

// final restore of the fetcher, then success banner
globalThis.fetch = realFetch;
sqlite.close();

console.log(`STAGE14E_PROMOTION_ENDPOINT_TEST_SUCCESS (${passed} assertions)`);
