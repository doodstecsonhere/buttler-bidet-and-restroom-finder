# Buttler 2.0 — Stage 14A: Canonical promotion contract (design only)

Status: **design contract**. This document turns the completed Stage 14 design
audit into the explicit rules a later Stage 14 implementation must follow. It
changes **no** application code, applies **no** migration, touches **no**
production data, exposes **no** endpoint, and commits **nothing**.

The rule everything below preserves, carried unchanged from Stages 12–13:

> **An approved community observation is not canonical truth.**
> Stage 13 `approved` means "this passed moderation." Stage 14 `promoted` means
> "this specific approved observation passed the additional safeguards required
> to modify canonical data." These states are never collapsed.

---

## 1. Scope

**In scope (this document only):**

- The promotion lifecycle and which existing statuses it may reuse.
- The idempotency, concurrency, atomicity, audit, and provenance contracts.
- A per-kind promotion policy matrix for all eight contribution kinds.
- Explicit rules for bidet transitions, empty addresses, coordinate changes,
  `new_location`, and destructive/lifecycle changes.
- The authorization model, future API contract, failure matrix, test contract,
  rollback/reversal design, implementation phases, and deployment gates.

**Out of scope:** any code, schema, migration, endpoint, Auth0 change, deploy,
commit, or push. Also out of scope: reopening Stage 13, deleting the Phase 12B
test contributions, cleaning unrelated repository artifacts, and repairing the
two known legacy TypeScript errors (`lib/api-zod`, `lib/replit-auth-web`).

### Verified repository facts (read from code/config on the current branch)

| Fact | Where verified |
| --- | --- |
| Writable canonical columns are exactly `access`, `fee`, `bidet_presence`, `name`, `address`, `latitude`, `longitude` | `lib/contributions/apply.ts` (`WRITABLE_CANONICAL_COLUMNS`) |
| Apply-reachable kinds: `access_update`, `fee_update`, `bidet_report`, `info_correction`; the other four map to no column | `lib/contributions/apply.ts` (`APPLY_FIELD_COLUMNS`) |
| `applyApprovedToCanonical` exists, is deliberate, and is wired to **no HTTP endpoint** | `functions/_lib/contributions-store.ts` + `docs/stage13-moderation-operations.md` |
| Current apply performs UPDATE canonical, then INSERT event, as **two separate awaits** (not atomic) | `functions/_lib/contributions-store.ts` (`applyApprovedToCanonical`) |
| Contribution status domain: `pending`, `validated`, `needs_review`, `approved`, `rejected`, `withdrawn`, `superseded`; terminal states must carry `decided_at` | `d1/migrations/0005_create_contributions.sql` |
| Event type domain has no promotion-specific type: `submitted`, `validated`, `flagged`, `status_change`, `comment`, `moderation_decision`, `withdrawn`, `superseded` | `d1/migrations/0005_create_contributions.sql` |
| `canonical_locations` is `STRICT`; bidet/restroom presence domains are `('Yes','Unknown')`; the surveyed-row invariant is `bidet_source_id IS NULL OR (bidet_presence='Yes' AND restroom_presence='Yes')`; `updated_at` has no auto-update trigger (the apply statement stamps it explicitly) | `d1/migrations/0003_create_canonical_read_model.sql` |
| `location_provenance.source_type` is constrained to `OSM` / `field_survey_bidet_workbook` and records acquisition provenance with `original_*` values | `d1/migrations/0003_create_canonical_read_model.sql` |
| Address validation currently accepts an empty string (only "short string" is required) | `lib/contributions/contract.ts` (`validateFieldValue("address")`) |
| Identity comes only from a locally verified Auth0 RS256 access token; roles come only from the server-side `BUTTLER_MODERATOR_IDS` allow-list; no client-supplied identity/role is ever read | `functions/_lib/identity.ts` |
| `api.approve_apply_writes_snapshot` in the Stage 13 test suite only exercises the inert path — no live promotion exists | `scripts/stage13-contributions.test.mjs` |

### Audit-derived facts (accepted from the Stage 14 design audit; re-verify read-only in 14H)

- **98** canonical rows have `bidet_source_id` set, so their CHECK requires
  `bidet_presence='Yes' AND restroom_presence='Yes'`.
- Production row counts at time of writing: canonical 776, provenance 845,
  legacy 1,112, bidet-positive 114; contributions 2, contribution_events 3.

These are numbers, not rules. No contract clause below depends on the exact
count — the constraint handling in §8 is written for *any* row with
`bidet_source_id IS NOT NULL`.

---

## 2. Terminology

- **Approved observation** — a contribution in status `approved`: moderation
  judged the claim credible. Still zero effect on canonical data.
- **Promotion** — the separate, privileged, explicitly-requested action that
  turns one specific approved contribution into one canonical field change,
  recorded durably in a promotion ledger.
- **Canonical snapshot (base snapshot)** — the exact current values of the seven
  promotion-reachable columns plus `updated_at` of the target row, captured at
  promotion time inside the promotion transaction.
- **Drift / stale** — the target row's snapshot differs at promotion time from
  what was implicitly current when the contribution was approved.
- **Reversal** — a new, forward-appended ledger entry that restores the values
  a previous promotion replaced. Never an edit or delete of history.

---

## 3. Promotion lifecycle

### 3.1 Decision: do NOT add any contribution status

The seven existing statuses are **reused unchanged**. No `promoted` status is
added, because:

1. Promotion state is derivable and durable in the new ledger (§5): a
   contribution is `promoted` iff a ledger row references it. One fact, one
   place.
2. Adding a status would broaden the D1 `status` CHECK (schema churn) **and**
   collide with the existing invariant "terminal decision states carry
   `decided_at`" — promotion is not a decision, so `promoted` would either
   break that CHECK or force a second timestamp convention.
3. Keeping `contributions` rows byte-identical after approval preserves the
   Stage 13 immutability property: after `decideContribution`, no code ever
   writes the contribution row again.

The lifecycle therefore spans two records: the **contribution row** (unchanged
domain) and the **promotion ledger row** (§5, `status='promoted'`).

### 3.2 Full transition table

