# backend/app/services/_conversions.py
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
