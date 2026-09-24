/// <reference types="vite/client" />
//
// Buttler 2.0 — Stage 13 frontend: the browser-visible environment contract.
//
// Declaring the variables here (instead of relying on Vite's loose
// `[key: string]: any` index signature) is what keeps the allow-list honest:
// a component cannot read a `VITE_*` name that this file has not declared and
// documented, and the values below are the only Auth0 inputs the browser sees.
//
// All three are public-by-design for an Authorization Code + PKCE SPA. A PKCE
// public client has no secret, so there is nothing here that could be a secret,
// and server-only names (`BUTTLER_MODERATOR_IDS` and friends) are deliberately
// absent — see `src/auth/config.ts` and the test that enforces it.
interface ImportMetaEnv {
  /** Auth0 tenant domain, e.g. `your-tenant.us.auth0.com`. */
  readonly VITE_AUTH0_DOMAIN?: string;
  /** Public Auth0 application client id (not a secret for PKCE). */
  readonly VITE_AUTH0_CLIENT_ID?: string;
  /** API identifier requested as the access-token audience, e.g. `https://buttler-api`. */
  readonly VITE_AUTH0_AUDIENCE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
