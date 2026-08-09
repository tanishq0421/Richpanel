# backend/app/components/agents/queries.py
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.components.agents.model import Agent


def lock_agent(session: Session, agent_id: int) -> None:
    """Serialise every writer that could change this agent's set of schedules,
    held to end of transaction.

    Single-key form deliberately: schedules.queries.lock_schedule uses the
    two-key form, which Postgres keeps in a separate space, so the two can never
    collide. Callers must take the schedule lock first and, where several agents
    are locked, take them in ascending agent_id order."""
    session.execute(text("SELECT pg_advisory_xact_lock(:agent_id)"), {"agent_id": agent_id})


def list_agents(session: Session, limit: int, offset: int) -> list[Agent]:
    stmt = select(Agent).order_by(Agent.id).limit(limit).offset(offset)
    return list(session.scalars(stmt))


def get_agent(session: Session, agent_id: int) -> Agent | None:
    return session.get(Agent, agent_id)
