#!/usr/bin/env bash
# =============================================================================
# DOJCD Connect - apply dojcd_db.sql to a database (convenience wrapper).
#
#   ./database/setup.sh                      # apply to the database named in .env
#   ./database/setup.sh --create-db          # create that database first if it is missing
#   ./database/setup.sh --samples            # also load 8 sample devices (local testing only)
#   DB_NAME=dojcd_test_yourname ./database/setup.sh --create-db --samples   # your own database
#
# Connection: DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME from .env.
# Anything already exported in your shell wins over .env.
#
# You do not need this script. The same thing is:
#   psql -d <dbname> -v ON_ERROR_STOP=1 -f dojcd_db.sql
# and dojcd_db.sql also runs as-is in pgAdmin / DataGrip / DBeaver.
# It is safe on a new, old or already-current database and never drops data.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="$ROOT/dojcd_db.sql"
cd "$ROOT"

SAMPLES=0; CREATE=0
for arg in "$@"; do
  case "$arg" in
    --samples) SAMPLES=1 ;;
    --create-db) CREATE=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

command -v psql >/dev/null || { echo "psql not found - install the PostgreSQL client tools." >&2; exit 1; }
[ -f "$SQL_FILE" ] || { echo "Not found: $SQL_FILE" >&2; exit 1; }

# Read one KEY from .env without sourcing it (values may contain spaces or <>).
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

echo "Target: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

if [ "$CREATE" = 1 ]; then
  exists="$(psql_db postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")"
  if [ -z "$exists" ]; then
    echo "Creating database $DB_NAME ..."
    psql_db postgres -c "CREATE DATABASE \"$DB_NAME\""
  fi
fi

echo "Applying dojcd_db.sql ..."
if [ "$SAMPLES" = 1 ]; then
  # -c and -f run in order in the SAME session, so the setting reaches the file.
  psql_db "$DB_NAME" -c "SET dojcd.with_samples = 'on'" -f "$SQL_FILE"
else
  psql_db "$DB_NAME" -f "$SQL_FILE"
fi
