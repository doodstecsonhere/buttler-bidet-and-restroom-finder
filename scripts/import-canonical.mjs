// Buttler 2.0 canonical dataset import pipeline.
//
// Reads the owner-approved canonical and provenance CSVs from attached_assets/,
// validates them, and generates deterministic D1 migration SQL. The source CSVs
// are never modified. Regenerating and re-applying the migrations upserts by
// primary key, so future dataset updates reuse the same pipeline without ever
// duplicating locations or provenance rows.
//
// Wrangler compatibility note (Stage 5C-B): before executing a migration file,
// Wrangler splits it into statements with a heuristic that treats any statement
// whose text ends with "CASE " or "BEGIN " as an open compound statement that
// only closes on "END" followed by a semicolon plus whitespace. A plain SQL
// `CASE WHEN ... END,` inside an ON CONFLICT UPDATE therefore never closes, and
// Wrangler sends the rest of the file as ONE statement, which local D1 rejects
// with `SQLITE_TOOBIG` once it passes 100,000 bytes. Every statement this
// generator emits must avoid the bare words BEGIN/CASE/END for that reason; the
// reviewed-record guard below uses COALESCE/NULLIF instead of CASE, and
// assertMigrationsAreWranglerSafe() enforces the rule together with a per-file
// size budget that also protects against a merged file exceeding the limit.
//
// Usage:
//   node scripts/import-canonical.mjs --validate   validate inputs + report
//   node scripts/import-canonical.mjs --write      refresh 0003 DDL + forward 0007_* additions (frozen 0001-0006 never rewritten)
//   node scripts/import-canonical.mjs --check      fail if committed migrations are stale

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { parseCsvRecords } from "./src/csv.mjs";

const CANONICAL_CSV = new URL("../attached_assets/buttler_locations_canonical.csv", import.meta.url);
const PROVENANCE_CSV = new URL("../attached_assets/buttler_location_provenance.csv", import.meta.url);
const MIGRATIONS_DIR = new URL("../d1/migrations/", import.meta.url);
const DDL_FILE = "0003_create_canonical_read_model.sql";
const SEED_BASE = "0004_seed_canonical_locations";
// Stage 14G: migrations 0001-0006 (including every 0004_* seed chunk) are
// already applied in production and their ledger names can never re-run, so
// they are FROZEN history. Any genuinely new canonical location arrives in a
// NEW forward migration under this prefix instead of rewriting the base.
const ADD_BASE = "0007_seed_canonical_locations_added";

// Rows per seed statement. Kept small so a single statement stays well under
// both the per-file byte budget and the 100,000 byte per-statement ceiling of
// local D1, even for the widest records.
const SEED_BATCH_ROWS = 25;
// Migration files are chunked so that even if Wrangler's splitter merged a
// whole file into one statement, the file still fits under the local D1
// per-statement ceiling (observed empirically at 100,000 bytes between
// 92,416 bytes passing and 110,851 bytes failing).
const MIGRATION_FILE_BUDGET_BYTES = 65_536;
const WRANGLER_STATEMENT_LIMIT_BYTES = 100_000;

export const REQUIRED_CANONICAL_COLUMNS = [
  "Canonical_Location_ID",
  "Name",
  "Latitude",
  "Longitude",
  "Address",
  "Restroom_Presence",
  "Bidet_Presence",
  "Access",
  "Fee",
  "Restroom_Verification",
  "Bidet_Verification",
  "Candidate_Priority",
  "Parent_Venue",
  "Source_Count",
  "Sources_JSON",
  "OSM_Type",
  "OSM_ID",
  "Bidet_Source_ID",
  "Match_Status",
  "Match_Confidence",
  "Match_Reason",
  "Last_Checked",
  "Notes",
];

export const REQUIRED_PROVENANCE_COLUMNS = [
  "Canonical_Location_ID",
  "Source_Link_ID",
  "Source_Type",
  "Source_Record_ID",
  "Evidence_Role",
  "Original_Name",
  "Original_Latitude",
  "Original_Longitude",
  "Original_Address",
  "Original_Access",
  "Original_Fee",
  "Original_Restroom_Presence",
  "Original_Bidet_Presence",
  "Verification",
  "Source_Data_JSON",
];

// Semantic domains. Unknown is a first-class value: it is never coerced to No.
const PRESENCE_DOMAIN = new Set(["Yes", "Unknown"]);
const ACCESS_DOMAIN = new Set([
  "public",
  "customers",
  "public/customers",
  "permissive",
  "students/public",
  "restricted",
  "unknown",
]);
const FEE_DOMAIN = new Set(["yes", "no", "unknown"]);
const RESTROOM_VERIFICATION_DOMAIN = new Set([
  "candidate_unverified",
  "field_verified_via_bidet_survey",
  "osm_explicit",
]);
const BIDET_VERIFICATION_DOMAIN = new Set([
  "unknown",
  "field_verified",
  "osm_explicit",
]);
const CANDIDATE_PRIORITY_DOMAIN = new Set(["", "High", "Medium", "Low"]);
const MATCH_STATUS_DOMAIN = new Set([
  "",
  "candidate_without_verified_bidet_match",
  "auto_matched_high_confidence",
  "restroom_without_verified_bidet_match",
  "unmatched_verified_bidet",
  "retain_as_distinct_restroom_unit_with_parent",
  "merge_with_restroom_record",
  "source_data_coordinate_issue",
]);
const SOURCE_TYPE_DOMAIN = new Set(["OSM", "field_survey_bidet_workbook"]);
const EVIDENCE_ROLE_DOMAIN = new Set([
  "restroom_acquisition",
  "verified_bidet_and_restroom_presence",
  "parent_venue_context",
  "same_brand_coordinate_conflict_context",
]);

