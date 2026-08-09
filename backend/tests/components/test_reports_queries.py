# backend/tests/components/test_reports_queries.py
from datetime import date, datetime, timedelta

from app.components.agents.model import Agent
from app.components.reports.queries import (
    create_report,
    get_active_agent_schedule_pairs,
    get_agent_hours_for_report,
    get_report,
    get_weekday_hours_for_schedules,
    insert_agent_hours,
    list_reports,
)
from app.components.schedule_agents.queries import create_assignment
from app.components.schedules.queries import create_schedule, insert_weekday_hours_rows
from app.domain.types import WeekdayShift


def test_create_and_get_report(db):
    report = create_report(db, ticket_start_at=datetime(2026, 1, 1), ticket_end_at=datetime(2026, 1, 2))
    db.commit()

    fetched = get_report(db, report.id)

    assert fetched is not None
    assert fetched.ticket_start_at == datetime(2026, 1, 1)


def test_insert_and_get_agent_hours_for_report(db):
    agent = Agent(name="Alice")
    db.add(agent)
    db.flush()
    report = create_report(db, ticket_start_at=datetime(2026, 1, 1), ticket_end_at=datetime(2026, 1, 2))
    db.commit()

    insert_agent_hours(db, report.id, [(agent.id, 28800)])
    db.commit()

    rows = get_agent_hours_for_report(db, report.id)
    assert len(rows) == 1
    assert rows[0].agent_id == agent.id
    assert rows[0].business_seconds == 28800


def test_list_reports_orders_by_id(db):
    create_report(db, ticket_start_at=datetime(2026, 1, 1), ticket_end_at=datetime(2026, 1, 2))
    create_report(db, ticket_start_at=datetime(2026, 2, 1), ticket_end_at=datetime(2026, 2, 2))
    db.commit()

    result = list_reports(db, limit=10, offset=0)

    assert len(result) == 2
    assert result[0].id < result[1].id


def test_get_active_agent_schedule_pairs_includes_unassigned_agents(db):
    unassigned = Agent(name="Unassigned")
    assigned = Agent(name="Assigned")
    db.add_all([unassigned, assigned])
    db.flush()
    schedule = create_schedule(db, name="Day Shift", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    create_assignment(db, schedule.id, assigned.id)
    db.commit()

    pairs = get_active_agent_schedule_pairs(db, datetime(2026, 6, 1), datetime(2026, 6, 2))

    pairs_by_agent = {agent_id: schedule_id for agent_id, schedule_id in pairs}
    assert pairs_by_agent[unassigned.id] is None
    assert pairs_by_agent[assigned.id] == schedule.id


def test_get_active_agent_schedule_pairs_excludes_schedules_outside_date_range(db):
    agent = Agent(name="Agent")
    db.add(agent)
    db.flush()
    schedule = create_schedule(db, name="Future", start_date=date(2030, 1, 1), end_date=None)
    db.commit()
    create_assignment(db, schedule.id, agent.id)
    db.commit()

    pairs = get_active_agent_schedule_pairs(db, datetime(2026, 6, 1), datetime(2026, 6, 2))

    pairs_by_agent = {agent_id: schedule_id for agent_id, schedule_id in pairs}
    assert pairs_by_agent[agent.id] is None


def test_get_weekday_hours_for_schedules_groups_by_schedule(db):
    schedule_a = create_schedule(db, name="A", start_date=date(2026, 1, 1), end_date=None)
    schedule_b = create_schedule(db, name="B", start_date=date(2026, 1, 1), end_date=None)
    db.commit()
    insert_weekday_hours_rows(
        db, schedule_a.id, [WeekdayShift(weekday=0, start_time=timedelta(hours=9), end_time=timedelta(hours=17))]
    )
    insert_weekday_hours_rows(
        db, schedule_b.id, [WeekdayShift(weekday=1, start_time=timedelta(hours=8), end_time=timedelta(hours=16))]
    )
    db.commit()

    result = get_weekday_hours_for_schedules(db, [schedule_a.id, schedule_b.id])

    assert {r.weekday for r in result[schedule_a.id]} == {0}
    assert {r.weekday for r in result[schedule_b.id]} == {1}
