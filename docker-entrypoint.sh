#!/bin/sh
set -e
# Migrations normally run as a separate Cloud Run Job before traffic shifts.
# For local containers set RUN_MIGRATIONS=true to apply them on start.
if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "Applying database migrations..."
  ./node_modules/.bin/prisma migrate deploy
fi
exec "$@"