| # | Transition | Control | Mechanism / notes |
| --- | --- | --- | --- |
| 1 | (submit) → `pending` | contributor | Stage 13 `createContribution`; unchanged |
| 2 | `pending` → `validated` \| `needs_review` | system | automated validation step (Stage 12 design; not yet automated in production) |
| 3 | `validated` \| `needs_review` → `approved` \| `rejected` | moderator | Stage 13 `decideContribution`; no self-decision; unchanged |
| 4 | pre-terminal → `withdrawn` | contributor \| system | Stage 13; unchanged |
| 5 | pre-terminal \| `approved` → `superseded` | moderator | Stage 13 semantics extended: also the landing state for an approved claim that promotion reports as **stale by drift** (§7.4) or that a newer accepted claim covers |
| 6 | `approved` + eligible kind → *(ledger row created; contribution row untouched)* | owner/promoter | the Stage 14 promotion (§13, §15) |
| 7 | promoted → reversible | owner/promoter | reversal via a new ledger row (§18); statuses never move backwards |

**Failure/stale paths:**

- Promotion attempt on a non-`approved`, ineligible-kind, or `new_location`
  contribution → rejected (§16 matrix); contribution state unchanged.
- Promotion attempt with **drift** → `409` + machine-readable drift report; no
  ledger row; canonical unchanged; attempt audited (§7.4). Human then chooses:
  supersede the stale claim (transition 5) and accept a fresh contribution, or
  (only if no drift exists on the fields the contribution writes *and* the
  implementation later grants that narrower rule — it does **not** in v1) retry.
- Promotion attempt with a **redundant payload** (every proposed value already
  equals canonical) → `409 redundant_noop`; no ledger row; no write; audited.
- Transient infrastructure failure (D1 error) → `500`; nothing committed
  (rollback semantics of §6); safe to retry.

`approved` remains a **terminal decision state and never a write**; the ledger
existence is the only "promotion" fact.

---

## 4. Authorization

- Promotion authority is a **separate, narrower server-side allow-list**:
  `BUTTLER_PROMOTER_IDS` (comma-separated opaque Auth0 `sub` values), read like
  `BUTTLER_MODERATOR_IDS` — env-name-only, never client-visible, fail-closed
  when empty. A promoter must also satisfy every Stage 13 rule: authenticated
  identity from the verified access token, **never** the request body, never
  Auth0 token role claims, and **no self-promotion** (promoter `sub` ≠
  `contributor_user_id`), even when the promoter is also the moderator who
  approved the contribution.
- Default posture: v1 recommends the promoter set be the owner alone. This
  keeps the "additional safeguards" of promotion materially stronger than
  moderation without inventing a two-person workflow the project cannot staff
  today. If/when a second promoter id exists, the owner may tighten specific
  change classes (coordinate relocations, bidet upgrades) to a two-promoter
  rule; that is an owner decision, not a default (§10, §13).
- The existing `authorizeCanonicalApply` gate (moderator + approved + no self)
  is **not** reused as-is; Stage 14 replaces it with a promotion-specific
  predicate (`authorizeCanonicalPromotion`) that layers: allow-list, kind
  eligibility (§10), lifecycle preconditions (§16), and self-check.
- Hiding the promote button is irrelevant; every rule above is enforced
  server-side in the handler/store (§15).

---

## 5. Idempotency: selected architecture = a dedicated promotion ledger

### 5.1 Options considered

| Criterion | A: `applied_*` columns on `contributions` | B: dedicated `canonical_promotions` ledger | C: events-only (reuse `contribution_events.detail_json`) |
| --- | --- | --- | --- |
| D1 simplicity | Small; but needs 3 new columns + CHECK rewrites | One new table; contributions untouched | No new table |
| Atomicity | Update+insert still needed | Insert doubles as the state gate (§6) | Same as A, weaker |
| Auditability | Values crammed into one JSON blob on the claim row | Structured before/after columns per promotion | Querying audit by canonical row requires `json_extract` over free blobs |
| Replay prevention | Needs `UNIQUE(applied_by...)`? No — `applied_at IS NOT NULL` check on a mutable row | `UNIQUE(contribution_id)` on an append-only table = a **hard, permanent** gate | No structural gate |
| Future rollback | Previous values live on the claim, easy to lose in a later edit | Ledger is the durable restore source; reversals append (§18) | Audit-only, no structured restore |
| Multi-column changes | One blob per row is fine | Fine (`resulting_values_json`) | Fine but untyped |
| Contribution immutability | **Violated** — the claim row must be rewritten after its terminal state | **Preserved** — zero writes to `contributions` after approval | Preserved |
| "Which places changed and when" queries | Poor (scan all contributions) | Indexed by `canonical_id` | Poor |

**Selected: Option B — one new append-only table, `canonical_promotions`.**
Rationale: it is the only option that (a) keeps contribution rows immutable
after approval, (b) makes replay prevention a database constraint rather than
application discipline, (c) puts previous/resulting values in queryable,
indexed structure, and (d) doubles as the provenance link for promoted
community edits (§9) and the restore source for reversals (§18). Option A is
rejected primarily for immutability; Option C is rejected for auditability and
the missing structural replay gate.

### 5.2 Ledger schema (proposed for 14B, as migration `0006_create_canonical_promotions.sql`)

```sql
CREATE TABLE canonical_promotions (
  promotion_id          TEXT PRIMARY KEY CHECK (length(promotion_id) BETWEEN 8 AND 64),
  contribution_id       TEXT NOT NULL REFERENCES contributions(contribution_id),
  canonical_id          TEXT NOT NULL REFERENCES canonical_locations(canonical_id),
  kind                  TEXT NOT NULL CHECK (
    kind IN ('info_correction','access_update','fee_update','bidet_report')),
  contributor_user_id   TEXT NOT NULL,   -- denormalized for self-promotion checks
  promoter_user_id      TEXT NOT NULL,
  promoted_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  base_snapshot_json    TEXT NOT NULL CHECK (json_valid(base_snapshot_json)),
  changed_columns_json  TEXT NOT NULL CHECK (json_valid(changed_columns_json)),
  resulting_values_json TEXT NOT NULL CHECK (json_valid(resulting_values_json)),
  status                TEXT NOT NULL DEFAULT 'promoted' CHECK (status = 'promoted'),
  reversal_of           TEXT REFERENCES canonical_promotions(promotion_id),
  promotion_note        TEXT CHECK (promotion_note IS NULL OR length(promotion_note) <= 2000)
) STRICT;

CREATE UNIQUE INDEX idx_canonical_promotions_contribution
  ON canonical_promotions (contribution_id);   -- the replay gate
CREATE INDEX idx_canonical_promotions_canonical
  ON canonical_promotions (canonical_id, promoted_at);
```

