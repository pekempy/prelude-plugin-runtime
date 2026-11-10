# Discovery Categories Plugin

Manages discovery categories and guild-to-category mappings. Provides category CRUD operations and admin management of guild assignments.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8082` | Server port |
| `PGHOST` | `postgres` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `fluxer` | Database name |
| `PGUSER` | `fluxer` | Database user |
| `PGPASSWORD` | (required) | Database password |
| `FLUXER_ADMIN_SECRET_KEY_BASE` | (required) | Admin authentication secret |

## API Endpoints

### Public Category Endpoints (No Auth)

**`GET /categories/categories.json`**
- Returns all categories (including hidden) as JSON
- Response: Array of category objects

**`GET /api/v1/discovery/categories`** (and variants: `/v1/discovery/categories`, `/api/discovery/categories`, `/discovery/categories`)
- Returns public discovery categories (filters out hidden categories)
- OPTIONS request returns CORS headers
- Response: Array of `{ id, name }`

### Admin API Endpoints (Requires Admin Auth)

All admin endpoints require a valid `admin_session` cookie (set via admin-panel login).

**`GET /admin/plugins/api/categories`**
- List all categories with server counts
- Response: Array of categories with `id`, `name`, `isDefault`, `hidden`, `serverCount`

**`POST /admin/plugins/api/categories/save`**
- Create or update category
- Body: `{ id?: number, name: string, hidden?: boolean }`
- Response: `{ success: true, categories }`

**`POST /admin/plugins/api/categories/toggle-hidden`**
- Toggle hidden flag for a category
- Body: `{ id: number, hidden?: boolean }`
- Response: `{ success: true, category }`

**`POST /admin/plugins/api/categories/delete`**
- Delete custom category (default categories 0-8 cannot be deleted)
- Reassigns deleted category's guilds to "Other" (ID 8)
- Body: `{ id: number }`
- Response: `{ success: true, categories }`

**`GET /admin/plugins/api/guilds`**
- List all guilds with discovery status
- Response: `{ guilds: Array<{ id, name, icon, description, inDiscovery, discoveryStatus, categoryId }> }`

**`GET /admin/plugins/api/categories/:id/guilds`**
- List guilds assigned to a specific category
- Response: `{ categoryId, guilds: Array<...> }`

**`POST /admin/plugins/api/categories/assign-guild`**
- Assign guild to discovery category
- Creates guild_discovery record if needed
- Body: `{ guild_id: string, category_id: number }`
- Response: `{ success: true }`

**`POST /admin/plugins/api/categories/remove-guild`**
- Remove guild from discovery
- Body: `{ guild_id: string }`
- Response: `{ success: true }`

## Caddy Routing

```caddy
# Public category endpoints
handle /categories/* { reverse_proxy plugin-discovery-categories:8082 }
handle /api/v1/discovery/categories* { reverse_proxy plugin-discovery-categories:8082 }
handle /v1/discovery/categories* { reverse_proxy plugin-discovery-categories:8082 }
handle /api/discovery/categories* { reverse_proxy plugin-discovery-categories:8082 }
handle /discovery/categories* { reverse_proxy plugin-discovery-categories:8082 }

# Admin API
handle /admin/plugins/api/categories* { reverse_proxy plugin-discovery-categories:8082 }
handle /admin/plugins/api/guilds* { reverse_proxy plugin-discovery-categories:8082 }
```

## Data Persistence

- Categories are stored in `discovery-categories.json` in the plugin directory
- Guild-to-category assignments are persisted in PostgreSQL `fluxer_kv` table:
  - `guild_discovery` — main discovery records
  - `guild_discovery_by_status` — status-indexed view for filtering

## Running Standalone

```bash
cd plugins/discovery-categories
npm install
docker-compose up -d
```

## Dependencies

- **pg** — PostgreSQL client
- **shared/auth.js** — Admin authentication helpers
- **shared/pg.js** — Database pool management
- **shared/http.js** — HTTP utilities
