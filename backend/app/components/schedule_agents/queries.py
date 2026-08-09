# backend/app/components/schedule_agents/queries.py
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.components.schedule_agents.model import ScheduleAgent
from app.domain.types import IST


def create_assignment(session: Session, schedule_id: int, agent_id: int) -> ScheduleAgent:
    assignment = ScheduleAgent(schedule_id=schedule_id, agent_id=agent_id)
    session.add(assignment)
    session.flush()
    return assignment


def soft_delete_assignment(session: Session, schedule_id: int, agent_id: int) -> None:
    session.execute(
        update(ScheduleAgent)
        .where(
            ScheduleAgent.schedule_id == schedule_id,
            ScheduleAgent.agent_id == agent_id,
            ScheduleAgent.deleted_at.is_(None),
        )
        .values(deleted_at=datetime.now(IST))
    )


def list_active_assignee_agent_ids(session: Session, schedule_id: int) -> list[int]:
    stmt = select(ScheduleAgent.agent_id).where(
        ScheduleAgent.schedule_id == schedule_id, ScheduleAgent.deleted_at.is_(None)
    )
    return list(session.scalars(stmt))


def get_other_active_schedule_ids_for_agent(
    session: Session, agent_id: int, exclude_schedule_id: int | None = None
) -> list[int]:
    stmt = select(ScheduleAgent.schedule_id).where(
        ScheduleAgent.agent_id == agent_id, ScheduleAgent.deleted_at.is_(None)
    )
    if exclude_schedule_id is not None:
        stmt = stmt.where(ScheduleAgent.schedule_id != exclude_schedule_id)
    return list(session.scalars(stmt))


def soft_delete_assignments_for_schedule(session: Session, schedule_id: int) -> None:
    session.execute(
        update(ScheduleAgent)
        .where(ScheduleAgent.schedule_id == schedule_id, ScheduleAgent.deleted_at.is_(None))
        .values(deleted_at=datetime.now(IST))
    )
