# Buttler v1.0.0 release candidate

Status: prepared, not approved for merge, production deployment, tagging, or
GitHub Release publication.

## Release scope

Buttler v1.0.0 is a mobile-first, read-only restroom and bidet finder for
Dumaguete City. Cloudflare Pages and D1 provide the independent production
path. The existing Replit deployment remains unchanged as a separate fallback.

This release candidate removes the visible CARTO API-key failure by using the
standard OpenStreetMap tile endpoint only while online. When disconnected, the
app continues to expose the bundled 1,112-location catalogue, search, filters,
markers, popups, pan, and zoom on a local grid. It does not claim to provide
offline street tiles.

## Verification required before final approval

- Type-check, map/offline test, D1 schema test, D1 preview test, and production
  build must pass on the exact proposed commit.
- A local online check must show OpenStreetMap tiles and attribution, 1,112
  markers, and no `API KEY required` message.
- A disconnected check must show no requested tile images, 1,112 markers, the
  offline explanation, and a working marker popup.
- The Cloudflare preview for the exact branch commit must pass the same online
  and disconnected journeys on mobile and desktop.
- The existing Replit URL must still load independently and must not be changed.
- The pull request must remain unmerged until the owner gives final approval.

## Zero-dollar and provider limits

No API key, account, card, trial, pay-as-you-go setting, secret, new dependency,
or paid service is introduced by the map change. OpenStreetMap's standard tile
service is free to access but is best-effort, has no SLA, and can block heavy or
policy-violating use. It must be reassessed before significant traffic growth
or commercialization.

## Security, privacy, data, and accessibility

- No secret or private record is added or exposed.
- Public writes remain rejected; authentication remains deferred.
- No database migration or catalogue-record change is included.
- OpenStreetMap attribution remains visible.
- Offline and tile-failure messages use an accessible live status.
- Location recentering respects the user's reduced-motion preference.

## Rollback

1. Create a new rollback branch from the then-current `master`.
2. Revert the v1.0.0 map commit; do not rewrite Git history.
3. Run the same type-checks, tests, build, and browser journeys.
4. Open and review a rollback pull request.
5. After explicit owner approval, merge and deploy the rollback commit.
6. If Cloudflare must be rolled back urgently, select the last known-good Pages
   deployment while retaining the Git revert as the source-of-truth fix.

The old Replit deployment is unchanged and remains available throughout. The
database schema, D1 catalogue records, local PostgreSQL backup, and uploaded
files are not affected by this release and need no rollback action.

## Final owner approval gate

The final approval must name the reviewed pull request and exact head commit and
authorize, in order: merge into `master`, deploy that exact merged commit to
Cloudflare Pages Production, verify production in a fresh tab and disconnected
session, create annotated tag `v1.0.0`, and publish the prepared GitHub Release.
Any failed production verification stops the sequence before tagging or release
publication and triggers the rollback procedure above.
