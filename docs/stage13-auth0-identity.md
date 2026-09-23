# Buttler 2.0 — Stage 13: Auth0 identity adapter

Status: **identity verification implemented and locally tested; contributions
still disabled.** This is the smallest engineering step after the Auth Provider
Selection Gate (`docs/auth-provider-selection.md`). It wires Auth0 into the one
identity seam (`functions/_lib/identity.ts`) and changes nothing else. No
production migration, no production data change, no deployment, and no secret
was created here.

---

## What this does

Auth0 is now the configured provider **only when its non-secret configuration
is present**. The Pages Function verifies the caller's Auth0 **access token
locally** — an RS256 signature check against Auth0's public JWKS plus issuer,
audience, and expiry validation — and derives a single stable identity: the
Auth0 `sub`. There is no client secret, no per-request call to Auth0's
Management API, and no trust in any caller-supplied id or role.

Conceptual split (unchanged from the selection doc):

- **Auth0** answers *who is this user?* → the verified `sub`.
- **Buttler** answers *what may they do?* → role from the server-side allow-list.
- **D1** answers *what is canonical?* → untouched by this step.

All Auth0-specific code lives in `functions/_lib/identity.ts`. `http.ts`,
`authorize.ts`, the contribution store, contract, and apply boundary are
provider-agnostic and unchanged.

## JWT verification model

`resolveIdentity(request, env)`:

1. If `AUTH0_DOMAIN` or `AUTH0_API_AUDIENCE` is absent/blank →
   `{ configured: false }`. Handlers answer **503** ("contributions are not open
   yet"). This is the safe default and the current production reality.
2. Otherwise read the `Authorization: Bearer <token>` header. No bearer →
   `{ configured: true, identity: null }` → **401**. (The adapter ignores
   `X-User-ID`-style headers and body fields entirely.)
3. Verify the token and, on success, return
   `{ configured: true, identity: { userId: <sub>, role } }`.

Verified properties (any failure → `identity: null`, never an error-turned-pass):

- **Algorithm**: only `RS256` (asymmetric). `none`, `HS256`, and any `alg`
  confusion are rejected before any crypto.
- **Signature**: RSASSA-PKCS1-v1_5 / SHA-256 checked against the tenant's JWKS.
  Signing keys are resolved by `kid` from the live JWKS (cached ~60s and refetched
  on an unknown `kid`), so Auth0 key rotation is supported and no key is embedded.
- **Issuer**: must exactly equal `https://<AUTH0_DOMAIN>/` (Auth0's documented
  tenant-issuer format). A single derived issuer, never a set of alternatives.
- **Audience**: must contain `AUTH0_API_AUDIENCE` (string or array form).
- **Time**: `exp` required and not past (60s skew leeway); `nbf` honoured if present.
- **`azp`**: if `AUTH0_CLIENT_ID` is configured and the token names an
  authorized party, they must match (defense-in-depth).

**No `nonce` requirement.** A nonce belongs to the browser OIDC (ID-token) flow.
This path validates an OAuth2 *bearer access token* for API use; its
authorization-bearing claims are signature, `iss`, `aud`, and `exp`. Requiring a
nonce here would reject valid tokens without adding security.

## Identity representation

The seam returns the existing provider-independent `Identity`
(`lib/contributions/authorize.ts`):

```
{ userId: "<Auth0 sub>", role: "contributor" | "moderator" | "admin" }
```

- `userId` is the immutable Auth0 `sub` (e.g. `auth0|…`, `google-oauth2|…`).
  **Email is never the identity key** and is not persisted by this step.
- The stable `sub` is what a future contribution write would store in
  `contributions.contributor_user_id` (a `TEXT` column — fits as-is, no migration).

## Moderator authorization (unchanged, Buttler-side)

Roles are decided **only** by the server-side `BUTTLER_MODERATOR_IDS` allow-list
in `roleFor()` — never from a JWT claim, request body, or header. A user cannot
make themselves a moderator by editing a token. No Auth0 RBAC is used.
Self-approval and the privileged canonical-apply step remain enforced in
`authorize.ts`, unchanged.

## Environment variables (names only)

Configure via each environment's normal secret/env mechanism. None of these is a
secret value, but real tenant values stay out of Git and out of client bundles.

| Name | Purpose | Secret? | Where the owner sets it |
| --- | --- | --- | --- |
| `AUTH0_DOMAIN` | Auth0 tenant domain; derives issuer + JWKS URL | No | Cloudflare Pages env (future) / `.dev.vars` (local) |
| `AUTH0_API_AUDIENCE` | Expected token `aud` (the Auth0 API identifier) | No | Cloudflare Pages env (future) / `.dev.vars` (local) |
| `AUTH0_CLIENT_ID` | Optional `azp` cross-check | No | Cloudflare Pages env (future) / `.dev.vars` (local) |
| `BUTTLER_MODERATOR_IDS` | Comma-separated `sub` values allowed to moderate | Server-side only (not a secret, but must not ship to the browser) | Cloudflare Pages env / `.dev.vars` |

Local development: copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill
the values. `.dev.vars` and `.dev.vars.*` are ignored by Git; only the
`.example` template is tracked.

## Contribution system: still disabled

Verifying identity is **not** the same as opening contributions. Contributions
also require the staged schema `d1/contributions/0005_create_contributions.sql`,
which is **deliberately kept out of `d1/migrations/`** and guarded by
`scripts/d1-schema.test.mjs` (the three-table invariant). This task applied no
migration and enabled no contribution write.

- `USER SUBMISSION != CANONICAL DATA` — unchanged.
- Production endpoints still answer **503** because the Auth0 env vars are not
  set there and the schema is not applied. Enabling contributions is a separate,
  owner-approved step (see `docs/stage13-moderation-operations.md`).

## Testing

`pnpm test:stage13-identity`
(`node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage13-identity.test.mjs`)
verifies real RS256 signatures against **locally generated keys** via an
injected JWKS resolver — it never contacts the live Auth0 tenant and needs no
owner credentials. It covers: missing config fails closed; malformed / unsigned /
wrong-issuer / wrong-audience / expired / unsupported-algorithm / tampered /
unknown-kid tokens are all rejected; a valid token yields the `sub`; spoofed
headers and attacker-signed tokens cannot set identity; moderation still uses the
allow-list; and the contribution handler stays 503 (unconfigured) / 401 (bad
token). The existing `pnpm test:stage13` still passes unchanged (its env has no
Auth0 config, so the seam remains `{ configured: false }`).

## Production status

No production D1 migration, no production data change, no canonical-data change,
no contribution-migration application, no Cloudflare Pages deployment, and no
Cloudflare secret were performed here. This is a development-only adapter with
deterministic tests.

## Rollback

Revert this branch's single commit with a reversal commit (no history rewrite, no
force push). Nothing to roll back in the database — no migration was applied and
no data touched. Removing the `AUTH0_*` env configuration returns every protected
endpoint to the 503 fail-closed default.
