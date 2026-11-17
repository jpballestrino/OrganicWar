#!/bin/sh
# Start the server as the unprivileged `node` user, after making sure it owns
# the data volume. Hosts such as Render mount persistent disks owned by root,
# which would leave the server unable to write its SQLite database.
set -e
DATA_DIR="$(dirname "${DB_PATH:-/data/organicwar.db}")"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" /app/logs
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