Contract properties:

- **Append-only.** No UPDATE statement to this table may ever be written. A
  reversal is a new row (`reversal_of` set), never a status flip on the old row.
- `UNIQUE(contribution_id)` is the persistent idempotency mechanism: a replay
  of the same contribution can never insert a second row (§6).
- **Promotion ids are random opaque tokens**, not derived from any timestamp:
  `promo_` + 32 lowercase hex chars produced from `crypto.randomUUID()` (38
  characters, inside the 8–64 length CHECK), matching the repository's existing
  `contrib_`/`evt_` id convention. A deterministic id derived from the canonical
  `updated_at` stamp was rejected: millisecond-precision stamps can collide
  across concurrent promotions to different rows (a `PRIMARY KEY` clash on
  `promotion_id`), and once any later legitimate edit re-stamps `updated_at` the
  derived id can no longer be recomputed — so it is unsafe as both a key and a
  reconciliation handle.
- A separate **read-only** reconciliation command (§19, gate 4) detects a
  crashed-between-batches orphan NOT by looking up a timestamp-derived id, but
  by comparing each approved, promotable contribution's stored payload against
  the live canonical row: canonical values already match the payload yet no
  ledger row exists ⇒ a *suspected* orphan (indistinguishable from an owner
  import of the same value, which the report states as a limitation). The
  `idx_canonical_promotions_canonical` index supports enumerating a row's
  promotions. Reconciliation only detects, classifies, and reports — it never
  reconstructs or writes a ledger row (see §6, §16, §19).
- Migration is strictly additive: creates this table and indexes only; touches
  no existing table, column, or row. Rollback: `d1/rollback/0006_drop_canonical_promotions.sql`.

---

## 6. Atomicity

The current inert apply does `await UPDATE canonical` then `await INSERT event`
as separate statements — a crash or failure between them leaves canonical
changed with no audit. Stage 14 replaces it with a **two-phase transaction
design**, using the documented D1 semantics (verified against
`developers.cloudflare.com/d1/worker-api/d1-database/`): *"Batched statements
are SQL transactions. If a statement in the sequence fails, ... it aborts or
rolls back the entire sequence"*, executing sequentially and non-concurrently.

**Phase 1 — canonical mutation (an optimistic compare-and-swap):**

The implementation performs phase 1 as a **fresh read of the current target row
followed by a single guarded compare-and-swap `UPDATE` statement**, not as a
multi-statement batch. A lone `UPDATE` is already atomic in SQLite/D1, and the
concurrency safety comes from the CAS `WHERE` guard (below), not from wrapping
the read and write in one transaction:

1. `SELECT` the fresh base snapshot (7 columns + `updated_at`) of the target row
   at promotion time (no earlier approval-time snapshot is trusted).
2. The guarded compare-and-swap UPDATE (§7): sets only allow-listed columns,
   `updated_at = strftime(...)`, and a `WHERE` that matches `canonical_id = ?`
   **and all eight snapshot values with NULL-safe `IS`**. `meta.changes` must be
   exactly `1`; if a concurrent write drifted any value, zero rows match and the
   attempt surfaces as `stale_snapshot` (never a force, never a silent retry).
   Any CHECK violation (e.g. the bidet invariant) rejects the statement, leaving
   canonical unchanged.

**Phase 2 — evidence trail (one `db.batch()`, atomic):**

3. `INSERT canonical_promotions` row (the `UNIQUE(contribution_id)` gate lives
   here — a replay fails and rolls the batch back).
4. `INSERT contribution_events`: one `event_type='status_change'` row with
   `from_status` = `to_status` = `'approved'` and
   `detail_json = { action: 'canonical_promoted', promotion_id, canonical_id,
   changed_columns }`. Using `status_change` (rather than a new `promoted`
   event type) stays inside the **existing** event-type CHECK domain — no
   0005 restatement needed. The event is written with `actor_type='moderator'`
   and `actor_id = promoter`: the 0005 `actor_type` domain is
   `('system','contributor','moderator')` and Stage 14D does not widen it, so
   the privileged human promoter is recorded under the highest existing
   human-actor type. The true promoter identity is durably and unambiguously
   captured in the ledger's `promoter_user_id` (and `contributor_user_id`) on
   the same batch, so the audit event stays within schema while the ledger
   carries the promoter-specific fact.

**Order rationale and the residual window:** SQLite has no
`UPDATE ... RETURNING`, so the ledger row (which carries the resulting values)
cannot be inserted in the same batch before the UPDATE has actually happened.
The chosen order is **canonical-first, ledger-second**, which means:

- "audit says promoted but canonical was not changed" is **structurally
  impossible** — phase 2 only runs after phase 1 committed with exactly one row
  changed.
- "canonical changed but no ledger row" is possible **only** if the request
  dies between the two commits (sub-second window). Mitigations: the HTTP
  response reports success only after phase 2; a **read-only** reconciliation
  command plus the `idx_canonical_promotions_canonical` index **detect and
  classify** such orphans by comparing the approved contribution's stored
  payload against the live canonical row — they do **not** automatically
  reconstruct a ledger row (reconstruction would risk inventing a historical
  record; healing an orphan is an explicit, human-approved operator action,
  §19 gate 4). Failure direction is toward "visible but unproven change",
  never silent canonical drift.

No `passThroughOnException`, no post-response `waitUntil` for phase 2 — both
would widen the window; phase 2 runs inline in the request.

---

## 7. Concurrency control (optimistic compare-and-swap)

**Selected rule: guarded UPDATE on the snapshot's `updated_at`, with all seven
promotion-reachable field values re-checked inside the same batch.**

Answering the required questions:

1. **When is the snapshot captured?** At promotion time, by a fresh read of the
   current target row immediately before the single guarded CAS `UPDATE` (see
   §6 phase 1). Concurrency safety comes from the CAS `WHERE` matching all eight
   snapshot values with NULL-safe `IS` and requiring exactly one affected row —
   not from wrapping the read in the same transaction. No earlier
   "approval-time" snapshot is trusted.
2. **What fields are captured?** `access`, `fee`, `bidet_presence`, `name`,
   `address`, `latitude`, `longitude`, `updated_at`. `address` may be NULL;
   all snapshot comparisons use SQLite `IS` semantics (NULL-safe), never `=`.
