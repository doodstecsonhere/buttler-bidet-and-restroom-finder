# Cloudflare D1 foundation

This directory prepares Buttler's future public, read-only data layer. It does
not provision Cloudflare resources, bind a database to Pages, modify production,
or enable authentication or public writes.

## Model boundary

Migration `0001` creates only `restroom_locations`. It deliberately omits the
legacy `users`, `sessions`, and `restroom_audits` tables, as well as future
submission and moderation tables. Community contributions remain disabled until
authentication, authorization, abuse prevention, and moderation are designed
and separately approved.

The owner-controlled catalogue remains bundled in `lib/restroom-data.ts` and is
mirrored by migration `0002`. Seeded rows are deliberately marked `candidate`
and `imported`: owning the source does not mean every facility claim has been
recently verified. The seed neither imports the disposable Replit records nor
creates Guardian verification claims.

Regenerate the seed after intentionally changing the bundled catalogue:

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

## Future commands (not approved for execution)

These placeholder commands document the later deployment shape only:

```sh
# Create a local Wrangler database and apply the migration locally.
wrangler d1 migrations apply <D1_DATABASE_NAME> --local

# Apply migrations to a separately approved remote D1 database.
wrangler d1 migrations apply <D1_DATABASE_NAME> --remote
```

Before remote use, create a Wrangler configuration containing the approved D1
binding and generated database ID. Do not place API tokens or other secrets in
that file.

## Rollback

Before production use, D1 Time Travel or an export must be verified and the
rollback tested on a disposable database. Migration `0001` can be reversed with
`d1/rollback/0001_drop_restroom_locations.sql`, but dropping a populated table
deletes its records and therefore requires a separate destructive approval.

For this unmerged preparation branch, rollback is simply to close the pull
request and delete the branch after approval. No external state exists to undo.
