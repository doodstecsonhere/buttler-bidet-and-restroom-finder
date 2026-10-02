-- Rollback for the Stage 13 contribution schema (production migration 0005).
--
-- 0005_create_contributions.sql has been promoted to `d1/migrations/` and
-- applied to the production D1 `buttler-read-model` (owner-approved,
-- 2026-10-01), so this script is the documented reversal path for that
-- applied migration. Dropping these tables removes contribution records, so
-- it is a destructive action that requires a verified backup and separate
-- approval. It never touches canonical_locations, location_provenance, or the
-- legacy restroom_locations table. Order matters: contribution_events
-- references contributions, so drop the child first.

DROP TABLE IF EXISTS contribution_events;
DROP TABLE IF EXISTS contributions;
