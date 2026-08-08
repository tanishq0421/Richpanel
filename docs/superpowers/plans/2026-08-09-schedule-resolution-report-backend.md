# Schedule Configuration & Resolution Time Report — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the FastAPI + SQLAlchemy + Postgres backend for Schedule Configuration and Resolution Time Report, per `docs/superpowers/specs/2026-08-09-schedule-resolution-report-design.md`.

**Architecture:** Layered backend — `domain/` (pure functions, zero I/O) → `components/<resource>/` (SQLAlchemy models + query functions) → `services/` (transaction boundaries, orchestration) → `api/v1/<resource>/` (HTTP routing, request/response schemas). `errors/error.py` holds the shared exception hierarchy. This plan covers the backend only; frontend is a separate, later plan.

**Tech Stack:** Python 3.12, `uv` for dependency management, FastAPI, SQLAlchemy 2.0 (ORM), Alembic (migrations), Postgres, `psycopg[binary]` (v3 driver), pytest, httpx (FastAPI TestClient).

## Global Constraints

- All backend code lives under `~/Desktop/Richpanel/backend/`.
- Every Postgres write path that must prevent overlapping agent schedules (assignment, schedule edit) uses `pg_advisory_xact_lock(agent_id)` inside the same transaction as the read-then-write — never a separate check call. See spec §4.4.
- Two DB session context managers, not one: `db_session_read` (no commit, closed immediately after use — never held open across computation) and `db_session_write` (commits on clean exit, rolls back on exception). **Exception, and it must stay documented at each call site:** the advisory-lock flows (`assignment_service.assign_agent`, `schedule_service.update_schedule_hours`) use `db_session_write` for *both* the read-side overlap check and the write — never `db_session_read` for the check portion — because the lock only protects a write that happens in the same transaction as the check.
- `domain/` modules never import from `components/`, `db.py`, or any SQLAlchemy/psycopg symbol. They operate only on the dataclasses defined in `domain/types.py`.
- Time-of-day is represented as Postgres `interval` / Python `timedelta` throughout (never `datetime.time`, never a raw int) — see spec §4.5 for why.
- Weekday convention: `0=Monday .. 6=Sunday`, matching Python's `datetime.weekday()`.
- Every read query against `schedules` or `schedule_agents` filters `WHERE deleted_at IS NULL` (or the ORM equivalent).
- No placeholders: every step below has complete, runnable code.

---

## File Structure

```
backend/
  pyproject.toml
  alembic.ini
  alembic/
    env.py
    versions/0001_initial_schema.py
  app/
    main.py
    db.py
    logging_config.py
    shared/
      pagination.py
    errors/
      error.py
    domain/
      types.py
      shift_normalization.py
      overlap.py
      business_hours.py
    components/
      agents/       model.py, queries.py
      schedules/    model.py, queries.py
      schedule_agents/  model.py, queries.py
      reports/      model.py, queries.py
    services/
      _conversions.py
      schedule_service.py
      assignment_service.py
      report_service.py
    api/v1/
      agents/           router.py, request_response.py
      schedules/        router.py, request_response.py
      schedule_agents/  router.py, request_response.py
      reports/          router.py, request_response.py
  scripts/
    seed_agents.py
  tests/
    conftest.py
    test_logging_config.py, test_request_logging.py
    domain/       test_types.py, test_shift_normalization.py, test_overlap.py, test_business_hours.py
    components/   test_agents_queries.py, test_schedules_queries.py, test_schedule_agents_queries.py, test_reports_queries.py
    services/     test_schedule_service.py, test_assignment_service.py, test_report_service.py
    api/          test_agents_api.py, test_schedules_api.py, test_schedule_agents_api.py, test_reports_api.py
```

The `backend/app/**/__init__.py` and `backend/tests/**/__init__.py` files already exist from the earlier scaffold — no task below re-creates them.

---

### Task 1: Project setup — `uv`, dependencies, FastAPI skeleton, health check, JSON logging

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/app/logging_config.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_health.py`, `backend/tests/test_logging_config.py`

**Interfaces:**
- Produces: a runnable FastAPI app object `app` importable as `app.main:app`, with `GET /health` returning `{"status": "ok"}`; `app.logging_config.JsonFormatter` (a `logging.Formatter` subclass emitting one JSON object per line, merging any `extra={...}` fields passed to a log call into the top-level JSON payload); `app.logging_config.configure_logging(level: int = logging.INFO) -> None`.

Every later task that logs (schedule_service, assignment_service, report_service, the Task 16 request middleware) depends on this formatter's `extra`-merging behavior — a call like `logger.info("x", extra={"duration_ms": 12.3})` must produce `{"message": "x", "duration_ms": 12.3, ...}`, not bury `duration_ms` inside an unparsed string.

- [ ] **Step 1: Initialize the `uv` project and add dependencies**

Run:
```bash
cd ~/Desktop/Richpanel/backend
uv init --no-readme --name richpanel-backend .
uv add fastapi "uvicorn[standard]" "sqlalchemy>=2.0" "psycopg[binary]>=3.1" alembic pydantic
uv add --dev pytest httpx pytest-cov
```
Expected: `pyproject.toml` is created/updated with these dependencies; `uv.lock` is generated.

- [ ] **Step 2: Write the failing health-check test**

```python
# backend/tests/test_health.py
from fastapi.testclient import TestClient
from app.main import app

def test_health_check_returns_ok():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_health.py -v`
Expected: FAIL — `ImportError: cannot import name 'app' from 'app.main'` (main.py is currently empty).

- [ ] **Step 4: Write the failing JSON logging formatter test**

```python
# backend/tests/test_logging_config.py
import json
import logging
import sys

from app.logging_config import JsonFormatter


def test_json_formatter_produces_valid_json_with_extra_fields():
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name="richpanel.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="something happened", args=(), exc_info=None,
    )
    record.duration_ms = 42.5
    record.schedule_id = 7

    parsed = json.loads(formatter.format(record))

    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "richpanel.test"
    assert parsed["message"] == "something happened"
    assert parsed["duration_ms"] == 42.5
    assert parsed["schedule_id"] == 7
    assert "timestamp" in parsed


def test_json_formatter_includes_exception_info():
    formatter = JsonFormatter()
    try:
        raise ValueError("boom")
    except ValueError:
        record = logging.LogRecord(
            name="richpanel.test", level=logging.ERROR, pathname=__file__, lineno=1,
            msg="failed", args=(), exc_info=sys.exc_info(),
        )
    parsed = json.loads(formatter.format(record))
    assert "ValueError: boom" in parsed["exc_info"]
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_logging_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.logging_config'`

- [ ] **Step 6: Write the implementation**

```python
# backend/app/logging_config.py
import json
import logging

_STANDARD_RECORD_ATTRS = set(
    logging.LogRecord(name="", level=0, pathname="", lineno=0, msg="", args=(), exc_info=None).__dict__.keys()
)


class JsonFormatter(logging.Formatter):
    """Emits one JSON object per log line. Any field passed via
    logger.info(msg, extra={...}) is merged into the top-level payload, not
    buried in an unparsed string -- this is what makes duration_ms,
    schedule_id, agent_id etc. queryable in log tooling."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = {k: v for k, v in record.__dict__.items() if k not in _STANDARD_RECORD_ATTRS}
        payload.update(extra)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
```

```python
# backend/app/main.py
from fastapi import FastAPI

from app.logging_config import configure_logging

configure_logging()

app = FastAPI(title="Richpanel Schedule & Resolution Time Report")


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}
```

- [ ] **Step 7: Run all of this task's tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_health.py tests/test_logging_config.py -v`
Expected: PASS (3 passed)

- [ ] **Step 8: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/pyproject.toml backend/uv.lock backend/app/main.py backend/app/logging_config.py backend/tests/test_health.py backend/tests/test_logging_config.py && git commit -m "feat: project setup with FastAPI skeleton, health check, and JSON logging"
```

---

### Task 2: Database session module + Alembic + initial migration

**Files:**
- Create: `backend/app/db.py`
- Create: `backend/alembic.ini`
- Create: `backend/alembic/env.py`
- Create: `backend/alembic/versions/0001_initial_schema.py`
- Test: `backend/tests/conftest.py`, `backend/tests/test_db_sessions.py`

**Interfaces:**
- Produces: `app.db.engine` (SQLAlchemy engine), `app.db.Base` (declarative base all models inherit from), `app.db.db_session_read()` and `app.db.db_session_write()` (context managers, see Global Constraints).
- Requires a real local Postgres instance. `DATABASE_URL` env var (default `postgresql+psycopg://localhost/richpanel`), `DATABASE_URL_TEST` env var (default `postgresql+psycopg://localhost/richpanel_test`).

- [ ] **Step 1: Create the test and dev databases**

Run:
```bash
createdb richpanel
createdb richpanel_test
```
Expected: both databases exist (no output on success).

- [ ] **Step 2: Write `app/db.py`**

```python
# backend/app/db.py
import os
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql+psycopg://localhost/richpanel")

engine = create_engine(DATABASE_URL, pool_size=10, max_overflow=5)
SessionFactory = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


@contextmanager
def db_session_read():
    """A session scoped to reads only. No commit — closed immediately after use.
    Never hold this open across computation or network I/O; fetch what you need,
    exit the block, then compute."""
    session = SessionFactory()
    try:
        yield session
    finally:
        session.close()


@contextmanager
def db_session_write():
    """A session scoped to a single write transaction. Commits on clean exit,
    rolls back on exception. For flows that must check-then-write atomically
    under an advisory lock (schedule assignment, schedule edit), the read that
    performs the check MUST use this same session — not db_session_read — since
    the lock and the check only protect the write if both are the same
    transaction."""
    session = SessionFactory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
```

- [ ] **Step 3: Initialize Alembic**

Run:
```bash
cd ~/Desktop/Richpanel/backend
uv run alembic init alembic
```
Expected: creates `alembic.ini` and `alembic/` with `env.py`, `script.py.mako`, `versions/`.

- [ ] **Step 4: Configure `alembic/env.py` to use our engine and metadata**

Replace the generated `backend/alembic/env.py` with:

