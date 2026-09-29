// Buttler 2.0 — Stage 13 contribution UI test (local workflow foundation).
//
// Like scripts/stage13-frontend-auth.test.mjs, this runs entirely in-process
// with injected doubles: no Auth0 tenant, no Cloudflare, no database, no
// network, no browser. It never submits anything real and cannot touch a
// deployment.
//
// Three layers:
//   1. The vocabulary mapping (pure module) — the UI's friendly words vs the
//      backend's kind tokens, kept explicitly separate and drift-checked.
//   2. The API client (pure module) — request construction, response handling,
//      and the auth seam behaviour, wired through the REAL createAuthorizedFetch
//      so bearer rules are exercised, not just described.
//   3. Static hygiene over the new browser source — the promises that are
//      properties of whole files rather than single functions (no token
//      persistence, no client-side role logic, no invented kind tokens).
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage13-contribution-ui.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_FIELDS_BY_KIND,
  CONTRIBUTION_KINDS,
  CONTRIBUTION_STATUSES,
  MAX_NOTES_LENGTH,
} from "../lib/contributions/contract.ts";
import {
  AuthRequiredError,
  createAuthorizedFetch,
} from "../artifacts/buttler/src/auth/authorized-fetch.ts";
import {
  EVIDENCE_TYPES,
  FIELDS_BY_KIND,
  KIND_LABEL,
  fieldLabel,
  kindLabel,
  kindRequiresTarget,
  payloadValueLabel,
  statusLabel,
} from "../artifacts/buttler/src/contributions/ui-vocabulary.ts";
import {
  buildSubmissionBody,
  createContributionsClient,
  evidenceToWire,
  isCanonicalTargetId,
} from "../artifacts/buttler/src/contributions/client.ts";

const APP_ORIGIN = "https://buttler.test";
const TOKEN = "test.access.token.value";
const TARGET_ID = `buttler_loc_${"0".repeat(20)}`;

const read = (relative) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.includes("//") ? line.slice(0, line.indexOf("//")) : line))
    .join("\n");

// A tiny fetch double recorder wrapped by the REAL authorized-fetch seam, so
// every client call walks the same guard order the browser uses.
function harness({ token = TOKEN, handler } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return handler
      ? handler(input, init)
      : Response.json({ ok: true }, { status: 200 });
  };
  const request = createAuthorizedFetch({ origin: APP_ORIGIN, getToken: async () => token, fetchImpl });
  const client = createContributionsClient({ request });
  return { calls, client };
}

const json = (body, status = 200) => Response.json(body, { status });

const validProblemDraft = () => ({
  kind: "problem_report",
  targetCanonicalId: TARGET_ID,
  payload: { issue: "The chain is broken." },
  notes: "",
  evidence: [],
});

// ---------------------------------------------------------------------------
// 1. Vocabulary: the UI/backend mapping is total, exact, and drift-proof
// ---------------------------------------------------------------------------

{
  // The mapping covers EXACTLY the backend's kinds — no gaps, no inventions.
  assert.deepEqual(
    Object.keys(KIND_LABEL).sort(),
    [...CONTRIBUTION_KINDS].sort(),
    "KIND_LABEL drifted from the backend CONTRIBUTION_KINDS",
  );
  assert.deepEqual(KIND_LABEL, {
    problem_report: "Report a problem",
    closure_report: "No longer exists",
    info_correction: "Corrected information",
    access_update: "Access information",
    fee_update: "Fee information",
    bidet_report: "Bidet information",
    reverification: "Fresh verification",
    new_location: "New location",
  });
}

{
  // Every form field the UI can build is on that kind's backend allow-list.
  assert.deepEqual(Object.keys(FIELDS_BY_KIND).sort(), [...CONTRIBUTION_KINDS].sort());
  for (const [kind, specs] of Object.entries(FIELDS_BY_KIND)) {
    const allowed = new Set(ALLOWED_FIELDS_BY_KIND[kind]);
    for (const spec of specs) {
      assert.ok(
        allowed.has(spec.key),
        `field ${spec.key} offered for ${kind} is not allow-listed by the backend`,
      );
    }
  }
}

{
  // Only new_location stands without a canonical target.
  for (const kind of CONTRIBUTION_KINDS) {
    assert.equal(
      kindRequiresTarget(kind),
      kind !== "new_location",
      `target requirement wrong for ${kind}`,
    );
  }
}

