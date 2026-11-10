# Prelude Plugin Runtime

This repository contains the split plugin architecture for Prelude's features. The original monolithic `server.js` has been decomposed into five independent plugins, each with its own Docker container, environment, and admin API.

## Architecture

The plugin ecosystem consists of:

1. **custom-badges** (port 8081) — User badge system with profile injection
2. **discovery-categories** (port 8082) — Guild discovery categories management
3. **encora-linking** (port 8083) — Discord Encora role linking
4. **admin-panel** (port 8084) — Unified admin dashboard and authentication
5. **web-script-injector** (port 8080) — Catch-all proxy with script injection

## Quick Start

### Prerequisites

- Docker and Docker Compose
- PostgreSQL 16+ (can use included postgres service)
- Caddy reverse proxy (configured separately)
- Discord bot token (for encora-linking)

### Running All Plugins

```bash
# Set environment variables
export POSTGRES_PASSWORD="your-secure-password"
export FLUXER_ADMIN_SECRET_KEY_BASE="your-admin-secret"
export BOT_TOKEN="your-discord-bot-token"
export ENCORA_GUILD_ID="1518021155376594944"
export ENCORA_LINKED_ROLE_ID="1518032794880573443"

# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f plugin-custom-badges
```

### Running a Single Plugin

Each plugin has its own docker-compose.yml for standalone operation:

```bash
cd plugins/custom-badges
docker-compose up -d
```

See individual plugin READMEs for details.

## Plugin Documentation

- [custom-badges](plugins/custom-badges/README.md) — User badge system
- [discovery-categories](plugins/discovery-categories/README.md) — Category management
- [encora-linking](plugins/encora-linking/README.md) — Encora integration
- [admin-panel](plugins/admin-panel/README.md) — Admin dashboard
- [web-script-injector](plugins/web-script-injector/README.md) — Script injection proxy

## Shared Utilities

All plugins use the following shared utilities (in `shared/`):

- **shared/pg.js** — PostgreSQL connection pool via `createPool()`
- **shared/auth.js** — Admin authentication functions:
  - `checkAdminAuth(req)` — Validate admin request
  - `createSessionCookie(username)` — Create authenticated session
  - `checkBearerToken(req)` — Validate bearer tokens
  - Constants: `ADMIN_SECRET`, `ALLOWED_ADMIN_TOKENS`
- **shared/http.js** — HTTP utilities:
  - `readJsonBody(req)` — Parse JSON request body
  - `readRawBody(req)` — Read raw request body
  - `json(res, status, body)` — Send JSON response

### Using Shared Utilities

From within a plugin's index.js:

```javascript
const { createPool } = require('../../shared/pg');
const { checkAdminAuth } = require('../../shared/auth');
const { json } = require('../../shared/http');

const pool = createPool();

// Use in routes...
```

## Caddy Configuration

Each plugin requires specific Caddy routing. Combine all blocks below in your Caddyfile:

```caddy
# custom-badges — Profile API interception + client script
handle /custom-badges/* { reverse_proxy plugin-custom-badges:8081 }
@profileBadgeProxy path_regexp ^/api(?:/v\d+)?/users/[^/]+/profile$
handle @profileBadgeProxy { reverse_proxy plugin-custom-badges:8081 }
@previewBadgeProxy path_regexp ^/api(?:/v\d+)?/users/@me/profile-badges/preview$
handle @previewBadgeProxy { reverse_proxy plugin-custom-badges:8081 }
handle /admin/plugins/api/badges* { reverse_proxy plugin-custom-badges:8081 }
handle /admin/plugins/api/users* { reverse_proxy plugin-custom-badges:8081 }

# discovery-categories — Category CRUD + guild mapping
handle /api/v1/discovery/categories* { reverse_proxy plugin-discovery-categories:8082 }
handle /api/discovery/categories* { reverse_proxy plugin-discovery-categories:8082 }
handle /categories/* { reverse_proxy plugin-discovery-categories:8082 }
handle /admin/plugins/api/categories* { reverse_proxy plugin-discovery-categories:8082 }
handle /admin/plugins/api/guilds* { reverse_proxy plugin-discovery-categories:8082 }

# encora-linking — Link/unlink user roles
handle /api/admin/users/link-encora* { reverse_proxy plugin-encora-linking:8083 }
handle /api/admin/users/unlink-encora* { reverse_proxy plugin-encora-linking:8083 }

# admin-panel — Login + dashboard UI
handle /admin/plugins { reverse_proxy plugin-admin-panel:8084 }
handle /admin/plugins/login* { reverse_proxy plugin-admin-panel:8084 }
handle /admin/plugins/logout* { reverse_proxy plugin-admin-panel:8084 }
handle /admin/badges* { reverse_proxy plugin-admin-panel:8084 }

# Catch-all with script injection (MUST BE LAST)
handle {
    reverse_proxy plugin-web-script-injector:8080 app-proxy:8080 {
        lb_policy first
        lb_try_duration 1s
        header_down Content-Security-Policy "connect-src " "connect-src wss://livekit.prelude.chat https://livekit.prelude.chat "
        header_down Content-Security-Policy "img-src " "img-src https://encora.it https://*.encora.it "
    }
}
```

