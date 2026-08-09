# backend/app/api/v1/schedule_agents/router.py
from fastapi import APIRouter, status

from app.api.v1.schedule_agents.request_response import AgentSummaryResponse, AssignRequest
from app.services import assignment_service

router = APIRouter(prefix="/api/v1/schedules/{schedule_id}/agents", tags=["schedule-agents"])


@router.get("", response_model=list[AgentSummaryResponse])
def list_assignees(schedule_id: int):
    agents = assignment_service.list_assignees(schedule_id)
    return [AgentSummaryResponse(id=a.id, name=a.name) for a in agents]


@router.post("", status_code=status.HTTP_201_CREATED)
def assign_agent(schedule_id: int, request: AssignRequest):
    assignment_service.assign_agent(schedule_id, request.agent_id)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def unassign_agent(schedule_id: int, agent_id: int):
    assignment_service.unassign_agent(schedule_id, agent_id)
