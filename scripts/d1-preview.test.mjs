import assert from "node:assert/strict";

import { onRequest } from "../functions/api/restrooms.ts";
import { BUNDLED_RESTROOMS } from "../lib/restroom-bundle.ts";
import { loadRestrooms } from "../lib/restroom-loader.ts";

const canonicalRows = [
  {
    id: "buttler_loc_b2a4f21fbc6a500ff101",
    name: "Casablanca Restaurant",
    latitude: 9.30852,
    longitude: 123.30952,
    address: "Rizal Boulevard",
    access: "customers",
    fee: "no",
    has_bidet: 1,
    bidet_evidence: "field_verified",
  },
  {
    id: "buttler_loc_956b9fbdf276c7542366",
    name: "Dumaguete",
    latitude: 9.3131543,
    longitude: 123.3114084,
    address: null,
    access: "unknown",
    fee: "unknown",
    has_bidet: 0,
    bidet_evidence: "unknown",
  },
];

function fakeDatabase({ queryError, failFirstQueryOnly = false } = {}) {
  const queries = [];
  let callCount = 0;
  return {
    queries,
    prepare(query) {
      queries.push(query);
      return {
        async all() {
          callCount += 1;
          const shouldFail = queryError && (!failFirstQueryOnly || callCount === 1);
          if (shouldFail) {
            const failure = new Error(queryError);
            failure.cause = { message: queryError };
            throw failure;
          }
          return { results: canonicalRows };
        },
      };
    },
  };
}

// 1. Primary path: the canonical read model is served with the stable public
//    shape (string canonical ids, boolean bidet flag).
const canonicalDb = fakeDatabase();
const response = await onRequest({
  env: { BUTTLER_DB: canonicalDb },
  request: new Request("https://preview.example/api/restrooms"),
});
assert.equal(response.status, 200);
assert.match(response.headers.get("cache-control"), /max-age=300/);
assert.match(canonicalDb.queries[0], /FROM canonical_locations/);
assert.match(canonicalDb.queries[0], /record_status <> 'rejected'/);
assert.match(
  canonicalDb.queries[0],
  /bidet_verification AS bidet_evidence/,
  "canonical projection must expose bidet_evidence",
);
const { has_bidet: firstBidet, ...firstPublic } = canonicalRows[0];
const { has_bidet: secondBidet, ...secondPublic } = canonicalRows[1];
assert.deepEqual(await response.json(), [
  { ...firstPublic, bidet: firstBidet === 1 },
  { ...secondPublic, bidet: secondBidet === 1 },
]);

// 2. Legacy fallback: until migrations 0003/0004 are applied, the previous
//    read model keeps the deployed frontend working.
const legacyDb = fakeDatabase({
  queryError: 'D1_ERROR: no such table: canonical_locations',
  failFirstQueryOnly: true,
});
const legacyResponse = await onRequest({
  env: { BUTTLER_DB: legacyDb },
  request: new Request("https://preview.example/api/restrooms"),
});
assert.equal(legacyResponse.status, 200);
assert.equal(legacyDb.queries.length, 2);
assert.match(legacyDb.queries[1], /FROM restroom_locations/);
// The legacy table has no verification data, so its projection must report
// evidence as 'unknown' instead of implying field checks.
assert.match(legacyDb.queries[1], /'unknown' AS bidet_evidence/);
assert.deepEqual(await legacyResponse.json(), [
  { ...firstPublic, bidet: firstBidet === 1 },
  { ...secondPublic, bidet: secondBidet === 1 },
]);

// 3. Unrelated database errors are not swallowed into the legacy path.
await assert.rejects(
  onRequest({
    env: { BUTTLER_DB: fakeDatabase({ queryError: "D1_ERROR: too many queries" }) },
    request: new Request("https://preview.example/api/restrooms"),
  }),
  /too many queries/,
);

// 4. Missing binding fails with 503; the browser then uses its fallback.
const missingBinding = await onRequest({
  env: {},
  request: new Request("https://preview.example/api/restrooms"),
});
assert.equal(missingBinding.status, 503);

// 5. GATE 7 boundary: the public read endpoint never accepts a write, no
//    matter the method or client. Authentication/authorization for future
//    Guardian contributions must live on a separate, server-enforced endpoint,
//    so nothing mutating can slip through this handler.
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  const rejected = await onRequest({
    env: { BUTTLER_DB: canonicalDb },
    request: new Request("https://preview.example/api/restrooms", { method }),
  });
  assert.equal(rejected.status, 405, `${method} should be rejected`);
  assert.equal(rejected.headers.get("allow"), "GET", `${method} Allow header`);
}

// 6. The loader accepts canonical string ids and evidence from the API.
const d1Result = await loadRestrooms(async () =>
  Response.json(
    canonicalRows.map(({ has_bidet, ...row }) => ({
      ...row,
      bidet: has_bidet === 1,
    })),
  ),
);
assert.equal(d1Result.source, "d1");
assert.equal(d1Result.failure, null);
assert.equal(d1Result.data.length, 2);
assert.equal(d1Result.data[0].id, "buttler_loc_b2a4f21fbc6a500ff101");
assert.equal(d1Result.data[0].bidet_evidence, "field_verified");

// 6b. Rows from an older API without evidence are normalised to "unknown"
//     rather than rejected, so the whole catalogue never disappears over one
//     missing field.
const legacyShapedResult = await loadRestrooms(async () =>
  Response.json([
    canonicalRows.map(({ has_bidet, bidet_evidence, ...row }) => ({
      ...row,
      bidet: has_bidet === 1,
    }))[0],
  ]),
);
assert.equal(legacyShapedResult.source, "d1");
assert.equal(legacyShapedResult.data[0].bidet_evidence, "unknown");

// 7. Invalid or unavailable payloads fall back to the canonical offline
//    bundle, with the failure kind distinguishing server errors from being
//    genuinely offline.
const fallbackResult = await loadRestrooms(async () =>
  Response.json({ error: "unavailable" }, { status: 503 }),
);
assert.equal(fallbackResult.source, "bundled");
assert.equal(fallbackResult.failure, "api-error");
assert.equal(fallbackResult.data, BUNDLED_RESTROOMS);

const invalidResult = await loadRestrooms(async () =>
  Response.json([{ id: "", name: "bad" }]),
);
assert.equal(invalidResult.source, "bundled");
assert.equal(invalidResult.failure, "api-error");

console.log("D1_PREVIEW_TEST_SUCCESS");
