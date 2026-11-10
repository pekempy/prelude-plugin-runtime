# Custom Badges Plugin

Serves custom user badges, intercepts profile API responses to inject badges, and provides an admin API to manage badge settings and user associations.

## Prerequisites

### Database Tables
- `user_badges` — user → badge associations
- `badge_settings` — badge metadata (name, description, rarity, tier)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8081` | Server port |
| `PGHOST` | `postgres` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `fluxer` | Database name |
| `PGUSER` | `fluxer` | Database user |
| `PGPASSWORD` | (required) | Database password |
| `FLUXER_ADMIN_SECRET_KEY_BASE` | (required) | Admin authentication secret |

## Caddy Configuration

Add the following blocks to your Caddyfile:

```caddy
# Custom badges client script + image proxy
handle /custom-badges/* {
    reverse_proxy plugin-custom-badges:8081
}

# Intercept profile API responses to inject badges
@profileBadgeProxy path_regexp ^/api(?:/v\d+)?/users/[^/]+/profile$
handle @profileBadgeProxy {
    reverse_proxy plugin-custom-badges:8081
}

# Intercept badge settings preview
@previewBadgeProxy path_regexp ^/api(?:/v\d+)?/users/@me/profile-badges/preview$
handle @previewBadgeProxy {
    reverse_proxy plugin-custom-badges:8081
}

# Admin API (must come before /admin/plugins catch-all)
handle /admin/plugins/api/badges* {
    reverse_proxy plugin-custom-badges:8081
}

handle /admin/plugins/api/users* {
    reverse_proxy plugin-custom-badges:8081
}
```

## Running Standalone

```bash
cd plugins/custom-badges
docker-compose up -d
```

## API Endpoints

### Client
- `GET /custom-badges/<badgeKey>` — Badge image/metadata
- `GET /api/v1/users/<userId>/badges` — User's active badges
- `POST /api/v1/users/@me/profile-badges/preview` — Preview badge arrangement

### Admin
- `GET /admin/plugins/api/badges` — List all badges
- `POST /admin/plugins/api/badges` — Create badge
- `PUT /admin/plugins/api/badges/<badgeKey>` — Update badge
- `GET /admin/plugins/api/users/<userId>/badges` — User's badges
- `POST /admin/plugins/api/users/<userId>/badges/<badgeKey>` — Assign badge
- `DELETE /admin/plugins/api/users/<userId>/badges/<badgeKey>` — Remove badge

## Dependencies

Standalone operation: only requires PostgreSQL and Caddy routing.

When running with discovery-categories and admin-panel: admin-panel provides the unified UI and handles login.
