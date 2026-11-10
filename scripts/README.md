# Utility Scripts

This directory contains utility and maintenance scripts for the plugin runtime.

## Scripts

- **api-preload.cjs** — API preload hook that seamlessly bypasses category validation without modifying upstream source or images.

- **backfill-encora-badges.sh** — Backfills Encora badges into the database. Supports `--dry-run` (default), `--test` (preview with rollback), and `--apply` (commit changes) modes.

- **backfill-encora-badges.sql** — SQL script executed by `backfill-encora-badges.sh` to perform the database update.

- **link-encora.sh** — Links a Fluxer user to an Encora trader profile. Requires a user ID and Encora slug, with the same mode options as the backfill script.

- **link-encora.sql** — SQL script executed by `link-encora.sh` to create the user-Encora connection.

- **repatch-plugins.sh** — Restarts the plugin runtime container, reloads Caddy proxy routes, and verifies plugin endpoints are healthy.
