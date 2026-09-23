# Buttler 2.0 — Stage 13: Authentication Provider Selection

Status: **DECISION GATE — selection made, nothing implemented.** This document
chooses one authentication provider for Buttler's open-community contributor
model and records the evidence. It creates no provider account, no OAuth
client, no secret, no production environment variable, no migration, and no
deployment. Authentication remains **disabled**; the identity seam
(`functions/_lib/identity.ts`) still fails closed.

Verified against official provider pricing pages and Cloudflare docs on
2026-09-23. Free-tier terms change; **re-verify before connecting.**

---

## 1. Decision

**Selected provider: Auth0** (Free plan, standards-based OIDC/JWT integration,
verified server-side inside Cloudflare Pages Functions).

Runner-up that was seriously considered: **Clerk**. Rejected for this use case:
**Supabase Auth**.

The decision is engineering-driven, not popularity- or convenience-driven. It is
justified in §9; the two non-selected providers are justified in §10.

---

## 2. Buttler requirements (what the provider must satisfy)

Carried from the product decision already made (an **open community of
potentially many users**, not a private 10–50 contributor tool) and from
`AGENTS.md` / the Stage 12–13 architecture:

1. Support account creation + authentication for a public contributor
   population.
2. Never give contributors direct write access to `canonical_locations`,
   `location_provenance`, or legacy `restroom_locations`. The invariant
   `USER SUBMISSION != CANONICAL DATA` is unchanged.
3. Fit the existing headless identity seam: verify a session/JWT **server-side**
   and return a **stable, immutable subject id**. No client-supplied identity.
4. Strong preference to stay **$0** during the early/community phase; hard-stop
   rather than surprise-bill.
5. Run cleanly in the **Cloudflare Workers / Pages Functions** runtime — no
   Node-only packages.
6. Not become the canonical data store; **D1 stays the application data
   authority.**
7. Keep the provider at the **boundary** so it is replaceable with low lock-in.
8. Work for users in the **Philippines**: email + Google login, no dependency on
   paid SMS.
9. Support a future, much smaller **moderator/admin** surface.
10. Contribute sensible abuse protection, while Buttler keeps enforcing its own
    per-user limits, payload caps, duplicate detection, moderation, and
    suspension.

---

## 3. Current architecture (verified, not assumed)

Production stack: **Cloudflare Pages + Pages Functions + D1**, React/TypeScript
frontend. Public read API is GET-only. Stage 13 ships an inert, fail-closed
contribution + moderation foundation.

Identity seam — `functions/_lib/identity.ts`:
- `resolveIdentity(request, env)` currently returns `{ configured: false }`, so
  every protected endpoint answers **503** before touching the database.
- The intended live shape (comments in-file): read a session token
  (cookie / bearer) → `verifySession(token) => subjectId | null` → map to an
  `Identity` → `{ configured: true, identity }`.
- `roleFor(subjectId, env)` decides moderator vs contributor purely from a
  server-side allow-list env var `BUTTLER_MODERATOR_IDS` (comma-separated opaque
  subject ids). There is deliberately **no admin-vs-moderator split** at this
  scale, and **no client-trusted role field**.

Authorization — `lib/contributions/authorize.ts`:
- `Identity = { userId: string; role: "contributor" | "moderator" | "admin" }`.
- `userId` is documented as "an opaque provider subject id, assigned by the
  server from a verified session — never read from the request body."
- Moderation requires a moderator; **no self-approval**; canonical apply is a
  separate, still-inert privileged step.

Contribution store — `functions/_lib/contributions-store.ts`:
- Sets `contributor_user_id` from the verified identity, forces `status=pending`,
  enforces pending caps + duplicate detection, writes append-only events. No code
  path to `canonical_locations` on submit.

Contract & apply boundary — `lib/contributions/contract.ts` / `apply.ts`:
- Per-kind field allow-lists, reserved-key rejection, value-domain checks, size
  caps; canonical apply uses a fixed 7-column allow-list + parameterised
  statement. Provider choice does not change any of this.

