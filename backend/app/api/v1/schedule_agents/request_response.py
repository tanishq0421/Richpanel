# backend/app/api/v1/schedule_agents/request_response.py
from pydantic import BaseModel


class AssignRequest(BaseModel):
    agent_id: int


class AgentSummaryResponse(BaseModel):
    id: int
    name: str
