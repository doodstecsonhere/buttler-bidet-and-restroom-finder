import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { BUNDLED_RESTROOMS } from "../lib/restroom-bundle.ts";
import { loadRestrooms } from "../lib/restroom-loader.ts";

const mapSource = await readFile(
  new URL("../artifacts/buttler/src/components/Map.tsx", import.meta.url),
  "utf8",
);
const viteConfig = await readFile(
  new URL("../artifacts/buttler/vite.config.ts", import.meta.url),
  "utf8",
);

assert.match(
  mapSource,
  /https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/,
);
assert.doesNotMatch(mapSource, /cartocdn|carto\.com|api[_-]?key/i);
assert.match(mapSource, /OpenStreetMap<\/a> contributors/);
assert.match(mapSource, /navigator\.onLine/);
assert.match(mapSource, /Restroom locations remain interactive/);
assert.match(mapSource, /you may be offline/i);
assert.match(mapSource, /prefers-reduced-motion: reduce/);

assert.doesNotMatch(viteConfig, /cartocdn|map-tiles|runtimeCaching/);

// True network loss: the loader falls back to the canonical offline bundle and
// labels the failure as "offline" (no localStorage exists under Node, so the
// last-known-good runtime cache is correctly skipped here).
const offline = await loadRestrooms(async () => {
  throw new TypeError("Network unavailable");
});
assert.equal(offline.source, "bundled");
assert.equal(offline.failure, "offline");
assert.equal(offline.data.length, 776);
assert.equal(offline.data, BUNDLED_RESTROOMS);

// A server-side HTTP error must never be mislabelled as the user being
// offline; the UI reads this flag to choose its banner wording.
const apiError = await loadRestrooms(async () =>
  new Response("boom", { status: 500 }),
);
assert.equal(apiError.source, "bundled");
assert.equal(apiError.failure, "api-error");

// The offline catalogue is the canonical dataset, not the superseded legacy
// 1,112-row bundle, and it carries canonical string ids plus bidet evidence.
assert.notEqual(BUNDLED_RESTROOMS.length, 1112);
assert.ok(BUNDLED_RESTROOMS.every((record) => typeof record.id === "string"));
assert.equal(
  BUNDLED_RESTROOMS.filter(
    (record) => record.bidet && record.bidet_evidence === "osm_explicit",
  ).length,
  16,
);
assert.equal(
  BUNDLED_RESTROOMS.filter(
    (record) => record.bidet && record.bidet_evidence === "field_verified",
  ).length,
  98,
);

console.log("MAP_OFFLINE_TEST_SUCCESS");
