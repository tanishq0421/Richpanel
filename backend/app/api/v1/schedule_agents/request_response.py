# backend/app/api/v1/schedule_agents/request_response.py
from pydantic import BaseModel


class AssignRequest(BaseModel):
    agent_id: int


class AgentSummaryResponse(BaseModel):
    id: int
    name: str


class ConflictCheckRequest(BaseModel):
    agent_ids: list[int]


class CollidingShiftResponse(BaseModel):
    """The hours that actually clash, so the UI can say WHEN, not just that
    something overlaps. Hours are floats matching the wire format elsewhere:
    22.5 is 22:30. `weekday` is 0 = Monday."""

    weekday: int
    existing_start_hours: float
    existing_end_hours: float
    new_start_hours: float
    new_end_hours: float


class ScheduleConflictResponse(BaseModel):
    schedule_id: int
    schedule_name: str
    colliding_shifts: list[CollidingShiftResponse]


class AgentConflictResponse(BaseModel):
    agent_id: int
    agent_name: str
    conflicts: list[ScheduleConflictResponse]


class ConflictCheckResponse(BaseModel):
    """Agents that CANNOT currently be assigned, with the reason. Agents absent
    from this list are assignable. Advisory only -- the write still re-checks
    under its lock, since state can change between this call and the assign."""

    conflicts: list[AgentConflictResponse]
