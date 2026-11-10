# Admin Panel Plugin

Serves the unified admin UI for the entire plugin ecosystem. Handles authentication, session management, and serves the admin dashboard. All admin API calls are routed directly to their respective plugins via Caddy.

## Prerequisites

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8084` | Server port |
| `PGHOST` | `postgres` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `fluxer` | Database name |
| `PGUSER` | `fluxer` | Database user |
| `PGPASSWORD` | (required) | Database password |
| `FLUXER_ADMIN_SECRET_KEY_BASE` | (required) | Admin authentication secret |

## Caddy Configuration

Add the following blocks to your Caddyfile:

```caddy
handle /admin/plugins {
    reverse_proxy plugin-admin-panel:8084
}

handle /admin/plugins/login* {
    reverse_proxy plugin-admin-panel:8084
}

handle /admin/plugins/logout* {
    reverse_proxy plugin-admin-panel:8084
}

handle /admin/badges* {
    reverse_proxy plugin-admin-panel:8084
}

# Note: /admin/plugins/api/* routes go directly to their respective plugins
# (see custom-badges and discovery-categories Caddy config blocks)
```

## Running Standalone

```bash
cd plugins/admin-panel
docker-compose up -d
```

## API Endpoints

### UI
- `GET /admin/plugins` — Main admin dashboard
- `GET /admin/plugins/login` — Login page
- `POST /admin/plugins/login` — Authenticate and create session
- `GET /admin/plugins/logout` — Clear session

### UI Assets
- `GET /admin/badges` — Serves admin.html UI

## Architecture

The admin-panel plugin serves three roles:

1. **Authentication Gateway** — Issues session cookies via `/admin/plugins/login`
2. **UI Host** — Serves the unified `/admin/plugins` dashboard
3. **Proxy Coordinator** — Caddy routes `/admin/plugins/api/*` to correct plugins:
   - `/admin/plugins/api/badges/*` → custom-badges:8081
   - `/admin/plugins/api/users/*` → custom-badges:8081
   - `/admin/plugins/api/categories/*` → discovery-categories:8082
   - `/admin/plugins/api/guilds/*` → discovery-categories:8082

Each plugin independently enforces `checkAdminAuth` on its own `/admin/plugins/api/` endpoints.

## Dependencies

**Required peer plugins:**
- custom-badges — provides badge management API
- discovery-categories — provides category management API

**Optional peer plugins:**
- encora-linking — can be managed via admin UI if enabled

When running all plugins together via root docker-compose.yml, ensure admin-panel starts last so plugins are ready.
