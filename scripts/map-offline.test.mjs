import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { RESTROOMS } from "../lib/restroom-data.ts";
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
assert.match(mapSource, /prefers-reduced-motion: reduce/);

assert.doesNotMatch(viteConfig, /cartocdn|map-tiles|runtimeCaching/);

const fallback = await loadRestrooms(async () => {
  throw new TypeError("Network unavailable");
});
assert.equal(fallback.source, "bundled");
assert.equal(fallback.data.length, 1112);
assert.equal(fallback.data, RESTROOMS);

console.log("MAP_OFFLINE_TEST_SUCCESS");
