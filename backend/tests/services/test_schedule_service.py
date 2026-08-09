# backend/tests/services/test_schedule_service.py
from datetime import date, timedelta

import pytest

from app.components.agents.model import Agent
from app.components.schedule_agents.queries import create_assignment, list_active_assignee_agent_ids
from app.db import db_session_write
from app.domain.types import ShiftInput
from app.errors.error import AssignmentOverlapError, NotFoundError, ScheduleOverlapError
from app.services.schedule_service import (
    create_schedule,
    get_deletion_impact,
    get_schedule_detail,
    list_schedules,
    soft_delete_schedule,
    update_schedule_hours,
)


def _create_agent(name="Agent") -> int:
    with db_session_write() as session:
        agent = Agent(name=name)
        session.add(agent)
        session.flush()
        return agent.id


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


def test_update_schedule_hours_applies_clean_edit(db):
    detail = create_schedule(
        name="Day Shift",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )

    updated = update_schedule_hours(
        detail.id, [ShiftInput(weekday=0, start_time=timedelta(hours=8), end_time=timedelta(hours=16))]
    )

    assert updated.shifts == [
        ShiftInput(weekday=0, start_time=timedelta(hours=8), end_time=timedelta(hours=16))
    ]


def test_update_schedule_hours_rejects_edit_that_creates_agent_overlap(db):
    schedule_a = create_schedule(
        name="A",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=13))],
    )
    schedule_b = create_schedule(
        name="B",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=14), end_time=timedelta(hours=18))],
    )
    agent_id = _create_agent()
    with db_session_write() as session:
        create_assignment(session, schedule_a.id, agent_id)
        create_assignment(session, schedule_b.id, agent_id)

    # editing schedule_b to now overlap schedule_a's 9-13 window
    with pytest.raises(AssignmentOverlapError) as exc_info:
        update_schedule_hours(
            schedule_b.id, [ShiftInput(weekday=0, start_time=timedelta(hours=10), end_time=timedelta(hours=18))]
        )
    assert exc_info.value.agent_id == agent_id

    # nothing was written: schedule_b's hours are unchanged
    still_old = get_schedule_detail(schedule_b.id)
    assert still_old.shifts == [
        ShiftInput(weekday=0, start_time=timedelta(hours=14), end_time=timedelta(hours=18))
    ]


def test_get_deletion_impact_lists_affected_agents(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    with db_session_write() as session:
        create_assignment(session, schedule.id, agent_id)

    impact = get_deletion_impact(schedule.id)

    assert impact.schedule_id == schedule.id
    assert impact.affected_agent_ids == [agent_id]


def test_soft_delete_schedule_cascades_to_assignments(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    with db_session_write() as session:
        create_assignment(session, schedule.id, agent_id)

    soft_delete_schedule(schedule.id)

    with pytest.raises(NotFoundError):
        get_schedule_detail(schedule.id)
    with db_session_write() as session:
        assert list_active_assignee_agent_ids(session, schedule.id) == []
