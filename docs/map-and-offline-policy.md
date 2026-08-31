# Map and offline policy

## v1.0.0 behavior

Buttler uses the standard OpenStreetMap tile endpoint only while the browser is
online. The map visibly credits OpenStreetMap contributors. It does not require
an API key, account, payment card, trial, or usage-based billing.

The standard OpenStreetMap tile service is community-funded, best-effort, and
has no availability guarantee. Heavy or policy-violating use can be blocked.
Before materially increasing traffic or commercializing Buttler, the owner must
review the current tile policy and choose a provider suitable for that use.

Buttler does not prefetch, bulk-download, or persist remote map tiles in its
service worker. This keeps the implementation within the standard tile
service's policy and avoids promising an offline street map that the project
does not legally or reliably have.

## Offline experience

Once the PWA has been loaded, the application shell and the bundled catalogue
of 1,112 restroom locations remain available without a network connection.
Search, filters, markers, popups, and map pan/zoom remain interactive on a local
grid background. Street names and roads are not shown while offline unless the
browser itself still has a provider-authorized HTTP cache entry. The interface
states this limitation instead of showing broken or API-key-warning tiles.

## Provider and attribution

- Tile URL: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- Attribution: `OpenStreetMap contributors`, linked to the copyright page
- Policy to re-check before release and future traffic growth:
  `https://operations.osmfoundation.org/policies/tiles/`

## Rollback

Revert the map commit on a new branch and deploy the resulting revert commit.
Do not restore the former keyless CARTO URL: it is the source of the API-key
warning. The Replit deployment is intentionally unchanged and remains the
fallback until the owner separately approves any change to it.
