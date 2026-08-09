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


def test_unassign_agent(db):
    agent_id = _create_agent()
    schedule_id = _create_schedule("A", [])
    client.post(f"/api/v1/schedules/{schedule_id}/agents", json={"agent_id": agent_id})

    response = client.delete(f"/api/v1/schedules/{schedule_id}/agents/{agent_id}")
    list_response = client.get(f"/api/v1/schedules/{schedule_id}/agents")

    assert response.status_code == 204
    assert list_response.json() == []