D1 schema — `d1/contributions/0005_create_contributions.sql` (STAGED, not in
`d1/migrations/`):
- `contributions.contributor_user_id TEXT` — **no length cap**, so any provider's
  opaque subject id string fits as-is. No schema change is needed for any of the
  three candidates.

HTTP surface — `functions/_lib/http.ts`:
- `requireIdentity` / `requireModerator` gate every protected route; stateless
  request handling, `Cache-Control: no-store`, 503 when auth is unwired.

**Legacy Replit authentication (distinct, not reusable here):**
`lib/replit-auth-web/src/use-auth.ts` is a browser hook that calls
`/api/auth/user`, `/api/login`, `/api/logout` on the old Replit OIDC + Replit
Postgres backend. Those routes do not exist on Cloudflare Pages. This legacy
system **must not** be assumed usable for the D1/Pages stack and is not part of
this decision.

Current production data (must remain untouched by this gate): **776** canonical
locations, **845** provenance links, **1,112** legacy `restroom_locations` rows.

---

## 4. Auth0 analysis

- **Free-tier facts (verified 2026-09-23):** $0/month, **no credit card required
  to sign up**, up to **25,000 MAU** ("External Active Users" — a user counts if
  they authenticate at all during the month). 1 custom domain, **unlimited social
  connections**, **passwordless**, **passkeys**, Auth0 database connection, 5
  organizations, brand customization, community support.
- **Paid-tier facts:** Essentials from **$35/mo (B2C, 500 MAU)**; price scales by
  MAU tier (e.g. 5,000 MAU ≈ $350/mo Essentials; 25,000 ≈ $1,750/mo). Professional
  from $240/mo. Yearly = 11× monthly.
- **Authentication features:** email/password, email verification, passwordless,
  magic links / email OTP, Google + GitHub + other social, **passkeys on free**.
  Brute-force protection + suspicious-IP throttling ("Basic Attack Protection")
  are **included on free**. MFA and Role Management and Account Linking are
  **not** on free (Essentials+). Customizing sign-up/login email templates is
  Essentials+.
- **Cloudflare integration / JWT-OIDC mechanics:** Auth0 is a standard OIDC
  provider issuing RS256 access/ID tokens verifiable against Auth0's public
  **JWKS**. The current implementation verifies the signature **locally with the
  WebCrypto `crypto.subtle` API built into the Cloudflare Workers runtime**, keyed
  on the token's `kid` against Auth0's public JWKS — **no network call per request**
  (the JWKS is cached), **no JWT library dependency**, and no Node-only SDK. This is
  exactly the `verifySession(token) → sub` shape the seam expects. Auth0 explicitly
  supports headless/API-first auth.
- **Identity mapping:** stable immutable `sub` claim (e.g. `auth0|…`,
  `google-oauth2|…`). Email is a convenience, never the key.
- **Authorization options:** can emit custom claims / RBAC, but Buttler does not
  need provider RBAC — it keeps roles in `BUTTLER_MODERATOR_IDS` / D1.
- **Abuse/security:** free brute-force + suspicious-IP throttling; bot detection
  and breached-password detection are paid tiers. Buttler adds its own limits.
- **Privacy:** provider stores user profile; Buttler persists only the opaque
  `sub` in D1 (no email/IP in the contribution row, matching the existing
  "no emails/IPs/device fingerprints stored" policy).
- **Lock-in:** **lowest** of the three — OIDC/JWT are open standards, so the
  boundary (JWKS URL + audience + `sub`) is portable to any OIDC provider.
- **Operational risks:** **Custom domains require credit-card verification** (a
  real zero-dollar gotcha). Default `*.auth0.com` domain avoids the card but
  shows Auth0-branded Universal Login. Free log retention is 1 day. 1 tenant.
- **Likely implementation complexity:** low — a WebCrypto (`crypto.subtle`)-based
  `verifySession` plus a browser Auth0 (or Authorization Code + PKCE) flow; no
  second datastore and no JWT library dependency.
- **Likely cost path:** $0 up to 25K monthly-active authenticated contributors;
  only after that does a card + Essentials appear. For a Dumaguete City restroom
  app, 25K *monthly authenticating contributors* is a very high ceiling.

