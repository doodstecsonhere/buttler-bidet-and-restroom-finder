# Buttler 2.0 — Stage 13: Moderation & operations

Status: **foundation built, live enablement blocked on one owner decision
(authentication).** This stage takes the Stage 12 design to a safe, minimal,
auditable contribution + moderation foundation. It changes **no** production
data, applies **no** migration, deploys **nothing**, and ships **no** live
public write — because the one dependency it genuinely cannot self-supply,
secure authentication, is an owner choice.

The one rule everything else follows, carried forward unchanged from Stage 12:

> **A user submission is never canonical data.** Nothing a contributor does can
> reach `canonical_locations`, `location_provenance`, or the legacy
> `restroom_locations` table. The only path that can is a separate,
> moderator-authorized, allow-listed apply step that ships inert.

---

## The blocker in one paragraph (for the owner)

To let real people submit restroom reports that the app can trust and moderate,
the app must know **who** is submitting. The production site (Cloudflare Pages +
D1) currently has **no login at all** — the only sign-in system in the repo is
the old Replit backend, which the live site never talks to. Every way to add a
real login needs the owner to either configure something in a dashboard or
create a set of credentials. Per the project rules, an AI agent must not invent
credentials or wire up a fake login just to look finished. So this stage builds
**everything except the login plug-in**, proves it works with throwaway test
data, and stops at the exact line where the owner must choose a login method.

**Verdict: PARTIAL.** The safe foundation is complete and tested. Turning it on
in production is **BLOCKED** pending the owner's authentication decision below.

---

## What is already safe today (verified, not assumed)

* The public read API (`functions/api/restrooms.ts`) is unchanged and still
  GET-only; a write to it returns `405`.
* Every new protected endpoint **fails closed**: with no authentication provider
  wired, `resolveIdentity()` returns "not configured" and the handler answers
  **`503`** before it ever touches the database. An anonymous or spoofed write is
  therefore structurally impossible right now — the same guarantee the Stage 13
  brief asks for ("unauthenticated contribution rejection").
* The contribution schema is **staged**, not applied: it lives in
  `d1/contributions/` and is **deliberately kept out of `d1/migrations/`** so the
  committed guard test (`scripts/d1-schema.test.mjs`), which asserts exactly
  three tables, still passes and the "contributions are disabled" production
  invariant holds until the owner approves.

---

## What was implemented (auth-agnostic foundation)

All of this is provider-independent: it does not change when you pick a login
method. Only one function — `resolveIdentity` in `functions/_lib/identity.ts` —
is the seam that the chosen provider plugs into.

| Area | File(s) | What it guarantees |
| --- | --- | --- |
| Submission contract | `lib/contributions/contract.ts` | Per-kind **allow-list** of proposal fields; rejects unknown keys and every server-controlled key (`record_status`, `bidet_verification`, ids, timestamps…); value-domain checks; notes/payload size caps. |
| Canonical apply boundary | `lib/contributions/apply.ts` | Turns an *approved* contribution into a **fixed, allow-listed** column plan + parameterised statement. Only 7 columns are ever writable; protected columns are unreachable. Never arbitrary SQL. |
| Authorization rules | `lib/contributions/authorize.ts` | Single source for "may this actor do this": owner/moderator read scoping, decision needs moderator, **no self-approval**, apply needs an already-approved row + moderator. |
| Auth seam | `functions/_lib/identity.ts` | The documented swap point; today returns "not configured" so protected routes reject. Role = server-side allow-list, no secrets invented. |
| Data access | `functions/_lib/contributions-store.ts` | Parameterised D1 reads/writes for `contributions`/`contribution_events` only. Pending caps, duplicate detection, forced `pending` status, server-set identity/timestamps, append-only events. |
| HTTP surface | `functions/api/contributions.ts`, `.../contributions/[id].ts`, `.../me/contributions.ts`, `.../moderation/contributions.ts`, `.../moderation/contributions/[id]/[decision].ts` | The Stage 12 API contract, fail-closed until auth lands. |
| Staged schema + rollback | `d1/contributions/0005_create_contributions.sql`, `d1/contributions/rollback/0005_drop_contributions.sql` | Additive two-table schema (validated) with a clean reverse script. |
| Behaviour test | `scripts/stage13-contributions.test.mjs` (`pnpm test:stage13`) | Proves the 24 required conditions against in-memory D1 + the real 776/845/1,112 dataset. |

### Contribution kinds supported (from Stage 12)

`problem_report`, `closure_report`, `info_correction`, `access_update`,
`fee_update`, `bidet_report`, `reverification`, `new_location`.

* Existing places: reference a real canonical id (FK), propose changes **stored
  separately**, never overwritten at submit time.
* New places: **no** canonical placeholder row; proposal only; moderation
  decides.

### Workflow states

`pending → validated | needs_review → approved | rejected`, plus optional
`withdrawn` / `superseded`. Only a moderator moves a submission to
approved/rejected, and `approved` is a **decision**, not a write — the canonical
apply is a further, separate, still-inert step.