3. **When is the snapshot compared?** As the `WHERE` guard of the UPDATE
   (`... AND updated_at = ?`) plus per-field guards; `meta.changes` must be
   exactly 1 or the batch aborts.
4. **If canonical data changed:** the guard matches zero rows → the batch
   fails → full rollback → `409 stale_snapshot` with a machine-readable drift
   report (`[{column, base_value, current_value}]`). Nothing is written: not
   canonical, not ledger, no state change; the attempt is audited (§3.2).
5. **Does the contribution become superseded?** Not automatically. A
   moderator (or owner) may move it to `superseded` after reviewing the drift
   report (§3.2 transition 5). Auto-supersede on drift is deferred — drift is
   information, not a verdict.
6. **Is re-review required?** Yes. An approved-on-snapshot-A claim is never
   promoted against snapshot-B. Recovery = a **fresh contribution** against the
   current values (normal moderation re-review) or a moderator supersede with
   note. No force-promote exists in v1.
7. **Can the moderator simply retry?** Retry is safe (idempotent) and permitted
   for **transient** failures (`500`, D1 unavailable, etc.). It can never
   succeed against a drifted row — only new data (a new contribution) moves a
   drifted field.
8. **How is the stale attempt audited?** Phase-1-only failure means nothing in
   D1 was written; the durable trace is the request log/observability plus (14E
   decision) an optional best-effort event row `status_change` with
   `detail.action='promotion_attempt_rejected', reason='stale_snapshot'`
   written after the rollback. The event insert is outside the failed batch and
   is best-effort; the contract does not require it, and its absence is not a
   safety gap (the promotion itself provably did not happen).

**Why `updated_at` and not a dedicated `row_version` integer:** D1 `STRICT`
tables have no auto-update trigger, and `updated_at` is already stamped by the
only canonical writer (the apply statement) and by owner-import tooling — so it
always reflects the true last-write instant of the row, needs no schema change
to existing data, and cannot be spoofed by request input. A dedicated
`row_version` column (additive `ALTER TABLE ... ADD COLUMN` in 14B) is recorded
as the **accepted future upgrade** if any second canonical writer ever appears
that forgets to stamp `updated_at`; until then, version churn on 776 rows for a
hypothetical writer is rejected.

---

## 8. Bidet-report promotion rules (explicit)

Canonical domain: `bidet_presence ∈ ('Yes','Unknown')` — there is no `No`.
Surveyed rows (any row with `bidet_source_id IS NOT NULL`, the audit counted
98) carry the DB invariant `bidet_presence='Yes' AND restroom_presence='Yes'`,
and `restroom_presence` is **not** promotion-writable.

| Transition | Verdict | Reason / requirement |
| --- | --- | --- |
| `Unknown → Yes` | **Permitted** (single-promoter in v1; owner may later require a second promoter) | The core community value. Row must have `bidet_source_id IS NULL` — structurally true, since the CHECK forbids surveyed rows from ever holding `Unknown`. Sets presence only; **never** `bidet_verification`. |
| `Yes → Yes` | **Refused: `409 redundant_noop`** | No-op writes create drift noise and pointless audit; reject with explanation so the promoter sees the place is already marked Yes. |
| `Unknown → Unknown` | **Refused: `409 redundant_noop`** | Redundant claim; same reasoning. |
| `Yes → Unknown` (row **has** `bidet_source_id`) | **Hard-prohibited — never via any promotion path** | Would violate the canonical CHECK. SQLite rejects it at the database level; the planner also refuses it earlier with `409 bidet_survey_conflict` so the error is explanatory, not raw. Field re-survey (owner import path) is the only route to downgrade a surveyed bidet. |
| `Yes → Unknown` (row has **no** `bidet_source_id`) | **Prohibited in v1**; reversal-only route (§18) | Community consensus must not silently erase a positive claim. If the `Yes` itself came from a prior community promotion, the correct action is an owner/promoter **reversal** of that promotion, not a new downgrading report. If the `Yes` was set by owner import, only the owner import path may change it. |

Additional contract rules:

- A promoted `bidet_report` MUST NOT set `bidet_verification`,
  `restroom_verification`, `restroom_presence`, or any provenance column — the
  writable-column allow-list already makes this unreachable; keep it that way.
- A promoted bidet presence SHOULD be reflected in the public read model with
  its existing verification status; the app must not display a community-
  promoted bidet as "field verified".
- `reverification` remains signal-only: a disputed bidet should generate a
  reverification **signal** for the owner's field survey, which is the only
  path to `field_verified` upgrades/downgrades.

---

## 9. Provenance

`location_provenance` records **acquisition provenance** — which source (OSM /
field-survey workbook) a canonical row originally came from, with `original_*`
values. That meaning is frozen.

**Decision: option C — the promotion ledger is the provenance link for
community-promoted field changes.**

- **A rejected:** a new `source_type='community_promoted'` in
  `location_provenance` would corrupt provenance into a change log, require
  broadening its CHECK (schema churn on a production table), and misuse
  `evidence_role`/`original_*` columns that describe row acquisition, not field
  edits.
- **B rejected:** a separate community-provenance table would duplicate exactly
  what the §5 ledger already stores (contribution → canonical change, before,
  after, actor, time) — two ledgers for one fact.

Invariants (structurally enforced, not policy prose):

- The promotion path contains **zero statements** writing
  `location_provenance`.
- `field_verified ≠ community observation`: presence and verification remain
  separate columns; the ledger + contribution + evidence chain is how a
  community-origin value is distinguished from an `osm_explicit` /
  `field_survey_bidet_workbook` original. Queryability: "is this field
  community-sourced?" = latest ledger row touched it.
- Overwriting the original field-survey provenance is impossible by
  construction (no write path exists).

---

## 10. Contribution-kind promotion policy matrix

