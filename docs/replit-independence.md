# Replit independence checkpoint

Status date: 2026-08-23

This document records the provider-neutral preparation completed before choosing
or creating replacement infrastructure. It contains no credentials or private
records.

## Verified recovery position

- The private GitHub repository is the active code source of truth.
- The Replit Development PostgreSQL database has a verified custom-format
  logical backup at the owner's local backup location.
- That backup was restored once into an isolated PostgreSQL 17 database and
  validated by schema name and aggregate counts only.
- The owner has chosen not to migrate the legacy `users`, `sessions`, or
  `restroom_audits` records. The backup remains recovery evidence.
- The original Replit database and deployment remain available. Nothing in this
  branch disconnects, deletes, republishes, or changes them.

## Current portability boundary

The public restroom catalogue is stored in source code and is portable. The
React/Vite PWA, Leaflet map, search, filters, location handling, and offline
cache can be rebuilt without a Replit database.

The following features are still coupled to Replit and PostgreSQL:

- Replit OIDC login through `ISSUER_URL` and `REPL_ID`.
- PostgreSQL access through `DATABASE_URL`.
- Database-backed browser and mobile sessions.
- Guardian audit creation and audit-summary reads.
- Replit deployment routing and development-only Vite plugins.

The repository also records a Replit Object Storage bucket identifier, but no
application code currently reads or writes object storage. Do not disconnect or
delete that bucket until the dashboard inventory is complete.

## Environment-variable names

Current runtime names, without values:

- `DATABASE_URL`
- `ISSUER_URL`
- `REPL_ID`
- `PORT`
- `BASE_PATH`
- `NODE_ENV`

Real environment files and credentials must remain outside Git.

## Database-change safety

The Replit post-merge hook previously ran `drizzle-kit push` automatically.
That command could change an unintended database when `DATABASE_URL` is
ambiguous. The hook now installs locked dependencies only. Future schema work
must use ordered migration files, an isolated database, review, backup and
restore instructions, and explicit approval before shared or production use.

## Strictly free architecture decision

No provider has been selected by this branch. Two materially different paths
remain:

1. **Read-only public launch first.** Package the owned restroom catalogue with
   the PWA and temporarily remove login and Guardian submissions. This has the
   smallest migration surface and can use static hosting, but community editing
   is unavailable until a later phase.
2. **Community-capable launch.** Replace Express/PostgreSQL/Replit OIDC with a
   serverless API, a fresh database, and fresh authentication. This preserves
   the intended Guardian workflow but requires a security and moderation design
   before public writes are enabled.

Cloudflare Workers/Pages with D1 is the leading zero-dollar candidate because
its free quotas stop requests or writes when limits are reached rather than
creating usage overages. The current application cannot be deployed there
unchanged: Express, PostgreSQL SQL, and Replit OIDC must be adapted. Provider
creation, GitHub connection, preview deployment, and architecture selection all
remain approval gates.

## Next implementation gate

Before implementation continues, the owner must choose read-only launch first
or community-capable launch. Either path will use a new focused branch, local
tests, an isolated preview, and a separate production-cutover approval.

The exposed, unused Neon credential should be revoked separately. Credential
rotation must not update any active Replit secret or deployment.
