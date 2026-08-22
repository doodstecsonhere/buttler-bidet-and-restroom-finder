# Buttler Project Instructions

## Purpose and communication

Buttler is a mobile-first bidet and restroom finder for Dumaguete City. The
owner is a technically new developer, so explain work in clear, non-technical
language while retaining enough technical detail for another coding agent to
continue safely.

Do not hide uncertainty. Clearly separate verified facts, reasonable
assumptions, and items that still require the owner's input.

## Repository and source of truth

This private repository, `doodstecsonhere/buttler-bidet-and-restroom-finder`, is
Buttler's only active development repository and source of truth. Its expected
local location is:

`C:\Code\GitHub\buttler-bidet-and-restroom-finder`

The old `buttler-replit` repository is a historical snapshot only. Never use it
for active development, merge from it automatically, or allow Replit to
overwrite this repository.

Keep `master` as the production branch during the migration. Renaming it to
`main` is a separate post-migration decision that requires owner approval.

Do not disconnect or remove the original Replit deployment, database,
authentication, storage, or platform integration until an independent
replacement has been backed up where necessary, tested, approved by the owner,
and verified in production.

## Strict zero-dollar budget

The project must remain at zero dollars unless the owner explicitly approves a
specific cost in advance.

Never do any of the following without explicit owner approval:

- Start or activate a paid trial.
- Add or enter a payment method or billing information.
- Enable pay-as-you-go billing, overages, or usage-based charging.
- Disable a spending cap or hard usage limit.
- Select or upgrade to a paid plan.
- Add a paid dependency or paid external service.
- Use a service whose free plan prohibits the owner's intended use.

Before proposing a hosting, database, authentication, map, email, analytics,
monitoring, storage, or other external service, report:

- Why it is needed.
- Its current free allowance and important limitations.
- Whether a payment card is required.
- Whether unexpected charges or overages are possible.
- What happens when the free allowance is exhausted.
- Whether inactive projects sleep, pause, expire, or are deleted.
- Whether its free plan permits the intended use, including possible future
  commercial use.
- Whether it supports private GitHub repositories, preview deployments, and
  rollback where applicable.
- What would eventually require payment.

Prefer services that stop or suspend at a hard limit instead of charging. Never
assume that a service is still free; verify current terms before recommending or
connecting it.

## Branches, commits, pushes, and pull requests

Never implement a feature or fix directly on `master` or another configured
production branch.

For each feature, fix, or focused documentation task:

1. Confirm the working tree and current branch before beginning.
2. Create one clearly named branch for that task. Use the `codex/` prefix unless
   the owner requests another clear branch name.
3. Keep the branch limited to the approved scope.
4. Make small, understandable commits with clear messages.
5. Push the completed feature branch to the active private GitHub repository as
   a cloud backup.
6. Prepare a pull request that explains changes, tests, risks, costs, and
   rollback.
7. Do not merge the pull request without explicit owner approval.

Never force-push, rewrite shared history, discard owner changes, delete branches
or tags, or use destructive Git commands without explicit approval.

## Scope and approval boundaries

Do not make changes outside the owner's requested scope. Investigation and
diagnostic tasks do not authorize implementation.

Always obtain explicit owner approval before:

- Running a migration against a shared or production database.
- Changing, deleting, or importing production records.
- Connecting, disconnecting, or changing an external provider.
- Changing production environment variables or secrets.
- Deploying or promoting a preview to production.
- Changing a public domain or DNS.
- Publishing a GitHub Release.
- Merging a pull request into the production branch.
- Disconnecting any original Replit component.
- Taking an irreversible or materially destructive action.

Codex may prepare a migration, deployment configuration, draft Release, pull
request, or rollback plan when that work is in scope, but preparation does not
authorize execution or publication.

## Local development and previews

Preview functional changes locally before asking for production approval.
Local work must use:

- A development-only database when database access is required.
- Development-only authentication configuration.
- Sample or disposable test accounts and records.
- Local environment files that are excluded from Git.

Never use a production `DATABASE_URL` for ordinary local development or tests.
Do not run the application when its environment is ambiguous and it might write
to production. Clearly label sample or development data when it could be
mistaken for live data.

Report the exact installation command, start commands, local addresses, ports,
and required environment-variable names. Never display secret values.

Normal safe local development is allowed when it stays within the approved task
and uses isolated development resources. Installing or updating dependencies,
changing a lockfile, adding a provider, or accessing a shared service requires
the scope or approval appropriate to that action.

## Testing and real-user journeys

Test in proportion to the risk of the change. At minimum, run the repository's
relevant type checks, automated tests, and production build when the environment
allows them to run safely. Do not claim a feature works merely because it
compiles.

For user-facing changes, verify the affected real-user journeys, including as
applicable:

- Finding and searching for a restroom.
- Viewing restroom and bidet details.
- Using the map, location permission, filters, and directions.
- Viewing, creating, or updating a Guardian audit.
- Signing in and signing out.
- Rejecting unauthorized actions.
- Submitting, reviewing, reporting, or moderating community content.
- Using the app on a narrow mobile screen and a desktop screen.
- Handling loading, empty, offline, denied-permission, and API-error states.

