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
