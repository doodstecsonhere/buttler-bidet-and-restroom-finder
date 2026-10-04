// Buttler 2.0 — Stage 14N contributor self-withdrawal test.
//
// Proves the narrow authenticated withdrawal lifecycle reuses the existing
// Stage 13 identity / authorization / HTTP / store seams and NOTHING else: an
// owner moves only their OWN pre-terminal contribution to `withdrawn`, the row
// and its payload / evidence / canonical target / contributor identity are
// preserved (never deleted), exactly one `withdrawn` event is appended, a
// replay or a lost race appends no second event, and no request-body field can
// steer identity, status, event type, or canonical targets. It exercises the
// REAL route handler with REAL cryptographically-verified RS256 tokens against
// a local JWKS (a stand-in for Auth0), so contributor identity comes only from
// a signed bearer token — never a header/body/query field.
//
// It applies the committed migrations to a throwaway in-memory SQLite and
// asserts canonical_locations, location_provenance, and canonical_promotions
// are byte-identical around a withdrawal. It NEVER touches a bound database, a
// Cloudflare account, or any secret, and runs zero production writes.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage14n-contributor-withdrawal.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  onRequestPost as withdrawHandler,
  onRequest as withdrawOnRequest,
} from "../functions/api/me/contributions/[id]/withdraw.ts";
import {
  createContribution,
  decideContribution,
  withdrawContribution,
} from "../functions/_lib/contributions-store.ts";
import { authorizeWithdraw } from "../lib/contributions/authorize.ts";

// ---------------------------------------------------------------------------
// Database: fresh throwaway, every committed migration (0005 holds the
// contributions + contribution_events tables and their lifecycle CHECKs).
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
          if (
            faults.forceZeroWithdrawChange &&
            /UPDATE contributions[\s\S]*SET status = 'withdrawn'/i.test(sql)
          ) {
            // Simulate losing a compare-and-swap race: the guarded transition
            // matches zero rows (another writer already moved the row).
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
// Baselines + production-safety snapshots
// ---------------------------------------------------------------------------
const count = (sql, ...a) => (a.length ? sqlite.prepare(sql).get(...a) : sqlite.prepare(sql).get()).c;
assert.equal(count("SELECT count(*) AS c FROM canonical_locations"), 777);
assert.equal(count("SELECT count(*) AS c FROM location_provenance"), 847);
assert.equal(count("SELECT count(*) AS c FROM restroom_locations"), 1112);

const CANON = () =>
  JSON.stringify(sqlite.prepare("SELECT * FROM canonical_locations ORDER BY canonical_id").all());
const PROVENANCE = () =>
  JSON.stringify(sqlite.prepare("SELECT * FROM location_provenance ORDER BY canonical_id, source_link_id").all());
const PROMOTIONS = () =>
  JSON.stringify(sqlite.prepare("SELECT * FROM canonical_promotions ORDER BY rowid").all());

const canonicalBefore = CANON();
const provenanceBefore = PROVENANCE();
const promotionsBefore = PROMOTIONS();
assert.equal(count("SELECT count(*) AS c FROM canonical_promotions"), 0, "no promotions exist at baseline");

const realId = sqlite.prepare("SELECT canonical_id AS id FROM canonical_locations ORDER BY canonical_id LIMIT 1").get().id;
const realId2 = sqlite.prepare("SELECT canonical_id AS id FROM canonical_locations ORDER BY canonical_id LIMIT 1 OFFSET 1").get().id;

// Distinct canonical targets for fixtures: the store's open-duplicate guard is
// per (target, kind), so every disposable contribution gets its own row and the
// fixtures never collide with each other.
const targetPool = sqlite
  .prepare("SELECT canonical_id AS id FROM canonical_locations ORDER BY canonical_id LIMIT 200")
  .all()
  .map((r) => r.id);
let targetCursor = 0;

// ---------------------------------------------------------------------------
// Real RS256 token harness (local JWKS; default fetcher stubbed so the identity
// seam verifies real signatures in-process, never contacting Auth0).
// ---------------------------------------------------------------------------
const DOMAIN = "buttler-14n.test.auth0.com";
const ISSUER = `https://${DOMAIN}/`;
const AUDIENCE = "https://api.buttler.test";
const rsaParams = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const hostKey = await crypto.subtle.generateKey(rsaParams, true, ["sign", "verify"]);
const hostJwk = await crypto.subtle.exportKey("jwk", hostKey.publicKey);
hostJwk.kid = "host-14n"; hostJwk.use = "sig"; hostJwk.alg = "RS256";

const fetchedUrls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetchedUrls.push(String(url));
  return { ok: true, json: async () => ({ keys: [hostJwk] }) };
};