// Dumaguete City sanity boundary for coordinate validation.
export const DUMAGUETE_BOUNDS = {
  minLatitude: 9.25,
  maxLatitude: 9.37,
  minLongitude: 123.24,
  maxLongitude: 123.35,
};

// Surveyed entities that must remain distinct canonical locations and must
// never collapse into their parent venues during import.
export const PROTECTED_DISTINCT_ENTITIES = [
  "La Mensa Bar Lounge",
  "Sans Rival Marina Town (Filinvest Mall)",
  "Harold's Dive Center",
  "Brain Brew",
  "Silliman University Cafeteria",
  "Silliman University College of Arts and Sciences",
  "Silliman University College of Business Administration (PWD Stalls)",
  "Silliman University Library",
  "Silliman University Senior High School Building",
];

export const EXPECTED_VERIFIED_BIDET_COUNT = 99;

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function loadCanonicalDataset({ canonicalPath = CANONICAL_CSV, provenancePath = PROVENANCE_CSV } = {}) {
  // Hash and parse the LF-normalized bytes. Git checks these CSVs out with
  // CRLF on Windows (core.autocrlf=true) but stores LF in the index, so hashing
  // the raw working-tree bytes produced a false "stale" fingerprint on Windows
  // while staying correct on Linux CI. Normalizing first makes the fingerprint
  // identical on every platform, which is what the frozen 0004_* headers and the
  // generated 0007 additions header both rely on. (Established LF-normalized
  // equivalence check; see d1/README.md and the Stage 5C-B splitter notes.)
  const canonicalText = readFileSync(canonicalPath).toString("utf8").replaceAll("\r\n", "\n");
  const provenanceText = readFileSync(provenancePath).toString("utf8").replaceAll("\r\n", "\n");
  const canonical = parseCsvRecords(canonicalText);
  const provenance = parseCsvRecords(provenanceText);
  return {
    canonical: canonical.records,
    provenance: provenance.records,
    fingerprints: {
      canonical_csv_sha256: sha256(Buffer.from(canonicalText, "utf8")),
      provenance_csv_sha256: sha256(Buffer.from(provenanceText, "utf8")),
      canonical_rows: canonical.records.length,
      provenance_rows: provenance.records.length,
    },
  };
}

function isIsoTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}

