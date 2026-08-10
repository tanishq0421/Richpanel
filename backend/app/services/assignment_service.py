# backend/app/services/assignment_service.py
import logging
import time
from dataclasses import dataclass
from datetime import date

from app.components.agents import queries as agents_queries
from app.components.agents.model import Agent
from app.components.agents.queries import get_agent
from app.components.reports import queries as reports_queries
from app.components.schedule_agents import queries as schedule_agents_queries
from app.components.schedules import queries as schedules_queries
from app.components.schedules.model import Schedule
from app.db import db_session_read, db_session_write
from app.domain.overlap import Overlap, find_overlaps
from app.domain.types import WeekdayShift
from app.errors.error import AssignmentOverlapError, ConflictError, NotFoundError
from app.services._conversions import date_ranges_overlap, weekday_shift_from_row

logger = logging.getLogger("richpanel.assignment_service")


def _weekday_shifts_for_schedule(session, schedule_id: int) -> list[WeekdayShift]:
    return [weekday_shift_from_row(r) for r in schedules_queries.get_weekday_hours_rows(session, schedule_id)]


@dataclass(frozen=True)
class ScheduleConflict:
    """One of an agent's existing schedules whose hours collide with the target
    schedule's. Carries the schedule's identity, not just the colliding hours,
    so the caller can offer to free the agent from THAT schedule by name."""

    schedule_id: int
    schedule_name: str
    colliding: list[Overlap]


@dataclass(frozen=True)
class AgentConflict:
    agent_id: int
    agent_name: str
    conflicts: list[ScheduleConflict]


def _conflicts_for_agents(
    session,
    agent_ids: list[int],
    target_shifts: list[WeekdayShift],
    target_start: date,
    target_end: date | None,
    exclude_schedule_id: int | None,
) -> dict[int, list[ScheduleConflict]]:
    """Batched form of the per-agent conflict check: for N candidate agents,
    issues one query for every OTHER active schedule id per agent, one query
    for the weekday-hours of the UNION of those schedule ids, and one query
    for their names -- regardless of how many agents or how many schedules
    they're spread across. Replaces what used to be 2 extra queries per OTHER
    schedule, per agent (the N+1 pattern).

    Compares per schedule rather than against one flattened list of shifts.
    Flattening loses which schedule produced the collision, which is exactly
    the fact the UI needs in order to say 'Bob is on Night Shift' and offer to
    remove him from it.

    target_start/target_end are the TARGET schedule's own effective date
    range. A candidate schedule whose range never coexists with it is skipped
    before the weekday/time comparison runs -- domain.overlap stays date-free
    by design, so date awareness lives here, at the call site."""
    other_ids_by_agent = schedule_agents_queries.get_other_active_schedule_ids_for_agents(
        session, agent_ids, exclude_schedule_id=exclude_schedule_id
    )
    all_other_ids = sorted({sid for ids in other_ids_by_agent.values() for sid in ids})
    hours_by_schedule = reports_queries.get_weekday_hours_for_schedules(session, all_other_ids)
    schedules_by_id = schedules_queries.get_schedules(session, all_other_ids)

    result: dict[int, list[ScheduleConflict]] = {}
    for agent_id in agent_ids:
        found: list[ScheduleConflict] = []
        for other_id in other_ids_by_agent.get(agent_id, []):
            other = schedules_by_id.get(other_id)
            if other is None:
                continue
            if not date_ranges_overlap(target_start, target_end, other.start_date, other.end_date):
                continue
            other_shifts = [weekday_shift_from_row(r) for r in hours_by_schedule.get(other_id, [])]
            overlaps = find_overlaps(other_shifts, target_shifts)
            if overlaps:
                found.append(ScheduleConflict(schedule_id=other_id, schedule_name=other.name, colliding=overlaps))
        result[agent_id] = found
    return result


def _conflicts_for_agent(
    session,
    agent_id: int,
    target_shifts: list[WeekdayShift],
    target_start: date,
    target_end: date | None,
    exclude_schedule_id: int | None,
) -> list[ScheduleConflict]:
    """Single-agent conflict check used by assign_agent's write path, where
    only one candidate is ever checked under the write lock. Delegates to the
    batched helper with a one-element list so both call sites share one code
    path and one query shape."""
    return _conflicts_for_agents(session, [agent_id], target_shifts, target_start, target_end, exclude_schedule_id)[
        agent_id
    ]


