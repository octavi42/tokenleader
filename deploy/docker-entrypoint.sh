#!/bin/sh
set -e
# If a staged import exists, move it over the DB before the server opens it.
restore_import() {
  DB="${TOKENLEADER_DB:-${TOKENLEADER_DATA_DIR:-/data}/tokenleader.sqlite}"
  if [ -f "${DB}.import" ]; then
    echo "[tokenleader] restoring ${DB}.import -> ${DB}"
    rm -f "${DB}-wal" "${DB}-shm"
    mv "${DB}.import" "${DB}"
  fi
}
if [ "$(id -u)" = "0" ]; then
  # Started as root (docker default, Railway, Fly): fix volume ownership, then drop privileges.
  # Same pattern as official postgres/redis images; removes the RAILWAY_RUN_UID=0 footgun.
  mkdir -p /data
  chown -R bun:bun /data
  restore_import
  exec setpriv --reuid bun --regid bun --init-groups "$@"
fi
restore_import
exec "$@"