| kind | promotion supported? | target required? | fields potentially changed | evidence requirement | validation requirement | concurrency requirement | provenance/audit requirement | destructive risk | authorization level | automatic promotion? | manual promotion required? | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `problem_report` | **No — signal only** | yes (at submit) | none | reviewer reads notes/evidence | n/a | n/a | decision events only | none via promotion (nothing writes) | moderator | never | n/a | informs a human; "problem" has no single column meaning |
| `closure_report` | **No — signal only** | yes (at submit) | none | reviewer | n/a | n/a | decision events only | lifecycle change is out of promotion scope | owner (import path) | never | n/a | closure = `record_status` lifecycle, a protected column; must stay an owner decision (§12) |
| `info_correction` | **Yes, gated** | yes | `name`, `address`, `latitude`+`longitude` (pair-only) | coordinate changes require ≥1 `field_observation` or `external_source` evidence entry | §11 rules (blank address, PII shape, pair rule) | CAS §7 | ledger + event | medium (mis-locates a place) | promoter | no | yes | factual edits are reviewable; geo edits carry extra rules |
| `access_update` | **Yes** | yes | `access` | none beyond normal review | enum domain (already contract-validated) | CAS §7 | ledger + event | low (reversible by new contribution) | promoter | no | yes | value inside an existing enum; trivially correctable |
| `fee_update` | **Yes** | yes | `fee` | none beyond normal review | enum domain | CAS §7 | ledger + event | low | promoter | no | yes | same as access |
| `bidet_report` | **Yes, transition-restricted** | yes | `bidet_presence` | normal review; upgrade `Unknown→Yes` is the only supported transition | §8 matrix | CAS §7 | ledger + event; **never** touches verification/provenance | medium (hope value distorts the map) | promoter (upgrade); reversal owner-level | no | yes | presence ≠ verification (§8, §9) |
| `reverification` | **No — signal only** | yes (at submit) | none | drives the owner field-survey queue | n/a | n/a | decision events only | none via promotion | owner (import path) | never | n/a | a re-check result is a *survey* act → `field_verified` semantics belong to owner import |
| `new_location` | **No via this path** | no (must be NULL) | would be an INSERT, not an UPDATE | see §12 | see §12 | n/a (no target to CAS) | see §12 | high (duplicate/PII insertion into truth) | owner only | never | manual import only | insertion has an entirely different risk profile; kept out of v1 promotion |

No kind is auto-promoted, ever, in Stage 14 v1: promotion is always an
explicit, authenticated, allow-listed human action per contribution.

---

## 11. Empty address rule

Stage 13 validation accepts `""` for `address` (verified in
`lib/contributions/contract.ts`). Per the mission, **Stage 13 code is not
touched in 14A**. Two-part resolution:

1. **Stage 14 promotion gate (planner-side, in 14C):** promotion refuses any
   payload whose `address` is empty or whitespace-only →
   `422 invalid_plan_reason=address_blank`. An existing non-empty address may
   only be replaced by another **non-empty, non-whitespace** value. A NULL
   snapshot address being set to a non-empty value is permitted.
2. **Follow-up candidate (separate, small, owner-approved patch, not part of
   14A):** tighten submit-time `address` validation the same way, so bad values
   never reach the queue. Until then, the promotion gate is the line of
   defense, and it is server-side, so the gap is contained.

Address **clearing** (non-empty → empty/NULL) is not a supported promotion
operation in v1 — a contributor wanting to say "address unknown" is
informationally identical to a no-change; it goes through review, not rewrite.

---

## 12. Coordinate-change rules

`latitude`/`longitude` are the fields whose errors move a pin on the map, so
promotion applies extra rules beyond CAS:

- **Pair rule (partial-update prevention):** a promotion plan derived from an
  `info_correction` whose payload contains exactly one of `latitude` /
  `longitude` is **refused** (`422 coordinates_partial`). Coordinates promote
  together or not at all. (Keep accepting single-coordinate submissions at
  Stage 13 — contributors may legitimately flag one bad value; the planner
  refuses to apply a half-change. Rationale: a lat-only or lon-only correction
  can relocate the pin to an arbitrary wrong place while each individual value
  still passes the range checks.)
- **Service-area bounds (existing rule, retained):** Dumaguete bounding box
  lat ∈ [9.0, 9.8], lon ∈ [123.0, 123.7] at submit and re-checked at promote.
  A promoted coordinate must lie inside it — this doubles as a
  wrong-continent typo guard without inventing a novel distance rule.
- **Proximity guard (justified threshold, detection-only):** if the promoted
  coordinate lies within **≈30 m** (haversine) of a *different* canonical row,
  promotion is refused with `409 proximity_conflict` listing the nearby id(s).
  30 m is not arbitrary: it is roughly "the same building/entrance" at street
  scale — inside it, two distinct public restrooms at one address are
  implausible without human reconciliation. v1 makes this refusal **informative
  only** (promoter resolves by superseding/merging via owner review); it does
  not auto-merge, never auto-deletes, and the promoter cannot override it in
  v1.
- **Evidence requirement:** coordinate promotions require the contribution to
  carry ≥1 structured evidence entry of type `field_observation` or
  `external_source` (per Stage 12 evidence semantics). Presence/enum updates
  do not (a sighted claim about a fee is self-evidencing; a re-location is not).
- **Reverification signal:** a successful coordinate promotion is a natural
  moment for the owner queue; the ledger row makes such rows enumerable via
  `changed_columns_json` — no extra column invented.
- **No arbitrary delta rules:** no "max 200 m move" style thresholds — they
  would be unjustified for a city where venues relocate legitimately. The
  bounds box + proximity guard + evidence + human promoter cover the real
  failure modes.

---

## 13. new_location policy

**Decision: Option A — Stage 14 v1 retains manual owner import as the only
canonical insertion path.** The existing inert apply already refuses
`new_location` promotion (`409 "new_location promotion is a manual owner
import"`); this becomes a *contract* rule, not just code behavior.

Why A over B (staging candidates) and C (dedicated insertion path):

- Insertion writes protected columns (`canonical_id`, `record_status`,
  `source_count` ≥ 1 CHECK, verification enums) that the entire Stage 12–13
  design exists to keep unreachable from user paths.
- Duplicate/proximity reconciliation (§12) against 776 curated rows is a
  data-curation job the owner performs with CSV tooling today; automating it
  well is a bigger design than field-update promotion and must not raise the
  blast radius of 14B–14I.
- Option B (a staging table) is recorded as the **future direction** if/when
  contribution volume makes manual import a bottleneck; it should be a separate
  stage (15+) with its own audit.

