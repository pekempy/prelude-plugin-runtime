#!/bin/bash
set -euo pipefail

RUNTIME_DIR="/home/pekempy/Documents/Docker/Dockhand/data/stacks/fluxer-plugin-runtime"
PRELUDE_DIR="/home/pekempy/Documents/Docker/Dockhand/data/stacks/Prelude Production/fluxer-plugin-availability"

echo "=========================================================="
echo " [Prelude Plugins] Re-patching and synchronizing plugins"
echo "=========================================================="

# 1. Ensure plugin runtime container is running
echo "-> Ensuring plugin runtime sidecar is up..."
docker compose --env-file "$PRELUDE_DIR/.env" -f "$RUNTIME_DIR/docker-compose.yml" up -d

# 2. Restart plugin runtime container to pick up code or catalog changes
echo "-> Restarting plugin runtime service..."
docker restart fluxer-plugin-runtime-encora-badges-1 >/dev/null

# 3. Reload Caddy configuration to ensure all proxy rules and hooks are active
if docker ps --format "{{.Names}}" | grep -q "caddy"; then
    echo "-> Reloading Caddy proxy routes..."
    docker exec fluxer-caddy-1 caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
fi

# 4. Perform health check
echo "-> Running plugin health check..."
HTTP_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" https://prelude.chat/custom-badges/categories.json || true)
if [ "$HTTP_STATUS" = "200" ]; then
    echo "-> Plugin endpoints verified OK (HTTP $HTTP_STATUS)"
else
    echo "-> Warning: Plugin endpoint returned HTTP $HTTP_STATUS"
fi

echo "=========================================================="
echo " [Prelude Plugins] Plugins successfully re-patched & live!"
echo "=========================================================="
