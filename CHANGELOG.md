# Changelog

All notable changes to Buttler are documented here.

## [Unreleased] - BUTTLER 2.0 (in development, not deployed)

### Added

- The `/api/restrooms` public contract now derives a `bidet_evidence` field
  (`field_verified` / `osm_explicit` / `unknown`) from the canonical
  verification column: 98 survey-verified and 16 map-reported bidets
  (development branch only; production D1 is unchanged).
- `scripts/generate-bundled-catalogue.mjs` generates the PWA's offline
  catalogue (`lib/restroom-bundle.ts`) from the canonical 776-row dataset.
- The restroom loader keeps a last-known-good canonical API response on the
  device and distinguishes true network loss from API/server errors.
- `scripts/public-data-contract.test.mjs` gates the contract: 776 rows,
  98/16 bidet evidence, string ids, fee/access preservation, and offline
  data equal to the live projection.

### Changed

- Offline fallback no longer serves the superseded legacy 1,112-row
  catalogue; online and offline use the same canonical dataset.
- UI access labels are conservative: exact "public" only; stored `unknown`
  shows "Access unconfirmed" instead of claiming Customer-Only.
- Map popups show "Bidet" without a checkmark; map-reported bidets get a
  subtle "map data" marker.

## [1.0.0] - Unreleased

### Added

- A read-only public catalogue of 1,112 Dumaguete restroom locations backed by
  Cloudflare D1, with a bundled catalogue fallback.
- Installable PWA support and a clear disconnected-state experience.
- An interactive offline map canvas that retains markers, search, filters,
  popups, pan, and zoom without requiring remote street tiles.

### Changed

- Replaced the keyless CARTO map URL with the standard OpenStreetMap online
  tile endpoint and visible OpenStreetMap attribution.
- Disabled service-worker caching of third-party map tiles to respect provider
  policy and avoid misleading offline-map promises.
- Location recentering now respects reduced-motion preferences.

### Known limitations

- Street names and roads require an internet connection; the offline map uses
  a local grid behind the still-interactive restroom markers.
- Authentication and public writes remain intentionally unavailable.
- OpenStreetMap's standard tile service is best-effort and may block heavy or
  policy-violating traffic.