---

## 5. Clerk analysis

- **Free-tier facts (verified 2026-09-23):** Hobby $0, **no credit card**, up to
  **50,000 MRU per application**. MRU = **Monthly Retained User** — a user counts
  only if they return **at least one day after signing up** ("First Day Free").
  Unlimited applications, 3 dashboard seats, custom domain, prebuilt sign-up /
  sign-in / profile UIs.
- **Paid-tier facts:** Pro **$25/mo ($20 annual)**, includes 50K MRU then
  **$0.02/MRU** overage. Exceeding 50K MRU on Hobby forces an upgrade (1-month
  grace). Business $300/mo.
- **Authentication features:** passwords, usernames, email codes, magic links,
  email OTP, social login **up to 3 connections on free**, web3, sign-in tokens.
  **Passkeys are Pro-only. MFA is Pro-only. SMS codes are paid per-message.**
  **Clerk branding cannot be removed on free.** User bans / allowlist /
  blocklist are Pro-only. Free session lifetime is fixed to 7 days.
- **Cloudflare integration:** Clerk session tokens are JWTs with a stable `sub`
  (`user_…`), verifiable via Clerk JWKS; `@clerk/backend` runs in edge/Workers.
  But Clerk is **frontend-SDK-first**: it wants to own the sign-in UI and session
  handling, which is more surface than Buttler's deliberately-minimal headless
  seam and nudges toward re-designing the app around Clerk.
- **Identity mapping:** stable `user_…` id; email is secondary. Good.
- **Authorization:** basic roles exist, but Buttler keeps its own — not a factor.
- **Abuse/security:** free includes bot protection, account lockout, block
  disposable/subaddress emails; bans are paid.
- **Privacy / export:** full data exports on free; GDPR/DPAs.
- **Lock-in:** **highest** of the three — proprietary token claims, SDK-driven UX,
  and its own session model; portable only if Buttler stays strictly on the `sub`.
- **Operational risks:** unavoidable "Powered by Clerk" badge on a public,
  potentially-commercial app (branding + commercial-use concern); key security
  features paywalled.
- **Likely cost path:** the **MRU metric is the most viral-safe** of the three
  (one-time signups that don't return don't bill). Cheap to outgrow ($0.02/MRU).
- **Why it's runner-up:** best raw free headroom + cheapest overage, but the
  paid-MFA/paid-passkeys and forced-frontend + permanent free branding make it a
  weaker boundary fit than Auth0 for Buttler's stated shape.

---

## 6. Supabase Auth analysis

- **Free-tier facts (verified 2026-09-23):** $0, up to **50,000 MAU**, unlimited
  total users, social OAuth, custom SMTP, basic MFA, Auth JWTs. **Free projects
  pause after 1 week of inactivity; limit of 2 active projects.** Pro $25/mo +
  usage.
- **Cloudflare integration:** issues JWTs verifiable against Supabase's JWKS;
  `supabase-js` runs in edge/Workers. Technically workable in the seam.
- **Identity mapping:** stable UUID `sub`; Supabase keeps it stable across email
  changes. Good.
- **Architectural mismatch (the decisive point):** Supabase is a **full Postgres
  platform**, not just an auth edge. Adopting it means running a **second
  datastore** beside D1 whose whole project can **auto-pause after 7 idle days** —
  for a low/bursty-traffic community app, authentication could silently go down
  (fail-closed → contributors blocked). This also cuts against the constraint
  "the provider MUST NOT become the canonical data store": Supabase structurally
  *wants* to be a data store, and Buttler already has one (D1).
- **Lock-in:** auth is tied to Supabase's GoTrue/JWT system and its project model
  — awkward to extract without a migration.
- **Guidance honored:** the brief explicitly says *do not select Supabase merely
  because Buttler has used Supabase elsewhere.* History is not a reason here; the
  pause-on-inactivity + redundant-database facts are against it.

---

## 7. Comparison matrix

Facts verified 2026-09-23. No weighted score is used — selection is by explicit
engineering reasons (§9).

