# backend/app/api/v1/schedules/request_response.py
from datetime import date, timedelta

from pydantic import BaseModel, Field, model_validator

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
        # Relational rules belong here, not deeper. Previously these fell through
        # to a bare ValueError in the domain dataclass (raised inside the router
        # body) or to a database constraint -- both surfaced as a 500 on ordinary
        # input a user can type into the form. Pydantic turns them into a 422
        # naming the offending field.
        if self.start_hours == self.end_hours:
            raise ValueError(
                "a shift cannot start and end at the same time; "
                "round-the-clock (24-hour) schedules are not supported"
            )
        if self.end_hours == 0:
            # 22:00 -> 00:00 normalises to a primary row plus a zero-length
            # overnight tail, which the domain rejects. Say so plainly instead of
            # failing deep in normalisation.
            raise ValueError(
                "end_hours must not be 0; a shift ending at midnight is not "
                "supported -- use 23.99 for a shift running to the end of the day"
            )
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


def _reject_duplicate_weekdays(shifts: list[ShiftInputSchema]) -> None:
    """Exactly one time window per weekday per schedule. Split shifts (e.g. a
    lunch break: Mon 09:00-12:00 plus Mon 14:00-18:00) are deliberately out of
    scope, enforced in the database by the partial unique index on
    (schedule_id, weekday, is_overnight_tail).

    Checking it here matters because find_self_overlaps() does NOT catch it --
    two same-weekday windows that don't overlap pass domain validation and then
    violate the index, which surfaced as a 500. If multiple windows per weekday
    are ever required, drop that index and delete this check together."""
    seen: set[int] = set()
    duplicates = sorted({s.weekday for s in shifts if s.weekday in seen or seen.add(s.weekday)})
    if duplicates:
        raise ValueError(
            f"only one time window per weekday is supported; weekday(s) {duplicates} appear more than once"
        )


class ScheduleCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    start_date: date
    end_date: date | None = None
    shifts: list[ShiftInputSchema]

    @model_validator(mode="after")
    def _validate_relationships(self):
        if self.end_date is not None and self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        _reject_duplicate_weekdays(self.shifts)
        return self


class ScheduleUpdateRequest(BaseModel):
    shifts: list[ShiftInputSchema]

    @model_validator(mode="after")
    def _validate_relationships(self):
        _reject_duplicate_weekdays(self.shifts)
        return self


class ScheduleResponse(BaseModel):
    id: int
    name: str
    start_date: date
    end_date: date | None
    shifts: list[ShiftInputSchema]


class DeletionImpactResponse(BaseModel):
    schedule_id: int
    affected_agent_ids: list[int]
