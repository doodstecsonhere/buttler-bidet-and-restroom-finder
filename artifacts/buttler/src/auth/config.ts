// Buttler 2.0 — Stage 13 frontend: browser-safe Auth0 configuration.
//
// Everything in this file is deliberately PURE (no DOM, no SDK, no network) so
// the security-relevant rules can be read and unit-tested in Node. The SDK is
// only ever loaded by `auth0-client.ts`, and only after this module says the
// public configuration exists — with no configuration the feature is inert.
//
// WHAT MAY LEAK INTO THE BROWSER
// A Vite build inlines only variables the frontend explicitly reads. This module
// reads exactly three, all of which Auth0 documents as public for a
// browser-side (Authorization Code + PKCE) application:
//
//   VITE_AUTH0_DOMAIN      the tenant domain            (e.g. tenant.us.auth0.com)
//   VITE_AUTH0_CLIENT_ID   the public application id    (not a secret for PKCE)
//   VITE_AUTH0_AUDIENCE    the API identifier = token `aud`
//
// A PKCE public client has NO secret. `BUTTLER_MODERATOR_IDS` and any provider
// secret are server-only and must never appear in this list — see
// SERVER_ONLY_ENV_NAMES, which `scripts/stage13-frontend-auth.test.mjs` enforces
// against the whole browser source tree.
//
// WHY THESE MIRROR THE SERVER NAMES
// `functions/_lib/identity.ts` verifies `iss` + `aud` from AUTH0_DOMAIN /
// AUTH0_API_AUDIENCE. If the browser asked for a different audience, every
// protected call would fail with 401. Keeping one allow-list of three names on
// each side makes that mismatch visible in a test rather than in production.

/** The only Auth0 values this application may ever send to a browser. */
export const BROWSER_SAFE_AUTH0_ENV = [
  "VITE_AUTH0_DOMAIN",
  "VITE_AUTH0_CLIENT_ID",
  "VITE_AUTH0_AUDIENCE",
] as const;

export type BrowserSafeAuth0EnvName = (typeof BROWSER_SAFE_AUTH0_ENV)[number];

/**
 * Names that exist only on the server. Any appearance of one of these in
 * browser source (or in a built bundle) is a secret-hygiene bug, so the test
 * suite greps the frontend tree for them.
 */
export const SERVER_ONLY_ENV_NAMES = [
  "BUTTLER_MODERATOR_IDS",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_MANAGEMENT_TOKEN",
  "CLIENT_SECRET",
] as const;

/** The three public values, once confirmed present. */
export interface PublicAuth0Config {
  /** Bare tenant host, scheme and trailing slash removed. */
  domain: string;
  /** Public application client id. */
  clientId: string;
  /** API identifier requested as the token audience. */
  audience: string;
}

export type Auth0ConfigResult =
  | { status: "configured"; config: PublicAuth0Config }
  // Missing/blank configuration is a normal state, not an error: the sign-in
  // control stays a disabled placeholder and nothing else changes.
  | { status: "missing"; missing: BrowserSafeAuth0EnvName[] };

/**
 * The minimum the reader needs. Keeping it narrow (rather than
 * `Record<string, string | undefined>`) means `import.meta.env` — whose type
 * also carries `DEV`/`PROD` booleans — stays assignable without a cast, and
 * nothing outside these three names can be read from it here.
 */
export interface Auth0EnvSource {
  readonly VITE_AUTH0_DOMAIN?: string;
  readonly VITE_AUTH0_CLIENT_ID?: string;
  readonly VITE_AUTH0_AUDIENCE?: string;
}

/**
 * Read and validate the browser-safe Auth0 configuration.
 *
 * `env` is injected (normally `import.meta.env`) so the same rules run under
 * Node tests. Any variable outside the allow-list is ignored even if present.
 */
export function readAuth0Config(
  env: Auth0EnvSource | undefined,
): Auth0ConfigResult {
  const source = env ?? {};
  const domain = normalizeDomain(source.VITE_AUTH0_DOMAIN);
  const clientId = (source.VITE_AUTH0_CLIENT_ID ?? "").trim();
  const audience = (source.VITE_AUTH0_AUDIENCE ?? "").trim();

  const missing: BrowserSafeAuth0EnvName[] = [];
  if (!domain) missing.push("VITE_AUTH0_DOMAIN");
  if (!clientId) missing.push("VITE_AUTH0_CLIENT_ID");
  if (!audience) missing.push("VITE_AUTH0_AUDIENCE");
  if (missing.length > 0) return { status: "missing", missing };

  return {
    status: "configured",
    config: { domain, clientId, audience },
  };
}

/**
 * Auth0's tenant domain is a bare host. Accept the value an owner is likely to
 * paste (with scheme and/or trailing slash) but hand back exactly the form both
 * the SDK and `identity.ts` expect.
 */
export function normalizeDomain(raw: string | undefined): string {
  let value = (raw ?? "").trim();
  value = value.replace(/^https:\/\//i, "");
  value = value.replace(/\/+$/, "");
  // A host with a space or a slash left in it is a typo, not a tenant domain.
  if (/[\s/]/.test(value)) return "";
  return value;
}

/**
 * The URL Auth0 redirects back to. The app is a single-page PWA with no
 * callback route, so the return target is the app root itself; the SDK then
 * reads `?code`/`?state` from it. It must match an entry in the tenant's
 * "Allowed Callback URLs" exactly.
 */
export function callbackUrlFor(origin: string, basePath = "/"): string {
  const root = origin.replace(/\/+$/, "");
  const path = basePath.replace(/^\/+|\/+$/g, "");
  return path ? `${root}/${path}/` : `${root}/`;
}

/** True when the browser came back from Auth0 with an authorization response. */
export function hasRedirectResult(search: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return false;
  }
  // `code` is success, `error` is a failed login; both must be consumed (and
  // both are rejected by the SDK if the PKCE transaction is gone).
  return params.has("code") || params.has("error");
}

/**
 * Strip the one-time authorization parameters from a URL once handled.
 * Leaving them behind means a refresh reuses a spent `code` and shows an error
 * the user cannot act on.
 */
export function withoutRedirectParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return url;
  }
  for (const key of ["code", "state", "error", "error_description"]) {
    parsed.searchParams.delete(key);
  }
  const query = parsed.searchParams.toString();
  const base = `${parsed.origin}${parsed.pathname}`;
  // A spent authorization response carries no other query state worth keeping,
  // so drop an emptied `?` entirely to return the URL to its original shape.
  return query ? `${base}?${query}` : base;
}

/**
 * Turn an unknown thrown value into one short, safe sentence.
 *
 * Auth0 errors expose `error` / `error_description` codes; those are useful and
 * not sensitive. Tokens, `state`, and codes must never reach the UI or a log,
 * so only those two fields are read and the result is truncated.
 */
export function describeAuthError(cause: unknown): string {
  const fallback = "sign-in could not complete";
  if (!cause || typeof cause !== "object") {
    const text = String(cause ?? "").trim();
    return text ? text.slice(0, 160) : fallback;
  }
  const record = cause as Record<string, unknown>;
  const code = typeof record.error === "string" ? record.error.trim() : "";
  const description =
    typeof record.error_description === "string"
      ? record.error_description.trim()
      : "";
  const message = [code, description].filter(Boolean).join(": ");
  if (!message) {
    const generic =
      typeof record.message === "string" ? record.message.trim() : "";
    return generic ? generic.slice(0, 160) : fallback;
  }
  return message.slice(0, 160);
}
