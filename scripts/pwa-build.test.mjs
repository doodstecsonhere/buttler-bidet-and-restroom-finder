import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const serviceWorkerUrl = new URL(
  "../artifacts/buttler/dist/public/sw.js",
  import.meta.url,
);
const serviceWorker = await readFile(serviceWorkerUrl, "utf8");

assert.match(serviceWorker, /precacheAndRoute\(/);
assert.match(serviceWorker, /url:"index\.html"/);
assert.match(serviceWorker, /url:"assets\/index-[^"]+\.css"/);
assert.match(serviceWorker, /url:"assets\/index-[^"]+\.js"/);
assert.match(serviceWorker, /new [A-Za-z_$][\w$]*\.NavigationRoute\(/);
assert.match(serviceWorker, /createHandlerBoundToURL\("index\.html"\)/);
assert.match(serviceWorker, /skipWaiting\(\)/);
assert.match(serviceWorker, /clientsClaim\(\)/);
assert.doesNotMatch(serviceWorker, /cartocdn|tile\.openstreetmap\.org/);

console.log("PWA_BUILD_TEST_SUCCESS");