If a later stage automates insertion, the contract it must satisfy (recorded
here so nobody improvises): server-generated id `buttler_loc_<32 hex>` from
`crypto.randomUUID()` (note: today's ids are 20 hex; a generation rule must be
pinned and validated against the `/^buttler_loc_[0-9a-f]{20}$/` accept-regex
used at submit — **decision needed**: either keep 20-hex ids by truncating
deterministically at import time and document collision handling, or widen the
regex; flagged in Appendix F); duplicate detection (normalized-name + ≤30 m
proximity against canonical); required fields (name, lat, lon; sensible safe
defaults `record_status='community-submitted'`, `source_count=1`,
verification=`candidate_unverified`/`unknown`, presence claims only as
reported); provenance = a ledger-style insert provenance record (NOT a
fabricated OSM/source-survey row); audit event; rollback = owner-authorized
row removal with ledger annotation, never silent delete.

---

## 14. Destructive / lifecycle change policy

A generic "approved ⇒ write anything" model is explicitly prohibited. The
writable-column allow-list is the structural floor: `record_status`, both
verification columns, `restroom_presence`, ids, and timestamps are
**unreachable by promotion**, full stop. Policy per class:

| Class | v1 route | Requirements |
| --- | --- | --- |
| Closure ("this place is gone") | **Never a promotion.** `closure_report` is signal-only; lifecycle transition (→ `outdated`/`rejected`/hidden) is an owner import-path action | owner-only; explicit confirmation; reversible state exists because nothing is deleted |
| Problem reports / signal downgrades | No canonical write; feed the reverification queue | moderator decision trail only |
| Bidet downgrade `Yes→Unknown` | Prohibited (§8) | surveyed rows: DB-forbidden; community-set `Yes`: reversal workflow (§18) |
| Coordinate relocation | Promotion with extra gates (§12) | evidence + pair rule + proximity guard; promoter-only |
| Name replacement | Ordinary `info_correction` promotion | CAS + ledger; PII-shape check: a "name" containing an email/URL/phone pattern is refused at promote (`422 name_pii_shape`) |
| Any row deletion from canonical | Not supported anywhere in 14A–14K | owner import + backup/restore only |

No second-moderator or re-review mechanism is invented for promotion itself
(v1: single promoter + self-check); the two-person idea is recorded as an
owner-tightening option for coordinate/bidet classes once a second promoter id
exists (§4).

---

## 15. API design (contract for 14E — not implemented)

**Selected route:**

```
POST /api/moderation/contributions/{id}/promotion
```

Alternatives considered: `.../apply` (verb-ish, collides with the inert
`applyApprovedToCanonical` naming and its Stage 13 meaning),
`.../decisions/promote` (implies a decision; approval ≠ promotion is the exact
confusion this stage prevents), `POST /api/moderation/promotions` with body
`{contribution_id}` (splits the resource pair across two URLs). A sub-resource
collection under the moderated contribution reads as "create the promotion of
this contribution", matches the existing path grammar
(`functions/api/moderation/contributions/[id]/[decision].ts`), and keeps `{id}`
as the only input.

**Request:**

- Auth: `Authorization: Bearer <Auth0 access token>` — same fail-closed
  contract as Stage 13 (`503` unconfigured, `401` no/invalid token).
- Body: **empty / ignored**. The endpoint accepts **never**:
  `canonical_id` (derived from the stored contribution), column names, SQL,
  canonical field values (taken from the stored `payload_json` through the
  fixed mapping), or caller identity/role. The contribution row is the sole
  authoritative source of the proposed change.

**Success response:** `200`
```json
{ "promotionId": "promo_…", "canonicalId": "buttler_loc_…",
  "changedColumns": ["bidet_presence"], "promotedAt": "…" }
```

**Failure responses** (see §16 for the full matrix): `401`, `403`, `404`,
`409` (with machine-readable `reason` codes: `not_approved`, `already_promoted`,
`stale_snapshot` + drift report, `redundant_noop`, `kind_not_promotable`,
`manual_import_only`, `bidet_survey_conflict`, `proximity_conflict`), `422`
(`invalid_plan_reason`: `address_blank`, `coordinates_partial`,
`name_pii_shape`, `coordinate_out_of_bounds`), `500` (transient; retryable).

**Idempotency behavior:** not header-based. The ledger `UNIQUE(contribution_id)`
+ CAS make *any* repeated request, from any client, safe: at most one promotion
can ever exist per contribution, and replays surface as `409 already_promoted`
(pre-flight read) or a rolled-back batch (race). No `Idempotency-Key` infra is
needed because the natural key is the contribution.

**Stale snapshot behavior:** `409 stale_snapshot` with
`drift: [{column, baseValue, currentValue}]`; nothing written; §7 answers 5–7
apply (no auto-supersede, no force, recovery via new contribution).

---

## 16. Transaction / failure matrix

Legend — C-state: canonical mutation permitted? L: ledger row written?
E: audit event required? C-state change: contribution status changed?

| Scenario | HTTP | D1 permitted? | Canonical | Ledger | Event | Contribution status | Retry behavior |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Auth not configured (prod state today) | 503 | no | — | — | — | none | after owner configures Auth0 |
| Anonymous / invalid token | 401 | no | — | — | — | none | after sign-in |
| Caller not in `BUTTLER_PROMOTER_IDS` | 403 | no | — | optional best-effort rejection event | none | none | never (by role) |
| Caller is the contributor | 403 | no | — | event recommended | none | none | never (by identity) |
| Contribution missing / malformed id | 404 | no | — | — | — | — | n/a |
| Contribution `pending` / `validated` / `needs_review` | 409 `not_approved` | no | — | — | — | none | after moderation decision |
| Contribution `rejected` / `withdrawn` / `superseded` | 409 `not_approved` | no | — | — | — | none | never for this row |
| Contribution `approved` but kind ineligible (§10) | 409 `kind_not_promotable` | no | — | — | — | none | n/a — signal kinds have no plan |
| `new_location` | 409 `manual_import_only` | no | — | — | — | none | owner import path only |
| Already promoted (ledger row exists) | 409 `already_promoted` | no | — | blocked by UNIQUE | — | none | replay is permanently impossible |
| Concurrent double-request race | one 200, one 409 | batch-per-batch | exactly one wins (UNIQUE + CAS) | one row | one event | unchanged | loser's effect was zero |
| Canonical target missing (row removed by owner cleanup) | 404 | no | — | FK fails anyway | — | none | n/a; FK + guard both refuse |
| Canonical snapshot stale (drift) | 409 `stale_snapshot` + drift | batch aborts, rollback | unchanged | none | optional best-effort | none (moderator may later supersede) | new contribution required (§7) |
| Redundant payload (values == canonical) | 409 `redundant_noop` | no | unchanged | none | — | none | n/a; explain to promoter |
| Invalid plan: blank address / half coordinates / PII name / out-of-bounds | 422 `<reason>` | no (planner refuses before batch) | unchanged | none | — | none | n/a; contribution needs replacement or review outcome |
| Bidet `Yes→Unknown` on surveyed row | 409 `bidet_survey_conflict` (planner) — DB CHECK also refuses structurally | no | unchanged | none | — | none | field-survey path only |
| Proximity conflict (≤30 m to different row) | 409 `proximity_conflict` | no | unchanged | none | — | none | owner reconciliation |
| Canonical constraint violation at batch time | 500 | batch aborts | unchanged | none | — | none | retryable; surfaces as a planner bug to fix |
| Provenance write attempted | impossible | no such statement exists in the promotion path | — | — | — | — | contract invariant (§9) |
| Phase-2 (ledger/event) failure after phase-1 commit | 500 | phase 1 committed | **changed** | missing (orphan) | missing | none | read-only reconciliation **detects/classifies** the orphan (§5.2, §6); an operator decides the repair; response never claims success |
| Transient D1 unavailable | 500 | no | unchanged | none | — | none | safe retry (nothing committed) |

