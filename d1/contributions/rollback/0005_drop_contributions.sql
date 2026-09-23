-- Rollback for the STAGED Stage 13 contribution schema.
--
-- Only relevant once 0005 has actually been applied (see the header in
-- 0005_create_contributions.sql — it has NOT been applied to any real database
-- yet). Dropping these tables removes contribution records, so it is a
-- destructive action that requires a verified backup and separate approval.
-- It never touches canonical_locations, location_provenance, or the legacy
-- restroom_locations table. Order matters: contribution_events references
-- contributions, so drop the child first.

DROP TABLE IF EXISTS contribution_events;
DROP TABLE IF EXISTS contributions;
