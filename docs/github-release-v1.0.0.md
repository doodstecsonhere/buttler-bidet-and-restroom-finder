# Buttler v1.0.0

Buttler v1.0.0 is the first independent, read-only release of the mobile-first
bidet and restroom finder for Dumaguete City.

## Highlights

- Browse, search, and filter 1,112 restroom locations.
- View bidet, access, fee, marker-detail, location, and directions information.
- Use a same-origin, GET-only Cloudflare D1 catalogue with an automatic bundled
  catalogue fallback.
- Install the PWA and reopen its shell, catalogue, search, filters, details, and
  interactive marker map after disconnecting.
- View an online OpenStreetMap basemap without an API key or CARTO warning.
- Receive a clear offline fallback when remote street tiles are unavailable.

## Offline limitation

Roads and street names require an internet connection. Buttler deliberately
does not prefetch or permanently store OpenStreetMap tiles. Offline, the local
catalogue and marker map remain interactive on a grid background; the app does
not pretend that uncached street tiles are available.

## Safety and cost

- Public database writes and authentication remain unavailable.
- No secret client-side key, payment card, trial, paid dependency, or
  usage-based service is introduced.
- OpenStreetMap attribution is visible. Its standard tile service is
  best-effort, has no SLA, and may block heavy or policy-violating traffic.

## Operational note

The existing Replit deployment remains online, unchanged, and independently
hosted as a fallback. This release does not migrate or delete Replit data or
resources and does not alter the existing D1 schema or records.

See `CHANGELOG.md`, `docs/map-and-offline-policy.md`, and
`docs/release-v1.0.0.md` for full verification, licensing, deployment, and
rollback details.
