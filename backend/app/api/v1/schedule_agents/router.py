# backend/app/api/v1/schedule_agents/router.py
from fastapi import APIRouter, status

from app.api.v1.schedule_agents.request_response import (
    AgentConflictResponse,
    AgentSummaryResponse,
    AssignRequest,
    CollidingShiftResponse,
    ConflictCheckRequest,
    ConflictCheckResponse,
    ScheduleConflictResponse,
)
from app.services import assignment_service

router = APIRouter(prefix="/api/v1/schedules/{schedule_id}/agents", tags=["schedule-agents"])


def _hours(value) -> float:
    """timedelta -> float hours, the wire format used everywhere else."""
    return value.total_seconds() / 3600


@router.get("", response_model=list[AgentSummaryResponse])
def list_assignees(schedule_id: int):
    agents = assignment_service.list_assignees(schedule_id)
    return [AgentSummaryResponse(id=a.id, name=a.name) for a in agents]


@router.post("", status_code=status.HTTP_201_CREATED)
def assign_agent(schedule_id: int, request: AssignRequest):
    assignment_service.assign_agent(schedule_id, request.agent_id)


@router.post("/check", response_model=ConflictCheckResponse)
def check_assignment_conflicts(schedule_id: int, request: ConflictCheckRequest):
    """Which of these agents cannot be assigned here, and why. Writes nothing.

    POST rather than GET because the agent list can be long enough to strain a
    query string, and because a batch of ids is a request body, not a resource
    path. It remains side-effect free."""
    found = assignment_service.find_assignment_conflicts(schedule_id, request.agent_ids)
    return ConflictCheckResponse(
        conflicts=[
            AgentConflictResponse(
                agent_id=agent.agent_id,
                agent_name=agent.agent_name,
                conflicts=[
                    ScheduleConflictResponse(
                        schedule_id=conflict.schedule_id,
                        schedule_name=conflict.schedule_name,
                        colliding_shifts=[
                            CollidingShiftResponse(
                                weekday=overlap.a.weekday,
                                existing_start_hours=_hours(overlap.a.start_time),
                                existing_end_hours=_hours(overlap.a.end_time),
                                new_start_hours=_hours(overlap.b.start_time),
                                new_end_hours=_hours(overlap.b.end_time),
                            )
                            for overlap in conflict.colliding
                        ],
                    )
                    for conflict in agent.conflicts
                ],
            )
            for agent in found
        ]
    )


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def unassign_agent(schedule_id: int, agent_id: int):
    assignment_service.unassign_agent(schedule_id, agent_id)