```python
# backend/alembic/env.py
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.db import Base, DATABASE_URL
from app.components.agents.model import Agent  # noqa: F401
from app.components.schedules.model import Schedule, ScheduleWeekdayHours  # noqa: F401
from app.components.schedule_agents.model import ScheduleAgent  # noqa: F401
from app.components.reports.model import ResolutionReport, ResolutionReportAgentHours  # noqa: F401

config = context.config
config.set_main_option("sqlalchemy.url", DATABASE_URL)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

Note: this references `app.components.*.model` modules that don't exist until Tasks 8-11. That's expected — `env.py` importing them is what makes `alembic revision --autogenerate` possible later, but this task's migration (Step 5) is hand-written, not autogenerated, so it does not require those modules to exist yet to run. Tasks 8-11 will each confirm `alembic upgrade head` still works once their model appears.

- [ ] **Step 5: Write the initial migration by hand**

```python
# backend/alembic/versions/0001_initial_schema.py
"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-08-09
"""
import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agents",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("email", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    op.create_table(
        "schedules",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("start_date", sa.Date, nullable=False),
        sa.Column("end_date", sa.Date, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("end_date IS NULL OR end_date >= start_date", name="ck_schedules_date_range"),
    )

    op.create_table(
        "schedule_weekday_hours",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("schedule_id", sa.BigInteger, sa.ForeignKey("schedules.id", ondelete="CASCADE"), nullable=False),
        sa.Column("weekday", sa.SmallInteger, nullable=False),
        sa.Column("start_time", sa.Interval, nullable=False),
        sa.Column("end_time", sa.Interval, nullable=False),
        sa.Column("is_overnight_tail", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("weekday BETWEEN 0 AND 6", name="ck_sw_weekday_range"),
        sa.CheckConstraint(
            "start_time >= interval '0' AND start_time < interval '24:00:00'", name="ck_sw_start_range"
        ),
        sa.CheckConstraint(
            "end_time > interval '0' AND end_time <= interval '24:00:00'", name="ck_sw_end_range"
        ),
        sa.CheckConstraint("end_time > start_time", name="ck_sw_end_after_start"),
        sa.CheckConstraint(
            "NOT is_overnight_tail OR start_time = interval '0'", name="ck_sw_tail_starts_midnight"
        ),
    )
    op.create_index("ix_sw_schedule_id", "schedule_weekday_hours", ["schedule_id"])
    op.create_index(
        "schedule_weekday_hours_active_uniq",
        "schedule_weekday_hours",
        ["schedule_id", "weekday", "is_overnight_tail"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    op.create_table(
        "schedule_agents",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("schedule_id", sa.BigInteger, sa.ForeignKey("schedules.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", sa.BigInteger, sa.ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_sa_schedule_id", "schedule_agents", ["schedule_id"])
    op.create_index("ix_sa_agent_id", "schedule_agents", ["agent_id"])
    op.create_index(
        "schedule_agents_active_uniq",
        "schedule_agents",
        ["schedule_id", "agent_id"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    op.create_table(
        "resolution_reports",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("ticket_start_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ticket_end_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("ticket_end_at > ticket_start_at", name="ck_reports_end_after_start"),
    )

    op.create_table(
        "resolution_report_agent_hours",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column(
            "report_id", sa.BigInteger, sa.ForeignKey("resolution_reports.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("agent_id", sa.BigInteger, sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("business_seconds", sa.BigInteger, nullable=False),
        sa.UniqueConstraint("report_id", "agent_id", name="uq_report_agent"),
    )
    op.create_index("ix_rrah_report_id", "resolution_report_agent_hours", ["report_id"])


def downgrade() -> None:
    op.drop_table("resolution_report_agent_hours")
    op.drop_table("resolution_reports")
    op.drop_table("schedule_agents")
    op.drop_table("schedule_weekday_hours")
    op.drop_table("schedules")
    op.drop_table("agents")
```

- [ ] **Step 6: Run the migration against both databases**

Run:
```bash
cd ~/Desktop/Richpanel/backend
uv run alembic upgrade head
DATABASE_URL=postgresql+psycopg://localhost/richpanel_test uv run alembic upgrade head
```
Expected: both commands print `Running upgrade  -> 0001, initial schema` with no errors.

- [ ] **Step 7: Write `tests/conftest.py` with the DB session fixtures used by every later test**

```python
# backend/tests/conftest.py
import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

TEST_DATABASE_URL = os.environ.get("DATABASE_URL_TEST", "postgresql+psycopg://localhost/richpanel_test")

test_engine = create_engine(TEST_DATABASE_URL)
TestSessionFactory = sessionmaker(bind=test_engine, expire_on_commit=False)

TABLES_IN_FK_ORDER = [
    "resolution_report_agent_hours",
    "resolution_reports",
    "schedule_agents",
    "schedule_weekday_hours",
    "schedules",
    "agents",
]


@pytest.fixture
def db(): # noqa: PT004 - fixture provides a session, not asserted directly
    """A plain session against the test database, truncated clean after each test."""
    session = TestSessionFactory()
    try:
        yield session
    finally:
        session.close()
        with test_engine.begin() as conn:
            conn.execute(text(f"TRUNCATE {', '.join(TABLES_IN_FK_ORDER)} RESTART IDENTITY CASCADE"))
```

- [ ] **Step 8: Write the failing test proving the read/write session contract**

```python
# backend/tests/test_db_sessions.py
import pytest
from sqlalchemy import text

from app.db import db_session_read, db_session_write


def test_write_session_commits_on_clean_exit(db):
    with db_session_write() as session:
        session.execute(text("INSERT INTO agents (name) VALUES ('probe-commit-test')"))

    with db_session_read() as read_session:
        count = read_session.execute(
            text("SELECT COUNT(*) FROM agents WHERE name = 'probe-commit-test'")
        ).scalar()
    assert count == 1


def test_write_session_rolls_back_on_exception(db):
    with pytest.raises(ValueError):
        with db_session_write() as session:
            session.execute(text("INSERT INTO agents (name) VALUES ('probe-rollback-test')"))
            raise ValueError("boom")

    with db_session_read() as read_session:
        count = read_session.execute(
            text("SELECT COUNT(*) FROM agents WHERE name = 'probe-rollback-test'")
        ).scalar()
    assert count == 0


def test_read_session_has_no_commit_side_effect(db):
    from app.components.agents.model import Agent  # exists starting Task 8

    with db_session_read() as session:
        agents = session.query(Agent).all()
    assert agents == []
```

Note: `test_read_session_has_no_commit_side_effect` references `app.components.agents.model.Agent`, which doesn't exist until Task 8. Leave it marked `@pytest.mark.skip(reason="Agent model added in Task 8")` for now — Task 8 removes the skip.

```python
# revise the third test:
@pytest.mark.skip(reason="Agent model added in Task 8")
def test_read_session_has_no_commit_side_effect(db):
    ...
```

- [ ] **Step 9: Run tests to verify the two runnable ones pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_db_sessions.py -v`
Expected: `test_write_session_commits_on_clean_exit` PASS, `test_write_session_rolls_back_on_exception` PASS, `test_read_session_has_no_commit_side_effect` SKIPPED.

- [ ] **Step 10: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/db.py backend/alembic.ini backend/alembic/ backend/tests/conftest.py backend/tests/test_db_sessions.py && git commit -m "feat: db session module (read/write) + Alembic + initial schema migration"
```

---

### Task 3: `domain/types.py` — shift dataclasses

**Files:**
- Create: `backend/app/domain/types.py`
- Test: `backend/tests/domain/test_types.py`

**Interfaces:**
- Produces: `ShiftInput(weekday: int, start_time: timedelta, end_time: timedelta)` with `.crosses_midnight: bool`; `WeekdayShift(weekday: int, start_time: timedelta, end_time: timedelta, is_overnight_tail: bool = False)` with `.duration: timedelta`; constants `ZERO = timedelta()`, `END_OF_DAY = timedelta(hours=24)`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/domain/test_types.py
from datetime import timedelta

import pytest

from app.domain.types import ShiftInput, WeekdayShift


def test_shift_input_accepts_same_day_shift():
    s = ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    assert s.crosses_midnight is False


def test_shift_input_accepts_midnight_crossing_shift():
    s = ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    assert s.crosses_midnight is True


def test_shift_input_rejects_zero_duration():
    with pytest.raises(ValueError, match="zero duration"):
        ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=9))


def test_shift_input_rejects_invalid_weekday():
    with pytest.raises(ValueError, match="weekday"):
        ShiftInput(weekday=7, start_time=timedelta(hours=9), end_time=timedelta(hours=17))


def test_weekday_shift_rejects_end_before_or_equal_start():
    with pytest.raises(ValueError, match="same-day"):
        WeekdayShift(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))


def test_weekday_shift_accepts_end_of_day_boundary():
    s = WeekdayShift(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=24))
    assert s.duration == timedelta(hours=2)


def test_weekday_shift_tail_must_start_at_midnight():
    with pytest.raises(ValueError, match="overnight tail"):
        WeekdayShift(
            weekday=1, start_time=timedelta(hours=1), end_time=timedelta(hours=6), is_overnight_tail=True
        )


def test_weekday_shift_tail_at_midnight_is_valid():
    s = WeekdayShift(weekday=1, start_time=timedelta(0), end_time=timedelta(hours=6), is_overnight_tail=True)
    assert s.duration == timedelta(hours=6)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/domain/test_types.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.domain.types'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/domain/types.py
from dataclasses import dataclass
from datetime import timedelta

ZERO = timedelta()
END_OF_DAY = timedelta(hours=24)


@dataclass(frozen=True)
class ShiftInput:
    """Raw user-facing shift input: one weekday, one start/end offset from
    midnight. May cross midnight (end_time <= start_time)."""

    weekday: int
    start_time: timedelta
    end_time: timedelta

    def __post_init__(self) -> None:
        if not (0 <= self.weekday <= 6):
            raise ValueError(f"weekday must be 0-6, got {self.weekday}")
        if not (ZERO <= self.start_time < END_OF_DAY):
            raise ValueError(f"start_time must be in [0, 24h), got {self.start_time}")
        if not (ZERO <= self.end_time < END_OF_DAY):
            raise ValueError(f"end_time must be in [0, 24h), got {self.end_time}")
        if self.start_time == self.end_time:
            raise ValueError("shift cannot have zero duration (start_time == end_time)")

    @property
    def crosses_midnight(self) -> bool:
        return self.end_time <= self.start_time


@dataclass(frozen=True)
class WeekdayShift:
    """A normalized, always-same-day shift: end_time is always strictly
    after start_time. Overnight input is split into two of these (see
    domain/shift_normalization.py) — a primary ending at END_OF_DAY and a
    tail starting at ZERO on the next weekday."""

    weekday: int
    start_time: timedelta
    end_time: timedelta
    is_overnight_tail: bool = False

    def __post_init__(self) -> None:
        if not (0 <= self.weekday <= 6):
            raise ValueError(f"weekday must be 0-6, got {self.weekday}")
        if not (ZERO <= self.start_time < END_OF_DAY):
            raise ValueError(f"start_time must be in [0, 24h), got {self.start_time}")
        if not (ZERO < self.end_time <= END_OF_DAY):
            raise ValueError(f"end_time must be in (0, 24h], got {self.end_time}")
        if self.end_time <= self.start_time:
            raise ValueError(
                "WeekdayShift must be same-day (end_time > start_time); "
                "use shift_normalization.normalize_shift() to split input that crosses midnight"
            )
        if self.is_overnight_tail and self.start_time != ZERO:
            raise ValueError("an overnight tail must start at 00:00 (start_time == timedelta())")

    @property
    def duration(self) -> timedelta:
        return self.end_time - self.start_time
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/domain/test_types.py -v`
Expected: PASS (8 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/domain/types.py backend/tests/domain/test_types.py && git commit -m "feat: domain shift dataclasses (ShiftInput, WeekdayShift)"
```

---

### Task 4: `domain/shift_normalization.py` — split and recombine overnight shifts

**Files:**
- Create: `backend/app/domain/shift_normalization.py`
- Test: `backend/tests/domain/test_shift_normalization.py`

**Interfaces:**
- Consumes: `ShiftInput`, `WeekdayShift`, `ZERO`, `END_OF_DAY` from `app.domain.types`.
- Produces: `normalize_shift(shift: ShiftInput) -> list[WeekdayShift]`; `recombine_shifts(shifts: list[WeekdayShift]) -> list[ShiftInput]`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/domain/test_shift_normalization.py
from datetime import timedelta

import pytest

from app.domain.shift_normalization import normalize_shift, recombine_shifts
from app.domain.types import ShiftInput, WeekdayShift


def test_normalize_same_day_shift_returns_single_row():
    shift = ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    result = normalize_shift(shift)
    assert result == [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]


def test_normalize_overnight_shift_splits_into_primary_and_tail():
    shift = ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    result = normalize_shift(shift)
    assert result == [
        WeekdayShift(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=24)),
        WeekdayShift(
            weekday=1, start_time=timedelta(0), end_time=timedelta(hours=6), is_overnight_tail=True
        ),
    ]


def test_normalize_sunday_overnight_wraps_to_monday():
    shift = ShiftInput(weekday=6, start_time=timedelta(hours=20), end_time=timedelta(hours=4))
    result = normalize_shift(shift)
    assert result[0].weekday == 6
    assert result[1].weekday == 0
    assert result[1].is_overnight_tail is True


def test_recombine_same_day_shift_is_unchanged():
    shifts = [WeekdayShift(weekday=2, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    assert recombine_shifts(shifts) == [
        ShiftInput(weekday=2, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    ]


def test_recombine_primary_and_tail_into_one_logical_shift():
    shifts = [
        WeekdayShift(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=24)),
        WeekdayShift(weekday=1, start_time=timedelta(0), end_time=timedelta(hours=6), is_overnight_tail=True),
    ]
    assert recombine_shifts(shifts) == [
        ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    ]


def test_recombine_round_trips_through_normalize():
    original = ShiftInput(weekday=4, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    assert recombine_shifts(normalize_shift(original)) == [original]


def test_recombine_raises_on_orphaned_tail():
    orphan_tail = [
        WeekdayShift(weekday=2, start_time=timedelta(0), end_time=timedelta(hours=6), is_overnight_tail=True)
    ]
    with pytest.raises(ValueError, match="orphaned"):
        recombine_shifts(orphan_tail)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/domain/test_shift_normalization.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.domain.shift_normalization'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/domain/shift_normalization.py
from app.domain.types import END_OF_DAY, ZERO, ShiftInput, WeekdayShift


def normalize_shift(shift: ShiftInput) -> list[WeekdayShift]:
    """Split a possibly-midnight-crossing ShiftInput into 1 or 2 same-day
    WeekdayShift rows, ready to persist."""
    if not shift.crosses_midnight:
        return [WeekdayShift(weekday=shift.weekday, start_time=shift.start_time, end_time=shift.end_time)]

    primary = WeekdayShift(weekday=shift.weekday, start_time=shift.start_time, end_time=END_OF_DAY)
    tail = WeekdayShift(
        weekday=(shift.weekday + 1) % 7,
        start_time=ZERO,
        end_time=shift.end_time,
        is_overnight_tail=True,
    )
    return [primary, tail]


def recombine_shifts(shifts: list[WeekdayShift]) -> list[ShiftInput]:
    """Inverse of normalize_shift: merge primary+tail pairs back into one
    logical (possibly midnight-crossing) shift per weekday, for display.
    Raises ValueError if a tail row has no matching primary — a data
    integrity anomaly that should never happen if all writes go through
    normalize_shift, but is surfaced loudly rather than silently dropped."""
    tails_by_weekday = {s.weekday: s for s in shifts if s.is_overnight_tail}
    primaries = [s for s in shifts if not s.is_overnight_tail]

    result: list[ShiftInput] = []
    consumed_tail_weekdays: set[int] = set()

    for primary in primaries:
        next_weekday = (primary.weekday + 1) % 7
        tail = tails_by_weekday.get(next_weekday)
        if primary.end_time == END_OF_DAY and tail is not None:
            result.append(
                ShiftInput(weekday=primary.weekday, start_time=primary.start_time, end_time=tail.end_time)
            )
            consumed_tail_weekdays.add(next_weekday)
        else:
            result.append(
                ShiftInput(
                    weekday=primary.weekday, start_time=primary.start_time, end_time=primary.end_time
                )
            )

    orphan_tails = [wd for wd in tails_by_weekday if wd not in consumed_tail_weekdays]
    if orphan_tails:
        raise ValueError(f"orphaned overnight-tail rows with no matching primary for weekday(s): {orphan_tails}")

    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/domain/test_shift_normalization.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/domain/shift_normalization.py backend/tests/domain/test_shift_normalization.py && git commit -m "feat: overnight shift split/recombine normalization"
```

---

### Task 5: `domain/overlap.py` — overlap detection

**Files:**
- Create: `backend/app/domain/overlap.py`
- Test: `backend/tests/domain/test_overlap.py`

**Interfaces:**
- Consumes: `WeekdayShift` from `app.domain.types`.
- Produces: `Overlap(a: WeekdayShift, b: WeekdayShift)` dataclass; `find_overlaps(existing: list[WeekdayShift], new: list[WeekdayShift]) -> list[Overlap]`; `find_self_overlaps(shifts: list[WeekdayShift]) -> list[Overlap]`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/domain/test_overlap.py
from datetime import timedelta

from app.domain.overlap import find_overlaps, find_self_overlaps
from app.domain.types import WeekdayShift


def shift(weekday, start_h, end_h, tail=False):
    return WeekdayShift(
        weekday=weekday, start_time=timedelta(hours=start_h), end_time=timedelta(hours=end_h), is_overnight_tail=tail
    )


def test_no_overlap_different_weekdays():
    existing = [shift(0, 9, 17)]
    new = [shift(1, 9, 17)]
    assert find_overlaps(existing, new) == []


def test_no_overlap_same_weekday_adjacent_ranges():
    existing = [shift(0, 9, 13)]
    new = [shift(0, 13, 17)]
    assert find_overlaps(existing, new) == []


def test_overlap_same_weekday_overlapping_ranges():
    existing = [shift(0, 9, 17)]
    new = [shift(0, 12, 20)]
    conflicts = find_overlaps(existing, new)
    assert len(conflicts) == 1
    assert conflicts[0].a == existing[0]
    assert conflicts[0].b == new[0]


def test_overlap_detects_tail_colliding_with_next_days_own_shift():
    # Monday-night overnight shift's tail lands on Tuesday 00:00-06:00
    existing_tail = shift(1, 0, 6, tail=True)
    new_tuesday_shift = shift(1, 5, 13)
    conflicts = find_overlaps([existing_tail], [new_tuesday_shift])
    assert len(conflicts) == 1


def test_self_overlaps_within_one_schedules_own_shift_set():
    # a schedule whose Monday-night overnight tail collides with its own Tuesday shift
    monday_primary = shift(0, 22, 24)
    tuesday_tail = shift(1, 0, 6, tail=True)
    tuesday_own_shift = shift(1, 5, 13)
    conflicts = find_self_overlaps([monday_primary, tuesday_tail, tuesday_own_shift])
    assert len(conflicts) == 1
    weekdays_involved = {conflicts[0].a.weekday, conflicts[0].b.weekday}
    assert weekdays_involved == {1}


def test_self_overlaps_empty_for_non_conflicting_shifts():
    shifts = [shift(0, 9, 17), shift(1, 9, 17), shift(2, 22, 24)]
    assert find_self_overlaps(shifts) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/domain/test_overlap.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.domain.overlap'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/domain/overlap.py
from dataclasses import dataclass

from app.domain.types import WeekdayShift


@dataclass(frozen=True)
class Overlap:
    a: WeekdayShift
    b: WeekdayShift


def _intervals_overlap(a: WeekdayShift, b: WeekdayShift) -> bool:
    return a.weekday == b.weekday and a.start_time < b.end_time and b.start_time < a.end_time


def find_overlaps(existing: list[WeekdayShift], new: list[WeekdayShift]) -> list[Overlap]:
    """Every pair (a in existing, b in new) whose weekday matches and whose
    time ranges overlap. Used to check a proposed assignment/edit against an
    agent's other schedules."""
    return [Overlap(a=a, b=b) for a in existing for b in new if _intervals_overlap(a, b)]


def find_self_overlaps(shifts: list[WeekdayShift]) -> list[Overlap]:
    """Every pair of DIFFERENT shifts within one set that overlap each other.
    Used to validate one schedule's own normalized shift set doesn't
    self-conflict (e.g. an overnight tail colliding with that weekday's own
    separately-configured shift)."""
    conflicts = []
    for i, a in enumerate(shifts):
        for b in shifts[i + 1 :]:
            if _intervals_overlap(a, b):
                conflicts.append(Overlap(a=a, b=b))
    return conflicts
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/domain/test_overlap.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/domain/overlap.py backend/tests/domain/test_overlap.py && git commit -m "feat: overlap detection (cross-schedule and self-overlap)"
```

---

### Task 6: `domain/business_hours.py` — closed-form calculation

**Files:**
- Create: `backend/app/domain/business_hours.py`
- Test: `backend/tests/domain/test_business_hours.py`

**Interfaces:**
- Consumes: `WeekdayShift`, `ZERO`, `END_OF_DAY` from `app.domain.types`.
- Produces: `calculate_business_seconds(shifts: list[WeekdayShift], window_start: datetime, window_end: datetime) -> int`.

- [ ] **Step 1: Write the failing tests**

These assert the exact hand-verified numbers from the design doc's Appendix A (Schedules A, B, C over the same window), plus two additional edge cases (single-day window, zero-shift schedule).

```python
# backend/tests/domain/test_business_hours.py
from datetime import datetime, timedelta

import pytest

from app.domain.business_hours import calculate_business_seconds
from app.domain.shift_normalization import normalize_shift
from app.domain.types import ShiftInput


def shift(weekday, start_h, end_h):
    return ShiftInput(weekday=weekday, start_time=timedelta(hours=start_h), end_time=timedelta(hours=end_h % 24))


def build_shifts(inputs):
    result = []
    for s in inputs:
        result.extend(normalize_shift(s))
    return result


