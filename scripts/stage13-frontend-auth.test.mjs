// Buttler 2.0 — Stage 13 frontend Auth0 integration test.
//
// Scope: the browser-side identity seam only. Like scripts/stage13-identity.test.mjs
// it runs entirely in-process and contacts NOTHING — no Auth0 tenant, no Cloudflare,
// no database, no network — so it needs no credentials and cannot affect a
// deployment. It never submits a contribution and never reads production data.
//
// Two halves:
//   1. Behaviour of the pure modules (config / state / authorized-fetch), exercised
//      through injected doubles exactly as the app wires them.
//   2. Static hygiene over the browser source tree (and, when a build exists, the
//      built bundle), because "no server-only value may reach a browser" is a
//      property of the whole tree rather than of one function.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage13-frontend-auth.test.mjs
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BROWSER_SAFE_AUTH0_ENV,
  SERVER_ONLY_ENV_NAMES,
  callbackUrlFor,
  describeAuthError,
  hasRedirectResult,
  normalizeDomain,
  readAuth0Config,
  withoutRedirectParams,
} from "../artifacts/buttler/src/auth/config.ts";
import {
  SAFE_PROFILE_CLAIMS,
  initialAuthState,
  profileFromClaims,
  reduceAuthState,
} from "../artifacts/buttler/src/auth/state.ts";
import {
  AuthRequiredError,
  createAuthorizedFetch,
  isButtlerApiRequest,
} from "../artifacts/buttler/src/auth/authorized-fetch.ts";
import { loadRestrooms } from "../lib/restroom-loader.ts";

const APP_ORIGIN = "https://buttler.test";
const COMPLETE_ENV = {
  VITE_AUTH0_DOMAIN: "buttler-test.us.auth0.com",
  VITE_AUTH0_CLIENT_ID: "test-client-id",
  VITE_AUTH0_AUDIENCE: "https://buttler-api",
};

// ---------------------------------------------------------------------------
// 1. Public configuration: present, partial, or absent — never an exception
// ---------------------------------------------------------------------------

{
  const configured = readAuth0Config(COMPLETE_ENV);
  assert.equal(configured.status, "configured");
  assert.deepEqual(configured.config, {
    domain: "buttler-test.us.auth0.com",
    clientId: "test-client-id",
    audience: "https://buttler-api",
  });
}

{
  // Empty is the today-in-production state: a normal result, not a crash.
  for (const env of [undefined, {}, { VITE_AUTH0_DOMAIN: "" }]) {
    const result = readAuth0Config(env);
    assert.equal(result.status, "missing");
    assert.ok(result.missing.length > 0);
    for (const name of result.missing) {
      assert.ok(BROWSER_SAFE_AUTH0_ENV.includes(name), `unexpected name ${name}`);
    }
  }
  // Each variable is reported individually so a misconfigured deployment is
  // diagnosable without printing any value.
  assert.deepEqual(
    readAuth0Config({
      VITE_AUTH0_DOMAIN: COMPLETE_ENV.VITE_AUTH0_DOMAIN,
      VITE_AUTH0_CLIENT_ID: COMPLETE_ENV.VITE_AUTH0_CLIENT_ID,
    }).missing,
    ["VITE_AUTH0_AUDIENCE"],
  );
  // Anything outside the allow-list is invisible to the reader.
  assert.equal(
    readAuth0Config({
      ...COMPLETE_ENV,
      AUTH0_CLIENT_SECRET: "nope",
    }).status,
    "configured",
  );
}

{
  // Owners paste a scheme and/or trailing slash; the SDK and identity.ts both
  // need a bare host.
  assert.equal(normalizeDomain("https://buttler-test.us.auth0.com/"), "buttler-test.us.auth0.com");
  assert.equal(normalizeDomain("  buttler-test.us.auth0.com  "), "buttler-test.us.auth0.com");
  assert.equal(normalizeDomain("buttler-test.us.auth0.com/authorize"), "");
  assert.equal(normalizeDomain("not a host"), "");
  assert.equal(normalizeDomain(undefined), "");
}

