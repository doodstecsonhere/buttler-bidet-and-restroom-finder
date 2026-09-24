// Buttler 2.0 — Stage 13 frontend: the Auth0 SDK boundary.
//
// This is the ONLY file that imports `@auth0/auth0-spa-js`, and the import is
// dynamic. Two consequences matter:
//   - With no public configuration the SDK is never fetched or parsed, so an
//     unconfigured (today: production) visitor downloads the same bundle
//     behaviour as before this feature existed.
//   - If Buttler ever swaps providers, this file and `config.ts` are the swap
//     surface; the provider, the UI, and `authorized-fetch.ts` do not change.
//
// FLOW: Authorization Code + PKCE, exactly as chosen in
// `docs/auth-provider-selection.md`. The SDK implements it; this file never
// touches a client secret (a PKCE public client has none), never uses the
// implicit `token` response_type, and never collects a password in the app.
//
// TOKEN HANDLING: `cacheLocation: "memory"` keeps the access token out of
// `localStorage`, so it cannot survive a page clone, a shared machine, or an
// XSS payload beyond the current tab. The cost is that a reload must renew
// silently, which relies on Auth0's session cookie; if a browser blocks
// third-party cookies the user simply signs in again. That trade is
// deliberate for a read-mostly app whose write path is still disabled.

import type { Auth0Client } from "@auth0/auth0-spa-js";
import type { PublicAuth0Config } from "./config.ts";
import type { IdentityClaims } from "./state.ts";

/** What the rest of the app is allowed to ask the provider for. */
export interface ButtlerAuthClient {
  isAuthenticated(): Promise<boolean>;
  getUser(): Promise<IdentityClaims | undefined>;
  /** Access token for the Buttler API audience, or `null` when unavailable. */
  getAccessToken(): Promise<string | null>;
  /** Send the browser to Auth0's Universal Login, coming back to `redirectUri`. */
  login(redirectUri: string): Promise<void>;
  /** End the local session and return the browser to `returnTo`. */
  logout(returnTo: string): Promise<void>;
  /** Exchange the `?code` Auth0 returned for tokens (Authorization Code + PKCE). */
  completeRedirectCallback(): Promise<void>;
  /** Try to restore a session without user interaction; never throws. */
  restoreSession(): Promise<void>;
}

// One client per page. A second `Auth0Client` would start a second PKCE
// transaction and race the first over the same stored session.
let pendingClient: Promise<Auth0Client> | null = null;

export function createAuth0Client(
  config: PublicAuth0Config,
  redirectUri: string,
): Promise<Auth0Client> {
  if (!pendingClient) {
    pendingClient = (async () => {
      const { Auth0Client } = await import("@auth0/auth0-spa-js");
      return new Auth0Client({
        domain: config.domain,
        clientId: config.clientId,
        cacheLocation: "memory",
        authorizationParams: {
          // The API identifier. The server rejects any token whose `aud` is not
          // exactly this value, so a wrong audience fails closed rather than
          // authorizing the wrong API.
          audience: config.audience,
          redirect_uri: redirectUri,
          // Ordinary identity only. No `offline_access`: refresh tokens need a
          // dashboard change the owner has not approved.
          scope: "openid profile email",
        },
      });
    })();
  }
  return pendingClient;
}

/**
 * Adapt the SDK to `ButtlerAuthClient`.
 *
 * Everything that can fail does so in exactly one of two ways: it throws (the
 * caller shows the error state) or it returns `null`/`false` (the caller stays
 * anonymous). It never half-authenticates.
 */
export async function createButtlerAuthClient(
  config: PublicAuth0Config,
  redirectUri: string,
): Promise<ButtlerAuthClient> {
  const client = await createAuth0Client(config, redirectUri);

  return {
    isAuthenticated: () => client.isAuthenticated(),
    getUser: () => client.getUser<IdentityClaims>(),
    async getAccessToken() {
      try {
        const token = await client.getTokenSilently();
        return typeof token === "string" && token.trim() ? token : null;
      } catch {
        // Silent renewal needs interaction (or cookies are blocked). Not an
        // error to show the user — just no token for this request.
        return null;
      }
    },
    login: (target) =>
      client.loginWithRedirect({
        authorizationParams: { redirect_uri: target },
      }),
    logout: (returnTo) =>
      client.logout({ logoutParams: { returnTo } }),
    async completeRedirectCallback() {
      // The result carries app state this app does not use; the tokens it
      // stored in memory are the point.
      await client.handleRedirectCallback();
    },
    async restoreSession() {
      try {
        await client.checkSession();
      } catch {
        // A failed silent renewal is expected when signed out; the user can
        // still browse, and can sign in explicitly.
      }
    },
  };
}