WINDOW_START = datetime(2026, 1, 5, 23, 0, 0)  # Monday 23:00
WINDOW_END = datetime(2026, 1, 21, 3, 0, 0)  # Wednesday 03:00


def test_schedule_a_day_shift_matches_hand_verified_88_hours():
    shifts = build_shifts([shift(wd, 9, 17) for wd in range(5)])  # Mon-Fri 09:00-17:00
    seconds = calculate_business_seconds(shifts, WINDOW_START, WINDOW_END)
    assert seconds == 88 * 3600


def test_schedule_b_night_shift_matches_hand_verified_92_hours():
    shifts = build_shifts([ShiftInput(weekday=wd, start_time=timedelta(hours=22), end_time=timedelta(hours=6)) for wd in range(5)])  # Mon-Fri 22:00-06:00
    seconds = calculate_business_seconds(shifts, WINDOW_START, WINDOW_END)
    assert seconds == 92 * 3600


def test_schedule_c_weekend_wrap_matches_hand_verified_22_hours():
    shifts = build_shifts(
        [
            ShiftInput(weekday=5, start_time=timedelta(hours=20), end_time=timedelta(hours=23)),  # Sat 20-23
            ShiftInput(weekday=6, start_time=timedelta(hours=20), end_time=timedelta(hours=4)),  # Sun 20 - Mon 04
        ]
    )
    seconds = calculate_business_seconds(shifts, WINDOW_START, WINDOW_END)
    assert seconds == 22 * 3600


def test_window_entirely_within_one_day():
    shifts = build_shifts([shift(1, 9, 17)])  # Tuesday 09:00-17:00
    window_start = datetime(2026, 1, 6, 10, 0, 0)  # Tuesday 10:00
    window_end = datetime(2026, 1, 6, 14, 0, 0)  # Tuesday 14:00
    seconds = calculate_business_seconds(shifts, window_start, window_end)
    assert seconds == 4 * 3600


def test_window_entirely_within_one_day_outside_shift_hours():
    shifts = build_shifts([shift(1, 9, 17)])
    window_start = datetime(2026, 1, 6, 18, 0, 0)
    window_end = datetime(2026, 1, 6, 20, 0, 0)
    seconds = calculate_business_seconds(shifts, window_start, window_end)
    assert seconds == 0


def test_schedule_with_no_shifts_returns_zero():
    seconds = calculate_business_seconds([], WINDOW_START, WINDOW_END)
    assert seconds == 0


def test_window_length_does_not_change_per_day_cost_only_the_total():
    # a much longer window (2 years) still returns a total consistent with
    # full_weeks * weekly_total dominating -- this is a correctness sanity
    # check, not a performance benchmark (that belongs in a separate perf test).
    shifts = build_shifts([shift(wd, 9, 17) for wd in range(5)])
    long_end = datetime(2028, 1, 21, 3, 0, 0)
    seconds = calculate_business_seconds(shifts, WINDOW_START, long_end)
    assert seconds > 88 * 3600  # strictly more than the 15-day window's total


def test_rejects_window_end_before_start():
    with pytest.raises(ValueError, match="after"):
        calculate_business_seconds([], WINDOW_END, WINDOW_START)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/domain/test_business_hours.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.domain.business_hours'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/domain/business_hours.py
from datetime import datetime, timedelta

from app.domain.types import END_OF_DAY, ZERO, WeekdayShift


def _weekday_of(dt: datetime) -> int:
    return dt.weekday()


def _day_offset_of(dt: datetime) -> timedelta:
    return dt - datetime.combine(dt.date(), datetime.min.time())


def _day_overlap(shifts_for_day: list[WeekdayShift], window_start: timedelta, window_end: timedelta) -> timedelta:
    total = ZERO
    for s in shifts_for_day:
        lo = max(s.start_time, window_start)
        hi = min(s.end_time, window_end)
        if hi > lo:
            total += hi - lo
    return total


def calculate_business_seconds(shifts: list[WeekdayShift], window_start: datetime, window_end: datetime) -> int:
    """O(1) relative to window length: touches only the given shifts (at
    most ~14 rows for a schedule with overnight splits), never loops per
    calendar day in the window."""
    if window_end <= window_start:
        raise ValueError("window_end must be after window_start")

    by_weekday: dict[int, list[WeekdayShift]] = {i: [] for i in range(7)}
    for s in shifts:
        by_weekday[s.weekday].append(s)

    weekly_total = sum((s.duration for s in shifts), start=ZERO)

    next_midnight = datetime.combine(window_start.date(), datetime.min.time()) + timedelta(days=1)

    if window_end <= next_midnight:
        total = _day_overlap(
            by_weekday[_weekday_of(window_start)], _day_offset_of(window_start), _day_offset_of(window_end)
        )
        return int(total.total_seconds())

    total = _day_overlap(by_weekday[_weekday_of(window_start)], _day_offset_of(window_start), END_OF_DAY)

    last_midnight = datetime.combine(window_end.date(), datetime.min.time())
    total += _day_overlap(by_weekday[_weekday_of(window_end)], ZERO, _day_offset_of(window_end))

    full_days = (last_midnight - next_midnight).days
    if full_days > 0:
        full_weeks, remainder_days = divmod(full_days, 7)
        total += full_weeks * weekly_total
        cursor = next_midnight
        for _ in range(remainder_days):
            total += sum((s.duration for s in by_weekday[_weekday_of(cursor)]), start=ZERO)
            cursor += timedelta(days=1)

    return int(total.total_seconds())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/domain/test_business_hours.py -v`
Expected: PASS (8 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/domain/business_hours.py backend/tests/domain/test_business_hours.py && git commit -m "feat: closed-form business-hours calculation, validated against hand-verified totals"
```

---

### Task 7: `errors/error.py` — exception hierarchy

**Files:**
- Create: `backend/app/errors/error.py`
- Test: `backend/tests/test_errors.py`

**Interfaces:**
- Produces: `AppError`, `NotFoundError(AppError)`, `ConflictError(AppError)`, `ScheduleOverlapError(ConflictError)`, `AssignmentOverlapError(ConflictError)`, `DomainValidationError(AppError)`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_errors.py
from app.domain.overlap import Overlap
from app.domain.types import WeekdayShift
from app.errors.error import (
    AppError,
    AssignmentOverlapError,
    ConflictError,
    DomainValidationError,
    NotFoundError,
    ScheduleOverlapError,
)
from datetime import timedelta


def test_hierarchy():
    assert issubclass(NotFoundError, AppError)
    assert issubclass(ConflictError, AppError)
    assert issubclass(ScheduleOverlapError, ConflictError)
    assert issubclass(AssignmentOverlapError, ConflictError)
    assert issubclass(DomainValidationError, AppError)


def test_conflict_error_carries_conflicts():
    a = WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    b = WeekdayShift(weekday=0, start_time=timedelta(hours=12), end_time=timedelta(hours=20))
    err = AssignmentOverlapError(agent_id=42, conflicts=[Overlap(a=a, b=b)])
    assert err.agent_id == 42
    assert len(err.conflicts) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_errors.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.errors.error'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/errors/error.py
from app.domain.overlap import Overlap


class AppError(Exception):
    """Base for all application-raised errors the API layer knows how to
    translate into an HTTP response."""


class NotFoundError(AppError):
    """A requested resource (schedule, agent, report) doesn't exist. -> 404"""


class ConflictError(AppError):
    """The requested write would violate a business invariant. -> 409"""


class ScheduleOverlapError(ConflictError):
    """A schedule's own weekday-hours rows self-conflict (e.g. an overnight
    tail colliding with that weekday's own separately-configured shift)."""

    def __init__(self, conflicts: list[Overlap]):
        self.conflicts = conflicts
        super().__init__(f"schedule has {len(conflicts)} self-overlapping shift(s)")


class AssignmentOverlapError(ConflictError):
    """Assigning/editing would create an overlap for one agent against their
    other active schedules."""

    def __init__(self, agent_id: int, conflicts: list[Overlap]):
        self.agent_id = agent_id
        self.conflicts = conflicts
        super().__init__(f"agent {agent_id} would have {len(conflicts)} overlapping shift(s)")


class DomainValidationError(AppError):
    """A business-rule violation requiring DB state to detect (not a plain
    request-shape issue, which Pydantic already handles at 422). -> 400"""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_errors.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/errors/error.py backend/tests/test_errors.py && git commit -m "feat: application exception hierarchy"
```

---

### Task 8: `components/agents` — model, queries, seed script

**Files:**
- Create: `backend/app/components/agents/model.py`
- Create: `backend/app/components/agents/queries.py`
- Create: `backend/scripts/seed_agents.py`
- Test: `backend/tests/components/test_agents_queries.py`
- Modify: `backend/tests/test_db_sessions.py` (remove the `@pytest.mark.skip` on `test_read_session_has_no_commit_side_effect`)

**Interfaces:**
- Produces: `Agent` ORM model (`id`, `name`, `email`, `created_at`); `list_agents(session, limit: int, offset: int) -> list[Agent]`; `get_agent(session, agent_id: int) -> Agent | None`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/components/test_agents_queries.py
from app.components.agents.model import Agent
from app.components.agents.queries import get_agent, list_agents


def test_list_agents_returns_seeded_agents(db):
    db.add_all([Agent(name="Alice"), Agent(name="Bob")])
    db.commit()

    result = list_agents(db, limit=10, offset=0)

    assert [a.name for a in result] == ["Alice", "Bob"]


def test_list_agents_respects_limit_and_offset(db):
    db.add_all([Agent(name=f"Agent {i}") for i in range(5)])
    db.commit()

    result = list_agents(db, limit=2, offset=2)

    assert [a.name for a in result] == ["Agent 2", "Agent 3"]


def test_get_agent_returns_none_when_missing(db):
    assert get_agent(db, agent_id=999) is None


def test_get_agent_returns_matching_agent(db):
    agent = Agent(name="Carol")
    db.add(agent)
    db.commit()

    result = get_agent(db, agent_id=agent.id)

    assert result is not None
    assert result.name == "Carol"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/components/test_agents_queries.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.components.agents.model'`

- [ ] **Step 3: Write the model**

```python
# backend/app/components/agents/model.py
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    email: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

- [ ] **Step 4: Write the queries**

```python
# backend/app/components/agents/queries.py
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.components.agents.model import Agent


def list_agents(session: Session, limit: int, offset: int) -> list[Agent]:
    stmt = select(Agent).order_by(Agent.id).limit(limit).offset(offset)
    return list(session.scalars(stmt))


def get_agent(session: Session, agent_id: int) -> Agent | None:
    return session.get(Agent, agent_id)