### Evidence & privacy

* Evidence stays a structured `evidence_json` array (`field_observation`,
  `user_note`, `external_source`, `photo_reference`). A contributor claim is
  **never** auto-recorded as `field_verified` — promotion is a human act, and the
  apply boundary physically cannot write `bidet_verification`.
* Contributor identity is an opaque provider subject id, **not public** by
  default, never exposed except to the owner's own view and the moderator queue.
  No emails, IPs, device fingerprints, or location tracking are stored.

---

## Authentication: the decision the owner must make

This is the only missing external dependency. None of the options below is a
"just use it" — each needs an owner action, and per the project's zero-dollar
rule the **current** free-tier terms must be re-verified before connecting (the
table lists what to check, not a guarantee they are still free today).

| Option | How contributors/moderators would sign in | Owner setup needed | Zero-dollar notes (verify before enabling) | Fit |
| --- | --- | --- | --- | --- |
| **A. Cloudflare Access (recommended first look)** | Email OTP or existing IdP via Cloudflare Zero Trust, in front of `/api/contributions*` | Create an Access application + policy in the Cloudflare dashboard already used by this project; set `BUTTLER_MODERATOR_IDS` | Free plan is limited-seat (historically ~50 users), no card required; hard-stop rather than bill. Must confirm current limits + that Pages custom-hosting + OTP are allowed on the free tier. | Smallest: same platform, no new vendor, no OAuth secrets in repo. |
| **B. External IdP OAuth (Auth0 / Clerk / etc.)** | Provider-hosted login, then a session cookie `resolveIdentity` verifies | Create provider app; store OAuth client id/secret as **encrypted Pages env vars**; configure redirect + allowed domains | Free tiers exist with MAU caps and sometimes card-on-file; watch commercial-use terms and "appending to a free tier" policy. | More moving parts + a paid-vendor risk; needs secrets the owner must create. |
| **C. Self-managed passkeys (WebAuthn) in Pages Functions + D1** | User registers a passkey; server verifies the challenge cryptographically | Owner enables HTTPS origin config; a small `users`/`passkey` table added | No vendor, no secrets, no card. But this is the most code and the least "minimal"; likely beyond Stage 13's scope. | Only if A and B are both rejected. |

The implementation deliberately does **not** pick for you or create any
credential. After you choose, finishing is small and local:

1. Implement `resolveIdentity` (+ a `verifySession`) in
   `functions/_lib/identity.ts` for the chosen provider.
2. Add the provider's env-var **names** (never values) to Pages.
3. Set `BUTTLER_MODERATOR_IDS` to your own opaque user id(s).
4. Optionally build a minimal moderator UI on top of the moderation API (the API
   is ready; the brief says a simple UI beats a big admin panel).

No other file changes.

---

## Remaining owner actions (each needs explicit approval)

1. **Choose + configure an authentication provider** (A/B/C above). This is the
   real gate.
2. **Decide whether to enable contributions** — promote `d1/contributions/0005`
   into `d1/migrations/`, update `scripts/d1-schema.test.mjs` to the new table
   set, and apply to production **only after** a verified backup and a
   tested rollback on a disposable database. Never `--force`.
3. **Decide whether to enable canonical promotion (apply)** — the
   `applyApprovedToCanonical` path is intentionally not wired to any endpoint.
   Turning moderation into live canonical edits is its own approval.
4. **Merge this PR** (owner approval required). Pages auto-deploy is disabled,
   so merging does not deploy; any deploy is separate approval.

---

## Testing

* `pnpm test:stage13` (run: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/stage13-contributions.test.mjs`)
  — covers all 24 brief conditions; asserts the real **776 canonical / 845
  provenance / 1,112 legacy** rows stay intact and that only the allow-listed
  apply path ever edits a canonical column.
* Regression suite still green: `d1-schema` (three-table guard), `d1-preview`,
  `canonical-import`, `no-redeploy`, `map-offline`, `pwa-build`.
* Root `tsc --build` shows only the two pre-existing, out-of-scope errors
  (`lib/api-zod`, `lib/replit-auth-web`); this stage adds none. The new modules
  run under the Node type-strip test harness exactly like the existing
  `functions/` and `lib/restroom-*.ts` files.
* **Not tested (cannot be, honestly):** the real provider handshake and any
  browser journey for submit/moderate — they need a live auth choice first. The
  UI was intentionally not built for the same reason.

---

## Production safety & rollback

* **No** production data, migration, secret, or deploy was touched. No fake
  users or contributions were seeded.
* **Git rollback:** revert this branch's commit(s) with a reversal commit — no
  history rewrite, no force push.
* **Schema rollback:** nothing to roll back (schema never applied). If ever
  applied, `d1/contributions/rollback/0005_drop_contributions.sql` restores the
  prior structure; it drops only the two new tables, never canonical/legacy data.
* **Not reversible casually:** none of this stage's changes are irreversible;
  the irreversible actions (production migration, enabling live writes,
  connecting a provider) are precisely the ones left to the owner.
