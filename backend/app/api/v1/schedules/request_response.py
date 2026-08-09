# backend/app/api/v1/schedules/request_response.py
from datetime import date, timedelta

from pydantic import BaseModel, model_validator

from app.domain.types import ShiftInput


class ShiftInputSchema(BaseModel):
    weekday: int
    start_hours: float
    end_hours: float

    @model_validator(mode="after")
    def _validate_ranges(self):
        if not (0 <= self.weekday <= 6):
            raise ValueError("weekday must be 0-6")
        if not (0 <= self.start_hours < 24):
            raise ValueError("start_hours must be in [0, 24)")
        if not (0 <= self.end_hours < 24):
            raise ValueError("end_hours must be in [0, 24)")
        return self

    def to_domain(self) -> ShiftInput:
        return ShiftInput(
            weekday=self.weekday,
            start_time=timedelta(hours=self.start_hours),
            end_time=timedelta(hours=self.end_hours),
        )

    @classmethod
    def from_domain(cls, shift: ShiftInput) -> "ShiftInputSchema":
        return cls(
            weekday=shift.weekday,
            start_hours=shift.start_time.total_seconds() / 3600,
            end_hours=shift.end_time.total_seconds() / 3600,
        )


class ScheduleCreateRequest(BaseModel):
    name: str
    start_date: date
    end_date: date | None = None
    shifts: list[ShiftInputSchema]


class ScheduleUpdateRequest(BaseModel):
    shifts: list[ShiftInputSchema]


class ScheduleResponse(BaseModel):
    id: int
    name: str
    start_date: date
    end_date: date | None
    shifts: list[ShiftInputSchema]


class DeletionImpactResponse(BaseModel):
    schedule_id: int
    affected_agent_ids: list[int]