// ---------------------------------------------------------------------------
// 2. Redirect plumbing: exact callback URL, one-time params consumed once
// ---------------------------------------------------------------------------

{
  assert.equal(callbackUrlFor("http://localhost:5173"), "http://localhost:5173/");
  assert.equal(callbackUrlFor("https://buttler.pages.dev/"), "https://buttler.pages.dev/");
  assert.equal(callbackUrlFor("https://example.com", "/buttler"), "https://example.com/buttler/");
}

{
  assert.equal(hasRedirectResult("?code=abc&state=xyz"), true);
  assert.equal(hasRedirectResult("?error=login_required&error_description=x"), true);
  // A plain visit, and a deep link that merely contains a similar word.
  assert.equal(hasRedirectResult(""), false);
  assert.equal(hasRedirectResult("?q=coded"), false);
  assert.equal(hasRedirectResult("?code="), true); // must still be consumed
}

{
  const cleaned = withoutRedirectParams(
    "https://buttler.test/?code=abc&state=xyz&error=login_required&error_description=x&q=pool",
  );
  assert.equal(cleaned, "https://buttler.test/?q=pool");
  // Query fully consumed -> no dangling "?" left behind.
  assert.equal(withoutRedirectParams("https://buttler.test/?code=a&state=b"), "https://buttler.test/");
  // Malformed input is returned or normalised, never thrown at the caller.
  for (const junk of ["http://", "   ", "https://buttler.test/?code=x"]) {
    assert.equal(typeof withoutRedirectParams(junk), "string");
  }
}

// ---------------------------------------------------------------------------
// 3. Error text: useful, bounded, and free of credentials
// ---------------------------------------------------------------------------

{
  assert.equal(
    describeAuthError({ error: "login_required", error_description: "Consent required" }),
    "login_required: Consent required",
  );
  assert.equal(describeAuthError(new Error("network unreachable")), "network unreachable");
  assert.equal(describeAuthError("boom"), "boom");
  // Never an empty string, never a throw: the UI always has something to show.
  for (const cause of [undefined, null, 0, "", {}, { error: 42 }]) {
    const text = describeAuthError(cause);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0);
    assert.ok(text.length <= 160);
  }
  // A leaked-code-shaped object must not be stringified wholesale: only the two
  // documented Auth0 fields (or `message`) are read.
  const hostile = describeAuthError({
    error: "access_denied",
    code: "SECRET_ONE_TIME_CODE",
    state: "SECRET_STATE",
    token: "SECRET_JWT",
  });
  assert.equal(hostile, "access_denied");
  assert.ok(!/SECRET/.test(hostile));
}

// ---------------------------------------------------------------------------
// 4. State machine: five states, and identity never survives logout or error
// ---------------------------------------------------------------------------

{
  const profile = { displayName: "Ada", subject: "auth0|ada", picture: null };

  assert.deepEqual(initialAuthState(), {
    status: "loading",
    profile: null,
    error: null,
  });

  const signedIn = reduceAuthState(initialAuthState(), { type: "signed-in", profile });
  assert.equal(signedIn.status, "authenticated");
  assert.deepEqual(signedIn.profile, profile);

  // Logout clears the displayed identity immediately, before the provider redirect.
  const loggedOut = reduceAuthState(signedIn, { type: "signed-out" });
  assert.equal(loggedOut.status, "anonymous");
  assert.equal(loggedOut.profile, null);
  assert.equal(loggedOut.error, null);

  // An error is never shown as "signed in".
  const failed = reduceAuthState(signedIn, { type: "error", message: "provider offline" });
  assert.equal(failed.status, "error");
  assert.equal(failed.profile, null);
  assert.equal(failed.error, "provider offline");

  // Unconfigured must not look broken.
  const inert = reduceAuthState(signedIn, { type: "unconfigured" });
  assert.deepEqual(inert, { status: "unconfigured", profile: null, error: null });

  // Every transition is total — no event type falls through to `undefined`.
  for (const event of [
    { type: "loading" },
    { type: "unconfigured" },
    { type: "signed-in", profile: null },
    { type: "signed-out" },
    { type: "error", message: "x" },
  ]) {
    const next = reduceAuthState(initialAuthState(), event);
    assert.ok(["loading", "unconfigured", "anonymous", "authenticated", "error"].includes(next.status));
    assert.ok("profile" in next && "error" in next);
  }
}

