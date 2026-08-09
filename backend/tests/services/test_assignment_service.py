# backend/tests/services/test_assignment_service.py
from datetime import date, timedelta

import pytest

from app.db import db_session_write
from app.domain.types import ShiftInput
from app.errors.error import AssignmentOverlapError, ConflictError, NotFoundError
from app.services.assignment_service import (
    assign_agent,
    list_assignees,
    list_schedules_for_agent,
    unassign_agent,
)
from app.services.schedule_service import create_schedule


def _create_agent(name="Agent") -> int:
    from app.components.agents.model import Agent

    with db_session_write() as session:
        agent = Agent(name=name)
        session.add(agent)
        session.flush()
        return agent.id


def test_assign_agent_succeeds_for_non_overlapping_schedules(db):
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

    assign_agent(schedule_a.id, agent_id)
    assign_agent(schedule_b.id, agent_id)

    names = {a.id for a in list_assignees(schedule_a.id)}
    assert names == {agent_id}


def test_assign_agent_rejects_overlapping_schedule(db):
    schedule_a = create_schedule(
        name="A",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    schedule_b = create_schedule(
        name="B",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=12), end_time=timedelta(hours=20))],
    )
    agent_id = _create_agent()
    assign_agent(schedule_a.id, agent_id)

    with pytest.raises(AssignmentOverlapError):
        assign_agent(schedule_b.id, agent_id)

    assert list_assignees(schedule_b.id) == []


def test_assign_agent_raises_not_found_for_missing_schedule(db):
    agent_id = _create_agent()
    with pytest.raises(NotFoundError):
        assign_agent(999, agent_id)


def test_unassign_agent_removes_from_active_list(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    unassign_agent(schedule.id, agent_id)

    assert list_assignees(schedule.id) == []


def test_reassign_after_unassign_succeeds(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)
    unassign_agent(schedule.id, agent_id)

    assign_agent(schedule.id, agent_id)

    assert {a.id for a in list_assignees(schedule.id)} == {agent_id}


def test_assign_nonexistent_agent_raises_not_found(db):
    # Previously fell through to an agents FK violation -> 500.
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    with pytest.raises(NotFoundError):
        assign_agent(schedule.id, 999999)


def test_duplicate_assignment_raises_conflict_not_overlap(db):
    # Two distinct previous failures: with no shifts it violated the partial
    # unique index (500); with shifts it reported the schedule as overlapping
    # ITSELF, giving a 409 with a misleading message.
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    with pytest.raises(ConflictError) as exc_info:
        assign_agent(schedule.id, agent_id)
    assert "already assigned" in str(exc_info.value)
    assert not isinstance(exc_info.value, AssignmentOverlapError)


def test_duplicate_assignment_conflicts_even_when_schedule_has_shifts(db):
    schedule = create_schedule(
        name="A",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    with pytest.raises(ConflictError) as exc_info:
        assign_agent(schedule.id, agent_id)
    assert "already assigned" in str(exc_info.value)


def test_list_schedules_for_agent_returns_active_schedules(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    result = list_schedules_for_agent(agent_id)

    assert [s.id for s in result] == [schedule.id]
