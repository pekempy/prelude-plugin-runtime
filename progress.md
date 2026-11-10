# Role-linked badge sync checkpoint

## Goal
Keep badge-to-role configuration in `pekempy/prelude-plugin-runtime`; have `EncoraFluxerBot` forward member role snapshots so the plugin can assign/remove custom badges. No public badge-mutation endpoint is intended.

## Repositories
- Plugin runtime: `~/Documents/Personal/Pekempy/prelude-plugin-runtime` (cloned from `pekempy/prelude-plugin-runtime`; production checkout was at `02bdc9b` when inspected).
- Bot: `~/Documents/Personal/Pekempy/EncoraFluxerBot`.
- Changes target `main` in both repositories; no production deployment or production `.env` edit has been made.

## Agreed contract
- Bot sends `POST /admin/plugins/api/badges/role-sync` with `Authorization: Bearer <BADGE_SYNC_TOKEN>` and JSON `{ guild_id, user_id, role_ids }`.
- `role_ids` is the member's complete post-change role-ID snapshot. The Bot sends snapshots for joins, role changes, and removals (empty list).
- One badge can link to multiple roles from one server; any matching role keeps the badge. The developer badge therefore links to both developer roles.
- Live badge IDs previously queried from `plugin_custom_badges`: `encora_staff`, `encora_developers`, `encora_bug_hunter`, and `encora_linked`.
- Requested mapping to configure in the admin UI after deployment:
  - Server `1518021155376594944`, role `1518032794880573441` → `encora_staff`
  - Roles `1518032740472061952` or `1562450044324413440` → `encora_developers`
  - Role `1569672387635445760` → `encora_bug_hunter`
- `encora_linked` remains the separate Encora account-link badge. The supplied SQL backfill updates legacy `fluxer_kv.users` fields, not `plugin_user_badges`, so it is unrelated to role sync.

## Work already made locally
### Plugin runtime
- Added role snapshot validation/auth helpers and focused Node tests in `plugins/custom-badges/role-sync.js` and `role-sync.test.js`; added `npm test` script.
- Added linked-role persistence, role-picker API helpers, schema initialization, and per-user transactional role snapshot reconciliation in `plugins/custom-badges/role-links.js`.
- Updated `plugins/custom-badges/index.js` with an authenticated role-sync endpoint, admin server/role pickers and linked-role CRUD, and manual-vs-role-managed assignment handling.
- Added the Linked roles panel and assignment-source label in `plugins/admin-panel/admin.html`.
- Passed `BOT_TOKEN` and `BADGE_SYNC_TOKEN` to the custom-badges service in both Compose files; updated plugin documentation.
### Bot
- Added `RoleBadgeSyncManager`, hooked member add/update/remove events, and added Vitest coverage, `.env.example`, and README guidance.

## Important runtime configuration
- `BADGE_SYNC_TOKEN` is an optional dedicated override. If blank, the plugin uses `BOT_TOKEN` and the Bot uses `FLUXER_BOT_TOKEN`; those live Bot credentials were confirmed to match. If an override is set, use the same value in both environments.
- The first linked role converts existing assignments for that badge to role-managed. Manual assignments made afterward remain manual exceptions.
- Existing members are reconciled on their next Bot join/role-update snapshot; there is no full guild backfill button/job yet.

## Verification completed
- Custom-badges unit tests: 5 passed (`npm test` in `plugins/custom-badges`).
- Bot role-sync tests: 7 passed (focused Vitest file).
- Node syntax checks passed for changed JavaScript, and the admin page's inline script parsed successfully.
- Browser preview exercised the badge detail, server/role pickers, and linked-role row at a narrow viewport using representative API responses.
- Read-only live checks confirmed the Bot can list the target server and roles through Caddy; no production files, database schema, `.env`, or containers were changed.
- Disposable PostgreSQL smoke setup could not start because Docker could not invoke `docker-credential-desktop`; no test container or database was changed.

## Before activation
1. The SQL reconciliation path has not been run against a test Postgres instance; the disposable Docker attempt failed because `docker-credential-desktop` was unavailable.
2. Configure the three role mappings in the badge admin UI; they are not seeded automatically.
3. Existing members are reconciled on their next Bot join/role-update snapshot; a full initial guild backfill is not implemented.
4. The Bot image publisher runs only on `v*` tags; a main push will not refresh GHCR `latest`. Production deployment is left to the user.
