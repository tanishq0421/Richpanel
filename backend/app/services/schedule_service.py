# backend/app/services/schedule_service.py
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime

from app.components.agents import queries as agents_queries
from app.components.schedule_agents import queries as schedule_agents_queries
from app.components.schedules import queries as schedules_queries
from app.db import db_session_read, db_session_write
from app.domain.overlap import find_overlaps, find_self_overlaps
from app.domain.shift_normalization import normalize_shift, recombine_shifts
from app.domain.types import IST, ShiftInput
from app.errors.error import (
    AssignmentOverlapError,
    DomainValidationError,
    NotFoundError,
    ScheduleOverlapError,
)
from app.services._conversions import weekday_shift_from_row

logger = logging.getLogger("richpanel.schedule_service")


class Unchanged:
    """Sentinel for "the client did not send this field, leave it alone".

    None cannot play that role. For end_date None IS a value -- "ongoing", no
    configured end -- so collapsing absent and null into one would make clearing
    an end date unexpressible. Callers pass a value to change a field and simply
    omit the argument to leave it be."""

    def __repr__(self) -> str:
        return "UNCHANGED"


UNCHANGED = Unchanged()


def _today_ist() -> date:
    """Today in IST, the single system-wide timezone (domain.types.IST).

    Deliberately not date.today() and not a UTC-derived date. The server may run
    anywhere, and IST runs 5h30 ahead: between 18:30 and 24:00 UTC it is already
    tomorrow in IST, so a UTC-derived "today" lags a day and would still call a
    start date that has in fact begun 'in the future'."""
    return datetime.now(IST).date()


@dataclass(frozen=True)
class ScheduleDetail:
    id: int
    name: str
    start_date: date
    end_date: date | None
    shifts: list[ShiftInput]


def _to_detail(schedule, weekday_hours_rows) -> ScheduleDetail:
    normalized = [weekday_shift_from_row(r) for r in weekday_hours_rows]
    return ScheduleDetail(
        id=schedule.id,
        name=schedule.name,
        start_date=schedule.start_date,
        end_date=schedule.end_date,
        shifts=recombine_shifts(normalized),
    )


def create_schedule(
    name: str, start_date: date, end_date: date | None, shift_inputs: list[ShiftInput]
) -> ScheduleDetail:
    started = time.perf_counter()
    normalized_shifts = [ws for shift in shift_inputs for ws in normalize_shift(shift)]

    conflicts = find_self_overlaps(normalized_shifts)
    if conflicts:
        raise ScheduleOverlapError(conflicts)

    with db_session_write() as session:
        schedule = schedules_queries.create_schedule(session, name=name, start_date=start_date, end_date=end_date)
        schedules_queries.insert_weekday_hours_rows(session, schedule.id, normalized_shifts)
        rows = schedules_queries.get_weekday_hours_rows(session, schedule.id)
        detail = _to_detail(schedule, rows)

    logger.info(
        "schedule created",
        extra={
            "schedule_id": detail.id,
            "shift_count": len(normalized_shifts),
            "duration_ms": round((time.perf_counter() - started) * 1000, 2),
        },
    )
    return detail


def get_schedule_detail(schedule_id: int) -> ScheduleDetail:
    with db_session_read() as session:
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")
        rows = schedules_queries.get_weekday_hours_rows(session, schedule_id)
        return _to_detail(schedule, rows)


def list_schedules(limit: int, offset: int) -> list[ScheduleDetail]:
    with db_session_read() as session:
        schedules = schedules_queries.list_active_schedules(session, limit, offset)
        return [_to_detail(s, schedules_queries.get_weekday_hours_rows(session, s.id)) for s in schedules]


@dataclass(frozen=True)
class DeletionImpact:
    schedule_id: int
    affected_agent_ids: list[int]


def _resolve_attribute_changes(
    schedule,
    name: str | Unchanged,
    start_date: date | Unchanged,
    end_date: date | None | Unchanged,
) -> dict[str, object]:
    """Validate the requested schedule-level edits against what is stored, and
    return only the fields that genuinely change.

    These rules live here rather than in the Pydantic request model because
    every one of them compares a sent value against a STORED one, which needs
    the row. They surface as DomainValidationError -> 400, which is precisely
    what that error is for; the request model still owns the rules decidable
    from the payload alone (-> 422)."""
    today = _today_ist()

    effective_start = schedule.start_date
    if not isinstance(start_date, Unchanged) and start_date != schedule.start_date:
        # Note the `!=` guard: re-sending the start_date a schedule already has
        # is not a change and must always be accepted. Rejecting it on the
        # elapsed test alone would make the endpoint unusable for any schedule
        # that has begun, because the natural client posts the whole form back.
        if schedule.start_date <= today:
            raise DomainValidationError(
                f"start_date {schedule.start_date.isoformat()} has already begun "
                f"(today is {today.isoformat()} IST) and can no longer be changed -- "
                "rewriting it would change what already happened. Send the existing "
                "start_date unchanged, or adjust end_date instead."
            )
        effective_start = start_date

    # Compare EFFECTIVE values: either date may be stored rather than sent, so
    # `end_date` alone can still fall behind a start_date nobody mentioned.
    # Without this the database CHECK catches it and it surfaces as a 500.
    effective_end = schedule.end_date if isinstance(end_date, Unchanged) else end_date
    if effective_end is not None and effective_end < effective_start:
        raise DomainValidationError(
            f"end_date {effective_end.isoformat()} must be on or after "
            f"start_date {effective_start.isoformat()}"
        )

    requested = {"name": name, "start_date": start_date, "end_date": end_date}
    return {
        field: value
        for field, value in requested.items()
        if not isinstance(value, Unchanged) and value != getattr(schedule, field)
    }


