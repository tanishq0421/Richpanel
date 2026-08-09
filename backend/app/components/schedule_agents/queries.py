# backend/app/components/schedule_agents/queries.py
from collections import defaultdict

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.components.schedule_agents.model import ScheduleAgent


def create_assignment(session: Session, schedule_id: int, agent_id: int) -> ScheduleAgent:
    assignment = ScheduleAgent(schedule_id=schedule_id, agent_id=agent_id)
    session.add(assignment)
    session.flush()
    return assignment


def soft_delete_assignment(session: Session, schedule_id: int, agent_id: int) -> None:
    # func.now(): the DB's clock, not the app process's -- matches the model's
    # own onupdate=func.now() on this table. Two clock sources for one audit
    # column let a write land "before" an earlier one under real host/DB skew;
    # see schedules.queries.touch_schedule for the proven failure mode.
    session.execute(
        update(ScheduleAgent)
        .where(
            ScheduleAgent.schedule_id == schedule_id,
            ScheduleAgent.agent_id == agent_id,
            ScheduleAgent.deleted_at.is_(None),
        )
        .values(deleted_at=func.now())
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


def get_other_active_schedule_ids_for_agents(
    session: Session, agent_ids: list[int], exclude_schedule_id: int | None = None
) -> dict[int, list[int]]:
    """Batched form of get_other_active_schedule_ids_for_agent: one query for
    every candidate agent's other active schedule ids, grouped by agent_id,
    instead of N calls to the single-agent version."""
    if not agent_ids:
        return {}
    stmt = select(ScheduleAgent.agent_id, ScheduleAgent.schedule_id).where(
        ScheduleAgent.agent_id.in_(agent_ids), ScheduleAgent.deleted_at.is_(None)
    )
    if exclude_schedule_id is not None:
        stmt = stmt.where(ScheduleAgent.schedule_id != exclude_schedule_id)
    result: dict[int, list[int]] = defaultdict(list)
    for agent_id, schedule_id in session.execute(stmt).all():
        result[agent_id].append(schedule_id)
    return dict(result)


def soft_delete_assignments_for_schedule(session: Session, schedule_id: int) -> None:
    # func.now(): same DB-clock rationale as soft_delete_assignment above.
    session.execute(
        update(ScheduleAgent)
        .where(ScheduleAgent.schedule_id == schedule_id, ScheduleAgent.deleted_at.is_(None))
        .values(deleted_at=func.now())
    )
