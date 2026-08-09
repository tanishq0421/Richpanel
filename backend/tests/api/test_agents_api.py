# backend/tests/api/test_agents_api.py
from datetime import date

from fastapi.testclient import TestClient

from app.components.agents.model import Agent
from app.db import db_session_write
from app.main import app
from app.services.assignment_service import assign_agent
from app.services.schedule_service import create_schedule


def test_list_agents_returns_seeded_agents(db):
    with db_session_write() as session:
        session.add_all([Agent(name="Alice"), Agent(name="Bob")])

    response = TestClient(app).get("/api/v1/agents")

    assert response.status_code == 200
    names = {a["name"] for a in response.json()}
    assert names == {"Alice", "Bob"}


def test_get_schedules_for_agent(db):
    schedule = create_schedule(name="A", start_date=date(2026, 1, 1), end_date=None, shift_inputs=[])
    with db_session_write() as session:
        agent = Agent(name="Alice")
        session.add(agent)
        session.flush()
        agent_id = agent.id
    assign_agent(schedule.id, agent_id)

    response = TestClient(app).get(f"/api/v1/agents/{agent_id}/schedules")

    assert response.status_code == 200
    assert [s["id"] for s in response.json()] == [schedule.id]
