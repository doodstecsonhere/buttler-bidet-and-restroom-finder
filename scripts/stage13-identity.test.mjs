// Buttler 2.0 — Stage 13 identity adapter test (Auth0 verification seam).
//
// Focused ONLY on the authentication boundary in functions/_lib/identity.ts.
// It verifies real RS256 signatures against a locally generated key set via an
// injected JWKS resolver, so it NEVER contacts a live Auth0 tenant and needs no
// owner credentials. It proves the fail-closed contract and that identity comes
// exclusively from a verified token subject — never a caller-supplied header or
// body — and that moderation is still decided by Buttler's server-side
// allow-list. It runs entirely in-process and touches no database, file, or
// network.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage13-identity.test.mjs
import assert from "node:assert/strict";

import { resolveIdentity, roleFor } from "../functions/_lib/identity.ts";
import { onRequestPost as contributionHandler } from "../functions/api/contributions.ts";

// --- Config the adapter expects (non-secret test doubles) ------------------
const DOMAIN = "buttler-test.us.auth0.com";
const ISSUER = `https://${DOMAIN}/`;
const AUDIENCE = "https://api.buttler.test";
const CLIENT_ID = "test-client-id";

const BASE_ENV = { AUTH0_DOMAIN: DOMAIN, AUTH0_API_AUDIENCE: AUDIENCE };

// --- Local key material -----------------------------------------------------
const rsaParams = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const hostKey = await crypto.subtle.generateKey(rsaParams, true, ["sign", "verify"]);
const attackerKey = await crypto.subtle.generateKey(rsaParams, true, ["sign", "verify"]);

const hostJwk = await crypto.subtle.exportKey("jwk", hostKey.publicKey);
hostJwk.kid = "host-key-1";
hostJwk.use = "sig";
hostJwk.alg = "RS256";
const attackerJwk = await crypto.subtle.exportKey("jwk", attackerKey.publicKey);
attackerJwk.kid = "attacker-not-in-jwks";

// Production resolves keys from the network; tests inject a fixed set.
const deps = { fetchJwks: async () => ({ keys: [hostJwk] }) };
// A deps whose JWKS is empty, to model "signature key rotated away / unknown kid".
const emptyDeps = { fetchJwks: async () => ({ keys: [] }) };

// --- Token helpers ----------------------------------------------------------
function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

