-- Buttler 2.0 — Stage 14K: controlled Pulantubig canonical duplicate merge.
--
-- WHAT THIS MIGRATION IS
--   A canonical IDENTITY RECONCILIATION, not an ordinary Stage 14 promotion and
--   not an ad-hoc production edit. Two canonical rows were established (owner
--   authoritative decision) to be the SAME physical facility:
--     RETAIN (survivor):  buttler_loc_a7db20b50c9993d58c0e  "Bahay Pamahalaan ng
--                         Barangay Pulantubig" (OSM way/1038157450 identity)
--     MERGE AWAY (dup):    buttler_loc_a962aa157dff936ae36a  "Pulantubig Barangay
--                         Hall" (field-survey bidet_survey_2fb2f828db6b507991d2)
--
-- FIELD PRECEDENCE (Phase 3), justified by the owner decision + corroborating
-- contributions contrib_b31ba5e67fc346b1bf9af6ef1e41c954 (access->public),
-- contrib_415a0227f7f54258954bd6c7a20f0c16 (bidet->Yes), and
-- contrib_12e2533907b44686bd357b7d654498f2 (closure of the duplicate as a
-- duplicate of the survivor):
--   name / address / coordinates : RETAIN the survivor (Bahay Pamahalaan). The
--       survivor's identity and its "L. Rovira West Road" address are anchored
--       to the OSM way geometry, so the surviving coordinate is the survivor's
--       existing 9.3240755,123.2880588. The field-survey point (tied to the
--       duplicate's different "Purok Tikling" address) and the earlier pending
--       coordinate proposal (contrib_9cfcf5c2..., 9.324338,123.288141) are NOT
--       adopted: neither is established as more correct for the surviving
--       address, and a coordinate is never moved merely because a point falls
--       inside a proximity threshold.
--   bidet + restroom presence & verification + bidet_source_id : TAKE the
--       duplicate's field-verified values (bidet Yes / field_verified, restroom
--       Yes / field_verified_via_bidet_survey, survey source id). Field
--       verification is preserved, never downgraded.
--   access : TAKE the duplicate's 'public'.
--   fee : UNCHANGED ('unknown'). The authoritative decision and the evidence do
--       not establish the survey fee as correct for the surviving address, so it
--       is not overwritten merely because of the merge.
--   source_count : 1 -> 2 (the survivor now carries the OSM provenance row and
--       the reassociated field-survey provenance row).
--
-- LINEAGE (Phase 5)
--   The schema has no canonical supersession table, so the narrowest existing
--   mechanism is used: the field-survey provenance row is REASSOCIATED to the
--   survivor (its original_* columns still record the duplicate's original name,
--   coordinate and address verbatim), the survivor's notes/match_reason document
--   the merge and the three corroborating contributions, and the duplicate row is
--   MARKED (record_status='rejected') rather than deleted so the contributions
--   that still reference it keep a valid foreign key and rollback stays exact.
--   LIMITATION: this reconciliation lives in the D1 read model only. The owner's
--   canonical CSV source is intentionally NOT edited here (dropping the
--   duplicate id would violate the frozen 0004 base guard, and zeroing a base
--   row's provenance would break the Source_Count/provenance invariants in
--   import-canonical.mjs). Fold the merge into the CSV at the next scheduled
--   owner re-import so the offline bundle snapshot catches up.
--
-- CONSTRAINT HANDLING (no schema is weakened)
--   idx_canonical_locations_bidet_source is UNIQUE WHERE bidet_source_id IS NOT
--   NULL, so the survey id cannot sit on both rows at once. The statements below
--   FREE the slot on the duplicate first (statement 1), then claim it on the
--   survivor (statement 2), respecting the existing constraint by ordering
--   rather than by altering it. The survivor's CHECK (bidet_source_id IS NULL OR
--   bidet_presence='Yes' AND restroom_presence='Yes') is satisfied because the
--   same statement sets both presences to 'Yes'.
--
--   VERIFICATION FOLLOWS ITS EVIDENCE. In this read model a field verification is
--   only meaningful while the row still holds the survey that produced it: every
--   one of the 99 records with bidet_verification='field_verified' carries a
--   bidet_source_id, and restroom_verification='field_verified_via_bidet_survey'
--   names that same survey. Because the survey transfers to the survivor, the
--   duplicate must release its verification labels with it (statement 1), or it
--   would keep asserting 'field_verified' with no evidence behind it. Its
--   presence facts and its original name/address/coordinate stay on the row for
--   audit; only the evidentiary claims move.
--
-- IDEMPOTENT / replay-safe: every statement converges to the same end state and
-- matches zero rows when already applied, so a re-run is a safe no-op. Rollback:
-- d1/rollback/0008_revert_pulantubig_canonical_duplicate.sql restores the exact
-- pre-merge snapshot (captured read-only from production 2026-10-04).