{
  // Status and enum labels are total over the backend enums; unknown values
  // fall back to themselves instead of lying.
  for (const status of CONTRIBUTION_STATUSES) {
    assert.notEqual(statusLabel(status), status);
  }
  assert.equal(statusLabel("mystery"), "mystery");
  assert.equal(kindLabel("mystery_kind"), "mystery_kind");
  assert.equal(payloadValueLabel("bidet_presence", "Yes"), "Bidet present");
  assert.equal(payloadValueLabel("fee", "no"), "Free");
  assert.equal(fieldLabel("issue"), "Problem");
  assert.equal(fieldLabel("not_a_field"), "not_a_field");
  assert.deepEqual(
    EVIDENCE_TYPES.map((entry) => entry.value),
    ["field_observation", "user_note", "external_source", "photo_reference"],
  );
}

// ---------------------------------------------------------------------------
// 2. Request construction (contract shape, no invented fields)
// ---------------------------------------------------------------------------

{
  const built = buildSubmissionBody(validProblemDraft());
  assert.equal(built.ok, true);
  assert.deepEqual(built.body, {
    kind: "problem_report",
    target_canonical_id: TARGET_ID,
    payload: { issue: "The chain is broken." },
    notes: null,
    evidence: null,
  });
}

{
  // new_location carries no target; everything else must have one.
  const ok = buildSubmissionBody({
    kind: "new_location",
    targetCanonicalId: null,
    payload: { name: "Rizal Blvd comfort station", latitude: 9.31, longitude: 123.3 },
    notes: "  spaced  ",
    evidence: [],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.notes, "spaced");
  assert.equal(ok.body.target_canonical_id, null);

  const missingTarget = buildSubmissionBody({
    kind: "bidet_report",
    targetCanonicalId: null,
    payload: { bidet_presence: "Yes" },
    notes: "",
    evidence: [],
  });
  assert.equal(missingTarget.ok, false);
}

{
  // Requirement 4: contribution-kind validation refuses unknown kinds and
  // off-allow-list fields before anything is sent.
  const badKind = buildSubmissionBody({
    kind: "mystery_kind",
    targetCanonicalId: TARGET_ID,
    payload: { issue: "x" },
    notes: "",
    evidence: [],
  });
  assert.equal(badKind.ok, false);

  const inventedField = buildSubmissionBody({
    kind: "problem_report",
    targetCanonicalId: TARGET_ID,
    payload: { status: "approved" },
    notes: "",
    evidence: [],
  });
  assert.equal(inventedField.ok, false);
}

{
  // Requirement 5: required-field and size validation.
  const emptyPayload = buildSubmissionBody({
    kind: "problem_report",
    targetCanonicalId: TARGET_ID,
    payload: {},
    notes: "",
    evidence: [],
  });
  assert.equal(emptyPayload.ok, false);
  assert.match(emptyPayload.message, /at least one/i);

  const longNotes = buildSubmissionBody({
    ...validProblemDraft(),
    notes: "n".repeat(MAX_NOTES_LENGTH + 1),
  });
  assert.equal(longNotes.ok, false);

  const badEvidence = buildSubmissionBody({
    ...validProblemDraft(),
    evidence: [{ type: "sworn_statement", detail: "", observed_at: "", source_url: "" }],
  });
  assert.equal(badEvidence.ok, false);

  const badCoords = buildSubmissionBody({
    kind: "new_location",
    targetCanonicalId: null,
    payload: { name: "Somewhere", latitude: 40.7, longitude: 123.3 },
    notes: "",
    evidence: [],
  });
  assert.equal(badCoords.ok, false);
  assert.match(badCoords.message, /Dumaguete/);
}

{
  // Evidence wire shape drops blanks and keeps documented keys only.
  const wire = evidenceToWire([
    { type: "field_observation", detail: "  I checked today ", observed_at: "2026-09-29", source_url: "" },
    { type: "photo_reference", detail: "shelf photo", observed_at: "", source_url: "" },
  ]);
  assert.deepEqual(wire, [
    { type: "field_observation", detail: "I checked today", observed_at: "2026-09-29" },
    { type: "photo_reference", detail: "shelf photo" },
  ]);
}

{
  assert.equal(isCanonicalTargetId(TARGET_ID), true);
  assert.equal(isCanonicalTargetId("buttler_loc_nope"), false);
  assert.equal(isCanonicalTargetId(null), false);
}

// ---------------------------------------------------------------------------
// 3. The auth seam: unauthenticated fails locally; authenticated sends bearer
// ---------------------------------------------------------------------------

{
  // Requirement 1: an anonymous browser cannot even reach the network.
  const { calls, client } = harness({ token: null });
  const result = await client.submit(validProblemDraft());
  assert.equal(result.ok, false);
  assert.equal(result.code, "auth_required");
  assert.equal(calls.length, 0, "an unauthenticated submit must not hit the network");
  // The guard is the real seam type, not the client's invention.
  assert.ok(new AuthRequiredError("/api/x") instanceof Error);
}

{
  // Requirement 2 + 3: a signed-in browser sends the exact contract body with
  // the bearer attached by authorized-fetch — to the app's own /api only.
  const { calls, client } = harness({
    handler: () => json({ contribution_id: "contrib_" + "a".repeat(32), status: "pending" }, 201),
  });
  const result = await client.submit(validProblemDraft());
  assert.equal(result.ok, true);
  assert.equal(result.value.status, "pending");
  assert.match(result.value.contributionId, /^contrib_/);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/contributions");
  assert.equal(calls[0].init.method, "POST");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    kind: "problem_report",
    target_canonical_id: TARGET_ID,
    payload: { issue: "The chain is broken." },
    notes: null,
    evidence: null,
  });
}

