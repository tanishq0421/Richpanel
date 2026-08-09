# backend/app/api/v1/reports/request_response.py
from datetime import datetime

from pydantic import BaseModel


class ReportGenerateRequest(BaseModel):
    ticket_start_at: datetime
    ticket_end_at: datetime


class AgentHoursResponse(BaseModel):
    agent_id: int
    business_seconds: int


class ReportResponse(BaseModel):
    id: int
    ticket_start_at: datetime
    ticket_end_at: datetime
    agent_hours: list[AgentHoursResponse]
