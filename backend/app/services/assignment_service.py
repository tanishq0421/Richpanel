# backend/app/services/assignment_service.py
import logging
import time

from sqlalchemy import text

from app.components.agents.model import Agent
from app.components.agents.queries import get_agent
from app.components.schedule_agents import queries as schedule_agents_queries
from app.components.schedules import queries as schedules_queries
from app.components.schedules.model import Schedule
from app.db import db_session_read, db_session_write
from app.domain.overlap import find_overlaps
from app.domain.types import WeekdayShift
from app.errors.error import AssignmentOverlapError, NotFoundError
from app.services._conversions import weekday_shift_from_row

logger = logging.getLogger("richpanel.assignment_service")


def _weekday_shifts_for_schedule(session, schedule_id: int) -> list[WeekdayShift]:
    return [weekday_shift_from_row(r) for r in schedules_queries.get_weekday_hours_rows(session, schedule_id)]


def assign_agent(schedule_id: int, agent_id: int) -> None:
    with db_session_write() as session:
        # check-then-write must share this one locked transaction (see Global Constraints)
        lock_started = time.perf_counter()
        session.execute(text("SELECT pg_advisory_xact_lock(:aid)"), {"aid": agent_id})
        lock_wait_ms = round((time.perf_counter() - lock_started) * 1000, 2)

        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")

        other_schedule_ids = schedule_agents_queries.get_other_active_schedule_ids_for_agent(session, agent_id)
        existing_shifts: list[WeekdayShift] = []
        for other_id in other_schedule_ids:
            existing_shifts.extend(_weekday_shifts_for_schedule(session, other_id))

        new_shifts = _weekday_shifts_for_schedule(session, schedule_id)
        conflicts = find_overlaps(existing_shifts, new_shifts)
        if conflicts:
            logger.info(
                "assignment rejected: overlap",
                extra={"schedule_id": schedule_id, "agent_id": agent_id, "lock_wait_ms": lock_wait_ms},
            )
            raise AssignmentOverlapError(agent_id=agent_id, conflicts=conflicts)

        schedule_agents_queries.create_assignment(session, schedule_id, agent_id)

    logger.info(
        "agent assigned", extra={"schedule_id": schedule_id, "agent_id": agent_id, "lock_wait_ms": lock_wait_ms}
    )


def unassign_agent(schedule_id: int, agent_id: int) -> None:
    with db_session_write() as session:
        schedule_agents_queries.soft_delete_assignment(session, schedule_id, agent_id)
    logger.info("agent unassigned", extra={"schedule_id": schedule_id, "agent_id": agent_id})


def list_assignees(schedule_id: int) -> list[Agent]:
    with db_session_read() as session:
        agent_ids = schedule_agents_queries.list_active_assignee_agent_ids(session, schedule_id)
        return [get_agent(session, aid) for aid in agent_ids]


def list_schedules_for_agent(agent_id: int) -> list[Schedule]:
    with db_session_read() as session:
        schedule_ids = schedule_agents_queries.get_other_active_schedule_ids_for_agent(session, agent_id)
        return [schedules_queries.get_schedule(session, sid) for sid in schedule_ids]