| Criterion | Auth0 | Clerk | Supabase Auth | Buttler implication |
| --- | --- | --- | --- | --- |
| Free user allowance | 25,000 MAU | 50,000 MRU | 50,000 MAU | All far exceed realistic Dumaguete contributor volume |
| Billing metric | MAU (auth in month) | MRU (retained ≥1 day after signup) | MAU | Buttler counts only *authenticated contributors*, so MAU overstates usage |
| Card required to start free | No | No | No | All $0 to begin |
| Email/password | Yes | Yes | Yes | All fit |
| Passwordless / magic link / email OTP | Yes | Yes | Yes | All fit |
| Google / GitHub social | Unlimited (free) | Up to 3 (free) | Yes (free) | Google login is the key PH method — all OK |
| Passkeys | **Yes (free)** | **Pro only** | Yes (free) | Auth0 advantage |
| MFA | Essentials+ (not free) | **Pro only** | Basic (free) | Contributor MFA low-stakes; moderator surface separate |
| Custom domain | 1, **but card verification required** | Yes (free) | Own domain | Clerk easiest; Auth0 needs card for custom domain |
| Branding on free | Customizable | **Clerk badge, not removable on free** | None | Clerk badge is a commercial concern |
| Abuse protection (free) | Brute-force + IP throttling | Bot + lockout + disposable-email block | Basic | All help; Buttler adds own limits regardless |
| JWT / OIDC | Standard OIDC, RS256 + JWKS | JWT + JWKS (proprietary claims) | JWT + JWKS | All verifiable server-side |
| Local JWT verification (no per-request network) | Yes (WebCrypto `crypto.subtle`, no JWT lib) | Yes (`jose` / `@clerk/backend`) | Yes (`jose` / `supabase-js`) | All fit the seam |
| Cloudflare Workers/Pages fit | Clean, headless, standards-first | Works, but frontend-SDK-first | Works, but project may pause | Auth0 smallest surface |
| Contributor identity stability | Stable `sub` | Stable `user_…` | Stable UUID | All fit |
| Account deletion / export | Yes | Full exports (free) | Yes | All fit |
| Free-tier operational risk | 25K ceiling; custom-domain card | Paywalled MFA/passkeys; forced branding | **7-day idle pause + 2-project cap** | Supabase riskiest for a public portal |
| Likely integration complexity | Low | Low-Med (UI pull) | Med (2nd datastore) | Auth0/Clerk simple |
| Vendor lock-in | **Lowest (open OIDC)** | Highest (proprietary UX/tokens) | Medium (own project/DB) | Boundary must stay swappable |
| Moderator architecture fit | Same provider + `BUTTLER_MODERATOR_IDS`; Cloudflare Access optional | Same | Same | Auth0 cleanest for a headless moderator check |

### Cloudflare / D1 cost interaction (criterion 14)

Verified Cloudflare Free baselines (2026-09-23): Pages Functions draw on the
Workers cap of **100,000 requests/day**; D1 Free = **5,000,000 rows read/day**,
**100,000 rows written/day**, **5 GB storage**. As of **2026-09-01, D1 Free-plan
queries fail (do not bill) when a daily row limit is exceeded** — a hard-stop,
consistent with the zero-dollar rule.

Illustrative (clearly-labeled, not projected traffic) scenario: if authenticated
contributors submit ~10 contributions each per month and each submit/list
endpoint reads a small bounded set, request volume stays a rounding error against
100K/day and D1 writes stay far under 100K rows/day for any plausible Dumaguete
community. The provider choice does **not** meaningfully change Cloudflare cost;
the binding constraint is the provider's own free MAU/MRU ceiling, not D1.

---

## 8. Selected provider

**Auth0** — Free plan, integrated as a standard OIDC provider with server-side
JWT verification inside Pages Functions.

---

## 9. Why Auth0 fits Buttler

1. **Cleanest fit for the actual seam.** Buttler's identity boundary is a
   deliberately tiny, headless `verifySession(token) → stable subject id`. Auth0
   is standards-based OIDC whose RS256 JWT verifies **locally with the Workers
   WebCrypto `crypto.subtle` API against a public JWKS** — no JWT library
   dependency, no forced frontend SDK, no second database, no per-request network
   call. This is the smallest change to `identity.ts`.
