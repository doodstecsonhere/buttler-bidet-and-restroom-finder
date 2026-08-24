-- Buttler's public read model for Cloudflare D1.
-- This migration contains no users, sessions, authentication, or public-write data.

CREATE TABLE restroom_locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  address TEXT,
  access TEXT NOT NULL CHECK (
    access IN (
      'public',
      'customers',
      'public/customers',
      'permissive',
      'students/public',
      'unknown'
    )
  ),
  fee TEXT NOT NULL CHECK (
    fee IN ('yes', 'no', 'unknown', 'yes (approx. 2-5 PHP)')
  ),
  has_bidet INTEGER NOT NULL DEFAULT 0 CHECK (has_bidet IN (0, 1)),
  record_status TEXT NOT NULL DEFAULT 'candidate' CHECK (
    record_status IN ('candidate', 'community-submitted', 'verified', 'disputed', 'outdated', 'rejected')
  ),
  source_kind TEXT NOT NULL DEFAULT 'owner-vetted' CHECK (
    source_kind IN ('owner-vetted', 'community', 'partner', 'imported')
  ),
  source_reference TEXT,
  verified_at TEXT CHECK (
    verified_at IS NULL OR verified_at GLOB '????-??-??T??:??:??*'
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (record_status <> 'verified' OR verified_at IS NOT NULL)
) STRICT;

CREATE INDEX idx_restroom_locations_public_filter
  ON restroom_locations (record_status, has_bidet, access);

CREATE INDEX idx_restroom_locations_coordinates
  ON restroom_locations (latitude, longitude);

CREATE INDEX idx_restroom_locations_name
  ON restroom_locations (name COLLATE NOCASE);
