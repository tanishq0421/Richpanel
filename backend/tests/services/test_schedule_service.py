# backend/tests/services/test_schedule_service.py
from datetime import date, timedelta

import pytest

from app.domain.types import ShiftInput
from app.errors.error import NotFoundError, ScheduleOverlapError
from app.services.schedule_service import create_schedule, get_schedule_detail, list_schedules


def test_create_schedule_persists_and_recombines_shifts(db):
    detail = create_schedule(
        name="Day Shift",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )

    assert detail.name == "Day Shift"
    assert detail.shifts == [
        ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    ]


def test_create_schedule_recombines_overnight_shift_for_display(db):
    detail = create_schedule(
        name="Night Shift",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))],
    )

    assert detail.shifts == [
        ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6))
    ]


def test_create_schedule_rejects_self_overlapping_shifts(db):
    # Monday-night overnight shift's tail (Tue 00:00-06:00) collides with
    # a separately-configured Tuesday 05:00-13:00 shift.
    with pytest.raises(ScheduleOverlapError):
        create_schedule(
            name="Broken",
            start_date=date(2026, 1, 1),
            end_date=None,
            shift_inputs=[
                ShiftInput(weekday=0, start_time=timedelta(hours=22), end_time=timedelta(hours=6)),
                ShiftInput(weekday=1, start_time=timedelta(hours=5), end_time=timedelta(hours=13)),
            ],
        )


def test_get_schedule_detail_raises_not_found(db):
    with pytest.raises(NotFoundError):
        get_schedule_detail(999)


def test_list_schedules_returns_created_schedules(db):
    create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    create_schedule(name="B", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])

    result = list_schedules(limit=10, offset=0)

    assert [s.name for s in result] == ["A", "B"]
