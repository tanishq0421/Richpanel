# backend/tests/api/test_schedule_agents_api.py
from fastapi.testclient import TestClient

from app.components.agents.model import Agent
from app.db import db_session_write
from app.main import app

client = TestClient(app)


def _create_schedule(name, shifts):
    response = client.post(
        "/api/v1/schedules", json={"name": name, "start_date": "2026-01-01", "end_date": None, "shifts": shifts}
    )
    return response.json()["id"]


def _create_agent(name="Alice") -> int:
    # Agent creation is deliberately out of scope for the API (spec NFR #1),
    # so tests seed agents directly rather than through an endpoint.
    with db_session_write() as session:
        agent = Agent(name=name)
        session.add(agent)
        session.flush()
        return agent.id


def test_assign_and_list_assignees(db):
    schedule_id = _create_schedule("A", [])
    agent_id = _create_agent()

    assign_response = client.post(f"/api/v1/schedules/{schedule_id}/agents", json={"agent_id": agent_id})
    list_response = client.get(f"/api/v1/schedules/{schedule_id}/agents")

    assert assign_response.status_code == 201
    assert list_response.status_code == 200
    assert [a["id"] for a in list_response.json()] == [agent_id]


def test_assign_conflicting_schedule_returns_409(db):
    agent_id = _create_agent()
    schedule_a = _create_schedule("A", [{"weekday": 0, "start_hours": 9, "end_hours": 17}])
    schedule_b = _create_schedule("B", [{"weekday": 0, "start_hours": 12, "end_hours": 20}])
    client.post(f"/api/v1/schedules/{schedule_a}/agents", json={"agent_id": agent_id})

    response = client.post(f"/api/v1/schedules/{schedule_b}/agents", json={"agent_id": agent_id})

    assert response.status_code == 409


def test_conflict_check_names_the_conflicting_schedule(db):
    # The whole point: the UI must be able to say "Bob is on Night Shift" and
    # offer to free him from it, which needs the schedule's identity -- not just
    # "there is an overlap".
    agent_id = _create_agent()
    day = _create_schedule("Day Shift", [{"weekday": 0, "start_hours": 9, "end_hours": 17}])
    overlapping = _create_schedule("Overlapping", [{"weekday": 0, "start_hours": 12, "end_hours": 20}])
    client.post(f"/api/v1/schedules/{day}/agents", json={"agent_id": agent_id})

    response = client.post(f"/api/v1/schedules/{overlapping}/agents/check", json={"agent_ids": [agent_id]})

    assert response.status_code == 200
    conflicts = response.json()["conflicts"]
    assert len(conflicts) == 1
    assert conflicts[0]["agent_id"] == agent_id
    assert conflicts[0]["conflicts"][0]["schedule_id"] == day
    assert conflicts[0]["conflicts"][0]["schedule_name"] == "Day Shift"
    colliding = conflicts[0]["conflicts"][0]["colliding_shifts"][0]
    assert colliding["weekday"] == 0
    assert colliding["existing_start_hours"] == 9.0
    assert colliding["new_start_hours"] == 12.0


def test_conflict_check_omits_assignable_agents(db):
    free_agent = _create_agent("Free")
    schedule = _create_schedule("A", [{"weekday": 0, "start_hours": 9, "end_hours": 17}])

    response = client.post(f"/api/v1/schedules/{schedule}/agents/check", json={"agent_ids": [free_agent]})

    assert response.status_code == 200
    assert response.json()["conflicts"] == []


def test_conflict_check_writes_nothing(db):
    agent_id = _create_agent()
    day = _create_schedule("Day", [{"weekday": 0, "start_hours": 9, "end_hours": 17}])
    other = _create_schedule("Other", [{"weekday": 0, "start_hours": 12, "end_hours": 20}])
    client.post(f"/api/v1/schedules/{day}/agents", json={"agent_id": agent_id})

    client.post(f"/api/v1/schedules/{other}/agents/check", json={"agent_ids": [agent_id]})

    # The check is a read: the agent must not have been assigned anywhere new.
    assert [a["id"] for a in client.get(f"/api/v1/schedules/{other}/agents").json()] == []
    assert [a["id"] for a in client.get(f"/api/v1/schedules/{day}/agents").json()] == [agent_id]


def test_conflict_check_404s_for_a_missing_schedule(db):
    assert client.post("/api/v1/schedules/999999/agents/check", json={"agent_ids": []}).status_code == 404


def test_conflict_check_batches_correctly_across_multiple_agents(db):
    # Exercises the batched find_assignment_conflicts path (a single call
    # covering several candidate agents spread across several OTHER
    # schedules) and asserts it still resolves each agent's conflicts
    # independently and by the right schedule -- i.e. batching one query per
    # step behind the scenes must produce the exact same per-agent,
    # per-schedule results the old N+1 loop did.
    day = _create_schedule("Day Shift", [{"weekday": 0, "start_hours": 9, "end_hours": 17}])
    evening = _create_schedule("Evening Shift", [{"weekday": 0, "start_hours": 20, "end_hours": 23}])
    target = _create_schedule("Target", [{"weekday": 0, "start_hours": 12, "end_hours": 20}])

    conflicting_agent = _create_agent("Conflicting")  # on Day Shift -> overlaps Target
    clean_agent = _create_agent("Clean")  # on Evening Shift -> no overlap with Target
    free_agent = _create_agent("Free")  # on no schedule at all
    already_on_target = _create_agent("AlreadyOnTarget")  # assigned to Target itself

    client.post(f"/api/v1/schedules/{day}/agents", json={"agent_id": conflicting_agent})
    client.post(f"/api/v1/schedules/{evening}/agents", json={"agent_id": clean_agent})
    client.post(f"/api/v1/schedules/{target}/agents", json={"agent_id": already_on_target})

    response = client.post(
        f"/api/v1/schedules/{target}/agents/check",
        json={"agent_ids": [conflicting_agent, clean_agent, free_agent, already_on_target]},
    )

    assert response.status_code == 200
    conflicts = response.json()["conflicts"]
    assert len(conflicts) == 1
    assert conflicts[0]["agent_id"] == conflicting_agent
    assert conflicts[0]["conflicts"][0]["schedule_id"] == day
    assert conflicts[0]["conflicts"][0]["schedule_name"] == "Day Shift"


def test_unassign_agent(db):
    agent_id = _create_agent()
    schedule_id = _create_schedule("A", [])
    client.post(f"/api/v1/schedules/{schedule_id}/agents", json={"agent_id": agent_id})

    response = client.delete(f"/api/v1/schedules/{schedule_id}/agents/{agent_id}")
    list_response = client.get(f"/api/v1/schedules/{schedule_id}/agents")

    assert response.status_code == 204
    assert list_response.json() == []
