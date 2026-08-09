#!/bin/sh
# ════════════════════════════════════════════════════════════════════════════
# Backend container entrypoint.
#
#   1. fail fast if the database URL is missing
#   2. run `alembic upgrade head` — schema is current BEFORE traffic is served
#   3. exec uvicorn (PID 1 handover, so SIGTERM reaches the server)
#
# Compose already gates startup on Postgres reporting healthy
# (`depends_on: condition: service_healthy`). The retry loop below covers the
# narrow window where the health probe passes but the server is still finishing
# its post-init restart, and any transient connection reset during a rolling
# database restart. It is a safety net, not the primary ordering mechanism.
# ════════════════════════════════════════════════════════════════════════════
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set — copy .env.example to .env}"

APP_PORT="${APP_PORT:-8000}"
UVICORN_WORKERS="${UVICORN_WORKERS:-2}"
LOG_LEVEL="${LOG_LEVEL:-info}"

MIGRATION_ATTEMPTS="${MIGRATION_ATTEMPTS:-10}"
MIGRATION_RETRY_DELAY="${MIGRATION_RETRY_DELAY:-2}"

echo "[entrypoint] applying database migrations (alembic upgrade head)"

attempt=1
while : ; do
    if alembic upgrade head; then
        echo "[entrypoint] migrations applied"
        break
    fi

    if [ "${attempt}" -ge "${MIGRATION_ATTEMPTS}" ]; then
        echo "[entrypoint] FATAL: migrations failed after ${attempt} attempts" >&2
        exit 1
    fi

    echo "[entrypoint] migration attempt ${attempt}/${MIGRATION_ATTEMPTS} failed; retrying in ${MIGRATION_RETRY_DELAY}s" >&2
    attempt=$((attempt + 1))
    sleep "${MIGRATION_RETRY_DELAY}"
done

# Agents cannot be created through the API by design (spec NFR #1), so a fresh
# database has no agents at all and the Resolution Time Report would render an
# empty table. Seeding here means `docker compose up` yields a usable system.
#
# The script is idempotent — it takes an advisory lock, counts the table, and
# returns without writing when any agent already exists — so this is safe on
# every restart and with more than one replica booting at once.
#
# Non-fatal on purpose: a failed seed is a convenience problem, not a reason to
# refuse to serve traffic. It is logged loudly instead.
echo "[entrypoint] seeding agents if the table is empty"
if ! python -m scripts.seed_agents; then
    echo "[entrypoint] WARNING: agent seeding failed; continuing to start the API" >&2
fi

echo "[entrypoint] starting uvicorn on 0.0.0.0:${APP_PORT} with ${UVICORN_WORKERS} worker(s)"

# No --reload: this is a production process model.
# --no-access-log: app/main.py already emits a structured JSON line per request
#   (method, path, status_code, duration_ms) via its own middleware; uvicorn's
#   plain-text access log would duplicate that in a second, unparseable format.
# --proxy-headers: honour X-Forwarded-* when a reverse proxy fronts the API.
exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${APP_PORT}" \
    --workers "${UVICORN_WORKERS}" \
    --log-level "${LOG_LEVEL}" \
    --no-access-log \
    --proxy-headers \
    --forwarded-allow-ips='*'