{
  // A draft that fails pre-validation never produces a request.
  const { calls, client } = harness();
  const result = await client.submit({ ...validProblemDraft(), kind: "mystery_kind" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "validation");
  assert.equal(calls.length, 0);
}

// ---------------------------------------------------------------------------
// 4. Submission outcomes (requirements 6 and 7)
// ---------------------------------------------------------------------------

const SUBMIT_DRAFT = validProblemDraft;

{
  // 6. Successful submission state.
  const { client } = harness({
    handler: () => json({ contribution_id: "contrib_" + "b".repeat(32), status: "pending" }, 201),
  });
  const result = await client.submit(SUBMIT_DRAFT());
  assert.deepEqual(result, {
    ok: true,
    value: { contributionId: "contrib_" + "b".repeat(32), status: "pending" },
  });
}

{
  // 7. Every failure family maps to a stable code + friendly message.
  const cases = [
    [400, { error: "bidet_presence must be Yes or Unknown" }, "validation"],
    [401, { error: "nope" }, "auth_required"],
    [403, { error: "nope" }, "forbidden"],
    [404, { error: "target location not found" }, "not_found"],
    [409, { error: "an open contribution for this already exists" }, "duplicate"],
    [413, { error: "notes exceed 2000 characters" }, "too_large"],
    [429, { error: "too many open contributions" }, "rate_limited"],
    [503, { error: "contributions are not open yet: authentication is not configured" }, "not_open"],
    [500, null, "server"],
  ];
  for (const [status, body, expectedCode] of cases) {
    const { client } = harness({
      handler: () => (body === null ? new Response("boom", { status }) : json(body, status)),
    });
    const result = await client.submit(SUBMIT_DRAFT());
    assert.equal(result.ok, false, `status ${status} must fail`);
    assert.equal(result.code, expectedCode, `wrong code for status ${status}`);
    assert.ok(typeof result.message === "string" && result.message.length > 0);
    // Messages must never carry the bearer or provider internals.
    assert.ok(!result.message.includes(TOKEN));
  }
  // A 400's specific reason survives, so the form can point at the field.
  const { client } = harness({
    handler: () => json({ error: "bidet_presence must be Yes or Unknown" }, 400),
  });
  const result = await client.submit(SUBMIT_DRAFT());
  assert.equal(result.message, "bidet_presence must be Yes or Unknown");
}

{
  // Network loss is its own honest state.
  const { client } = harness({ handler: () => { throw new TypeError("Failed to fetch"); } });
  const result = await client.submit(SUBMIT_DRAFT());
  assert.equal(result.ok, false);
  assert.equal(result.code, "offline");
}

// ---------------------------------------------------------------------------
// 5. Own history (requirements 8, 9, 10)
// ---------------------------------------------------------------------------

{
  // 8. Loading a real list; the client passes the base projection through.
  const rows = [
    {
      contribution_id: "contrib_" + "1".repeat(32),
      kind: "problem_report",
      target_canonical_id: TARGET_ID,
      status: "pending",
      submitted_at: "2026-09-29T00:00:00.000Z",
      payload: { issue: "dirty" },
      evidence: null,
      notes: null,
    },
  ];
  const { calls, client } = harness({ handler: () => json(rows) });
  const result = await client.listMine();
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, rows);
  assert.equal(calls[0].input, "/api/me/contributions");
  assert.equal(calls[0].init.method, "GET");
  // The contributor view carries no moderation internals to leak.
  assert.ok(!("moderation_note" in rows[0]));
}

