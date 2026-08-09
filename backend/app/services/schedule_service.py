# backend/app/services/schedule_service.py
import logging
import time
from dataclasses import dataclass
from datetime import date

from app.components.schedules import queries as schedules_queries
from app.db import db_session_read, db_session_write
from app.domain.overlap import find_self_overlaps
from app.domain.shift_normalization import normalize_shift, recombine_shifts
from app.domain.types import ShiftInput
from app.errors.error import NotFoundError, ScheduleOverlapError
from app.services._conversions import weekday_shift_from_row

logger = logging.getLogger("richpanel.schedule_service")


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
