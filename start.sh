#!/bin/bash
set -a
source /home/sprite/embedding-proxy/.env
set +a
exec bun run /home/sprite/embedding-proxy/index.ts