2. **Stays at the boundary → lowest lock-in.** Because Auth0 speaks open OIDC,
   the whole provider coupling is: issuer URL + audience + `sub`. Swapping
   providers later does not touch D1, contribution history, moderation history,
   or provenance — satisfying the "provider-independent identity boundary" goal
   better than Clerk's proprietary UX or Supabase's project-coupled auth.
3. **Security an open community needs, on the free tier.** Free Auth0 already
   includes brute-force protection and suspicious-IP throttling, plus **passkeys
   and passwordless and unlimited social login** — features Clerk only unlocks on
   paid plans. Combined with Buttler's own server-side limits (already built in
   the store), this is the strongest free anti-abuse baseline.
4. **Respects the architecture rule.** Auth0 will not try to become the data
   store; D1 remains the sole application data authority. Choosing Supabase would
   introduce a competing datastore that auto-pauses when idle.
5. **Philippines / community access.** Google login + email/passwordless work
   with no SMS and no per-login cost on any of the three; Auth0 needs no paid
   phone infrastructure.
6. **Zero-dollar safety with a high enough ceiling.** No card to start; exceeding
   25K *monthly authenticating contributors* is a distant ceiling for this app,
   and Auth0 stops-and-prompts rather than silently billing a card-on-file that
   isn't there.

---

## 10. Why the other two were not selected

**Clerk (runner-up).** Its free 50K **MRU** metric is the most viral-cost-safe and
its UI is the fastest to ship — but those are exactly the reasons the brief warns
against choosing it ("not merely because its UI is convenient"). Against
Buttler's *specific* shape: (a) it is frontend-SDK-first and pulls Clerk's own
sign-in UI/session model into an app whose seam is intentionally headless —
risking "redesigning Buttler around the provider"; (b) **passkeys and MFA are
Pro-only** and **user bans are paid**, so its free security is weaker for an open
community than it first looks; (c) the **non-removable Clerk brand on the free
tier** is a visible third-party badge on a product the owner may commercialize.
Lock-in is also the highest of the three. Clerk remains the fallback if the owner
later prioritizes fastest shipped UI over a minimal headless boundary.

**Supabase Auth.** Rejected on operational and architectural grounds, not price:
the **free project auto-pauses after 1 week of inactivity** (with a 2-active-
project cap), which can take authentication down for a bursty/low-traffic public
portal — and a paused auth provider fails Buttler closed, blocking legitimate
contributors. It is also a full Postgres platform, so using it purely as an auth
edge means running a **redundant datastore beside D1**, which cuts against "the
provider must not become the data store." The brief separately cautions against
choosing Supabase simply because it was used before.

---

## 11. Identity boundary design (target, not implemented)

`functions/_lib/identity.ts` becomes the only file that knows Auth0:

```
request → read bearer/cookie session token
        → verifySession(token):
            - verify RS256 signature against Auth0 JWKS (cached), locally with
              WebCrypto `crypto.subtle` (no JWT library)
            - check iss (issuer), aud (API audience), azp, exp/nbf — deliberately
              NO `nonce`: this verifies an OAuth2 bearer *access token* at the API
              boundary, not an OIDC browser ID-token authentication transaction,
              so a nonce would reject valid tokens and add no security
            - return the stable `sub`, or null
        → roleFor(sub, env)  // existing allow-list, unchanged
        → { configured: true, identity: { userId: sub, role } }
```

Expected `Identity` object (no invented claims):
- `provider`: implicit — Auth0 is the only configured issuer behind this seam.
- `subject / user ID`: the Auth0 `sub` (opaque, immutable). **Stored** in D1 as
  `contributions.contributor_user_id`.
- `email`: read from the token only if present and needed for display; **not
  used as an identity key**; ideally **not persisted** in D1.
- `email verification state`: from the `email_verified` claim if present — may
  gate contribution rights later, but not assumed.
- `authentication time`: from the `auth_time` / `iat` claim if present.
- `roles/claims`: **not trusted from the token**; role is decided solely by the
  server-side `BUTTLER_MODERATOR_IDS` allow-list.

