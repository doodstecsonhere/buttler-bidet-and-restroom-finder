-- Buttler 2.0 — Stage 14B canonical promotion ledger (SCHEMA ONLY; created
-- under the frozen Stage 14A contract, docs/stage14a-canonical-promotion-
-- contract.md §5.2). As of this commit the migration is validated ONLY against
-- disposable local D1 databases; applying it to the shared production D1
-- `buttler-read-model` remains a separately owner-approved deployment gate
-- (contract §19 gate 1).
--
-- The rule this table exists to enforce, carried unchanged from Stages 12–13:
-- AN APPROVED COMMUNITY OBSERVATION IS NOT CANONICAL TRUTH. A ledger row here
-- is the single durable record that one specific approved contribution was
-- promoted into a canonical field change. Promotion state is derivable from
-- this table alone — no contribution status was added or changed (§3.1).
--
-- It is strictly ADDITIVE: creates this one table and its two indexes only. It
-- does not touch canonical_locations, location_provenance, the legacy
-- restroom_locations table, contributions, contribution_events, the 776
-- canonical records, or the 845 provenance links. Both foreign keys are
-- read-only references; nothing here can write a canonical or contribution
-- row, and no promotion behavior (planner, executor, endpoint) exists yet —
-- 14B ships no HTTP surface (contract §14A scope: schema-only).
--
-- Contract properties preserved by the CHECKs below (see §5.2):
--   • Append-only by design: reversals are NEW rows via `reversal_of`, never
--     edits (§18). `status` is therefore pinned to the single value
--     'promoted' — a flip would mean rewriting history.
--   • UNIQUE(contribution_id) on the index below is the permanent replay /
--     idempotency gate: a contribution can be promoted at most once (§6).
--   • The three *_json columns must be valid JSON so base snapshots and
--     resulting values stay machine-restorable for reversals (§18).
--   • `kind` is restricted to the four promotion-eligible kinds (§10 matrix);
--     signal-only kinds and `new_location` have no ledger representation.
--   • Migration id convention: reconciliation derives `promotion_id` as
--     'promo_' + 32 hex of the canonical updated_at stamp — 38 chars, inside
--     the 8–64 length CHECK (§5.2).

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
