# backend/tests/components/test_schedules_queries.py
from datetime import date, timedelta

from app.components.schedules.queries import (
    create_schedule,
    get_schedule,
    get_weekday_hours_rows,
    insert_weekday_hours_rows,
    list_active_schedules,
    replace_weekday_hours_rows,
    soft_delete_schedule,
    soft_delete_weekday_hours_for_schedule,
    touch_schedule,
)
from app.domain.types import WeekdayShift


def test_create_and_get_schedule(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()

    fetched = get_schedule(db, schedule.id)

    assert fetched is not None
    assert fetched.name == "Day Shift"
    assert fetched.end_date is None


def test_get_schedule_returns_none_for_soft_deleted(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    soft_delete_schedule(db, schedule.id)
    db.commit()

    assert get_schedule(db, schedule.id) is None


def test_list_active_schedules_excludes_deleted(db):
    kept = create_schedule(db, name="Kept", start_date=date(2026, 1, 1), end_date=None)
    deleted = create_schedule(db, name="Deleted", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    soft_delete_schedule(db, deleted.id)
    db.commit()

    result = list_active_schedules(db, limit=10, offset=0)

    assert [s.name for s in result] == ["Kept"]


def test_insert_and_get_weekday_hours_rows(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()

    shifts = [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    insert_weekday_hours_rows(db, schedule.id, shifts)
    db.commit()

    rows = get_weekday_hours_rows(db, schedule.id)

    assert len(rows) == 1
    assert rows[0].weekday == 0
    assert rows[0].start_time == timedelta(hours=9)
    assert rows[0].end_time == timedelta(hours=17)


def test_replace_weekday_hours_rows_swaps_old_for_new(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    insert_weekday_hours_rows(
        db, schedule.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    )
    db.commit()

    replace_weekday_hours_rows(
        db, schedule.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=8), end_time=timedelta(hours=16))]
    )
    db.commit()

    rows = get_weekday_hours_rows(db, schedule.id)
    assert len(rows) == 1
    assert rows[0].start_time == timedelta(hours=8)


def test_weekday_hours_rows_record_when_they_were_created(db):
    # The table used to store deleted_at with no created_at: it could say when a
    # row stopped applying but never when it started.
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    insert_weekday_hours_rows(
        db, schedule.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    )
    db.commit()

    row = get_weekday_hours_rows(db, schedule.id)[0]
    assert row.created_at is not None
    assert row.updated_at is not None


def test_touch_schedule_moves_updated_at_past_created_at(db):
    # updated_at previously equalled created_at forever: declared with a
    # server_default and never assigned by anything.
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    created_at, before = schedule.created_at, schedule.updated_at

    touch_schedule(db, schedule.id)
    db.commit()
    db.refresh(schedule)

    assert schedule.updated_at > before
    assert schedule.updated_at > created_at
    assert schedule.created_at == created_at  # creation time must not move


def test_soft_delete_weekday_hours_for_schedule(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    insert_weekday_hours_rows(
        db, schedule.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    )
    db.commit()

    soft_delete_weekday_hours_for_schedule(db, schedule.id)
    db.commit()

    assert get_weekday_hours_rows(db, schedule.id) == []