{
  // 9. Empty history is a success, not an error.
  const { client } = harness({ handler: () => json([]) });
  const result = await client.listMine();
  assert.deepEqual(result, { ok: true, value: [] });
}

{
  // 10. Failure families on history: 401 and the fail-closed 503.
  for (const [status, expectedCode] of [
    [401, "auth_required"],
    [503, "not_open"],
  ]) {
    const { client } = harness({ handler: () => json({ error: "x" }, status) });
    const result = await client.listMine();
    assert.equal(result.ok, false);
    assert.equal(result.code, expectedCode);
  }
  // A tokenless history call never reaches the network at all.
  const { calls, client } = harness({ token: null });
  const result = await client.listMine();
  assert.equal(result.code, "auth_required");
  assert.equal(calls.length, 0);
}

// ---------------------------------------------------------------------------
// 6. Moderation: queue, decisions, and server-only authority (11–14)
// ---------------------------------------------------------------------------

{
  // 11. Queue rendering path: filter goes into the query, rows parse through.
  const { calls, client } = harness({ handler: () => json([]) });
  const all = await client.queue();
  assert.equal(all.ok, true);
  assert.equal(calls[0].input, "/api/moderation/contributions");
  await client.queue("needs_review");
  assert.equal(calls[1].input, "/api/moderation/contributions?status=needs_review");
}

{
  // 12 + 13. approve / reject call shapes and returned status.
  const { calls, client } = harness({
    handler: () => json({ status: "approved" }),
  });
  const approved = await client.decide("contrib_" + "2".repeat(32), "approve", " looks verified ");
  assert.deepEqual(approved, { ok: true, value: { status: "approved" } });
  assert.equal(calls[0].input, `/api/moderation/contributions/contrib_${"2".repeat(32)}/approve`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { note: "looks verified" });

  const rejected = await client.decide("contrib_" + "3".repeat(32), "reject", "");
  assert.equal(rejected.ok, true);
  assert.equal(calls[1].input, `/api/moderation/contributions/contrib_${"3".repeat(32)}/reject`);
  assert.deepEqual(JSON.parse(calls[1].init.body), { note: null });
}

{
  // 14. A non-moderator learns about it ONLY from the server's 403 — and the
  // client's behaviour proves no local role check short-circuits anything.
  const { calls, client } = harness({
    handler: () => json({ error: "moderator role required" }, 403),
  });
  const queue = await client.queue();
  assert.equal(queue.ok, false);
  assert.equal(queue.code, "forbidden");
  const decision = await client.decide("contrib_" + "4".repeat(32), "approve", "");
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "forbidden");
  assert.equal(calls.length, 2);
}

// ---------------------------------------------------------------------------
// 7. Static hygiene over the new browser source (requirements 14–16 and more)
// ---------------------------------------------------------------------------

const CONTRIBUTION_SOURCES = [
  "../artifacts/buttler/src/contributions/ui-vocabulary.ts",
  "../artifacts/buttler/src/contributions/client.ts",
  "../artifacts/buttler/src/contributions/ui.tsx",
  "../artifacts/buttler/src/pages/Contribute.tsx",
  "../artifacts/buttler/src/pages/MyContributions.tsx",
  "../artifacts/buttler/src/pages/Moderation.tsx",
];

const sources = new Map();
for (const path of CONTRIBUTION_SOURCES) {
  sources.set(path, await read(path));
}

{
  // 15. No token persistence: contribution code may touch no persistent store.
  const offenders = [];
  for (const [path, text] of sources) {
    const code = withoutComments(text);
    for (const storage of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "caches.open"]) {
      if (code.includes(storage)) offenders.push(`${path}: ${storage}`);
    }
  }
  assert.deepEqual(offenders, [], "contribution code persists browser state");
}

