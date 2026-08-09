# backend/app/api/v1/agents/request_response.py
from pydantic import BaseModel


class AgentResponse(BaseModel):
    id: int
    name: str
    email: str | None


class ScheduleSummaryResponse(BaseModel):
    id: int
    name: str
