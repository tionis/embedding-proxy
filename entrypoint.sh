#!/bin/sh
set -e

if [ -n "${LITESTREAM_REPLICA_URL}" ]; then
  # Restore database from replica if it doesn't exist locally
  if [ ! -f "${DB_PATH}" ]; then
    echo "Attempting restore from ${LITESTREAM_REPLICA_URL}..."
    litestream restore -config /etc/litestream.yml -if-replica-exists "${DB_PATH}" \
      || echo "No replica found, starting with fresh database"
  fi

  # Run litestream as a supervisor: it replicates in the background
  # and runs the app as a child process (restarts litestream if app exits)
  echo "Starting with Litestream replication to ${LITESTREAM_REPLICA_URL}"
  exec litestream replicate -exec "bun run /app/index.ts"
else
  echo "LITESTREAM_REPLICA_URL not set — running without replication"
  exec bun run /app/index.ts
fi