## Environment Variables

### Common to All Plugins

| Variable | Example | Required |
|----------|---------|----------|
| `PGHOST` | `postgres` | Yes |
| `PGPORT` | `5432` | Yes |
| `PGDATABASE` | `fluxer` | Yes |
| `PGUSER` | `fluxer` | Yes |
| `PGPASSWORD` | — | Yes |
| `FLUXER_ADMIN_SECRET_KEY_BASE` | — | Yes |

### Plugin-Specific

**encora-linking only:**
- `BOT_TOKEN` — Discord bot token
- `ENCORA_GUILD_ID` — Discord server ID
- `ENCORA_LINKED_ROLE_ID` — Discord role ID

**web-script-injector only:**
- `UPSTREAM_URL` — App proxy address (default: `http://app-proxy:8080`)

## Directory Structure

```
prelude-plugin-runtime/
├── shared/                       # Shared utilities (imported by all plugins)
│   ├── pg.js                    # PostgreSQL pool
│   ├── auth.js                  # Admin auth functions
│   └── http.js                  # HTTP helpers
├── plugins/
│   ├── custom-badges/           # Badge system
│   │   ├── index.js            # Entry point
│   │   ├── Dockerfile
│   │   ├── docker-compose.yml
│   │   ├── package.json
│   │   └── README.md
│   ├── discovery-categories/    # Category system
│   │   ├── index.js
│   │   ├── Dockerfile
│   │   ├── docker-compose.yml
│   │   ├── package.json
│   │   └── README.md
│   ├── encora-linking/          # Encora integration
│   │   ├── index.js
│   │   ├── Dockerfile
│   │   ├── docker-compose.yml
│   │   ├── package.json
│   │   └── README.md
│   ├── admin-panel/             # Admin UI + auth
│   │   ├── index.js
│   │   ├── Dockerfile
│   │   ├── docker-compose.yml
│   │   ├── package.json
│   │   └── README.md
│   └── web-script-injector/     # Catch-all proxy
│       ├── index.js
│       ├── Dockerfile
│       ├── docker-compose.yml
│       ├── package.json
│       └── README.md
├── docker-compose.yml           # Root compose (all plugins)
├── README.md                    # This file
└── AGENTS.md                    # Migration notes
```

## Migration from Monolithic server.js

The original `server.js` (1434 lines) has been split as follows:

| Original Code | New Location |
|---|---|
| Badge routes + image proxy | `plugins/custom-badges/index.js` |
| Category CRUD + guild mapping | `plugins/discovery-categories/index.js` |
| Encora link/unlink routes | `plugins/encora-linking/index.js` |
| Login + admin.html serving | `plugins/admin-panel/index.js` |
| Script injection + catch-all | `plugins/web-script-injector/index.js` |
| Auth functions | `shared/auth.js` |
| DB utilities | `shared/pg.js` |
| HTTP utilities | `shared/http.js` |

## Development

### Creating a New Plugin

1. Create folder: `plugins/new-plugin/`
2. Copy Dockerfile, docker-compose.yml template
3. Write `index.js` (use port next in sequence)
4. Import shared utilities as needed
5. Update root docker-compose.yml
6. Add Caddy routing
7. Document in plugin README

### Testing a Plugin

```bash
# Run standalone with postgres
cd plugins/my-plugin
docker-compose up -d

# Test endpoints
curl http://localhost:8081/health

# View logs
docker-compose logs -f plugin-my-plugin

# Stop
docker-compose down
```

## Networking

All plugins communicate via the external Docker network `fluxer_fluxer`:

- Plugins reach PostgreSQL via hostname `postgres`
- Caddy reverse proxies to containers by service name (e.g., `plugin-custom-badges:8081`)
- Inter-plugin calls use direct hostnames (e.g., `http://plugin-custom-badges:8081/...`)

## Production Deployment

1. **Build images** (optional, using provided Dockerfile):
   ```bash
   docker build -t prelude-plugin-custom-badges:latest plugins/custom-badges/
   ```
   Or let docker-compose pull node:24 base image

2. **Set environment variables** via `.env` file or Docker secrets

3. **Start services**:
   ```bash
   docker-compose up -d
   ```

4. **Configure Caddy** with routes from above

5. **Verify** all plugins are healthy:
   ```bash
   docker-compose ps
   ```

## Troubleshooting

### Plugin not responding

```bash
# Check container status
docker-compose ps plugin-custom-badges

# View logs
docker-compose logs plugin-custom-badges

# Check network connectivity
docker-compose exec plugin-custom-badges curl http://postgres:5432

# Verify environment variables
docker-compose exec plugin-custom-badges env | grep PG
```

### Database connection errors

- Verify `PGHOST`, `PGPORT`, `PGDATABASE` match postgres service
- Check `PGPASSWORD` in .env
- Ensure postgres service is running: `docker-compose ps postgres`

### Admin routes returning 403

- Check `FLUXER_ADMIN_SECRET_KEY_BASE` is set correctly
- Verify session cookie is being set via `/admin/plugins/login`
- Check plugin logs for auth errors

## License

Same as original Prelude project.