```

- [ ] **Step 5: Un-skip the earlier db-session test**

In `backend/tests/test_db_sessions.py`, remove the `@pytest.mark.skip(reason="Agent model added in Task 8")` decorator above `test_read_session_has_no_commit_side_effect`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/components/test_agents_queries.py tests/test_db_sessions.py -v`
Expected: PASS (7 passed — 4 from this task, 3 from Task 2's file now fully unskipped)

- [ ] **Step 7: Write the agent seed script**

```python
# backend/scripts/seed_agents.py
"""Seed a handful of agents for local development. Agent creation is
explicitly out of scope for the API (see spec NFR #1) -- this script is the
only way agents enter the system."""

from app.components.agents.model import Agent
from app.db import db_session_write

SEED_NAMES = [
    "Alice Chen",
    "Bob Martinez",
    "Carol Singh",
    "David Okafor",
    "Elena Petrova",
]

if __name__ == "__main__":
    with db_session_write() as session:
        for name in SEED_NAMES:
            session.add(Agent(name=name, email=f"{name.split()[0].lower()}@richpanel.example"))
    print(f"seeded {len(SEED_NAMES)} agents")
```

- [ ] **Step 8: Run the seed script against the dev database**

Run: `cd ~/Desktop/Richpanel/backend && uv run python scripts/seed_agents.py`
Expected: `seeded 5 agents`

- [ ] **Step 9: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/components/agents/ backend/scripts/seed_agents.py backend/tests/components/test_agents_queries.py backend/tests/test_db_sessions.py && git commit -m "feat: Agent model, queries, and dev seed script"
```

---

### Task 9: `components/schedules` — model, queries

**Files:**
- Create: `backend/app/components/schedules/model.py`
- Create: `backend/app/components/schedules/queries.py`
- Test: `backend/tests/components/test_schedules_queries.py`

**Interfaces:**
- Consumes: `WeekdayShift` from `app.domain.types`.
- Produces: `Schedule`, `ScheduleWeekdayHours` ORM models; `create_schedule(session, name, start_date, end_date) -> Schedule`; `get_schedule(session, schedule_id) -> Schedule | None`; `list_active_schedules(session, limit, offset) -> list[Schedule]`; `soft_delete_schedule(session, schedule_id) -> None`; `insert_weekday_hours_rows(session, schedule_id, shifts: list[WeekdayShift]) -> None`; `get_weekday_hours_rows(session, schedule_id) -> list[ScheduleWeekdayHours]`; `replace_weekday_hours_rows(session, schedule_id, shifts: list[WeekdayShift]) -> None`; `soft_delete_weekday_hours_for_schedule(session, schedule_id) -> None`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/components/test_schedules_queries.py
from datetime import date, timedelta

from app.components.schedules.queries import (
    create_schedule,
    get_schedule,
    get_weekday_hours_rows,
    insert_weekday_hours_rows,
    list_active_schedules,
    replace_weekday_hours_rows,
    soft_delete_schedule,
    soft_delete_weekday_hours_for_schedule,
)
from app.domain.types import WeekdayShift


def test_create_and_get_schedule(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()

    fetched = get_schedule(db, schedule.id)

    assert fetched is not None
    assert fetched.name == "Day Shift"
    assert fetched.end_date is None


def test_get_schedule_returns_none_for_soft_deleted(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    soft_delete_schedule(db, schedule.id)
    db.commit()

    assert get_schedule(db, schedule.id) is None


def test_list_active_schedules_excludes_deleted(db):
    kept = create_schedule(db, name="Kept", start_date=date(2026, 1, 1), end_date=None)
    deleted = create_schedule(db, name="Deleted", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    soft_delete_schedule(db, deleted.id)
    db.commit()

    result = list_active_schedules(db, limit=10, offset=0)

    assert [s.name for s in result] == ["Kept"]


def test_insert_and_get_weekday_hours_rows(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()

    shifts = [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    insert_weekday_hours_rows(db, schedule.id, shifts)
    db.commit()

    rows = get_weekday_hours_rows(db, schedule.id)

    assert len(rows) == 1
    assert rows[0].weekday == 0
    assert rows[0].start_time == timedelta(hours=9)
    assert rows[0].end_time == timedelta(hours=17)


def test_replace_weekday_hours_rows_swaps_old_for_new(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    insert_weekday_hours_rows(
        db, schedule.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    )
    db.commit()

    replace_weekday_hours_rows(
        db, schedule.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=8), end_time=timedelta(hours=16))]
    )
    db.commit()

    rows = get_weekday_hours_rows(db, schedule.id)
    assert len(rows) == 1
    assert rows[0].start_time == timedelta(hours=8)


def test_soft_delete_weekday_hours_for_schedule(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    insert_weekday_hours_rows(
        db, schedule.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    )
    db.commit()

    soft_delete_weekday_hours_for_schedule(db, schedule.id)
    db.commit()

    assert get_weekday_hours_rows(db, schedule.id) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/components/test_schedules_queries.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.components.schedules.model'`

- [ ] **Step 3: Write the model**

```python
# backend/app/components/schedules/model.py
from datetime import date, datetime, timedelta

from sqlalchemy import ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    start_date: Mapped[date]
    end_date: Mapped[date | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(default=None)


class ScheduleWeekdayHours(Base):
    __tablename__ = "schedule_weekday_hours"

    id: Mapped[int] = mapped_column(primary_key=True)
    schedule_id: Mapped[int] = mapped_column(ForeignKey("schedules.id", ondelete="CASCADE"))
    weekday: Mapped[int]
    start_time: Mapped[timedelta]
    end_time: Mapped[timedelta]
    is_overnight_tail: Mapped[bool] = mapped_column(default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(default=None)
```

- [ ] **Step 4: Write the queries**

```python
# backend/app/components/schedules/queries.py
from datetime import date, datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.components.schedules.model import Schedule, ScheduleWeekdayHours
from app.domain.types import WeekdayShift


def create_schedule(session: Session, name: str, start_date: date, end_date: date | None) -> Schedule:
    schedule = Schedule(name=name, start_date=start_date, end_date=end_date)
    session.add(schedule)
    session.flush()  # populate schedule.id without committing
    return schedule


def get_schedule(session: Session, schedule_id: int) -> Schedule | None:
    stmt = select(Schedule).where(Schedule.id == schedule_id, Schedule.deleted_at.is_(None))
    return session.scalars(stmt).one_or_none()


def list_active_schedules(session: Session, limit: int, offset: int) -> list[Schedule]:
    stmt = select(Schedule).where(Schedule.deleted_at.is_(None)).order_by(Schedule.id).limit(limit).offset(offset)
    return list(session.scalars(stmt))


def soft_delete_schedule(session: Session, schedule_id: int) -> None:
    session.execute(update(Schedule).where(Schedule.id == schedule_id).values(deleted_at=datetime.now()))


def insert_weekday_hours_rows(session: Session, schedule_id: int, shifts: list[WeekdayShift]) -> None:
    session.add_all(
        [
            ScheduleWeekdayHours(
                schedule_id=schedule_id,
                weekday=s.weekday,
                start_time=s.start_time,
                end_time=s.end_time,
                is_overnight_tail=s.is_overnight_tail,
            )
            for s in shifts
        ]
    )


def get_weekday_hours_rows(session: Session, schedule_id: int) -> list[ScheduleWeekdayHours]:
    stmt = select(ScheduleWeekdayHours).where(
        ScheduleWeekdayHours.schedule_id == schedule_id, ScheduleWeekdayHours.deleted_at.is_(None)
    )
    return list(session.scalars(stmt))


def replace_weekday_hours_rows(session: Session, schedule_id: int, shifts: list[WeekdayShift]) -> None:
    """Hard-delete the schedule's existing rows and insert the new set, in
    one flush. Per spec 4.6, weekday-hours edits stay a plain in-place
    operation (not soft-deleted individually) -- deleted_at on this table is
    only ever set by the schedule-level cascade."""
    session.execute(
        ScheduleWeekdayHours.__table__.delete().where(ScheduleWeekdayHours.schedule_id == schedule_id)
    )
    insert_weekday_hours_rows(session, schedule_id, shifts)


def soft_delete_weekday_hours_for_schedule(session: Session, schedule_id: int) -> None:
    session.execute(
        update(ScheduleWeekdayHours)
        .where(ScheduleWeekdayHours.schedule_id == schedule_id, ScheduleWeekdayHours.deleted_at.is_(None))
        .values(deleted_at=datetime.now())
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/components/test_schedules_queries.py -v`
Expected: PASS (6 passed)

- [ ] **Step 6: Confirm the migration still applies cleanly now that the model exists**

Run: `cd ~/Desktop/Richpanel/backend && uv run alembic upgrade head`
Expected: `INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.` with no errors (already at head, so no-op if Task 2 already ran it — this step is a smoke check that importing the new model doesn't break `alembic/env.py`).

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/components/schedules/ backend/tests/components/test_schedules_queries.py && git commit -m "feat: Schedule and ScheduleWeekdayHours models + queries"
```

---

### Task 10: `components/schedule_agents` — model, queries

**Files:**
- Create: `backend/app/components/schedule_agents/model.py`
- Create: `backend/app/components/schedule_agents/queries.py`
- Test: `backend/tests/components/test_schedule_agents_queries.py`

**Interfaces:**
- Produces: `ScheduleAgent` ORM model; `create_assignment(session, schedule_id, agent_id) -> ScheduleAgent`; `soft_delete_assignment(session, schedule_id, agent_id) -> None`; `list_active_assignee_agent_ids(session, schedule_id) -> list[int]`; `get_other_active_schedule_ids_for_agent(session, agent_id, exclude_schedule_id) -> list[int]`; `soft_delete_assignments_for_schedule(session, schedule_id) -> None`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/components/test_schedule_agents_queries.py
from datetime import date

from app.components.agents.model import Agent
from app.components.schedule_agents.queries import (
    create_assignment,
    get_other_active_schedule_ids_for_agent,
    list_active_assignee_agent_ids,
    soft_delete_assignment,
    soft_delete_assignments_for_schedule,
)
from app.components.schedules.queries import create_schedule


def _agent(db, name="Agent"):
    a = Agent(name=name)
    db.add(a)
    db.flush()
    return a


def test_create_assignment_and_list_assignees(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    agent = _agent(db)
    db.commit()

    create_assignment(db, schedule.id, agent.id)
    db.commit()

    assert list_active_assignee_agent_ids(db, schedule.id) == [agent.id]


def test_soft_delete_assignment_removes_from_active_list(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    agent = _agent(db)
    db.commit()
    create_assignment(db, schedule.id, agent.id)
    db.commit()

    soft_delete_assignment(db, schedule.id, agent.id)
    db.commit()

    assert list_active_assignee_agent_ids(db, schedule.id) == []


def test_reassign_after_unassign_is_allowed(db):
    # exercises the partial unique index (schedule_id, agent_id) WHERE deleted_at IS NULL
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    agent = _agent(db)
    db.commit()
    create_assignment(db, schedule.id, agent.id)
    db.commit()
    soft_delete_assignment(db, schedule.id, agent.id)
    db.commit()

    create_assignment(db, schedule.id, agent.id)  # should not raise
    db.commit()

    assert list_active_assignee_agent_ids(db, schedule.id) == [agent.id]


def test_get_other_active_schedule_ids_excludes_the_given_schedule(db):
    schedule_a = create_schedule(db, name="A", start_date=date(2026, 1, 1), end_date=None)
    schedule_b = create_schedule(db, name="B", start_date=date(2026, 1, 1), end_date=None)
    agent = _agent(db)
    db.commit()
    create_assignment(db, schedule_a.id, agent.id)
    create_assignment(db, schedule_b.id, agent.id)
    db.commit()

    result = get_other_active_schedule_ids_for_agent(db, agent.id, exclude_schedule_id=schedule_a.id)

    assert result == [schedule_b.id]


def test_soft_delete_assignments_for_schedule_clears_all_assignees(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    agent1, agent2 = _agent(db, "A1"), _agent(db, "A2")
    db.commit()
    create_assignment(db, schedule.id, agent1.id)
    create_assignment(db, schedule.id, agent2.id)
    db.commit()

    soft_delete_assignments_for_schedule(db, schedule.id)
    db.commit()

    assert list_active_assignee_agent_ids(db, schedule.id) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/components/test_schedule_agents_queries.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.components.schedule_agents.model'`

- [ ] **Step 3: Write the model**

```python
# backend/app/components/schedule_agents/model.py
from datetime import datetime

from sqlalchemy import ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ScheduleAgent(Base):
    __tablename__ = "schedule_agents"

    id: Mapped[int] = mapped_column(primary_key=True)
    schedule_id: Mapped[int] = mapped_column(ForeignKey("schedules.id", ondelete="CASCADE"))
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(default=None)
```

- [ ] **Step 4: Write the queries**

```python
# backend/app/components/schedule_agents/queries.py
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.components.schedule_agents.model import ScheduleAgent


def create_assignment(session: Session, schedule_id: int, agent_id: int) -> ScheduleAgent:
    assignment = ScheduleAgent(schedule_id=schedule_id, agent_id=agent_id)
    session.add(assignment)
    session.flush()
    return assignment


def soft_delete_assignment(session: Session, schedule_id: int, agent_id: int) -> None:
    session.execute(
        update(ScheduleAgent)
        .where(
            ScheduleAgent.schedule_id == schedule_id,
            ScheduleAgent.agent_id == agent_id,
            ScheduleAgent.deleted_at.is_(None),
        )
        .values(deleted_at=datetime.now())
    )


def list_active_assignee_agent_ids(session: Session, schedule_id: int) -> list[int]:
    stmt = select(ScheduleAgent.agent_id).where(
        ScheduleAgent.schedule_id == schedule_id, ScheduleAgent.deleted_at.is_(None)
    )
    return list(session.scalars(stmt))


def get_other_active_schedule_ids_for_agent(
    session: Session, agent_id: int, exclude_schedule_id: int | None = None
) -> list[int]:
    stmt = select(ScheduleAgent.schedule_id).where(
        ScheduleAgent.agent_id == agent_id, ScheduleAgent.deleted_at.is_(None)
    )
    if exclude_schedule_id is not None:
        stmt = stmt.where(ScheduleAgent.schedule_id != exclude_schedule_id)
    return list(session.scalars(stmt))


def soft_delete_assignments_for_schedule(session: Session, schedule_id: int) -> None:
    session.execute(
        update(ScheduleAgent)
        .where(ScheduleAgent.schedule_id == schedule_id, ScheduleAgent.deleted_at.is_(None))
        .values(deleted_at=datetime.now())
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/components/test_schedule_agents_queries.py -v`
Expected: PASS (5 passed)

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/components/schedule_agents/ backend/tests/components/test_schedule_agents_queries.py && git commit -m "feat: ScheduleAgent model + queries, including partial-unique-index reassignment"
```

---

### Task 11: `components/reports` — model, queries, and the bounded report-window query

**Files:**
- Create: `backend/app/components/reports/model.py`
- Create: `backend/app/components/reports/queries.py`
- Test: `backend/tests/components/test_reports_queries.py`

**Interfaces:**
- Produces: `ResolutionReport`, `ResolutionReportAgentHours` ORM models; `create_report(session, ticket_start_at, ticket_end_at) -> ResolutionReport`; `insert_agent_hours(session, report_id, rows: list[tuple[int, int]]) -> None`; `list_reports(session, limit, offset) -> list[ResolutionReport]`; `get_report(session, report_id) -> ResolutionReport | None`; `get_agent_hours_for_report(session, report_id) -> list[ResolutionReportAgentHours]`; `get_active_agent_schedule_pairs(session, window_start: datetime, window_end: datetime) -> list[tuple[int, int | None]]`; `get_weekday_hours_for_schedules(session, schedule_ids: list[int]) -> dict[int, list[ScheduleWeekdayHours]]`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/components/test_reports_queries.py
from datetime import date, datetime, timedelta

from app.components.agents.model import Agent
from app.components.reports.queries import (
    create_report,
    get_active_agent_schedule_pairs,
    get_agent_hours_for_report,
    get_report,
    get_weekday_hours_for_schedules,
    insert_agent_hours,
    list_reports,
)
from app.components.schedule_agents.queries import create_assignment
from app.components.schedules.queries import create_schedule, insert_weekday_hours_rows
from app.domain.types import WeekdayShift


def test_create_and_get_report(db):
    report = create_report(db, ticket_start_at=datetime(2026, 1, 1), ticket_end_at=datetime(2026, 1, 2))
    db.commit()

    fetched = get_report(db, report.id)

    assert fetched is not None
    assert fetched.ticket_start_at == datetime(2026, 1, 1)


def test_insert_and_get_agent_hours_for_report(db):
    agent = Agent(name="Alice")
    db.add(agent)
    db.flush()
    report = create_report(db, ticket_start_at=datetime(2026, 1, 1), ticket_end_at=datetime(2026, 1, 2))
    db.commit()

    insert_agent_hours(db, report.id, [(agent.id, 28800)])
    db.commit()

    rows = get_agent_hours_for_report(db, report.id)
    assert len(rows) == 1
    assert rows[0].agent_id == agent.id
    assert rows[0].business_seconds == 28800


def test_list_reports_orders_by_id(db):
    create_report(db, ticket_start_at=datetime(2026, 1, 1), ticket_end_at=datetime(2026, 1, 2))
    create_report(db, ticket_start_at=datetime(2026, 2, 1), ticket_end_at=datetime(2026, 2, 2))
    db.commit()

    result = list_reports(db, limit=10, offset=0)

    assert len(result) == 2
    assert result[0].id < result[1].id


def test_get_active_agent_schedule_pairs_includes_unassigned_agents(db):
    unassigned = Agent(name="Unassigned")
    assigned = Agent(name="Assigned")
    db.add_all([unassigned, assigned])
    db.flush()
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    create_assignment(db, schedule.id, assigned.id)
    db.commit()

    pairs = get_active_agent_schedule_pairs(db, datetime(2026, 6, 1), datetime(2026, 6, 2))

    pairs_by_agent = {agent_id: schedule_id for agent_id, schedule_id in pairs}
    assert pairs_by_agent[unassigned.id] is None
    assert pairs_by_agent[assigned.id] == schedule.id


def test_get_active_agent_schedule_pairs_excludes_schedules_outside_date_range(db):
    agent = Agent(name="Agent")
    db.add(agent)
    db.flush()
    schedule = create_schedule(db, name="Future", start_date=date(2030, 1, 1), end_date=None)
    db.commit()
    create_assignment(db, schedule.id, agent.id)
    db.commit()

    pairs = get_active_agent_schedule_pairs(db, datetime(2026, 6, 1), datetime(2026, 6, 2))

    pairs_by_agent = {agent_id: schedule_id for agent_id, schedule_id in pairs}
    assert pairs_by_agent[agent.id] is None


def test_get_weekday_hours_for_schedules_groups_by_schedule(db):
    schedule_a = create_schedule(db, name="A", start_date=date(2026, 1, 1), end_date=None)
    schedule_b = create_schedule(db, name="B", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    insert_weekday_hours_rows(
        db, schedule_a.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    )
    insert_weekday_hours_rows(
        db, schedule_b.id, [WeekdayShift(weekday=1, start_time=timedelta(hours=8), end_time=timedelta(hours=16))]
    )
    db.commit()

    result = get_weekday_hours_for_schedules(db, [schedule_a.id, schedule_b.id])

    assert {r.weekday for r in result[schedule_a.id]} == {0}
    assert {r.weekday for r in result[schedule_b.id]} == {1}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/components/test_reports_queries.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.components.reports.model'`

- [ ] **Step 3: Write the model**

```python
# backend/app/components/reports/model.py
from datetime import datetime

from sqlalchemy import ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ResolutionReport(Base):
    __tablename__ = "resolution_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_start_at: Mapped[datetime]
    ticket_end_at: Mapped[datetime]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class ResolutionReportAgentHours(Base):
    __tablename__ = "resolution_report_agent_hours"

    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("resolution_reports.id", ondelete="CASCADE"))
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"))
    business_seconds: Mapped[int]
```

- [ ] **Step 4: Write the queries**

```python
# backend/app/components/reports/queries.py
from collections import defaultdict
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.components.agents.model import Agent
from app.components.reports.model import ResolutionReport, ResolutionReportAgentHours
from app.components.schedule_agents.model import ScheduleAgent
from app.components.schedules.model import Schedule, ScheduleWeekdayHours


def create_report(session: Session, ticket_start_at: datetime, ticket_end_at: datetime) -> ResolutionReport:
    report = ResolutionReport(ticket_start_at=ticket_start_at, ticket_end_at=ticket_end_at)
    session.add(report)
    session.flush()
    return report


def insert_agent_hours(session: Session, report_id: int, rows: list[tuple[int, int]]) -> None:
    session.add_all(
        [
            ResolutionReportAgentHours(report_id=report_id, agent_id=agent_id, business_seconds=seconds)
            for agent_id, seconds in rows
        ]
    )


def list_reports(session: Session, limit: int, offset: int) -> list[ResolutionReport]:
    stmt = select(ResolutionReport).order_by(ResolutionReport.id).limit(limit).offset(offset)
    return list(session.scalars(stmt))


def get_report(session: Session, report_id: int) -> ResolutionReport | None:
    return session.get(ResolutionReport, report_id)


def get_agent_hours_for_report(session: Session, report_id: int) -> list[ResolutionReportAgentHours]:
    stmt = select(ResolutionReportAgentHours).where(ResolutionReportAgentHours.report_id == report_id)
    return list(session.scalars(stmt))


def get_active_agent_schedule_pairs(
    session: Session, window_start: datetime, window_end: datetime
) -> list[tuple[int, int | None]]:
    """Every agent, paired with each active schedule whose effective date
    range overlaps the window. Agents with no matching schedule appear once
    with schedule_id=None (0-hour contribution)."""
    stmt = (
        select(Agent.id, Schedule.id)
        .select_from(Agent)
        .outerjoin(
            ScheduleAgent,
            (ScheduleAgent.agent_id == Agent.id) & (ScheduleAgent.deleted_at.is_(None)),
        )
        .outerjoin(
            Schedule,
            (Schedule.id == ScheduleAgent.schedule_id)
            & (Schedule.deleted_at.is_(None))
            & (Schedule.start_date <= window_end.date())
            & (or_(Schedule.end_date.is_(None), Schedule.end_date >= window_start.date())),
        )
        .order_by(Agent.id)
    )
    return list(session.execute(stmt).all())


def get_weekday_hours_for_schedules(
    session: Session, schedule_ids: list[int]
) -> dict[int, list[ScheduleWeekdayHours]]:
    if not schedule_ids:
        return {}
    stmt = select(ScheduleWeekdayHours).where(
        ScheduleWeekdayHours.schedule_id.in_(schedule_ids), ScheduleWeekdayHours.deleted_at.is_(None)
    )
    result: dict[int, list[ScheduleWeekdayHours]] = defaultdict(list)
    for row in session.scalars(stmt):
        result[row.schedule_id].append(row)
    return dict(result)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/components/test_reports_queries.py -v`
Expected: PASS (6 passed)

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/components/reports/ backend/tests/components/test_reports_queries.py && git commit -m "feat: report models + queries, including the bounded agent-schedule-window query"
```

---

### Task 12: `services/schedule_service.py` — create, get, list

**Files:**
- Create: `backend/app/services/schedule_service.py`
- Test: `backend/tests/services/test_schedule_service.py`

**Interfaces:**
- Consumes: `ShiftInput`, `WeekdayShift` (`app.domain.types`); `normalize_shift`, `recombine_shifts` (`app.domain.shift_normalization`); `find_self_overlaps` (`app.domain.overlap`); `ScheduleOverlapError`, `NotFoundError` (`app.errors.error`); the `components/schedules` query functions; `db_session_write`, `db_session_read` (`app.db`).
- Produces: `@dataclass ScheduleDetail(id: int, name: str, start_date: date, end_date: date | None, shifts: list[ShiftInput])`; `create_schedule(name: str, start_date: date, end_date: date | None, shift_inputs: list[ShiftInput]) -> ScheduleDetail`; `get_schedule_detail(schedule_id: int) -> ScheduleDetail`; `list_schedules(limit: int, offset: int) -> list[ScheduleDetail]`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/services/test_schedule_service.py
from datetime import date, timedelta

import pytest

from app.domain.types import ShiftInput
from app.errors.error import NotFoundError, ScheduleOverlapError
from app.services.schedule_service import create_schedule, get_schedule_detail, list_schedules


def test_create_schedule_persists_and_recombines_shifts(db):
    detail = create_schedule(
        name="Day Shift",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )

    assert detail.name == "Day Shift"
    assert detail.shifts == [
        ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    ]


def test_create_schedule_recombines_overnight_shift_for_display(db):
    detail = create_schedule(
        name="Night Shift",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))],
    )

    assert detail.shifts == [
        ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    ]


def test_create_schedule_rejects_self_overlapping_shifts(db):
    # Monday-night overnight shift's tail (Tue 00:00-06:00) collides with
    # a separately-configured Tuesday 05:00-13:00 shift.
    with pytest.raises(ScheduleOverlapError):
        create_schedule(
            name="Broken",
            start_date=date(2026, 1, 1),
            end_date=None,
            shift_inputs=[
                ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6)),
                ShiftInput(weekday=1, start_time=timedelta(hours=5), end_time=timedelta(hours=13)),
            ],
        )


def test_get_schedule_detail_raises_not_found(db):
    with pytest.raises(NotFoundError):
        get_schedule_detail(999)


def test_list_schedules_returns_created_schedules(db):
    create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    create_schedule(name="B", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])

    result = list_schedules(limit=10, offset=0)

    assert [s.name for s in result] == ["A", "B"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_schedule_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.schedule_service'`

- [ ] **Step 3: Write the shared ORM-row-to-domain-type conversion helper**

`schedule_service`, `assignment_service`, and `report_service` all need to convert a `ScheduleWeekdayHours` ORM row into a domain `WeekdayShift`. Writing that conversion once here, rather than inline in each service, is what keeps it from drifting into three slightly-different copies as later tasks are added.

```python
# backend/app/services/_conversions.py
from app.domain.types import WeekdayShift


def weekday_shift_from_row(row) -> WeekdayShift:
    """Convert a ScheduleWeekdayHours ORM row into a domain WeekdayShift.
    The one place this conversion is written -- every service imports this
    rather than reconstructing it inline."""
    return WeekdayShift(
        weekday=row.weekday,
        start_time=row.start_time,
        end_time=row.end_time,
        is_overnight_tail=row.is_overnight_tail,
    )
```

- [ ] **Step 4: Write the implementation**

```python
# backend/app/services/schedule_service.py
import logging
import time
from dataclasses import dataclass
from datetime import date

from app.components.schedules import queries as schedules_queries
from app.db import db_session_read, db_session_write
from app.domain.overlap import find_self_overlaps
from app.domain.shift_normalization import normalize_shift, recombine_shifts
from app.domain.types import ShiftInput
from app.errors.error import NotFoundError, ScheduleOverlapError
from app.services._conversions import weekday_shift_from_row

logger = logging.getLogger("richpanel.schedule_service")


@dataclass(frozen=True)
class ScheduleDetail:
    id: int
    name: str
    start_date: date
    end_date: date | None
    shifts: list[ShiftInput]


def _to_detail(schedule, weekday_hours_rows) -> ScheduleDetail:
    normalized = [weekday_shift_from_row(r) for r in weekday_hours_rows]
    return ScheduleDetail(
        id=schedule.id,
        name=schedule.name,
        start_date=schedule.start_date,
        end_date=schedule.end_date,
        shifts=recombine_shifts(normalized),
    )


def create_schedule(
    name: str, start_date: date, end_date: date | None, shift_inputs: list[ShiftInput]
) -> ScheduleDetail:
    started = time.perf_counter()
    normalized_shifts = [ws for shift in shift_inputs for ws in normalize_shift(shift)]

    conflicts = find_self_overlaps(normalized_shifts)
    if conflicts:
        raise ScheduleOverlapError(conflicts)

    with db_session_write() as session:
        schedule = schedules_queries.create_schedule(session, name=name, start_date=start_date, end_date=end_date)
        schedules_queries.insert_weekday_hours_rows(session, schedule.id, normalized_shifts)
        rows = schedules_queries.get_weekday_hours_rows(session, schedule.id)
        detail = _to_detail(schedule, rows)

    logger.info(
        "schedule created",
        extra={"schedule_id": detail.id, "shift_count": len(normalized_shifts), "duration_ms": round((time.perf_counter() - started) * 1000, 2)},
    )
    return detail


def get_schedule_detail(schedule_id: int) -> ScheduleDetail:
    with db_session_read() as session:
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")
        rows = schedules_queries.get_weekday_hours_rows(session, schedule_id)
        return _to_detail(schedule, rows)


def list_schedules(limit: int, offset: int) -> list[ScheduleDetail]:
    with db_session_read() as session:
        schedules = schedules_queries.list_active_schedules(session, limit, offset)
        return [_to_detail(s, schedules_queries.get_weekday_hours_rows(session, s.id)) for s in schedules]
```

Note the logging call here: it uses `extra={...}` rather than string-formatting the values into the message. That's deliberate — Task 16 configures a JSON formatter that reads fields out of `extra` and emits them as top-level JSON keys (`schedule_id`, `shift_count`, `duration_ms`), so this line ends up queryable in log tooling rather than buried in free text. Every later task's logging follows this same `extra={...}` convention.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_schedule_service.py -v`
Expected: PASS (5 passed)

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/services/schedule_service.py backend/app/services/_conversions.py backend/tests/services/test_schedule_service.py && git commit -m "feat: schedule_service create/get/list with self-overlap validation"
```

---

### Task 13: `services/schedule_service.py` — update (locked re-validation), deletion impact, soft delete

**Files:**
- Modify: `backend/app/services/schedule_service.py`
- Modify: `backend/tests/services/test_schedule_service.py`

**Interfaces:**
- Consumes (new, added this task): `get_other_active_schedule_ids_for_agent`, `list_active_assignee_agent_ids`, `soft_delete_assignments_for_schedule` (`app.components.schedule_agents.queries`); `find_overlaps` (`app.domain.overlap`); `AssignmentOverlapError` (`app.errors.error`); `Agent`, `get_agent` (`app.components.agents.queries`).
- Produces (new, added this task): `@dataclass DeletionImpact(schedule_id: int, affected_agent_ids: list[int])`; `update_schedule_hours(schedule_id: int, shift_inputs: list[ShiftInput]) -> ScheduleDetail` (raises `ScheduleOverlapError` for self-conflicts or `AssignmentOverlapError` listing affected agents for cross-schedule conflicts); `get_deletion_impact(schedule_id: int) -> DeletionImpact`; `soft_delete_schedule(schedule_id: int) -> None`.

- [ ] **Step 1: Write the failing tests (append to the existing test file)**

```python
# append to backend/tests/services/test_schedule_service.py
from app.components.schedule_agents.queries import create_assignment, list_active_assignee_agent_ids
from app.components.agents.model import Agent
from app.errors.error import AssignmentOverlapError
from app.services.schedule_service import get_deletion_impact, soft_delete_schedule, update_schedule_hours
from app.db import db_session_write


def _create_agent(name="Agent") -> int:
    with db_session_write() as session:
        agent = Agent(name=name)
        session.add(agent)
        session.flush()
        return agent.id


def test_update_schedule_hours_applies_clean_edit(db):
    detail = create_schedule(
        name="Day Shift",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )

    updated = update_schedule_hours(
        detail.id, [ShiftInput(weekday=0, start_time=timedelta(hours=8), end_time=timedelta(hours=16))]
    )

    assert updated.shifts == [
        ShiftInput(weekday=0, start_time=timedelta(hours=8), end_time=timedelta(hours=16))
    ]


def test_update_schedule_hours_rejects_edit_that_creates_agent_overlap(db):
    schedule_a = create_schedule(
        name="A",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=13))],
    )
    schedule_b = create_schedule(
        name="B",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=14), end_time=timedelta(hours=18))],
    )
    agent_id = _create_agent()
    with db_session_write() as session:
        create_assignment(session, schedule_a.id, agent_id)
        create_assignment(session, schedule_b.id, agent_id)

    # editing schedule_b to now overlap schedule_a's 9-13 window
    with pytest.raises(AssignmentOverlapError) as exc_info:
        update_schedule_hours(
            schedule_b.id, [ShiftInput(weekday=0, start_time=timedelta(hours=10), end_time=timedelta(hours=18))]
        )
    assert exc_info.value.agent_id == agent_id

    # nothing was written: schedule_b's hours are unchanged
    still_old = get_schedule_detail(schedule_b.id)
    assert still_old.shifts == [
        ShiftInput(weekday=0, start_time=timedelta(hours=14), end_time=timedelta(hours=18))
    ]


def test_get_deletion_impact_lists_affected_agents(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    with db_session_write() as session:
        create_assignment(session, schedule.id, agent_id)

    impact = get_deletion_impact(schedule.id)

    assert impact.schedule_id == schedule.id
    assert impact.affected_agent_ids == [agent_id]


def test_soft_delete_schedule_cascades_to_assignments(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    with db_session_write() as session:
        create_assignment(session, schedule.id, agent_id)

    soft_delete_schedule(schedule.id)

    with pytest.raises(NotFoundError):
        get_schedule_detail(schedule.id)
    with db_session_write() as session:
        assert list_active_assignee_agent_ids(session, schedule.id) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_schedule_service.py -v`
Expected: FAIL — `ImportError: cannot import name 'update_schedule_hours' from 'app.services.schedule_service'`

- [ ] **Step 3: Extend the implementation**

Replace the top of `backend/app/services/schedule_service.py` (the import block) with:

```python
import logging
import time
from dataclasses import dataclass
from datetime import date

from sqlalchemy import text

from app.components.schedule_agents import queries as schedule_agents_queries
from app.components.schedules import queries as schedules_queries
from app.db import db_session_read, db_session_write
from app.domain.overlap import find_overlaps, find_self_overlaps
from app.domain.shift_normalization import normalize_shift, recombine_shifts
from app.domain.types import ShiftInput
from app.errors.error import AssignmentOverlapError, NotFoundError, ScheduleOverlapError
from app.services._conversions import weekday_shift_from_row

logger = logging.getLogger("richpanel.schedule_service")
```

Then add these functions at the end of the file:

```python
@dataclass(frozen=True)
class DeletionImpact:
    schedule_id: int
    affected_agent_ids: list[int]


def update_schedule_hours(schedule_id: int, shift_inputs: list[ShiftInput]) -> ScheduleDetail:
    normalized_shifts = [ws for shift in shift_inputs for ws in normalize_shift(shift)]

    self_conflicts = find_self_overlaps(normalized_shifts)
    if self_conflicts:
        raise ScheduleOverlapError(self_conflicts)

    with db_session_write() as session:
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")

        assignee_ids = sorted(schedule_agents_queries.list_active_assignee_agent_ids(session, schedule_id))

        lock_started = time.perf_counter()
        for agent_id in assignee_ids:
            session.execute(text("SELECT pg_advisory_xact_lock(:aid)"), {"aid": agent_id})
        lock_wait_ms = round((time.perf_counter() - lock_started) * 1000, 2)

        for agent_id in assignee_ids:
            other_schedule_ids = schedule_agents_queries.get_other_active_schedule_ids_for_agent(
                session, agent_id, exclude_schedule_id=schedule_id
            )
            existing_shifts = [
                weekday_shift_from_row(r)
                for other_id in other_schedule_ids
                for r in schedules_queries.get_weekday_hours_rows(session, other_id)
            ]
            conflicts = find_overlaps(existing_shifts, normalized_shifts)
            if conflicts:
                logger.info(
                    "schedule edit rejected: assignment overlap",
                    extra={"schedule_id": schedule_id, "agent_id": agent_id, "lock_wait_ms": lock_wait_ms},
                )
                raise AssignmentOverlapError(agent_id=agent_id, conflicts=conflicts)

        schedules_queries.replace_weekday_hours_rows(session, schedule_id, normalized_shifts)
        rows = schedules_queries.get_weekday_hours_rows(session, schedule_id)
        detail = _to_detail(schedule, rows)

    logger.info(
        "schedule hours updated",
        extra={"schedule_id": schedule_id, "assignee_count": len(assignee_ids), "lock_wait_ms": lock_wait_ms},
    )
    return detail


def get_deletion_impact(schedule_id: int) -> DeletionImpact:
    with db_session_read() as session:
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")
        agent_ids = schedule_agents_queries.list_active_assignee_agent_ids(session, schedule_id)
        return DeletionImpact(schedule_id=schedule_id, affected_agent_ids=agent_ids)


def soft_delete_schedule(schedule_id: int) -> None:
    with db_session_write() as session:
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")
        schedules_queries.soft_delete_schedule(session, schedule_id)
        schedule_agents_queries.soft_delete_assignments_for_schedule(session, schedule_id)
        schedules_queries.soft_delete_weekday_hours_for_schedule(session, schedule_id)
    logger.info("schedule soft-deleted", extra={"schedule_id": schedule_id})
```

Note `lock_wait_ms` measures the time spent acquiring every assignee's advisory lock before any conflict-checking begins — a slow or contended lock is exactly the kind of thing worth being able to see in logs later, since the whole overlap-prevention design depends on that lock never becoming a bottleneck.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_schedule_service.py -v`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/services/schedule_service.py backend/tests/services/test_schedule_service.py && git commit -m "feat: schedule_service update (locked re-validation), deletion impact, soft delete"
```

---

### Task 14: `services/assignment_service.py` — assign, unassign, list

**Files:**
- Create: `backend/app/services/assignment_service.py`
- Test: `backend/tests/services/test_assignment_service.py`

**Interfaces:**
- Consumes: `WeekdayShift` (`app.domain.types`); `find_overlaps` (`app.domain.overlap`); `AssignmentOverlapError`, `NotFoundError` (`app.errors.error`); `components/schedules`, `components/schedule_agents`, `components/agents` query functions.
- Produces: `assign_agent(schedule_id: int, agent_id: int) -> None` (raises `AssignmentOverlapError` or `NotFoundError`); `unassign_agent(schedule_id: int, agent_id: int) -> None`; `list_assignees(schedule_id: int) -> list[Agent]` (`Agent` from `app.components.agents.model`).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/services/test_assignment_service.py
from datetime import date, timedelta

import pytest

from app.db import db_session_write
from app.domain.types import ShiftInput
from app.errors.error import AssignmentOverlapError, NotFoundError
from app.services.assignment_service import assign_agent, list_assignees, unassign_agent
from app.services.schedule_service import create_schedule


def _create_agent(name="Agent") -> int:
    from app.components.agents.model import Agent

    with db_session_write() as session:
        agent = Agent(name=name)
        session.add(agent)
        session.flush()
        return agent.id


def test_assign_agent_succeeds_for_non_overlapping_schedules(db):
    schedule_a = create_schedule(
        name="A",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=13))],
    )
    schedule_b = create_schedule(
        name="B",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=14), end_time=timedelta(hours=18))],
    )
    agent_id = _create_agent()

    assign_agent(schedule_a.id, agent_id)
    assign_agent(schedule_b.id, agent_id)

    names = {a.id for a in list_assignees(schedule_a.id)}
    assert names == {agent_id}


def test_assign_agent_rejects_overlapping_schedule(db):
    schedule_a = create_schedule(
        name="A",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    schedule_b = create_schedule(
        name="B",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=12), end_time=timedelta(hours=20))],
    )
    agent_id = _create_agent()
    assign_agent(schedule_a.id, agent_id)

    with pytest.raises(AssignmentOverlapError):
        assign_agent(schedule_b.id, agent_id)

    assert list_assignees(schedule_b.id) == []


def test_assign_agent_raises_not_found_for_missing_schedule(db):
    agent_id = _create_agent()
    with pytest.raises(NotFoundError):
        assign_agent(999, agent_id)


def test_unassign_agent_removes_from_active_list(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    unassign_agent(schedule.id, agent_id)

    assert list_assignees(schedule.id) == []


def test_reassign_after_unassign_succeeds(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)
    unassign_agent(schedule.id, agent_id)

    assign_agent(schedule.id, agent_id)

    assert {a.id for a in list_assignees(schedule.id)} == {agent_id}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_assignment_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.assignment_service'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/services/assignment_service.py
import logging
import time

from sqlalchemy import text

from app.components.agents.model import Agent
from app.components.agents.queries import get_agent
from app.components.schedule_agents import queries as schedule_agents_queries
from app.components.schedules import queries as schedules_queries
from app.db import db_session_read, db_session_write
from app.domain.overlap import find_overlaps
from app.domain.types import WeekdayShift
from app.errors.error import AssignmentOverlapError, NotFoundError
from app.services._conversions import weekday_shift_from_row

logger = logging.getLogger("richpanel.assignment_service")


def _weekday_shifts_for_schedule(session, schedule_id: int) -> list[WeekdayShift]:
    return [weekday_shift_from_row(r) for r in schedules_queries.get_weekday_hours_rows(session, schedule_id)]


def assign_agent(schedule_id: int, agent_id: int) -> None:
    with db_session_write() as session:
        # check-then-write must share this one locked transaction (see Global Constraints)
        lock_started = time.perf_counter()
        session.execute(text("SELECT pg_advisory_xact_lock(:aid)"), {"aid": agent_id})
        lock_wait_ms = round((time.perf_counter() - lock_started) * 1000, 2)

        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")

        other_schedule_ids = schedule_agents_queries.get_other_active_schedule_ids_for_agent(session, agent_id)
        existing_shifts: list[WeekdayShift] = []
        for other_id in other_schedule_ids:
            existing_shifts.extend(_weekday_shifts_for_schedule(session, other_id))

        new_shifts = _weekday_shifts_for_schedule(session, schedule_id)
        conflicts = find_overlaps(existing_shifts, new_shifts)
        if conflicts:
            logger.info(
                "assignment rejected: overlap",
                extra={"schedule_id": schedule_id, "agent_id": agent_id, "lock_wait_ms": lock_wait_ms},
            )
            raise AssignmentOverlapError(agent_id=agent_id, conflicts=conflicts)

        schedule_agents_queries.create_assignment(session, schedule_id, agent_id)

    logger.info(
        "agent assigned", extra={"schedule_id": schedule_id, "agent_id": agent_id, "lock_wait_ms": lock_wait_ms}
    )


def unassign_agent(schedule_id: int, agent_id: int) -> None:
    with db_session_write() as session:
        schedule_agents_queries.soft_delete_assignment(session, schedule_id, agent_id)
    logger.info("agent unassigned", extra={"schedule_id": schedule_id, "agent_id": agent_id})


def list_assignees(schedule_id: int) -> list[Agent]:
    with db_session_read() as session:
        agent_ids = schedule_agents_queries.list_active_assignee_agent_ids(session, schedule_id)
        return [get_agent(session, aid) for aid in agent_ids]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_assignment_service.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/services/assignment_service.py backend/tests/services/test_assignment_service.py && git commit -m "feat: assignment_service with advisory-lock overlap check"
```

---

### Task 15: `services/report_service.py` — generate, list, get

**Files:**
- Create: `backend/app/services/report_service.py`
- Test: `backend/tests/services/test_report_service.py`

**Interfaces:**
- Consumes: `calculate_business_seconds` (`app.domain.business_hours`); `WeekdayShift` (`app.domain.types`); `components/reports` query functions; `NotFoundError` (`app.errors.error`).
- Produces: `@dataclass AgentHoursRow(agent_id: int, business_seconds: int)`; `@dataclass ReportResult(id: int, ticket_start_at: datetime, ticket_end_at: datetime, agent_hours: list[AgentHoursRow])`; `generate_report(ticket_start_at: datetime, ticket_end_at: datetime) -> ReportResult`; `list_reports(limit: int, offset: int) -> list[ReportResult]` (agent_hours empty for the list view); `get_report(report_id: int) -> ReportResult`.

This task demonstrates the "release the connection before computing" pattern from Global Constraints: fetch with `db_session_read`, release it, run the (DB-free) closed-form calculation, then persist with a fresh `db_session_write`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/services/test_report_service.py
from datetime import date, datetime, timedelta

import pytest

from app.db import db_session_write
from app.domain.types import ShiftInput
from app.errors.error import NotFoundError
from app.services.assignment_service import assign_agent
from app.services.report_service import generate_report, get_report, list_reports
from app.services.schedule_service import create_schedule


def _create_agent(name="Agent") -> int:
    from app.components.agents.model import Agent

    with db_session_write() as session:
        agent = Agent(name=name)
        session.add(agent)
        session.flush()
        return agent.id


def test_generate_report_computes_hours_for_assigned_agent(db):
    schedule = create_schedule(
        name="Day Shift",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=1, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    result = generate_report(
        ticket_start_at=datetime(2026, 1, 6, 10, 0, 0),  # Tuesday 10:00
        ticket_end_at=datetime(2026, 1, 6, 14, 0, 0),  # Tuesday 14:00
    )

    row = next(r for r in result.agent_hours if r.agent_id == agent_id)
    assert row.business_seconds == 4 * 3600


def test_generate_report_includes_unassigned_agents_at_zero(db):
    unassigned_id = _create_agent("Unassigned")

    result = generate_report(
        ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0)
    )

    row = next(r for r in result.agent_hours if r.agent_id == unassigned_id)
    assert row.business_seconds == 0


def test_generate_report_persists_and_is_retrievable(db):
    generated = generate_report(
        ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0)
    )

    fetched = get_report(generated.id)

    assert fetched.id == generated.id
    assert fetched.ticket_start_at == generated.ticket_start_at
    assert {r.agent_id for r in fetched.agent_hours} == {r.agent_id for r in generated.agent_hours}


def test_generate_report_rejects_end_before_start(db):
    with pytest.raises(ValueError, match="after"):
        generate_report(ticket_start_at=datetime(2026, 1, 6, 14, 0, 0), ticket_end_at=datetime(2026, 1, 6, 10, 0, 0))


def test_get_report_raises_not_found(db):
    with pytest.raises(NotFoundError):
        get_report(999)


def test_list_reports_returns_summaries(db):
    generate_report(ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0))

    result = list_reports(limit=10, offset=0)

    assert len(result) == 1


