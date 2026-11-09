# prelude-plugin-runtime — Agent Notes

## What this is
The **legacy plugin server** for Prelude (`prelude.chat`). A single Node.js `server.js` process that sits as a reverse proxy in front of Fluxer's `app-proxy`, handling:

- **Custom badge serving** — `/custom-badges/badges.json`, `/custom-badges/image-proxy`, `/custom-badges/encora-badges.js` (client-side badge injection script)
- **Discovery category overrides** — intercepts `/api/v1/discovery/categories` and returns custom categories from `discovery-categories.json`
- **Encora account linking/unlinking** — `/admin/users/link-encora`, `/admin/users/unlink-encora`
- **Admin UI** — `/admin/plugins/*` (badge CRUD, category management, guild-category assignments)

## Production stack
- **Dockhand stack name**: `fluxer-plugins`
- **Container**: `fluxer-plugins-plugin-server-1`
- **Compose file**: `/home/pekempy/Documents/Docker/Dockhand/data/stacks/fluxer-plugins/docker-compose.yml`
- **Env file**: `/home/pekempy/Documents/Docker/Dockhand/data/stacks/Prelude Production/fluxer-plugin-availability/.env` (shares Fluxer's .env for `POSTGRES_PASSWORD` etc.)
- **Network**: `fluxer_fluxer` (external, shared with the main Fluxer stack)
- **Caddy routing**: `plugin-server:8080` (service alias on the shared network)

## Deploying changes
```bash
# On the IONOS server:
cd /home/pekempy/Documents/Docker/Dockhand/data/stacks/fluxer-plugins
GIT_SSH_COMMAND="ssh -i ~/.ssh/prelude_plugin_runtime_deploy -o StrictHostKeyChecking=no" git pull
docker compose --env-file "/home/pekempy/Documents/Docker/Dockhand/data/stacks/Prelude Production/fluxer-plugin-availability/.env" \
  up -d --no-deps --force-recreate plugin-server
```

No image rebuild needed — `server.js`, `encora-badges.js`, `admin.html` etc. are volume-mounted from the git directory at `./:/app`.

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
`server.js` is the **legacy** approach. The proper `fluxer-plugins` SDK repo (`pekempy/fluxer-plugins`) has TypeScript plugins (`custom-badges`, `custom-discovery-categories`) that replicate this functionality properly inside the Fluxer API process. The SDK plugins are **not yet fully deployed** — the api-loader wiring has outstanding issues. Until that's resolved, `server.js` remains the active implementation.

## Caddyfile routing (on IONOS server)
`/home/pekempy/Documents/Docker/Dockhand/data/stacks/Prelude Production/fluxer-plugin-availability/Caddyfile`

Key routes:
- `/admin/plugins*` → `plugin-server:8080`
- `/api/v1/discovery/categories*` → `plugin-server:8080`
- `/custom-badges/*` → `plugin-server:8080` (via `plugin-server:8080 app-proxy:8080` fallback chain for main site)
- `/api/admin/users/link-encora*` → `plugin-server:8080`
- `/api/admin/users/unlink-encora*` → `plugin-server:8080`
