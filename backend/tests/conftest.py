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
