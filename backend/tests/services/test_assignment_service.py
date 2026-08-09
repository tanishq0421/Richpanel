# backend/tests/services/test_assignment_service.py
from datetime import date, timedelta

import pytest

from app.db import db_session_write
from app.domain.types import ShiftInput
from app.errors.error import AssignmentOverlapError, NotFoundError
from app.services.assignment_service import assign_agent, list_assignees, unassign_agent
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
