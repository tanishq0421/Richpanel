# backend/tests/test_errors.py
from datetime import timedelta

from app.domain.overlap import Overlap
from app.domain.types import WeekdayShift
from app.errors.error import (
    AppError,
    AssignmentOverlapError,
    ConflictError,
    DomainValidationError,
    NotFoundError,
    ScheduleOverlapError,
)


def test_hierarchy():
    assert issubclass(NotFoundError, AppError)
    assert issubclass(ConflictError, AppError)
    assert issubclass(ScheduleOverlapError, ConflictError)
    assert issubclass(AssignmentOverlapError, ConflictError)
    assert issubclass(DomainValidationError, AppError)


def test_conflict_error_carries_conflicts():
    a = WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))
    b = WeekdayShift(weekday=0, start_time=timedelta(hours=12), end_time=timedelta(hours=20))
    err = AssignmentOverlapError(agent_id=42, conflicts=[Overlap(a=a, b=b)])
    assert err.agent_id == 42
    assert len(err.conflicts) == 1
