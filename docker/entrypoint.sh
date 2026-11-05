#!/bin/sh
set -e

PB="/pb/pocketbase"
ARGS="--dir=/pb/pb_data --migrationsDir=/pb/pb_migrations"

# Optional: create/update the PocketBase admin account from environment variables.
if [ -n "$PB_ADMIN_EMAIL" ] && [ -n "$PB_ADMIN_PASSWORD" ]; then
  $PB superuser upsert "$PB_ADMIN_EMAIL" "$PB_ADMIN_PASSWORD" $ARGS >/dev/null \
    && echo "PocketBase admin account ready: $PB_ADMIN_EMAIL"
fi

exec $PB serve --http=0.0.0.0:8090 --publicDir=/pb/pb_public $ARGS
