# Richpanel — Schedule Configuration & Resolution Time Report

A standalone internal tool with two screens. Written for someone who has never
seen this codebase: read section 1 before any code.

---

## 1. Context

**Richpanel is a customer-support platform for ecommerce brands.** Support
agents answer tickets. Agents work shifts, not around the clock — so when a
manager asks *"how long did this ticket really take?"*, the honest answer is not
wall-clock time. A ticket opened Friday 6pm and closed Monday 10am was not
"64 hours slow" if nobody was rostered over the weekend.

This tool answers that question. It has exactly two screens:

| Screen | What you do there |
|---|---|
| **Schedule Configuration** | Create a schedule — a name, an effective date range, and working hours for each weekday (e.g. Mon–Fri 09:00–17:00). Then assign agents to it. |
| **Resolution Time Report** | Type in a ticket's start and end time. Get back every agent's **business hours** — the amount of their own scheduled working time that fell inside that window. |

![Schedule Configuration](frontend/public/screenshots/schedule-edit.png)

![Resolution Time Report](frontend/public/screenshots/resolution-report.png)

### The vocabulary

| Term | Meaning |
|---|---|
| **Agent** | A support person. Seeded into the database; **there is no UI or API to create one**. |
| **Schedule** | A recurring *weekly* pattern (hours per weekday) plus an effective date range. `end_date = null` means ongoing. |
| **Weekday hours** | One time window on one weekday, e.g. Monday 09:00→17:00. Exactly **one window per weekday** — see §6. |
| **Assignment** | A link between an agent and a schedule. One schedule → many agents. One agent → many schedules, **provided their hours never overlap**. |
| **Business hours** | The number the report computes: the intersection of a ticket's open window with an agent's scheduled hours. |
| **Report** | A saved, point-in-time result. The computed numbers are stored, not recomputed on view. |

### A worked example

Alice is on "Day Shift" (Mon–Fri 09:00–17:00). A ticket is open from
**Friday 16:00 to Monday 10:00**.

- Friday 16:00→17:00 = 1 hour
- Saturday, Sunday = 0 (not scheduled)
- Monday 09:00→10:00 = 1 hour

Alice's business hours = **2 hours**, not the 66 hours the clock shows. That
computation, done efficiently for every agent over an arbitrarily long window,
is what this codebase is mostly about.

### Stack