-- 1. Release the duplicate's claim on the field survey: free the unique
--    bidet_source_id slot (the survivor claims it in the next statement) and
--    downgrade the verification labels that were backed by that survey. Name,
--    address, coordinates, presences, access and fee are left untouched.
UPDATE canonical_locations
   SET bidet_source_id = NULL,
       bidet_verification = 'unknown',
       restroom_verification = 'candidate_unverified',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE canonical_id = 'buttler_loc_a962aa157dff936ae36a';

-- 2. Enrich the surviving canonical row with the field-verified bidet/restroom
--    facts, access, and the authoritative survey source id. Name, address, and
--    coordinates are retained (unchanged); fee is retained (unchanged).
UPDATE canonical_locations
   SET restroom_presence = 'Yes',
       bidet_presence = 'Yes',
       access = 'public',
       restroom_verification = 'field_verified_via_bidet_survey',
       bidet_verification = 'field_verified',
       bidet_source_id = 'bidet_survey_2fb2f828db6b507991d2',
       source_count = 2,
       match_status = 'merge_with_restroom_record',
       match_reason = 'Stage 14K canonical identity reconciliation: merged duplicate buttler_loc_a962aa157dff936ae36a (Pulantubig Barangay Hall) into this survivor as the same physical facility; bidet and access taken from the field-verified duplicate.',
       notes = 'Stage 14K: survivor of the Pulantubig barangay-hall duplicate merge. Bidet/restroom presence, verification, and the field-survey source are retained from the merged record; address and coordinate are retained from this OSM identity. Corroborated by contrib_b31ba5e67fc346b1bf9af6ef1e41c954, contrib_415a0227f7f54258954bd6c7a20f0c16, contrib_12e2533907b44686bd357b7d654498f2.',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE canonical_id = 'buttler_loc_a7db20b50c9993d58c0e';

-- 3. Reassociate the field-survey acquisition provenance to the survivor. Its
--    original_* columns keep the merged record's original name/coordinate/
--    address, so the lineage of both sources stays auditable under one identity.
UPDATE location_provenance
   SET canonical_id = 'buttler_loc_a7db20b50c9993d58c0e'
 WHERE canonical_id = 'buttler_loc_a962aa157dff936ae36a'
   AND source_link_id = 'bidet_survey_2fb2f828db6b507991d2';

-- 4. Mark the duplicate as rejected (the schema's established suppression value:
--    /api/restrooms already filters record_status <> 'rejected'). The row is kept
--    so contributions targeting it retain a valid FK and rollback is exact.
UPDATE canonical_locations
   SET record_status = 'rejected',
       notes = 'Stage 14K: duplicate of buttler_loc_a7db20b50c9993d58c0e (Bahay Pamahalaan ng Barangay Pulantubig). Rejected as a separate active canonical record; its field-survey provenance was reassociated to the survivor. Original OSM/survey identity preserved here for audit and rollback.',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE canonical_id = 'buttler_loc_a962aa157dff936ae36a';
