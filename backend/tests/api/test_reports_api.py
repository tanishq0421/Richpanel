# backend/tests/api/test_reports_api.py
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.domain.types import IST
from app.main import app

client = TestClient(app)


def test_generate_report(db):
    response = client.post(
        "/api/v1/reports",
        json={"ticket_start_at": "2026-01-06T10:00:00", "ticket_end_at": "2026-01-06T14:00:00"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert "agent_hours" in body


def test_generate_report_rejects_end_before_start(db):
    response = client.post(
        "/api/v1/reports",
        json={"ticket_start_at": "2026-01-06T14:00:00", "ticket_end_at": "2026-01-06T10:00:00"},
    )

    # 422, not 400: this is request-shape validation and now happens in the
    # Pydantic model rather than deep in the service.
    assert response.status_code == 422
    assert response.json()["error_code"] == "validation_error"


def test_generate_report_rejects_a_window_ending_in_the_future(db):
    # A future window would take hours nobody has worked yet and report them as
    # though they had been -- scheduled capacity presented as history.
    future = datetime.now(IST) + timedelta(days=1)
    response = client.post(
        "/api/v1/reports",
        json={
            "ticket_start_at": (future - timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%S"),
            "ticket_end_at": future.strftime("%Y-%m-%dT%H:%M:%S"),
        },
    )

    assert response.status_code == 422
    assert "future" in response.json()["details"][0]["message"]


def test_generate_report_rejects_a_window_starting_in_the_future(db):
    start = datetime.now(IST) + timedelta(days=2)
    response = client.post(
        "/api/v1/reports",
        json={
            "ticket_start_at": start.strftime("%Y-%m-%dT%H:%M:%S"),
            "ticket_end_at": (start + timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%S"),
        },
    )

    assert response.status_code == 422


def test_generate_report_accepts_a_window_ending_moments_ago(db):
    # The boundary matters: a ticket resolved a minute ago must still report.
    end = datetime.now(IST) - timedelta(minutes=1)
    response = client.post(
        "/api/v1/reports",
        json={
            "ticket_start_at": (end - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S"),
            "ticket_end_at": end.strftime("%Y-%m-%dT%H:%M:%S"),
        },
    )

    assert response.status_code == 201, response.text


def test_list_and_get_report(db):
    create = client.post(
        "/api/v1/reports",
        json={"ticket_start_at": "2026-01-06T10:00:00", "ticket_end_at": "2026-01-06T14:00:00"},
    )
    report_id = create.json()["id"]

    list_response = client.get("/api/v1/reports")
    get_response = client.get(f"/api/v1/reports/{report_id}")

    assert list_response.status_code == 200
    assert any(r["id"] == report_id for r in list_response.json())
    assert get_response.status_code == 200
    assert get_response.json()["id"] == report_id


def test_get_missing_report_returns_404(db):
    response = client.get("/api/v1/reports/999")
    assert response.status_code == 404
