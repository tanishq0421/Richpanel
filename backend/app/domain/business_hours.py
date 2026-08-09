# backend/app/domain/business_hours.py
from datetime import datetime, timedelta

from app.domain.types import END_OF_DAY, ZERO, WeekdayShift


def _weekday_of(dt: datetime) -> int:
    return dt.weekday()


def _day_offset_of(dt: datetime) -> timedelta:
    return dt - datetime.combine(dt.date(), datetime.min.time())


def _day_overlap(shifts_for_day: list[WeekdayShift], window_start: timedelta, window_end: timedelta) -> timedelta:
    total = ZERO
    for s in shifts_for_day:
        lo = max(s.start_time, window_start)
        hi = min(s.end_time, window_end)
        if hi > lo:
            total += hi - lo
    return total


def calculate_business_seconds(shifts: list[WeekdayShift], window_start: datetime, window_end: datetime) -> int:
    """O(1) relative to window length: touches only the given shifts (at
    most ~14 rows for a schedule with overnight splits), never loops per
    calendar day in the window."""
    if window_end <= window_start:
        raise ValueError("window_end must be after window_start")

    by_weekday: dict[int, list[WeekdayShift]] = {i: [] for i in range(7)}
    for s in shifts:
        by_weekday[s.weekday].append(s)

    weekly_total = sum((s.duration for s in shifts), start=ZERO)

    next_midnight = datetime.combine(window_start.date(), datetime.min.time()) + timedelta(days=1)

    if window_end <= next_midnight:
        total = _day_overlap(
            by_weekday[_weekday_of(window_start)], _day_offset_of(window_start), _day_offset_of(window_end)
        )
        return int(total.total_seconds())

    total = _day_overlap(by_weekday[_weekday_of(window_start)], _day_offset_of(window_start), END_OF_DAY)

    last_midnight = datetime.combine(window_end.date(), datetime.min.time())
    total += _day_overlap(by_weekday[_weekday_of(window_end)], ZERO, _day_offset_of(window_end))

    full_days = (last_midnight - next_midnight).days
    if full_days > 0:
        full_weeks, remainder_days = divmod(full_days, 7)
        total += full_weeks * weekly_total
        cursor = next_midnight
        for _ in range(remainder_days):
            total += sum((s.duration for s in by_weekday[_weekday_of(cursor)]), start=ZERO)
            cursor += timedelta(days=1)

    return int(total.total_seconds())
