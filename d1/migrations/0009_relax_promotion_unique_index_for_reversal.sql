-- Buttler 2.0 — Stage 14 ownership completion: ledger index swap for reversal.
--
-- WHY (owner-approved decision, 2026-10-04): the frozen Stage 14A contract
-- §18 defines a reversal as a NEW, forward-appended `canonical_promotions`
-- row (`reversal_of = <original promotion_id>`) that restores exactly the
-- guarded pre-promotion snapshot. Such a row necessarily carries the SAME
-- `contribution_id` as the promotion it reverses — but migration 0006 created
-- `UNIQUE (contribution_id)` (§5.2's replay gate), which structurally forbids
-- that second row. The two frozen decisions cannot both hold; §18 is the
-- contract's own correction mechanism (and the only exit for a wrong
-- Unknown→Yes bidet promotion per §8), so the owner chose to keep reversal and
-- relax the index. This migration is applied to production D1 only under the
-- final Stage 14 ownership mission's explicit production authorization, after
-- the migration ledger and backups were verified.
--
-- WHAT: drops the UNIQUE index and recreates the same index NON-unique. It
-- touches NO rows, NO columns, NO other table — canonical_locations,
-- location_provenance, contributions, and contribution_events are untouched,
-- and every existing ledger row is preserved byte-identical (append-only, §5).
--
-- WHAT STILL PROTECTS DUPLICATE PROMOTION (the §5.2 gate, now enforced one
-- layer up instead of in the index):
--   * the executor's phase-4 replay pre-check refuses any second promotion of
--     a contribution whose canonical value has drifted (`already_promoted`),
--     and the planner refuses an ordinary replay earlier still
--     (`redundant_noop`) — both proven by the Stage 14D/14E suites;
--   * every phase-2 write (promotion OR reversal) runs as ONE `db.batch()`,
--     which D1 executes as a single transaction, so a lost replay race rolls
--     the whole ledger+event batch back rather than committing half;
--   * a repeat reversal is caught twice over: the executor's `already_reversed`
--     pre-check refuses it after the first reversal committed, and only ONE
--     concurrent reversal can ever win the phase-1 compare-and-swap (a second
--     sees the flipped value and refuses as `superseded_by_later_edit`), so a
--     second reversal row for the same promotion is never appended.
--
-- Rollback: d1/rollback/0009_restore_unique_promotion_index.sql — restores the
-- UNIQUE index after verifying (in-script) that no contribution holds more
-- than one promotion row. If that verification ever fails, the rollback
-- refuses to run instead of silently deleting ledger history.

DROP INDEX IF EXISTS idx_canonical_promotions_contribution;

CREATE INDEX idx_canonical_promotions_contribution
  ON canonical_promotions (contribution_id);
