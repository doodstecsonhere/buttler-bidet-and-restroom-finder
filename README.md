# Buttler — Bidet and Restroom Finder

Buttler is a mobile-first progressive web app for finding bidets and restrooms in Dumaguete City, Philippines.

## Product features

- Interactive restroom map with bidet and access indicators
- Search and filters for bidets and public facilities
- Directions, access details, and fee information
- Read-only catalogue served from Cloudflare D1 with a bundled fallback
- Offline-capable PWA shell, catalogue, search, filters, details, and marker map

## Technology

The public application uses React, TypeScript, Vite, Leaflet/OpenStreetMap,
Cloudflare Pages, Cloudflare D1, and pnpm workspaces. Legacy Replit, Express,
and PostgreSQL code remains in the repository for fallback and migration
history but is not a dependency of the Cloudflare read-only application.

## Development status

This private repository is the independent source of truth for Buttler. The
Cloudflare deployment operates independently, while the unchanged Replit
deployment remains available as a separately hosted fallback.

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

The public frontend first reads its catalogue from a same-origin, GET-only D1
endpoint and falls back to the catalogue bundled with the PWA on any API or
network failure. It intentionally does not expose login, Guardian-audit, or
other public-write controls. See [docs/read-only-launch.md](docs/read-only-launch.md)
and [docs/map-and-offline-policy.md](docs/map-and-offline-policy.md).