| Half | Stack |
|---|---|
| `backend/` | Python 3.14, FastAPI, SQLAlchemy 2.0 (ORM), psycopg3, Alembic, Postgres 17. Managed by [`uv`](https://docs.astral.sh/uv/). |
| `frontend/` | React 19, TypeScript, Vite 6, Tailwind v4, TanStack Query v5, Radix primitives, react-day-picker. |
| Root | `docker-compose.yml`, `docs/` (design spec + implementation plans). |

---

## 2. Folder structure

### 2.1 Backend

The backend is strictly layered. **The dependency arrow only ever points one
way**, and the whole point of the layout is to make a violation obvious in an
import statement.

```
api/v1/<resource>/  →  services/  →  components/<entity>/  →  domain/
                                                  (domain imports nothing above it)
```

```
backend/
├── app/
│   ├── main.py                  # app assembly: routers, CORS, exception handlers, request-log middleware
│   ├── db.py                    # engine + the two session context managers (read / write)
│   ├── logging_config.py        # structured JSON logging, pinned to INFO
│   │
│   ├── api/v1/<resource>/       # ══ LAYER 1 — HTTP ONLY ═══════════════════════
│   │   ├── router.py            #   URL, verb, status code. Calls ONE service function.
│   │   └── request_response.py  #   Pydantic in/out schemas + request-shape validation (→ 422)
│   │   #  resources: agents, schedules, schedule_agents, reports
│   │
│   ├── services/                # ══ LAYER 2 — BUSINESS LOGIC + TRANSACTIONS ═══
│   │   ├── schedule_service.py  #   create/update/delete a schedule, deletion impact
│   │   ├── assignment_service.py#   assign/unassign, the pre-flight conflict check
│   │   ├── report_service.py    #   generate/read reports (read → compute → write)
│   │   └── _conversions.py      #   ORM row → domain dataclass. The ONLY translation point.
│   │
│   ├── components/<entity>/     # ══ LAYER 3 — PERSISTENCE ═════════════════════
│   │   ├── model.py             #   SQLAlchemy ORM model — table shape only
│   │   └── queries.py           #   every SELECT/INSERT/UPDATE for that table
│   │   #  entities: agents, schedules, schedule_agents, reports
│   │
│   ├── domain/                  # ══ LAYER 4 — PURE ════════════════════════════
│   │   ├── types.py             #   IST, ShiftInput, WeekdayShift (frozen dataclasses)
│   │   ├── business_hours.py    #   the closed-form O(1) calculation
│   │   ├── overlap.py           #   overlap detection (cross-schedule and self)
│   │   └── shift_normalization.py # overnight split / recombine
│   │
│   ├── errors/error.py          # the whole exception hierarchy, one file
│   └── shared/pagination.py     # shared limit/offset dependency
│
├── alembic/versions/            # 0001_initial_schema, 0002_audit_timestamps
├── scripts/seed_agents.py       # idempotent dev seed
├── tests/                       # mirrors app/: domain/ components/ services/ api/
├── docker-entrypoint.sh         # migrate → seed → exec uvicorn
└── pyproject.toml
```

**Why each layer exists**

| Layer | Exists so that… | Rule |
|---|---|---|
| `api/` | HTTP concerns (status codes, JSON shape, pagination params) never leak into business logic. A router body should be 1–3 lines. | May import `services/`. Never touches a session or an ORM model. |
| `services/` | There is exactly one place that owns a **transaction boundary**. This matters enormously here: the overlap check and the write it guards *must* be the same transaction (§6.2), and that is only enforceable if one layer owns both. | May import `domain/` and `components/`. |
| `components/` | SQL lives next to the model it queries, so "how do we read schedules" has one answer, not one per caller. | May import `domain/` types. **Never imports `services/`.** |
| `domain/` | The hardest logic in the system — overnight-shift wrap-around and the closed-form hours math — is unit-testable **with no database at all**. It operates on plain frozen dataclasses, never ORM instances. | **Zero imports from `components/`, `db`, SQLAlchemy, or FastAPI.** |

`components/` and `domain/` never import each other. `services/` depends on
both and is the only thing that translates between them (`_conversions.py`).

### 2.2 Frontend

The frontend deliberately mirrors the same shape, so that moving between the
two halves does not require a different mental model.

```
pages/  →  hooks/  →  api/apiService  →  api/http
              ↑
   components/ and helpers/ are LEAVES — they never import upward
```

```
frontend/src/
├── main.tsx / App.tsx           # bootstrap + routes
│
├── pages/                       # ══ SCREENS — composition only ════════════════
│   ├── schedules/               #   SchedulesPage, ScheduleList/Detail/Form, AssigneeList
│   └── reports/                 #   ReportsPage, ReportForm, AgentHoursTable, ReportHistory
│
├── hooks/                       # ══ SERVER STATE — the ONLY place data is fetched ══
│   ├── queries/                 #   useSchedules, useAgents, useReport, useAssignmentConflicts…
│   ├── mutations/                #   useCreateSchedule, useUpdateSchedule, useAssignAgent…
│   ├── queryKeys.ts             #   every cache key, in one place
│   └── useReportRows.ts         #   view-model shaping (joins agents onto report rows)
│
├── api/                         # ══ TRANSPORT ═════════════════════════════════
│   ├── apiService.ts            #   one typed function per endpoint
│   ├── http.ts                  #   the ONLY module that calls fetch(); owns ApiError + timeout
│   └── types.ts                 #   wire types, mirroring the backend schemas
│
├── components/                  # ══ LEAF — presentational, no data access ══════
│   ├── ui/  datetime/  modals/  feedback/  layout/
│
├── helpers/                     # ══ LEAF — pure functions ══════════════════════
│   ├── time.ts                  #   the float-hours wire format (22.5 == 22:30)
│   ├── weekday.ts               #   0 == Monday
│   └── errors.ts
│
├── context/ToastContext.tsx     # cross-cutting UI state ONLY (see §6.5)
├── lib/queryClient.ts           # retry policy
└── styles/index.css             # design tokens
```

**Why each layer exists**

| Layer | Exists so that… |
|---|---|
| `pages/` | Screens compose; they do not fetch or transport. |
| `hooks/` | Every cache read/write and invalidation is in one layer, so "what goes stale when I do X" is answerable by reading one directory. |
| `api/apiService` | Endpoint shapes are typed once. A backend field rename breaks compilation in one file. |
| `api/http` | Exactly one `fetch` call site in the app — so timeout, error normalisation and the base URL cannot drift. |
| `components/`, `helpers/` | Leaves. A component that fetches its own data is unreusable and untestable; a component here **never imports `apiService`**. |

The `@/` path alias (`vite.config.ts`) exists to make this visible: a page
imports `@/hooks/...`, never `../../api/http`.

---

## 3. Running it

### 3.1 Prerequisites

Pick **one** path — they're alternatives, not a combined checklist. Docker
needs nothing else: Python/`uv` and Node/npm are baked into their own images,
never installed on the host.

| Path | Needs on your machine |
|---|---|
| Docker (§3.2) | Docker Desktop / Colima with Compose v2 — nothing else |
| Local backend (§3.3) | Python 3.14, [`uv`](https://docs.astral.sh/uv/), a reachable Postgres |
| Local frontend (§3.4) | Node 22+, npm |

### 3.2 Docker — the one-command path

Copy both env templates first. Compose reads them via `env_file:` and will fail
without them.

```bash
cp backend/.env.example backend/.env
```

```bash
cp frontend/.env.example frontend/.env
```

Then, from the repo root:

```bash
docker compose --profile frontend up --build
```

| Service | URL | Notes |
|---|---|---|
| postgres | `localhost:55432` | Non-default port so it cannot collide with a local Postgres on 5432. |
| backend | `http://localhost:8000` | Swagger UI at `/docs`, health at `/health`. |
| frontend | `http://localhost:5173` | nginx serving the built SPA. |

> **The frontend sits behind a Compose profile.** Plain `docker compose up --build`
> starts **only** postgres and backend. Use `--profile frontend` as above, or set
> `COMPOSE_PROFILES=frontend` in your shell to make it the default.

On first boot the backend entrypoint runs `alembic upgrade head`, then seeds
5 demo agents **if and only if the agents table is empty**, then execs uvicorn.
Both steps are safe to repeat.

Common tasks:

```bash
docker compose ps
```

```bash
docker compose logs -f backend
```

```bash
docker compose exec postgres psql -U richpanel -d richpanel
```

#### Stopping — and the one command that destroys data

```bash
docker compose down
```

**`down` KEEPS your data.** The named volume `richpanel_pgdata` survives it.

```bash
docker compose down -v
```

**`down -v` DESTROYS the database.** This is the only routine command that
does. Note it is also what you must run if you change `POSTGRES_USER` /
`POSTGRES_PASSWORD` / `POSTGRES_DB`, because Postgres only reads those when
initialising an empty volume — changing them otherwise has no effect.

### 3.3 Local development — backend

```bash
cd backend && uv sync
```

Point `DATABASE_URL` at a database. Against the Compose Postgres from the host,
note the port is **55432** and the host is `localhost` (not `postgres`, which
only resolves inside the Compose network):

```bash
export DATABASE_URL='postgresql+psycopg://richpanel:change_me_local_only@localhost:55432/richpanel'
```

Migrations:

```bash
cd backend && uv run alembic upgrade head
```

Seed the demo agents:

```bash
cd backend && uv run python -m scripts.seed_agents
```

> **It must be `-m scripts.seed_agents`, not `scripts/seed_agents.py`.** The
> project is not installed as a package, so `app` is only importable when the
> backend directory itself is on `sys.path`. `python -m` puts the current
> directory there; `python <path>` puts the *script's* directory (`scripts/`)
> there instead, and the import fails with `ModuleNotFoundError: No module named 'app'`.
> (Inside the container both forms happen to work, because the image sets
> `PYTHONPATH=/app` explicitly. Use the `-m` form everywhere so the habit is right.)

Serve the API:

```bash
cd backend && uv run uvicorn app.main:app --reload --port 8000
```

### 3.4 Local development — frontend

```bash
cd frontend && npm install
```

```bash
cd frontend && npm run dev
```

Vite serves on `http://localhost:5173`. The dev server calls the API at
`VITE_APP_BASE_URL` (default `http://localhost:8000`), so the backend must be
running and that origin must appear in the backend's `CORS_ALLOWED_ORIGINS`.

```bash
cd frontend && npm run build
```

```bash
cd frontend && npm run typecheck
```

### 3.5 Tests

```bash
cd backend && uv run pytest -q
```

**146 passed.** The backend tests need a real Postgres — they are integration
tests by design, since advisory locks and partial unique indexes cannot be
faked. `tests/conftest.py` forces `DATABASE_URL` to `DATABASE_URL_TEST`
(default `postgresql+psycopg://localhost/richpanel_test`) *before* `app.db` is
imported, and truncates every table after each test.

```bash
cd frontend && npx vitest run
```

**171 passed across 7 test files** (jsdom + Testing Library).

### 3.6 Environment variables

`.env` files are **per service** and **never committed**. `.gitignore` ignores
`.env` / `.env.*` and re-includes `!.env.example`.

**`backend/.env`** — loaded by Compose into *both* the `postgres` and `backend`
containers, so the credentials and the connection string cannot drift apart.

| Variable | Read by | Why |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | the `postgres` image entrypoint | Initialise the cluster. Only take effect on an **empty** volume. |
| `DATABASE_URL` | `app/db.py`, Alembic | SQLAlchemy + psycopg3 URL. Host is `postgres` (the Compose service name) inside Docker; `localhost:55432` from the host. |
| `UVICORN_WORKERS` | `docker-entrypoint.sh` | Worker processes. The SQLAlchemy pool is `pool_size=10, max_overflow=5` **per worker**, so keep `workers × 15` under Postgres' `max_connections`. |
| `LOG_LEVEL` | `docker-entrypoint.sh` → uvicorn | uvicorn's level only. The app's own JSON logger is pinned to INFO in `logging_config.py`. |
| `APP_BASE_URL` | backend | Public base URL of the API. |
| `CORS_ALLOWED_ORIGINS` | `app/main.py` | Comma-separated exact origins. **Without the UI's origin here the browser blocks every response** before any app code sees it. Not `*`: credentialed requests cannot use a wildcard. |
| `TZ` | container libc | Aligns container clocks and log timestamps. **Does not change business logic** — that is pinned to IST in code (§6.1). |

**`frontend/.env`**

| Variable | Read by | Why |
|---|---|---|
| `VITE_APP_BASE_URL` | `src/api/http.ts` | Where the browser reaches the API. `localhost:8000`, **not** `http://backend:8000` — Compose service names resolve only between containers, and the browser is outside that network. |
| `TZ` | container libc | Log-timestamp alignment only. |

> **Why the `VITE_` prefix is mandatory.** Vite only exposes variables whose
> names begin with `VITE_` to client code. A variable named `APP_BASE_URL`
> would compile to `undefined` in the bundle — silently, at runtime, with no
> build error. The prefix is also a safety boundary: **everything with it is
> compiled into a public bundle any user can read.** Never put an API key,
> password or database URL in `frontend/.env`.

Compose also reads a few variables from your **shell** (not from `env_file`,
which injects into containers but does not feed `${VAR}` interpolation):
`POSTGRES_HOST_PORT` (55432), `BACKEND_HOST_PORT` (8000), `FRONTEND_HOST_PORT`
(5173), `COMPOSE_PROFILES`.

```bash
BACKEND_HOST_PORT=9000 docker compose up
```

---

## 4. The API

Weekday is `0 = Monday … 6 = Sunday` (matching Python's `datetime.weekday()`).
Times cross the wire as **float hours**: `22.5` means 22:30.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness. |
| `GET` | `/api/v1/agents` | List agents. `limit`/`offset`, plus `q` (ILIKE on name). |
| `GET` | `/api/v1/agents/{id}/schedules` | Schedules this agent is on. |
| `POST` | `/api/v1/schedules` | Create a schedule with its weekday hours. |
| `GET` | `/api/v1/schedules` | List active schedules. |
| `GET` | `/api/v1/schedules/{id}` | One schedule, hours recombined for display. |
| `PUT` | `/api/v1/schedules/{id}` | Update hours (always) plus name/start_date/end_date (partial — only fields sent are changed; `start_date` only while still in the future). |
| `GET` | `/api/v1/schedules/{id}/deletion-impact` | Read-only preview: who gets unassigned. |
| `DELETE` | `/api/v1/schedules/{id}` | Soft-delete, cascading to assignments and hours. |
| `GET` | `/api/v1/schedules/{id}/agents` | Assignees. |
| `POST` | `/api/v1/schedules/{id}/agents` | Assign an agent. |
| `POST` | `/api/v1/schedules/{id}/agents/check` | **Read-only** pre-flight conflict check. |
| `DELETE` | `/api/v1/schedules/{id}/agents/{agent_id}` | Unassign (soft). |
| `POST` | `/api/v1/reports` | Generate + persist a report. |
| `GET` | `/api/v1/reports`, `/api/v1/reports/{id}` | History / one report. |

Every error uses one envelope:

```json
{ "error_code": "validation_error", "message": "request validation failed", "details": [ { "field": "shifts.0", "message": "...", "type": "value_error" } ] }
```

| Status | When |
|---|---|
| `422` | Input validation. Carries `details[]` with a `field` path addressable in a form. |
| `409` | Business-rule conflict (overlap, duplicate assignment). Message string, **no `details`**. |
| `404` | Missing resource. |
| `400` | Business-rule violation needing DB state (`DomainValidationError`). |
| `500` | Generic. Logged server-side with a stack trace; **the body leaks nothing**. |

---

## 5. Data model

| Table | Soft-deletable | Notes |
|---|---|---|
| `agents` | no | Seeded only. Creation is out of scope. |
| `schedules` | `deleted_at` | `start_date` + nullable `end_date` (null = ongoing). |
| `schedule_weekday_hours` | `deleted_at` (cascade only) | `start_time`/`end_time` are Postgres `interval` (duration since midnight), plus `is_overnight_tail`. |
| `schedule_agents` | `deleted_at` | Unassign sets `deleted_at`; it does not delete the row. |
| `resolution_reports` | no | Append-only history. |
| `resolution_report_agent_hours` | no | Stores computed `business_seconds` — a number, not a live reference. |

Two partial unique indexes carry real weight:

```
schedule_weekday_hours_active_uniq (schedule_id, weekday, is_overnight_tail) WHERE deleted_at IS NULL
schedule_agents_active_uniq        (schedule_id, agent_id)                   WHERE deleted_at IS NULL
```

The first enforces one window per weekday (§6.1). The second is what makes
re-assigning an agent after an unassignment possible at all — a plain
`UNIQUE` would be blocked forever by the old soft-deleted row.

---

## 6. Decision log

Terse, one entry per decision: what was decided and why. Sourced from commit
bodies — read `git log` for the full reasoning behind any entry.

### 6.1 Domain

- **IST, system-wide, non-configurable.** Windows are `timestamptz`; converted to IST at one boundary. Fixed two endpoints disagreeing on weekday.
- **Business hours are O(1)**, not a per-day loop. 4 queries whether the window is 1 day or 365.
- **Overnight shifts split at storage** — primary row to 24:00, tail row from 0 the next weekday. Reduces overlap math to same-weekday comparisons.
- **One time window per weekday**, enforced by a unique index plus a Pydantic check (the domain check alone misses non-overlapping same-day windows).
- **24-hour schedules unsupported** — `end_hours` of `0` or `24` both 422.
- **A report can't cover a future window** (422) — would report scheduled hours as history.
- **A schedule can't start in the past** — UI-only. The API itself still accepts it (unfixed, verified).
- **A schedule's `start_date` can't be edited into the past either.** Was checking only the old value's elapsed-ness, not the new one. Fixed.

### 6.2 Data model

- **Soft deletes everywhere via `deleted_at`** — existence history, not value history. Forces the unique index to be partial (`WHERE deleted_at IS NULL`).
- **`created_at` on every table; `updated_at` only where rows mutate post-insert.** Hours edits touch a child table, so `touch_schedule()` bumps the parent explicitly.
- **Every audit timestamp uses the DB clock (`func.now()`)**, not the app clock. Mixing the two let `updated_at` move backwards under real clock skew — proven by a failing test.
- **Overlap prevention is a Postgres advisory lock**, not a DB constraint — transaction-scoped, auto-releases on commit/rollback.
- **The edit-vs-assign race is fixed** with a schedule-scoped advisory lock taken before agent locks in both paths. A real-thread concurrency test proves it.

### 6.3 API

- **One error envelope**: `{error_code, message, details}` — normalizes FastAPI's native shape so `field` is directly addressable.
- **422 for validation, 409 for conflicts, 500 leaks nothing.** Relational rules live in Pydantic now, not a bare `ValueError` that used to 500.
- **`POST /schedules/{id}/agents/check`** — read-only pre-flight so the UI can disable conflicting agents up front. Advisory only; the write re-checks under its own lock.
- **That check was N+1; now batched.** 2005 agents: 687ms → 100ms.
- **`GET /agents` gained `q` search** — without it, an agent past page one was unreachable.
- **A whole-request 422 (`field: "body"`) now has one handler**, `ApiError.bodyError`. Previously only one form handled it; the rest silently swallowed it.

### 6.4 Infrastructure

- **Three containers, three ports, CORS** — not a same-origin proxy. Postgres on 55432 to avoid clashing with a local install.
- **Env files per service, never committed.**
- **Agents seed on first boot only**, guarded by an advisory lock so two replicas can't double-seed.
- **Migrations run on every boot** — unsafe with more than one replica (§8).

### 6.5 Frontend

- **Stack**: React 19, Vite, TS, Tailwind v4, TanStack Query, Radix + react-day-picker, a hand-built time listbox.
- **Layering mirrors the backend**: `pages → hooks → apiService → http`.
- **TanStack Query owns server state; Context holds only cross-cutting UI state** (toasts) — a per-entity Context would be a second source of truth.
- **Mutations never retry** — a timed-out POST may have already succeeded.
- **Cache invalidation is worked out case-wise**, not by widening to a prefix.
- **Two date fields, not a range picker** — a range calendar's restart-on-click silently turned "ongoing" into a real end date.
- **`DateRangePicker` deleted** — fully built but unrendered, a landmine for reintroducing that same bug.
- **`ApiError` normalizes every failure into one typed shape**, including network/timeout (CORS looks identical to offline).
- **Schedule name/dates are now editable in the UI.** Start date locks once elapsed rather than failing silently on submit.
- **The assign picker now searches and paginates** — it used to hard-cap at 50 with no error.
- **An overnight tail is checked against that weekday's own hours client-side** — used to be an opaque 409 on Save.
- **Modal focus now returns to its trigger, not `<body>`.** Root cause: Radix assumes `Dialog.Trigger` owns the trigger, which this app never uses.
- **Visual design is derived from richpanel.com's own computed styles.**

---

## 7. Verified numbers

Everything below was measured on this checkout, not estimated.

| Check | Result |
|---|---|
| `uv run pytest -q` (backend) | **146 passed** |
| `npx vitest run` (frontend) | **171 passed**, 7 files |
| `npx tsc -b --noEmit --force` | clean, no errors |
| `npm run build` | clean |
| `alembic current` | `0002 (head)` |
| Report: 1-day vs 365-day window | **4 queries each**, ~equal time |
| Report: 1 vs 25 distinct schedules | **4 queries each** |
| Assign-agent conflict check, 2005 agents | **7 scans, 100ms** (was 2005+2004 scans, 687ms) |

---

## 8. Known limitations and things not done

Deliberately specific. Do not read this project as finished.

### Correctness

**Effective dates filter *which* schedules apply, but do not *clip* the hours.**
`get_active_agent_schedule_pairs` selects schedules whose `[start_date, end_date]`
overlaps the report window, and the hours calculation then runs over the **whole
window**. A schedule effective for a single day inside a two-month report window
is billed for the entire two months. **Unresolved.**

**"Overlap" is judged on time-of-day only, ignoring effective dates.**
`find_overlaps` compares weekday + time range. Two schedules with identical
hours in completely non-overlapping date ranges (say Jan vs Dec) are therefore
rejected as conflicting, even though no agent could ever work both at once.
`update_schedule`'s own docstring flags this: a date-only edit re-validates
nothing, because no date change can currently create or resolve an overlap.
**Unresolved.**

**Reports exclude soft-deleted schedules entirely.** The report query filters
`Schedule.deleted_at IS NULL` with no reference to the report window, so
regenerating a report over a **past** window omits schedules that were genuinely
active then. **Not done.**

**Editing hours destroys the previous hours permanently.**
`replace_weekday_hours_rows` **hard-deletes** the existing rows and inserts the
new set. There is no value history — a report regenerated after an edit uses
the new hours as though they had always applied. Existing saved reports are
unaffected (they persist computed `business_seconds`, not a live reference).

### Testing

**The end-to-end smoke test was never written** — `tests/test_full_suite_smoke.py`
does not exist. The advisory-lock concurrency test **does now exist**
(`tests/services/test_assignment_service_concurrency.py`, real threads on real
connections) and passes — it reproduces and confirms the fix for the
edit-vs-assign race documented in §6.2.

### Performance

Known N+1s, **measured on this checkout**, none of them touched by the
assign-agent batching fix in §6.3:

| Path | Scenario | Queries | Shape |
|---|---|---|---|
| `list_schedules` | 200 schedules | **201** | 1 list + 1 hours-fetch per schedule |
| `list_assignees` | 51 assignees | **52** | 1 id list + 1 `get_agent` per id |
| `update_schedule` | 50 assignees, no other schedules | **106** | 1 + 2 per assignee |
| `update_schedule` | 50 assignees, each on 1 other schedule | **156** | plus 1 per other schedule |

All of them collapse onto the batching pattern that already exists in
`reports/queries.py::get_weekday_hours_for_schedules` and, since §6.3, in
`schedule_agents/queries.py::get_other_active_schedule_ids_for_agents` — both
already used by the assign-agent conflict check. **Not applied here.**

### API surface

- **The 409 body carries a message string, not structured conflict detail** — `{"error_code":"conflict","message":"agent 1 would have 1 overlapping shift(s)"}`. The `check` endpoint *does* return structured detail, so the UI gets its rich conflict copy from the pre-flight call, not from the rejection.
- **There is no authentication anywhere.** No login, no API keys, no authorization checks. Anyone who can reach the port has full read/write access.

### Infrastructure

- **Secrets are plaintext in `.env`**, and the committed example ships `change_me_local_only`.
- **No TLS** on any service.
- **Migrations run on every container boot**, which races if you run more than one backend replica — two containers can attempt `alembic upgrade head` simultaneously. Fine for one replica; not safe to scale as-is. (The *seed* step is separately guarded by an advisory lock and is safe.)
- **The frontend image's API base URL does not actually take effect.** `docker-compose.yml` passes build arg `VITE_APP_BASE_URL`, but `frontend/Dockerfile` declares `ARG VITE_API_BASE_URL` (`API` vs `APP`). Docker ignores an undeclared build arg, so the app falls back to the hardcoded `http://localhost:8000` in `src/api/http.ts`. Masked locally because that fallback happens to be correct for local dev — but a containerised frontend cannot currently be pointed at any other API host.
- **Vite inlines `VITE_APP_BASE_URL` at build time.** Even once the name mismatch above is fixed, an image built for one environment can't be re-pointed by changing an environment variable — it must be rebuilt, or served through a runtime-config approach.
