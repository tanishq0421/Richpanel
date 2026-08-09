from dataclasses import dataclass
from datetime import timedelta
from zoneinfo import ZoneInfo

ZERO = timedelta()
END_OF_DAY = timedelta(hours=24)

# The single system-wide timezone (spec 4.1, previously left open). Every
# schedule's weekday hours and every ticket window are interpreted as IST
# (UTC+05:30) wall-clock time. Storage stays timestamptz so a ticket window
# remains a real instant; this constant is the one place that decides how those
# instants map onto weekdays and offsets-from-midnight. If per-schedule
# timezones are ever required, this constant is the extension point -- nothing
# else in the codebase hardcodes a zone.
IST = ZoneInfo("Asia/Kolkata")


@dataclass(frozen=True)
class ShiftInput:
    """Raw user-facing shift input: one weekday, one start/end offset from
    midnight. May cross midnight (end_time <= start_time)."""

    weekday: int
    start_time: timedelta
    end_time: timedelta

    def __post_init__(self) -> None:
        if not (0 <= self.weekday <= 6):
            raise ValueError(f"weekday must be 0-6, got {self.weekday}")
        if not (ZERO <= self.start_time < END_OF_DAY):
            raise ValueError(f"start_time must be in [0, 24h), got {self.start_time}")
        if not (ZERO <= self.end_time < END_OF_DAY):
            raise ValueError(f"end_time must be in [0, 24h), got {self.end_time}")
        if self.start_time == self.end_time:
            raise ValueError("shift cannot have zero duration (start_time == end_time)")

    @property
    def crosses_midnight(self) -> bool:
        return self.end_time <= self.start_time


@dataclass(frozen=True)
class WeekdayShift:
    """A normalized, always-same-day shift: end_time is always strictly
    after start_time. Overnight input is split into two of these (see
    domain/shift_normalization.py) — a primary ending at END_OF_DAY and a
    tail starting at ZERO on the next weekday."""

    weekday: int
    start_time: timedelta
    end_time: timedelta
    is_overnight_tail: bool = False

    def __post_init__(self) -> None:
        if not (0 <= self.weekday <= 6):
            raise ValueError(f"weekday must be 0-6, got {self.weekday}")
        if not (ZERO <= self.start_time < END_OF_DAY):
            raise ValueError(f"start_time must be in [0, 24h), got {self.start_time}")
        if not (ZERO < self.end_time <= END_OF_DAY):
            raise ValueError(f"end_time must be in (0, 24h], got {self.end_time}")
        if self.end_time <= self.start_time:
            raise ValueError(
                "WeekdayShift must be same-day (end_time > start_time); "
                "use shift_normalization.normalize_shift() to split input that crosses midnight"
            )
        if self.is_overnight_tail and self.start_time != ZERO:
            raise ValueError("an overnight tail must start at 00:00 (start_time == timedelta())")

    @property
    def duration(self) -> timedelta:
        return self.end_time - self.start_time
