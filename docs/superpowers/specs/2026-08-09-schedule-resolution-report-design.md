# Schedule Configuration & Resolution Time Report — Design

Date: 2026-08-09
Status: Draft, pending user review

## 1. Overview

Richpanel is a customer support platform for ecommerce brands. This project adds two screens:

- **Schedule Configuration** — create and manage recurring weekly work schedules, and assign agents to them.
- **Resolution Time Report** — given a ticket's start/end time, show every agent's business hours (their scheduled working time) that falls within that window.

This is a standalone greenfield build (not integrated into Richpanel's real codebase). Agents are seeded directly into the database; agent creation is out of scope.

**Stack:** Python (FastAPI, SQLAlchemy ORM) backend, Next.js + Tailwind CSS frontend, Postgres database.

## 2. Functional Requirements

1. CRUD for schedules (list, create, update, delete).
2. A schedule can be assigned to multiple agents; an agent can be assigned to multiple schedules, as long as those schedules don't overlap for that agent.
3. Given a ticket start/end time, compute the total business hours for every agent within that window.
4. Persist computed reports, with a browsable history.

## 3. Non-Functional Requirements

1. Agent creation is out of scope — agents are seeded.
2. Two things the data model and algorithms are specifically built around:
   - Efficiently computing business hours for all agents, for an arbitrary (potentially very large) time window.
   - Efficiently and correctly preventing overlapping schedule assignments for an agent.

## 4. Key Design Decisions

### 4.1 Timezone: single global timezone

The whole system operates on one timezone. Every schedule's hours and every ticket start/end time are interpreted in that same timezone. Simpler than per-schedule timezones; acceptable given no requirement for a globally distributed agent base was stated. *Open item: which specific timezone (e.g. UTC, or the brand's local timezone) is a config constant to be pinned down before implementation — not yet specified.*

### 4.2 Schedule dating: recurring pattern + effective date range, owned by the schedule

A schedule is a recurring weekly pattern (per-weekday hours) plus an effective date range (`start_date`, optional `end_date`). The date range belongs to the schedule itself, not to each individual assignment — every agent assigned to a schedule shares its effective window.

### 4.3 Live propagation of schedule edits

Editing a schedule's hours applies immediately to every agent currently assigned to it (and to future report computations), rather than being frozen/snapshotted per assignment. This matches how tools like Zendesk business hours behave, and is the expected product behavior for "manage schedules."

**Consequence:** because the overlap-prevention constraint must always compare against *live* schedule data, and Postgres's `EXCLUDE USING gist` can only compare rows within a single table (not across the normalized `schedules` / `schedule_weekday_hours` / `schedule_agents` split), a static DB-level exclusion constraint isn't viable without a trigger-synced denormalized shadow table. That complexity (triggers, a table to keep in sync, harder debugging/testing) was judged disproportionate — see 4.4.

### 4.4 Overlap enforcement: app-level advisory lock, not a DB constraint

**Decision:** overlap prevention (both "does this agent's new assignment conflict with their existing schedules" and "does this schedule's own weekday hours self-conflict") is enforced in application code, inside a transaction guarded by a Postgres advisory lock — not via a DB `EXCLUDE` constraint.

**Why an advisory lock, keyed on `agent_id`:** the invariant being protected ("this agent's assigned schedules don't overlap") is scoped per-agent. Locking on `agent_id` serializes exactly the operations that can actually conflict (two writes touching the same agent) without serializing unrelated operations. `pg_advisory_xact_lock(agent_id)` — the **transaction-scoped** variant — is used specifically because it auto-releases on `COMMIT`/`ROLLBACK`, with no risk of a leaked lock from a crash between lock and manual unlock. This also happens to be the flavor compatible with PgBouncer transaction-pooling mode, if that's ever introduced later.

Row-level locking (`SELECT ... FOR UPDATE` on existing `schedule_agents` rows) was considered and rejected: it only protects *existing* rows, so an agent's first-ever assignment (no row yet to lock) wouldn't be protected against a concurrent race.

