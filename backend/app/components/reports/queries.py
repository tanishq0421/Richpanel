# backend/app/components/reports/queries.py
from collections import defaultdict
from datetime import date, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.components.agents.model import Agent
from app.components.reports.model import ResolutionReport, ResolutionReportAgentHours
from app.components.schedule_agents.model import ScheduleAgent
from app.components.schedules.model import Schedule, ScheduleWeekdayHours


def create_report(session: Session, ticket_start_at: datetime, ticket_end_at: datetime) -> ResolutionReport:
    report = ResolutionReport(ticket_start_at=ticket_start_at, ticket_end_at=ticket_end_at)
    session.add(report)
    session.flush()
    return report


def insert_agent_hours(session: Session, report_id: int, rows: list[tuple[int, int]]) -> None:
    session.add_all(
        [
            ResolutionReportAgentHours(report_id=report_id, agent_id=agent_id, business_seconds=seconds)
            for agent_id, seconds in rows
        ]
    )


def list_reports(session: Session, limit: int, offset: int) -> list[ResolutionReport]:
    stmt = select(ResolutionReport).order_by(ResolutionReport.id).limit(limit).offset(offset)
    return list(session.scalars(stmt))


def get_report(session: Session, report_id: int) -> ResolutionReport | None:
    return session.get(ResolutionReport, report_id)


def get_agent_hours_for_report(session: Session, report_id: int) -> list[ResolutionReportAgentHours]:
    stmt = select(ResolutionReportAgentHours).where(ResolutionReportAgentHours.report_id == report_id)
    return list(session.scalars(stmt))


def get_active_agent_schedule_pairs(
    session: Session, window_start: datetime, window_end: datetime
) -> list[tuple[int, int | None, date | None, date | None]]:
    """Every agent, paired with each active schedule whose effective date
    range overlaps the window. Agents with no matching schedule appear once
    with schedule_id=None (0-hour contribution).

    Also returns each matched schedule's own start_date/end_date (None when
    schedule_id is None). This WHERE clause only decides whether a schedule is
    considered at all -- it does not bound which of its hours count. A
    schedule effective for one day inside a much wider report window still
    passes this filter; the caller uses the returned dates to clip the hours
    calculation down to the schedule's actual effective range within the
    window, rather than crediting the whole window."""
    stmt = (
        select(Agent.id, Schedule.id, Schedule.start_date, Schedule.end_date)
        .select_from(Agent)
        .outerjoin(
            ScheduleAgent,
            (ScheduleAgent.agent_id == Agent.id) & (ScheduleAgent.deleted_at.is_(None)),
        )
        .outerjoin(
            Schedule,
            (Schedule.id == ScheduleAgent.schedule_id)
            & (Schedule.deleted_at.is_(None))
            & (Schedule.start_date <= window_end.date())
            & (or_(Schedule.end_date.is_(None), Schedule.end_date >= window_start.date())),
        )
        .order_by(Agent.id)
    )
    return list(session.execute(stmt).all())


def get_weekday_hours_for_schedules(
    session: Session, schedule_ids: list[int]
) -> dict[int, list[ScheduleWeekdayHours]]:
    if not schedule_ids:
        return {}
    stmt = select(ScheduleWeekdayHours).where(
        ScheduleWeekdayHours.schedule_id.in_(schedule_ids), ScheduleWeekdayHours.deleted_at.is_(None)
    )
    result: dict[int, list[ScheduleWeekdayHours]] = defaultdict(list)
    for row in session.scalars(stmt):
        result[row.schedule_id].append(row)
    return dict(result)
