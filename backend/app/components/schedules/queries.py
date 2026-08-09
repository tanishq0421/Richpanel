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