Also check keyboard operation, visible focus, accessible names, readable
contrast, reduced-motion behavior where relevant, and basic screen-reader
semantics. Document any check that could not be run and why.

## Secrets and private data

Never commit, print, log, paste into issues or pull requests, or include in
screenshots:

- Passwords or database connection strings.
- API keys, access tokens, refresh tokens, cookies, or session identifiers.
- Private keys or authentication client secrets.
- Private user records or production data.
- Workspace invitation or join links that may grant access.

Commit only placeholder-based example environment files. Ensure all real `.env`
variants and local secret files are ignored. Client-visible environment
variables must contain only information safe for any visitor to inspect.

If secret exposure is suspected, stop displaying output, redact the value
completely, identify only the affected location and general credential type,
and recommend rotation. Never rotate or revoke a credential without approval.

## Database, migrations, and storage

Treat these as four separate recovery systems:

1. Code in Git.
2. Database structure and ordered migrations.
3. Database records and backups.
4. Uploaded files and object-storage backups.

Before any database schema change:

1. Explain the proposed migration, risk, and rollback.
2. Create an ordered migration file.
3. Test it against an isolated development database.
4. Confirm the required backup and restore procedure.
5. Obtain explicit approval before running it against shared or production data.

Never use a force schema-push command against shared or production data. Never
imply that Git can restore database records or uploaded files. Do not delete old
tables, columns, records, accounts, sessions, audits, or storage objects without
explicit approval and an appropriate verified backup.

Buttler's old Replit users, sessions, and audit records may be treated as
disposable only when the owner explicitly authorizes their abandonment during
the migration. This does not authorize modifying or deleting them early.

## Authentication and authorization

Hiding a button is not authorization. Enforce every protected operation on the
server and test that unauthorized requests fail.

Guardian contributions must remain traceable to an account. Provide owner-approved
ways to suspend abusive contributors and invalidate harmful submissions before
large public contribution events. Moderator and administrator capabilities must
use explicit server-side authorization.

Do not expose session/provider tokens, private email addresses, private remarks,
or moderation information through public endpoints. An authentication-provider
replacement requires a fresh-account or account-mapping plan, session handling,
rollback instructions, and owner approval.

## Restroom data and community safety

The owner maintains the source restroom and bidet data. Preserve the distinction
between:

- Manually vetted source data.
- Sensible but unverified candidate locations.
- Community submissions and proposed updates.
- Verified, disputed, outdated, and rejected information.

Do not present assumed accessibility, access, fee, restroom, or bidet details as
verified fact. Keep CSV files usable for import, export, and backup, but do not
silently overwrite source data from unreviewed submissions.

Public contribution features require appropriate validation, duplicate and
spam controls, rate limiting, reporting, moderation, and retention/deletion
behavior. A leaderboard or university mapathon must reward accepted, useful
contributions rather than raw submission volume.

## Dependencies

Prefer existing dependencies and browser/platform capabilities. Add a dependency
only when it provides a clear benefit that cannot reasonably be achieved with
the current stack.

Before adding one, check its maintenance status, security history, license,
commercial-use terms, bundle or runtime impact, transitive dependencies, and any
paid external-service requirement. Do not remove a dependency until its usage
has been checked and relevant tests pass.

## Maps, assets, and licensing

Preserve required map and geographic-data attribution. Verify map-tile-provider
usage and commercial terms before launch or monetization. Do not assume that
OpenStreetMap data means every third-party tile server is unrestricted or free
for commercial use.

Record the source and ownership of fonts, icons, images, generated assets,
facility data, templates, and copied components. The owner-generated logo and
PWA icon, Replit-generated social image and interface, CSV data, dependencies,
map tiles, and fonts still require an appropriate licensing and attribution
record before commercialization.

## Releases and production deployment

Use semantic versions after the independent release process is established:

- Major versions for incompatible changes.
- Minor versions for backward-compatible features.
- Patch versions for compatible fixes.

Codex may prepare draft Releases and generated release notes when requested.
Publishing a GitHub Release always requires explicit owner approval.

Production deployment, provider connection, public-domain or DNS changes, and
promotion of a preview to production always require explicit owner approval.
Do not configure unreviewed branches to deploy automatically to production.

## Rollback

Every implemented task must include a rollback explanation covering each
applicable layer:

- How to reverse the Git changes, normally with a reversal commit rather than
  history rewriting.
- How to restore the previous deployment.
- How to reverse a database-structure change.
- How to restore database records.
- How to restore uploaded files.
- Which actions are not fully reversible.

Keep the previous working deployment and original Replit components available
until the replacement has been verified and the owner approves disconnection.

## Required end-of-task report

End every implementation task with a concise, non-technical summary for the
owner that reports:

- What changed and why.
- Files changed.
- Branch name and commit identifiers.
- Pull-request and preview status, when applicable.
- Tests and real-user journeys checked, including anything not tested.
- Local preview instructions.
- Environment-variable names added or changed, without values.
- Security, privacy, accessibility, data, and migration risks.
- Current cost and anything that could create a future cost.
- Known limitations and remaining Replit dependencies.
- The exact rollback procedure.
- Every action still requiring owner approval.

Never state that production is safe merely because a build or test suite passes.
