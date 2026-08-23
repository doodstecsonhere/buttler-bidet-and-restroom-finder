# Read-only launch

The read-only launch keeps Buttler useful while removing live database and
authentication dependencies from the public frontend. It is a preview
candidate only; this branch does not create or change hosting.

## Included journeys

- Browse all bundled restroom locations.
- Search by place name or address.
- Filter for bidets or public access.
- View map markers and listing details.
- Request device location and sort nearby results.
- Open external directions.
- Install and reopen the PWA.
- Use the bundled catalogue, search, and filters while offline.

## Intentionally unavailable

- Login and logout.
- Guardian audit submission.
- Guardian verification badges.
- Database-backed user, session, or audit reads and writes.

The interface labels this state as read-only. Listings ask visitors to check
current conditions instead of implying that unaudited information is verified.

## Data flow

`lib/restroom-data.ts` is the provider-neutral source catalogue. The PWA bundles
it at build time, so loading places does not contact Replit, Neon, PostgreSQL,
or an application API. The legacy Express route imports the same catalogue to
avoid creating two divergent copies while Replit remains available for
rollback.

## Local checks

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/buttler typecheck
pnpm --filter @workspace/buttler build
pnpm --filter @workspace/buttler serve
```

The local preview defaults to port `5173` and base path `/`. `PORT` and
`BASE_PATH` remain optional overrides. The read-only frontend requires no
secret environment variables.

## Preview deployment shape

A static host needs only:

- Build command: `pnpm --filter @workspace/buttler build`
- Output directory: `artifacts/buttler/dist/public`
- Node.js: 24
- Secrets: none
- Database: none
- Authentication provider: none

Creating a host project, connecting the private GitHub repository, or uploading
the built site requires a separate preview-deployment approval. Production
cutover and Replit disconnection remain later approvals.

## Rollback

Delete the unmerged branch or revert its focused commit. The current Replit
deployment and its data are unchanged, so they remain the operational rollback.
