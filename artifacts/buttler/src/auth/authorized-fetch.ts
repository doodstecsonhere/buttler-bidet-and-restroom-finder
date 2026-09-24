// Buttler 2.0 — Stage 13 frontend: the authenticated-request helper.
//
// One rule, stated once so it cannot be forgotten at each call site: a bearer
// token is attached to same-origin `/api/...` Buttler requests and to NOTHING
// else. Everything else in the app keeps using plain `fetch` — in particular
// the public restroom catalogue (`lib/restroom-loader.ts`) never imports this
// file, so browsing stays anonymous and works while signed out, offline, or
// with authentication unconfigured.
//
// The three guards, in order:
//   1. not our API origin  -> forward the request untouched; `getToken` is not
//      even called, so a token cannot leak to a tile server, a directions
//      provider, or a typo'd absolute URL.
//   2. no usable token     -> throw `AuthRequiredError` instead of sending an
//      unauthenticated request that would come back 401 with no explanation.
//   3. token in hand       -> set `Authorization: Bearer <token>`, replacing any
//      caller-supplied Authorization header rather than merging with it.
//
// Pure by construction: the origin, the token source, and `fetch` are injected,
// which is what lets scripts/stage13-frontend-auth.test.mjs exercise all three
// guards in Node without a browser or the Auth0 SDK.

/** Thrown when a protected call is attempted without an access token. */
export class AuthRequiredError extends Error {
  readonly name = "AuthRequiredError";
  readonly path: string;

  constructor(path: string) {
    super(`Sign-in is required to use ${path}.`);
    this.path = path;
  }
}

export interface AuthorizedFetchDeps {
  /** Resolves the API access token, or `null` when nobody is signed in. */
  getToken: () => Promise<string | null>;
  /** The app's own origin, e.g. `https://buttler.pages.dev` (no trailing slash). */
  origin: string;
  /** Injected for tests; defaults to the platform `fetch`. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** A drop-in `fetch` for Buttler's own protected endpoints. */
export type AuthorizedFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * True only for Buttler's own API on Buttler's own origin.
 *
 * Pages Functions are mounted at the site root (`/api/...`), independent of the
 * Vite base path, so the prefix check is intentionally absolute.
 */
export function isButtlerApiRequest(url: URL, origin: string): boolean {
  if (url.origin !== origin) return false;
  return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

export function createAuthorizedFetch(deps: AuthorizedFetchDeps): AuthorizedFetch {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const origin = deps.origin.replace(/\/+$/, "");

  return async (input, init) => {
    // Relative paths resolve against the app origin; an absolute URL to another
    // host resolves to itself and therefore fails the origin check below.
    let url: URL;
    try {
      url = new URL(input, origin);
    } catch {
      throw new AuthRequiredError(input || "(empty request)");
    }

    if (!isButtlerApiRequest(url, origin)) {
      // Guard 1: unrelated destination. No token lookup, no token header.
      return fetchImpl(input, init);
    }

    const token = (await deps.getToken())?.trim() ?? "";
    if (!token) {
      // Guard 2: fail here rather than firing a request that cannot succeed.
      throw new AuthRequiredError(url.pathname);
    }

    // Guard 3: same origin, our API, real token.
    const headers = new Headers(init?.headers ?? undefined);
    headers.set("Authorization", `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}