Everything downstream (`http.ts`, `authorize.ts`, store, contract, apply) is
**already provider-agnostic and unchanged.**

---

## 12. Contributor identity mapping

- **Primary key:** `provider_subject → local contributor identity`, i.e. store
  Auth0 `sub` in `contributions.contributor_user_id` (a `TEXT` column with no
  length cap — fits as-is, **no migration needed**).
- **Email is never the key.** If a contributor changes their account email, the
  Auth0 `sub` stays stable, so all prior contributions, moderation records, and
  provenance remain correctly attributed. Mapping by email would break this.
- **No PII duplication.** Buttler stores only the opaque `sub` (plus whatever a
  contributor explicitly types into a contribution payload). No provider profile,
  no email, no IP in the contribution row — consistent with the existing
  privacy policy in `docs/stage13-moderation-operations.md`.
- **Cross-provider caution:** a `google-oauth2|…` vs `auth0|…` `sub` differs per
  connection; account linking (which merges identities) is Auth0 Essentials+.
  Buttler mitigates by treating `sub` as opaque and accepting that a contributor
  who changes login *method* may appear as a new identity until a policy decision
  is made — an acceptable, documented limitation at Stage 13 scale.

---

## 13. Moderator identity / authorization design

- **Authentication** for moderators uses the **same Auth0 project** (they are
  just contributors who also appear in `BUTTLER_MODERATOR_IDS`).
- **Authorization stays local and server-controlled.** A subject is a moderator
  only if it is in the server-side allow-list env var; a moderator may never
  decide or apply their **own** submission (already enforced in `authorize.ts`).
  No provider RBAC is required.
- **Optional defense-in-depth for a private moderator surface:** a future
  `/moderation` UI can additionally sit behind **Cloudflare Access** (Zero Trust,
  free up to 50 seats) as a separate perimeter — independent of and not coupled
  to the contributor auth choice. This gate does **not** force Cloudflare Access
  into the contributor decision.

---

## 14. Required future configuration (owner actions; not done by this gate)

1. Create an Auth0 tenant + a **First-Party Application** (Auth Code + PKCE) and
   an **API** with a stable identifier/audience. (Owner account action.)
2. Configure allowed callback/logout origins for the Pages domain(s). Add Google
   (and optionally GitHub) as social connections.
3. Decide **custom domain vs default `*.auth0.com`**: a custom domain needs
   **credit-card verification** on free — an explicit owner cost decision.
4. Populate `BUTTLER_MODERATOR_IDS` with the owner's own opaque `sub`(s).
5. Only then implement `verifySession` in `identity.ts` (§11) — one file.

## 15. Required secrets / env-var names (names only — never values)

- `AUTH0_DOMAIN` — the Auth0 tenant domain, e.g. `<tenant>.<region>.auth0.com`
  (scheme optional). It drives BOTH the expected issuer and the JWKS URL. This is
  the **actual** env var read by the current implementation (it replaces the
  earlier placeholder name `AUTH0_ISSUER_BASE_URL`).
- `AUTH0_API_AUDIENCE` — the Auth0 API identifier used as the JWT `aud`. This is
  the **actual** env var read by the current implementation (it replaces the earlier
  placeholder name `AUTH0_AUDIENCE`).
- `AUTH0_CLIENT_ID` — the application client id (public value; not a secret for
  PKCE, but keep server-side copies authoritative)
- `BUTTLER_MODERATOR_IDS` — existing server-side allow-list (already defined)

No client secret is needed for a PKCE public browser flow. If a confidential
flow is ever chosen instead, its secret is a new encrypted Pages env var (owner
decision). **None of these are created by this gate.**

---

## 16. Expected implementation sequence (future, needs approval)

1. **This gate** (selection) — documentation only. ✅
2. Owner creates the Auth0 tenant/app/API and configures domains + Google.
3. Implement `verifySession` + token read in `identity.ts`; add a small browser
   sign-in (Auth0 JS or a hand-rolled Auth Code + PKCE redirect); store only
   `sub` client-side in a session the server can verify.