function isValidJson(value) {
  if (value === "") return true; // empty column means NULL
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

// Validates the parsed dataset and returns machine-checkable stats. Throws an
// Error listing every violation so an import fails safely instead of partially
// corrupting the read model.
export function validateDataset({ canonical, provenance }) {
  const errors = [];
  const canonicalHeader = canonical.length
    ? Object.keys(canonical[0])
    : [];
  const provenanceHeader = provenance.length
    ? Object.keys(provenance[0])
    : [];
  for (const column of REQUIRED_CANONICAL_COLUMNS) {
    if (!canonicalHeader.includes(column)) {
      errors.push(`canonical CSV is missing required column: ${column}`);
    }
  }
  for (const column of REQUIRED_PROVENANCE_COLUMNS) {
    if (!provenanceHeader.includes(column)) {
      errors.push(`provenance CSV is missing required column: ${column}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));

  const ids = new Set();
  const bidetSourceOwners = new Map();
  const osmRefs = new Map();
  let verifiedBidetCount = 0;

  for (const [index, row] of canonical.entries()) {
    const where = `canonical row ${index + 1} (${row.Canonical_Location_ID})`;
    if (!/^buttler_loc_[0-9a-f]{20}$/.test(row.Canonical_Location_ID)) {
      errors.push(`${where}: invalid Canonical_Location_ID format`);
    }
    if (ids.has(row.Canonical_Location_ID)) {
      errors.push(`${where}: duplicate Canonical_Location_ID`);
    }
    ids.add(row.Canonical_Location_ID);

    if (!row.Name.trim()) errors.push(`${where}: Name is required`);

    const latitude = Number(row.Latitude);
    const longitude = Number(row.Longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < DUMAGUETE_BOUNDS.minLatitude ||
      latitude > DUMAGUETE_BOUNDS.maxLatitude ||
      longitude < DUMAGUETE_BOUNDS.minLongitude ||
      longitude > DUMAGUETE_BOUNDS.maxLongitude
    ) {
      errors.push(`${where}: coordinates outside the Dumaguete boundary: ${row.Latitude},${row.Longitude}`);
    }

    if (!PRESENCE_DOMAIN.has(row.Restroom_Presence)) {
      errors.push(`${where}: Restroom_Presence outside domain: ${row.Restroom_Presence}`);
    }
    if (!PRESENCE_DOMAIN.has(row.Bidet_Presence)) {
      errors.push(`${where}: Bidet_Presence outside domain: ${row.Bidet_Presence}`);
    }
    if (!ACCESS_DOMAIN.has(row.Access)) {
      errors.push(`${where}: Access outside domain: ${row.Access}`);
    }
    if (!FEE_DOMAIN.has(row.Fee)) {
      errors.push(`${where}: Fee outside domain: ${row.Fee}`);
    }
    if (!RESTROOM_VERIFICATION_DOMAIN.has(row.Restroom_Verification)) {
      errors.push(`${where}: Restroom_Verification outside domain: ${row.Restroom_Verification}`);
    }
    if (!BIDET_VERIFICATION_DOMAIN.has(row.Bidet_Verification)) {
      errors.push(`${where}: Bidet_Verification outside domain: ${row.Bidet_Verification}`);
    }
    if (!CANDIDATE_PRIORITY_DOMAIN.has(row.Candidate_Priority)) {
      errors.push(`${where}: Candidate_Priority outside domain: ${row.Candidate_Priority}`);
    }
    if (!MATCH_STATUS_DOMAIN.has(row.Match_Status)) {
      errors.push(`${where}: Match_Status outside domain: ${row.Match_Status}`);
    }
    if (row.Last_Checked && !isIsoTimestamp(row.Last_Checked)) {
      errors.push(`${where}: Last_Checked is not an ISO timestamp: ${row.Last_Checked}`);
    }
    if (!isValidJson(row.Sources_JSON)) {
      errors.push(`${where}: Sources_JSON is not valid JSON`);
    }

    const sourceCount = Number(row.Source_Count);
    if (!Number.isInteger(sourceCount) || sourceCount < 1) {
      errors.push(`${where}: Source_Count must be a positive integer`);
    }

    // Surveyed identity rules: the field survey is authoritative.
    if (row.Bidet_Source_ID) {
      verifiedBidetCount += 1;
      if (row.Bidet_Presence !== "Yes") {
        errors.push(`${where}: verified bidet survey must keep Bidet_Presence=Yes`);
      }
      if (row.Restroom_Presence !== "Yes") {
        errors.push(`${where}: verified bidet survey must keep Restroom_Presence=Yes`);
      }
      if (row.Restroom_Verification !== "field_verified_via_bidet_survey") {
        errors.push(`${where}: verified bidet survey lost its field verification`);
      }
      const prior = bidetSourceOwners.get(row.Bidet_Source_ID);
      if (prior) {
        errors.push(`${where}: bidet source ${row.Bidet_Source_ID} already owned by ${prior}`);
      }
      bidetSourceOwners.set(row.Bidet_Source_ID, row.Canonical_Location_ID);
    }

    if (row.OSM_Type && row.OSM_ID) {
      const refs = row.OSM_ID.split(";").map((_, i) => `${row.OSM_Type.split(";")[i] ?? row.OSM_Type}/${row.OSM_ID.split(";")[i] ?? _}`);
      for (const ref of refs) {
        const prior = osmRefs.get(ref);
        if (prior && prior !== row.Canonical_Location_ID) {
          errors.push(`${where}: OSM reference ${ref} shared with ${prior}`);
        }
        osmRefs.set(ref, row.Canonical_Location_ID);
      }
    }
  }

  if (verifiedBidetCount !== EXPECTED_VERIFIED_BIDET_COUNT) {
    errors.push(`expected ${EXPECTED_VERIFIED_BIDET_COUNT} verified bidet records, found ${verifiedBidetCount}`);
  }

  for (const entity of PROTECTED_DISTINCT_ENTITIES) {
    const matches = canonical.filter((row) => row.Name === entity);
    if (matches.length !== 1) {
      errors.push(`protected distinct entity "${entity}" appears ${matches.length} times (expected exactly 1)`);
    }
  }

  const provenancePairs = new Set();
  const provenanceCountByLocation = new Map();
  for (const [index, row] of provenance.entries()) {
    const where = `provenance row ${index + 1}`;
    if (!ids.has(row.Canonical_Location_ID)) {
      errors.push(`${where}: orphaned Canonical_Location_ID ${row.Canonical_Location_ID}`);
    }
    const pair = `${row.Canonical_Location_ID}|${row.Source_Link_ID}`;
    if (provenancePairs.has(pair)) {
      errors.push(`${where}: duplicate provenance link ${pair}`);
    }
    provenancePairs.add(pair);
    provenanceCountByLocation.set(
      row.Canonical_Location_ID,
      (provenanceCountByLocation.get(row.Canonical_Location_ID) ?? 0) + 1,
    );
    if (!SOURCE_TYPE_DOMAIN.has(row.Source_Type)) {
      errors.push(`${where}: Source_Type outside domain: ${row.Source_Type}`);
    }
    if (!EVIDENCE_ROLE_DOMAIN.has(row.Evidence_Role)) {
      errors.push(`${where}: Evidence_Role outside domain: ${row.Evidence_Role}`);
    }
    if (!row.Source_Record_ID) {
      errors.push(`${where}: Source_Record_ID is required`);
    }
    if (!isValidJson(row.Source_Data_JSON)) {
      errors.push(`${where}: Source_Data_JSON is not valid JSON`);
    }
    for (const column of ["Original_Latitude", "Original_Longitude"]) {
      if (row[column] !== "") {
        const value = Number(row[column]);
        if (!Number.isFinite(value)) {
          errors.push(`${where}: ${column} is not numeric: ${row[column]}`);
        }
      }
    }
  }

  for (const row of canonical) {
    const actual = provenanceCountByLocation.get(row.Canonical_Location_ID) ?? 0;
    if (actual !== Number(row.Source_Count)) {
      errors.push(`canonical ${row.Canonical_Location_ID}: Source_Count=${row.Source_Count} but provenance has ${actual} rows`);
    }
  }

  const surveyProvenance = provenance.filter(
    (row) => row.Source_Type === "field_survey_bidet_workbook",
  );
  if (surveyProvenance.length !== EXPECTED_VERIFIED_BIDET_COUNT) {
    errors.push(`expected ${EXPECTED_VERIFIED_BIDET_COUNT} survey provenance rows, found ${surveyProvenance.length}`);
  }
  for (const row of surveyProvenance) {
    const target = canonical.find((c) => c.Canonical_Location_ID === row.Canonical_Location_ID);
    if (!target || target.Bidet_Source_ID !== row.Source_Record_ID) {
      errors.push(`provenance survey link ${row.Source_Record_ID} does not agree with its canonical record`);
    }
  }

  if (errors.length) {
    throw new Error(`Canonical dataset validation failed:\n${errors.join("\n")}`);
  }

  return {
    canonical_rows: canonical.length,
    provenance_rows: provenance.length,
    verified_bidet_records: verifiedBidetCount,
    unique_canonical_ids: ids.size,
    protected_entities_present: PROTECTED_DISTINCT_ENTITIES.length,
    provenance_orphans: 0,
    source_count_mismatches: 0,
    duplicate_provenance_links: 0,
  };
}

function sqlLiteral(value) {
  return value === null || value === undefined || value === ""
    ? "NULL"
    : `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  return value === "" ? "NULL" : String(Number(value));
}

const CANONICAL_COLUMNS = [
  "canonical_id", "name", "latitude", "longitude", "address",
  "restroom_presence", "bidet_presence", "access", "fee",
  "restroom_verification", "bidet_verification", "candidate_priority",
  "parent_venue", "source_count", "osm_type", "osm_id",
  "bidet_source_id", "match_status", "match_confidence", "match_reason",
  "last_checked", "notes",
];

function canonicalRowSql(row) {
  return `(${[
    sqlLiteral(row.Canonical_Location_ID),
    "'candidate'",
    sqlLiteral(row.Name),
    sqlNumber(row.Latitude),
    sqlNumber(row.Longitude),
    sqlLiteral(row.Address),
    sqlLiteral(row.Restroom_Presence),
    sqlLiteral(row.Bidet_Presence),
    sqlLiteral(row.Access),
    sqlLiteral(row.Fee),
    sqlLiteral(row.Restroom_Verification),
    sqlLiteral(row.Bidet_Verification),
    sqlLiteral(row.Candidate_Priority),
    sqlLiteral(row.Parent_Venue),
    sqlNumber(row.Source_Count),
    sqlLiteral(row.OSM_Type),
    sqlLiteral(row.OSM_ID),
    sqlLiteral(row.Bidet_Source_ID),
    sqlLiteral(row.Match_Status),
    sqlLiteral(row.Match_Confidence),
    sqlLiteral(row.Match_Reason),
    sqlLiteral(row.Last_Checked),
    sqlLiteral(row.Notes),
  ].join(", ")})`;
}

const PROVENANCE_COLUMNS = [
  "canonical_id", "source_link_id", "source_type", "source_record_id",
  "evidence_role", "original_name", "original_latitude", "original_longitude",
  "original_address", "original_access", "original_fee",
  "original_restroom_presence", "original_bidet_presence", "verification",
  "source_data_json",
];

function provenanceRowSql(row) {
  return `(${[
    sqlLiteral(row.Canonical_Location_ID),
    sqlLiteral(row.Source_Link_ID),
    sqlLiteral(row.Source_Type),
    sqlLiteral(row.Source_Record_ID),
    sqlLiteral(row.Evidence_Role),
    sqlLiteral(row.Original_Name),
    sqlNumber(row.Original_Latitude),
    sqlNumber(row.Original_Longitude),
    sqlLiteral(row.Original_Address),
    sqlLiteral(row.Original_Access),
    sqlLiteral(row.Original_Fee),
    sqlLiteral(row.Original_Restroom_Presence),
    sqlLiteral(row.Original_Bidet_Presence),
    sqlLiteral(row.Verification),
    sqlLiteral(row.Source_Data_JSON),
  ].join(", ")})`;
}

export function generateCanonicalDdlSql() {
  return `-- Buttler 2.0 canonical read model for Cloudflare D1.
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
`;
}

export function generateCanonicalSeedSql(canonical, provenance, fingerprints) {
  const byId = [...canonical].sort((a, b) =>
    a.Canonical_Location_ID < b.Canonical_Location_ID ? -1 : 1,
  );
  const provSorted = [...provenance].sort((a, b) => {
    const left = `${a.Canonical_Location_ID}|${a.Source_Link_ID}`;
    const right = `${b.Canonical_Location_ID}|${b.Source_Link_ID}`;
    return left < right ? -1 : 1;
  });

  const header = [
    "-- Generated by scripts/import-canonical.mjs from the owner-approved",
    "-- canonical dataset; do not edit by hand.",
    `-- canonical_csv_sha256=${fingerprints.canonical_csv_sha256}`,
    `-- provenance_csv_sha256=${fingerprints.provenance_csv_sha256}`,
    `-- canonical_rows=${fingerprints.canonical_rows}`,
    `-- provenance_rows=${fingerprints.provenance_rows}`,
    "-- Re-importing upserts by primary key: no duplicate locations, and",
    "-- reviewed backend edits are only overwritten by the next approved dataset.",
    "-- reviewed record_status is preserved via COALESCE/NULLIF rather than CASE",
    "-- WHEN, because Wrangler's SQL splitter treats a trailing `CASE ` as an",
    "-- unclosed compound statement and merges the rest of the file into one",
    "-- statement that local D1 then rejects with SQLITE_TOOBIG.",
    "",
  ].join("\n");

  const statements = [];
  for (let index = 0; index < byId.length; index += SEED_BATCH_ROWS) {
    const batch = byId.slice(index, index + SEED_BATCH_ROWS);
    statements.push(
      [
        `INSERT INTO canonical_locations (\n  ${[CANONICAL_COLUMNS[0], "record_status", ...CANONICAL_COLUMNS.slice(1)].join(", ")}\n) VALUES`,
        batch.map(canonicalRowSql).join(",\n"),
        "ON CONFLICT(canonical_id) DO UPDATE SET\n  " +
          CANONICAL_COLUMNS.slice(1)
            .map((column) => `${column} = excluded.${column}`)
            .join(",\n  ") +
          ",\n  record_status = COALESCE(NULLIF(CAST(canonical_locations.record_status AS TEXT), 'candidate'), excluded.record_status),\n  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');",
      ].join("\n"),
    );
  }
  for (let index = 0; index < provSorted.length; index += SEED_BATCH_ROWS) {
    const batch = provSorted.slice(index, index + SEED_BATCH_ROWS);
    statements.push(
      [
        `INSERT INTO location_provenance (\n  ${PROVENANCE_COLUMNS.join(", ")}\n) VALUES`,
        batch.map(provenanceRowSql).join(",\n"),
        "ON CONFLICT(canonical_id, source_link_id) DO UPDATE SET\n  " +
          PROVENANCE_COLUMNS.slice(1)
            .map((column) => `${column} = excluded.${column}`)
            .join(",\n  ") + ";",
      ].join("\n"),
    );
  }

  // Chunk the statements into ordered files by packing each file up to the byte
  // budget. Packing by accumulated bytes (not a fixed statement count) matters
  // because statements have unequal sizes: rounding a statement count could put
  // two ~64 KB statements into one file and exceed the per-statement ceiling if
  // Wrangler ever merged them. Locations always precede their provenance links,
  // so any prefix of the sequence stays applyable in order against the FKs. A
  // single statement larger than the budget still gets its own file (assert
  // catches it if that alone breaks the ceiling).
  const chunks = [];
  let current = [];
  for (const statement of statements) {
    const candidate = [...current, statement];
    const candidateSql = `${header}\n${candidate.join("\n\n")}\n`;
    if (
      current.length > 0 &&
      Buffer.byteLength(candidateSql) > MIGRATION_FILE_BUDGET_BYTES
    ) {
      chunks.push(current);
      current = [statement];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  const files = chunks.map((chunk, index) => {
    const suffix = chunks.length === 1 ? "" : `_${String(index + 1).padStart(2, "0")}`;
    return {
      file: `${SEED_BASE}${suffix}.sql`,
      sql: `${header}\n${chunk.join("\n\n")}\n`,
    };
  });
  return files;
}

// The set of canonical ids already carried by the committed, already-applied
// 0004_* seed chunks. That set is the frozen cutover base: every one of those
// names is in the production d1_migrations ledger and can never run again, so
// the generator must never rewrite those files. New places are the CSV rows
// whose id is NOT in this set.
export function listCommittedSeedCanonicalIds(dir = fileURLToPath(MIGRATIONS_DIR)) {
  const ids = new Set();
  for (const name of readdirSync(dir)) {
    if (!isSeedMigrationFile(name)) continue;
    const sql = readFileSync(resolve(dir, name), "utf8");
    for (const match of sql.matchAll(/buttler_loc_[0-9a-f]{20}/g)) {
      ids.add(match[0]);
    }
  }
  return ids;
}

// Splits the full CSV into the frozen base (ids already seeded in 0004) and the
// post-cutover additions that must go into a new forward migration.
export function splitBaseAndAdditions(canonical, provenance, baseIds) {
  const canonicalAdditions = canonical.filter(
    (row) => !baseIds.has(row.Canonical_Location_ID),
  );
  const provenanceAdditions = provenance.filter(
    (row) => !baseIds.has(row.Canonical_Location_ID),
  );
  return { canonicalAdditions, provenanceAdditions };
}

// Mirrors generateCanonicalSeedSql's statement builders and upsert semantics
// exactly, but writes to the ADD_BASE prefix and always uses a two-digit chunk
// suffix (0007_seed_canonical_locations_added_01.sql). Idempotent upsert by
// primary key, canonical rows emitted before their provenance links (FK order),
// and the same Wrangler-safe (no bare BEGIN/CASE/END) COALESCE/NULLIF guard.
export function generateAdditionsSql(canonicalAdditions, provenanceAdditions, fingerprints) {
  if (canonicalAdditions.length === 0 && provenanceAdditions.length === 0) {
    return [];
  }
  const byId = [...canonicalAdditions].sort((a, b) =>
    a.Canonical_Location_ID < b.Canonical_Location_ID ? -1 : 1,
  );
  const provSorted = [...provenanceAdditions].sort((a, b) => {
    const left = `${a.Canonical_Location_ID}|${a.Source_Link_ID}`;
    const right = `${b.Canonical_Location_ID}|${b.Source_Link_ID}`;
    return left < right ? -1 : 1;
  });

  const header = [
    "-- Generated by scripts/import-canonical.mjs from the owner-approved",
    "-- canonical dataset; do not edit by hand.",
    "-- Stage 14G post-cutover additions: this forward migration adds ONLY",
    "-- canonical rows whose id is absent from the frozen 0004_* seed, because",
    "-- 0001-0006 are already recorded in the production migration ledger and",
    "-- their file names can never re-run. Re-applying upserts by primary key.",
    `-- canonical_csv_sha256=${fingerprints.canonical_csv_sha256}`,
    `-- provenance_csv_sha256=${fingerprints.provenance_csv_sha256}`,
    `-- additions_canonical_rows=${canonicalAdditions.length}`,
    `-- additions_provenance_rows=${provenanceAdditions.length}`,
    "-- reviewed record_status is preserved via COALESCE/NULLIF rather than CASE",
    "-- WHEN, because Wrangler's SQL splitter treats a trailing `CASE ` as an",
    "-- unclosed compound statement and merges the rest of the file into one",
    "-- statement that local D1 then rejects with SQLITE_TOOBIG.",
    "",
  ].join("\n");

  const statements = [];
  for (let index = 0; index < byId.length; index += SEED_BATCH_ROWS) {
    const batch = byId.slice(index, index + SEED_BATCH_ROWS);
    statements.push(
      [
        `INSERT INTO canonical_locations (\n  ${[CANONICAL_COLUMNS[0], "record_status", ...CANONICAL_COLUMNS.slice(1)].join(", ")}\n) VALUES`,
        batch.map(canonicalRowSql).join(",\n"),
        "ON CONFLICT(canonical_id) DO UPDATE SET\n  " +
          CANONICAL_COLUMNS.slice(1)
            .map((column) => `${column} = excluded.${column}`)
            .join(",\n  ") +
          ",\n  record_status = COALESCE(NULLIF(CAST(canonical_locations.record_status AS TEXT), 'candidate'), excluded.record_status),\n  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');",
      ].join("\n"),
    );
  }
  for (let index = 0; index < provSorted.length; index += SEED_BATCH_ROWS) {
    const batch = provSorted.slice(index, index + SEED_BATCH_ROWS);
    statements.push(
      [
        `INSERT INTO location_provenance (\n  ${PROVENANCE_COLUMNS.join(", ")}\n) VALUES`,
        batch.map(provenanceRowSql).join(",\n"),
        "ON CONFLICT(canonical_id, source_link_id) DO UPDATE SET\n  " +
          PROVENANCE_COLUMNS.slice(1)
            .map((column) => `${column} = excluded.${column}`)
            .join(",\n  ") + ";",
      ].join("\n"),
    );
  }

  const chunks = [];
  let current = [];
  for (const statement of statements) {
    const candidate = [...current, statement];
    const candidateSql = `${header}\n${candidate.join("\n\n")}\n`;
    if (
      current.length > 0 &&
      Buffer.byteLength(candidateSql) > MIGRATION_FILE_BUDGET_BYTES
    ) {
      chunks.push(current);
      current = [statement];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((chunk, index) => ({
    file: `${ADD_BASE}_${String(index + 1).padStart(2, "0")}.sql`,
    sql: `${header}\n${chunk.join("\n\n")}\n`,
  }));
}

// ---- Faithful port of Wrangler's D1 SQL splitter (src/d1/splitter.ts +
// trimmer.ts) so migration-safety assertions match exactly what
// `wrangler d1 migrations apply` does. It strips `--` line comments and
// consumes quoted strings atomically, so only bare BEGIN/CASE/END tokens in
// real SQL open a compound statement. A test compares this against Wrangler's
// own exported unstable_splitSqlQuery to keep the two in sync.
function wranglerMayContainTransaction(sql) {
  return sql.includes("BEGIN TRANSACTION");
}
function wranglerTrimSqlQuery(sql) {
  if (!wranglerMayContainTransaction(sql)) return sql;
  return sql.replace("BEGIN TRANSACTION;", "").replace("COMMIT;", "");
}
function wranglerMayContainMultipleStatements(sql) {
  const trimmed = sql.trimEnd();
  const semiColonIndex = trimmed.indexOf(";");
  return semiColonIndex !== -1 && semiColonIndex !== trimmed.length - 1;
}
function wranglerIsCompoundStatementStart(str) {
  return /\s(BEGIN|CASE)\s$/i.test(str);
}
function wranglerIsCompoundStatementEnd(str) {
  return /\sEND[;\s]$/i.test(str);
}
function wranglerIsDollarQuoteIdentifier(str) {
  const lastChar = str.slice(-1);
  return (
    lastChar !== "$" &&
    (/[0-9_]/i.test(lastChar) || lastChar.toLowerCase() !== lastChar.toUpperCase())
  );
}
function wranglerConsumeWhile(iterator, predicate, window = 16) {
  let next = iterator.next();
  let str = "";
  let tail = "";
  while (!next.done) {
    str += next.value;
    tail = (tail + next.value).slice(-window);
    if (!predicate(tail)) break;
    next = iterator.next();
  }
  return str;
}
function wranglerConsumeUntilMarker(iterator, endMarker) {
  return wranglerConsumeWhile(iterator, (str) => !str.endsWith(endMarker), endMarker.length);
}
function wranglerSplitIntoStatements(sql) {
  const statements = [];
  let str = "";
  const compoundStatementStack = [];
  const iterator = sql[Symbol.iterator]();
  let next = iterator.next();
  while (!next.done) {
    const char = next.value;
    if (compoundStatementStack[0]?.(str + char)) {
      compoundStatementStack.shift();
    }
    switch (char) {
      case "'":
      case '"':
      case "`":
        str += char + wranglerConsumeUntilMarker(iterator, char);
        break;
      case "$": {
        const dollarQuote = "$" + wranglerConsumeWhile(iterator, wranglerIsDollarQuoteIdentifier);
        str += dollarQuote;
        if (dollarQuote.endsWith("$")) {
          str += wranglerConsumeUntilMarker(iterator, dollarQuote);
        }
        break;
      }
      case "-":
        next = iterator.next();
        if (!next.done && next.value === "-") {
          wranglerConsumeUntilMarker(iterator, "\n");
          str += "\n";
          break;
        } else {
          str += char;
          continue;
        }
      case "/":
        next = iterator.next();
        if (!next.done && next.value === "*") {
          wranglerConsumeUntilMarker(iterator, "*/");
          break;
        } else {
          str += char;
          continue;
        }
      case ";":
        if (compoundStatementStack.length === 0) {
          statements.push(str);
          str = "";
        } else {
          str += char;
        }
        break;
      default:
        str += char;
        break;
    }
    if (wranglerIsCompoundStatementStart(str)) {
      compoundStatementStack.unshift(wranglerIsCompoundStatementEnd);
    }
    next = iterator.next();
  }
  statements.push(str);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
export function wranglerSplitSql(sql) {
  const trimmedSql = wranglerTrimSqlQuery(sql);
  if (!wranglerMayContainMultipleStatements(trimmedSql)) {
    return [trimmedSql];
  }
  const split = wranglerSplitIntoStatements(trimmedSql);
  return split.length === 0 ? [trimmedSql] : split;
}

// Fails at generation time if Wrangler's real splitter would produce any single
// statement larger than local D1's per-statement ceiling. That is precisely the
// condition behind SQLITE_TOOBIG: a bare BEGIN/CASE/END token merges the rest of
// a file into one statement. Checking the split output (not a text scan) avoids
// false alarms on the words CASE/END inside comments or string values.
export function assertMigrationsAreWranglerSafe(files) {
  const errors = [];
  for (const { file, sql } of files) {
    const statements = wranglerSplitSql(sql);
    if (statements.length === 0) {
      errors.push(`${file}: produced no statements`);
      continue;
    }
    for (const [index, statement] of statements.entries()) {
      const bytes = Buffer.byteLength(statement);
      if (bytes > WRANGLER_STATEMENT_LIMIT_BYTES) {
        errors.push(
          `${file}: statement ${index + 1} is ${bytes} bytes (> ${WRANGLER_STATEMENT_LIMIT_BYTES}) and would hit SQLITE_TOOBIG; Wrangler merged ${statements.length} statement(s) into it — look for a bare BEGIN/CASE/END token outside a string or comment`,
        );
      }
    }
  }
  if (errors.length) {
    throw new Error(`Wrangler migration safety check failed:\n${[...new Set(errors)].join("\n")}`);
  }
}

// The exact set of seed migration files the generator would write, so tests
// and cleanup never have to hard-code the chunk count.
export function listCanonicalMigrationFiles(files) {
  return [DDL_FILE, ...files.map(({ file }) => file)];
}

function migrationSqlExists(dir, filename) {
  return readdirSync(dir).some((name) => name === filename);
}

const mode = process.argv[2];
// Only act as a CLI when this file is the entry point. Importers such as
// scripts/generate-bundled-catalogue.mjs and the tests share flags like
// --write, and must never trigger a migration rewrite as a side effect.
const isEntry =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function isSeedMigrationFile(name) {
  return name.startsWith(`${SEED_BASE}`) && name.endsWith(".sql");
}

function isAdditionsMigrationFile(name) {
  return name.startsWith(`${ADD_BASE}`) && name.endsWith(".sql");
}

if (isEntry && (mode === "--validate" || mode === "--write" || mode === "--check")) {
  const dataset = loadCanonicalDataset();
  const stats = validateDataset(dataset);
  const ddlSql = generateCanonicalDdlSql();
  const migrationsDirPath = fileURLToPath(MIGRATIONS_DIR);

  // The committed 0004_* seed defines the frozen cutover base. When it exists,
  // --write and --check must never regenerate it from the (now larger) CSV, or
  // they would rewrite applied migration history. When no base is on disk yet
  // (a fresh from-scratch bootstrap) the whole CSV seeds 0004 as before.
  const baseIds = listCommittedSeedCanonicalIds(migrationsDirPath);
  const baseExists = baseIds.size > 0;
  const { canonicalAdditions, provenanceAdditions } = splitBaseAndAdditions(
    dataset.canonical,
    dataset.provenance,
    baseIds,
  );
  const additionFiles = generateAdditionsSql(
    canonicalAdditions,
    provenanceAdditions,
    dataset.fingerprints,
  );
  // In a bootstrap the additions ARE the whole dataset, emitted as 0004.
  const baseSeedFiles = baseExists
    ? null
    : generateCanonicalSeedSql(
        dataset.canonical,
        dataset.provenance,
        dataset.fingerprints,
      );
  const filesToSafetyCheck = [
    ...(baseSeedFiles ?? []),
    ...additionFiles,
  ];

  // Guard: a frozen base id that has vanished from the CSV would silently drop
  // production history on the next bootstrap, so refuse loudly instead.
  const csvIdSet = new Set(
    dataset.canonical.map((row) => row.Canonical_Location_ID),
  );
  const droppedBaseIds = [...baseIds].filter((id) => !csvIdSet.has(id));

  if (mode === "--validate") {
    assertMigrationsAreWranglerSafe(filesToSafetyCheck);
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...dataset.fingerprints,
          ...stats,
          frozen_base_canonical_ids: baseIds.size,
          additions_canonical_rows: canonicalAdditions.length,
          additions_provenance_rows: provenanceAdditions.length,
          base_files: baseExists ? null : (baseSeedFiles ?? []).map(({ file }) => file),
          addition_files: additionFiles.map(({ file }) => file),
        },
        null,
        2,
      ),
    );
  } else if (mode === "--write") {
    if (droppedBaseIds.length) {
      throw new Error(
        `Refusing to write: frozen base canonical ids are missing from the CSV (${droppedBaseIds.join(", ")}). Restoring the base rows is a separate, reviewed action.`,
      );
    }
    assertMigrationsAreWranglerSafe(filesToSafetyCheck);
    // 0003 DDL is deterministic and CSV-independent; keep it current.
    writeFileSync(new URL(DDL_FILE, MIGRATIONS_DIR), ddlSql, "utf8");
    if (!baseExists) {
      // Fresh bootstrap: seed the entire dataset into 0004 (original behaviour).
      const expectedBase = new Set(baseSeedFiles.map(({ file }) => file));
      for (const { file, sql } of baseSeedFiles) {
        writeFileSync(new URL(file, MIGRATIONS_DIR), sql, "utf8");
      }
      for (const name of readdirSync(migrationsDirPath)) {
        if (isSeedMigrationFile(name) && !expectedBase.has(name)) {
          rmSync(new URL(name, MIGRATIONS_DIR));
        }
      }
    }
    // Post-cutover additions go into the new forward migration(s). The frozen
    // 0004_* files are never rewritten.
    const expectedAdd = new Set(additionFiles.map(({ file }) => file));
    for (const { file, sql } of additionFiles) {
      writeFileSync(new URL(file, MIGRATIONS_DIR), sql, "utf8");
    }
    for (const name of readdirSync(migrationsDirPath)) {
      if (isAdditionsMigrationFile(name) && !expectedAdd.has(name)) {
        rmSync(new URL(name, MIGRATIONS_DIR));
      }
    }
    console.log(
      `CANONICAL_MIGRATIONS_WRITTEN canonical_rows=${dataset.canonical.length} provenance_rows=${dataset.provenance.length} frozen_base=${baseIds.size} additions_canonical=${canonicalAdditions.length} additions_provenance=${provenanceAdditions.length} addition_files=${additionFiles.map(({ file }) => file).join(",")}`,
    );
  } else {
    assertMigrationsAreWranglerSafe(filesToSafetyCheck);
    const problems = [];
    if (droppedBaseIds.length) {
      problems.push(`frozen base canonical ids missing from CSV: ${droppedBaseIds.join(", ")}`);
    }
    const currentDdl = migrationSqlExists(migrationsDirPath, DDL_FILE)
      ? readFileSync(new URL(DDL_FILE, MIGRATIONS_DIR), "utf8").replaceAll("\r\n", "\n")
      : "";
    if (currentDdl !== ddlSql) problems.push(`${DDL_FILE}: content differs from generated DDL`);

    if (!baseExists) {
      // Bootstrap check: regenerate 0004 from the full CSV and compare.
      const expected = new Set(baseSeedFiles.map(({ file }) => file));
      for (const { file, sql } of baseSeedFiles) {
        const current = migrationSqlExists(migrationsDirPath, file)
          ? readFileSync(new URL(file, MIGRATIONS_DIR), "utf8").replaceAll("\r\n", "\n")
          : null;
        if (current === null) problems.push(`${file}: missing`);
        else if (current !== sql) problems.push(`${file}: content differs from generated seed`);
      }
      for (const name of readdirSync(migrationsDirPath)) {
        if (isSeedMigrationFile(name) && !expected.has(name)) {
          problems.push(`${name}: unexpected stale seed migration`);
        }
      }
    } else {
      // Frozen-base check: the base files are applied history; only confirm they
      // are still present and that no CSV row leaked into them.
      const onDiskBase = readdirSync(migrationsDirPath).filter(isSeedMigrationFile);
      if (onDiskBase.length === 0) problems.push("no committed 0004_* seed found to anchor the frozen base");
    }

    // Additions check: generated forward migration(s) must match what is on disk.
    const expectedAdd = new Set(additionFiles.map(({ file }) => file));
    for (const { file, sql } of additionFiles) {
      const current = migrationSqlExists(migrationsDirPath, file)
        ? readFileSync(new URL(file, MIGRATIONS_DIR), "utf8").replaceAll("\r\n", "\n")
        : null;
      if (current === null) problems.push(`${file}: missing`);
      else if (current !== sql) problems.push(`${file}: content differs from generated additions`);
    }
    for (const name of readdirSync(migrationsDirPath)) {
      if (isAdditionsMigrationFile(name) && !expectedAdd.has(name)) {
        problems.push(`${name}: unexpected stale additions migration`);
      }
    }

    if (problems.length) {
      throw new Error(
        `Canonical D1 migrations are stale; run: node scripts/import-canonical.mjs --write\n${problems.join("\n")}`,
      );
    }
    console.log(
      `CANONICAL_MIGRATIONS_CURRENT canonical_rows=${dataset.canonical.length} provenance_rows=${dataset.provenance.length} frozen_base=${baseIds.size} additions_canonical=${canonicalAdditions.length} addition_files=${additionFiles.map(({ file }) => file).join(",")}`,
    );
  }
} else if (isEntry) {
  throw new Error("Use --validate, --write, or --check");
}
