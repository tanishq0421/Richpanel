# backend/tests/conftest.py
import os

os.environ["DATABASE_URL"] = os.environ.get("DATABASE_URL_TEST", "postgresql+psycopg://localhost/richpanel_test")

import pytest
from sqlalchemy import text

from app.db import engine, SessionFactory

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
    session = SessionFactory()
    try:
        yield session
    finally:
        session.close()
        with engine.begin() as conn:
            conn.execute(text(f"TRUNCATE {', '.join(TABLES_IN_FK_ORDER)} RESTART IDENTITY CASCADE"))
