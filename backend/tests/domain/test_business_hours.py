# backend/tests/domain/test_business_hours.py
from datetime import datetime, timedelta

import pytest

from app.domain.business_hours import calculate_business_seconds
from app.domain.shift_normalization import normalize_shift
from app.domain.types import ShiftInput


def shift(weekday, start_h, end_h):
    return ShiftInput(weekday=weekday, start_time=timedelta(hours=start_h), end_time=timedelta(hours=end_h % 24))


def build_shifts(inputs):
    result = []
    for s in inputs:
        result.extend(normalize_shift(s))
    return result


WINDOW_START = datetime(2026, 1, 5, 23, 0, 0)  # Monday 23:00
WINDOW_END = datetime(2026, 1, 21, 3, 0, 0)  # Wednesday 03:00


def test_schedule_a_day_shift_matches_hand_verified_88_hours():
    shifts = build_shifts([shift(wd, 9, 17) for wd in range(5)])  # Mon-Fri 09:00-17:00
    seconds = calculate_business_seconds(shifts, WINDOW_START, WINDOW_END)
    assert seconds == 88 * 3600


def test_schedule_b_night_shift_matches_hand_verified_92_hours():
    shifts = build_shifts(
        [ShiftInput(weekday=wd, start_time=timedelta(hours=22), end_time=timedelta(hours=6)) for wd in range(5)]
    )  # Mon-Fri 22:00-06:00
    seconds = calculate_business_seconds(shifts, WINDOW_START, WINDOW_END)
    assert seconds == 92 * 3600


def test_schedule_c_weekend_wrap_matches_hand_verified_22_hours():
    shifts = build_shifts(
        [
            ShiftInput(weekday=5, start_time=timedelta(hours=20), end_time=timedelta(hours=23)),  # Sat 20-23
            ShiftInput(weekday=6, start_time=timedelta(hours=20), end_time=timedelta(hours=4)),  # Sun 20 - Mon 04
        ]
    )
    seconds = calculate_business_seconds(shifts, WINDOW_START, WINDOW_END)
    assert seconds == 22 * 3600


def test_window_entirely_within_one_day():
    shifts = build_shifts([shift(1, 9, 17)])  # Tuesday 09:00-17:00
    window_start = datetime(2026, 1, 6, 10, 0, 0)  # Tuesday 10:00
    window_end = datetime(2026, 1, 6, 14, 0, 0)  # Tuesday 14:00
    seconds = calculate_business_seconds(shifts, window_start, window_end)
    assert seconds == 4 * 3600


def test_window_entirely_within_one_day_outside_shift_hours():
    shifts = build_shifts([shift(1, 9, 17)])
    window_start = datetime(2026, 1, 6, 18, 0, 0)
    window_end = datetime(2026, 1, 6, 20, 0, 0)
    seconds = calculate_business_seconds(shifts, window_start, window_end)
    assert seconds == 0


def test_schedule_with_no_shifts_returns_zero():
    seconds = calculate_business_seconds([], WINDOW_START, WINDOW_END)
    assert seconds == 0


def test_window_length_does_not_change_per_day_cost_only_the_total():
    # a much longer window (2 years) still returns a total consistent with
    # full_weeks * weekly_total dominating -- this is a correctness sanity
    # check, not a performance benchmark (that belongs in a separate perf test).
    shifts = build_shifts([shift(wd, 9, 17) for wd in range(5)])
    long_end = datetime(2028, 1, 21, 3, 0, 0)
    seconds = calculate_business_seconds(shifts, WINDOW_START, long_end)
    assert seconds > 88 * 3600  # strictly more than the 15-day window's total


def test_rejects_window_end_before_start():
    with pytest.raises(ValueError, match="after"):
        calculate_business_seconds([], WINDOW_END, WINDOW_START)
