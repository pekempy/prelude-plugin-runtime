# prelude-plugin-runtime — Agent Notes

## Plugin Philosophy (INVIOLABLE)
- **Every plugin must be individual, self-contained, and independently deployable.**
- **Do NOT modify upstream Fluxer code, images, or compose files.** All overrides go through the Caddyfile or `compose.plugins.yaml` only.
- **Backend over frontend.** If a feature can be served cleanly by intercepting/modifying an API response server-side, do that — do NOT add client-side JS hacks to achieve the same result. When a backend approach is confirmed working, remove the JS workaround.
- **No dead code.** Delete hacks when replaced by proper implementations.
- **Plugins must be shareable** — another Fluxer instance should be able to adopt this runtime and have it work without custom changes.

## Architecture: Monolithic → Split Plugins

**As of this version**, the single `server.js` (1434 lines) has been decomposed into **five independent plugins**:

| Plugin | Port | Purpose | Container |
|--------|------|---------|-----------|
| custom-badges | 8081 | Badge system + profile API interception | `plugin-custom-badges` |
| discovery-categories | 8082 | Category CRUD + guild mapping | `plugin-discovery-categories` |
| encora-linking | 8083 | Discord Encora role management | `plugin-encora-linking` |
| admin-panel | 8084 | Admin UI + authentication | `plugin-admin-panel` |
| web-script-injector | 8080 | Catch-all proxy + script injection | `plugin-web-script-injector` |

### Legacy monolith
The original `server.js` provided all functionality in a single process. **It is now obsolete** — all code has been migrated to the respective plugins above.

### Shared utilities
All plugins import from `shared/`:
- `shared/pg.js` — PostgreSQL connection pool via `createPool()`
- `shared/auth.js` — Admin authentication (checkAdminAuth, createSessionCookie, bearer tokens, ADMIN_SECRET, ALLOWED_ADMIN_TOKENS)
- `shared/http.js` — HTTP utilities (readJsonBody, readRawBody, json response)

## What this is
The **plugin runtime** for Prelude (`prelude.chat`). Five Node.js processes that sit as a reverse proxy in front of Fluxer, handling:

- **Custom badge serving** — `/custom-badges/badges.json`, `/custom-badges/image-proxy`, `/custom-badges/encora-badges.js` (client-side badge injection script)
- **Discovery category overrides** — intercepts `/api/v1/discovery/categories` and returns custom categories from `discovery-categories.json`
- **Encora account linking/unlinking** — `/api/admin/users/link-encora`, `/api/admin/users/unlink-encora`
- **Admin UI** — `/admin/plugins/*` (badge CRUD, category management, guild-category assignments)
- **Script injection** — catch-all proxy with HTML script injection

## Production stack
- **Dockhand stack name**: `fluxer-plugins`
- **Containers** (from root docker-compose.yml):
  - `fluxer-plugins-plugin-custom-badges-1` (port 8081)
  - `fluxer-plugins-plugin-discovery-categories-1` (port 8082)
  - `fluxer-plugins-plugin-encora-linking-1` (port 8083)
  - `fluxer-plugins-plugin-admin-panel-1` (port 8084)
  - `fluxer-plugins-plugin-web-script-injector-1` (port 8080)
- **Compose file**: `/home/pekempy/Documents/Docker/Dockhand/data/stacks/fluxer-plugins/docker-compose.yml` (now has all 5 services)
- **Env file**: `/home/pekempy/Documents/Docker/Dockhand/data/stacks/Prelude Production/fluxer-plugin-availability/.env` (shares Fluxer's .env)
- **Network**: `fluxer_fluxer` (external, shared with main Fluxer stack)
- **Caddy routing**: individual routes per plugin (see below)

## Deploying changes

### Local testing
```bash
# Start all plugins + postgres
docker-compose up -d

# Or a single plugin
cd plugins/custom-badges
docker-compose up -d

# View logs
docker-compose logs -f plugin-custom-badges
```

### Production deployment
```bash
# On the IONOS server:
cd /home/pekempy/Documents/Docker/Dockhand/data/stacks/fluxer-plugins
GIT_SSH_COMMAND="ssh -i ~/.ssh/prelude_plugin_runtime_deploy -o StrictHostKeyChecking=no" git pull

# Restart all plugins
docker compose --env-file "/home/pekempy/Documents/Docker/Dockhand/data/stacks/Prelude Production/fluxer-plugin-availability/.env" \
  up -d --force-recreate
```

No image rebuild needed — plugin code, admin.html, encora-badges.js etc. are volume-mounted from the git directory (`./:/plugin`).

## SSH access
```bash
ssh -i ~/.ssh/ionos_ed25519 -o IdentitiesOnly=yes pekempy@212.227.22.45
# or via alias:
ssh-ionos
```

## GitHub repo
`pekempy/prelude-plugin-runtime` (private)
Deploy key: `~/.ssh/prelude_plugin_runtime_deploy` (read-write, on IONOS server)

## Data storage
- **Badge types & user assignments**: PostgreSQL (`plugin_custom_badges`, `plugin_user_badges` tables in the `fluxer` DB)
- **Discovery categories**: `discovery-categories.json` in this repo (flat JSON, volume-mounted)
- **Badge catalog**: `badges-catalog.json` in this repo

## Relationship to fluxer-plugins SDK
The original `server.js` was the **legacy** approach. The proper `fluxer-plugins` SDK repo (`pekempy/fluxer-plugins`) has TypeScript plugins (`custom-badges`, `custom-discovery-categories`) that replicate this functionality properly inside the Fluxer API process. The SDK plugins are **not yet fully deployed** — the api-loader wiring has outstanding issues. Until that's resolved, this plugin runtime remains the active implementation.

## Caddyfile routing (on IONOS server)
`/home/pekempy/Documents/Docker/Dockhand/data/stacks/Prelude Production/fluxer-plugin-availability/Caddyfile`

Each plugin has dedicated routes:
- **custom-badges:8081** ← `/custom-badges/*`, `/api/*/users/*/profile`, `/admin/plugins/api/badges*`, `/admin/plugins/api/users*`
- **discovery-categories:8082** ← `/api/*/discovery/categories*`, `/categories/*`, `/admin/plugins/api/categories*`, `/admin/plugins/api/guilds*`
- **encora-linking:8083** ← `/api/admin/users/link-encora*`, `/api/admin/users/unlink-encora*`
- **admin-panel:8084** ← `/admin/plugins*`, `/admin/plugins/login*`, `/admin/plugins/logout*`, `/admin/badges*`
- **web-script-injector:8080** ← catch-all (LAST block)

For the complete Caddy config, see the README.md in repo root.

## 📌 TODO (soon™)

### Mobile badge toggle support
Custom badges appear in the Flutter mobile settings page but their toggle is **non-functional** — tapping does nothing. Root cause: Flutter's `kProfileBadgeKinds` Set in `flutter_client` doesn't include `"custom"`, so the toggle tap handler is a no-op for custom-kind badges.

**Fix**: one-liner PR to `fluxerapp/flutter_client`:
- File: `lib/features/profile/utils/profile_badge_keys.dart`
- Change: add `'custom'` to the `kProfileBadgeKinds` Set

Once that ships, the mobile toggle will work via the existing `hidden_profile_badges` mechanism — each plugin's `checkAdminAuth` handles auth, and the preview proxy persists hidden state to `plugin_user_badges.hidden`.
