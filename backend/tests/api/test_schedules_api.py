# backend/tests/api/test_schedules_api.py
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.domain.types import IST
from app.main import app

client = TestClient(app)


def _day(offset: int) -> str:
    """A date `offset` days from today, as the API spells it.

    Derived rather than hardcoded: whether a start_date has elapsed is decided
    against today in IST, so a fixed literal would silently change meaning as
    CI's clock moves past it."""
    return (datetime.now(IST).date() + timedelta(days=offset)).isoformat()


def test_create_schedule(db):
    response = client.post(
        "/api/v1/schedules",
        json={
            "name": "Day Shift",
            "start_date": "2026-01-01",
            "end_date": None,
            "shifts": [{"weekday": 0, "start_hours": 9, "end_hours": 17}],
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Day Shift"
    assert body["shifts"] == [{"weekday": 0, "start_hours": 9.0, "end_hours": 17.0}]


def test_create_schedule_with_self_overlap_returns_409(db):
    response = client.post(
        "/api/v1/schedules",
        json={
            "name": "Broken",
            "start_date": "2026-01-01",
            "end_date": None,
            "shifts": [
                {"weekday": 0, "start_hours": 22, "end_hours": 6},
                {"weekday": 1, "start_hours": 5, "end_hours": 13},
            ],
        },
    )

    assert response.status_code == 409


def test_get_and_list_schedules(db):
    create = client.post(
        "/api/v1/schedules", json={"name": "A", "start_date": "2026-01-01", "end_date": None, "shifts": []}
    )
    schedule_id = create.json()["id"]

    get_response = client.get(f"/api/v1/schedules/{schedule_id}")
    list_response = client.get("/api/v1/schedules")

    assert get_response.status_code == 200
    assert get_response.json()["id"] == schedule_id
    assert list_response.status_code == 200
    assert any(s["id"] == schedule_id for s in list_response.json())


def _post_schedule(**overrides):
    payload = {"name": "S", "start_date": "2026-01-01", "end_date": None, "shifts": []}
    payload.update(overrides)
    return client.post("/api/v1/schedules", json=payload)


def test_zero_duration_shift_returns_422(db):
    # Previously a bare ValueError from the domain dataclass raised inside the
    # router body -> caught by the catch-all -> 500.
    response = _post_schedule(shifts=[{"weekday": 0, "start_hours": 9, "end_hours": 9}])
    assert response.status_code == 422
    assert response.json()["error_code"] == "validation_error"


def test_shift_ending_at_midnight_returns_422(db):
    response = _post_schedule(shifts=[{"weekday": 0, "start_hours": 22, "end_hours": 0}])
    assert response.status_code == 422


def test_shift_ending_at_the_day_boundary_is_accepted_and_round_trips(db):
    # end_hours=24 used to be blanket-rejected by the same `< 24` bound used
    # for start_hours, making an ordinary midnight-ending shift (distinct from
    # round-the-clock) inexpressible. 22:00->24:00 is a plain 2-hour shift.
    response = _post_schedule(shifts=[{"weekday": 0, "start_hours": 22, "end_hours": 24}])
    assert response.status_code == 201, response.text
    schedule_id = response.json()["id"]
    assert response.json()["shifts"] == [{"weekday": 0, "start_hours": 22.0, "end_hours": 24.0}]

    # And it survives a read back unchanged -- recombine_shifts must not
    # mistake this same-day shift for an overnight primary with a missing tail.
    get_response = client.get(f"/api/v1/schedules/{schedule_id}")
    assert get_response.json()["shifts"] == [{"weekday": 0, "start_hours": 22.0, "end_hours": 24.0}]


def test_round_the_clock_via_start_zero_end_24_returns_422(db):
    # start_hours == end_hours (e.g. 9 == 9) already covers most spellings of
    # round-the-clock; 0/24 is the one pair that widening end_hours to 24
    # would otherwise sneak past that check, since 0 != 24 as numbers.
    response = _post_schedule(shifts=[{"weekday": 0, "start_hours": 0, "end_hours": 24}])
    assert response.status_code == 422
    assert "round-the-clock" in response.text


def test_end_date_before_start_date_returns_422(db):
    # Previously only the database CHECK caught this -> IntegrityError -> 500.
    response = _post_schedule(start_date="2026-06-01", end_date="2026-01-01")
    assert response.status_code == 422


def test_two_windows_on_the_same_weekday_returns_422(db):
    # Split shifts are deliberately unsupported. find_self_overlaps does NOT
    # catch this (the two windows don't overlap), so it previously reached the
    # partial unique index and 500'd.
    response = _post_schedule(
        shifts=[
            {"weekday": 0, "start_hours": 9, "end_hours": 12},
            {"weekday": 0, "start_hours": 14, "end_hours": 18},
        ]
    )
    assert response.status_code == 422


def test_empty_name_returns_422(db):
    assert _post_schedule(name="").status_code == 422


def test_validation_error_body_names_the_offending_field(db):
    # The UI maps each failure back onto its form control, so `field` must be
    # addressable within the request payload.
    response = _post_schedule(shifts=[{"weekday": 9, "start_hours": 9, "end_hours": 17}])
    assert response.status_code == 422
    body = response.json()
    assert body["error_code"] == "validation_error"
    assert body["details"], "422 body must carry field-level details"
    assert any("shifts" in detail["field"] for detail in body["details"])


def test_get_missing_schedule_returns_404(db):
    response = client.get("/api/v1/schedules/999")
    assert response.status_code == 404


def test_update_schedule_hours(db):
    create = client.post(
        "/api/v1/schedules",
        json={
            "name": "A",
            "start_date": "2026-01-01",
            "end_date": None,
            "shifts": [{"weekday": 0, "start_hours": 9, "end_hours": 17}],
        },
    )
    schedule_id = create.json()["id"]

    response = client.put(
        f"/api/v1/schedules/{schedule_id}",
        json={"shifts": [{"weekday": 0, "start_hours": 8, "end_hours": 16}]},
    )

    assert response.status_code == 200
    assert response.json()["shifts"] == [{"weekday": 0, "start_hours": 8.0, "end_hours": 16.0}]


def _create_for_edit(**overrides) -> int:
    payload = {"name": "S", "start_date": _day(-30), "end_date": _day(30), "shifts": []}
    payload.update(overrides)
    response = client.post("/api/v1/schedules", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _put(schedule_id: int, **body):
    return client.put(f"/api/v1/schedules/{schedule_id}", json={"shifts": [], **body})


def test_extending_end_date_succeeds_and_persists(db):
    # The headline case: "this schedule should run longer than we first said".
    schedule_id = _create_for_edit()

    response = _put(schedule_id, end_date=_day(365))

    assert response.status_code == 200, response.text
    assert response.json()["end_date"] == _day(365)
    assert client.get(f"/api/v1/schedules/{schedule_id}").json()["end_date"] == _day(365)


def test_clearing_end_date_to_null_makes_the_schedule_ongoing(db):
    schedule_id = _create_for_edit()

    response = _put(schedule_id, end_date=None)

    assert response.status_code == 200, response.text
    assert response.json()["end_date"] is None
    assert client.get(f"/api/v1/schedules/{schedule_id}").json()["end_date"] is None


def test_omitting_end_date_leaves_it_unchanged(db):
    # The other half of the same distinction: an ABSENT end_date must not be
    # read as the null above, or every hours-only edit would silently wipe the
    # schedule's end date.
    schedule_id = _create_for_edit(end_date=_day(30))

    response = _put(schedule_id)

    assert response.status_code == 200, response.text
    assert response.json()["end_date"] == _day(30)


def test_end_date_before_start_date_on_update_returns_422(db):
    schedule_id = _create_for_edit(start_date=_day(-30))

    response = _put(schedule_id, start_date=_day(-30), end_date=_day(-60))

    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "validation_error"


def test_changing_an_elapsed_start_date_is_rejected(db):
    schedule_id = _create_for_edit(start_date=_day(-30))

    response = _put(schedule_id, start_date=_day(-10))

    assert response.status_code == 400, response.text
    assert response.json()["error_code"] == "validation_error"
    message = response.json()["message"]
    assert "start_date" in message and "already begun" in message


def test_a_start_date_of_today_is_already_frozen(db):
    # The boundary: the period has begun the moment the day starts in IST.
    schedule_id = _create_for_edit(start_date=_day(0))

    assert _put(schedule_id, start_date=_day(7)).status_code == 400


def test_moving_a_future_start_date_into_the_past_is_rejected(db):
    # The gap a review pass found: the elapsed-check above only protects the
    # STORED start_date. A schedule that hasn't begun yet (still safely
    # editable) could previously be given a NEW start_date that is itself in
    # the past -- silently defeating "editable only while still in the future"
    # via the value being written, not the value being overwritten.
    schedule_id = _create_for_edit(start_date=_day(10))

    response = _put(schedule_id, start_date=_day(-5))

    assert response.status_code == 400, response.text
    assert response.json()["error_code"] == "validation_error"
    message = response.json()["message"]
    assert "start_date" in message and "past" in message
    # Nothing was written.
    assert client.get(f"/api/v1/schedules/{schedule_id}").json()["start_date"] == _day(10)


def test_moving_a_future_start_date_to_today_succeeds(db):
    # Today is the boundary, not "in the past" -- must remain a valid target.
    schedule_id = _create_for_edit(start_date=_day(10))

    response = _put(schedule_id, start_date=_day(0))

    assert response.status_code == 200, response.text
    assert response.json()["start_date"] == _day(0)


def test_resending_the_same_elapsed_start_date_alongside_a_new_end_date_succeeds(db):
    # An unchanged field is not a change. A naive implementation rejects this
    # and makes the endpoint unusable for every schedule that has begun --
    # which is most of them, since clients post the whole form back.
    schedule_id = _create_for_edit(start_date=_day(-30), end_date=_day(30))

    response = _put(schedule_id, start_date=_day(-30), end_date=_day(90))

    assert response.status_code == 200, response.text
    assert response.json()["start_date"] == _day(-30)
    assert response.json()["end_date"] == _day(90)


def test_changing_a_still_future_start_date_succeeds(db):
    schedule_id = _create_for_edit(start_date=_day(10), end_date=None)

    response = _put(schedule_id, start_date=_day(20))

    assert response.status_code == 200, response.text
    assert response.json()["start_date"] == _day(20)
    assert client.get(f"/api/v1/schedules/{schedule_id}").json()["start_date"] == _day(20)


def test_renaming_a_schedule_succeeds_and_persists(db):
    schedule_id = _create_for_edit(name="Old Name")

    response = _put(schedule_id, name="New Name")

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "New Name"
    assert client.get(f"/api/v1/schedules/{schedule_id}").json()["name"] == "New Name"


def test_renaming_to_an_empty_name_returns_422(db):
    schedule_id = _create_for_edit()
    assert _put(schedule_id, name="").status_code == 422


def test_explicitly_nulling_a_non_nullable_field_returns_422(db):
    # Both columns are NOT NULL, so null must be named as a 422 rather than
    # reaching the database and coming back as a 500.
    schedule_id = _create_for_edit()
    assert _put(schedule_id, name=None).status_code == 422
    assert _put(schedule_id, start_date=None).status_code == 422


def test_editing_hours_alongside_the_dates_still_replaces_the_hours(db):
    schedule_id = _create_for_edit(shifts=[{"weekday": 0, "start_hours": 9, "end_hours": 17}])

    response = client.put(
        f"/api/v1/schedules/{schedule_id}",
        json={"shifts": [{"weekday": 1, "start_hours": 8, "end_hours": 16}], "name": "Renamed"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["shifts"] == [{"weekday": 1, "start_hours": 8.0, "end_hours": 16.0}]
    assert response.json()["name"] == "Renamed"


def test_deletion_impact_and_delete(db):
    create = client.post(
        "/api/v1/schedules", json={"name": "A", "start_date": "2026-01-01", "end_date": None, "shifts": []}
    )
    schedule_id = create.json()["id"]

    impact_response = client.get(f"/api/v1/schedules/{schedule_id}/deletion-impact")
    delete_response = client.delete(f"/api/v1/schedules/{schedule_id}")
    get_after_delete = client.get(f"/api/v1/schedules/{schedule_id}")

    assert impact_response.status_code == 200
    assert impact_response.json()["affected_agent_ids"] == []
    assert delete_response.status_code == 204
    assert get_after_delete.status_code == 404