def test_generate_report_logs_phase_durations(db, caplog):
    import logging

    with caplog.at_level(logging.INFO, logger="richpanel.report_service"):
        generate_report(ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0))

    records = [r for r in caplog.records if r.name == "richpanel.report_service"]
    assert len(records) == 1
    assert hasattr(records[0], "read_ms")
    assert hasattr(records[0], "compute_ms")
    assert hasattr(records[0], "write_ms")
    assert hasattr(records[0], "agent_count")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_report_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.report_service'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/services/report_service.py
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime

from app.components.reports import queries as reports_queries
from app.db import db_session_read, db_session_write
from app.domain.business_hours import calculate_business_seconds
from app.domain.types import WeekdayShift
from app.errors.error import NotFoundError
from app.services._conversions import weekday_shift_from_row

logger = logging.getLogger("richpanel.report_service")


@dataclass(frozen=True)
class AgentHoursRow:
    agent_id: int
    business_seconds: int


@dataclass(frozen=True)
class ReportResult:
    id: int
    ticket_start_at: datetime
    ticket_end_at: datetime
    agent_hours: list[AgentHoursRow] = field(default_factory=list)


def generate_report(ticket_start_at: datetime, ticket_end_at: datetime) -> ReportResult:
    if ticket_end_at <= ticket_start_at:
        raise ValueError("ticket_end_at must be after ticket_start_at")

    # 1. Read: fetch the bounded row set, then release the connection.
    read_started = time.perf_counter()
    with db_session_read() as session:
        pairs = reports_queries.get_active_agent_schedule_pairs(session, ticket_start_at, ticket_end_at)
        schedule_ids = sorted({sid for _, sid in pairs if sid is not None})
        weekday_hours_by_schedule = reports_queries.get_weekday_hours_for_schedules(session, schedule_ids)
    read_ms = round((time.perf_counter() - read_started) * 1000, 2)

    # 2. Compute: pure in-memory work, no DB connection held during this.
    compute_started = time.perf_counter()
    weekly_shifts_by_schedule: dict[int, list[WeekdayShift]] = {
        sid: [weekday_shift_from_row(r) for r in rows] for sid, rows in weekday_hours_by_schedule.items()
    }

    totals_by_agent: dict[int, int] = {}
    for agent_id, schedule_id in pairs:
        totals_by_agent.setdefault(agent_id, 0)
        if schedule_id is None:
            continue
        shifts = weekly_shifts_by_schedule.get(schedule_id, [])
        totals_by_agent[agent_id] += calculate_business_seconds(shifts, ticket_start_at, ticket_end_at)
    compute_ms = round((time.perf_counter() - compute_started) * 1000, 2)

    # 3. Write: fresh session, only to persist the already-computed result.
    write_started = time.perf_counter()
    with db_session_write() as session:
        report = reports_queries.create_report(session, ticket_start_at, ticket_end_at)
        reports_queries.insert_agent_hours(session, report.id, list(totals_by_agent.items()))
        report_id = report.id
    write_ms = round((time.perf_counter() - write_started) * 1000, 2)

    logger.info(
        "report generated",
        extra={
            "report_id": report_id,
            "agent_count": len(totals_by_agent),
            "schedule_count": len(schedule_ids),
            "read_ms": read_ms,
            "compute_ms": compute_ms,
            "write_ms": write_ms,
        },
    )

    return ReportResult(
        id=report_id,
        ticket_start_at=ticket_start_at,
        ticket_end_at=ticket_end_at,
        agent_hours=[AgentHoursRow(agent_id=aid, business_seconds=secs) for aid, secs in totals_by_agent.items()],
    )


