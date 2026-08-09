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


def list_agents(session: Session, limit: int, offset: int, q: str | None = None) -> list[Agent]:
    stmt = select(Agent).order_by(Agent.id)
    if q:
        # Single ILIKE filter, name only -- matches the picker's own search
        # box, and keeps this a minimal addition rather than a second search
        # feature (email, fuzzy matching, etc.) nobody asked for.
        stmt = stmt.where(Agent.name.ilike(f"%{q}%"))
    stmt = stmt.limit(limit).offset(offset)
    return list(session.scalars(stmt))


def get_agent(session: Session, agent_id: int) -> Agent | None:
    return session.get(Agent, agent_id)


def get_agents(session: Session, agent_ids: list[int]) -> dict[int, Agent]:
    """Batched form of get_agent: one WHERE id IN (...) query for every
    requested agent, keyed by id, instead of N calls to get_agent."""
    if not agent_ids:
        return {}
    stmt = select(Agent).where(Agent.id.in_(agent_ids))
    return {a.id: a for a in session.scalars(stmt)}
