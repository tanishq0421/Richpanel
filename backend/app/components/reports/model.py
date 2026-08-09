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
    # No updated_at: these rows are written once with the report and never
    # mutated. created_at is here because every table should be able to say when
    # a row came into existence.
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
