# backend/app/components/agents/queries.py
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.components.agents.model import Agent


def list_agents(session: Session, limit: int, offset: int) -> list[Agent]:
    stmt = select(Agent).order_by(Agent.id).limit(limit).offset(offset)
    return list(session.scalars(stmt))


def get_agent(session: Session, agent_id: int) -> Agent | None:
    return session.get(Agent, agent_id)