---

## 17. Test contract (for 14F; naming continues the Stage 13 suite style)

Harness parity: same pattern as `scripts/stage13-contributions.test.mjs` —
in-memory SQLite + the real 776/845/1,110 dataset snapshot; **no** production
access; throwaway rows only.

AUTHORIZATION — `auth.*`
- `auth.anonymous_rejected` (401), `auth.unconfigured_failclosed` (503)
- `auth.contributor_self_promotion_rejected` (403, own submission)
- `auth.non_promoter_moderator_rejected` (403 — moderator ≠ promoter; the lists
  are separate)
- `auth.promoter_accepted` (200 + ledger + event + correct column change)
- `auth.body_identity_ignored` (identity from token only)

LIFECYCLE — `lifecycle.*`
- `lifecycle.pending_cannot_promote`, `lifecycle.validated_cannot_promote`,
  `lifecycle.needs_review_cannot_promote`, `lifecycle.rejected_cannot_promote`,
  `lifecycle.withdrawn_cannot_promote`, `lifecycle.superseded_cannot_promote`
- `lifecycle.approved_enters_gate`
- `lifecycle.already_promoted_cannot_replay` (second call 409; row byte-identical)
- `lifecycle.approved_row_immutable` (contribution row hash unchanged pre/post)

CONCURRENCY — `concurrency.*`
- `concurrency.unchanged_canonical_succeeds`
- `concurrency.changed_canonical_detected` (drift report names the drifted column)
- `concurrency.stale_cannot_overwrite_newer` (owner-stamped newer value survives)
- `concurrency.null_address_is_safe` (`IS` semantics; NULL↔value drift caught)
- `concurrency.race_single_winner` (two batches against same snapshot → exactly one ledger row)

ATOMICITY — `atomicity.*`
- `atomicity.canonical_ledger_event_commit_together`
- `atomicity.planner_refusal_writes_nothing` (each 422/409 case: zero deltas on all three tables)
- `atomicity.batch_abort_rolls_back` (injected CHECK failure → canonical unchanged, no ledger, no event)
- `atomicity.phase2_orphan_reconcilable` (simulated crash → the read-only
  reconciliation **detects and classifies** the orphan as `suspected_orphans`
  and writes nothing; it never reconstructs a ledger row — repair stays an
  explicit operator action)

PAYLOAD / PLAN — `payload.*`
- `payload.arbitrary_column_unreachable`, `payload.reserved_key_unreachable`
  (planner input is stored payload only)
- `payload.empty_address_rejected`, `payload.whitespace_address_rejected`
- `payload.invalid_coordinate_rejected`, `payload.half_coordinate_pair_rejected`
- `payload.name_pii_shape_rejected`
- `payload.bidet_transition_matrix` (all five §8 transitions, incl. surveyed-row
  hard-refusal via real CHECK)

AUDIT — `audit.*`
- `audit.previous_values_captured`, `audit.resulting_values_captured`,
  `audit.actor_captured`, `audit.contribution_id_captured`,
  `audit.canonical_id_captured`, `audit.timestamp_captured`,
  `audit.event_within_existing_type_domain` (no CHECK violation on 0005)

PROVENANCE — `provenance.*`
- `provenance.osm_rows_untouched`, `provenance.field_survey_untouched`
  (provenance table byte-identical before/after full promotion run)
- `provenance.community_never_field_verified` (verification columns unchanged)
- `provenance.promoted_change_distinguishable` (ledger query answers "community-sourced?")

NEW LOCATION — `newloc.*`
- `newloc.promotion_refused_manual_import_only`
- `newloc.no_automatic_canonical_insert_under_any_path` (row counts unchanged)
- `newloc.duplicate_and_proximity_rules_deferred_documented` (contract check
  that §13 future rules remain unimplemented in 14)

CANONICAL INTEGRITY (global, mirrors Stage 13): after the entire suite,
`canonical_locations` differs from baseline by exactly the tested promotions,
`location_provenance` is byte-identical, legacy `restroom_locations` is
byte-identical.

---

## 18. Rollback / reversal design

Mistaken promotions are corrected **forward**, never by rewriting history:

- **Immutable promotion record:** ledger rows are never updated or deleted.
- **Previous-value capture:** every ledger row stores `base_snapshot_json` —
  the exact pre-promotion values — making any promotion precisely reversible
  *as data*.
- **Standard path — corrective contribution:** for most field regressions, a
  contributor (or owner drafting a record) submits a new contribution carrying
  the desired values; normal moderation + promotion apply it. The ledger then
  tells the full story: A changed X→Y on day 1, B changed Y→X on day 2.
- **Dedicated reversal workflow (kept, narrowly):** a promoter may
  `POST /api/moderation/promotions/{id}/reversal`-style action (final route in
  14E design; concept fixed here) which inserts a **new** ledger row with
  `reversal_of = {promotion_id}` and performs a guarded restore via the same
  two-phase transaction: allowed only if the current values still equal the
  original promotion's `resulting_values_json` (i.e. nobody edited since);
  otherwise refused (`409 superseded_by_later_edit`) and the corrective-
  contribution path is the route. Primary use case: reversing a wrong
  `Unknown→Yes` bidet promotion — the one correction the §8 matrix otherwise
  prohibits (§18 is its exit).
