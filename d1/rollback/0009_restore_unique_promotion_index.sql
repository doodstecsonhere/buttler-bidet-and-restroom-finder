-- Buttler 2.0 — rollback for migration 0009
-- (d1/migrations/0009_relax_promotion_unique_index_for_reversal.sql).
--
-- Restores the §5.2 UNIQUE(contribution_id) replay gate. This script touches
-- no rows and deletes nothing. If the ledger ever holds more than one row for
-- a single contribution (i.e. a promotion plus a reversal, which the Stage 14
-- §18 reversal design intentionally allows), the verification statement below
-- crashes the script BEFORE the UNIQUE index is created — the correct
-- response then is to keep the non-unique index, not to delete history.
--
-- Usage (throwaway/local first, production only with owner approval):
--   wrangler d1 execute buttler-read-model --local  --file d1/rollback/0009_restore_unique_promotion_index.sql
--   wrangler d1 execute buttler-read-model --remote --file d1/rollback/0009_restore_unique_promotion_index.sql

-- Fail-closed guard: raises "NOT NULL check failed: a contribution holds more
-- than one ledger row" when UNIQUE would silently require deleting history.
SELECT CASE
  WHEN (
    SELECT COUNT(*) FROM (
      SELECT contribution_id FROM canonical_promotions
      GROUP BY contribution_id HAVING COUNT(*) > 1
    )
  ) = 0
  THEN 1
  ELSE NULL
END AS "a contribution holds more than one ledger row - keep the non-unique index (0009), do not delete history";

DROP INDEX IF EXISTS idx_canonical_promotions_contribution;

CREATE UNIQUE INDEX idx_canonical_promotions_contribution
  ON canonical_promotions (contribution_id);
