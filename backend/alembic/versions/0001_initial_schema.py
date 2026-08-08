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