4. Wire the (already-tested) moderation API to a minimal moderator UI.
5. **Separate approvals, unchanged from Stage 13:** (a) enabling contributions =
   promote the staged D1 schema into `d1/migrations/` + update
   `scripts/d1-schema.test.mjs` + apply only after backup + tested rollback
   (never `--force`); (b) enabling canonical apply = wiring
   `applyApprovedToCanonical`. Neither is implied by choosing a provider.

---

## 17. Cost model (Buttler, this selection)

- **Now:** $0. Auth0 Free (25K MAU), no card, Cloudflare Pages/D1 Free.
- **Trigger to pay on Auth0:** exceeding 25,000 monthly *authenticating*
  contributors, or requiring custom-domain (card verification) / MFA / RBAC /
  breached-password (paid tiers). First realistic paid step is Essentials
  $35/mo.
- **Trigger to pay on Cloudflare:** exceeding 100K Function requests/day or D1
  daily row limits — but D1 Free **fails (no charge)** past daily limits since
  2026-09-01, and Pages/Workers Paid is a separate owner decision.
- Both providers of the runner-up class (Clerk) would bill sooner-per-user only
  after a 50K retained threshold; Supabase is comparable on auth MAU but carries
  the pause risk. Auth0's ceiling is the lowest number but comfortably beyond any
  plausible near-term Buttler scale.

---

## 18. Free-tier risks (documented, mitigated)

- **Auth0:** custom domain needs a card (mitigation: start on default domain; the
  card is verification, not automatic billing). MFA/RBAC/bot-detection are paid
  (mitigation: Buttler enforces its own rate/pending/duplicate limits already
  built into the store). 1-day log retention. 25K MAU ceiling.
- **Clerk:** paywalled MFA/passkeys/bans; permanent free branding.
- **Supabase:** idle-pause + 2-project cap (decisive rejection reason).
- **Cloudflare:** D1 Free queries now hard-fail past daily limits (safe, no bill).
- **General:** all free terms are as of 2026-09-23 and **must be re-verified
  before connecting**, per the project's zero-dollar rule.

---

## 19. Migration / exit strategy

Because identity is a provider-standards `sub` held **at the boundary**, and all
application truth lives in D1:

- **To exit Auth0 later:** point the seam at a new OIDC provider's JWKS +
  audience. Existing `contributions.contributor_user_id` values keep their
  meaning as historical provenance; a one-time **subject re-mapping** (old `sub`
  → new `sub`) may be needed only if the same people must act under a new
  provider. Contribution history, moderation trail, and canonical provenance are
  **not** rewritten.
- **Export path:** Auth0 supports user export; Buttler's own D1 is already the
  authoritative store, so losing the provider loses only the login mechanism, not
  the data.
- **No redesign dependency:** the app is not built on Auth0 SDK widgets, so
  removal does not force a UI rewrite — the reason the headless seam was chosen.

---

## 20. Explicit non-implementation statement

This gate **enabled no authentication and changed no data.** Concretely:

- No Auth0 (or any provider) account, application, OAuth client, or credential
  was created.
- No secret or production environment variable was added or changed.
- No Cloudflare dashboard/DNS/domain setting was altered.
- No migration was applied; the staged `d1/contributions/0005` schema was **not**
  promoted to `d1/migrations/`.
- No endpoint was deployed or enabled; `resolveIdentity` still returns
  `{ configured: false }` and protected routes still answer **503**.
- `canonical_locations`, `location_provenance`, and `restroom_locations` were not
  touched.

Validation after writing this document (throwaway in-memory D1 only; never the
bound database):
- `pnpm test:stage13` → `STAGE13_CONTRIBUTIONS_TEST_SUCCESS`; canonical **776** /
  provenance **845** / legacy **1,112** intact.
- `pnpm test:d1` (schema guard) → `D1_SCHEMA_TEST_SUCCESS`; the three-table
  "contributions disabled" invariant still holds.

**STOP. No implementation was performed. The next action is the owner's (§14,
step 1: create the Auth0 tenant) and requires explicit approval.**