def find_assignment_conflicts(schedule_id: int, agent_ids: list[int]) -> list[AgentConflict]:
    """Read-only pre-flight: which of these agents could NOT be assigned to this
    schedule, and why. Writes nothing, takes no lock.

    The UI calls this as it opens the assign dialog so conflicting agents are
    non-selectable from the outset, rather than being offered and then rejected.
    It is advisory, not authoritative -- state can change between this call and
    the write -- so assign_agent still performs the real check under its lock."""
    with db_session_read() as session:
        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")

        target_shifts = _weekday_shifts_for_schedule(session, schedule_id)
        already_assigned = set(schedule_agents_queries.list_active_assignee_agent_ids(session, schedule_id))

        # Dedup + drop already-assigned before batching: they're filtered from
        # the picker anyway, and there's no reason to look up their schedules.
        candidate_ids = [aid for aid in dict.fromkeys(agent_ids) if aid not in already_assigned]
        agents_by_id = agents_queries.get_agents(session, candidate_ids)
        existing_candidate_ids = [aid for aid in candidate_ids if aid in agents_by_id]
        conflicts_by_agent = _conflicts_for_agents(
            session,
            existing_candidate_ids,
            target_shifts,
            schedule.start_date,
            schedule.end_date,
            exclude_schedule_id=schedule_id,
        )

        results: list[AgentConflict] = []
        for agent_id in agent_ids:
            agent = agents_by_id.get(agent_id)
            if agent is None or agent_id in already_assigned:
                # A missing agent is not this endpoint's business, and an
                # already-assigned one is filtered from the picker anyway.
                continue
            conflicts = conflicts_by_agent.get(agent_id, [])
            if conflicts:
                results.append(AgentConflict(agent_id=agent_id, agent_name=agent.name, conflicts=conflicts))
        return results


def assign_agent(schedule_id: int, agent_id: int) -> None:
    with db_session_write() as session:
        # check-then-write must share this one locked transaction (see Global Constraints).
        # Schedule lock FIRST, then the agent lock -- the global order defined in
        # schedules.queries.lock_schedule. The agent lock alone left this path and
        # an hours edit with nothing in common to contend on, so both could
        # validate against the other's stale state and commit. Taking the agent
        # lock first here (as this used to) would invert the order and deadlock.
        lock_started = time.perf_counter()
        schedules_queries.lock_schedule(session, schedule_id)
        agents_queries.lock_agent(session, agent_id)
        lock_wait_ms = round((time.perf_counter() - lock_started) * 1000, 2)

        schedule = schedules_queries.get_schedule(session, schedule_id)
        if schedule is None:
            raise NotFoundError(f"schedule {schedule_id} not found")
        if get_agent(session, agent_id) is None:
            # Without this the insert below fails on the agents FK, which
            # surfaced as a 500 rather than a 404.
            raise NotFoundError(f"agent {agent_id} not found")

        if agent_id in schedule_agents_queries.list_active_assignee_agent_ids(session, schedule_id):
            # Must be caught before the overlap check: get_other_active_... is
            # called WITHOUT exclude_schedule_id below (deliberately -- at assign
            # time this schedule is not yet among the agent's schedules), so an
            # already-assigned agent would otherwise be reported as overlapping
            # itself, or hit the partial unique index and 500 when the schedule
            # has no shifts to overlap.
            raise ConflictError(f"agent {agent_id} is already assigned to schedule {schedule_id}")

        new_shifts = _weekday_shifts_for_schedule(session, schedule_id)
        # Same per-schedule comparison the pre-flight check uses, so the two can
        # never disagree about what counts as a conflict.
        schedule_conflicts = _conflicts_for_agent(
            session, agent_id, new_shifts, schedule.start_date, schedule.end_date, exclude_schedule_id=schedule_id
        )
        if schedule_conflicts:
            logger.info(
                "assignment rejected: overlap",
                extra={
                    "schedule_id": schedule_id,
                    "agent_id": agent_id,
                    "conflicting_schedule_ids": [c.schedule_id for c in schedule_conflicts],
                    "lock_wait_ms": lock_wait_ms,
                },
            )
            raise AssignmentOverlapError(
                agent_id=agent_id,
                conflicts=[overlap for c in schedule_conflicts for overlap in c.colliding],
            )

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
