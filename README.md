# Buttler — Bidet and Restroom Finder

Buttler is a mobile-first progressive web app for finding bidets and restrooms in Dumaguete City, Philippines.

## Product features

- Interactive restroom map with bidet and access indicators
- Search and filters for bidets and public facilities
- Directions, access details, fees, and verification status
- Guardian audits for community-maintained facility information
- Offline-capable PWA experience

## Technology

React, TypeScript, Vite, Leaflet/OpenStreetMap, Express, PostgreSQL, Drizzle ORM, and pnpm workspaces.

## Development status

This private repository is the independent source of truth for Buttler. It retains the original revision history while the application is being migrated away from Replit.

Migration work should be performed on feature branches and merged through reviewed pull requests.

## Development

Use Node.js 24 and pnpm.

```sh
pnpm install
pnpm run typecheck
pnpm run build
```

Runtime services and environment variables will be documented as part of the migration assessment.

## Read-only launch work

The `codex/read-only-launch` branch contains a provider-independent frontend
path that bundles the restroom catalogue directly with the PWA. It intentionally
does not expose login or Guardian-audit controls and does not require a database
connection. See [docs/read-only-launch.md](docs/read-only-launch.md).
