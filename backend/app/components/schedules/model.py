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