def get_report(report_id: int) -> ReportResult:
    with db_session_read() as session:
        report = reports_queries.get_report(session, report_id)
        if report is None:
            raise NotFoundError(f"report {report_id} not found")
        agent_hours = reports_queries.get_agent_hours_for_report(session, report_id)
        return ReportResult(
            id=report.id,
            ticket_start_at=report.ticket_start_at,
            ticket_end_at=report.ticket_end_at,
            agent_hours=[
                AgentHoursRow(agent_id=r.agent_id, business_seconds=r.business_seconds) for r in agent_hours
            ],
        )


def list_reports(limit: int, offset: int) -> list[ReportResult]:
    with db_session_read() as session:
        reports = reports_queries.list_reports(session, limit, offset)
        return [
            ReportResult(id=r.id, ticket_start_at=r.ticket_start_at, ticket_end_at=r.ticket_end_at)
            for r in reports
        ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_report_service.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/services/report_service.py backend/tests/services/test_report_service.py && git commit -m "feat: report_service — read/compute/write separated per session discipline"
```

---

### Task 16: `shared/pagination.py`, global exception handling, and request-timing middleware in `main.py`

**Files:**
- Create: `backend/app/shared/pagination.py`
- Create: `backend/app/shared/__init__.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_exception_handlers.py`, `backend/tests/test_request_logging.py`

**Interfaces:**
- Produces: `PaginationParams` (Pydantic model with `limit: int = 50`, `offset: int = 0`, both validated `>= 0`, `limit <= 200`) as a FastAPI dependency; `register_exception_handlers(app: FastAPI) -> None` mapping `NotFoundError` → 404, `ConflictError` → 409, `DomainValidationError` → 400, and any other `Exception` → 500 with no internal detail leaked; `register_request_logging(app: FastAPI) -> None` — middleware logging every request's method/path/status/duration_ms as one structured JSON line via the Task 1 `JsonFormatter`.

- [ ] **Step 1: Write the failing exception-handler test**

```python
# backend/tests/test_exception_handlers.py
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors.error import ConflictError, DomainValidationError, NotFoundError
from app.main import register_exception_handlers


def _build_test_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/not-found")
    def raise_not_found():
        raise NotFoundError("nope")

    @app.get("/conflict")
    def raise_conflict():
        raise ConflictError("nope")

    @app.get("/invalid")
    def raise_invalid():
        raise DomainValidationError("nope")

    @app.get("/boom")
    def raise_unexpected():
        raise RuntimeError("internal secret detail")

    return app


def test_not_found_error_maps_to_404():
    client = TestClient(_build_test_app())
    response = client.get("/not-found")
    assert response.status_code == 404
    assert response.json()["error_code"] == "not_found"


def test_conflict_error_maps_to_409():
    client = TestClient(_build_test_app())
    response = client.get("/conflict")
    assert response.status_code == 409


def test_domain_validation_error_maps_to_400():
    client = TestClient(_build_test_app())
    response = client.get("/invalid")
    assert response.status_code == 400


def test_unexpected_error_maps_to_500_without_leaking_detail():
    client = TestClient(_build_test_app(), raise_server_exceptions=False)
    response = client.get("/boom")
    assert response.status_code == 500
    assert "internal secret detail" not in response.text
```

- [ ] **Step 2: Write the failing request-logging middleware test**

```python
# backend/tests/test_request_logging.py
import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import register_request_logging


def _build_test_app() -> FastAPI:
    app = FastAPI()
    register_request_logging(app)

    @app.get("/ping")
    def ping():
        return {"pong": True}

    return app


def test_request_logging_records_method_path_status_and_duration(caplog):
    client = TestClient(_build_test_app())

    with caplog.at_level(logging.INFO, logger="richpanel.request"):
        response = client.get("/ping")

    assert response.status_code == 200
    records = [r for r in caplog.records if r.name == "richpanel.request"]
    assert len(records) == 1
    assert records[0].method == "GET"
    assert records[0].path == "/ping"
    assert records[0].status_code == 200
    assert isinstance(records[0].duration_ms, float)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_exception_handlers.py tests/test_request_logging.py -v`
Expected: FAIL — `ImportError: cannot import name 'register_exception_handlers' from 'app.main'` (neither function exists yet)

- [ ] **Step 4: Write `shared/pagination.py`**

```python
# backend/app/shared/pagination.py
from pydantic import BaseModel, Field


class PaginationParams(BaseModel):
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)
```

- [ ] **Step 5: Extend `main.py` with exception handlers and request-timing middleware**

This builds on Task 1's `main.py` (which already calls `configure_logging()` before the app is constructed) — that call stays; this step adds to the same file rather than replacing it.

```python
# backend/app/main.py
import logging
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.errors.error import AppError, ConflictError, DomainValidationError, NotFoundError
from app.logging_config import configure_logging

