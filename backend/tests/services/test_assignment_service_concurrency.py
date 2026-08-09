# backend/tests/services/test_assignment_service_concurrency.py
"""Serialisation tests for the 'an agent is never on two schedules whose hours
overlap' invariant.

These run REAL threads on REAL separate connections. The invariant is enforced
by advisory locks inside the write transaction, so it cannot be exercised by
single-threaded tests: every check passes trivially when nothing runs
concurrently."""
import threading
import time
from datetime import date, timedelta

from app.components.agents.model import Agent
from app.components.schedule_agents import queries as schedule_agents_queries
from app.components.schedules import queries as schedules_queries
from app.db import db_session_write
from app.domain.overlap import find_overlaps
from app.domain.types import ShiftInput
from app.services._conversions import weekday_shift_from_row
from app.services.assignment_service import assign_agent
from app.services.schedule_service import create_schedule, update_schedule

START = date(2026, 1, 1)


def _create_agent(name="Agent") -> int:
    with db_session_write() as session:
        agent = Agent(name=name)
        session.add(agent)
        session.flush()
        return agent.id


def _shift(weekday: int, start: float, end: float) -> ShiftInput:
    return ShiftInput(weekday=weekday, start_time=timedelta(hours=start), end_time=timedelta(hours=end))


def _run_concurrently(*callables, timeout: float = 20.0) -> list[BaseException | None]:
    """Run each callable in its own thread, returning what each one raised (or
    None). Each service call opens its own session, so the threads genuinely
    contend on the database rather than sharing a transaction."""
    results: list[BaseException | None] = [None] * len(callables)

    def _target(index, fn):
        try:
            fn()
        except BaseException as exc:  # noqa: BLE001 - the failure IS the result
            results[index] = exc

    threads = [threading.Thread(target=_target, args=(i, fn)) for i, fn in enumerate(callables)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout)
        assert not thread.is_alive(), "thread did not finish -- likely blocked on a lock forever"
    return results


def _agent_overlaps(agent_id: int) -> list:
    """Every overlap across ALL of the agent's active schedules. The invariant
    says this must always be empty, whatever order concurrent writes ran in."""
    with db_session_write() as session:
        schedule_ids = schedule_agents_queries.get_other_active_schedule_ids_for_agent(session, agent_id)
        shift_sets = [
            [weekday_shift_from_row(r) for r in schedules_queries.get_weekday_hours_rows(session, sid)]
            for sid in schedule_ids
        ]
    return [
        overlap
        for i, a in enumerate(shift_sets)
        for b in shift_sets[i + 1 :]
        for overlap in find_overlaps(a, b)
    ]


def test_edit_racing_assign_cannot_leave_agent_on_two_overlapping_schedules(db, monkeypatch):
    """The race: editing a schedule's hours used to read its assignee list
    BEFORE taking any lock, so a schedule with no assignees locked nothing at
    all. A concurrent assign_agent could then add an agent, check that agent
    against the schedule's OLD (non-overlapping) hours, and commit -- while the
    edit committed hours that overlap one of the agent's other schedules. Both
    operations reported success and the invariant was broken.

    Neither path locked the SCHEDULE, so there was nothing to contend on."""
    other = create_schedule(name="Other", start_date=START, end_date=None, shift_inputs=[_shift(0, 9, 17)])
    target = create_schedule(name="Target", start_date=START, end_date=None, shift_inputs=[_shift(0, 18, 20)])
    agent_id = _create_agent()
    assign_agent(other.id, agent_id)  # legal today: 18:00-20:00 does not touch 09:00-17:00

    edit_is_mid_transaction = threading.Event()
    real_replace = schedules_queries.replace_weekday_hours_rows

    def _pause_then_replace(session, schedule_id, shifts):
        """Forces the interleave deterministically. By the time the edit reaches
        its write it has already taken every lock it is going to take and read
        its assignee list, which is precisely the window the assignment has to
        slip through. The sleep lives here in the test, not in production
        code."""
        edit_is_mid_transaction.set()
        time.sleep(0.5)
        return real_replace(session, schedule_id, shifts)

    monkeypatch.setattr(schedules_queries, "replace_weekday_hours_rows", _pause_then_replace)

    def _edit():
        # 10:00-16:00 collides head-on with `other`'s 09:00-17:00
        update_schedule(target.id, [_shift(0, 10, 16)])

    def _assign():
        assert edit_is_mid_transaction.wait(timeout=5), "edit never reached its write"
        assign_agent(target.id, agent_id)

    errors = _run_concurrently(_edit, _assign)

    assert _agent_overlaps(agent_id) == [], "agent ended up on two schedules with overlapping hours"
    assert len([e for e in errors if e is not None]) == 1, (
        f"exactly one of the two operations must fail, got errors={errors}"
    )


def test_concurrent_edits_of_the_same_schedule_do_not_deadlock(db):
    """Both paths take the schedule lock first, then agent locks in sorted
    agent_id order. Two editors of the same schedule therefore queue behind one
    another instead of interleaving their agent locks."""
    schedule = create_schedule(name="S", start_date=START, end_date=None, shift_inputs=[_shift(0, 9, 17)])
    first_agent = _create_agent("A")
    second_agent = _create_agent("B")
    assign_agent(schedule.id, first_agent)
    assign_agent(schedule.id, second_agent)

    errors = _run_concurrently(
        lambda: update_schedule(schedule.id, [_shift(0, 8, 12)]),
        lambda: update_schedule(schedule.id, [_shift(0, 13, 18)]),
    )

    assert errors == [None, None], f"concurrent edits of one schedule must both succeed, got {errors}"


def test_concurrent_edits_of_two_schedules_sharing_agents_do_not_deadlock(db):
    """The scenario that a naive lock order deadlocks on: two schedules holding
    their own schedule lock, both needing the SAME two agent locks. Sorting the
    agent ids gives every transaction the same acquisition order, so one simply
    waits for the other."""
    early = create_schedule(name="Early", start_date=START, end_date=None, shift_inputs=[_shift(0, 6, 8)])
    late = create_schedule(name="Late", start_date=START, end_date=None, shift_inputs=[_shift(0, 20, 22)])
    first_agent = _create_agent("A")
    second_agent = _create_agent("B")
    for schedule_id in (early.id, late.id):
        assign_agent(schedule_id, first_agent)
        assign_agent(schedule_id, second_agent)

    errors = _run_concurrently(
        lambda: update_schedule(early.id, [_shift(0, 5, 8)]),
        lambda: update_schedule(late.id, [_shift(0, 20, 23)]),
    )

    assert errors == [None, None], f"shared-agent edits must not deadlock, got {errors}"
