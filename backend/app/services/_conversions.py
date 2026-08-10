# backend/app/services/_conversions.py
from datetime import date

from app.domain.types import WeekdayShift


def weekday_shift_from_row(row) -> WeekdayShift:
    """Convert a ScheduleWeekdayHours ORM row into a domain WeekdayShift.
    The one place this conversion is written -- every service imports this
    rather than reconstructing it inline."""
    return WeekdayShift(
        weekday=row.weekday,
        start_time=row.start_time,
        end_time=row.end_time,
        is_overnight_tail=row.is_overnight_tail,
    )


def date_ranges_overlap(start_a: date, end_a: date | None, start_b: date, end_b: date | None) -> bool:
    """True if [start_a, end_a] and [start_b, end_b] share at least one
    calendar day. Both ranges are inclusive of their end date; None means
    "ongoing" -- open-ended, never the earlier bound.

    Deliberately outside domain.overlap: WeekdayShift/find_overlaps stay
    date-free by design (weekday + time-of-day only). This is the one place
    assignment_service and schedule_service both call to decide whether two
    schedules' effective date ranges even coexist, before the date-free
    weekday/time comparison runs."""
    if end_a is not None and end_a < start_b:
        return False
    if end_b is not None and end_b < start_a:
        return False
    return True
