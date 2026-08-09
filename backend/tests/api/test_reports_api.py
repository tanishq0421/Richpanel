# backend/tests/api/test_reports_api.py
from fastapi.testclient import TestClient

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

    assert response.status_code == 400


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
