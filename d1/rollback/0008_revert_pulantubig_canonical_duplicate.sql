-- Buttler 2.0 — Stage 14K rollback for 0008_reconcile_pulantubig_canonical_duplicate.sql
--
-- Restores the EXACT pre-merge snapshot captured read-only from production on
-- 2026-10-04 (see .tmp-14k/phase1-canonical-rows.json and phase1-provenance.json
-- at authoring time). Reverse of the forward migration:
--   1. Revert the survivor to its original OSM-only candidate state (frees the
--      unique bidet_source_id slot).
--   2. Move the field-survey provenance back to the duplicate.
--   3. Return the duplicate to its original active (candidate) surveyed state
--      (reclaims the unique slot freed in step 1).
-- Everything else on both rows was never touched by the forward migration, so it
-- needs no restore. created_at is never modified by either migration.
--
-- Order respects idx_canonical_locations_bidet_source (UNIQUE WHERE NOT NULL):
-- the survivor releases the survey id before the duplicate reclaims it.

-- 1. Restore the survivor (Bahay Pamahalaan) to its pre-merge candidate state.
UPDATE canonical_locations
   SET restroom_presence = 'Unknown',
       bidet_presence = 'Unknown',
       access = 'unknown',
       restroom_verification = 'candidate_unverified',
       bidet_verification = 'unknown',
       bidet_source_id = NULL,
       source_count = 1,
       match_status = 'candidate_without_verified_bidet_match',
       match_reason = NULL,
       notes = NULL,
       updated_at = '2026-09-22T16:48:11.465Z'
 WHERE canonical_id = 'buttler_loc_a7db20b50c9993d58c0e';

-- 2. Reassociate the field-survey provenance back to the duplicate.
UPDATE location_provenance
   SET canonical_id = 'buttler_loc_a962aa157dff936ae36a'
 WHERE canonical_id = 'buttler_loc_a7db20b50c9993d58c0e'
   AND source_link_id = 'bidet_survey_2fb2f828db6b507991d2';

-- 3. Restore the duplicate (Pulantubig Barangay Hall) to its pre-merge active
--    surveyed state. Its presence/access/fee/name/coordinates were never changed
--    by the forward migration; the survey id, the verification labels that depend
--    on it, record_status, notes and updated_at are reverted here.
UPDATE canonical_locations
   SET bidet_source_id = 'bidet_survey_2fb2f828db6b507991d2',
       bidet_verification = 'field_verified',
       restroom_verification = 'field_verified_via_bidet_survey',
       record_status = 'candidate',
       notes = 'Survey-derived canonical location; no automatic restroom merge applied.',
       updated_at = '2026-09-22T16:48:11.465Z'
 WHERE canonical_id = 'buttler_loc_a962aa157dff936ae36a';
