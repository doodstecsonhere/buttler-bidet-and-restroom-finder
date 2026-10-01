-- Buttler 2.0 — Stage 13 contribution schema (STAGED, not yet applied).
--
-- This file lives in `d1/contributions/`, NOT `d1/migrations/`, ON PURPOSE:
--   * The committed guard `scripts/d1-schema.test.mjs` asserts that applying
--     everything in `d1/migrations/` yields exactly three tables — a deliberate
--     "community contributions are disabled until auth/authz/abuse/moderation
--     are separately approved" invariant (see d1/README.md). Moving this file
--     into the auto-applied directory would pre-empt that approval and break
--     the guard.
--   * Contributions cannot go live without an approved authentication provider
--     (docs/stage13-moderation-operations.md). Until then this schema stays
--     staged and inert.
--
-- When the owner approves enabling contributions, the promotion is a two-part,
-- separately-approved action:
--   1. move/copy this file into `d1/migrations/` and update
--      `scripts/d1-schema.test.mjs` to the new expected table set, and
--   2. apply it to the real database ONLY after backing up and testing the
--      rollback on a disposable database (never `--force`).
--
-- It is strictly ADDITIVE: creates two new tables and their indexes only. It
-- does not touch canonical_locations, location_provenance, the legacy
-- restroom_locations table, the 776 canonical records, or the 845 provenance
-- links. The sole foreign key INTO canonical data (target_canonical_id) is a
-- read-only reference; nothing here can write a canonical row.

CREATE TABLE contributions (
  contribution_id     TEXT PRIMARY KEY CHECK (length(contribution_id) BETWEEN 8 AND 64),
  kind                TEXT NOT NULL CHECK (
    kind IN ('problem_report','closure_report','info_correction','access_update',
             'fee_update','bidet_report','reverification','new_location')),
  target_canonical_id TEXT REFERENCES canonical_locations(canonical_id),
  contributor_user_id TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','validated','needs_review','approved','rejected',
               'withdrawn','superseded')),
  validation_status   TEXT NOT NULL DEFAULT 'not_validated' CHECK (
    validation_status IN ('not_validated','passed','failed')),
  payload_json        TEXT NOT NULL CHECK (json_valid(payload_json)),
  evidence_json       TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  notes               TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  validation_result_json TEXT CHECK (validation_result_json IS NULL OR json_valid(validation_result_json)),
  moderation_note     TEXT CHECK (moderation_note IS NULL OR length(moderation_note) <= 2000),
  submitted_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at          TEXT,
  decided_by          TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- new_location must not point at a canonical row; every other kind must.
  CHECK (
    (kind = 'new_location' AND target_canonical_id IS NULL)
    OR (kind <> 'new_location' AND target_canonical_id IS NOT NULL)
  ),
  -- Terminal decision states must carry a decision timestamp; non-terminal must not.
  CHECK (
    (status IN ('approved','rejected','superseded','withdrawn') AND decided_at IS NOT NULL)
    OR (status NOT IN ('approved','rejected','superseded','withdrawn') AND decided_at IS NULL)
  )
) STRICT;

CREATE INDEX idx_contributions_status ON contributions (status, submitted_at);
CREATE INDEX idx_contributions_target ON contributions (target_canonical_id);
CREATE INDEX idx_contributions_contributor ON contributions (contributor_user_id);
CREATE INDEX idx_contributions_open_by_target
  ON contributions (target_canonical_id, kind)
  WHERE status IN ('pending','validated','needs_review');

CREATE TABLE contribution_events (
  event_id        TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 8 AND 64),
  contribution_id TEXT NOT NULL REFERENCES contributions(contribution_id),
  event_type      TEXT NOT NULL CHECK (
    event_type IN ('submitted','validated','flagged','status_change',
                   'comment','moderation_decision','withdrawn','superseded')),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('system','contributor','moderator')),
  actor_id        TEXT,
  from_status     TEXT,
  to_status       TEXT,
  detail_json     TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_contribution_events_contribution
  ON contribution_events (contribution_id, created_at);
