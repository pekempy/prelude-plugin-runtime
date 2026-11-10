#!/bin/sh
set -eu

usage() {
  printf 'Usage: backfill-encora-badges [--dry-run|--test|--apply]\n' >&2
}

mode="--dry-run"
if [ "$#" -gt 0 ]; then
  case "$1" in
    --dry-run|--test|--apply) mode="$1"; shift ;;
    *) usage; exit 2 ;;
  esac
fi
if [ "$#" -ne 0 ]; then
  usage
  exit 2
fi

apply=false
rollback=false
if [ "$mode" = "--apply" ] || [ "$mode" = "--test" ]; then apply=true; fi
if [ "$mode" = "--test" ]; then rollback=true; fi

printf 'Running Encora badge backfill in %s mode...\n' "${mode#--}"
exec psql -X --no-psqlrc -v ON_ERROR_STOP=1 \
  -v apply="$apply" \
  -v rollback="$rollback" \
  -f /plugin/backfill-encora-badges.sql
