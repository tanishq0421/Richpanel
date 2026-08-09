# backend/tests/api/test_schedules_api.py
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


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
