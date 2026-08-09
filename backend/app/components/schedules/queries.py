# backend/app/components/schedules/queries.py
from datetime import date

from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from app.components.schedules.model import Schedule, ScheduleWeekdayHours
from app.domain.types import WeekdayShift

# Postgres keeps single-key and key-pair advisory locks in two separate spaces,
# so pg_advisory_xact_lock(SCHEDULE_LOCK_NAMESPACE, schedule_id) can never
# collide with the single-key pg_advisory_xact_lock(agent_id) taken by
# agents.queries.lock_agent -- even when a schedule id equals an agent id. The
# one-argument form must NEVER be used for schedule ids for exactly that reason.
SCHEDULE_LOCK_NAMESPACE = 1

# The GLOBAL lock order, which every writer must follow or two writers can
# deadlock: the schedule lock first, then that schedule's agent locks in
# ascending agent_id order.


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


def lock_schedule(session: Session, schedule_id: int) -> None:
    """Serialise every writer touching this schedule, held to end of transaction.

    Locking the agents alone is not enough. An hours edit locks the agents
    ASSIGNED TO the schedule, so a schedule with no assignees locked nothing --
    and a concurrent assign_agent, which also locked only the agent, had nothing
    to contend on. The two transactions then validated against each other's
    stale state and both committed, leaving the agent on two schedules whose
    hours overlap. This lock is the thing they now contend on.

    Callers MUST take this before any agent lock (see SCHEDULE_LOCK_NAMESPACE),
    and MUST re-read the assignee list after taking it -- a list read beforehand
    is exactly the stale input this lock exists to prevent."""
    session.execute(
        text("SELECT pg_advisory_xact_lock(:ns, :schedule_id)"),
        {"ns": SCHEDULE_LOCK_NAMESPACE, "schedule_id": schedule_id},
    )


def touch_schedule(session: Session, schedule_id: int) -> None:
    """Bump updated_at on the schedule itself.

    Needed because editing weekday hours rewrites rows in
    schedule_weekday_hours and never issues an UPDATE against schedules -- so
    the column's onupdate can never fire, and 'last modified' would stay at the
    creation time no matter how often the hours changed.

    Uses func.now() -- the DATABASE's clock -- deliberately, not
    datetime.now(IST) (the application process's clock). The column's own
    onupdate=func.now() (model.py) already uses the DB clock; mixing the two
    sources for one audit column means whichever write is on the losing side of
    real host/DB clock skew can move updated_at BACKWARDS. This was proven, not
    theoretical: under measured skew in the documented local-dev setup (backend
    on host, Postgres in Docker), the app-clock write landed earlier than a
    prior DB-clock write and failed the ordering assertion in
    test_touch_schedule_moves_updated_at_past_created_at."""
    session.execute(update(Schedule).where(Schedule.id == schedule_id).values(updated_at=func.now()))


def update_schedule_attributes(session: Session, schedule: Schedule, values: dict[str, object]) -> None:
    """Apply schedule-level edits (name / start_date / end_date) to an
    already-loaded row.

    Assigning through the ORM rather than emitting a Core update() keeps the
    in-memory object in step with the row, so the caller can build its response
    straight from it; a Core UPDATE would leave `schedule` holding the pre-edit
    values and the API would echo back what the client just replaced. The flush
    fires the model's onupdate, which is why this needs no touch_schedule()
    alongside it -- that would be a second, redundant write."""
    for field, value in values.items():
        setattr(schedule, field, value)
    session.flush()


def soft_delete_schedule(session: Session, schedule_id: int) -> None:
    # func.now(): same DB-clock rationale as touch_schedule above.
    session.execute(update(Schedule).where(Schedule.id == schedule_id).values(deleted_at=func.now()))


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
    # func.now(): same DB-clock rationale as touch_schedule above.
    session.execute(
        update(ScheduleWeekdayHours)
        .where(ScheduleWeekdayHours.schedule_id == schedule_id, ScheduleWeekdayHours.deleted_at.is_(None))
        .values(deleted_at=func.now())
    )
