# backend/tests/services/test_report_service.py
from datetime import date, datetime, timedelta

import pytest

from app.db import db_session_write
from app.domain.types import ShiftInput
from app.errors.error import NotFoundError
from app.services.assignment_service import assign_agent
from app.services.report_service import generate_report, get_report, list_reports
from app.services.schedule_service import create_schedule


def _create_agent(name="Agent") -> int:
    from app.components.agents.model import Agent

    with db_session_write() as session:
        agent = Agent(name=name)
        session.add(agent)
        session.flush()
        return agent.id


def test_generate_report_computes_hours_for_assigned_agent(db):
    schedule = create_schedule(
        name="Day Shift",
        start_date=date(2026, 1, 1),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=1, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    result = generate_report(
        ticket_start_at=datetime(2026, 1, 6, 10, 0, 0),  # Tuesday 10:00
        ticket_end_at=datetime(2026, 1, 6, 14, 0, 0),  # Tuesday 14:00
    )

    row = next(r for r in result.agent_hours if r.agent_id == agent_id)
    assert row.business_seconds == 4 * 3600


def test_generate_report_includes_unassigned_agents_at_zero(db):
    unassigned_id = _create_agent("Unassigned")

    result = generate_report(
        ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0)
    )

    row = next(r for r in result.agent_hours if r.agent_id == unassigned_id)
    assert row.business_seconds == 0


def test_generate_report_clips_hours_to_the_schedules_effective_range(db):
    # The headline bug: a schedule effective for ONE day inside a much wider
    # report window used to be billed for the whole window. Effective range is
    # exactly Jan 6 (a Tuesday); the report window spans two months and
    # contains eight Tuesdays. Unclipped, this schedule's weekly pattern would
    # be counted on all eight (64h). Clipped, only the one day it was actually
    # effective counts.
    schedule = create_schedule(
        name="One Day Only",
        start_date=date(2026, 1, 6),
        end_date=date(2026, 1, 6),
        shift_inputs=[ShiftInput(weekday=1, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    result = generate_report(ticket_start_at=datetime(2026, 1, 1, 0, 0, 0), ticket_end_at=datetime(2026, 3, 1, 0, 0, 0))

    row = next(r for r in result.agent_hours if r.agent_id == agent_id)
    assert row.business_seconds == 8 * 3600  # exactly the one Tuesday, not all eight


def test_generate_report_credits_the_full_window_for_a_schedule_spanning_it(db):
    # No-regression check: a schedule already effective for the ENTIRE report
    # window must get exactly the same total as before clipping existed --
    # the clip should be a no-op when there is nothing to clip.
    schedule = create_schedule(
        name="Long Runner",
        start_date=date(2025, 1, 1),
        end_date=None,  # ongoing
        shift_inputs=[ShiftInput(weekday=wd, start_time=timedelta(hours=9), end_time=timedelta(hours=17)) for wd in range(5)],
    )
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    # Monday 5 Jan 2026 00:00 -> the following Monday 00:00: one full Mon-Fri week.
    result = generate_report(ticket_start_at=datetime(2026, 1, 5, 0, 0, 0), ticket_end_at=datetime(2026, 1, 12, 0, 0, 0))

    row = next(r for r in result.agent_hours if r.agent_id == agent_id)
    assert row.business_seconds == 40 * 3600  # five 8h days, unclipped


def test_generate_report_clips_a_schedule_that_ends_mid_window(db):
    # The complementary case to the "starts mid-window" test above: a schedule
    # whose end_date falls partway through the window must stop counting
    # after it, not carry on to the window's own end.
    schedule = create_schedule(
        name="Ends Mid Window",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 6),  # ends the same Tuesday it starts covering
        shift_inputs=[ShiftInput(weekday=1, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    result = generate_report(ticket_start_at=datetime(2026, 1, 1, 0, 0, 0), ticket_end_at=datetime(2026, 3, 1, 0, 0, 0))

    row = next(r for r in result.agent_hours if r.agent_id == agent_id)
    assert row.business_seconds == 8 * 3600  # only the one Tuesday before end_date


def test_generate_report_handles_a_schedule_whose_effective_start_lands_exactly_at_the_window_end(db):
    # The edge case the fix specifically had to guard against: the coarse
    # day-level filter (get_active_agent_schedule_pairs) still matches this
    # schedule, but the exact datetime clip is empty -- the schedule's
    # effective start (that day's midnight) is not strictly before the
    # window's end. Before the guard, this would raise inside
    # calculate_business_seconds (window_end <= window_start) instead of
    # correctly reporting zero.
    schedule = create_schedule(
        name="Starts At The Wire",
        start_date=date(2026, 1, 10),
        end_date=None,
        shift_inputs=[ShiftInput(weekday=5, start_time=timedelta(hours=9), end_time=timedelta(hours=17))],
    )
    agent_id = _create_agent()
    assign_agent(schedule.id, agent_id)

    # Window ends AT the exact instant the schedule becomes effective.
    result = generate_report(ticket_start_at=datetime(2026, 1, 1, 0, 0, 0), ticket_end_at=datetime(2026, 1, 10, 0, 0, 0))

    row = next(r for r in result.agent_hours if r.agent_id == agent_id)
    assert row.business_seconds == 0  # not a crash, not a false credit


def test_generate_report_persists_and_is_retrievable(db):
    generated = generate_report(
        ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0)
    )

    fetched = get_report(generated.id)

    assert fetched.id == generated.id
    assert fetched.ticket_start_at == generated.ticket_start_at
    assert {r.agent_id for r in fetched.agent_hours} == {r.agent_id for r in generated.agent_hours}


def test_generate_report_rejects_end_before_start(db):
    with pytest.raises(ValueError, match="after"):
        generate_report(ticket_start_at=datetime(2026, 1, 6, 14, 0, 0), ticket_end_at=datetime(2026, 1, 6, 10, 0, 0))


def test_get_report_raises_not_found(db):
    with pytest.raises(NotFoundError):
        get_report(999)


def test_list_reports_returns_summaries(db):
    generate_report(ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0))

    result = list_reports(limit=10, offset=0)

    assert len(result) == 1


def test_report_windows_round_trip_as_ist_regardless_of_db_session_timezone(db):
    # The columns are timestamptz, so what psycopg returns depends on the DB
    # session's TimeZone. Pinning IST at the service boundary is what makes
    # generate and get agree -- and what keeps the wall-clock weekday/hour math
    # from shifting with the ambient timezone of whatever host runs the app.
    from app.domain.types import IST

    generated = generate_report(
        ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0)
    )
    fetched = get_report(generated.id)

    assert generated.ticket_start_at.utcoffset() == timedelta(hours=5, minutes=30)
    assert fetched.ticket_start_at.utcoffset() == timedelta(hours=5, minutes=30)
    assert fetched.ticket_start_at == datetime(2026, 1, 6, 10, 0, 0, tzinfo=IST)
    assert fetched.ticket_start_at == generated.ticket_start_at


def test_generate_report_logs_phase_durations(db, caplog):
    import logging

    with caplog.at_level(logging.INFO, logger="richpanel.report_service"):
        generate_report(ticket_start_at=datetime(2026, 1, 6, 10, 0, 0), ticket_end_at=datetime(2026, 1, 6, 14, 0, 0))

    records = [r for r in caplog.records if r.name == "richpanel.report_service"]
    assert len(records) == 1
    assert hasattr(records[0], "read_ms")
    assert hasattr(records[0], "compute_ms")
    assert hasattr(records[0], "write_ms")
    assert hasattr(records[0], "agent_count")