**Mechanics:** `BEGIN` → `pg_advisory_xact_lock(agent_id)` (or, for a schedule edit, every currently-assigned agent's id, in sorted order to avoid deadlocks) → read the agent's other active schedules live → compute overlap → conflict found: `ROLLBACK`, return a structured 409 with no write having happened; clean: perform the `INSERT`/`UPDATE`, `COMMIT`. Because the check and the write are the same transaction, there's no separate "preview check" call needed and no redundant re-validation — a failed attempt is safe to retry since nothing was written.

**Accepted trade-off:** the non-overlap invariant is only as strong as this single, disciplined write path (report computation trusts it and does not defensively re-check — see 4.9). This was chosen deliberately: schedule/assignment writes are rare (admin-driven), while report reads are frequent and must stay O(1) per schedule — so complexity was pushed onto the rare write path rather than the frequent, scale-critical read path.

### 4.5 Overnight (midnight-crossing) shifts: split-row normalization

Shifts that cross midnight (e.g. 22:00–06:00) are normalized at write time into two ordinary same-day rows: a **primary** row ending at `end_time = interval '24:00:00'` (end of day) on the starting weekday, and a **tail** row starting at `start_time = interval '0'` on the next weekday (`is_overnight_tail = true`). `24:00:00` (not `23:59:59`) is used specifically so the two rows are exactly adjacent with no gap and exact-duration math.

Time-of-day is represented as Postgres `interval` (duration since midnight), not `time` (point-in-day) or a plain integer — this was a deliberate fix discovered during implementation planning. Postgres's `time` type does support a `24:00:00` boundary value, but Python's `datetime.time` cannot represent it at all (it caps at 23:59:59.999999), so a literal `24:00:00` wouldn't round-trip cleanly through the driver into application code. A plain integer (seconds-since-midnight) avoids that bug but loses SQL-level and in-memory readability (a bare `32400` means nothing without knowing the convention, versus `interval '09:00:00'` / `timedelta(hours=9)` which are self-evident and print naturally). `interval`/Python's `timedelta` avoids both problems at once: `timedelta` has no 24-hour ceiling (unlike `time`), so `24:00:00` round-trips with zero special-casing, while still being exact and human-readable in both SQL and Python. One implementation gotcha to note: Python's built-in `sum()` defaults to a `0` start value, and `0 + timedelta(...)` isn't defined — summing durations requires `sum(durations, start=timedelta())`.

This was chosen over an alternative "week-offset + circular interval overlap" representation (treating each shift as an offset in seconds-from-week-start, requiring ±604800s wraparound comparisons for the Sunday→Monday boundary). Split-row was chosen because it collapses **both** the overlap-check and the business-hours closed-form math back to their pre-overnight-shift simplicity — same-weekday-only comparisons, no adjacent-day or circular-boundary logic anywhere in the read path. The Sunday→Monday week-boundary case disappears entirely as a special case, since weekday indices are already modular (a Sunday tail is structurally identical to any other day's tail).

**Trade-off accepted:** the pairing between a primary and its tail row is an application-level invariant, not DB-enforced (a `CHECK` constraint can't see other rows). Mitigated by funneling all writes through one service function, consistent with 4.4's discipline-based approach. Edits are more involved than a single-row `UPDATE` (may require insert/update/delete across two rows depending on whether the shift starts/stops crossing midnight), and the API must recombine primary+tail rows into one logical shift for display — the frontend never sees the split representation.

**Validated:** this approach was hand-verified against brute-force ground truth across three worked example schedules (a plain day shift, an overnight shift, and a schedule whose overnight shift specifically wraps Sunday→Monday) over a real 15-day window with boundaries deliberately cutting mid-shift. All three matched exactly. See Appendix A.

### 4.6 Soft delete: `deleted_at` on `schedules`, `schedule_agents`, `schedule_weekday_hours`

Chosen for two goals: undo/restore of an accidental schedule delete, and an audit trail of assignment history (when was an agent on a given schedule).

Note on scope: soft-delete gives **existence/period history** ("was this record active, and when"), not **value history** ("what did it look like before an edit"). For `schedule_weekday_hours` specifically, edits remain a plain in-place `UPDATE` (deleted_at is only ever set when the parent schedule is soft-deleted, cascaded) — true value-history would require switching edits to a soft-delete-and-reinsert pattern, which was explicitly deferred as unnecessary complexity for now (see Section 8).

**Necessary consequence:** `UNIQUE(schedule_id, agent_id)` on `schedule_agents` becomes a **partial** unique index, `WHERE deleted_at IS NULL` — otherwise re-assigning an agent after a prior unassignment would be blocked by the old soft-deleted row. Every read path touching `schedules` or `schedule_agents` must filter `WHERE deleted_at IS NULL`.

### 4.7 Schedule deletion policy: cascade-unassign with a preview step

Deleting a schedule cascades to soft-delete its active `schedule_agents` and `schedule_weekday_hours` rows in the same transaction. Because a silent cascade risks an admin unknowingly zeroing out coverage for many agents, the frontend must call a read-only preview endpoint first (`GET /schedules/{id}/deletion-impact`) to show the affected agent count/list before the user confirms.

Deleting a schedule only affects *future* report runs — a saved report stores the computed `business_seconds` number, not a live reference to the schedules that produced it, so historical reports are never corrupted by a later schedule deletion.

### 4.8 Schedule edit policy: single locked transaction, no redundant check

Editing a schedule's weekday hours re-validates against every currently-assigned agent's *other* active schedules, inside the same advisory-locked transaction that performs the write (see 4.4's mechanics). If any agent would end up with an overlap, the transaction rolls back and returns the conflict list (which agents, which colliding schedule) as a 409 — nothing is written. The edit only succeeds once those specific agents are unassigned from *this* schedule (a separate, ordinary unassign call) and the edit is retried.

### 4.9 Report computation trusts the non-overlap invariant

Given the invariant is enforced by the write path (4.4/4.8), the report computation sums each `(agent, schedule)` pair's contribution directly rather than defensively merging/deduping overlapping intervals. This keeps the read path — the one place explicitly required to be fast at scale — as simple as a plain sum, at the cost of assuming the write-path discipline never has a bug or bypass.

## 5. Data Model

```sql
-- Postgres. Soft-deletable tables use deleted_at; every read path must filter WHERE deleted_at IS NULL.

CREATE TABLE agents (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now()
  -- no deleted_at: agent creation/deletion is out of scope; agents are seeded
);

CREATE TABLE schedules (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  start_date    date NOT NULL,
  end_date      date,                       -- null = open-ended
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE schedule_weekday_hours (
  id                 bigserial PRIMARY KEY,
  schedule_id        bigint NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  weekday            smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0=Monday..6=Sunday (matches Python's datetime.weekday())
  start_time       interval NOT NULL,       -- duration since midnight, e.g. '22:00:00'
  end_time         interval NOT NULL,       -- duration since midnight, e.g. '24:00:00' for an overnight primary row
  is_overnight_tail  boolean NOT NULL DEFAULT false,
  deleted_at         timestamptz,             -- set only when the parent schedule is soft-deleted (cascade)
  CHECK (start_time >= interval '0' AND start_time < interval '24:00:00'),
  CHECK (end_time > interval '0' AND end_time <= interval '24:00:00'),
  CHECK (end_time > start_time),
  CHECK (NOT is_overnight_tail OR start_time = interval '0')
);
CREATE UNIQUE INDEX schedule_weekday_hours_active_uniq
  ON schedule_weekday_hours (schedule_id, weekday, is_overnight_tail) WHERE deleted_at IS NULL;

CREATE TABLE schedule_agents (
  id            bigserial PRIMARY KEY,
  schedule_id   bigint NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  agent_id      bigint NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz                   -- unassign = set this, not delete the row
);
CREATE UNIQUE INDEX schedule_agents_active_uniq
  ON schedule_agents (schedule_id, agent_id) WHERE deleted_at IS NULL;

CREATE TABLE resolution_reports (
  id               bigserial PRIMARY KEY,
  ticket_start_at  timestamptz NOT NULL,
  ticket_end_at    timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ticket_end_at > ticket_start_at)
  -- no deleted_at: append-only history, no delete requirement stated
);

CREATE TABLE resolution_report_agent_hours (
  id                bigserial PRIMARY KEY,
  report_id         bigint NOT NULL REFERENCES resolution_reports(id) ON DELETE CASCADE,
  agent_id          bigint NOT NULL REFERENCES agents(id),
  business_seconds  bigint NOT NULL,
  UNIQUE (report_id, agent_id)
);

-- Indexes: schedule_weekday_hours(schedule_id); schedule_agents(agent_id); schedule_agents(schedule_id);
-- resolution_report_agent_hours(report_id)
```

## 6. Business-Hours Algorithm

For a given `(agent, schedule)` pair and report window `[ticket_start_at, ticket_end_at)`:

```
partial_first_day  = overlap of [window_start, next_midnight) with that weekday's row-set
partial_last_day   = overlap of [last_midnight, window_end) with that weekday's row-set
full_days          = calendar days strictly between the two partial days
full_weeks         = full_days // 7
remainder_days     = full_days % 7   (looked up individually by weekday)

business_seconds = partial_first_day + partial_last_day
                  + full_weeks * weekly_total(schedule)
                  + sum(remainder day contributions)
```

`weekly_total(schedule)` (sum of all its weekday-hours row durations) is computed **once per distinct schedule** and reused across every agent assigned to it — cost scales with the number of distinct schedules (small, admin-managed), not with agent count.

**Complexity:** O(1) per `(agent, schedule)` pair — touches at most ~14 rows (a schedule's weekday-hours, worst case with overnight splits) regardless of window length. Total cost per report = O(number of active agent-schedule assignments), completely independent of how large the requested window is. This was the explicit design target given NFR #2.

### Appendix A — Validation

Hand-verified against brute-force ground truth for three schedules over the window `Mon 2026-01-05 23:00:00 → Wed 2026-01-21 03:00:00` (chosen to start and end mid-shift):

| Schedule | Definition | Brute-force | Closed-form |
|---|---|---|---|
| A — Day Shift | Mon–Fri 09:00–17:00 | 88h | 88h |
| B — Night Shift | Mon–Fri 22:00–06:00 (overnight) | 92h | 92h |
| C — Weekend Coverage | Sat 20:00–23:00 + Sun 20:00–Mon 04:00 (wraps the week boundary) | 22h | 22h |

All three matched exactly, including the boundary-clipped shift blocks and the Sunday→Monday wrap.

## 7. High-Level Architecture

Three tiers: **Next.js frontend** (client-side rendered, no SSR needed for an internal admin tool) → **FastAPI backend** (all business logic, validation, locking) → **Postgres**.

**Backend layering:**
- `api/` — HTTP only: parse request, call a service, map results/exceptions to status codes.
- `services/` — business logic and transaction boundaries.
- `domain/` — pure functions, zero I/O and zero SQLAlchemy/DB imports. Operates on its own plain dataclasses (`domain/types.py`), not ORM model instances — so the trickiest logic (overnight-wrap math) is unit-testable without a database, and `services/` is solely responsible for translating ORM rows into domain types and back.
- `components/<resource>/` — SQLAlchemy models and query/CRUD functions per resource.

### Request flows

**Create schedule:** validate input → normalize any midnight-crossing input into primary+tail rows → self-overlap check (a tail row colliding with that weekday's own primary) → insert schedule + weekday-hours rows → response recombines primary+tail into one logical shift per weekday.

**Edit schedule:** `BEGIN` → lock every current assignee's `agent_id` (sorted) → re-check new hours against each assignee's other active schedules → conflict: `ROLLBACK` + 409 with per-agent conflict list; clean: update weekday-hours rows in place, `COMMIT`.

**Delete schedule:** frontend calls the deletion-impact preview → user confirms → `BEGIN` → soft-delete the schedule and cascade `deleted_at` onto its active assignments and weekday-hours rows → `COMMIT`.

**Assign agent → schedule:** `BEGIN` → `pg_advisory_xact_lock(agent_id)` → fetch the agent's other active schedules + the target schedule → check overlap → conflict: `ROLLBACK` + 409; clean: insert the assignment, `COMMIT`.

**Generate report:** validate `start < end` → bounded query (agents LEFT JOIN active schedule_agents LEFT JOIN active schedules filtered by date-range overlap LEFT JOIN schedule_weekday_hours) → compute `weekly_total` once per distinct schedule → per-pair closed-form calculation → sum per agent (0 for unassigned) → persist `resolution_reports` + bulk-insert `resolution_report_agent_hours`.

## 8. API & Module Structure

**Versioning:** URL-prefix based (`/api/v1/...`), applied when `main.py` registers each resource's router — not a literal nested folder wrapping every layer.

**Endpoints:**
- `GET /api/v1/agents`, `GET /api/v1/agents/{id}/schedules`
- `GET|POST /api/v1/schedules`, `GET|PUT /api/v1/schedules/{id}`, `GET /api/v1/schedules/{id}/deletion-impact`, `DELETE /api/v1/schedules/{id}`
- `GET|POST /api/v1/schedules/{id}/agents`, `DELETE /api/v1/schedules/{id}/agents/{agent_id}`
- `POST /api/v1/reports`, `GET /api/v1/reports`, `GET /api/v1/reports/{id}`

List endpoints take `limit`/`offset` (shared `PaginationParams` in `shared/pagination.py`).

**Backend module layout:**
```
app/
  main.py  db.py
  api/v1/{schedules,schedule_agents,agents,reports}/  router.py, request_response.py
  services/  schedule_service.py, assignment_service.py, report_service.py
  domain/    types.py, business_hours.py, overlap.py, shift_normalization.py
  errors/    error.py            -- whole exception hierarchy, one file (each class is a few lines; split only if a
                                      specific error later grows real independent content, e.g. structured conflict detail)
  components/{schedules,schedule_agents,agents,reports}/  model.py, queries.py
tests/
  domain/  components/  services/  api/
```

`domain/` has zero imports from `components/` or `db/` — the dependency direction is one-way: `services/` depends on both `domain/` and `components/`, which never depend on each other.

**Error handling:** a small exception hierarchy (`AppError` → `NotFoundError` (404), `ConflictError` (409, base for `ScheduleOverlapError`/`AssignmentOverlapError`), `DomainValidationError` (400)) mapped centrally via FastAPI exception handlers to a consistent JSON error shape. A catch-all handler logs unexpected exceptions server-side and returns a generic 500 with no internal detail leaked. Structural input validation (types, required fields, simple field rules) lives in Pydantic request schemas (422); semantic validation needing DB state lives in the service layer.

**Explicitly deferred:** PgBouncer (SQLAlchemy's own connection pool already solves same-process TCP reuse; PgBouncer only earns its keep at a many-instance scale this build isn't targeting — though the transaction-scoped advisory lock choice is already compatible with it if added later).

## 9. Testing Strategy

- `domain/` — pure unit tests, no database, covering the overnight-wrap edge cases explicitly (window boundary falling mid-wrap, a schedule's only shift being the Sunday-wrapping one, etc.).
- `services/` / `components/` — integration tests against a real Postgres instance, including concurrency tests for the advisory-lock overlap checks.
- `api/` — end-to-end tests via FastAPI's TestClient.

## 10. Deferred / Future Extensions

Explicitly out of scope for this build, noted so they aren't accidentally assumed:
- Multiple shifts per day (e.g. lunch-break splits) and holiday/date-specific exceptions to a schedule.
- Per-schedule timezones (currently one global timezone system-wide).
- Value-history (not just existence-history) for `schedule_weekday_hours` edits.
- Agent creation/editing (agents are seeded only).
