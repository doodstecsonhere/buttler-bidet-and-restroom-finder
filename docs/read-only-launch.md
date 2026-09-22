# Read-only launch

The read-only launch keeps Buttler useful while removing live database and
authentication dependencies from the public frontend. It is a preview
candidate only; this branch does not create or change hosting.

## Included journeys

- Browse all restroom locations.
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

Since the Stage 9 canonical cutover the frontend asks the same-origin,
GET-only `functions/api/restrooms.ts` Pages Function, which projects the
canonical D1 read model (776 string-keyed locations). On any API or network
failure, `lib/restroom-loader.ts` falls back to the last-known-good canonical
response cached per device, and before any successful load to the generated
canonical bundle in `lib/restroom-bundle.ts` — never the superseded legacy
catalogue. The `RESTROOMS` array in `lib/restroom-data.ts` remains only as the
seed source for the off-stack legacy `restroom_locations` table and is
tree-shaken out of the shipped PWA bundle.

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
