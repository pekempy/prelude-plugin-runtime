#!/bin/sh
set -eu

usage() {
  printf 'Usage: link-encora [--dry-run|--test|--apply] <Fluxer user ID> <Encora slug>\n' >&2
}

mode="--dry-run"
if [ "$#" -gt 0 ]; then
  case "$1" in
    --dry-run|--test|--apply) mode="$1"; shift ;;
  esac
fi
if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

user_id="$1"
slug="$2"
case "$user_id" in
  ''|0*|*[!0-9]*) printf 'Invalid Fluxer user ID.\n' >&2; exit 2 ;;
esac
case "$slug" in
  ''|.|..|*[!A-Za-z0-9._-]*) printf 'Invalid Encora slug. Pass the slug, not a full URL.\n' >&2; exit 2 ;;
esac

slug=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')
domain="encora.it/traders/$slug"
connection_id=$(printf '%s' "$user_id:$domain" | sha256sum | cut -d ' ' -f 1)
partition_key=$(printf '{"__fluxer_type":"bigint","value":"%s"}' "$user_id")
apply=false
rollback=false
if [ "$mode" = "--apply" ] || [ "$mode" = "--test" ]; then apply=true; fi
if [ "$mode" = "--test" ]; then rollback=true; fi

printf '%s\n' "${mode#--}: $user_id -> https://$domain"
exec psql -X --no-psqlrc -v ON_ERROR_STOP=1 \
  -v apply="$apply" \
  -v user_id="$user_id" \
  -v domain="$domain" \
  -v connection_id="$connection_id" \
  -v partition_key="$partition_key" \
  -v rollback="$rollback" \
  -f /plugin/link-encora.sql
