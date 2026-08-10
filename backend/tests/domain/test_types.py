from datetime import timedelta

import pytest

from app.domain.types import ShiftInput, WeekdayShift


def test_shift_input_accepts_same_day_shift():
    s = ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    assert s.crosses_midnight is False


def test_shift_input_accepts_midnight_crossing_shift():
    s = ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    assert s.crosses_midnight is True


def test_shift_input_rejects_zero_duration():
    with pytest.raises(ValueError, match="zero duration"):
        ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=9))


def test_shift_input_rejects_invalid_weekday():
    with pytest.raises(ValueError, match="weekday"):
        ShiftInput(weekday=7, start_time=timedelta(hours=9), end_time=timedelta(hours=17))


def test_shift_input_accepts_end_of_day_boundary():
    # An ordinary shift ending exactly at midnight -- distinct from the
    # round-the-clock case, which is rejected explicitly below.
    s = ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=24))
    assert s.crosses_midnight is False


def test_shift_input_rejects_round_the_clock_via_end_of_day():
    # start=0, end=24 is round-the-clock spelled with the day's other
    # boundary -- start_time == end_time alone would not catch this, since
    # timedelta(hours=0) != timedelta(hours=24).
    with pytest.raises(ValueError, match="round-the-clock"):
        ShiftInput(weekday=0, start_time=timedelta(0), end_time=timedelta(hours=24))


def test_shift_input_rejects_start_time_at_end_of_day():
    with pytest.raises(ValueError, match="start_time"):
        ShiftInput(weekday=0, start_time=timedelta(hours=24), end_time=timedelta(hours=1))


def test_weekday_shift_rejects_end_before_or_equal_start():
    with pytest.raises(ValueError, match="same-day"):
        WeekdayShift(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))


def test_weekday_shift_accepts_end_of_day_boundary():
    s = WeekdayShift(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=24))
    assert s.duration == timedelta(hours=2)


def test_weekday_shift_tail_must_start_at_midnight():
    with pytest.raises(ValueError, match="overnight tail"):
        WeekdayShift(
            weekday=1, start_time=timedelta(hours=1), end_time=timedelta(hours=6), is_overnight_tail=True
        )


def test_weekday_shift_tail_at_midnight_is_valid():
    s = WeekdayShift(weekday=1, start_time=timedelta(0), end_time=timedelta(hours=6), is_overnight_tail=True)
    assert s.duration == timedelta(hours=6)
