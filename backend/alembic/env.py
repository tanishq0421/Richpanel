# backend/alembic/env.py
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.db import Base, DATABASE_URL

# These component model modules are placeholders until Tasks 8-11 add the
# classes below; importing them registers each model's table with
# Base.metadata for `alembic revision --autogenerate`. Guard each import so
# `alembic upgrade head` (this task's hand-written migration doesn't need
# autogenerate) keeps working before a given model exists, and so each model
# comes online automatically once its task adds the class - no env.py edit
# needed.
try:
    from app.components.agents.model import Agent  # noqa: F401
except ImportError:
    pass
try:
    from app.components.schedules.model import Schedule, ScheduleWeekdayHours  # noqa: F401
except ImportError:
    pass
try:
    from app.components.schedule_agents.model import ScheduleAgent  # noqa: F401
except ImportError:
    pass
try:
    from app.components.reports.model import ResolutionReport, ResolutionReportAgentHours  # noqa: F401
except ImportError:
    pass

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