- **Not destructive undo:** no DELETE, no ledger edit, no "reset to import
  baseline" outside the owner's normal backup-restore authority.
- **Git/code rollback pre-14I:** every 14B–14H artifact is revertible by
  reversal commit; the 0006 migration has a tested drop script
  (`d1/rollback/0006_drop_canonical_promotions.sql`) prepared in 14B.

**Decision required (Appendix F):** whether v1 ships the dedicated reversal or
launches with corrective contributions only. Recommendation: ship reversal in
v1 but promoter-allow-list-gated and restricted to "restore exactly what one
promotion changed", because the bidet case genuinely needs it.

---

## 19. Deployment gates (what must be true before any promotion endpoint is exposed)

1. **14B** migration `0006` merged, applied to a **throwaway** D1 and verified
   (STRICT table, UNIQUE index, FK behavior) before any shared-db discussion.
2. **14C/14D** planner + executor covered by the §17 suite at 100% of listed
   cases; `pnpm test:stage13` and all regression guards still green.
3. **Authorization seam:** `BUTTLER_PROMOTER_IDS` exists as env **name** in
   example files only; unset ⇒ endpoint fails closed (403/503 class), tested.
4. **Reconciliation command** exists, is read-only and idempotent: it detects,
   classifies, and reports crash-window orphans (§5.2/§6) but never invents or
   reconstructs ledger rows — any repair is an explicit, human-approved action.
   Tested in 14F.
5. **14H read-only readiness audit** re-verifies the audit-derived counts (§1)
   against production with SELECT-only access.
6. **Owner approvals** (Appendix F) recorded for: applying 0006 to production,
   exposing the endpoint, deploying, and the first controlled promotion.
7. **Backup verified** (restore-tested) before the first production promotion;
   the canonical table's pre-promotion snapshot retained.
8. Phase-2 failure mode documented in ops runbook (read-only orphan detection
   + the explicit, human-approved repair path), because it is the one
   non-instantly-reversible behavior in the design.

Until every gate above is green, the endpoint stays unwired and
`applyApprovedToCanonical` stays inert — the current state, preserved.

---

## 20. Explicit non-goals — Stage 14A does NOT

- modify canonical data or any production data
- automatically apply existing approved contributions
- create new canonical locations (insertion stays owner import)
- change bidet verification semantics (`field_verified` etc.)
- change provenance semantics or write `location_provenance` from any promotion path
- expose the current apply function through an endpoint
- alter Auth0 configuration, secrets, or env values
- change any Stage 13 behavior, validation code, or status domain
- delete the Phase 12B test contributions
- clean unrelated repository artifacts (`.tmp-*` dirs etc.)
- repair the unrelated legacy TypeScript errors (`lib/api-zod`, `lib/replit-auth-web`)
- commit or push anything

---

## Appendix — Final status summary (mission §21)

**A. Stage 13 status:** COMPLETE. Auth0 identity, contribution submission,
persistence, append-only events, moderator authorization, self-moderation
prevention, approval, decision events, and canonical immutability are proven by
production E2E. This document reopens none of it.

**B. Stage 14 status:** 14A design contract only (this document). Nothing
below is implemented.

**C. Selected promotion architecture:** an append-only
`canonical_promotions` ledger (Option B) that never rewrites contribution rows;
two-phase D1 transactions (atomic CAS-guarded canonical UPDATE batch, then
ledger+event batch); optimistic concurrency on the promotion-time snapshot
(`updated_at` + seven field values, NULL-safe `IS` comparisons); per-kind
eligibility with signal-only kinds staying signals; bidet transitions
restricted by §8; provenance untouched; promoter allow-list separate from
moderators; single `POST /api/moderation/contributions/{id}/promotion`
endpoint with an empty body, designed but not built.

**D. Exact safeguards required before any endpoint is exposed:** the eight
gates in §19 — most critically the ledger UNIQUE replay gate, the CAS guard
inside one transaction, the §17 suite, fail-closed `BUTTLER_PROMOTER_IDS`, the
reconciliation command, verified backup, and per-action owner approvals.

**E. Smallest safe implementation sequence:**
14A this contract → 14B ledger migration + drop script (throwaway D1 only) →
14C pure promotion planner (kinds, §8/§11/§12 rules; no I/O) → 14D transactional
executor (§6/§7) → 14E authorization (`authorizeCanonicalPromotion`,
`BUTTLER_PROMOTER_IDS`) + endpoint (§15) → 14F §17 suite → 14G throwaway-D1 E2E
→ 14H production read-only readiness audit → 14I controlled production
deployment (owner-approved) → 14J controlled production E2E with disposable
contributions → 14K post-deployment verification (counts + ledger diff).

**F. Decisions still requiring owner approval (none taken here):**

1. Adopt this contract as the binding Stage 14 spec (vs. requesting changes).
2. §5/§7 future-upgrade clause: add a dedicated `row_version` column in 14B or
   keep `updated_at`-as-version (recommended: keep, no churn).
3. §7: confirm "any drift blocks promotion" (recommended) vs. column-scoped
   staleness.
4. §8: confirm bidet downgrades are prohibited-with-reversal-only (recommended)
   vs. allowing a stronger-authorization downgrade path.
5. §12: confirm the 30 m proximity guard and evidence requirement for
   coordinate promotions.
6. §13: confirm `new_location` stays manual owner import in v1; plus the
   canonical-id generation/regex question if insertion is ever automated.
7. §4: confirm promoter = owner-only allow-list (`BUTTLER_PROMOTER_IDS`) and no
   two-person rule in v1.
8. §15: confirm the `/promotion` sub-resource route.
9. §18: confirm whether v1 ships the dedicated reversal workflow (recommended)
   or corrective contributions only.
10. Every execution step of 14B–14K individually (migration apply, endpoint
    exposure, deploy, production E2E, backups) — design approval here is not
    implementation or deployment approval.

---

**FINAL STATUS:**

```
STAGE 13               = COMPLETE
STAGE 14A              = DESIGN CONTRACT (this document; not committed)
CANONICAL PROMOTION    = NOT IMPLEMENTED
PRODUCTION DATA        = UNCHANGED
CANONICAL READ MODEL   = UNCHANGED (776 / 845 / 1,112)
```
