# Custom Badges Plugin

Serves custom user badges, intercepts profile API responses to inject badges, and provides an admin API to manage badge settings and user associations.

## Prerequisites

### Database Tables
- `plugin_custom_badges` — badge definitions
- `plugin_user_badges` — user badge assignments, including whether the assignment is role-managed
- `plugin_badge_role_links` — badge-to-guild/role configuration
- `plugin_user_badge_role_assignments` — per-user sources for role-managed badges

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
| `BOT_TOKEN` | (required) | Bot token used to list the Bot's servers and roles for badge configuration |
| `BADGE_SYNC_TOKEN` | (optional) | Dedicated role-sync credential; if omitted, `BOT_TOKEN` is used |
| `API_URL` | `http://api:8080` | Internal Fluxer API URL used by the role picker |

By default, the role-sync route authenticates with `BOT_TOKEN`, which must match the Bot's `FLUXER_BOT_TOKEN`. `BADGE_SYNC_TOKEN` is an optional dedicated override; if set, use the same value in both environments. Role-list choices are fetched with `BOT_TOKEN`. Existing members are reconciled on their next Bot join or role-update snapshot.

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
- `GET /admin/plugins/api/badges/guilds` — list servers available to the Bot
- `GET /admin/plugins/api/badges/guilds/<guildId>/roles` — list a server's roles
- `GET /admin/plugins/api/badges/<badgeId>/role-links` — list a badge's linked roles
- `POST /admin/plugins/api/badges/<badgeId>/role-links` — link a server role to a badge
- `DELETE /admin/plugins/api/badges/<badgeId>/role-links/<linkId>` — remove a role link
- `POST /admin/plugins/api/badges/role-sync` — authenticated Bot role snapshot; requires `Authorization: Bearer <BADGE_SYNC_TOKEN>`

### Role-linked assignments

In the badge detail view, admins can link one or more roles from a single server to a badge. The first linked role makes existing assignments role-managed. The Bot posts full member role-ID snapshots to `POST /admin/plugins/api/badges/role-sync`; a badge remains assigned while any linked role in that server is present. Manual assignments can be created afterward as exceptions.

The role-sync route is not public; it accepts a bearer credential. Use matching Bot tokens by default, or set the same dedicated `BADGE_SYNC_TOKEN` in both environments. Existing members are reconciled when the Bot next sends a join or role-update snapshot.

The role-link tables and assignment-source column are added idempotently when the custom-badges service starts.

## Dependencies

Standalone profile badge serving requires PostgreSQL and Caddy. Linked-role configuration also needs `BOT_TOKEN` for server/role pickers; `BADGE_SYNC_TOKEN` is an optional dedicated sync credential.

When running with discovery-categories and admin-panel: admin-panel provides the unified UI and handles login.