// ---------------------------------------------------------------------------
// 5. Identity display: safe claims in, authorization claims dropped
// ---------------------------------------------------------------------------

{
  const claims = {
    sub: "auth0|ada",
    name: "Ada L",
    nickname: "ada",
    picture: "https://cdn.test/a.png",
    updated_at: "2026-09-23T00:00:00Z",
    // Everything from here down is what a tampered or over-trusting client must
    // never turn into a UI capability.
    roles: ["moderator"],
    permissions: ["moderate:contribution"],
    scope: "openid profile email",
    email: "ada@private.test",
    email_verified: true,
    "https://buttler.test/moderator": true,
    sid: "session-id-value",
  };
  const profile = profileFromClaims(claims);
  assert.deepEqual(profile, {
    displayName: "Ada L",
    subject: "auth0|ada",
    picture: "https://cdn.test/a.png",
  });
  // Structural guarantee, not a naming convention: nothing outside the three
  // display fields (so no role, permission, scope, or email) can ride along
  // into the DOM.
  assert.deepEqual(Object.keys(profile).sort(), ["displayName", "picture", "subject"]);
  assert.ok(SAFE_PROFILE_CLAIMS.includes("sub"));
  for (const forbidden of ["roles", "permissions", "scope", "email", "sid"]) {
    assert.ok(!SAFE_PROFILE_CLAIMS.includes(forbidden), `${forbidden} must never be a safe claim`);
    assert.ok(!(forbidden in profile), `${forbidden} leaked into the profile`);
  }
}

{
  // Label fallbacks, and no identity without a subject.
  assert.equal(profileFromClaims({ sub: "auth0|x", nickname: "x" }).displayName, "x");
  assert.equal(
    profileFromClaims({ sub: "auth0|x", name: "   ", nickname: "" }).displayName,
    "Signed-in contributor",
  );
  for (const claims of [null, undefined, {}, { sub: "  " }, { name: "no subject" }]) {
    assert.equal(profileFromClaims(claims), null);
  }
  assert.equal(profileFromClaims({ sub: "auth0|x", picture: "  " }).picture, null);
}

// ---------------------------------------------------------------------------
// 6. authorizedFetch: the three guards
// ---------------------------------------------------------------------------

