# backend/tests/components/test_agents_queries.py
from app.components.agents.model import Agent
from app.components.agents.queries import get_agent, list_agents


def test_list_agents_returns_seeded_agents(db):
    db.add_all([Agent(name="Alice"), Agent(name="Bob")])
    db.commit()

    result = list_agents(db, limit=10, offset=0)

    assert [a.name for a in result] == ["Alice", "Bob"]


def test_list_agents_respects_limit_and_offset(db):
    db.add_all([Agent(name=f"Agent {i}") for i in range(5)])
    db.commit()

    result = list_agents(db, limit=2, offset=2)

    assert [a.name for a in result] == ["Agent 2", "Agent 3"]


def test_get_agent_returns_none_when_missing(db):
    assert get_agent(db, agent_id=999) is None


def test_get_agent_returns_matching_agent(db):
    agent = Agent(name="Carol")
    db.add(agent)
    db.commit()

    result = get_agent(db, agent_id=agent.id)

    assert result is not None
    assert result.name == "Carol"