async function makeToken(claims, { header = { alg: "RS256" }, key = hostKey.privateKey, kid = "host-key-1" } = {}) {
  const headerObj = { typ: "JWT", ...header };
  if (kid) headerObj.kid = kid;
  const h = b64urlText(JSON.stringify(headerObj));
  const p = b64urlText(JSON.stringify(claims));
  const signingInput = new TextEncoder().encode(`${h}.${p}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signingInput);
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const validClaims = (over = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "auth0|user-123",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

function bearerRequest(token, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://app.test/api/contributions", { headers });
}

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, label);
  passed += 1;
};

// ===========================================================================
// 1. Missing / partial configuration fails closed (=> handlers answer 503).
// ===========================================================================
const goodToken = await makeToken(validClaims());
check("no config => not configured", (await resolveIdentity(bearerRequest(goodToken), {}, deps)).configured === false);
check("only domain => not configured", (await resolveIdentity(bearerRequest(goodToken), { AUTH0_DOMAIN: DOMAIN }, deps)).configured === false);
check("only audience => not configured", (await resolveIdentity(bearerRequest(goodToken), { AUTH0_API_AUDIENCE: AUDIENCE }, deps)).configured === false);
check("blank strings => not configured", (await resolveIdentity(bearerRequest(goodToken), { AUTH0_DOMAIN: "  ", AUTH0_API_AUDIENCE: "" }, deps)).configured === false);

// With config present, a valid token flips the gate to "configured".
const configured = await resolveIdentity(bearerRequest(goodToken), BASE_ENV, deps);
check("config present => configured", configured.configured === true);

// ===========================================================================
// 2-7. Every way a token can be bad yields { configured: true, identity: null }.
// ===========================================================================
async function expectReject(label, token, useDeps = deps) {
  const res = await resolveIdentity(bearerRequest(token), BASE_ENV, useDeps);
  assert.equal(res.configured, true, `${label}: should be configured`);
  assert.equal(res.identity, null, `${label}: identity must be null`);
  passed += 1;
}

const noneToken = (await makeToken(validClaims(), { header: { alg: "none" } })).replace(/\.[^.]*$/, ".");

await expectReject("malformed token", "not.a.jwt");
await expectReject("empty bearer", "");
await expectReject("unsigned alg=none", noneToken);
await expectReject("wrong issuer", await makeToken(validClaims({ iss: "https://evil.example/" })));
await expectReject("wrong audience", await makeToken(validClaims({ aud: "https://other-api/" })));
await expectReject("audience array without match", await makeToken(validClaims({ aud: ["https://nope/", "also-no"] })));
await expectReject("expired token", await makeToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 100 })));
await expectReject("missing exp", await makeToken(validClaims({ exp: undefined })));
await expectReject("not yet valid (nbf)", await makeToken(validClaims({ nbf: Math.floor(Date.now() / 1000) + 3600 })));
await expectReject("unsupported algorithm HS256", await makeToken(validClaims(), { header: { alg: "HS256" } }));
await expectReject("tampered signature", `${goodToken.slice(0, -4)}AAAA`);
await expectReject("missing kid header", await makeToken(validClaims(), { header: { alg: "RS256" }, kid: "" }));
await expectReject("kid not in JWKS (rotation/unknown)", await makeToken(validClaims(), { key: attackerKey.privateKey, kid: "attacker-not-in-jwks" }), emptyDeps);

// ===========================================================================
// 8-9. A valid Auth0-style RS256 token succeeds; identity is the `sub`.
// ===========================================================================
const SUB = "google-oauth2|114514";
const okRes = await resolveIdentity(bearerRequest(await makeToken(validClaims({ sub: SUB }))), BASE_ENV, deps);
check("valid token => configured", okRes.configured === true);
check("valid token => identity present", okRes.identity !== null);
check("identity.userId is exactly the Auth0 sub", okRes.identity.userId === SUB);
check("default role is contributor", okRes.identity.role === "contributor");

// Audience may be a plain string or an array containing the API id.
const arrAud = await resolveIdentity(bearerRequest(await makeToken(validClaims({ aud: [AUDIENCE, "other"], sub: SUB }))), BASE_ENV, deps);
check("array audience containing match is accepted", arrAud.identity && arrAud.identity.userId === SUB);

// ===========================================================================
// 10. Caller cannot supply or override the authenticated subject.
// ===========================================================================
const spoof = await resolveIdentity(bearerRequest(await makeToken(validClaims({ sub: SUB })), { "x-user-id": "admin", "x-role": "moderator" }), BASE_ENV, deps);
check("x-user-id header cannot change the subject", spoof.identity.userId === SUB);
check("x-role header cannot grant moderation", spoof.identity.role === "contributor");
const anonSpoof = await resolveIdentity(bearerRequest(null, { "x-user-id": SUB }), BASE_ENV, deps);
check("no token => null identity even with x-user-id", anonSpoof.configured === true && anonSpoof.identity === null);
await expectReject("attacker-signed subject ignored", await makeToken(validClaims({ sub: "auth0|victim" }), { key: attackerKey.privateKey, kid: "attacker-not-in-jwks" }));

// ===========================================================================
// 11. Moderation is Buttler's server-side allow-list, never a token claim.
// ===========================================================================
const modEnv = { ...BASE_ENV, BUTTLER_MODERATOR_IDS: " auth0|mod-1 , auth0|mod-2 " };
const modToken = await makeToken(validClaims({ sub: "auth0|mod-1", role: "nobody" }));
const modRes = await resolveIdentity(bearerRequest(modToken), modEnv, deps);
check("allow-listed subject becomes moderator", modRes.identity.role === "moderator");
const nonModRes = await resolveIdentity(bearerRequest(await makeToken(validClaims({ sub: "auth0|rando" }))), modEnv, deps);
check("non-listed subject stays contributor", nonModRes.identity.role === "contributor");
check("roleFor honors trimmed allow-list", roleFor("auth0|mod-2", modEnv) === "moderator");
check("roleFor default is contributor", roleFor("auth0|x", { BUTTLER_MODERATOR_IDS: "" }) === "contributor");

// ===========================================================================
// 12. Contribution endpoints stay behind the safety gate.
// ===========================================================================
const gated = await contributionHandler({
  request: bearerRequest(goodToken),
  env: { BUTTLER_DB: {} },
  params: {},
});
check("endpoint is 503 with auth unconfigured", gated.status === 503);

const denied = await contributionHandler({
  request: bearerRequest("garbage.token.here"),
  env: { ...BASE_ENV, BUTTLER_DB: {} },
  params: {},
});
check("endpoint is 401 with a bad token", denied.status === 401);

// A valid token is the ONLY thing that opens the auth gate, and that is proven
// at the seam itself (section 8-9, resolveIdentity returns a non-null identity
// for a cryptographically valid token). Opening the gate is still NOT enough to
// write: contributions need the staged D1 schema, which is intentionally absent
// and guarded by scripts/d1-schema.test.mjs. The handler reaches the store only
// past auth, which the two assertions above (503 unconfigured, 401 bad token)
// already pin down without needing the live network.

console.log(`STAGE13_IDENTITY_TEST_SUCCESS (${passed} assertions)`);
