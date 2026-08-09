# backend/tests/components/test_schedule_agents_queries.py
from datetime import date

from app.components.agents.model import Agent
from app.components.schedule_agents.queries import (
    create_assignment,
    get_other_active_schedule_ids_for_agent,
    list_active_assignee_agent_ids,
    soft_delete_assignment,
    soft_delete_assignments_for_schedule,
)
from app.components.schedules.queries import create_schedule


def _agent(db, name="Agent"):
    a = Agent(name=name)
    db.add(a)
    db.flush()
    return a


def test_create_assignment_and_list_assignees(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    agent = _agent(db)
    db.commit()

    create_assignment(db, schedule.id, agent.id)
    db.commit()

    assert list_active_assignee_agent_ids(db, schedule.id) == [agent.id]


def test_soft_delete_assignment_removes_from_active_list(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    agent = _agent(db)
    db.commit()
    create_assignment(db, schedule.id, agent.id)
    db.commit()

    soft_delete_assignment(db, schedule.id, agent.id)
    db.commit()

    assert list_active_assignee_agent_ids(db, schedule.id) == []


def test_reassign_after_unassign_is_allowed(db):
    # exercises the partial unique index (schedule_id, agent_id) WHERE deleted_at IS NULL
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    agent = _agent(db)
    db.commit()
    create_assignment(db, schedule.id, agent.id)
    db.commit()
    soft_delete_assignment(db, schedule.id, agent.id)
    db.commit()

    create_assignment(db, schedule.id, agent.id)  # should not raise
    db.commit()

    assert list_active_assignee_agent_ids(db, schedule.id) == [agent.id]


def test_get_other_active_schedule_ids_excludes_the_given_schedule(db):
    schedule_a = create_schedule(db, name="A", start_date=date(2026, 1, 1), end_date=None)
    schedule_b = create_schedule(db, name="B", start_date=date(2026, 1, 1), end_date=None)
    agent = _agent(db)
    db.commit()
    create_assignment(db, schedule_a.id, agent.id)
    create_assignment(db, schedule_b.id, agent.id)
    db.commit()

    result = get_other_active_schedule_ids_for_agent(db, agent.id, exclude_schedule_id=schedule_a.id)

    assert result == [schedule_b.id]


def test_soft_delete_assignments_for_schedule_clears_all_assignees(db):
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    agent1, agent2 = _agent(db, "A1"), _agent(db, "A2")
    db.commit()
    create_assignment(db, schedule.id, agent1.id)
    create_assignment(db, schedule.id, agent2.id)
    db.commit()

    soft_delete_assignments_for_schedule(db, schedule.id)
    db.commit()

    assert list_active_assignee_agent_ids(db, schedule.id) == []
