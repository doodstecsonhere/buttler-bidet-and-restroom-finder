import assert from "node:assert/strict";

import { onRequest } from "../functions/api/restrooms.ts";
import { RESTROOMS } from "../lib/restroom-data.ts";
import { loadRestrooms } from "../lib/restroom-loader.ts";

const rows = RESTROOMS.slice(0, 2).map(({ bidet, ...restroom }) => ({
  ...restroom,
  has_bidet: bidet ? 1 : 0,
}));
let capturedQuery = "";
const database = {
  prepare(query) {
    capturedQuery = query;
    return {
      async all() {
        return { results: rows };
      },
    };
  },
};

const response = await onRequest({
  env: { BUTTLER_DB: database },
  request: new Request("https://preview.example/api/restrooms"),
});
assert.equal(response.status, 200);
assert.match(response.headers.get("cache-control"), /max-age=300/);
assert.match(capturedQuery, /record_status <> 'rejected'/);
assert.deepEqual(await response.json(), RESTROOMS.slice(0, 2));

const missingBinding = await onRequest({
  env: {},
  request: new Request("https://preview.example/api/restrooms"),
});
assert.equal(missingBinding.status, 503);

const post = await onRequest({
  env: { BUTTLER_DB: database },
  request: new Request("https://preview.example/api/restrooms", {
    method: "POST",
  }),
});
assert.equal(post.status, 405);
assert.equal(post.headers.get("allow"), "GET");

const d1Result = await loadRestrooms(async () =>
  Response.json(RESTROOMS.slice(0, 2)),
);
assert.equal(d1Result.source, "d1");
assert.deepEqual(d1Result.data, RESTROOMS.slice(0, 2));

const fallbackResult = await loadRestrooms(async () =>
  Response.json({ error: "unavailable" }, { status: 503 }),
);
assert.equal(fallbackResult.source, "bundled");
assert.equal(fallbackResult.data, RESTROOMS);

console.log("D1_PREVIEW_TEST_SUCCESS");
