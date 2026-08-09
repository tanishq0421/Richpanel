# Schedule Configuration & Resolution Time Report — Design

Date: 2026-08-09
Status: **Implemented.** Backend and frontend are both built and passing
(124 backend tests, 140 frontend tests). Open items from the original draft have
been resolved and are marked **RESOLVED** inline below, with the rationale that
settled them. Where the implementation diverged from this design, the section
says so — the code is the authority, this document records the reasoning.
Outstanding gaps are tracked in the README's "Known limitations" section.

## 1. Overview

Richpanel is a customer support platform for ecommerce brands. This project adds two screens:

- **Schedule Configuration** — create and manage recurring weekly work schedules, and assign agents to them.
- **Resolution Time Report** — given a ticket's start/end time, show every agent's business hours (their scheduled working time) that falls within that window.

This is a standalone greenfield build (not integrated into Richpanel's real codebase). Agents are seeded directly into the database; agent creation is out of scope.

**Stack:** Python (FastAPI, SQLAlchemy ORM) backend, React + Tailwind CSS frontend, Postgres database.

> **CORRECTION (as built).** The frontend is **React 19 + Vite + TypeScript + Tailwind v4**, not Next.js. This design named Next.js, but the app is a purely client-side internal admin tool with no SSR, no routing-driven data loading and no server components — so Next.js's entire value proposition was unused while still imposing its build and runtime model. Vite gives the same SPA with a fraction of the surface. Server state is **TanStack Query v5**; pickers are **Radix primitives + react-day-picker** (the frontend implementation plan had specified `react-aria-components`; that was reversed during implementation because Radix was already in use for Dialog/Popover, with a hand-built ARIA listbox for time since no library ships one).

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

The whole system operates on one timezone. Every schedule's hours and every ticket start/end time are interpreted in that same timezone. Simpler than per-schedule timezones; acceptable given no requirement for a globally distributed agent base was stated.

> **RESOLVED — the timezone is IST (`Asia/Kolkata`), system-wide and non-configurable.**
>
> Pinned as a hard constant at `app/domain/types.py::IST`. It is the only place a timezone is named anywhere in the codebase, and therefore the single extension point if per-schedule timezones are ever required.
>
> **Rationale.** Ticket windows remain `timestamptz` columns, so they stay real *instants*; `IST` is what maps those instants onto weekday + offset-from-midnight wall-clock math. The conversion happens at the **service boundary** (`report_service._to_ist`), not in the database. This was not a cosmetic choice — it fixed a live defect: `generate_report` returned the naive datetime it was handed while `get_report` returned whatever the DB session's `TimeZone` setting produced, so the two disagreed and report weekdays shifted with the host's ambient timezone. Converting in application code makes the result independent of the session. Soft-delete timestamps moved to `datetime.now(IST)` for the same reason.
>
> **Rejected:** configurable/per-schedule timezones (no stated requirement; deferred, see §10), and naive `timestamp` columns (they discard the instant, so the same wall-clock value means different moments in different zones).
>
> Note the container-level `TZ` env var is *not* this setting. `TZ` only aligns container clocks and log timestamps; changing it does not move the business logic.

### 4.2 Schedule dating: recurring pattern + effective date range, owned by the schedule

A schedule is a recurring weekly pattern (per-weekday hours) plus an effective date range (`start_date`, optional `end_date`). The date range belongs to the schedule itself, not to each individual assignment — every agent assigned to a schedule shares its effective window.

### 4.3 Live propagation of schedule edits

Editing a schedule's hours applies immediately to every agent currently assigned to it (and to future report computations), rather than being frozen/snapshotted per assignment. This matches how tools like Zendesk business hours behave, and is the expected product behavior for "manage schedules."

**Consequence:** because the overlap-prevention constraint must always compare against *live* schedule data, and Postgres's `EXCLUDE USING gist` can only compare rows within a single table (not across the normalized `schedules` / `schedule_weekday_hours` / `schedule_agents` split), a static DB-level exclusion constraint isn't viable without a trigger-synced denormalized shadow table. That complexity (triggers, a table to keep in sync, harder debugging/testing) was judged disproportionate — see 4.4.

### 4.4 Overlap enforcement: app-level advisory lock, not a DB constraint

**Decision:** overlap prevention (both "does this agent's new assignment conflict with their existing schedules" and "does this schedule's own weekday hours self-conflict") is enforced in application code, inside a transaction guarded by a Postgres advisory lock — not via a DB `EXCLUDE` constraint.

**Why an advisory lock, keyed on `agent_id`:** the invariant being protected ("this agent's assigned schedules don't overlap") is scoped per-agent. Locking on `agent_id` serializes exactly the operations that can actually conflict (two writes touching the same agent) without serializing unrelated operations. `pg_advisory_xact_lock(agent_id)` — the **transaction-scoped** variant — is used specifically because it auto-releases on `COMMIT`/`ROLLBACK`, with no risk of a leaked lock from a crash between lock and manual unlock. This also happens to be the flavor compatible with PgBouncer transaction-pooling mode, if that's ever introduced later.

Row-level locking (`SELECT ... FOR UPDATE` on existing `schedule_agents` rows) was considered and rejected: it only protects *existing* rows, so an agent's first-ever assignment (no row yet to lock) wouldn't be protected against a concurrent race.

**Mechanics:** `BEGIN` → `pg_advisory_xact_lock(agent_id)` (or, for a schedule edit, every currently-assigned agent's id, in sorted order to avoid deadlocks) → read the agent's other active schedules live → compute overlap → conflict found: `ROLLBACK`, return a structured 409 with no write having happened; clean: perform the `INSERT`/`UPDATE`, `COMMIT`. Because the check and the write are the same transaction, there is no redundant re-validation on the write path — a failed attempt is safe to retry since nothing was written.

> **AMENDED — a separate read-only pre-flight check WAS added: `POST /api/v1/schedules/{id}/agents/check`.**
>
> This paragraph originally concluded that no "preview check" call was needed. That holds for *correctness* but not for *usability*, which is why the endpoint exists. Without it the assign dialog can only offer every agent and then reject the user's choice on submit — the user discovers a conflict after committing to it. The check lets the dialog render conflicting agents as disabled **with the reason** ("Already on Day Shift — Mon 09:00–17:00"), naming the colliding schedule and hours.
>
> It changes nothing about the locking argument above: the check **writes nothing and takes no lock**, and is explicitly **advisory** — state can change between the check and the write, so `assign_agent` still performs the authoritative check under its own advisory lock and the 409-at-assign path is untouched. The two use the same per-schedule comparison function so they cannot disagree about what counts as a conflict.
>
> `POST` rather than `GET` for a read-only operation: the agent-id list can be long enough to strain a query string, and a batch of ids is a request body, not a resource path.
>
> The overlap rule is deliberately **not** reimplemented client-side — a second copy in TypeScript would be free to drift from the domain layer.

**Accepted trade-off:** the non-overlap invariant is only as strong as this single, disciplined write path (report computation trusts it and does not defensively re-check — see 4.9). This was chosen deliberately: schedule/assignment writes are rare (admin-driven), while report reads are frequent and must stay O(1) per schedule — so complexity was pushed onto the rare write path rather than the frequent, scale-critical read path.

### 4.5 Overnight (midnight-crossing) shifts: split-row normalization

Shifts that cross midnight (e.g. 22:00–06:00) are normalized at write time into two ordinary same-day rows: a **primary** row ending at `end_time = interval '24:00:00'` (end of day) on the starting weekday, and a **tail** row starting at `start_time = interval '0'` on the next weekday (`is_overnight_tail = true`). `24:00:00` (not `23:59:59`) is used specifically so the two rows are exactly adjacent with no gap and exact-duration math.

Time-of-day is represented as Postgres `interval` (duration since midnight), not `time` (point-in-day) or a plain integer — this was a deliberate fix discovered during implementation planning. Postgres's `time` type does support a `24:00:00` boundary value, but Python's `datetime.time` cannot represent it at all (it caps at 23:59:59.999999), so a literal `24:00:00` wouldn't round-trip cleanly through the driver into application code. A plain integer (seconds-since-midnight) avoids that bug but loses SQL-level and in-memory readability (a bare `32400` means nothing without knowing the convention, versus `interval '09:00:00'` / `timedelta(hours=9)` which are self-evident and print naturally). `interval`/Python's `timedelta` avoids both problems at once: `timedelta` has no 24-hour ceiling (unlike `time`), so `24:00:00` round-trips with zero special-casing, while still being exact and human-readable in both SQL and Python. One implementation gotcha to note: Python's built-in `sum()` defaults to a `0` start value, and `0 + timedelta(...)` isn't defined — summing durations requires `sum(durations, start=timedelta())`.

This was chosen over an alternative "week-offset + circular interval overlap" representation (treating each shift as an offset in seconds-from-week-start, requiring ±604800s wraparound comparisons for the Sunday→Monday boundary). Split-row was chosen because it collapses **both** the overlap-check and the business-hours closed-form math back to their pre-overnight-shift simplicity — same-weekday-only comparisons, no adjacent-day or circular-boundary logic anywhere in the read path. The Sunday→Monday week-boundary case disappears entirely as a special case, since weekday indices are already modular (a Sunday tail is structurally identical to any other day's tail).

**Trade-off accepted:** the pairing between a primary and its tail row is an application-level invariant, not DB-enforced (a `CHECK` constraint can't see other rows). Mitigated by funneling all writes through one service function, consistent with 4.4's discipline-based approach. Edits are more involved than a single-row `UPDATE` (may require insert/update/delete across two rows depending on whether the shift starts/stops crossing midnight), and the API must recombine primary+tail rows into one logical shift for display — the frontend never sees the split representation.

**Validated:** this approach was hand-verified against brute-force ground truth across three worked example schedules (a plain day shift, an overnight shift, and a schedule whose overnight shift specifically wraps Sunday→Monday) over a real 15-day window with boundaries deliberately cutting mid-shift. All three matched exactly. See Appendix A.

### 4.6 Soft delete: `deleted_at` on `schedules`, `schedule_agents`, `schedule_weekday_hours`

Chosen for two goals: undo/restore of an accidental schedule delete, and an audit trail of assignment history (when was an agent on a given schedule).

Note on scope: soft-delete gives **existence/period history** ("was this record active, and when"), not **value history** ("what did it look like before an edit"). For `schedule_weekday_hours` specifically, edits are a plain in-place replacement (deleted_at is only ever set when the parent schedule is soft-deleted, cascaded) — true value-history would require switching edits to a soft-delete-and-reinsert pattern, which was explicitly deferred as unnecessary complexity for now (see Section 8).

> **CLARIFICATION (as built).** This section says edits "remain a plain in-place `UPDATE`". The implementation (`schedules/queries.py::replace_weekday_hours_rows`) is a **hard `DELETE` of the schedule's existing rows followed by an `INSERT` of the new set**, in one flush, rather than a row-wise `UPDATE`. The practical consequence is what this section describes and is unchanged — **no value history** — but it is worth stating plainly: the previous hours are destroyed permanently, so a report regenerated after an edit uses the new hours as though they had always applied. Already-saved reports are unaffected, because they persist the computed `business_seconds` number rather than a live reference (see 4.7).
>
> A second consequence, resolved separately: because this rewrites a **child** table and never issues an `UPDATE` against the `schedules` row, SQLAlchemy's `onupdate` on `schedules.updated_at` can never fire. `touch_schedule()` is called explicitly from `update_schedule_hours` to bump it — otherwise "last modified" would sit at creation time no matter how often the hours changed.

**Necessary consequence:** `UNIQUE(schedule_id, agent_id)` on `schedule_agents` becomes a **partial** unique index, `WHERE deleted_at IS NULL` — otherwise re-assigning an agent after a prior unassignment would be blocked by the old soft-deleted row. Every read path touching `schedules` or `schedule_agents` must filter `WHERE deleted_at IS NULL`.

### 4.7 Schedule deletion policy: cascade-unassign with a preview step

Deleting a schedule cascades to soft-delete its active `schedule_agents` and `schedule_weekday_hours` rows in the same transaction. Because a silent cascade risks an admin unknowingly zeroing out coverage for many agents, the frontend must call a read-only preview endpoint first (`GET /schedules/{id}/deletion-impact`) to show the affected agent count/list before the user confirms.

Deleting a schedule only affects *future* report runs — a saved report stores the computed `business_seconds` number, not a live reference to the schedules that produced it, so historical reports are never corrupted by a later schedule deletion.

### 4.8 Schedule edit policy: single locked transaction, no redundant check

Editing a schedule's weekday hours re-validates against every currently-assigned agent's *other* active schedules, inside the same advisory-locked transaction that performs the write (see 4.4's mechanics). If any agent would end up with an overlap, the transaction rolls back and returns the conflict list (which agents, which colliding schedule) as a 409 — nothing is written. The edit only succeeds once those specific agents are unassigned from *this* schedule (a separate, ordinary unassign call) and the edit is retried.

### 4.9 Report computation trusts the non-overlap invariant

Given the invariant is enforced by the write path (4.4/4.8), the report computation sums each `(agent, schedule)` pair's contribution directly rather than defensively merging/deduping overlapping intervals. This keeps the read path — the one place explicitly required to be fast at scale — as simple as a plain sum, at the cost of assuming the write-path discipline never has a bug or bypass.

> **CAVEAT — that assumption is currently violated. The trust is misplaced under concurrency.**
>
> This section's "at the cost of assuming the write-path discipline never has a bug" is not hypothetical. A reproducible race exists, demonstrated with a 2-thread test:
>
> - An agent is on `S1` (Mon 09:00–17:00). `S2` is Mon 20:00–23:00 — no conflict.
> - Thread A calls `update_schedule_hours(S2 → Mon 10:00–16:00)`. Per 4.4's mechanics it locks every **current assignee** of `S2` — and `S2` has none, so it locks nothing.
> - Thread B calls `assign_agent(agent → S2)`. It locks the agent, reads `S2`'s **pre-edit** hours, and correctly sees no conflict.
> - Both commit. The agent is now on two overlapping schedules, and the report will double-count.
>
> The root cause: the advisory lock is keyed on `agent_id`, and **neither write path locks the SCHEDULE**. An agent being *added* concurrently is outside the set `update_schedule_hours` locks. Two concurrent `assign_agent` calls for the same agent *are* correctly serialised — that case works as designed.
>
> Until this is fixed the report can silently double-count. Not fixed; tracked in the README. Task 21 of the implementation plan (the advisory-lock concurrency test) was never executed, which is precisely why this survived to be found later.

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

Three tiers: **React SPA frontend** (client-side rendered, no SSR needed for an internal admin tool) → **FastAPI backend** (all business logic, validation, locking) → **Postgres**.

> **CORRECTION (as built).** Built with **Vite**, not Next.js — see the correction in §1. The reasoning in this very sentence is what settled it: "client-side rendered, no SSR needed" describes an SPA, and Vite delivers exactly that without Next.js's server runtime. Frontend layering mirrors the backend's: `pages → hooks → api/apiService → api/http`, with `components/` and `helpers/` as leaves that never import upward.

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
- `GET|POST /api/v1/schedules/{id}/agents`, `POST /api/v1/schedules/{id}/agents/check`, `DELETE /api/v1/schedules/{id}/agents/{agent_id}`
- `POST /api/v1/reports`, `GET /api/v1/reports`, `GET /api/v1/reports/{id}`

`POST /schedules/{id}/agents/check` was added after this design was first written — the read-only pre-flight conflict check described in the amendment to 4.4. It is the only endpoint that returns **structured** conflict detail (which schedule, which colliding hours); the 409 raised by an actual assign carries a message string only.

**As-built note:** `PUT /api/v1/schedules/{id}` updates **weekday hours only**. Name, `start_date` and `end_date` are not editable through the API. This was not an explicit decision recorded anywhere — it is simply the scope the update path was built to — but it is load-bearing for the frontend, whose edit screen therefore renders only the hours editor, and it is why a schedule that legitimately started in the past cannot be retroactively invalidated.

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

> **STATUS (as built): 124 backend tests and 140 frontend tests pass — but the concurrency tests named above were never written.**
>
> Task 21 of the implementation plan (`backend/tests/test_full_suite_smoke.py` and `backend/tests/services/test_assignment_service_concurrency.py`) was never executed; both files are absent and the plan's checkboxes are unticked. Every existing backend test runs through a single-session fixture, so no test in the suite exercises two genuinely concurrent transactions.
>
> This is not a cosmetic gap. The race documented in the caveat to 4.9 is exactly the property that task was written to cover, and it went undetected until probed manually. **The advisory-lock behaviour this design leans on is, as of now, unverified by the test suite in the one dimension that matters: concurrency.**
>
> One thing the suite does do well, worth preserving: `tests/conftest.py` forces `DATABASE_URL` to the test database *before* `app.db` is imported and then reuses `app.db`'s own engine, rather than constructing a second one. That makes it structurally impossible for the fixture's cleanup and the code under test to target different databases — a defect that existed earlier and was fixed in `de3df59`.

## 10. Deferred / Future Extensions

Explicitly out of scope for this build, noted so they aren't accidentally assumed:
- Multiple shifts per day (e.g. lunch-break splits) and holiday/date-specific exceptions to a schedule.
- Per-schedule timezones (currently one global timezone system-wide — **now pinned to IST**, see 4.1).
- Value-history (not just existence-history) for `schedule_weekday_hours` edits.
- Agent creation/editing (agents are seeded only).

**Added during implementation, confirmed as deliberate:**
- **Round-the-clock (24-hour) schedules are unsupported.** `end_hours == 0` and `end_hours == 24` are both rejected with a 422 naming the field. `start == end` is a zero-duration shift, and `22:00 → 00:00` normalises to a primary row plus a *zero-length* overnight tail, which the domain dataclass rejects. Both previously escaped as 500s. The error message names the workaround (`23.99`).
- **Exactly one time window per weekday per schedule.** Enforced twice on purpose: the partial unique index `(schedule_id, weekday, is_overnight_tail)`, and an explicit check in `ShiftInputSchema`. The second is required because `find_self_overlaps()` does **not** catch it — two same-weekday windows that do not overlap pass domain validation and then violate the index, which surfaced as a 500. **The documented extension path is to drop that index and delete the `_reject_duplicate_weekdays` check together.** The rationale on record is scope only; no deeper argument against multiple windows is documented in the commits or this spec.
- **Reports cannot cover a future window** (422). A window reaching into the future would report *scheduled capacity* as *history* — a plausible-looking, wrong number.
- **Schedules cannot be created starting in the past** — a schedule declares when people *will* work. Enforced **in the UI only**; the API still accepts a past `start_date` and returns 201.

**Known gaps discovered after implementation** (detail and reproduction steps in the README's "Known limitations"):
- A schedule's `start_date`/`end_date` filter *which* schedules apply to a report but do not **clip** the hours, so a schedule effective for one day inside a two-month window is billed for the whole window.
- Overlap is judged on time-of-day only, ignoring effective dates — two schedules with identical hours in non-overlapping date ranges are wrongly rejected as conflicting.
- Report queries exclude soft-deleted schedules unconditionally, so regenerating a report over a *past* window omits schedules that were active then. Fix is a predicate, not a schema change.
- The concurrency race described in the caveat to 4.9.
