# backend/app/services/report_service.py
import logging
import time
from dataclasses import dataclass, field
from datetime import date, datetime, time as time_of_day, timedelta

from app.components.reports import queries as reports_queries
from app.db import db_session_read, db_session_write
from app.domain.business_hours import calculate_business_seconds
from app.domain.types import IST, WeekdayShift
from app.errors.error import NotFoundError
from app.services._conversions import weekday_shift_from_row

logger = logging.getLogger("richpanel.report_service")


def _to_ist(dt: datetime) -> datetime:
    """Every datetime crossing this service's boundary is IST-aware. A naive
    input is taken to already be IST wall-clock (what the UI submits); an aware
    one -- including anything psycopg hands back from a timestamptz column -- is
    converted. Without this, the value read back depends on the database
    session's TimeZone setting rather than on the system's declared timezone."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=IST)
    return dt.astimezone(IST)


def _wall_clock(dt: datetime) -> datetime:
    """Strip the offset for domain.business_hours, which reasons purely in
    weekday + offset-from-midnight terms and must stay timezone-free."""
    return dt.replace(tzinfo=None)


@dataclass(frozen=True)
class AgentHoursRow:
    agent_id: int
    business_seconds: int


@dataclass(frozen=True)
class ReportResult:
    id: int
    ticket_start_at: datetime
    ticket_end_at: datetime
    agent_hours: list[AgentHoursRow] = field(default_factory=list)


def _clip_to_schedule_range(
    window_start: datetime, window_end: datetime, schedule_start: date, schedule_end: date | None
) -> tuple[datetime, datetime] | None:
    """Intersect the report window with the schedule's own effective range, in
    wall-clock terms. `schedule_end` is inclusive of that whole calendar day,
    matching how the rest of the codebase already treats it (e.g. the coarse
    SQL filter this feeds from: `end_date >= window_start.date()`).

    Returns None when the intersection is empty. That can happen even though
    get_active_agent_schedule_pairs already filtered at the DAY level: this
    clip is exact to the minute, and that filter is not. Concretely, a
    schedule whose start_date is the exact calendar day the window ends on
    passes the day-level filter, but its effective start (that day's
    midnight) can fall AT OR AFTER the window's own end -- an empty
    intersection, not a bug in the filter. calculate_business_seconds raises
    on window_end <= window_start rather than returning 0, so this case must
    be caught here, before calling it, not left to surface as an error."""
    effective_start = max(window_start, datetime.combine(schedule_start, time_of_day.min))
    if schedule_end is not None:
        exclusive_end = datetime.combine(schedule_end + timedelta(days=1), time_of_day.min)
        effective_end = min(window_end, exclusive_end)
    else:
        effective_end = window_end
    if effective_end <= effective_start:
        return None
    return effective_start, effective_end


def generate_report(ticket_start_at: datetime, ticket_end_at: datetime) -> ReportResult:
    ticket_start_at = _to_ist(ticket_start_at)
    ticket_end_at = _to_ist(ticket_end_at)
    if ticket_end_at <= ticket_start_at:
        raise ValueError("ticket_end_at must be after ticket_start_at")

    # 1. Read: fetch the bounded row set, then release the connection.
    read_started = time.perf_counter()
    with db_session_read() as session:
        pairs = reports_queries.get_active_agent_schedule_pairs(session, ticket_start_at, ticket_end_at)
        schedule_ids = sorted({sid for _, sid, _, _ in pairs if sid is not None})
        weekday_hours_by_schedule = reports_queries.get_weekday_hours_for_schedules(session, schedule_ids)
    read_ms = round((time.perf_counter() - read_started) * 1000, 2)

    # 2. Compute: pure in-memory work, no DB connection held during this.
    compute_started = time.perf_counter()
    weekly_shifts_by_schedule: dict[int, list[WeekdayShift]] = {
        sid: [weekday_shift_from_row(r) for r in rows] for sid, rows in weekday_hours_by_schedule.items()
    }

    window_start = _wall_clock(ticket_start_at)
    window_end = _wall_clock(ticket_end_at)

    # Each distinct schedule's clipped window and resulting seconds are
    # computed exactly ONCE, however many agents share that schedule -- the
    # clip and the hours calculation both depend only on the schedule, never
    # on which agent is asking, so recomputing per agent would be redundant
    # work, not just a missed optimisation.
    schedule_dates: dict[int, tuple[date, date | None]] = {
        sid: (start, end) for _, sid, start, end in pairs if sid is not None
    }
    seconds_by_schedule: dict[int, int] = {}
    for schedule_id, (schedule_start, schedule_end) in schedule_dates.items():
        clipped = _clip_to_schedule_range(window_start, window_end, schedule_start, schedule_end)
        if clipped is None:
            seconds_by_schedule[schedule_id] = 0
            continue
        clip_start, clip_end = clipped
        shifts = weekly_shifts_by_schedule.get(schedule_id, [])
        seconds_by_schedule[schedule_id] = calculate_business_seconds(shifts, clip_start, clip_end)

    totals_by_agent: dict[int, int] = {}
    for agent_id, schedule_id, _, _ in pairs:
        totals_by_agent.setdefault(agent_id, 0)
        if schedule_id is None:
            continue
        totals_by_agent[agent_id] += seconds_by_schedule[schedule_id]
    compute_ms = round((time.perf_counter() - compute_started) * 1000, 2)

    # 3. Write: fresh session, only to persist the already-computed result.
    write_started = time.perf_counter()
    with db_session_write() as session:
        report = reports_queries.create_report(session, ticket_start_at, ticket_end_at)
        reports_queries.insert_agent_hours(session, report.id, list(totals_by_agent.items()))
        report_id = report.id
    write_ms = round((time.perf_counter() - write_started) * 1000, 2)

    logger.info(
        "report generated",
        extra={
            "report_id": report_id,
            "agent_count": len(totals_by_agent),
            "schedule_count": len(schedule_ids),
            "read_ms": read_ms,
            "compute_ms": compute_ms,
            "write_ms": write_ms,
        },
    )

    return ReportResult(
        id=report_id,
        ticket_start_at=ticket_start_at,
        ticket_end_at=ticket_end_at,
        agent_hours=[AgentHoursRow(agent_id=aid, business_seconds=secs) for aid, secs in totals_by_agent.items()],
    )


def get_report(report_id: int) -> ReportResult:
    with db_session_read() as session:
        report = reports_queries.get_report(session, report_id)
        if report is None:
            raise NotFoundError(f"report {report_id} not found")
        agent_hours = reports_queries.get_agent_hours_for_report(session, report_id)
        return ReportResult(
            id=report.id,
            ticket_start_at=_to_ist(report.ticket_start_at),
            ticket_end_at=_to_ist(report.ticket_end_at),
            agent_hours=[
                AgentHoursRow(agent_id=r.agent_id, business_seconds=r.business_seconds) for r in agent_hours
            ],
        )


def list_reports(limit: int, offset: int) -> list[ReportResult]:
    with db_session_read() as session:
        reports = reports_queries.list_reports(session, limit, offset)
        return [
            ReportResult(id=r.id, ticket_start_at=_to_ist(r.ticket_start_at), ticket_end_at=_to_ist(r.ticket_end_at))
            for r in reports
        ]