function b64url(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
const b64urlText = (t) => b64url(new TextEncoder().encode(t));
async function makeToken(claims, { kid = "host-14n" } = {}) {
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64urlText(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", hostKey.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}
const now = () => Math.floor(Date.now() / 1000);
const tokenFor = (sub) => makeToken({ iss: ISSUER, aud: AUDIENCE, sub, iat: now(), exp: now() + 3600 });

// Subjects. OWNER and OTHER are ordinary contributors; MOD is a moderator. The
// moderator is on BUTTLER_MODERATOR_IDS so its resolved role is "moderator" —
// used to prove a moderator CANNOT withdraw another contributor's row here.
const OWNER = "auth0|owner-14n";
const OTHER = "auth0|other-14n";
const MOD = "auth0|mod-14n";
const MODERATOR_IDS = [MOD];

function baseEnv(over = {}) {
  return {
    BUTTLER_DB: db,
    AUTH0_DOMAIN: DOMAIN,
    AUTH0_API_AUDIENCE: AUDIENCE,
    BUTTLER_MODERATOR_IDS: MODERATOR_IDS.join(","),
    ...over,
  };
}

async function callWithdraw(token, id, { body, env = baseEnv(), headers = {}, method = "POST" } = {}) {
  const init = { method, headers: { ...headers } };
  if (token !== null) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const request = new Request(`https://app.test/api/me/contributions/${id}/withdraw`, init);
  const handler = method === "POST" ? withdrawHandler : withdrawOnRequest;
  const res = await handler({ request, env, params: { id } });
  let json = null;
  try { json = await res.clone().json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

// Owner-authored pending contribution on a fresh canonical target.
async function makeOwnContribution() {
  const target = targetPool[targetCursor++];
  assert.ok(target, "fixture pool exhausted — add more targets");
  const created = await createContribution(db, { userId: OWNER, role: "contributor" }, {
    kind: "fee_update",
    targetCanonicalId: target,
    payload: { fee: "yes" },
    notes: "original note",
    evidence: [{ type: "field_observation", detail: "I paid 10 pesos" }],
  });
  assert.equal(created.ok, true, `fixture created: ${JSON.stringify(created)}`);
  return created.value.contributionId;
}

function getContrib(id) {
  return sqlite.prepare("SELECT * FROM contributions WHERE contribution_id = ?").get(id);
}
function withdrawEvents(id) {
  return count("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ? AND event_type = 'withdrawn'", id);
}
function lastWithdrawEvent(id) {
  return sqlite
    .prepare("SELECT * FROM contribution_events WHERE contribution_id = ? AND event_type = 'withdrawn' ORDER BY created_at DESC LIMIT 1")
    .get(id);
}

let passed = 0;
const eq = (label, a, b) => { assert.equal(a, b, `${label} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); passed += 1; };
const okTrue = (label, c) => { assert.ok(c, label); passed += 1; };
const deepEq = (label, a, b) => { assert.deepEqual(a, b, label); passed += 1; };

// ===========================================================================
// 1 + 5 + 13 + 14 + 18. Authenticated owner withdraws own eligible (pending)
// contribution: row kept, payload/evidence preserved, exactly one withdrawn
// event, actor + decision identity come from the SERVER token.
// ===========================================================================
{
  const id = await makeOwnContribution();
  const before = getContrib(id);
  const r = await callWithdraw(await tokenFor(OWNER), id);
  eq("1 owner withdraw => 200", r.status, 200);
  eq("1 response status withdrawn", r.json.status, "withdrawn");
  eq("1 response echoes stored id", r.json.contributionId, id);

  const after = getContrib(id);
  // 13: row retained (same primary key, still present).
  eq("13 contribution row retained", after.contribution_id, id);
  eq("13 status is withdrawn", after.status, "withdrawn");
  okTrue("13 decided_at stamped (schema CHECK requires it)", after.decided_at !== null && after.decided_at.length > 0);
  // 5: identity is the verified token subject, not anything a body supplied.
  eq("5 decided_by is the server-derived subject", after.decided_by, OWNER);
  // 14: payload / evidence / canonical target / notes preserved verbatim.
  eq("14 payload_json preserved", after.payload_json, before.payload_json);
  eq("14 evidence_json preserved", after.evidence_json, before.evidence_json);
  eq("14 notes preserved", after.notes, before.notes);
  eq("14 target_canonical_id preserved", after.target_canonical_id, before.target_canonical_id);
  eq("14 contributor_user_id preserved", after.contributor_user_id, before.contributor_user_id);
  eq("14 validation_status untouched (not a moderator decision)", after.validation_status, "not_validated");

  // 18: exactly one withdrawal event, correct actor + transition.
  eq("18 exactly one withdrawn event", withdrawEvents(id), 1);
  const ev = lastWithdrawEvent(id);
  eq("18 event actor_type contributor", ev.actor_type, "contributor");
  eq("18 event actor_id = token subject", ev.actor_id, OWNER);
  eq("18 event from_status", ev.from_status, "pending");
  eq("18 event to_status", ev.to_status, "withdrawn");
}

// ===========================================================================
// Eligible pre-terminal states: validated and needs_review also withdrawable.
// ===========================================================================
{
  const vId = await makeOwnContribution();
  sqlite.prepare(`UPDATE contributions SET status = 'validated' WHERE contribution_id = ?`).run(vId);
  const rv = await callWithdraw(await tokenFor(OWNER), vId);
  eq("pending->validated eligible: withdraw => 200", rv.status, 200);
  eq("validated withdraw appends one event", withdrawEvents(vId), 1);
  eq("validated event from_status", lastWithdrawEvent(vId).from_status, "validated");

  const nId = await makeOwnContribution();
  sqlite.prepare(`UPDATE contributions SET status = 'needs_review' WHERE contribution_id = ?`).run(nId);
  const rn = await callWithdraw(await tokenFor(OWNER), nId);
  eq("needs_review eligible: withdraw => 200", rn.status, 200);
  eq("needs_review withdraw appends one event", withdrawEvents(nId), 1);
}

// ===========================================================================
// 2. Unauthenticated / misconfigured callers are rejected (fail closed).
// ===========================================================================
{
  const id = await makeOwnContribution();
  // No valid token (signed-out): Auth0 configured but garbage bearer => 401.
  eq("2 garbage token => 401", (await callWithdraw("garbage.token.value", id)).status, 401);
  // No auth provider wired => 503 (never a silent write).
  const noAuth = baseEnv(); delete noAuth.AUTH0_DOMAIN;
  eq("2 auth-not-configured => 503", (await callWithdraw(await tokenFor(OWNER), id, { env: noAuth })).status, 503);
  eq("2 rejected attempts appended no event", withdrawEvents(id), 0);
  eq("2 rejected attempts left row pending", getContrib(id).status, "pending");
}

// ===========================================================================
// 3 + 4. Ownership: another contributor AND a moderator both cannot withdraw
// someone else's row (404 — existence not leaked, moderator not privileged).
// ===========================================================================
{
  const id = await makeOwnContribution();
  eq("3 other contributor => 404", (await callWithdraw(await tokenFor(OTHER), id)).status, 404);
  eq("4 moderator via this endpoint => 404", (await callWithdraw(await tokenFor(MOD), id)).status, 404);
  eq("3/4 no event appended by non-owners", withdrawEvents(id), 0);
  eq("3/4 row still pending", getContrib(id).status, "pending");
}

// ===========================================================================
// 6-12. Trust boundary: a body full of server-derived / protected keys is
// ignored. The transition still uses ONLY stored state + the token subject.
// ===========================================================================
{
  const id = await makeOwnContribution();
  const before = getContrib(id);
  const smuggle = {
    contributor_user_id: OTHER,          // 6 spoof ownership
    actor_user_id: MOD,                   // 9 spoof actor
    actor_id: MOD,                        // 9 spoof actor (alt key)
    decided_by: MOD,                      // 9 spoof decision actor
    status: "approved",                   // 7 spoof status
    validation_status: "passed",          // 8 spoof validation
    event_type: "moderation_decision",    // 10 spoof event type
    canonical_id: realId2,                // 11 spoof canonical target
    target_canonical_id: realId2,         // 11 spoof target (alt key)
    kind: "access_update",                // protected
    payload: { fee: "no", hacked: true }, // 12 spoof payload
    evidence: [{ type: "forged" }],       // 12 spoof evidence
    notes: "rewritten",                   // 12 spoof notes
    moderation_note: "self-approved",     // 12 spoof moderation field
  };
  const r = await callWithdraw(await tokenFor(OWNER), id, { body: smuggle });
  eq("6-12 smuggled body ignored => 200", r.status, 200);
  const after = getContrib(id);
  eq("6 ownership still server-derived (owner)", after.contributor_user_id, before.contributor_user_id);
  eq("7 forged status did NOT become approved", after.status, "withdrawn");
  eq("8 forged validation_status ignored", after.validation_status, "not_validated");
  eq("11 forged canonical target ignored", after.target_canonical_id, before.target_canonical_id);
  eq("12 forged payload ignored", after.payload_json, before.payload_json);
  eq("12 forged evidence ignored", after.evidence_json, before.evidence_json);
  eq("12 forged notes ignored", after.notes, before.notes);
  eq("12 forged moderation_note ignored", after.moderation_note, before.moderation_note);
  eq("9 forged actor did NOT stamp decided_by", after.decided_by, OWNER);
  eq("18 one event total", withdrawEvents(id), 1);
  eq("10 forged event_type ignored (real event is 'withdrawn')", lastWithdrawEvent(id).event_type, "withdrawn");
  eq("9 event actor is token subject", lastWithdrawEvent(id).actor_id, OWNER);
}

// ===========================================================================
// 19 + 20. Replay safety + concurrency: never two withdrawal events.
// ===========================================================================
{
  // 19 sequential replay: second call refused, still exactly one event.
  const id = await makeOwnContribution();
  eq("19 first withdraw => 200", (await callWithdraw(await tokenFor(OWNER), id)).status, 200);
  eq("19 replay refused (non-200)", (await callWithdraw(await tokenFor(OWNER), id)).status !== 200, true);
  eq("19 replay => still exactly one event", withdrawEvents(id), 1);

  // 20 concurrent double-invoke on the same fresh row: one lands, the partner
  // is refused, and there is NEVER a second event. node:sqlite is synchronous,
  // so the guarded UPDATE compare-and-swap is the load-bearing invariant.
  const cid = await makeOwnContribution();
  const tok = await tokenFor(OWNER);
  const [a, b] = await Promise.all([callWithdraw(tok, cid), callWithdraw(tok, cid)]);
  const codes = [a.status, b.status].sort();
  eq("20 concurrent => one 200", codes[0], 200);
  okTrue("20 concurrent => partner refused (non-200)", codes[1] !== 200);
  eq("20 concurrent => exactly one withdrawn event", withdrawEvents(cid), 1);
  eq("20 concurrent => row is withdrawn", getContrib(cid).status, "withdrawn");

  // 20b direct CAS-loss guard: force the transition to match zero rows even
  // though the pre-check passed, proving no event is appended on a lost race.
  const rid = await makeOwnContribution();
  const raceDb = makeD1(sqlite, { forceZeroWithdrawChange: true });
  const lost = await withdrawContribution(raceDb, { userId: OWNER, role: "contributor" }, rid);
  eq("20b lost CAS => refused 409", lost.ok, false);
  eq("20b lost CAS => status 409", lost.status, 409);
  eq("20b lost CAS => no event appended", withdrawEvents(rid), 0);
  eq("20b lost CAS => row untouched", getContrib(rid).status, "pending");
}

// ===========================================================================
// 21. Invalid terminal-state transitions are deterministic (409) and append
// nothing: approved / rejected / withdrawn / superseded.
// ===========================================================================
{
  // approved (decided by a moderator first)
  const aId = await makeOwnContribution();
  const app = await decideContribution(db, { userId: MOD, role: "moderator" }, aId, "approve", null);
  eq("21 fixture approved", app.ok, true);
  const ra = await callWithdraw(await tokenFor(OWNER), aId);
  eq("21 approved => 409", ra.status, 409);
  eq("21 approved => no withdrawn event", withdrawEvents(aId), 0);

  // rejected
  const rId = await makeOwnContribution();
  await decideContribution(db, { userId: MOD, role: "moderator" }, rId, "reject", "not enough detail");
  const rr = await callWithdraw(await tokenFor(OWNER), rId);
  eq("21 rejected => 409", rr.status, 409);
  eq("21 rejected => stays rejected", getContrib(rId).status, "rejected");
  eq("21 rejected => no withdrawn event", withdrawEvents(rId), 0);

  // withdrawn (already withdrawn — replay case)
  const wId = await makeOwnContribution();
  await withdrawContribution(db, { userId: OWNER, role: "contributor" }, wId);
  const rw = await callWithdraw(await tokenFor(OWNER), wId);
  eq("21 withdrawn => 409", rw.status, 409);
  eq("21 withdrawn => still one event", withdrawEvents(wId), 1);

  // superseded
  const sId = await makeOwnContribution();
  sqlite.prepare(`UPDATE contributions SET status = 'superseded', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_by = ? WHERE contribution_id = ?`).run(MOD, sId);
  const rs = await callWithdraw(await tokenFor(OWNER), sId);
  eq("21 superseded => 409", rs.status, 409);
  eq("21 superseded => no withdrawn event", withdrawEvents(sId), 0);

  // malformed / absent id => 404
  eq("21 malformed id => 404", (await callWithdraw(await tokenFor(OWNER), "not-a-contrib-id")).status, 404);
  eq("21 absent well-formed id => 404", (await callWithdraw(await tokenFor(OWNER), "contrib_" + "f".repeat(32))).status, 404);
}

// ===========================================================================
// 22. Existing moderation behavior unchanged: a moderator can still reject a
// contributor's row, and a contributor still cannot decide via moderation.
// ===========================================================================
{
  const mId = await makeOwnContribution();
  eq("22 contributor cannot moderate own row (403)", (await decideContribution(db, { userId: OWNER, role: "contributor" }, mId, "approve", null)).status, 403);
  const mres = await decideContribution(db, { userId: MOD, role: "moderator" }, mId, "reject", "rejected by moderator");
  eq("22 moderator reject still works", mres.ok, true);
  eq("22 moderation decision event recorded", count("SELECT count(*) AS c FROM contribution_events WHERE contribution_id = ? AND event_type = 'moderation_decision' AND actor_id = ?", mId, MOD), 1);
  eq("22 moderation note recorded", getContrib(mId).moderation_note, "rejected by moderator");
  // A moderator reject is NOT a withdrawal: no 'withdrawn' event on this row.
  eq("22 moderation path creates no withdrawn event", withdrawEvents(mId), 0);
}

// ===========================================================================
// Pure predicate unit checks (defense in depth) — authorizeWithdraw rules.
// ===========================================================================
{
  eq("unit owner pre-terminal => ok", authorizeWithdraw({ userId: OWNER, role: "contributor" }, { contributor_user_id: OWNER, status: "pending" }).ok, true);
  eq("unit no identity => 401", authorizeWithdraw(null, { contributor_user_id: OWNER, status: "pending" }).status, 401);
  eq("unit non-owner => 404", authorizeWithdraw({ userId: OTHER, role: "contributor" }, { contributor_user_id: OWNER, status: "pending" }).status, 404);
  // A moderator is NOT privileged here — same 404 as any non-owner.
  eq("unit moderator non-owner => 404", authorizeWithdraw({ userId: MOD, role: "moderator" }, { contributor_user_id: OWNER, status: "pending" }).status, 404);
  eq("unit null contributor => 404", authorizeWithdraw({ userId: OWNER, role: "contributor" }, { contributor_user_id: null, status: "pending" }).status, 404);
  for (const s of ["approved", "rejected", "withdrawn", "superseded"]) {
    eq(`unit terminal ${s} => 409`, authorizeWithdraw({ userId: OWNER, role: "contributor" }, { contributor_user_id: OWNER, status: s }).status, 409);
  }
}

// ===========================================================================
// Production safety: method guard, local-only fetch, canonical/provenance/
// promotion tables byte-identical around the whole suite.
// ===========================================================================
{
  const id = await makeOwnContribution();
  eq("GET => 405", (await callWithdraw(await tokenFor(OWNER), id, { method: "GET" })).status, 405);
  eq("no network left the local JWKS test host", fetchedUrls.filter((u) => !u.includes(DOMAIN)).length, 0);
  okTrue("all outbound fetches hit only the test JWKS host", fetchedUrls.every((u) => u.includes(DOMAIN) && u.includes("/.well-known/jwks.json")));
  eq("canonical_locations byte-identical (no promotion/write)", CANON(), canonicalBefore);
  eq("location_provenance byte-identical", PROVENANCE(), provenanceBefore);
  eq("canonical_promotions byte-identical (empty)", PROMOTIONS(), promotionsBefore);
}

// Malformed JSON body is refused (400) and changes nothing.
{
  const id = await makeOwnContribution();
  eq("malformed JSON body => 400", (await callWithdraw(await tokenFor(OWNER), id, { body: "not json {" })).status, 400);
  eq("malformed body appended no event", withdrawEvents(id), 0);
  // An empty body is the normal, legitimate case.
  eq("empty body => 200", (await callWithdraw(await tokenFor(OWNER), id)).status, 200);
  deepEq("empty-body withdrawal produced one event", [withdrawEvents(id)], [1]);
}

globalThis.fetch = realFetch;
sqlite.close();
console.log(`STAGE14N_CONTRIBUTOR_WITHDRAWAL_TEST_SUCCESS (${passed} assertions)`);
