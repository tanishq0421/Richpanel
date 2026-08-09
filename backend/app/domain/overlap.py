# backend/app/domain/overlap.py
from dataclasses import dataclass

from app.domain.types import WeekdayShift


@dataclass(frozen=True)
class Overlap:
    a: WeekdayShift
    b: WeekdayShift


def _intervals_overlap(a: WeekdayShift, b: WeekdayShift) -> bool:
    return a.weekday == b.weekday and a.start_time < b.end_time and b.start_time < a.end_time


def find_overlaps(existing: list[WeekdayShift], new: list[WeekdayShift]) -> list[Overlap]:
    """Every pair (a in existing, b in new) whose weekday matches and whose
    time ranges overlap. Used to check a proposed assignment/edit against an
    agent's other schedules."""
    return [Overlap(a=a, b=b) for a in existing for b in new if _intervals_overlap(a, b)]


def find_self_overlaps(shifts: list[WeekdayShift]) -> list[Overlap]:
    """Every pair of DIFFERENT shifts within one set that overlap each other.
    Used to validate one schedule's own normalized shift set doesn't
    self-conflict (e.g. an overnight tail colliding with that weekday's own
    separately-configured shift)."""
    conflicts = []
    for i, a in enumerate(shifts):
        for b in shifts[i + 1 :]:
            if _intervals_overlap(a, b):
                conflicts.append(Overlap(a=a, b=b))
    return conflicts
