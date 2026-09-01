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

### Disconnected-reload method

The offline check must disable the network and the browser's ordinary HTTP
cache while leaving the installed service worker and its Cache Storage
available. Do not use a reload option that explicitly bypasses the service
worker or clears site data: that tests a first visit with no local application
installed, not an installed PWA reopening offline.

Before disconnecting, confirm that the service worker controls the page. Then
reload with normal navigation semantics, confirm the shell and bundled
catalogue render, and restore every temporary network/cache override after the
check.

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

## Proposed tag target

The tag target is not the feature-branch commit. After an expected-head-guarded
merge and successful Production verification, annotated tag `v1.0.0` must point
to the exact merged `master` commit that Cloudflare Production serves. Record
that full commit ID before creating the tag. Never move or recreate the tag to
hide a failed deployment.

## Release checklist

- [x] Work performed on a focused `codex/` branch.
- [x] No Replit component changed.
- [x] No new paid or charge-capable service, account, key, or dependency added.
- [x] Type-check, focused tests, D1 tests, and Production build pass locally.
- [x] Production-format PWA opens after a disconnected reload.
- [x] Online and offline catalogue, search, filters, markers, details, and
      directions behavior checked locally.
- [x] Map provider policy, attribution, caching, offline-use, and traffic risks
      documented.
- [x] Tracked files and built frontend scanned for credential patterns.
- [ ] Draft pull request created and reviewed at its exact head commit.
- [ ] Cloudflare Preview deployed from that exact commit and verified on mobile
      and desktop, online and disconnected.
- [ ] Replit fallback rechecked immediately before final approval.
- [ ] Owner approves the consolidated merge/deploy/tag/release sequence.
- [ ] Pull request merged with an expected-head guard.
- [ ] Exact merged `master` commit deployed to Cloudflare Production.
- [ ] Production verified online, offline, read-only, and independent of Replit.
- [ ] Annotated `v1.0.0` tag created at the verified Production commit.
- [ ] GitHub Release published from the prepared notes.

Unchecked items are release gates, not optional follow-up work.

## Production deployment plan

1. Confirm the reviewed pull-request head still equals the commit stated in the
   final approval prompt; stop if it differs.
2. Merge through GitHub using the repository's normal merge method and an
   expected-head guard. Do not push directly to `master`.
3. Confirm `origin/master` contains the reviewed commits and record the exact
   merged commit ID.
4. Use the existing Cloudflare Pages project `buttler`, existing Production D1
   binding `BUTTLER_DB`, existing build command, and existing output directory.
   Do not change billing, bindings, environment variables, DNS, or automatic
   deployment settings.
5. Deploy only the recorded merged commit to Production through the existing
   token-free Git integration/manual deployment route.
6. In a fresh tab, verify the application shell, OpenStreetMap tiles and
   attribution, absence of any API-key warning, exactly 1,112 catalogue rows,
   search, filters, details, directions, denied location, and rejected writes.
7. In a separate Production PWA session that has first loaded online, disconnect
   networking and reload. Verify the shell, bundled catalogue, search, filters,
   details, markers, clear offline message, zero broken tiles, and no endless
   loading state.
8. Recheck the unchanged Replit fallback. If any check fails, stop before tag or
   Release publication and execute the rollback plan.
9. Only after all checks pass, create annotated tag `v1.0.0` on the recorded
   Production commit and publish the prepared GitHub Release.

## Layer-by-layer rollback details

- **Git:** revert the release commits on a new branch, review the revert PR, and
  merge normally; never reset or force-push shared history.
- **Cloudflare Pages:** immediately select the previous known-good Production
  deployment, then deploy the reviewed Git revert so Production and Git agree.
- **D1:** this release has no migration or record change. Keep the existing
  database and `BUTTLER_DB` binding unchanged; do not restore or delete data.
- **Map:** the old keyless CARTO layer is not a valid rollback target. If OSM
  tiles must be disabled, revert to the local grid/marker fallback while a new
  provider is reviewed.
- **Service worker/cache:** deploy the rollback build with the existing
  `skipWaiting` and `clientsClaim` settings, then verify in a fresh tab and after
  closing/reopening any installed PWA. Old browser-cached OSM tiles may expire
  naturally under provider HTTP headers and must not be bulk-cleared remotely.
- **GitHub tag and Release:** if failure occurs before publication, create
  neither. If a serious defect is discovered after publication, do not silently
  move the tag; document the issue, roll back Production, and prepare a new
  patch release under explicit owner approval.
- **Replit:** no rollback action is needed because this release never modifies
  the separate Replit fallback.
