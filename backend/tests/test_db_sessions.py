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
