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
