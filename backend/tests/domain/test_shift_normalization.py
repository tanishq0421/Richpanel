from datetime import timedelta

import pytest

from app.domain.shift_normalization import normalize_shift, recombine_shifts
from app.domain.types import ShiftInput, WeekdayShift


def test_normalize_same_day_shift_returns_single_row():
    shift = ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    result = normalize_shift(shift)
    assert result == [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]


def test_normalize_overnight_shift_splits_into_primary_and_tail():
    shift = ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    result = normalize_shift(shift)
    assert result == [
        WeekdayShift(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=24)),
        WeekdayShift(
            weekday=1, start_time=timedelta(0), end_time=timedelta(hours=6), is_overnight_tail=True
        ),
    ]


def test_normalize_sunday_overnight_wraps_to_monday():
    shift = ShiftInput(weekday=6, start_time=timedelta(hours=20), end_time=timedelta(hours=4))
    result = normalize_shift(shift)
    assert result[0].weekday == 6
    assert result[1].weekday == 0
    assert result[1].is_overnight_tail is True


def test_recombine_same_day_shift_is_unchanged():
    shifts = [WeekdayShift(weekday=2, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    assert recombine_shifts(shifts) == [
        ShiftInput(weekday=2, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    ]


def test_recombine_primary_and_tail_into_one_logical_shift():
    shifts = [
        WeekdayShift(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=24)),
        WeekdayShift(weekday=1, start_time=timedelta(0), end_time=timedelta(hours=6), is_overnight_tail=True),
    ]
    assert recombine_shifts(shifts) == [
        ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    ]


def test_recombine_round_trips_through_normalize():
    original = ShiftInput(weekday=4, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    assert recombine_shifts(normalize_shift(original)) == [original]


def test_recombine_raises_on_orphaned_tail():
    orphan_tail = [
        WeekdayShift(weekday=2, start_time=timedelta(0), end_time=timedelta(hours=6), is_overnight_tail=True)
    ]
    with pytest.raises(ValueError, match="orphaned"):
        recombine_shifts(orphan_tail)
