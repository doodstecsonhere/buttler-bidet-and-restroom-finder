# D1 read-only preview

This phase adds a same-origin, GET-only Pages Function at `/api/restrooms`.
The frontend uses that endpoint when available and falls back to the bundled
catalogue on any network, database, response-validation, or binding failure.

## Safety boundary

- Binding name: `BUTTLER_DB`
- Database name: `buttler-read-model`
- Allowed HTTP method: `GET`
- Authentication and mutation endpoints: none
- Production binding: prohibited in this phase
- Production deployment: prohibited in this phase

Every response excludes rejected records and maps D1's integer `has_bidet`
field back to the public boolean `bidet` field. Responses may be cached for five
minutes. Missing bindings fail with HTTP 503; the browser then uses its bundled
catalogue.

## Local validation

```sh
pnpm test:d1
pnpm test:d1-preview
pnpm --filter @workspace/buttler typecheck
pnpm --filter @workspace/buttler build
```

The preview test uses an in-memory fake binding and never connects to D1.

## Remote migration and preview gates

Use Wrangler so `0001` and `0002` are recorded in D1's migration ledger:

```sh
wrangler d1 migrations apply buttler-read-model --remote \
  --config d1/wrangler.migrations.jsonc
```

The dedicated migration configuration is not a Pages deployment
configuration. Running the migration command does not bind D1 to production.

The D1 binding must be added to the Cloudflare Pages **Preview** environment
only. Deploy the `codex/d1-preview-binding` branch after that binding exists.

## Rollback

Before merge, close the preview PR and retain the current production deployment.
Removing a preview deployment or binding is a separate external change. Do not
drop the D1 table or database: the resource can remain isolated at zero dollars
until deletion is separately approved.
