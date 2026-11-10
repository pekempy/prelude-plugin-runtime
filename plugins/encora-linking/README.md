# Encora Linking Plugin

Manages Discord Encora role linking. Provides endpoints to link/unlink users to the Encora Discord server and assigns the linked role via bot API.

## Prerequisites

### Database Tables
- `user_encora_links` — user → Encora link status (userId, encoraUsername, linkedAt)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8083` | Server port |
| `PGHOST` | `postgres` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `fluxer` | Database name |
| `PGUSER` | `fluxer` | Database user |
| `PGPASSWORD` | (required) | Database password |
| `FLUXER_ADMIN_SECRET_KEY_BASE` | (required) | Admin authentication secret |
| `BOT_TOKEN` | (required) | Discord bot token for role management |
| `ENCORA_GUILD_ID` | (required) | Discord guild/server ID for Encora |
| `ENCORA_LINKED_ROLE_ID` | (required) | Discord role ID assigned to linked users |

## Caddy Configuration

Add the following blocks to your Caddyfile:

```caddy
handle /api/admin/users/link-encora* {
    reverse_proxy plugin-encora-linking:8083
}

handle /api/admin/users/unlink-encora* {
    reverse_proxy plugin-encora-linking:8083
}
```

## Running Standalone

```bash
cd plugins/encora-linking
# Set required environment variables in .env or export them
export BOT_TOKEN="your-discord-bot-token"
export ENCORA_GUILD_ID="1518021155376594944"
export ENCORA_LINKED_ROLE_ID="1518032794880573443"
export POSTGRES_PASSWORD="your-db-password"
export FLUXER_ADMIN_SECRET_KEY_BASE="your-admin-secret"

docker-compose up -d
```

## API Endpoints

### Admin
- `POST /api/admin/users/<userId>/link-encora` — Link user to Encora (with encoraUsername in body)
- `POST /api/admin/users/<userId>/unlink-encora` — Unlink user from Encora
- `GET /api/admin/users/<userId>/encora-status` — Check link status

## Dependencies

- Requires Discord bot token with permission to manage roles
- Requires encora guild and role IDs to exist
- Requires PostgreSQL for persistence
- Admin requests must pass authentication via shared/auth.js
