#!/usr/bin/env bash
# Zipy AI — Postgres backup wrapper for on-prem hosts.
#
# Honours DATABASE_URL (loaded from the environment or the env file). Uses
# the pg_dump custom format so restores can be selective. Does not take the
# backup itself into a separate location; the operator's storage layer is
# responsible for off-host retention.
#
# Exit codes:
#   0  backup written
#   1  DATABASE_URL is not set, or pg_dump failed
#   2  the output directory is not writable

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "backup-postgres.sh: DATABASE_URL is not set. Source /etc/zipy/zipy.env or export it first." >&2
  exit 1
fi

out_dir="${ZIPY_BACKUP_DIR:-/var/backups/zipy}"
mkdir -p "${out_dir}"

if [[ ! -w "${out_dir}" ]]; then
  echo "backup-postgres.sh: ${out_dir} is not writable by $(id -un)." >&2
  exit 2
fi

ts="$(date -u +'%Y-%m-%dT%H-%M-%SZ')"
out_file="${out_dir}/zipy-${ts}.dump"

# pg_dump streams to stdout with -f - and reads the connection string from
# DATABASE_URL. The custom format (-Fc) is compressed and can be restored
# selectively with pg_restore.
echo "backup-postgres.sh: writing ${out_file}"
if ! pg_dump --format=custom --no-owner --no-privileges --file="${out_file}" "${DATABASE_URL}"; then
  echo "backup-postgres.sh: pg_dump failed." >&2
  exit 1
fi

if [[ ! -s "${out_file}" ]]; then
  echo "backup-postgres.sh: pg_dump produced an empty file. Removing ${out_file}." >&2
  rm -f "${out_file}"
  exit 1
fi

echo "backup-postgres.sh: done ($(du -h "${out_file}" | cut -f1))"
