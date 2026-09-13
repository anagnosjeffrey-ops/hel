#!/usr/bin/env bash
# Bring up a local Postgres and create the AutoBank role and databases.
# Idempotent: safe to run on every session start.
set -euo pipefail

DB_USER="${AUTOBANK_DB_USER:-autobank}"
DB_PASSWORD="${AUTOBANK_DB_PASSWORD:-autobank}"

if ! command -v psql >/dev/null 2>&1; then
  echo "postgres client not found; skipping database setup" >&2
  exit 0
fi

# Start the cluster if one is installed and down.
if command -v pg_ctlcluster >/dev/null 2>&1; then
  version="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $1}')"
  cluster="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $2}')"
  status="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $4}')"
  if [ -n "${version}" ] && [ "${status}" != "online" ]; then
    pg_ctlcluster "${version}" "${cluster}" start || true
  fi
fi

for _ in $(seq 1 20); do
  if su postgres -c "psql -tAc 'SELECT 1'" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"" \
  | grep -q 1 \
  || su postgres -c "psql -c \"CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}' SUPERUSER\""

for db in autobank autobank_test; do
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${db}'\"" \
    | grep -q 1 \
    || su postgres -c "createdb -O ${DB_USER} ${db}"
done

echo "postgres ready: postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/autobank"
