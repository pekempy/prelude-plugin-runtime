# Web Script Injector Plugin

A catch-all proxy that injects custom JavaScript and modifies response headers for all HTTP traffic. Acts as the final fallback proxy in the Caddy routing chain, forwarding unmatched requests to the main app proxy while injecting custom scripts and CSP/security headers.

## Prerequisites

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `UPSTREAM_URL` | `http://app-proxy:8080` | Upstream application proxy |
| `PGHOST` | `postgres` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `fluxer` | Database name |
| `PGUSER` | `fluxer` | Database user |
| `PGPASSWORD` | (required) | Database password |
| `FLUXER_ADMIN_SECRET_KEY_BASE` | (required) | Admin authentication secret |

## Caddy Configuration

Add the following block to your Caddyfile (must be LAST):

```caddy
# Catch-all — must be LAST in routing order
handle {
    reverse_proxy plugin-web-script-injector:8080 app-proxy:8080 {
        lb_policy first
        lb_try_duration 1s
        header_down Content-Security-Policy "connect-src " "connect-src wss://livekit.prelude.chat https://livekit.prelude.chat "
        header_down Content-Security-Policy "img-src " "img-src https://encora.it https://*.encora.it "
    }
}
```

## Running Standalone

```bash
cd plugins/web-script-injector
docker-compose up -d
```

## Behavior

This plugin:

1. **Proxies** unmatched requests to upstream (app-proxy:8080)
2. **Injects** custom JavaScript into HTML responses (badges client script, etc.)
3. **Modifies** CSP headers to allow LiveKit and Encora domains
4. **Falls back** to app-proxy if injector is unavailable (via Caddy lb_policy)

## Script Injection

The plugin inspects response content-type and injects `encora-badges.js` into HTML documents:

- Checks for `content-type: text/html`
- Injects `<script src="/custom-badges/encora-badges.js"></script>` before closing `</body>`
- Preserves original response headers and status code

## Note

This plugin must be the **final handle block** in Caddy's routing configuration. All other specific routes (plugins, APIs, etc.) should be defined before this catch-all.
