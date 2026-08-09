# backend/tests/domain/test_overlap.py
from datetime import timedelta

from app.domain.overlap import find_overlaps, find_self_overlaps
from app.domain.types import WeekdayShift


def shift(weekday, start_h, end_h, tail=False):
    return WeekdayShift(
        weekday=weekday, start_time=timedelta(hours=start_h), end_time=timedelta(hours=end_h), is_overnight_tail=tail
    )


def test_no_overlap_different_weekdays():
    existing = [shift(0, 9, 17)]
    new = [shift(1, 9, 17)]
    assert find_overlaps(existing, new) == []


def test_no_overlap_same_weekday_adjacent_ranges():
    existing = [shift(0, 9, 13)]
    new = [shift(0, 13, 17)]
    assert find_overlaps(existing, new) == []


def test_overlap_same_weekday_overlapping_ranges():
    existing = [shift(0, 9, 17)]
    new = [shift(0, 12, 20)]
    conflicts = find_overlaps(existing, new)
    assert len(conflicts) == 1
    assert conflicts[0].a == existing[0]
    assert conflicts[0].b == new[0]


def test_overlap_detects_tail_colliding_with_next_days_own_shift():
    # Monday-night overnight shift's tail lands on Tuesday 00:00-06:00
    existing_tail = shift(1, 0, 6, tail=True)
    new_tuesday_shift = shift(1, 5, 13)
    conflicts = find_overlaps([existing_tail], [new_tuesday_shift])
    assert len(conflicts) == 1


def test_self_overlaps_within_one_schedules_own_shift_set():
    # a schedule whose Monday-night overnight tail collides with its own Tuesday shift
    monday_primary = shift(0, 22, 24)
    tuesday_tail = shift(1, 0, 6, tail=True)
    tuesday_own_shift = shift(1, 5, 13)
    conflicts = find_self_overlaps([monday_primary, tuesday_tail, tuesday_own_shift])
    assert len(conflicts) == 1
    weekdays_involved = {conflicts[0].a.weekday, conflicts[0].b.weekday}
    assert weekdays_involved == {1}


def test_self_overlaps_empty_for_non_conflicting_shifts():
    shifts = [shift(0, 9, 17), shift(1, 9, 17), shift(2, 22, 24)]
    assert find_self_overlaps(shifts) == []
