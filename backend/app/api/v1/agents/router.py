# backend/app/api/v1/agents/router.py
from fastapi import APIRouter, Depends

from app.api.v1.agents.request_response import AgentResponse, ScheduleSummaryResponse
from app.components.agents import queries as agents_queries
from app.db import db_session_read
from app.services.assignment_service import list_schedules_for_agent
from app.shared.pagination import PaginationParams

router = APIRouter(prefix="/api/v1/agents", tags=["agents"])


@router.get("", response_model=list[AgentResponse])
def list_agents(q: str | None = None, pagination: PaginationParams = Depends()):
    with db_session_read() as session:
        agents = agents_queries.list_agents(session, pagination.limit, pagination.offset, q=q)
        return [AgentResponse(id=a.id, name=a.name, email=a.email) for a in agents]


@router.get("/{agent_id}/schedules", response_model=list[ScheduleSummaryResponse])
def get_schedules_for_agent(agent_id: int):
    schedules = list_schedules_for_agent(agent_id)
    return [ScheduleSummaryResponse(id=s.id, name=s.name) for s in schedules]
