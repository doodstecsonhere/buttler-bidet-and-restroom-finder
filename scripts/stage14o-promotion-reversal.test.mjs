// Stage 14 ownership completion — the contract §18 guarded promotion reversal.
//
// The frozen Stage 14A contract defines a reversal as a NEW, forward-appended
// `canonical_promotions` row (`reversal_of = <original promotion_id>`) that
// restores EXACTLY the guarded pre-promotion snapshot. Such a row necessarily
// shares the original's `contribution_id`, which migration 0006's
// UNIQUE(contribution_id) replay gate forbade — so migration 0009 (owner-
// approved) relaxed it to a plain index and duplicate-PROMOTION safety moved up
// into the executor + planner. This suite proves the reversal behaves to the
// §18 letter and that the relaxed index did NOT weaken any safety property.
//
// It exercises the REAL route handler (functions/api/moderation/promotions/
// [id]/reversal.ts) with REAL cryptographically-verified RS256 tokens (a local
// JWKS stands in for Auth0), so identity comes only from a signed bearer token.
//
// Required §18 properties proven here:
//   * promoter-gated + authenticated (fail-closed config, 401/403/503)
//   * explicit, forward-appended (new ledger row, history never edited/deleted)
//   * restores exactly the guarded pre-promotion snapshot
//   * refuses if the canonical row drifted (superseded_by_later_edit)
//   * refuses a second reversal of the same promotion (already_reversed)
//   * never targets rejected lineage (Stage 14M parity)
//   * prevents unauthorized / malformed / body-smuggled reversals
//   * links the reversal to the original promotion (reversal_of FK)
//   * optimistic compare-and-swap is NOT weakened to make reversal easier
//
// It NEVER touches a bound database, a Cloudflare account, or any secret, and
// runs zero production writes.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage14o-promotion-reversal.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { onRequestPost as reverseHandler, onRequest as reversalOnRequest } from "../functions/api/moderation/promotions/[id]/reversal.ts";
import { onRequestPost as promoteHandler } from "../functions/api/moderation/contributions/[id]/promotion.ts";
import { createContribution, decideContribution } from "../functions/_lib/contributions-store.ts";
import { authorizePromotionReversal } from "../lib/contributions/authorize.ts";
import { MAX_PROMOTION_NOTE_LENGTH } from "../lib/contributions/contract.ts";

// ---------------------------------------------------------------------------
// Database: fresh throwaway, every committed migration through 0009
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
            // Simulate a concurrent writer drifting the row between the
            // reversal's snapshot read and its compare-and-swap UPDATE.
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
// Schema proof: the 0009 index swap is present in the fresh database, so the
// rest of this suite genuinely relies on a second (reversal) row being legal.
// ---------------------------------------------------------------------------
{
  const ix = sqlite
    .prepare("PRAGMA index_list('canonical_promotions')")
    .all()
    .find((i) => sqlite.prepare(`PRAGMA index_info('${i.name}')`).all().some((c) => c.name === "contribution_id"));
  assert.ok(ix, "an index on contribution_id exists");
  assert.equal(ix.unique, 0, "0009 relaxed UNIQUE(contribution_id) so §18 reversals can append");
  // The self-referential reversal_of FK must still be enforced.
  const fks = sqlite.prepare("PRAGMA foreign_key_list('canonical_promotions')").all();
  assert.ok(fks.some((f) => f.table === "canonical_promotions"), "reversal_of FK references canonical_promotions");
}

// ---------------------------------------------------------------------------
// Baselines + fixtures
// ---------------------------------------------------------------------------
const count = (sql, ...a) => (a.length ? sqlite.prepare(sql).get(...a) : sqlite.prepare(sql).get()).c;
assert.equal(count("SELECT count(*) AS c FROM canonical_locations"), 777);

const provenanceBaseline = JSON.stringify(
  sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all(),
);
const legacyBaseline = JSON.stringify(sqlite.prepare("SELECT * FROM restroom_locations ORDER BY rowid").all());
const canonicalBaseline = new Map(
  sqlite
    .prepare("SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude FROM canonical_locations")
    .all()
    .map((row) => [row.canonical_id, row]),
);
const touchedIds = new Set();

