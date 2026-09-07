#!/bin/sh
# Bring the database schema up to date before the app opens a connection pool.
# A deploy that cannot migrate itself is a deploy that fails at 3am.
set -e

echo "[entrypoint] applying database schema"
if [ -d prisma/migrations ]; then
  npx prisma migrate deploy || {
    echo "[entrypoint] migrate deploy failed, falling back to db push"
    npx prisma db push --accept-data-loss --skip-generate
  }
else
  npx prisma db push --accept-data-loss --skip-generate
fi

echo "[entrypoint] starting: $*"
exec "$@"