def update_schedule(
    schedule_id: int,
    shift_inputs: list[ShiftInput],
    *,
    name: str | Unchanged = UNCHANGED,
    start_date: date | Unchanged = UNCHANGED,
    end_date: date | None | Unchanged = UNCHANGED,
) -> ScheduleDetail:
    """Replace the schedule's hours and apply any requested schedule-level
    edits. An omitted keyword leaves that field alone; `end_date=None` clears
    it, meaning the schedule is ongoing.

    Changing the dates deliberately triggers no ADDITIONAL overlap check.
    domain.overlap compares weekday and time-of-day only -- effective dates
    never enter it -- so no date change can create or resolve an overlap today.
    The hours re-validation below is unchanged and still runs on every call. If
    date-aware overlap is ever implemented, that stops being true and this
    function must re-check whenever the dates move, not only the hours."""
    normalized_shifts = [ws for shift in shift_inputs for ws in normalize_shift(shift)]

    self_conflicts = find_self_overlaps(normalized_shifts)
    if self_conflicts:
        raise ScheduleOverlapError(self_conflicts)

    with db_session_write() as session:
        lock_started = time.perf_counter()
        # Schedule lock FIRST (the global order -- see queries.lock_schedule),
        # and only then read the assignee list. Reading it before locking was
        # the defect: assign_agent could add an assignee in between, and that
        # agent would be neither locked nor checked against these new hours.
        # A schedule with no assignees used to lock nothing whatsoever.
        schedules_queries.lock_schedule(session, schedule_id)
        assignee_ids = sorted(schedule_agents_queries.list_active_assignee_agent_ids(session, schedule_id))
        for agent_id in assignee_ids:
            agents_queries.lock_agent(session, agent_id)
        lock_wait_ms = round((time.perf_counter() - lock_started) * 1000, 2)

        # Read the row only once the schedule lock is held, so the stored dates
        # the rules below compare against cannot be rewritten underneath us.
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")
        attribute_changes = _resolve_attribute_changes(schedule, name, start_date, end_date)

        for agent_id in assignee_ids:
            other_schedule_ids = schedule_agents_queries.get_other_active_schedule_ids_for_agent(
                session, agent_id, exclude_schedule_id=schedule_id
            )
            existing_shifts = [
                weekday_shift_from_row(r)
                for other_id in other_schedule_ids
                for r in schedules_queries.get_weekday_hours_rows(session, other_id)
            ]
            conflicts = find_overlaps(existing_shifts, normalized_shifts)
            if conflicts:
                logger.info(
                    "schedule edit rejected: assignment overlap",
                    extra={"schedule_id": schedule_id, "agent_id": agent_id, "lock_wait_ms": lock_wait_ms},
                )
                raise AssignmentOverlapError(agent_id=agent_id, conflicts=conflicts)

        schedules_queries.replace_weekday_hours_rows(session, schedule_id, normalized_shifts)
        if attribute_changes:
            # This UPDATEs the schedules row, so the model's onupdate fires and
            # updated_at moves by itself -- touch_schedule here as well would be
            # a second write for the same effect.
            schedules_queries.update_schedule_attributes(session, schedule, attribute_changes)
        else:
            # Hours-only edit: the hours live in a child table, so nothing above
            # updates the schedule row and onupdate can never fire. Without this,
            # "last modified" would never move.
            schedules_queries.touch_schedule(session, schedule_id)
        rows = schedules_queries.get_weekday_hours_rows(session, schedule_id)
        detail = _to_detail(schedule, rows)

    logger.info(
        "schedule updated",
        extra={
            "schedule_id": schedule_id,
            "assignee_count": len(assignee_ids),
            "changed_attributes": sorted(attribute_changes),
            "lock_wait_ms": lock_wait_ms,
        },
    )
    return detail


def get_deletion_impact(schedule_id: int) -> DeletionImpact:
    with db_session_read() as session:
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")
        agent_ids = schedule_agents_queries.list_active_assignee_agent_ids(session, schedule_id)
        return DeletionImpact(schedule_id=schedule_id, affected_agent_ids=agent_ids)


def soft_delete_schedule(schedule_id: int) -> None:
    with db_session_write() as session:
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")
        schedules_queries.soft_delete_schedule(session, schedule_id)
        schedule_agents_queries.soft_delete_assignments_for_schedule(session, schedule_id)
        schedules_queries.soft_delete_weekday_hours_for_schedule(session, schedule_id)
    logger.info("schedule soft-deleted", extra={"schedule_id": schedule_id})