{
  // 16. No external bearer leakage and no second auth implementation:
  // only the authorized-fetch seam may attach credentials, and the client
  // itself never builds absolute URLs or touches fetch/Authorization.
  const offenders = [];
  for (const [path, text] of sources) {
    const code = withoutComments(text);
    if (/Authorization/.test(code)) offenders.push(`${path}: touches Authorization`);
    if (/\bfetch\s*\(/.test(code)) offenders.push(`${path}: calls raw fetch`);
    if (/getTokenSilently|loginWithRedirect|auth0-spa-js/.test(code)) {
      offenders.push(`${path}: bypasses the auth seam`);
    }
  }
  assert.deepEqual(offenders, [], "the auth seam was re-implemented or bypassed");
  // The API client speaks in relative same-origin paths only (pages may show
  // placeholder example URLs in form hints, so this scan is client-scoped).
  const clientCode = withoutComments(sources.get("../artifacts/buttler/src/contributions/client.ts"));
  assert.ok(!/https?:\/\//.test(clientCode), "the client builds an absolute URL");
}

{
  // 14 (static half). No client-side authorization: nothing reads a role,
  // claim, or moderator list; only server status codes drive the UI.
  const offenders = [];
  for (const [path, text] of sources) {
    const code = withoutComments(text);
    if (/getTokenData|\broles\b|isModerator|isAdmin|BUTTLER_MODERATOR_IDS|permissions/i.test(code)) {
      offenders.push(path);
    }
  }
  assert.deepEqual(offenders, [], "contribution code reads roles or claims");
  // The moderation page's "moderators only" state is keyed off the server 403.
  const moderation = withoutComments(sources.get("../artifacts/buttler/src/pages/Moderation.tsx"));
  assert.match(moderation, /failure\.code === "forbidden"/);
}

{
  // The UI must speak ONLY the backend's kind tokens. Vocabulary from the
  // objective doc that does not exist in the contract must not sneak in.
  const forbiddenTokens = [
    "report_problem",
    "no_longer_exists",
    "corrected_info",
    "access_info",
    "fee_info",
    "bidet_info",
    "fresh_verification",
  ];
  for (const [path, text] of sources) {
    for (const token of forbiddenTokens) {
      assert.ok(!text.includes(token), `${path} invents non-backend kind: ${token}`);
    }
  }
  // And every real kind token is reachable from the friendly side.
  const vocabulary = sources.get("../artifacts/buttler/src/contributions/ui-vocabulary.ts");
  for (const kind of CONTRIBUTION_KINDS) {
    assert.ok(vocabulary.includes(`"${kind}"`) || vocabulary.includes(`${kind}:`), kind);
  }
}

{
  // Credential-shaped literals are absent from the new files (same sweep the
  // auth suite runs tree-wide, repeated here for the new surface).
  for (const [path, text] of sources) {
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text), `${path}: JWT-shaped literal`);
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{20,}/.test(withoutComments(text)), `${path}: hardcoded bearer`);
  }
}

{
  // Wiring: the three routes exist, Home links once per header, cards deep
  // link only canonical ids, and pages talk to the API only via the client.
  const app = await read("../artifacts/buttler/src/App.tsx");
  for (const route of ["/contribute", "/my-contributions", "/moderation"]) {
    assert.ok(app.includes(`path="${route}"`), `route ${route} is not registered`);
  }
  const home = await read("../artifacts/buttler/src/pages/Home.tsx");
  assert.equal((home.match(/href="\/contribute"/g) ?? []).length, 2);
  // Sign-in state must not gate discovery — the catalogue still loads anon.
  assert.match(home, /useOfflineRestrooms/);
  const card = await read("../artifacts/buttler/src/components/RestroomCard.tsx");
  assert.match(card, /\/contribute\?target=\$\{canonicalTarget\}/);
  assert.match(card, /\^buttler_loc_\[0-9a-f\]\{20\}\$/);
  for (const [path, text] of sources) {
    if (path.includes("/pages/")) {
      assert.ok(!text.includes('"/api/'), `${path} hardcodes an API path`);
    }
  }
  // The success screen tells the truth about moderation.
  const contribute = sources.get("../artifacts/buttler/src/pages/Contribute.tsx");
  assert.match(contribute, /human moderator/);
  assert.match(contribute, /<strong>not<\/strong>/);
}

console.log("STAGE13_CONTRIBUTION_UI_TEST_SUCCESS");
