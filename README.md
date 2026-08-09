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
| `services/` | There is exactly one place that owns a **transaction boundary**. This matters enormously here: the overlap check and the write it guards *must* be the same transaction (§6.6), and that is only enforceable if one layer owns both. | May import `domain/` and `components/`. |
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
│   ├── mutations/               #   useCreateSchedule, useAssignAgent, useDeleteSchedule…
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
├── context/ToastContext.tsx     # cross-cutting UI state ONLY (see §7 Frontend)
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

| Path | Needs |
|---|---|
| Docker | Docker Desktop / Colima with Compose v2 |
| Local backend | Python 3.14, [`uv`](https://docs.astral.sh/uv/), a reachable Postgres |
| Local frontend | Node 22+, npm |

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

**124 passed.** The backend tests need a real Postgres — they are integration
tests by design, since advisory locks and partial unique indexes cannot be
faked. `tests/conftest.py` forces `DATABASE_URL` to `DATABASE_URL_TEST`
(default `postgresql+psycopg://localhost/richpanel_test`) *before* `app.db` is
imported, and truncates every table after each test.

```bash
cd frontend && npx vitest run
```

**140 passed across 7 test files** (jsdom + Testing Library).

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
| `GET` | `/api/v1/agents` | List agents (`limit`/`offset`). |
| `GET` | `/api/v1/agents/{id}/schedules` | Schedules this agent is on. |
| `POST` | `/api/v1/schedules` | Create a schedule with its weekday hours. |
| `GET` | `/api/v1/schedules` | List active schedules. |
| `GET` | `/api/v1/schedules/{id}` | One schedule, hours recombined for display. |
| `PUT` | `/api/v1/schedules/{id}` | Update **hours only** (see §8). |
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

The first enforces one window per weekday (§6.4). The second is what makes
re-assigning an agent after an unassignment possible at all — a plain
`UNIQUE` would be blocked forever by the old soft-deleted row.

---

## 6. Decision log

The section to read to understand *why the code looks like this*. Each entry is
**the decision**, **why**, and **what was rejected**. Sourced from the commit
bodies and `docs/superpowers/specs/`; where a decision has no recorded
rationale, that is stated rather than guessed.

### 6.1 Domain

**Timezone is IST, system-wide, non-configurable.**
`app/domain/types.py::IST = ZoneInfo("Asia/Kolkata")` is the single place a zone
is named anywhere in the codebase.
*Why:* ticket windows are stored as `timestamptz` so they remain real
**instants**; the service converts to IST at its own boundary
(`report_service._to_ist`). Before this, `generate_report` returned the naive
datetime it was handed while `get_report` returned whatever the DB session's
`TimeZone` produced — the two disagreed, and report weekdays shifted with the
host's ambient timezone. Pinning the conversion in app code makes the result
independent of the database session.
*Rejected:* per-schedule / configurable timezones (no requirement for a
globally distributed agent base; the constant is the documented extension
point). Also rejected: naive `timestamp` columns, which lose the instant.

**Business hours use a closed-form O(1) calculation, never a per-day loop.**
`domain/business_hours.py` computes: partial first day + partial last day +
`full_weeks × weekly_total` + the ≤6 remainder days looked up by weekday.
*Why:* NFR — an arbitrarily large report window must not cost more. **Measured
on this machine:** a 1-day window and a 365-day window each issue **4 SQL
statements** and take single-digit milliseconds; the query count is also flat as
the number of distinct schedules grows (1 schedule → 4, 25 schedules → 4).
*Rejected:* iterating calendar days in the window, which is O(window length).

**Overnight shifts are split at storage.** A midnight-crossing shift
(22:00→06:00) becomes two ordinary same-day rows: a **primary** ending at
`interval '24:00:00'` on the starting weekday, and a **tail** starting at
`interval '0'` on the next weekday with `is_overnight_tail = true`. Sunday
wraps to Monday by modulo-7. They are recombined for display, so the API and UI
never see the split.
*Why:* it collapses both the overlap check and the hours math back to
same-weekday-only comparisons — no adjacent-day or circular-boundary logic
anywhere in the read path. `24:00:00` rather than `23:59:59` so the two rows are
exactly adjacent with no gap.
*Rejected:* a "week-offset + circular interval" representation requiring
±604800s wraparound comparisons at the Sunday→Monday boundary.
*Related, recorded in `9071922`:* the column type is `interval`, not `time` or
an integer. Postgres `time` accepts `24:00:00` but Python's `datetime.time`
cannot represent it, so it would not round-trip through the driver; a plain
integer round-trips but loses readability in both SQL and Python.

**Exactly one time window per weekday per schedule.**
*Why:* split shifts and lunch breaks are out of scope for this build. Enforced
in two places on purpose — the partial unique index
`(schedule_id, weekday, is_overnight_tail)`, and an explicit check in
`ShiftInputSchema`, because `find_self_overlaps()` does **not** catch it: two
same-weekday windows that do not overlap pass domain validation and then
violate the index, which surfaced as a 500.
*Extension path (documented in the code):* drop that index and delete the
`_reject_duplicate_weekdays` check together.
*Note:* the decision is recorded as out-of-scope; the commits and spec do not
document a deeper rationale for rejecting multiple windows beyond scope.

**24-hour schedules are unsupported.** `end_hours == 0` and `end_hours == 24`
are both rejected with 422 (verified against the running API).
*Why:* `start == end` is a zero-duration shift, and `22:00 → 00:00` normalises
to a primary row plus a **zero-length** overnight tail, which the domain
dataclass rejects. Both previously failed deep in normalisation as a 500. The
error message names the workaround (`23.99`).

**A report cannot cover a future window** (422).
*Why:* a report answers "how many business hours did each agent have while this
ticket was open". A window reaching into the future would report *scheduled
capacity* as *history* — a number that looks perfectly plausible and is wrong,
which is the worst kind of wrong.

**A schedule cannot be created starting in the past.**
*Why:* a schedule declares when people **will** work; you cannot change what
already happened. Past days are genuinely unselectable in the picker (disabled
matcher, not keyboard-reachable), with a submit-time guard for a tab left open
past midnight.
*Honest caveat:* **this is enforced in the UI only.** The API accepts a past
`start_date` and returns 201 — verified. The edit path is deliberately
untouched, so a schedule that legitimately started earlier cannot be
retroactively invalidated.

### 6.2 Data model

**Soft deletes everywhere via `deleted_at`.**
*Why:* two goals — undo of an accidental schedule delete, and an audit trail of
assignment history ("was this agent on this schedule, and when").
*Necessary consequence:* `UNIQUE(schedule_id, agent_id)` had to become a
**partial** unique index `WHERE deleted_at IS NULL`, otherwise re-assigning an
agent after an unassignment would be blocked forever by the old row. Every read
path must filter `deleted_at IS NULL`.
*Scope limit, stated in the spec:* this gives **existence** history, not
**value** history — it records that a row stopped applying, not what it looked
like before an edit.

**`created_at` on every table; `updated_at` only where rows are mutated after
insert.**
*Why (the bug this fixed, commit `f9e4b92`):* `schedules.updated_at` had a
`server_default` and nothing else — set once at insert and never touched, so it
was permanently **exactly equal to `created_at`**. A column that silently lies
is worse than one that is absent, because eventually something displays it as
"last modified" and is believed. `onupdate=func.now()` on the model fixes the
general case, and fires for the Core `update()` statements the queries module
uses, so unassigning an agent now stamps `schedule_agents.updated_at` with no
extra code.
*Why `onupdate` alone was not enough (commit `dab4887`):* editing hours rewrites
rows in the **child** table `schedule_weekday_hours` and never issues an UPDATE
against the `schedules` row — so `onupdate` never fires and "last modified"
would sit at creation time no matter how often the hours changed. Hence an
explicit `touch_schedule()` called from `update_schedule_hours`.
*Deliberately omitted:* `updated_at` on `agents`, `resolution_reports` and
`resolution_report_agent_hours` — those rows are written once and never
mutated, so the column would be permanently equal to `created_at`, which is
precisely the failure mode being fixed.

**Overlap prevention uses a Postgres advisory lock, not a DB constraint.**
`pg_advisory_xact_lock(agent_id)` is taken **inside the same transaction** as
the check and the write.
*Why keyed on `agent_id`:* the invariant is per-agent, so this serialises
exactly the operations that can conflict and nothing else. The
**transaction-scoped** variant is used specifically because it auto-releases on
COMMIT/ROLLBACK — no leaked lock if a process dies mid-flight — and it is the
flavour compatible with PgBouncer transaction pooling if that is ever added.
*Rejected — `EXCLUDE USING gist`:* it can only compare rows within a single
table, and the data is normalised across `schedules` / `schedule_weekday_hours`
/ `schedule_agents`. Making it work would need a trigger-synced denormalised
shadow table; that complexity was judged disproportionate.
*Rejected — `SELECT … FOR UPDATE`:* it only locks rows that already exist, so an
agent's first-ever assignment has nothing to lock and stays racy.
*Accepted trade-off, stated in the spec:* the invariant is only as strong as
this one disciplined write path — report computation trusts it and does not
re-check. See §8 for a case where that trust is currently misplaced.

### 6.3 API

**One error envelope: `{error_code, message, details}`.** FastAPI's native 422
body is `{"detail": [...]}` — a different shape from every other error. It is
normalised in `main.py` so the UI parses **one** shape, and the leading
`body`/`query` segment is dropped from the location tuple so `field` reads as
`shifts.0.start_hours` — directly addressable in a form.

**Validation is 422 with field-level detail; conflicts are 409; 500 leaks
nothing.**
*The fix this encodes (commit `a52fc51`):* five inputs a user could simply type
into the form returned **500** — `start_hours == end_hours`, `end_hours == 0`,
`end_date < start_date`, two windows on one weekday, and out-of-range values.
`ShiftInputSchema` validated each field's *range* but not the *relationships
between* fields, so those fell through to a bare `ValueError` in a domain
dataclass or to a database constraint. Relational rules now live in the Pydantic
schema, at the source, rather than being patched per endpoint.

**A read-only pre-flight conflict check: `POST /schedules/{id}/agents/check`.**
*Why:* the assign dialog asks the backend which agents *cannot* be assigned as
it opens, and renders those rows disabled with the reason ("Already on Day
Shift — Mon 09:00–17:00") — rather than letting the user tick an agent and
discover on submit that it was never possible. It returns **structured** conflict
detail: which schedule, and the exact colliding hours.
*Why POST for a read:* the agent-id list can be long enough to strain a query
string, and a batch of ids is a request body, not a resource path. It remains
side-effect free.
*Why the overlap rule is NOT duplicated client-side:* a second copy of that rule
in TypeScript would be free to drift from the domain layer. The backend gets the
last word.
*Explicitly advisory:* state can change between the check and the write, so
`assign_agent` still performs the real check under its lock. The 409-at-assign
path is untouched.

### 6.4 Infrastructure

**Three containers on three separate ports, with CORS — not a same-origin
reverse proxy.** Every browser call is therefore cross-origin and must be
allowed explicitly via `CORS_ALLOWED_ORIGINS`. Postgres is published on
**55432** rather than 5432 so it cannot collide with a local Postgres.
*Trade-off accepted:* a proxy would remove CORS entirely, but the separate-port
layout keeps each service independently runnable and its logs unmixed.

**Env files per service, never committed.** `backend/.env` is loaded into *both*
the postgres and backend containers, because the credentials and the connection
string are two views of the same thing and must not drift. `.env.example` is the
committed, documented template.

**Agents are seeded on container start when the table is empty.**
*Why:* agent creation is out of scope by requirement, so a fresh database would
otherwise have no agents at all and the report screen would render an empty
table — `docker compose up` would not yield a usable system.
*How it is made safe:* the script takes a **two-argument** advisory lock
(`pg_advisory_xact_lock(ns, key)`), counts the table, and returns without
writing if any agent exists. Postgres keeps single-key and key-pair advisory
locks in separate spaces, so this cannot collide with the `agent_id` lock the
assignment path takes. Two replicas booting simultaneously cannot double-seed.
*Deliberately non-fatal:* a failed seed is logged loudly and startup continues —
it is a convenience problem, not a reason to refuse traffic.

**Migrations run on every boot**, before uvicorn starts, with a bounded retry
loop. Compose already gates startup on Postgres reporting healthy; the retry
covers the narrow window where the probe passes but the server is still
finishing its post-init restart. (See §8 for the multi-replica caveat.)

### 6.5 Frontend

**Stack:** React 19 + Vite + TypeScript + Tailwind v4, TanStack Query v5 for
server state, Radix primitives (Dialog, Popover) + react-day-picker for the
calendar, plus a hand-built ARIA listbox for time — no library ships one.

**Layering `pages → hooks → apiService → http` mirrors the backend**, with
`components/` and `helpers/` as leaves that never import upward. Components
never touch `apiService`.

**TanStack Query owns server state, so React Context holds only cross-cutting
UI state** (toasts). A `SchedulesContext` / `AgentsContext` / `ReportContext` is
explicitly forbidden by design rule R6 in the frontend spec.
*Why:* the TanStack cache is already global. A context wrapping fetched data
would duplicate it and produce two sources of truth that can disagree.
Everything else — schedules, agents, the selected schedule id, the report
window — lives in the query cache or in the URL.

**Mutations never retry.** Queries retry only transient failures (network,
timeout, 5xx) and at most twice.
*Why:* a timed-out POST **may well have succeeded**. Retrying risks a duplicate
schedule or a duplicate assignment. Retrying a 404 or 422 is also pointless — it
turns one failure into four identical ones and a four-times-longer wait.

**Cache invalidation is worked out case-wise, not by widening to a prefix.**
Deleting a schedule is the one mutation whose server-side effect fans out beyond
the entity named in the request — `soft_delete_schedule` cascades to N
unassignments — and the 204 carries no body, so the client is never told whose
assignments went with it.
*Why from the cache, not from the deletion-impact snapshot:* that list is
fetched when the confirm dialog **opens**, and someone may assign another agent
before the user confirms; invalidating from it would miss them. Any cached
agent-schedule list that mentions this schedule is stale by definition. The
tests assert both directions, so the invalidation cannot silently drift back to
a broad prefix.

**Two separate date fields, not a range picker.**
*The bug:* clicking a date reset it as the START and nulled the end — that is
react-day-picker's range semantics, where a click after a complete range begins
a new one. Badly wrong here, because **a null end means ONGOING**, so a stray
click silently turned "1 Jan to 31 Mar" into "runs forever".
*Fixed structurally* rather than by taming the click rule: `start_date` and
`end_date` are distinct API fields, not two halves of one gesture. Each owns its
state so neither can clear the other, "ongoing" is reachable only via the end
field's own Clear, and the two 422 field errors land on the control that caused
them instead of sharing one slot.

**`ApiError` normalises every failure into one typed shape** with a `kind` the
UI switches on — including `network` and `timeout`, which are genuinely
reachable because the API is on a different origin. A CORS rejection is
indistinguishable from being offline; the browser withholds the reason.

**Visual design is derived from richpanel.com's own computed styles** rather
than invented, so the internal tool reads as part of the product: General Sans
(UI), Nohemi (display), ink `#101828`, brand blue `#004E96`, off-whites
`#FAFBFE` / `#FBF7F2`, radii 8/12px. Fonts are **self-hosted** to keep CSP at
`font-src 'self'` and remove a render-blocking third-party request — but the
**binaries are not committed** (see `frontend/public/fonts/README.md`). Until
they are added the UI falls back to the system sans stack: fully usable, just
not on-brand.

---

## 7. Verified numbers

Everything below was measured on this checkout, not estimated.

| Check | Result |
|---|---|
| `uv run pytest -q` (backend) | **124 passed** |
| `npx vitest run` (frontend) | **140 passed**, 7 files |
| `alembic current` | `0002 (head)` |
| `npm run build` / `npm run typecheck` | both clean |
| Report: 1-day vs 365-day window | **4 queries each**, ~equal time |
| Report: 1 vs 25 distinct schedules | **4 queries each** |

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
**Unresolved.**

**Reports exclude soft-deleted schedules entirely.** The report query filters
`Schedule.deleted_at IS NULL` with no reference to the report window, so
regenerating a report over a **past** window omits schedules that were genuinely
active then. The fix is a predicate change (compare `deleted_at` against the
window), not a schema change. **Not done.**

**Editing hours destroys the previous hours permanently.**
`replace_weekday_hours_rows` **hard-deletes** the existing rows and inserts the
new set. There is no value history, so a report regenerated after an edit uses
the new hours as though they had always applied. Existing saved reports are
unaffected — they persist computed `business_seconds`, not a live reference.
(The spec describes this table's edits as an in-place update; the implementation
is delete-and-reinsert. Same practical consequence: no value history.)

**A proven race lets one agent land on two overlapping schedules.**
The advisory lock is keyed on `agent_id`, and **neither `assign_agent` nor
`update_schedule_hours` locks the SCHEDULE**. `update_schedule_hours` locks only
the schedule's *current* assignees — so an agent being added concurrently is not
covered.

Reproduced here with a 2-thread test:

- Agent is on `S1` (Mon 09:00–17:00). `S2` is Mon 20:00–23:00 (no conflict).
- Thread A: `update_schedule_hours(S2 → Mon 10:00–16:00)` — S2 has no assignees, so it locks nothing.
- Thread B: `assign_agent(agent → S2)` — locks the agent, reads S2's *pre-edit* hours, sees no conflict.
- **Both commit.** The agent is now on two overlapping schedules.

Two concurrent `assign_agent` calls for the same agent *are* correctly
serialised — that case works. **Not fixed.**

### Testing

**Plan Task 21 was never executed** — the end-to-end smoke test
(`tests/test_full_suite_smoke.py`) and the advisory-lock concurrency test
(`tests/services/test_assignment_service_concurrency.py`) do not exist. Both
checkboxes are still unticked in the plan. The race above is exactly what that
task would have caught.

### Performance

Known N+1s, **measured on this checkout**:

| Path | Scenario | Queries | Shape |
|---|---|---|---|
| `list_schedules` | 200 schedules | **201** | 1 list + 1 hours-fetch per schedule |
| `list_assignees` | 51 assignees | **52** | 1 id list + 1 `get_agent` per id |
| `update_schedule_hours` | 50 assignees, no other schedules | **106** | 1 + 2 per assignee |
| `update_schedule_hours` | 50 assignees, each on 1 other schedule | **156** | plus 1 per other schedule |

All of them collapse onto the batching pattern that already exists in
`reports/queries.py::get_weekday_hours_for_schedules` (one `WHERE id IN (...)`
returning a dict). **Not applied.** Note the report path itself is already
batched and is flat at 4 queries.

### API surface

- **`PUT /schedules/{id}` updates hours only.** Name, `start_date` and `end_date` are not editable through the API at all. The UI's edit screen therefore renders only the hours editor.
- **The 409 body carries a message string, not structured conflict detail** — `{"error_code":"conflict","message":"agent 1 would have 1 overlapping shift(s)"}`. The `check` endpoint *does* return structured detail, so the UI gets its rich conflict copy from the pre-flight call, not from the rejection.
- **There is no authentication anywhere.** No login, no API keys, no authorization checks. Anyone who can reach the port has full read/write access.

### Infrastructure

- **Secrets are plaintext in `.env`**, and the committed example ships `change_me_local_only`.
- **No TLS** on any service.
- **Migrations run on every container boot**, which races if you run more than one backend replica — two containers can attempt `alembic upgrade head` simultaneously. Fine for one replica; not safe to scale as-is. (The *seed* step is separately guarded by an advisory lock and is safe.)
- **The frontend image's API base URL does not actually take effect.** `docker-compose.yml` passes build arg `VITE_APP_BASE_URL`, but `frontend/Dockerfile` declares `ARG VITE_API_BASE_URL` (`API` vs `APP`). Docker ignores an undeclared build arg, so the app falls back to the hardcoded `http://localhost:8000` in `src/api/http.ts`. This is masked locally because that fallback is the correct value for local development — but a containerised frontend cannot currently be pointed at any other API host.
- **Vite inlines `VITE_APP_BASE_URL` at build time.** Even once the name mismatch is fixed, a production image built for one environment cannot be re-pointed by changing an environment variable — it must be rebuilt, or served through a runtime-config approach.
