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

The catalogue remains bundled in `lib/restroom-data.ts`; this migration does not
seed or transfer it. When a D1 database is eventually approved, an explicit,
reviewable seed migration should be generated from the owner-vetted catalogue.

## Local validation

Node.js 24 includes the SQLite interface used by the test. From the repository
root, run:

```sh
pnpm test:d1
```

The test applies every migration to a temporary in-memory SQLite database,
checks the expected table and indexes, accepts a valid row, and confirms that
invalid coordinates, invalid statuses, and false verification claims are
rejected. It then applies the rollback and confirms the table is gone.

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
