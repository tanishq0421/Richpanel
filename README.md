# Richpanel — Schedule & Resolution Time Report

Monorepo. One command builds and runs the whole stack.

```bash
cp .env.example .env
docker compose up --build
```

That brings up:

| Service    | What it is                          | Host URL                              |
| ---------- | ----------------------------------- | ------------------------------------- |
| `postgres` | Postgres 17.6 (alpine), own volume  | `localhost:55432`                     |
| `backend`  | FastAPI on uvicorn                  | <http://localhost:8000>               |
| `frontend` | Defined but **inactive** (profiled) | <http://localhost:5173> once enabled  |

Check it is alive:

```bash
curl http://localhost:8000/health          # {"status":"ok"}
curl http://localhost:8000/api/v1/agents
open http://localhost:8000/docs            # interactive OpenAPI UI
```

---

## How it runs

### Startup ordering

`postgres` has a real `healthcheck` (`pg_isready` over TCP, not the unix socket —
the official image runs a throwaway socket-only server during first-boot
`initdb`, and a socket check would go green against *that*). The backend declares
`depends_on: postgres: condition: service_healthy`, so its container is not even
created until Postgres genuinely accepts TCP connections.

### Migrations

`backend/docker-entrypoint.sh` runs `alembic upgrade head` and only then `exec`s
uvicorn. There is no hand-run migration step — the schema is always current
before the first request is served. `exec` matters: uvicorn becomes PID 1 so
`docker compose stop` delivers SIGTERM to the server itself.

### The image

`backend/Dockerfile` is multi-stage. The builder installs the locked dependency
set with `uv sync --frozen --no-dev` into `/opt/venv`; the runtime stage copies
only that venv plus application source. `uv`, its cache, the dev dependency
group (`pytest`, `httpx`, `pytest-cov`) and `tests/` never reach the final
image. It runs as the unprivileged `app` user (uid/gid 10001) and carries a
`HEALTHCHECK` that hits `/health` through the stdlib, so no `curl` is installed.

---

## Common tasks

```bash
docker compose up --build -d        # build + start in the background
docker compose logs -f backend      # follow API logs (structured JSON)
docker compose ps                   # health status of each service
docker compose down                 # stop; DATA IS KEPT
docker compose restart backend      # re-run migrations + restart the API

# Seed dev agents. Must be invoked as a module — the project is not installed
# as a package, so a file path will not resolve its imports.
docker compose exec backend python -m scripts.seed_agents

# psql into the containerised database
docker compose exec postgres psql -U richpanel -d richpanel
# ...or from the host, on the non-default port:
psql -h localhost -p 55432 -U richpanel richpanel
```

> **Destroying data.** `docker compose down` keeps the `richpanel_pgdata` volume.
> Only `docker compose down -v` (or `docker volume rm richpanel_pgdata`) wipes
> it. Run that deliberately, never as a reflex — and note it is also what you
> must do if you change `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`,
> since those only take effect on an uninitialised volume.

### Why port 55432?

Developer machines very often already run a local Postgres on 5432. The compose
Postgres publishes on **55432** so the two never collide, and it uses its own
named volume so neither can touch the other's data. Inside the compose network
the port is still the normal 5432 — that is what `DATABASE_URL` uses.

### Running the tests

Tests are excluded from the runtime image on purpose. Run them on the host:

```bash
cd backend && uv run pytest
```

---

## Adding the frontend later

There is no `frontend/` application yet — only `frontend/Dockerfile`, a
documented multi-stage template (Node build → nginx static serve, with SPA
history fallback and sane cache headers). The compose service already exists but
sits behind a **profile**, which is why `docker compose up --build` works today
with no frontend code present.

1. Scaffold the app into `frontend/` (e.g. `npm create vite@latest .`), making
   sure `package.json` **and** `package-lock.json` are committed.
2. Check the assumptions at the top of `frontend/Dockerfile` — package manager,
   build output directory (`BUILD_OUTPUT_DIR`, default `dist`), and the env var
   name your framework uses for the API base URL.
3. Activate it. Either per-command:

   ```bash
   docker compose --profile frontend up --build
   ```

   or permanently, with **one line in `.env`**:

   ```dotenv
   COMPOSE_PROFILES=frontend
   ```

   after which plain `docker compose up --build` starts all three services.

The API base URL is injected at **build** time (`VITE_API_BASE_URL`, sourced
from `APP_BASE_URL`) because a compiled static bundle cannot read container
environment variables at runtime.

---

## Environment variables

Copy `.env.example` → `.env`. `.env` is git-ignored and must never be committed;
`.env.example` is the documented template and carries placeholders only.

| Variable             | Consumed by                       | Purpose                                                                 | Example                                                             | Required          |
| -------------------- | --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------- |
| `POSTGRES_USER`      | postgres entrypoint               | DB superuser created on first boot                                       | `richpanel`                                                          | yes               |
| `POSTGRES_PASSWORD`  | postgres entrypoint               | Password for that user                                                   | `change_me_local_only`                                               | yes               |
| `POSTGRES_DB`        | postgres entrypoint               | Database created on first boot                                           | `richpanel`                                                          | yes               |
| `POSTGRES_HOST_PORT` | compose port mapping              | Host port for the containerised DB; avoids clashing with a local 5432    | `55432`                                                              | no (`55432`)      |
| `DATABASE_URL`       | `backend/app/db.py`, `alembic/env.py` | SQLAlchemy/psycopg3 URL. Host is `postgres` (the service name)       | `postgresql+psycopg://richpanel:change_me_local_only@postgres:5432/richpanel` | yes       |
| `BACKEND_HOST_PORT`  | compose port mapping              | Host port for the API (container always listens on 8000)                 | `8000`                                                               | no (`8000`)       |
| `UVICORN_WORKERS`    | `docker-entrypoint.sh`            | uvicorn worker processes                                                 | `2`                                                                  | no (`2`)          |
| `LOG_LEVEL`          | `docker-entrypoint.sh` → uvicorn  | uvicorn server log level. **Does not** change the app's JSON logger      | `info`                                                               | no (`info`)       |
| `APP_BASE_URL`       | compose → frontend build arg      | Public origin the API is reachable at; baked into the frontend bundle    | `http://localhost:8000`                                              | no (`http://localhost:8000`) |
| `TZ`                 | all containers (glibc)            | Container system timezone, for log timestamps                            | `Asia/Kolkata`                                                       | no (`Asia/Kolkata`) |
| `FRONTEND_HOST_PORT` | compose port mapping              | Host port for the frontend; inert until the profile is enabled           | `5173`                                                               | no (`5173`)       |

Two things worth knowing:

- **`DATABASE_URL` duplicates the `POSTGRES_*` credentials.** They are separate
  settings so that pointing the backend at an external managed database is a
  one-line change. If they drift apart the backend fails at startup with an
  authentication error.
- **`TZ` does not drive business logic.** `backend/app/domain/types.py` pins the
  business timezone as a hard constant, `IST = ZoneInfo("Asia/Kolkata")`. Every
  schedule weekday/offset and ticket window is interpreted in IST regardless of
  `TZ`. Keeping `TZ` aligned only keeps container log timestamps unsurprising.