const STAMP = "2026-01-01T00:00:00.000Z";
function unsurveyedTargets(n, { excludeRejected = false } = {}) {
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

// ---------------------------------------------------------------------------
// Real RS256 token harness (local JWKS; network fetcher stubbed so identity
// verifies signatures in-process and never contacts Auth0).
// ---------------------------------------------------------------------------
const DOMAIN = "buttler-14o.test.auth0.com";
const ISSUER = `https://${DOMAIN}/`;
const AUDIENCE = "https://api.buttler.test";
const rsaParams = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const hostKey = await crypto.subtle.generateKey(rsaParams, true, ["sign", "verify"]);
const hostJwk = await crypto.subtle.exportKey("jwk", hostKey.publicKey);
hostJwk.kid = "host-14o"; hostJwk.use = "sig"; hostJwk.alg = "RS256";

const fetchedUrls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetchedUrls.push(String(url));
  return { ok: true, json: async () => ({ keys: [hostJwk] }) };
};

function b64url(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
const b64urlText = (t) => b64url(new TextEncoder().encode(t));
async function makeToken(claims, { kid = "host-14o" } = {}) {
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64urlText(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", hostKey.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}
const now = () => Math.floor(Date.now() / 1000);
const tokenFor = (sub) => makeToken({ iss: ISSUER, aud: AUDIENCE, sub, iat: now(), exp: now() + 3600 });

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

// POST /api/moderation/contributions/{id}/promotion (to create a target).
async function callPromote(token, contributionId, { body, env = baseEnv(), method = "POST" } = {}) {
  const init = { method, headers: {} };
  if (token !== null) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const request = new Request(`https://app.test/api/moderation/contributions/${contributionId}/promotion`, init);
  const res = await promoteHandler({ request, env, params: { id: contributionId } });
  let json = null; try { json = await res.clone().json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// POST /api/moderation/promotions/{id}/reversal (the route under test).
async function callReverse(token, promotionId, { body, env = baseEnv(), headers = {}, method = "POST" } = {}) {
  const init = { method, headers: { ...headers } };
  if (token !== null) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const request = new Request(`https://app.test/api/moderation/promotions/${promotionId}/reversal`, init);
  const handler = method === "POST" ? reverseHandler : reversalOnRequest;
  const res = await handler({ request, env, params: { id: promotionId } });
  let json = null; try { json = await res.clone().json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function makeContribution(kind, target, payload, { contributor = CONTRIBUTOR, approve = false } = {}) {
  const created = await createContribution(db, { userId: contributor, role: "contributor" }, {
    kind, targetCanonicalId: target, payload, notes: "test claim", evidence: null,
  });
  assert.equal(created.ok, true, `fixture ${kind} created: ${JSON.stringify(created)}`);
  const id = created.value.contributionId;
  if (approve) {
    const dec = await decideContribution(db, { userId: MOD_ONLY, role: "moderator" }, id, "approve", null);
    assert.equal(dec.ok, true, "fixture approved");
  }
  return id;
}

// Create + approve + promote an access_update (unknown -> public). Returns the
// contribution id, the promotion ledger id, and the target.
async function promoteAccess(target) {
  prepAccessUnknown(target);
  const contributionId = await makeContribution("access_update", target, { access: "public" }, { approve: true });
  const r = await callPromote(await tokenFor(PROMOTER), contributionId);
  assert.equal(r.status, 200, `promote fixture => 200 (got ${r.status})`);
  return { contributionId, promotionId: r.json.promotionId, target };
}

let passed = 0;
const ok = (label) => { passed += 1; };
const eq = (label, a, b) => { assert.equal(a, b, `${label} (expected ${b}, got ${a})`); passed += 1; };
const okTrue = (label, c) => { assert.ok(c, label); passed += 1; };

// ===========================================================================
// A. Happy path — a guarded reversal restores the snapshot and appends history
// ===========================================================================
const [RA, RB, RC, RD, RE_, RF, RG, RH, RI, RJ] = unsurveyedTargets(16).slice(0, 10);
{
  const { contributionId, promotionId, target } = await promoteAccess(RA);
  // After promotion the canonical row reads the promoted value.
  eq("A promoted value present before reversal", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(target).access, "public");
  const originalRow = sqlite.prepare("SELECT * FROM canonical_promotions WHERE promotion_id = ?").get(promotionId);
  const eventsBefore = count("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ? AND event_type = 'status_change'", contributionId);

  const r = await callReverse(await tokenFor(PROMOTER), promotionId, { body: { reversal_note: "wrong facility, undo" } });
  eq("A reversal => 200", r.status, 200);
  okTrue("A success shape", r.json.reversalId && r.json.reversesPromotionId === promotionId && r.json.canonicalId === target);
  eq("A restored access to the base snapshot", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(target).access, "unknown");

  // Forward-append: TWO rows now share the contribution (only possible after
  // 0009 relaxed UNIQUE(contribution_id)); the original is untouched.
  eq("A exactly two ledger rows for the contribution (0009 allows the append)", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", contributionId), 2);
  eq("A original promotion row still present (history never deleted)", count("SELECT count(*) AS c FROM canonical_promotions WHERE promotion_id = ?", promotionId), 1);

  const reversalRow = sqlite.prepare("SELECT * FROM canonical_promotions WHERE promotion_id = ?").get(r.json.reversalId);
  eq("A reversal links to the original promotion", reversalRow.reversal_of, promotionId);
  eq("A reversal shares the contribution id", reversalRow.contribution_id, contributionId);
  eq("A reversal targets the same canonical row", reversalRow.canonical_id, target);
  eq("A reversal status pinned to 'promoted' (append-only)", reversalRow.status, "promoted");
  eq("A reversal kind matches original", reversalRow.kind, originalRow.kind);
  eq("A reversal contributor id copied from original", reversalRow.contributor_user_id, originalRow.contributor_user_id);
  eq("A reversal promoter is the reversing caller", reversalRow.promoter_user_id, PROMOTER);
  eq("A reversal changed columns == original", JSON.parse(reversalRow.changed_columns_json).join(","), JSON.parse(originalRow.changed_columns_json).join(","));
  okTrue("A reversal restores base value as its result", JSON.parse(reversalRow.resulting_values_json).access === "unknown");
  okTrue("A reversal snapshot is the value at reversal time", JSON.parse(reversalRow.base_snapshot_json).access === "public");
  eq("A reversal id is an opaque token", true, /^promo_[0-9a-f]{32}$/.test(reversalRow.promotion_id));
  okTrue("A reversal promoted_at stamped", typeof reversalRow.promoted_at === "string" && reversalRow.promoted_at.length > 0);
  eq("A trusted reversal_note stored", reversalRow.promotion_note, "wrong facility, undo");

  // Audit event appended inside the same phase-2 batch.
  eq("A exactly one reversal event appended", count("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ? AND event_type = 'status_change'", contributionId), eventsBefore + 1);
  const ev = sqlite.prepare(`SELECT detail_json FROM contribution_events WHERE contribution_id = ? ORDER BY rowid DESC LIMIT 1`).get(contributionId);
  okTrue("A reversal event names the action + link", JSON.parse(ev.detail_json).action === "canonical_promotion_reversed" && JSON.parse(ev.detail_json).reverses_promotion_id === promotionId);

  // The promoted value's provenance/legacy tables are never touched.
  eq("A location_provenance byte-identical", JSON.stringify(sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all()), provenanceBaseline);
  eq("A legacy restroom_locations byte-identical", JSON.stringify(sqlite.prepare("SELECT * FROM restroom_locations ORDER BY rowid").all()), legacyBaseline);
}

// ===========================================================================
// B. Authorization — promoter-gated, authenticated, fail-closed config
// ===========================================================================
{
  const { promotionId } = await promoteAccess(RB);
  // B1 unauthenticated -> 401
  eq("B1 unauthenticated => 401", (await callReverse("garbage.token.value", promotionId)).status, 401);
  eq("B1 no reversal on 401", count("SELECT count(*) AS c FROM canonical_promotions WHERE reversal_of = ?", promotionId), 0);
  // B2 authenticated non-promoter (moderator-only) -> 403
  const r2 = await callReverse(await tokenFor(MOD_ONLY), promotionId);
  eq("B2 moderator-but-not-promoter => 403", r2.status, 403);
  eq("B2 code promoter_required", r2.json.code, "promoter_required");
  // B3 malformed promoter config (wildcard) -> fail-closed 503
  eq("B3 malformed promoter config => 503", (await callReverse(await tokenFor(PROMOTER), promotionId, { env: baseEnv({ BUTTLER_PROMOTER_IDS: "*" }) })).status, 503);
  // B4 absent promoter config -> fail-closed 503
  const noPromoter = baseEnv(); delete noPromoter.BUTTLER_PROMOTER_IDS;
  eq("B4 absent promoter config => 503", (await callReverse(await tokenFor(PROMOTER), promotionId, { env: noPromoter })).status, 503);
  // B5 token without a subject -> 401
  const noSub = await makeToken({ iss: ISSUER, aud: AUDIENCE, iat: now(), exp: now() + 3600 });
  eq("B5 token without subject => 401", (await callReverse(noSub, promotionId)).status, 401);
  // B6 auth not configured -> 503 (fail closed before promoter resolution)
  const noAuth = baseEnv(); delete noAuth.AUTH0_DOMAIN;
  eq("B6 auth-not-configured => 503", (await callReverse(await tokenFor(PROMOTER), promotionId, { env: noAuth })).status, 503);
  // B7 GET is rejected (reversal is an explicit POST)
  eq("B7 GET => 405", (await callReverse(await tokenFor(PROMOTER), promotionId, { method: "GET" })).status, 405);
}

// ===========================================================================
// C. Idempotency — one forward append per promotion
// ===========================================================================
{
  const { contributionId, promotionId } = await promoteAccess(RC);
  const r1 = await callReverse(await tokenFor(PROMOTER), promotionId);
  eq("C first reversal => 200", r1.status, 200);
  const r2 = await callReverse(await tokenFor(PROMOTER), promotionId);
  eq("C second reversal => 409", r2.status, 409);
  eq("C code already_reversed", r2.json.code, "already_reversed");
  okTrue("C already_reversed names the existing reversal", r2.json.details?.reversal_id === r1.json.reversalId);
  eq("C no third ledger row", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", contributionId), 2);
  eq("C exactly one reversal of this promotion", count("SELECT count(*) AS c FROM canonical_promotions WHERE reversal_of = ?", promotionId), 1);
}

// ===========================================================================
// D. Drift — a later edit blocks the restore (superseded_by_later_edit)
// ===========================================================================
{
  const { contributionId, promotionId, target } = await promoteAccess(RD);
  const promoted = sqlite.prepare("SELECT * FROM canonical_locations WHERE canonical_id = ?").get(target);
  // A legitimate later edit (not this reversal) changes the promoted value.
  sqlite.prepare(`UPDATE canonical_locations SET access='customers' WHERE canonical_id = ?`).run(target);
  const r = await callReverse(await tokenFor(PROMOTER), promotionId);
  eq("D drifted row => 409", r.status, 409);
  eq("D code superseded_by_later_edit", r.json.code, "superseded_by_later_edit");
  okTrue("D drift detail names the column", (r.json.details?.drift ?? []).some((d) => d.column === "access"));
  eq("D later edit preserved (no partial restore)", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(target).access, "customers");
  eq("D no reversal appended on drift", count("SELECT count(*) AS c FROM canonical_promotions WHERE reversal_of = ?", promotionId), 0);
  eq("D ledger still one row", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", contributionId), 1);
  void promoted;
}

// ===========================================================================
// E. Rejected lineage — Stage 14M parity: a retired row is never writable
// ===========================================================================
{
  const { contributionId, promotionId, target } = await promoteAccess(RE_);
  // Retire the promoted row out from under the reversal.
  sqlite.prepare(`UPDATE canonical_locations SET record_status='rejected' WHERE canonical_id = ?`).run(target);
  const before = JSON.stringify(getFullCanonical(target));
  const r = await callReverse(await tokenFor(PROMOTER), promotionId);
  eq("E rejected target => 409", r.status, 409);
  eq("E code canonical_target_rejected", r.json.code, "canonical_target_rejected");
  eq("E rejected row untouched", JSON.stringify(getFullCanonical(target)), before);
  eq("E no reversal appended", count("SELECT count(*) AS c FROM canonical_promotions WHERE reversal_of = ?", promotionId), 0);
  void contributionId;
}

// ===========================================================================
// F. Not-found / malformed promotion id
// ===========================================================================
{
  eq("F1 well-formed but absent promotion id => 404", (await callReverse(await tokenFor(PROMOTER), "promo_" + "a".repeat(32))).status, 404);
  const rF2 = await callReverse(await tokenFor(PROMOTER), "nonsense-id");
  okTrue("F2 malformed id => 404", rF2.status === 404 || rF2.status === 422);
  eq("F code not_found", rF2.json.code, "not_found");
}

// ===========================================================================
// G. Body trust boundary — only a `reversal_note` string is honoured
// ===========================================================================
{
  const { promotionId, target } = await promoteAccess(RF);
  // G1 smuggle every field that could matter; the ledger row is the authority.
  const smuggle = {
    canonical_id: RG, // redirect the restore elsewhere
    restored_values: { access: "private" }, // invent a restore value
    changed_columns: ["name", "address"],
    base_snapshot: { access: "private" },
    promoter_user_id: MOD_ONLY,
    contributor_user_id: "auth0|someone-else",
    reversal_of: "promo_" + "c".repeat(32),
    _pad: "x".repeat(4096),
  };
  const r1 = await callReverse(await tokenFor(PROMOTER), promotionId, { body: smuggle });
  eq("G1 smuggled body ignored => 200", r1.status, 200);
  eq("G1 restores the STORED base value, not the smuggled one", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(target).access, "unknown");
  eq("G1 smuggled target RG untouched", count("SELECT count(*) AS c FROM canonical_promotions WHERE canonical_id = ?", RG), 0);
  eq("G1 reversal links the path id, not a smuggled one", sqlite.prepare("SELECT reversal_of FROM canonical_promotions WHERE promotion_id = ?").get(r1.json.reversalId).reversal_of, promotionId);

  // G2 object reversal_note -> 422
  const { promotionId: p2 } = await promoteAccess(RG);
  const r2 = await callReverse(await tokenFor(PROMOTER), p2, { body: { reversal_note: { nested: "obj" } } });
  eq("G2 object reversal_note => 422", r2.status, 422);
  eq("G2 code", r2.json.code, "invalid_reversal_note");
  // G3 oversized reversal_note -> 413, nothing written
  const big = "x".repeat(MAX_PROMOTION_NOTE_LENGTH + 10);
  const r3 = await callReverse(await tokenFor(PROMOTER), p2, { body: { reversal_note: big } });
  eq("G3 oversized note => 413", r3.status, 413);
  eq("G3 code", r3.json.code, "reversal_note_too_long");
  eq("G3 rejected attempts appended nothing", count("SELECT count(*) AS c FROM canonical_promotions WHERE reversal_of = ?", p2), 0);
  // G4 malformed JSON body -> 400
  eq("G4 malformed JSON => 400", (await callReverse(await tokenFor(PROMOTER), p2, { body: "not json {" })).status, 400);
  // G5 empty body is valid (§15: metadata optional)
  const r5 = await callReverse(await tokenFor(PROMOTER), p2);
  eq("G5 empty body => 200", r5.status, 200);
}

// ===========================================================================
// H. Optimistic concurrency is NOT weakened — CAS still guards the restore
// ===========================================================================
{
  const { contributionId, promotionId, target } = await promoteAccess(RH);
  // Force the phase-1 compare-and-swap UPDATE to match zero rows (a concurrent
  // writer landed between the snapshot read and the guarded UPDATE).
  const staleEnv = baseEnv({ BUTTLER_DB: makeD1(sqlite, { forceZeroCanonicalChange: true }) });
  const r = await callReverse(await tokenFor(PROMOTER), promotionId, { env: staleEnv });
  eq("H concurrent drift => 409", r.status, 409);
  eq("H code superseded_by_later_edit", r.json.code, "superseded_by_later_edit");
  okTrue("H marks it concurrent", r.json.details?.concurrent === true);
  eq("H no reversal row appended on a lost CAS", count("SELECT count(*) AS c FROM canonical_promotions WHERE reversal_of = ?", promotionId), 0);
  eq("H ledger still one row", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", contributionId), 1);
  void target;
}

// ===========================================================================
// I. Forward chain — a reversal can itself be reversed (re-apply), still
//    append-only, never editing or deleting the prior rows.
// ===========================================================================
{
  const { contributionId, promotionId, target } = await promoteAccess(RI);
  const first = await callReverse(await tokenFor(PROMOTER), promotionId);
  eq("I first reversal => 200", first.status, 200);
  eq("I access restored to unknown", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(target).access, "unknown");
  const second = await callReverse(await tokenFor(PROMOTER), first.json.reversalId);
  eq("I reversing a reversal => 200 (forward chain)", second.status, 200);
  eq("I access re-applied to public", sqlite.prepare("SELECT access FROM canonical_locations WHERE canonical_id = ?").get(target).access, "public");
  eq("I three append-only rows, none edited", count("SELECT count(*) AS c FROM canonical_promotions WHERE contribution_id = ?", contributionId), 3);
  eq("I second reversal links the first", sqlite.prepare("SELECT reversal_of FROM canonical_promotions WHERE promotion_id = ?").get(second.json.reversalId).reversal_of, first.json.reversalId);
  eq("I original promotion row untouched", count("SELECT count(*) AS c FROM canonical_promotions WHERE promotion_id = ? AND reversal_of IS NULL", promotionId), 1);
}

// ===========================================================================
// J. Architecture guard — the thin route holds no policy; the executor does
// ===========================================================================
{
  const routeSource = readFileSync(
    new URL("../functions/api/moderation/promotions/[id]/reversal.ts", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const executorSource = readFileSync(
    new URL("../functions/_lib/canonical-promotion.ts", import.meta.url),
    "utf8",
  );
  okTrue("J route holds no record_status policy", !/record_status/.test(routeSource));
  okTrue("J route holds no canonical SELECT", !/canonical_locations/.test(routeSource));
  okTrue("J route ignores body except reversal_note", !/changed_columns|resulting_values|base_snapshot/.test(routeSource));
  okTrue("J executor performs the guarded restore", /executeCanonicalPromotionReversal/.test(executorSource));
  okTrue("J executor refuses rejected lineage", /canonical_target_rejected/.test(executorSource));
  okTrue("J executor links reversal_of", /reversal_of/.test(executorSource));
}

// ===========================================================================
// K. Pure predicate unit checks (defense in depth)
// ===========================================================================
{
  const id = { userId: PROMOTER, role: "contributor" };
  eq("K promoter ok", authorizePromotionReversal(id, PROMOTER_IDS).ok, true);
  eq("K promoter_required", authorizePromotionReversal({ userId: MOD_ONLY, role: "moderator" }, PROMOTER_IDS).code, "promoter_required");
  eq("K no identity => 401", authorizePromotionReversal(null, PROMOTER_IDS).status, 401);
  eq("K identity without subject => 401", authorizePromotionReversal({ userId: "", role: "promoter" }, PROMOTER_IDS).code, "identity_missing");
  // substring must never match: PROMOTER is not equal to "auth0|promoter".
  eq("K no substring match", authorizePromotionReversal(id, ["auth0|promoter"]).code, "promoter_required");
}

// ===========================================================================
// L. Production safety — local-only, no unexpected network, no drift outside
//    the prepared fixtures.
// ===========================================================================
{
  okTrue("L all fetches were the local test JWKS host", fetchedUrls.every((u) => u.includes(DOMAIN) && u.includes("/.well-known/jwks.json")));
  eq("L no non-test host contacted", fetchedUrls.filter((u) => !u.includes(DOMAIN)).length, 0);
  const drifted = sqlite
    .prepare("SELECT canonical_id, updated_at, access, fee, bidet_presence, name, address, latitude, longitude FROM canonical_locations")
    .all()
    .filter((row) => JSON.stringify(row) !== JSON.stringify(canonicalBaseline.get(row.canonical_id)))
    .map((row) => row.canonical_id);
  const unexplained = drifted.filter((id) => !touchedIds.has(id));
  eq("L every drifted canonical row is a prepared fixture", unexplained.length, 0);
  okTrue("L some fixtures were exercised", touchedIds.size > 0);
  void RJ;
}

// final restore of the fetcher, then success banner
globalThis.fetch = realFetch;
sqlite.close();

console.log(`STAGE14O_PROMOTION_REVERSAL_TEST_SUCCESS (${passed} assertions)`);