configure_logging()

logger = logging.getLogger("richpanel")
request_logger = logging.getLogger("richpanel.request")

STATUS_BY_ERROR_TYPE = [
    (NotFoundError, 404, "not_found"),
    (ConflictError, 409, "conflict"),
    (DomainValidationError, 400, "validation_error"),
]


def register_exception_handlers(app: FastAPI) -> None:
    for error_type, status_code, error_code in STATUS_BY_ERROR_TYPE:

        def _make_handler(status_code=status_code, error_code=error_code):
            async def _handler(request: Request, exc: AppError):
                return JSONResponse(status_code=status_code, content={"error_code": error_code, "message": str(exc)})

            return _handler

        app.add_exception_handler(error_type, _make_handler())

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(request: Request, exc: Exception):
        logger.error(
            "unhandled exception",
            extra={"method": request.method, "path": request.url.path},
            exc_info=exc,
        )
        return JSONResponse(status_code=500, content={"error_code": "internal_error", "message": "internal server error"})


def register_request_logging(app: FastAPI) -> None:
    @app.middleware("http")
    async def _log_requests(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        request_logger.info(
            "request handled",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        return response


app = FastAPI(title="Richpanel Schedule & Resolution Time Report")
register_exception_handlers(app)
register_request_logging(app)


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_exception_handlers.py tests/test_request_logging.py tests/test_health.py -v`
Expected: PASS (6 passed)

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/shared/ backend/app/main.py backend/tests/test_exception_handlers.py backend/tests/test_request_logging.py && git commit -m "feat: shared pagination params, global exception handlers, request-timing middleware"
```

---

### Task 17: `api/v1/agents` — router and schemas

**Files:**
- Create: `backend/app/api/v1/agents/request_response.py`
- Create: `backend/app/api/v1/agents/router.py`
- Test: `backend/tests/api/test_agents_api.py`

**Interfaces:**
- Consumes: `list_agents`, `get_agent` (`app.components.agents.queries`); `db_session_read` (`app.db`); `PaginationParams` (`app.shared.pagination`); `list_schedules_for_agent` from `assignment_service` — **not yet built**; this task adds it as a small addition to `assignment_service.py`.
- Produces: `AgentResponse(id: int, name: str, email: str | None)`; `router: APIRouter` mounted with routes `GET /` (list) and `GET /{agent_id}/schedules` (that agent's active schedule summaries).

- [ ] **Step 1: Add the missing `list_schedules_for_agent` to assignment_service (small, TDD first)**

```python
# backend/tests/services/test_assignment_service.py — append
from app.services.assignment_service import list_schedules_for_agent


def test_list_schedules_for_agent_returns_active_schedules(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    result = list_schedules_for_agent(agent_id)

    assert [s.id for s in result] == [schedule.id]
```

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_assignment_service.py -v`
Expected: FAIL — `ImportError: cannot import name 'list_schedules_for_agent'`

Add to `backend/app/services/assignment_service.py`:

```python
from app.components.schedules.model import Schedule


def list_schedules_for_agent(agent_id: int) -> list[Schedule]:
    with db_session_read() as session:
        schedule_ids = schedule_agents_queries.get_other_active_schedule_ids_for_agent(session, agent_id)
        return [schedules_queries.get_schedule(session, sid) for sid in schedule_ids]
```

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_assignment_service.py -v`
Expected: PASS (6 passed)

Commit: `git add backend/app/services/assignment_service.py backend/tests/services/test_assignment_service.py && git commit -m "feat: list_schedules_for_agent"` (run from `~/Desktop/Richpanel`)

- [ ] **Step 2: Write the failing API test**

```python
# backend/tests/api/test_agents_api.py
from datetime import date

from fastapi.testclient import TestClient

from app.components.agents.model import Agent
from app.db import db_session_write
from app.main import app
from app.services.assignment_service import assign_agent
from app.services.schedule_service import create_schedule


def test_list_agents_returns_seeded_agents(db):
    with db_session_write() as session:
        session.add_all([Agent(name="Alice"), Agent(name="Bob")])

    response = TestClient(app).get("/api/v1/agents")

    assert response.status_code == 200
    names = {a["name"] for a in response.json()}
    assert names == {"Alice", "Bob"}


def test_get_schedules_for_agent(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    with db_session_write() as session:
        agent = Agent(name="Alice")
        session.add(agent)
        session.flush()
        agent_id = agent.id
    assign_agent(schedule.id, agent_id)

    response = TestClient(app).get(f"/api/v1/agents/{agent_id}/schedules")

    assert response.status_code == 200
    assert [s["id"] for s in response.json()] == [schedule.id]
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/api/test_agents_api.py -v`
Expected: FAIL — 404 (no `/api/v1/agents` route registered yet)

- [ ] **Step 4: Write the schemas**

```python
# backend/app/api/v1/agents/request_response.py
from pydantic import BaseModel


class AgentResponse(BaseModel):
    id: int
    name: str
    email: str | None


class ScheduleSummaryResponse(BaseModel):
    id: int
    name: str
```

- [ ] **Step 5: Write the router**

```python
# backend/app/api/v1/agents/router.py
from fastapi import APIRouter, Depends

from app.api.v1.agents.request_response import AgentResponse, ScheduleSummaryResponse
from app.components.agents import queries as agents_queries
from app.db import db_session_read
from app.services.assignment_service import list_schedules_for_agent
from app.shared.pagination import PaginationParams

router = APIRouter(prefix="/api/v1/agents", tags=["agents"])


@router.get("", response_model=list[AgentResponse])
def list_agents(pagination: PaginationParams = Depends()):
    with db_session_read() as session:
        agents = agents_queries.list_agents(session, pagination.limit, pagination.offset)
        return [AgentResponse(id=a.id, name=a.name, email=a.email) for a in agents]


@router.get("/{agent_id}/schedules", response_model=list[ScheduleSummaryResponse])
def get_schedules_for_agent(agent_id: int):
    schedules = list_schedules_for_agent(agent_id)
    return [ScheduleSummaryResponse(id=s.id, name=s.name) for s in schedules]
```

- [ ] **Step 6: Register the router in `main.py`**

Add to `backend/app/main.py`, after `register_exception_handlers(app)`:

```python
from app.api.v1.agents.router import router as agents_router

app.include_router(agents_router)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/api/test_agents_api.py -v`
Expected: PASS (2 passed)

- [ ] **Step 8: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/api/v1/agents/ backend/app/main.py backend/tests/api/test_agents_api.py && git commit -m "feat: agents API router"
```

---

### Task 18: `api/v1/schedules` — router and schemas

**Files:**
- Create: `backend/app/api/v1/schedules/request_response.py`
- Create: `backend/app/api/v1/schedules/router.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/api/test_schedules_api.py`

**Interfaces:**
- Consumes: `schedule_service.{create_schedule, get_schedule_detail, list_schedules, update_schedule_hours, get_deletion_impact, soft_delete_schedule}`; `PaginationParams`.
- Produces: `ShiftInputSchema(weekday: int, start_hours: float, end_hours: float)` (float hours for a simple wire format — e.g. `22.5` = 22:30) with a `.to_domain()` / `.from_domain()` conversion; `ScheduleCreateRequest`, `ScheduleResponse`, `DeletionImpactResponse`; routes `POST /`, `GET /`, `GET /{id}`, `PUT /{id}`, `GET /{id}/deletion-impact`, `DELETE /{id}`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/api/test_schedules_api.py
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_create_schedule(db):
    response = client.post(
        "/api/v1/schedules",
        json={
            "name": "Day Shift",
            "start_date": "2026-01-01",
            "end_date": None,
            "shifts": [{"weekday": 0, "start_hours": 9, "end_hours": 17}],
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Day Shift"
    assert body["shifts"] == [{"weekday": 0, "start_hours": 9.0, "end_hours": 17.0}]


def test_create_schedule_with_self_overlap_returns_409(db):
    response = client.post(
        "/api/v1/schedules",
        json={
            "name": "Broken",
            "start_date": "2026-01-01",
            "end_date": None,
            "shifts": [
                {"weekday": 0, "start_hours": 22, "end_hours": 6},
                {"weekday": 1, "start_hours": 5, "end_hours": 13},
            ],
        },
    )

    assert response.status_code == 409


def test_get_and_list_schedules(db):
    create = client.post(
        "/api/v1/schedules", json={"name": "A", "start_date": "2026-01-01", "end_date": None, "shifts": []}
    )
    schedule_id = create.json()["id"]

    get_response = client.get(f"/api/v1/schedules/{schedule_id}")
    list_response = client.get("/api/v1/schedules")

    assert get_response.status_code == 200
    assert get_response.json()["id"] == schedule_id
    assert list_response.status_code == 200
    assert any(s["id"] == schedule_id for s in list_response.json())


def test_get_missing_schedule_returns_404(db):
    response = client.get("/api/v1/schedules/999")
    assert response.status_code == 404


def test_update_schedule_hours(db):
    create = client.post(
        "/api/v1/schedules",
        json={"name": "A", "start_date": "2026-01-01", "end_date": None, "shifts": [{"weekday": 0, "start_hours": 9, "end_hours": 17}]},
    )
    schedule_id = create.json()["id"]

    response = client.put(
        f"/api/v1/schedules/{schedule_id}",
        json={"shifts": [{"weekday": 0, "start_hours": 8, "end_hours": 16}]},
    )

    assert response.status_code == 200
    assert response.json()["shifts"] == [{"weekday": 0, "start_hours": 8.0, "end_hours": 16.0}]


def test_deletion_impact_and_delete(db):
    create = client.post(
        "/api/v1/schedules", json={"name": "A", "start_date": "2026-01-01", "end_date": None, "shifts": []}
    )
    schedule_id = create.json()["id"]

    impact_response = client.get(f"/api/v1/schedules/{schedule_id}/deletion-impact")
    delete_response = client.delete(f"/api/v1/schedules/{schedule_id}")
    get_after_delete = client.get(f"/api/v1/schedules/{schedule_id}")

    assert impact_response.status_code == 200
    assert impact_response.json()["affected_agent_ids"] == []
    assert delete_response.status_code == 204
    assert get_after_delete.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/api/test_schedules_api.py -v`
Expected: FAIL — 404 (no `/api/v1/schedules` routes registered yet)

- [ ] **Step 3: Write the schemas**

```python
# backend/app/api/v1/schedules/request_response.py
from datetime import date, timedelta

from pydantic import BaseModel, model_validator

from app.domain.types import ShiftInput


class ShiftInputSchema(BaseModel):
    weekday: int
    start_hours: float
    end_hours: float

    @model_validator(mode="after")
    def _validate_ranges(self):
        if not (0 <= self.weekday <= 6):
            raise ValueError("weekday must be 0-6")
        if not (0 <= self.start_hours < 24):
            raise ValueError("start_hours must be in [0, 24)")
        if not (0 <= self.end_hours < 24):
            raise ValueError("end_hours must be in [0, 24)")
        return self

    def to_domain(self) -> ShiftInput:
        return ShiftInput(
            weekday=self.weekday,
            start_time=timedelta(hours=self.start_hours),
            end_time=timedelta(hours=self.end_hours),
        )

    @classmethod
    def from_domain(cls, shift: ShiftInput) -> "ShiftInputSchema":
        return cls(
            weekday=shift.weekday,
            start_hours=shift.start_time.total_seconds() / 3600,
            end_hours=shift.end_time.total_seconds() / 3600,
        )


class ScheduleCreateRequest(BaseModel):
    name: str
    start_date: date
    end_date: date | None = None
    shifts: list[ShiftInputSchema]


class ScheduleUpdateRequest(BaseModel):
    shifts: list[ShiftInputSchema]


class ScheduleResponse(BaseModel):
    id: int
    name: str
    start_date: date
    end_date: date | None
    shifts: list[ShiftInputSchema]


class DeletionImpactResponse(BaseModel):
    schedule_id: int
    affected_agent_ids: list[int]
```

- [ ] **Step 4: Write the router**

```python
# backend/app/api/v1/schedules/router.py
from fastapi import APIRouter, Depends, status

from app.api.v1.schedules.request_response import (
    DeletionImpactResponse,
    ScheduleCreateRequest,
    ScheduleResponse,
    ScheduleUpdateRequest,
    ShiftInputSchema,
)
from app.services import schedule_service
from app.shared.pagination import PaginationParams

router = APIRouter(prefix="/api/v1/schedules", tags=["schedules"])


def _to_response(detail: schedule_service.ScheduleDetail) -> ScheduleResponse:
    return ScheduleResponse(
        id=detail.id,
        name=detail.name,
        start_date=detail.start_date,
        end_date=detail.end_date,
        shifts=[ShiftInputSchema.from_domain(s) for s in detail.shifts],
    )


@router.post("", response_model=ScheduleResponse, status_code=status.HTTP_201_CREATED)
def create_schedule(request: ScheduleCreateRequest):
    detail = schedule_service.create_schedule(
        name=request.name,
        start_date=request.start_date,
        end_date=request.end_date,
        shift_inputs=[s.to_domain() for s in request.shifts],
    )
    return _to_response(detail)


@router.get("", response_model=list[ScheduleResponse])
def list_schedules(pagination: PaginationParams = Depends()):
    details = schedule_service.list_schedules(pagination.limit, pagination.offset)
    return [_to_response(d) for d in details]


@router.get("/{schedule_id}", response_model=ScheduleResponse)
def get_schedule(schedule_id: int):
    return _to_response(schedule_service.get_schedule_detail(schedule_id))


@router.put("/{schedule_id}", response_model=ScheduleResponse)
def update_schedule(schedule_id: int, request: ScheduleUpdateRequest):
    detail = schedule_service.update_schedule_hours(schedule_id, [s.to_domain() for s in request.shifts])
    return _to_response(detail)


@router.get("/{schedule_id}/deletion-impact", response_model=DeletionImpactResponse)
def get_deletion_impact(schedule_id: int):
    impact = schedule_service.get_deletion_impact(schedule_id)
    return DeletionImpactResponse(schedule_id=impact.schedule_id, affected_agent_ids=impact.affected_agent_ids)


@router.delete("/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_schedule(schedule_id: int):
    schedule_service.soft_delete_schedule(schedule_id)
```

- [ ] **Step 5: Register the router in `main.py`**

```python
from app.api.v1.schedules.router import router as schedules_router

app.include_router(schedules_router)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/api/test_schedules_api.py -v`
Expected: PASS (6 passed)

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/api/v1/schedules/ backend/app/main.py backend/tests/api/test_schedules_api.py && git commit -m "feat: schedules API router"
```

---

### Task 19: `api/v1/schedule_agents` — router and schemas

**Files:**
- Create: `backend/app/api/v1/schedule_agents/request_response.py`
- Create: `backend/app/api/v1/schedule_agents/router.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/api/test_schedule_agents_api.py`

**Interfaces:**
- Consumes: `assignment_service.{assign_agent, unassign_agent, list_assignees}`.
- Produces: `AssignRequest(agent_id: int)`; `AgentSummaryResponse(id: int, name: str)`; `ConflictDetailResponse(weekday: int, existing_start_hours: float, existing_end_hours: float)`; routes `GET /`, `POST /`, `DELETE /{agent_id}` under `/api/v1/schedules/{schedule_id}/agents`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/api/test_schedule_agents_api.py
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _create_schedule(name, shifts):
    response = client.post(
        "/api/v1/schedules", json={"name": name, "start_date": "2026-01-01", "end_date": None, "shifts": shifts}
    )
    return response.json()["id"]


def test_assign_and_list_assignees(db):
    schedule_id = _create_schedule("A", [])
    agent_response = client.post("/api/v1/schedules", json={"name": "unused", "start_date": "2026-01-01", "shifts": []})
    # create an agent directly via the db fixture instead of a nonexistent agents-create endpoint
    from app.components.agents.model import Agent
    from app.db import db_session_write

    with db_session_write() as session:
        agent = Agent(name="Alice")
        session.add(agent)
        session.flush()
        agent_id = agent.id

    assign_response = client.post(f"/api/v1/schedules/{schedule_id}/agents", json={"agent_id": agent_id})
    list_response = client.get(f"/api/v1/schedules/{schedule_id}/agents")

    assert assign_response.status_code == 201
    assert list_response.status_code == 200
    assert [a["id"] for a in list_response.json()] == [agent_id]


def test_assign_conflicting_schedule_returns_409(db):
    from app.components.agents.model import Agent
    from app.db import db_session_write

    with db_session_write() as session:
        agent = Agent(name="Alice")
        session.add(agent)
        session.flush()
        agent_id = agent.id

    schedule_a = _create_schedule("A", [{"weekday": 0, "start_hours": 9, "end_hours": 17}])
    schedule_b = _create_schedule("B", [{"weekday": 0, "start_hours": 12, "end_hours": 20}])
    client.post(f"/api/v1/schedules/{schedule_a}/agents", json={"agent_id": agent_id})

    response = client.post(f"/api/v1/schedules/{schedule_b}/agents", json={"agent_id": agent_id})

    assert response.status_code == 409


def test_unassign_agent(db):
    from app.components.agents.model import Agent
    from app.db import db_session_write

    with db_session_write() as session:
        agent = Agent(name="Alice")
        session.add(agent)
        session.flush()
        agent_id = agent.id

    schedule_id = _create_schedule("A", [])
    client.post(f"/api/v1/schedules/{schedule_id}/agents", json={"agent_id": agent_id})

    response = client.delete(f"/api/v1/schedules/{schedule_id}/agents/{agent_id}")
    list_response = client.get(f"/api/v1/schedules/{schedule_id}/agents")

    assert response.status_code == 204
    assert list_response.json() == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/api/test_schedule_agents_api.py -v`
Expected: FAIL — 404 (no `/api/v1/schedules/{id}/agents` routes registered yet)

- [ ] **Step 3: Write the schemas**

```python
# backend/app/api/v1/schedule_agents/request_response.py
from pydantic import BaseModel


class AssignRequest(BaseModel):
    agent_id: int


class AgentSummaryResponse(BaseModel):
    id: int
    name: str
```

- [ ] **Step 4: Write the router**

```python
# backend/app/api/v1/schedule_agents/router.py
from fastapi import APIRouter, status

from app.api.v1.schedule_agents.request_response import AgentSummaryResponse, AssignRequest
from app.services import assignment_service

router = APIRouter(prefix="/api/v1/schedules/{schedule_id}/agents", tags=["schedule-agents"])


@router.get("", response_model=list[AgentSummaryResponse])
def list_assignees(schedule_id: int):
    agents = assignment_service.list_assignees(schedule_id)
    return [AgentSummaryResponse(id=a.id, name=a.name) for a in agents]


@router.post("", status_code=status.HTTP_201_CREATED)
def assign_agent(schedule_id: int, request: AssignRequest):
    assignment_service.assign_agent(schedule_id, request.agent_id)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def unassign_agent(schedule_id: int, agent_id: int):
    assignment_service.unassign_agent(schedule_id, agent_id)
```

- [ ] **Step 5: Register the router in `main.py`**

```python
from app.api.v1.schedule_agents.router import router as schedule_agents_router

app.include_router(schedule_agents_router)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/api/test_schedule_agents_api.py -v`
Expected: PASS (3 passed)

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/api/v1/schedule_agents/ backend/app/main.py backend/tests/api/test_schedule_agents_api.py && git commit -m "feat: schedule_agents (assignment) API router"
```

---

### Task 20: `api/v1/reports` — router and schemas

**Files:**
- Create: `backend/app/api/v1/reports/request_response.py`
- Create: `backend/app/api/v1/reports/router.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/api/test_reports_api.py`

**Interfaces:**
- Consumes: `report_service.{generate_report, list_reports, get_report}`.
- Produces: `ReportGenerateRequest(ticket_start_at: datetime, ticket_end_at: datetime)`; `AgentHoursResponse(agent_id: int, business_seconds: int)`; `ReportResponse(id: int, ticket_start_at: datetime, ticket_end_at: datetime, agent_hours: list[AgentHoursResponse])`; routes `POST /`, `GET /`, `GET /{id}`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/api/test_reports_api.py
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_generate_report(db):
    response = client.post(
        "/api/v1/reports",
        json={"ticket_start_at": "2026-01-06T10:00:00", "ticket_end_at": "2026-01-06T14:00:00"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert "agent_hours" in body


def test_generate_report_rejects_end_before_start(db):
    response = client.post(
        "/api/v1/reports",
        json={"ticket_start_at": "2026-01-06T14:00:00", "ticket_end_at": "2026-01-06T10:00:00"},
    )

    assert response.status_code == 400


def test_list_and_get_report(db):
    create = client.post(
        "/api/v1/reports",
        json={"ticket_start_at": "2026-01-06T10:00:00", "ticket_end_at": "2026-01-06T14:00:00"},
    )
    report_id = create.json()["id"]

    list_response = client.get("/api/v1/reports")
    get_response = client.get(f"/api/v1/reports/{report_id}")

    assert list_response.status_code == 200
    assert any(r["id"] == report_id for r in list_response.json())
    assert get_response.status_code == 200
    assert get_response.json()["id"] == report_id


def test_get_missing_report_returns_404(db):
    response = client.get("/api/v1/reports/999")
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/api/test_reports_api.py -v`
Expected: FAIL — 404 (no `/api/v1/reports` routes registered yet)

- [ ] **Step 3: Write the schemas**

```python
# backend/app/api/v1/reports/request_response.py
from datetime import datetime

from pydantic import BaseModel


class ReportGenerateRequest(BaseModel):
    ticket_start_at: datetime
    ticket_end_at: datetime


class AgentHoursResponse(BaseModel):
    agent_id: int
    business_seconds: int


class ReportResponse(BaseModel):
    id: int
    ticket_start_at: datetime
    ticket_end_at: datetime
    agent_hours: list[AgentHoursResponse]
```

- [ ] **Step 4: Write the router**

```python
# backend/app/api/v1/reports/router.py
from fastapi import APIRouter, Depends, status

from app.api.v1.reports.request_response import AgentHoursResponse, ReportGenerateRequest, ReportResponse
from app.errors.error import DomainValidationError
from app.services import report_service
from app.shared.pagination import PaginationParams

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])


def _to_response(result: report_service.ReportResult) -> ReportResponse:
    return ReportResponse(
        id=result.id,
        ticket_start_at=result.ticket_start_at,
        ticket_end_at=result.ticket_end_at,
        agent_hours=[
            AgentHoursResponse(agent_id=r.agent_id, business_seconds=r.business_seconds) for r in result.agent_hours
        ],
    )


@router.post("", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def generate_report(request: ReportGenerateRequest):
    try:
        result = report_service.generate_report(request.ticket_start_at, request.ticket_end_at)
    except ValueError as exc:
        raise DomainValidationError(str(exc)) from exc
    return _to_response(result)


@router.get("", response_model=list[ReportResponse])
def list_reports(pagination: PaginationParams = Depends()):
    results = report_service.list_reports(pagination.limit, pagination.offset)
    return [_to_response(r) for r in results]


@router.get("/{report_id}", response_model=ReportResponse)
def get_report(report_id: int):
    return _to_response(report_service.get_report(report_id))
```

- [ ] **Step 5: Register the router in `main.py`**

```python
from app.api.v1.reports.router import router as reports_router

app.include_router(reports_router)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/api/test_reports_api.py -v`
Expected: PASS (4 passed)

- [ ] **Step 7: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/app/api/v1/reports/ backend/app/main.py backend/tests/api/test_reports_api.py && git commit -m "feat: reports API router"
```

---

### Task 21: Full-suite smoke test and concurrency test for the advisory lock

**Files:**
- Test: `backend/tests/test_full_suite_smoke.py`
- Test: `backend/tests/services/test_assignment_service_concurrency.py`

**Interfaces:** none new — this task only adds tests exercising everything built so far end-to-end, plus the one property that can't be tested through the ORM's single-session fixture: two genuinely concurrent transactions racing for the same agent's advisory lock.

- [ ] **Step 1: Write the end-to-end smoke test**

```python
# backend/tests/test_full_suite_smoke.py
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_full_flow_create_assign_report(db):
    from app.components.agents.model import Agent
    from app.db import db_session_write

    with db_session_write() as session:
        agent = Agent(name="Alice")
        session.add(agent)
        session.flush()
        agent_id = agent.id

    schedule = client.post(
        "/api/v1/schedules",
        json={
            "name": "Day Shift",
            "start_date": "2026-01-01",
            "end_date": None,
            "shifts": [{"weekday": 1, "start_hours": 9, "end_hours": 17}],
        },
    ).json()

    assign = client.post(f"/api/v1/schedules/{schedule['id']}/agents", json={"agent_id": agent_id})
    assert assign.status_code == 201

    report = client.post(
        "/api/v1/reports",
        json={"ticket_start_at": "2026-01-06T10:00:00", "ticket_end_at": "2026-01-06T14:00:00"},
    ).json()

    row = next(r for r in report["agent_hours"] if r["agent_id"] == agent_id)
    assert row["business_seconds"] == 4 * 3600

    history = client.get("/api/v1/reports").json()
    assert any(r["id"] == report["id"] for r in history)
```

- [ ] **Step 2: Run it to verify it fails or passes cleanly given everything built so far**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/test_full_suite_smoke.py -v`
Expected: PASS immediately (this is a smoke test over already-implemented behavior, not new TDD — if it fails, something in Tasks 1-20 has a real bug to fix before continuing).

- [ ] **Step 3: Write the concurrency test using two real raw connections**

This is the one place `db_session_write`'s single-session-per-block model can't exercise the real property we care about — two genuinely simultaneous transactions racing for the same advisory lock. Use `threading` with two separate psycopg connections directly.

```python
# backend/tests/services/test_assignment_service_concurrency.py
import threading
from datetime import date, timedelta

from app.db import db_session_write
from app.domain.types import ShiftInput
from app.services.assignment_service import assign_agent, list_assignees
from app.services.schedule_service import create_schedule


def test_concurrent_assignment_attempts_for_same_agent_do_not_both_succeed(db):
    # two overlapping schedules; only one should end up assigned to the agent
    schedule_a = create_schedule(
        name="A",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    schedule_b = create_schedule(
        name="B",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=12), end_time=timedelta(hours=20))],
    )
    from app.components.agents.model import Agent

    with db_session_write() as session:
        agent = Agent(name="Alice")
        session.add(agent)
        session.flush()
        agent_id = agent.id

    results = {}

    def _assign(schedule_id, key):
        try:
            assign_agent(schedule_id, agent_id)
            results[key] = "success"
        except Exception as exc:  # noqa: BLE001 - capturing for assertion, not swallowing silently
            results[key] = type(exc).__name__

    t1 = threading.Thread(target=_assign, args=(schedule_a.id, "a"))
    t2 = threading.Thread(target=_assign, args=(schedule_b.id, "b"))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    outcomes = sorted(results.values())
    assert outcomes == ["AssignmentOverlapError", "success"]
    assert len(list_assignees(schedule_a.id)) + len(list_assignees(schedule_b.id)) == 1
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest tests/services/test_assignment_service_concurrency.py -v`
Expected: PASS. If flaky, run with `-p no:randomly --count=5` a few times to confirm — the advisory lock should make this deterministic (exactly one success, one `AssignmentOverlapError`), not merely usually-correct.

- [ ] **Step 5: Run the entire backend test suite**

Run: `cd ~/Desktop/Richpanel/backend && uv run pytest -v`
Expected: all tests across `tests/domain/`, `tests/components/`, `tests/services/`, `tests/api/`, and the root-level tests PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/Richpanel && git add backend/tests/test_full_suite_smoke.py backend/tests/services/test_assignment_service_concurrency.py && git commit -m "test: end-to-end smoke test + advisory-lock concurrency test"
```

---

## Self-Review Notes

**Spec coverage:** FR1 (schedule CRUD) — Tasks 9, 12, 13, 18. FR2 (assignment, non-overlap) — Tasks 5, 10, 14, 19, 21 (concurrency). FR3 (business hours computation) — Tasks 3-6, 15. FR4 (persist + browsable history) — Tasks 11, 15, 20. NFR efficiency (business hours) — Task 6, validated against spec Appendix A numbers in Task 6's tests. NFR efficiency (overlap prevention) — Task 14/21 (advisory lock + concurrency proof). Soft delete (spec §4.6) — Tasks 9, 10, 13. Deletion preview (spec §4.7) — Task 13, 18. Edit re-validation without redundant checks (spec §4.8) — Task 13. Read/write session separation — Task 2 (the contract), Task 15 (the concrete read→compute→write example), documented as an explicit exception at the advisory-lock call sites in Tasks 13/14. Structured JSON logging with timing — Task 1 (the `JsonFormatter`/`configure_logging` foundation), Task 16 (per-request method/path/status/duration_ms middleware), Tasks 12/13/14/15 (operation-specific timing: schedule create/update, lock-wait duration, report read/compute/write phase durations).

**Pre-flight review (run before Task 1 was dispatched, per this skill's process):** found and fixed three real defects rather than letting them surface as task-reviewer bounces later —
1. Tasks 12 and 13 each originally contained a flawed draft implementation immediately followed by a "(corrected)" replacement of the same step — confusing for an implementer subagent (which version governs?). Both are now single, clean steps with no leftover draft artifacts.
2. `ScheduleWeekdayHours` row → `WeekdayShift` conversion was duplicated near-verbatim across `schedule_service.py`, `assignment_service.py`, and `report_service.py` (Tasks 12/13, 14, 15). Extracted into one shared `services/_conversions.py::weekday_shift_from_row`, added in Task 12 and imported by the other three — this is exactly the kind of duplication the review rubric flags, cheaper to fix once here than three times across separate task reviews.
3. Task 2's two `db_session_write` contract tests originally asserted nothing (a comment explained the real behavior was "tested later") — replaced with real assertions: insert a row inside the session, then check its presence/absence from a separate `db_session_read` afterward, which actually proves commit-on-clean-exit and rollback-on-exception rather than just "no exception was raised."

**Placeholder scan:** clean — the `__import__` hack that was in Task 12's original draft is gone entirely (not just replaced downstream) after the pre-flight fix above.

**Type consistency check:** `WeekdayShift`/`ShiftInput` field names (`weekday`, `start_time`, `end_time`, `is_overnight_tail`) are identical across Tasks 3-15 and the ORM column names (`weekday`, `start_time`, `end_time`, `is_overnight_tail`) in Task 9 — no renaming drift. `db_session_read`/`db_session_write` (Task 2) are used with those exact names in every later task, never a different spelling. Error class names (`NotFoundError`, `ConflictError`, `ScheduleOverlapError`, `AssignmentOverlapError`, `DomainValidationError`) match between Task 7's definitions and every later `raise`/`except`/`pytest.raises` usage. Logger names follow one convention throughout: `richpanel.<module>` (`richpanel.schedule_service`, `richpanel.assignment_service`, `richpanel.report_service`, `richpanel.request`), and every structured field is passed via `extra={...}`, never string-interpolated into the message — consistent with what Task 1's `JsonFormatter` test asserts.

**Not covered by this plan (explicitly deferred, per spec §10 and the frontend split):** the Next.js frontend, and the spec's still-open items (concrete timezone value, weekday-numbering confirmation with stakeholders) — both should be resolved before or during frontend work, not blocking this backend plan.
