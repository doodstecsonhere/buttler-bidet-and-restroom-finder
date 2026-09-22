# Buttler 2.0 — Stage 12: Contribution architecture

Status: **design only**. This document defines how future community
contributions will work. It changes **no** production data, applies **no**
migration, and ships **no** live submission endpoint. See
[Why design-only](#why-design-only) for the reason.

The one rule everything else follows:

> **A user submission is never canonical data.** A contribution lands in its
> own tables and its own workflow. The only way it can ever reach
> `canonical_locations` is a separate, moderator-authorized action that this
> document deliberately does **not** build.

---

## PART 1 — What already exists (inventory)

Verified by reading the repository and the production wiring, not assumed.

| Concern | Reality today |
| --- | --- |
| Public API | Cloudflare Pages Function `functions/api/restrooms.ts`. **GET-only** (`405` for anything else), projects the canonical read model, `Cache-Control: public, max-age=300`. The **only** file under `functions/` — there is no `_middleware` and no other route. |
| Database | Cloudflare **D1** (`BUTTLER_DB`), configured in `d1/wrangler.migrations.jsonc` (db `buttler-read-model`). Ordered SQL migrations in `d1/migrations/`. |
| Canonical data | `canonical_locations` (776 rows, string ids `buttler_loc_<20 hex>`) + `location_provenance` (845 rows), created by migration `0003`, seeded by `0004_*`. `record_status` domain already includes a future `community-submitted` value but nothing writes it. |
| Legacy table | `restroom_locations` (1,112 rows) from `0001`/`0002`, kept only for rollback/fallback. |
| Users / sessions / roles | **None in the Cloudflare/D1 stack.** Migration `0003` header states it contains "no users, sessions, authentication, or public-write data". |
| Auth (legacy) | `artifacts/api-server` is the **old Replit Express backend**: Replit OIDC (`https://replit.com/oidc`, client id = `REPL_ID`), `sessions`/`users` in **Replit Postgres** (`lib/db/src/schema/auth.ts`), plus a Guardian `POST /api/audits` route (`lib/db/src/schema/audits.ts`). It is **not** connected to Pages or D1. |
| Frontend auth | `lib/replit-auth-web` `useAuth()` calls `/api/login`, `/api/auth/user`, `/api/logout`. Those routes only exist on the Replit backend, so on `buttler.pages.dev` they resolve to nothing — the app is effectively **read-only**. |
| Rate limiting / abuse / logging | None on the production path. |
| Contribution code | None live. `d1/README.md` and `docs/read-only-launch.md` both state Guardian/contributions are **intentionally disabled until Stage 12 designs auth, authorization, abuse prevention, and moderation**. Stage 11 removed the dead `AuditModal`/`BidetCard`; the old `restroom_audits` shape is **not** resurrected as-is. |

### What the legacy Guardian/audit model teaches us
The old `restroom_audits` table wrote a row per submission and the old route
inserted directly, trusting `req.user.id` from Replit. It mixed raw booleans
(`hasSoap`, `hasTissue`) into the same table as any verification claim and had
no moderation state. That is exactly the "submission == truth" coupling Stage 12
must avoid. We keep the *idea* of a traceable per-user observation and drop the
*direct-write-to-truth* behavior.

---

## Why design-only

The Stage 12 decision rule: if authentication is missing or ambiguous, design
the architecture and the schema/API contract but **do not invent insecure
authentication**.

On the production Cloudflare/D1 path, authentication is **absent** — the only
identity system is the legacy Replit OIDC/Postgres stack that Pages never calls.
Wiring a public write endpoint now would mean either (a) accepting anonymous
writes (spam/abuse with no accountability, no moderation identity) or (b)
stand-up of a new identity provider — both are out of scope and (a) is unsafe.

So Stage 12 delivers the **contract**; Stage 13 (with an approved authentication
choice) makes it **live**. The proposed schema below was validated locally so the
handoff is concrete, but it is intentionally **not** placed in `d1/migrations/`
(see [Migration safety](#part-13--migration-safety)).

---

## PART 2 — Contribution model (the durable record)

One row = one submission. It captures, at minimum:

- stable **string** id (`contribution_id`) — server-generated, never auto-increment (PART 4).
- **kind** — what the contributor is claiming (enumerated in PART 7).
- **target** — the canonical row it refers to, or `NULL` for a brand-new place.
- **contributor reference** — server-assigned; `NULL` until an auth-backed
  submission path exists.
- **payload** — the structured, allow-listed proposed change (JSON).
- **notes** — the contributor's words (size-capped).
- **evidence** — structured observations/sources (JSON array).
- **status** + **validation_status** — workflow + machine-validation state.
- **timestamps** — server-set `submitted_at`, and `decided_at` when a terminal
  state is reached.
- **moderation fields** — `moderation_note`, `decided_by` (written only by the
  Stage 13 moderation path; always `NULL` on insert).

Traceability of *state changes* lives in a second, append-only table
(`contribution_events`) rather than mutating columns, so the history of who did
what survives moderation (PART 12).

Eight contribution types are supported without speculative extra columns:

1. `problem_report` — something is wrong with an existing place.
2. `closure_report` — a restroom no longer exists.
3. `info_correction` — corrected name / address / coordinates.
4. `access_update` — new access classification.
5. `fee_update` — new fee information.
6. `bidet_report` — report or suggest bidet presence.
7. `reverification` — a fresh on-the-ground check of an existing place.
8. `new_location` — propose a place not yet in the catalogue.

Not every submission maps to a field change. `problem_report`, `closure_report`,
and `reverification` are **signals for a human**, not column updates.

---

## PART 3 — Existing location vs. new location

The two cases are separated by a database `CHECK`, not app convention:

- **Existing (`target_canonical_id` set):** the contribution references a real
  canonical id via a foreign key. That FK is a **read-only association** — it
  points at the row, it does not permit changing it. The canonical row stays
  byte-for-byte identical until Stage 13 moderation applies an approved change.
- **New (`kind = 'new_location'`, `target_canonical_id IS NULL`):** the
  contribution stores the proposed place **inside its own payload**. No
  placeholder row is created in `canonical_locations`. A moderator later decides
  whether it becomes canonical.

Enforced rule: `new_location` **must** have a `NULL` target and every other kind
**must** have a non-null target that exists. This was proven against real data
(see [Validation](#validation-results)).

---

## PART 4 — D1 data model (proposed, minimal)

Two tables. Both `STRICT` to match `canonical_locations`. This is the smallest
schema that gives durable traceability, workflow state, auditability, canonical
separation, and future moderation support.

### `contributions`

| Column | Type | Notes |
| --- | --- | --- |
| `contribution_id` | TEXT PK | Stable string id (`contrib_…`), server-generated. Length-checked; **not** auto-increment. |
| `kind` | TEXT | One of the 8 kinds (CHECK-enumerated). |
| `target_canonical_id` | TEXT FK → `canonical_locations(canonical_id)` | Nullable. Read-only reference; does **not** allow mutation. |
| `contributor_user_id` | TEXT | Server-assigned opaque id. Nullable **now** (no auth); becomes effectively NOT-NULL once an auth path exists. |
| `status` | TEXT | Workflow state (PART 5), default `pending`. |
| `validation_status` | TEXT | `not_validated` / `passed` / `failed`. Machine step only. |
| `payload_json` | TEXT | Allow-listed structured change (PART 7). `json_valid` CHECK. |
| `evidence_json` | TEXT | Optional evidence array. `json_valid` CHECK. |
| `notes` | TEXT | Contributor free text, ≤ 2000 chars. |
| `validation_result_json` | TEXT | Optional validation detail. |
| `moderation_note` | TEXT | Internal reviewer note ≤ 2000 chars. Never public. |
| `submitted_at` | TEXT | Server default timestamp. |
| `decided_at` | TEXT | Set only with a terminal state (CHECK-enforced). |
| `decided_by` | TEXT | Moderator id — written only by Stage 13. |
| `updated_at` | TEXT | Server default; moderation bumps it. |

Table constraints:

- `CHECK ((kind='new_location' AND target_canonical_id IS NULL) OR (kind<>'new_location' AND target_canonical_id IS NOT NULL))`
- `CHECK ((status IN ('approved','rejected','superseded','withdrawn') AND decided_at IS NOT NULL) OR (status NOT IN (...) AND decided_at IS NULL))`

Indexes:

- `idx_contributions_status (status, submitted_at)` — moderation queue.
- `idx_contributions_target (target_canonical_id)` — "what is claimed about place X".
- `idx_contributions_contributor (contributor_user_id)` — abuse / per-user history.
- `idx_contributions_open_by_target (target_canonical_id, kind) WHERE status IN ('pending','validated','needs_review')` — duplicate detection + "already open for this place".

### `contribution_events` (append-only audit trail)

| Column | Type | Notes |
| --- | --- | --- |
| `event_id` | TEXT PK | Stable string id. |
| `contribution_id` | TEXT FK → `contributions` | Cascade history owner. |
| `event_type` | TEXT | `submitted`/`validated`/`flagged`/`status_change`/`comment`/`moderation_decision`/`withdrawn`/`superseded`. |
| `actor_type` | TEXT | `system`/`contributor`/`moderator`. |
| `actor_id` | TEXT | Server-assigned; who, if known. |
| `from_status` / `to_status` | TEXT | Records each transition. |
| `detail_json` | TEXT | Optional context. `json_valid` CHECK. |
| `created_at` | TEXT | Server default timestamp. |

Index: `idx_contribution_events_contribution (contribution_id, created_at)`.

### Deliberately **not** created yet
A third `contribution_evidence` table (evidence stays as a JSON array — no query
needs it as rows yet), any `users`/`sessions`/`roles` tables (belongs with the
approved auth choice, PART 9), and any moderation-decision table beyond the
columns above. Adding them now would be speculative breadth the task warns
against.

**Foreign-key safety:** the only FK into canonical data is `target_canonical_id`.
It exists so a moderator can jump from a claim to the real row. No contribution
statement writes `canonical_locations`; the validation run asserts the canonical
table is bit-identical before and after all contribution activity.

---

## PART 5 — Workflow states

Small state machine; states chosen, not copied:

```
                       ┌─────────────────┐
   submit ───────────► │     pending     │
                       └───────┬─────────┘
                auto-validate  │
                  ┌────────────┴────────────┐
                  ▼                          ▼
             validated                  needs_review
                  │                          │
        human moderation gate      human moderation gate
        ┌─────────┴─────────┐      ┌─────────┴─────────┐
        ▼                   ▼      ▼                   ▼
    approved            rejected  approved          rejected

   pending/validated/needs_review ──(contributor)──► withdrawn
   approved/... ──(newer accepted claim covers same target)──► superseded
```

- **Who creates each state:**
  - `pending` — the submission API (server), after basic validation.
  - `validated` / `needs_review` — the automated validation step only.
  - `approved` / `rejected` — **a moderator only** (Stage 13, authenticated +
    authorized). No automated or user path reaches these.
  - `withdrawn` — the contributor (own submission) or `system`.
  - `superseded` — set by moderation when a newer accepted claim covers the same
    target/field.
- **Allowed transitions:** forward through validate → moderate; `withdrawn` from
  any pre-terminal state; `superseded` from a decided/open state when replaced.
- **Transitions requiring a human:** every move to `approved` or `rejected`.
- **Invalid submissions:** do **not** delete. Mark `validation_status='failed'`
  and route to `needs_review` (kept for abuse history and repeat-offender
  detection).
- **Rejected:** stays stored with `moderation_note` + `decided_at`; never applied.
- **Multiple contributions on one record:** all allowed and independent; the
  partial index surfaces them together so moderation reconciles them; losing
  duplicates become `superseded`.
- **Obsolete:** becomes `superseded` rather than deleted.

> **Hard rule:** *no user-triggered action transitions a contribution into a
> canonical mutation.* `approved` is a **decision state**, not a write. The
> actual `canonical_locations` update is a distinct, privileged Stage 13 step.

---

## PART 6 — Security boundary

Four zones, each with its own trust level:

```
PUBLIC API  ── reads canonical only (today: GET /api/restrooms)
CONTRIBUTION API ── writes ONLY contributions / contribution_events
MODERATION API ── reads all contributions; the ONLY path that may write canonical
CANONICAL DATA ── written only by owner import + approved moderation apply
```

A contribution request must be structurally unable to:

- update / delete `canonical_locations` or its provenance — it has no code path
  to those tables and the FK is read-only;
- change another contributor's submission — ownership is checked server-side
  against `contributor_user_id`;
- impersonate anyone — identity comes from the verified session, never the body;
- change moderation state — `status`/`decided_at`/`decided_by` are not
  client-writable columns; only the moderation handler sets them;
- inject SQL / arbitrary fields — parameterized statements + a strict allow-list
  (PART 7);
- bypass validation — validation runs server-side before any row is written.

**Never trusted inputs** (always overwritten server-side): hidden UI controls,
client-supplied `role`, `status`, `contributor_user_id`, `decided_by`, canonical
approval flags, and any timestamp. **Server-side authorization is mandatory**;
hiding a button is not a control.

Enforcement point: the Pages Function that will host these endpoints (Stage 13).
D1 gives the whole Worker the same binding, so authorization is enforced in
**handler code** (which table a request may touch, whose rows it may read), not
by a DB grant. The schema supports this by keeping canonical writes out of every
contribution statement.

---

## PART 7 — Contribution payload design

No arbitrary database patches. A submission carries a fixed-shape, allow-listed
object keyed by `kind`. Server-controlled concepts are **impossible** to submit.

| Contributor may propose (allow-list) | Maps to canonical |
| --- | --- |
| `access` | `canonical_locations.access` (same enum: public / customers / public-customers / permissive / students-public / restricted / unknown) |
| `fee` | `canonical_locations.fee` (yes / no / unknown) |
| `bidet_presence` | `canonical_locations.bidet_presence` (Yes / Unknown) — **presence only** |
| `name`, `address`, `latitude`, `longitude` | identity/geo correction (range-validated) |
| `closed` / `observed` / `issue` | signal flags for the human reviewer |

**Server-controlled, never user-writable:** `canonical_id`, `record_status`,
`bidet_verification`, `restroom_verification`, `match_*`, `source_count`,
provenance rows, every timestamp, `status`, `contributor_user_id`, `decided_by`.

The API parses `payload_json` against a per-kind Zod allow-list and rejects any
unknown or reserved key **before** writing. The validation script demonstrates
this rule: submitting `bidet_verification` or `record_status` or an out-of-kind
`latitude` is refused.

---

## PART 8 — Evidence and provenance

Evidence is stored as structured entries in `evidence_json`, e.g.:

```
{ "type": "field_observation" | "user_note" | "external_source"
  | "photo_reference",   // reserved; not required, not fake-verifiable
  "detail": "I personally checked this restroom today",
  "observed_at": "2026-09-20",
  "source_url": "https://…" }   // for external_source
```

Rules:

- A photo is **never required** (would block useful reports); `photo_reference`
  is a future pointer only.
- A contributor saying "I checked today" is recorded as a `field_observation`
  **claim**. It does **not** set canonical `bidet_verification = 'field_verified'`.
- The existing authoritative semantics —
  `field_verified` / `osm_explicit` / `unknown` (and the
  `restroom_verification` domain) — stay owned by the owner import and the
  Stage 13 moderation decision. Promotion from "someone claims they checked" to
  "we verified in the field" is a **human** act.

---

## PART 9 — Anti-spam / abuse (minimum)

Ordered by what the architecture must decide:

1. **Authentication required.** Public anonymous writes are **not** allowed once
   live: without identity there is no accountability, no rate-limit subject, and
   no "change another contributor's submission" check. This is the missing
   dependency.
2. **Pending cap** per contributor (e.g. N open contributions) via
   `idx_contributions_contributor`.
3. **Rate limiting** per authenticated identity / IP at the edge.
4. **Duplicate detection** via the partial open-by-target index (same target +
   kind already open → soft-dedupe).
5. **Payload size limits** (row + `notes` length; enforced in schema + handler).
6. **Server-side validation** before any write.
7. **Suspension hook:** contributor state is a Stage 13 concern; the data model
   keeps per-contributor history so abuse is reviewable. Rejected/failed
   submissions are retained, not deleted.

**On authentication specifically:** the repo has Replit OIDC + Replit Postgres
sessions, but not on the Cloudflare path. Stage 12 must **not** stand up a new
identity provider or a fake session. Stage 13 needs an approved auth choice
first. Per the zero-budget rule, any provider must be evaluated as free-tier
before connecting — none is recommended or activated here.

---

## PART 10 — Contribution API contract (for Stage 13 to implement)

Shapes only; **nothing implemented** (no safe auth yet).

- `POST /api/contributions` — auth required. Validates body against the per-kind
  allow-list, generates `contribution_id`, stamps `submitted_at`/`updated_at`,
  sets `contributor_user_id` from the session, forces `status='pending'`,
  `validation_status='not_validated'`, and null moderation fields. Returns the
  created id + status. Writes a `submitted` event. Rate-limited.
- `GET /api/contributions/{id}` — visible to its owner or a moderator; 404 (not
  403) to everyone else so ids don't leak existence.
- `GET /api/me/contributions` — the caller's own submissions + statuses.
- `GET /api/moderation/contributions?status=…` — **moderator only**, the queue.
- `POST /api/moderation/contributions/{id}/{decision}` — **moderator only**;
  `approve` / `reject` (+ note). Approval here is the *decision*; applying it to
  canonical is a further privileged step, out of Stage 12 scope.

Every implemented endpoint must: validate server-side, enforce size limits,
generate ids/timestamps/contributor server-side, prevent canonical writes, return
safe errors, and never expose privileged fields. Because current auth is
insufficient, the contract is specified but **no insecure endpoint is created**.

Contributions are **not publicly readable** by default — publishing unverified
claims would amplify exactly the noise the moderation exists to filter.

---

## PART 11 — Privacy (data minimization)

Store only what accountability, authentication, moderation, and audit require:

- **Accountability:** `contributor_user_id` (opaque provider subject id).
- **Content:** the payload, notes, evidence the contributor chose to submit.
- **Moderation:** `moderation_note`, `decided_by`, `decided_at` (internal).

Do **not** store in these tables: emails, display names, IP addresses, precise
device location, or any sensitive personal data. Contributor identity is **not
public** by default and is not exposed on any read other than the owner's own
view and the moderator queue. Provider tokens/claims stay in the auth layer,
never copied into contributions.

---

## PART 12 — Handoff to Stage 13 (what it will need)

Stage 13 (Moderation & operations) can rely on this document for:

- the two tables and their constraints (validated — see below);
- the state machine and the "approval ≠ canonical write" rule;
- the per-kind payload allow-list + reserved-key list;
- the API contracts above;
- evidence semantics and the "claim ≠ `field_verified`" boundary;
- the auth dependency: Stage 13 must first land an **approved** authentication
  choice, then the abuse controls (rate limit, pending cap), then the moderation
  queue/decisions, then — separately approved — the canonical-apply step.

Stage 12 builds **no** moderator UI and approves **nothing**.

---

## PART 13 — Migration safety

- The proposed schema is an **additive** `0005_create_contributions.sql` design,
  written to create only new tables/indexes. It does **not** modify `0001`–`0004`,
  the canonical seed, `canonical_locations`, or legacy `restroom_locations`.
- It is **intentionally not placed in `d1/migrations/`** and **not applied to
  production**, for two reasons:
  1. the committed `scripts/d1-schema.test.mjs` asserts exactly three tables
     (`canonical_locations`, `location_provenance`, `restroom_locations`) as a
     deliberate "contributions disabled" invariant, and
  2. `d1/README.md` says contributions stay disabled until auth/authz/abuse/
     moderation are **separately approved**. Adding the table early would
     pre-empt that approval and break the guard test.
- Validated against a **fresh in-memory SQLite** (D1 engine) seeded with the real
  canonical data, never production.

### Validation results
`.tmp-stage12/validate-schema.mjs` (scratch, not committed) ran against the real
776-location dataset and printed `STAGE12_SCHEMA_VALIDATION_SUCCESS`:

- canonical rows before/after contribution activity: **776 / 776**; provenance
  untouched (845) — **proves no canonical mutation**;
- valid existing-location and new-location inserts accepted;
- `new_location` with a target → rejected; existing-kind without a target →
  rejected; unknown `target_canonical_id` → FK rejected;
- bad `kind` / bad `status` rejected; `approved` without `decided_at` rejected;
- malformed `payload_json` rejected; wrong type into `STRICT` column rejected;
- event FK enforced;
- allow-list check rejects reserved/server-controlled keys (`bidet_verification`,
  `record_status`) and out-of-kind fields.

(The only real bug found during validation — this SQLite build disallows a
table-level `CHECK` before a column definition — was fixed by moving both
table `CHECK`s to the end of the column list. Recorded here so Stage 13 does not
re-trip it.)

---

## Production safety & rollback

- **No** production data changed, migration applied, contribution created,
  canonical/legacy row touched, secret changed, or deploy performed.
- Only repository changes: this document (tracked) + scratch validation under
  `.tmp-stage12/` (untracked).
- **Rollback:** delete the branch or revert its single commit. Nothing else —
  because nothing live was touched.
