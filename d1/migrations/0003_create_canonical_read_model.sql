-- Buttler 2.0 canonical read model for Cloudflare D1.
-- Generated structure companion of scripts/import-canonical.mjs; keep both in sync.
-- This migration contains no users, sessions, authentication, or public-write data.

CREATE TABLE canonical_locations (
  canonical_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  address TEXT,
  restroom_presence TEXT NOT NULL CHECK (restroom_presence IN ('Yes', 'Unknown')),
  bidet_presence TEXT NOT NULL CHECK (bidet_presence IN ('Yes', 'Unknown')),
  access TEXT NOT NULL CHECK (
    access IN (
      'public', 'customers', 'public/customers', 'permissive',
      'students/public', 'restricted', 'unknown'
    )
  ),
  fee TEXT NOT NULL CHECK (fee IN ('yes', 'no', 'unknown')),
  restroom_verification TEXT NOT NULL CHECK (
    restroom_verification IN (
      'candidate_unverified', 'field_verified_via_bidet_survey', 'osm_explicit'
    )
  ),
  bidet_verification TEXT NOT NULL CHECK (
    bidet_verification IN ('unknown', 'field_verified', 'osm_explicit')
  ),
  candidate_priority TEXT CHECK (
    candidate_priority IS NULL OR candidate_priority IN ('High', 'Medium', 'Low')
  ),
  parent_venue TEXT,
  source_count INTEGER NOT NULL CHECK (source_count >= 1),
  osm_type TEXT,
  osm_id TEXT,
  bidet_source_id TEXT,
  match_status TEXT CHECK (
    match_status IS NULL OR match_status IN (
      'candidate_without_verified_bidet_match',
      'auto_matched_high_confidence',
      'restroom_without_verified_bidet_match',
      'unmatched_verified_bidet',
      'retain_as_distinct_restroom_unit_with_parent',
      'merge_with_restroom_record',
      'source_data_coordinate_issue'
    )
  ),
  match_confidence TEXT,
  match_reason TEXT,
  last_checked TEXT CHECK (
    last_checked IS NULL OR last_checked GLOB '????-??-??T??:??:??*'
  ),
  notes TEXT,
  record_status TEXT NOT NULL DEFAULT 'candidate' CHECK (
    record_status IN ('candidate', 'community-submitted', 'verified', 'disputed', 'outdated', 'rejected')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Field-surveyed identity may never be downgraded inside the read model.
  CHECK (
    bidet_source_id IS NULL
    OR (bidet_presence = 'Yes' AND restroom_presence = 'Yes')
  )
) STRICT;

CREATE UNIQUE INDEX idx_canonical_locations_bidet_source
  ON canonical_locations (bidet_source_id)
  WHERE bidet_source_id IS NOT NULL;

CREATE INDEX idx_canonical_locations_public_filter
  ON canonical_locations (record_status, bidet_presence, access);

CREATE INDEX idx_canonical_locations_coordinates
  ON canonical_locations (latitude, longitude);

CREATE INDEX idx_canonical_locations_name
  ON canonical_locations (name COLLATE NOCASE);

CREATE TABLE location_provenance (
  canonical_id TEXT NOT NULL REFERENCES canonical_locations(canonical_id),
  source_link_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('OSM', 'field_survey_bidet_workbook')
  ),
  source_record_id TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK (
    evidence_role IN (
      'restroom_acquisition',
      'verified_bidet_and_restroom_presence',
      'parent_venue_context',
      'same_brand_coordinate_conflict_context'
    )
  ),
  original_name TEXT,
  original_latitude REAL,
  original_longitude REAL,
  original_address TEXT,
  original_access TEXT,
  original_fee TEXT,
  original_restroom_presence TEXT,
  original_bidet_presence TEXT,
  verification TEXT,
  source_data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (canonical_id, source_link_id)
) STRICT;

CREATE INDEX idx_location_provenance_source_record
  ON location_provenance (source_type, source_record_id);