function recorder(token) {
  const calls = [];
  return {
    calls,
    token,
    getTokenCalls: 0,
    async getToken() {
      this.getTokenCalls += 1;
      return token;
    },
    async fetchImpl(input, init) {
      calls.push({
        input,
        authorization: new Headers(init?.headers ?? undefined).get("authorization"),
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

function authed(rec) {
  return createAuthorizedFetch({
    origin: APP_ORIGIN,
    getToken: () => rec.getToken(),
    fetchImpl: (input, init) => rec.fetchImpl(input, init),
  });
}

{
  // Guard 3: Buttler's own API gets exactly one bearer header.
  const rec = recorder("access-token-value");
  const response = await authed(rec)("/api/me/contributions", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  assert.equal(response.status, 200);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].authorization, "Bearer access-token-value");
  assert.equal(rec.getTokenCalls, 1);
}

{
  // A caller-supplied Authorization header is replaced, never merged with.
  const rec = recorder("real-token-value");
  await authed(rec)("/api/contributions", {
    method: "POST",
    headers: { Authorization: "Bearer forged", "Content-Type": "application/json" },
  });
  assert.equal(rec.calls[0].authorization, "Bearer real-token-value");
}

{
  // Guard 2: protected call without a token fails locally, and sends nothing.
  for (const token of [null, "", "   "]) {
    const rec = recorder(token);
    await assert.rejects(
      () => authed(rec)("/api/me/contributions"),
      (error) =>
        error instanceof AuthRequiredError &&
        error.path === "/api/me/contributions" &&
        /Sign-in is required/.test(error.message),
    );
    assert.equal(rec.calls.length, 0, "no request may leave without a token");
  }
}

{
  // Guard 1: unrelated destinations are forwarded untouched, with no token
  // lookup at all — map tiles, geocoders, a mistaken absolute Buttler URL on
  // another host, and same-origin non-API paths.
  const targets = [
    "https://tile.openstreetmap.org/3/4/5.png",
    "https://auth0.test/u/api/restrooms", // looks like our API, wrong origin
    "https://evil.example/api/contributions",
    "/images/logo.png",
    "/nearby", // same origin but not the API
  ];

  for (const target of targets) {
    const rec = recorder("access-token-value");
    await authed(rec)(target);
    assert.equal(rec.calls.length, 1, `expected exactly one forwarded call for ${target}`);
    assert.equal(rec.calls[0].authorization, null, `token leaked to ${target}`);
    assert.equal(rec.getTokenCalls, 0, `token was looked up for ${target}`);
  }
}

{
  // The API-prefix predicate itself, including the near-miss cases.
  const at = (href) => new URL(href, APP_ORIGIN);
  assert.equal(isButtlerApiRequest(at("/api/restrooms"), APP_ORIGIN), true);
  assert.equal(isButtlerApiRequest(at("/api/contributions"), APP_ORIGIN), true);
  assert.equal(isButtlerApiRequest(at("/api"), APP_ORIGIN), true);
  assert.equal(isButtlerApiRequest(at("/apiology"), APP_ORIGIN), false);
  assert.equal(isButtlerApiRequest(at("/"), APP_ORIGIN), false);
  assert.equal(isButtlerApiRequest(at("/tiles/osm/1.png"), APP_ORIGIN), false);
  assert.equal(
    isButtlerApiRequest(new URL("https://other.test/api/restrooms"), APP_ORIGIN),
    false,
  );
}

// ---------------------------------------------------------------------------
// 7. Public discovery stays anonymous and unauthenticated
// ---------------------------------------------------------------------------

{
  const rows = [
    {
      id: "canonical-1",
      name: "Test Restroom",
      latitude: 9.3,
      longitude: 123.3,
      address: "Dumaguete",
      access: "public",
      fee: "free",
      bidet: true,
      bidet_evidence: "field_verified",
    },
  ];
  const seen = [];
  // Deliberately unauthenticated: no provider, no token, no sign-in.
  const loaded = await loadRestrooms(async (input, init) => {
    seen.push({
      input,
      authorization: new Headers(init?.headers ?? undefined).get("authorization"),
    });
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(loaded.source, "d1");
  assert.equal(loaded.failure, null);
  assert.equal(loaded.data.length, 1);
  assert.equal(seen[0].input, "/api/restrooms");
  assert.equal(seen[0].authorization, null, "public catalogue request carried a bearer token");

  // A total network failure still yields the bundled catalogue, so a broken or
  // absent auth layer cannot blank the app.
  const offline = await loadRestrooms(async () => {
    throw new TypeError("Network unavailable");
  });
  assert.equal(offline.source, "bundled");
  assert.equal(offline.failure, "offline");
  assert.equal(offline.data.length, 776);
}

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

/**
 * Rough comment stripper: lets a check say "this may be documented, but it may
 * not be used". Truncating at the first `//` can also shorten a line that
 * contains a URL inside a string, which only ever weakens a check rather than
 * strengthening a false pass, and the strict allow-list in 8(a) covers env reads
 * without needing this.
 */
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.includes("//") ? line.slice(0, line.indexOf("//")) : line))
    .join("\n");

{
  // The public data path must not import the auth layer at all.
  const loaderSource = await read("../lib/restroom-loader.ts");
  assert.ok(!/src\/auth|authorized-fetch|AuthProvider/.test(loaderSource));
  assert.ok(!/Authorization/i.test(loaderSource));
  const hookSource = await read("../artifacts/buttler/src/hooks/use-offline-restrooms.ts");
  assert.ok(!/authorized-fetch|AuthProvider|useButtlerAuth/.test(hookSource));
}

// ---------------------------------------------------------------------------
// 8. Environment hygiene across the whole browser tree
// ---------------------------------------------------------------------------

const BROWSER_ROOT = fileURLToPath(new URL("../artifacts/buttler/src", import.meta.url));
const IGNORED_DIRS = new Set(["node_modules", "dist", "dev-dist"]);

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) found.push(...(await sourceFiles(full)));
      continue;
    }
    if (/\.(?:ts|tsx|js|jsx|css|html)$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

const browserFiles = await sourceFiles(BROWSER_ROOT);
assert.ok(browserFiles.length > 20, `expected the real tree, found ${browserFiles.length}`);
const byPath = new Map();
for (const path of browserFiles) byPath.set(path, await readFile(path, "utf8"));

{
  // (a) The only `import.meta.env.X` reads allowed anywhere in the browser are
  // Vite's own build flags plus BASE_URL. Every Auth0 value must go through
  // readAuth0Config(), which is what keeps the three-name allow-list enforceable.
  const ALLOWED_META_READS = new Set(["BASE_URL", "DEV", "PROD", "MODE"]);
  const offenders = [];
  for (const [path, text] of byPath) {
    for (const match of text.matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g)) {
      if (!ALLOWED_META_READS.has(match[1])) offenders.push(`${path}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `undocumented env read(s): ${offenders.join(", ")}`);
  // Including, explicitly, any direct VITE_ read that bypasses the allow-list.
  for (const [, text] of byPath) {
    assert.ok(!/import\.meta\.env\.VITE_/.test(text));
  }
}

{
  // (b) Server-only names may appear in browser CODE exactly once: inside the
  // block-list that this test uses. Documenting them in a comment is allowed and
  // useful; reading, echoing, or shipping one is not. Stripping comments first is
  // what makes both true at once.
  const blockListPath = `${BROWSER_ROOT}/auth/config.ts`;
  for (const [path, text] of byPath) {
    const code = withoutComments(text);
    for (const name of SERVER_ONLY_ENV_NAMES) {
      if (!code.includes(name)) continue;
      assert.equal(path, blockListPath, `${name} is used by browser code in ${path}`);
    }
  }
  // The block-list itself must actually list the moderator allow-list, and the
  // browser allow-list must stay exactly the three documented public values.
  assert.ok(SERVER_ONLY_ENV_NAMES.includes("BUTTLER_MODERATOR_IDS"));
  assert.ok(SERVER_ONLY_ENV_NAMES.some((name) => /SECRET|TOKEN/.test(name)));
  assert.deepEqual([...BROWSER_SAFE_AUTH0_ENV], [
    "VITE_AUTH0_DOMAIN",
    "VITE_AUTH0_CLIENT_ID",
    "VITE_AUTH0_AUDIENCE",
  ]);
}

{
  // (c) The declared frontend contract must not drift from the code.
  const envDts = await read("../artifacts/buttler/src/env.d.ts");
  const declared = [...envDts.matchAll(/\b(readonly (VITE_[A-Z0-9_]+)\??:)/g)].map((m) => m[2]).sort();
  assert.deepEqual(declared, [...BROWSER_SAFE_AUTH0_ENV].sort());
  // The declaration file may explain the boundary in prose, but its types must
  // only ever expose the three public names.
  const declaredCode = withoutComments(envDts);
  for (const forbidden of SERVER_ONLY_ENV_NAMES) {
    assert.ok(!declaredCode.includes(forbidden), `env.d.ts declares server-only ${forbidden}`);
  }

  const example = await read("../artifacts/buttler/.env.example");
  const exampleKeys = [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exampleKeys, [...BROWSER_SAFE_AUTH0_ENV].sort());
}

{
  // (d) No secret-store file is tracked, and the ignore rules stay in place.
  const gitignore = await read("../.gitignore");
  assert.match(gitignore, /^\.dev\.vars$/m);
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
}

{
  // (e) If a local .dev.vars exists, no value from it may be copied into browser
  // source — except the three that are public by design and are *meant* to be
  // mirrored into VITE_AUTH0_* (domain, client id, audience). Anything else in
  // that file (a moderator list, a future provider secret) must not appear.
  // Values are only ever compared, never printed.
  const PUBLIC_BY_DESIGN_KEYS = new Set([
    "AUTH0_DOMAIN",
    "AUTH0_CLIENT_ID",
    "AUTH0_API_AUDIENCE",
  ]);
  let privateValues = [];
  try {
    privateValues = (await read("../.dev.vars"))
      .split(/\r?\n/)
      .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
      .filter(Boolean)
      .filter((m) => !PUBLIC_BY_DESIGN_KEYS.has(m[1]))
      .map((m) => m[2].trim().replace(/^(["'])(.*)\1$/, "$2"))
      .filter((value) => value.length >= 6);
  } catch {
    privateValues = []; // no local server config to check against
  }
  const leaks = [];
  for (const [path, text] of byPath) {
    for (const value of privateValues) {
      if (text.includes(value)) leaks.push(path);
    }
    // Shape-based sweep, independent of any file: no credentials of any kind.
    if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)) {
      leaks.push(`${path} (JWT-shaped literal)`);
    }
    if (/Bearer\s+[A-Za-z0-9._-]{20,}/.test(withoutComments(text))) {
      leaks.push(`${path} (hardcoded bearer token)`);
    }
  }
  assert.deepEqual(leaks, [], "a server-side or credential value appears in browser source");
}

{
  // (f) The auth layer is opt-in at the module level: only auth0-client.ts may
  // reference the SDK, and it must load it lazily so an unconfigured deployment
  // downloads no Auth0 code at all.
  const sdkRefs = [...byPath]
    .filter(([, text]) => /auth0-spa-js/.test(text))
    .map(([path]) => path)
    .filter((path) => !path.endsWith("/auth/auth0-client.ts"));
  assert.deepEqual(sdkRefs, [], "the SDK is imported outside auth0-client.ts");
  const clientSource = withoutComments(byPath.get(`${BROWSER_ROOT}/auth/auth0-client.ts`));
  assert.match(clientSource, /await import\("@auth0\/auth0-spa-js"\)/);
  // Only a type-only import may be static — those erase to nothing at runtime.
  for (const line of clientSource.split("\n")) {
    if (/^import .*from "@auth0\/auth0-spa-js"/.test(line.trim())) {
      assert.match(line, /^import type /, `static runtime SDK import: ${line.trim()}`);
    }
  }
  // The client the SDK is built with asks for an audience and nothing secret:
  // no client_secret option, and no implicit/password grant anywhere in the
  // auth layer.
  const authLayer = [...byPath]
    .filter(([path]) => path.includes("/auth/"))
    .map(([, text]) => withoutComments(text))
    .join("\n")
    // config.ts legitimately names the forbidden values inside its block-list.
    .replace(/"(?:BUTTLER_MODERATOR_IDS|AUTH0_CLIENT_SECRET|AUTH0_MANAGEMENT_TOKEN|CLIENT_SECRET)",?/g, "");
  assert.ok(!/clientSecret|client_secret/i.test(authLayer), "a client secret is being used");
  assert.ok(!/response_type\s*[:=]/i.test(authLayer), "implicit flow");
  assert.ok(!/grant_type[\s\S]{0,24}(password|token)/i.test(authLayer), "non-PKCE grant");
  assert.match(authLayer, /cacheLocation:\s*"memory"/);
  assert.match(authLayer, /audience/);
}

// ---------------------------------------------------------------------------
// 9. UI surface (source assertions, mirroring scripts/map-offline.test.mjs)
// ---------------------------------------------------------------------------

{
  const control = byPath.get(`${BROWSER_ROOT}/auth/AuthControl.tsx`);
  // All five states render something, and the unconfigured state is byte-for-byte
  // the placeholder Buttler ships today.
  for (const label of [
    "Log in — coming soon",
    "Checking sign-in…",
    "Log in",
    "Try sign-in again",
    "Log out",
  ]) {
    assert.ok(control.includes(label), `missing state label: ${label}`);
  }
  assert.match(control, /case "authenticated"/);
  assert.match(control, /aria-live="polite"/);
  assert.match(control, /focus-visible:ring-2/);
  // The control renders state, never a permission. (`role="status"` is ARIA and
  // expected, so the check looks for capability words and claim reads.)
  const controlCode = withoutComments(control);
  assert.ok(!/moderator|permission|isAdmin|is_admin|claims\.|\broles\b/i.test(controlCode));
}

{
  const home = byPath.get(`${BROWSER_ROOT}/pages/Home.tsx`);
  // The old disabled placeholders are gone, replaced by the real control.
  assert.ok(!/coming soon/.test(home));
  assert.equal((home.match(/<AuthControl size="(sm|md)" \/>/g) ?? []).length, 2);
  assert.match(home, /import\.meta\.env\.DEV &&/);
  assert.match(home, /<DevAuthProbe \/>/);
  // Sign-in must not gate discovery.
  assert.match(home, /<AuthProvider|RestroomList|useOfflineRestrooms/);

  const app = byPath.get(`${BROWSER_ROOT}/App.tsx`);
  assert.match(app, /<AuthProvider>/);

  // The dev probe is read-only: one GET, no mutation of any kind.
  const probe = byPath.get(`${BROWSER_ROOT}/auth/DevAuthProbe.tsx`);
  assert.match(probe, /PROTECTED_PATH = "\/api\/me\/contributions"/);
  assert.match(probe, /method: "GET"/);
  assert.ok(!/method: "(POST|PUT|PATCH|DELETE)"/.test(probe));
}

{
  // The provider must not be able to take the app down with it: every failure
  // path dispatches a state, and the hook has a non-throwing fallback.
  const provider = byPath.get(`${BROWSER_ROOT}/auth/AuthProvider.tsx`);
  assert.match(provider, /catch \(cause\)/);
  assert.match(provider, /type: "error"/);
  assert.match(provider, /type: "unconfigured"/);
  assert.match(provider, /useContext\(AuthContext\) \?\? FALLBACK_AUTH/);
  // Startup failures become state; no `throw` statement escapes into the tree.
  assert.ok(!/^\s*throw\b/m.test(withoutComments(provider)), "provider startup must not throw");
  // Redirect handling runs once, then the one-time params are dropped.
  assert.match(provider, /startedRef/);
  assert.match(provider, /withoutRedirectParams/);
}

// ---------------------------------------------------------------------------
// 10. Built bundle (only when a production build exists locally)
// ---------------------------------------------------------------------------

{
  let bundleFiles = [];
  try {
    bundleFiles = await collectAssets(fileURLToPath(new URL("../artifacts/buttler/dist", import.meta.url)));
  } catch {
    bundleFiles = [];
  }
  if (bundleFiles.length > 0) {
    const offenders = [];
    for (const path of bundleFiles) {
      const text = await readFile(path, "utf8");
      for (const name of SERVER_ONLY_ENV_NAMES) {
        if (text.includes(name)) offenders.push(`${path}: ${name}`);
      }
      // The dev-only probe is statically folded out of production output.
      if (/dev: protected API check/.test(text)) offenders.push(`${path}: dev probe`);
    }
    assert.deepEqual(offenders, [], "production bundle contains server-only material");
  }
}

async function collectAssets(dir) {
  const assets = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) assets.push(...(await collectAssets(full)));
    else if (/\.(?:js|css|html)$/.test(entry.name)) assets.push(full);
  }
  return assets;
}

console.log("STAGE13_FRONTEND_AUTH_TEST_SUCCESS");
