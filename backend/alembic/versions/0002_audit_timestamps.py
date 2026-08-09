# backend/alembic/versions/0002_audit_timestamps.py
"""audit timestamps on every table

Every table gets created_at; the two tables that are mutated after insert
(schedule_agents, schedule_weekday_hours) also get updated_at.

The gap this closes: schedule_weekday_hours stored deleted_at but no
created_at, recording when a row stopped applying and never when it started --
half a lifecycle. Its sibling schedule_agents already had created_at, so the
schema was inconsistent as well as incomplete.

DEFAULT now() backfills existing rows with the migration time rather than their
true creation time. That is unavoidable -- the information was never recorded --
and is the reason to add these columns before the tables grow further.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-09
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # schedule_weekday_hours: had deleted_at only.
    op.add_column(
        "schedule_weekday_hours",
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.add_column(
        "schedule_weekday_hours",
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # schedule_agents: had created_at + deleted_at, but assignments are mutated
    # after insert (unassign sets deleted_at), so the change needs a timestamp.
    op.add_column(
        "schedule_agents",
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # resolution_report_agent_hours: immutable children of a report, but
    # created_at belongs on every table -- a row with no birth date cannot be
    # reasoned about when something goes wrong.
    op.add_column(
        "resolution_report_agent_hours",
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_column("resolution_report_agent_hours", "created_at")
    op.drop_column("schedule_agents", "updated_at")
    op.drop_column("schedule_weekday_hours", "updated_at")
    op.drop_column("schedule_weekday_hours", "created_at")
