from app.domain.types import END_OF_DAY, ZERO, ShiftInput, WeekdayShift


def normalize_shift(shift: ShiftInput) -> list[WeekdayShift]:
    """Split a possibly-midnight-crossing ShiftInput into 1 or 2 same-day
    WeekdayShift rows, ready to persist."""
    if not shift.crosses_midnight:
        return [WeekdayShift(weekday=shift.weekday, start_time=shift.start_time, end_time=shift.end_time)]

    primary = WeekdayShift(weekday=shift.weekday, start_time=shift.start_time, end_time=END_OF_DAY)
    tail = WeekdayShift(
        weekday=(shift.weekday + 1) % 7,
        start_time=ZERO,
        end_time=shift.end_time,
        is_overnight_tail=True,
    )
    return [primary, tail]


def recombine_shifts(shifts: list[WeekdayShift]) -> list[ShiftInput]:
    """Inverse of normalize_shift: merge primary+tail pairs back into one
    logical (possibly midnight-crossing) shift per weekday, for display.
    Raises ValueError if a tail row has no matching primary — a data
    integrity anomaly that should never happen if all writes go through
    normalize_shift, but is surfaced loudly rather than silently dropped."""
    tails_by_weekday = {s.weekday: s for s in shifts if s.is_overnight_tail}
    primaries = [s for s in shifts if not s.is_overnight_tail]

    result: list[ShiftInput] = []
    consumed_tail_weekdays: set[int] = set()

    for primary in primaries:
        next_weekday = (primary.weekday + 1) % 7
        tail = tails_by_weekday.get(next_weekday)
        if primary.end_time == END_OF_DAY and tail is not None:
            result.append(
                ShiftInput(weekday=primary.weekday, start_time=primary.start_time, end_time=tail.end_time)
            )
            consumed_tail_weekdays.add(next_weekday)
        else:
            result.append(
                ShiftInput(
                    weekday=primary.weekday, start_time=primary.start_time, end_time=primary.end_time
                )
            )

    orphan_tails = [wd for wd in tails_by_weekday if wd not in consumed_tail_weekdays]
    if orphan_tails:
        raise ValueError(f"orphaned overnight-tail rows with no matching primary for weekday(s): {orphan_tails}")

    return result
