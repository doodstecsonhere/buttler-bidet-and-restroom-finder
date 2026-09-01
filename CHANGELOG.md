# Changelog

All notable changes to Buttler are documented here.

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
