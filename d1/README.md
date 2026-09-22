# Cloudflare D1 foundation

This directory holds Buttler's public, read-only data layer: the ordered D1
migrations that structure the production database behind
`https://buttler.pages.dev/api/restrooms`. Applying migrations to the shared
production database remains a separately approved operation; nothing here
provisions Cloudflare resources or enables public writes.

## Model boundary

Migrations `0001`/`0002` create and seed the legacy `restroom_locations`
table. It is intentionally preserved as historical and rollback infrastructure
after the Stage 9 canonical cutover; it deliberately omits the old Replit
`users`, `sessions`, and `restroom_audits` tables, and community contributions
remain disabled until authentication, authorization, abuse prevention, and
moderation are designed and separately approved (Stage 12).

Since Stage 8/9 the canonical read model is the live source of truth:
migration `0003` creates `canonical_locations` and `location_provenance`, and
the `0004_*` seed migrations carry the owner-approved 776-location dataset
imported from `attached_assets/buttler_locations_canonical.csv` by
`scripts/import-canonical.mjs`. The bundled catalogue in
`lib/restroom-data.ts` (mirrored by `0002`) is now only the seed source for the
legacy table. Its rows remain marked `candidate` and `imported`: owning the
source does not mean every facility claim has been recently verified. The seed
neither imports the disposable Replit records nor creates Guardian
verification claims.

Regenerate the legacy seed after intentionally changing the bundled catalogue
(the check tolerates Git's CRLF checkout on Windows):

```sh
pnpm generate:d1-seed
pnpm check:d1-seed
```

The generator sorts rows by ID, emits batches of 100, escapes SQL text, and uses
`ON CONFLICT(id) DO NOTHING`. Reapplying the seed therefore does not duplicate
rows or overwrite future reviewed data.

## Local validation

Node.js 24 includes the SQLite interface used by the test. From the repository
root, run:

```sh
pnpm test:d1
```

The test first confirms the checked-in seed exactly matches the generator. It
then applies every migration to a temporary in-memory SQLite database, checks
the table and indexes, compares every seeded row with the bundled catalogue,
and confirms that invalid coordinates, invalid statuses, and false verification
claims are rejected. It reapplies the seed to prove it is idempotent, then
applies the rollback and confirms the table is gone.

No Cloudflare account, token, database, network connection, or secret is used.

## Remote commands (manual, approval-gated)

Migrations are applied manually; no tooling in this repository applies them
automatically, and any remote apply against the production database requires
separate owner approval:

```sh
# Create a local Wrangler database and apply the migrations locally.
wrangler d1 migrations apply <D1_DATABASE_NAME> --local

# Apply migrations to the approved remote D1 database.
wrangler d1 migrations apply <D1_DATABASE_NAME> --remote
```

The production Pages deployment binds the approved D1 database configured in
Wrangler. Do not place API tokens or other secrets in that file.

## Rollback

Before any further production use, D1 Time Travel or an export must be verified
and the rollback tested on a disposable database. Migration `0001` can be
reversed with `d1/rollback/0001_drop_restroom_locations.sql`, but dropping a
populated table deletes its records and therefore requires a separate
destructive approval.

Code-level rollback is a reversal commit merged through a reviewed pull
request. The canonical data migration itself is re-deployable and idempotent,
and the preserved legacy table keeps the pre-Stage-9 fallback path available.
