#!/usr/bin/env bash
# =============================================================================
# DOJCD Connect — set up / update a database to the shared template.
#
#   ./database/setup.sh                       # apply schema.sql, then verify
#   ./database/setup.sh --seed                # ... also load departments + sample devices
#   ./database/setup.sh --create-db --seed    # create the database first if it is missing
#   ./database/setup.sh --verify-only         # just compare, change nothing
#
# Connection: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME from .env.
# Anything already exported wins, so each developer can use their own database:
#   DB_NAME=dojcd_test_lunga ./database/setup.sh --create-db --seed
#
# Safe on a new, old or already-current database. It never drops data.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SEED=0; CREATE=0; VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    --create-db) CREATE=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

command -v psql >/dev/null || { echo "psql not found — install the PostgreSQL client tools." >&2; exit 1; }

# Read one KEY from .env without sourcing it (values may contain spaces / <>).
env_get() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | head -n1 | cut -d= -f2- | tr -d '\r' | sed -E "s/^['\"]//; s/['\"]$//"
}

DB_HOST="${DB_HOST:-$(env_get DB_HOST)}";         DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-$(env_get DB_PORT)}";         DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-$(env_get DB_USER)}";         DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-$(env_get DB_PASSWORD)}"
DB_NAME="${DB_NAME:-$(env_get DB_NAME)}"
[ -n "$DB_NAME" ] || { echo "DB_NAME is not set (.env or environment)." >&2; exit 1; }

export PGPASSWORD="$DB_PASSWORD"
psql_db() { psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$1" -v ON_ERROR_STOP=1 -q "${@:2}"; }
# schema/seed: hide "already exists, skipping" chatter, still show warnings.
psql_quiet() { PGOPTIONS="-c client_min_messages=warning" psql_db "$@"; }

echo "Target: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

if [ "$CREATE" = 1 ]; then
  exists="$(psql_db postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")"
  if [ -z "$exists" ]; then
    echo "Creating database $DB_NAME ..."
    psql_db postgres -c "CREATE DATABASE \"$DB_NAME\""
  fi
fi

if [ "$VERIFY_ONLY" = 0 ]; then
  echo "Applying database/schema.sql ..."
  psql_quiet "$DB_NAME" -f database/schema.sql
  if [ "$SEED" = 1 ]; then
    echo "Applying database/seed.sql ..."
    psql_quiet "$DB_NAME" -f database/seed.sql
  fi
fi

echo "Verifying ..."
psql_db "$DB_NAME" -f database/verify_schema.sql
