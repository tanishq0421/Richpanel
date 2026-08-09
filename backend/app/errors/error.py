# backend/app/errors/error.py
from app.domain.overlap import Overlap


class AppError(Exception):
    """Base for all application-raised errors the API layer knows how to
    translate into an HTTP response."""


class NotFoundError(AppError):
    """A requested resource (schedule, agent, report) doesn't exist. -> 404"""


class ConflictError(AppError):
    """The requested write would violate a business invariant. -> 409"""


class ScheduleOverlapError(ConflictError):
    """A schedule's own weekday-hours rows self-conflict (e.g. an overnight
    tail colliding with that weekday's own separately-configured shift)."""

    def __init__(self, conflicts: list[Overlap]):
        self.conflicts = conflicts
        super().__init__(f"schedule has {len(conflicts)} self-overlapping shift(s)")


class AssignmentOverlapError(ConflictError):
    """Assigning/editing would create an overlap for one agent against their
    other active schedules."""

    def __init__(self, agent_id: int, conflicts: list[Overlap]):
        self.agent_id = agent_id
        self.conflicts = conflicts
        super().__init__(f"agent {agent_id} would have {len(conflicts)} overlapping shift(s)")


class DomainValidationError(AppError):
    """A business-rule violation requiring DB state to detect (not a plain
    request-shape issue, which Pydantic already handles at 422). -> 400"""
