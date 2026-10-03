-- Rollback for the Stage 14G DICT canonical addition (migration 0007).
--
-- 0007_seed_canonical_locations_added_01.sql adds exactly ONE canonical
-- location (Department of Information and Communications Technology,
-- buttler_loc_e43982e95335d647d95c) and its TWO provenance rows (the OSM
-- node/12566526394 acquisition row and the bidet_survey_17faf0a4b26e748fbd3c
-- field-survey row). This script is the documented reversal path for that
-- applied migration and deletes ONLY those three rows.
--
-- Order matters: location_provenance rows reference canonical_locations via
-- a foreign key, so the two provenance rows are deleted before the canonical
-- row. The deletion is keyed on the exact DICT canonical id, so it can never
-- remove any of the 776 pre-existing frozen-base locations, their provenance,
-- the legacy restroom_locations table, contributions, contribution_events, or
-- canonical_promotions.
--
-- Do NOT run this against production without a verified backup and separate
-- owner approval; it permanently removes the DICT rows added by 0007.

DELETE FROM location_provenance
WHERE canonical_id = 'buttler_loc_e43982e95335d647d95c'
  AND source_link_id IN ('node/12566526394', 'bidet_survey_17faf0a4b26e748fbd3c');

DELETE FROM canonical_locations
WHERE canonical_id = 'buttler_loc_e43982e95335d647d95c';
