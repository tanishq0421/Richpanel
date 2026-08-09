# backend/tests/test_request_logging.py
import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import register_request_logging


def _build_test_app() -> FastAPI:
    app = FastAPI()
    register_request_logging(app)

    @app.get("/ping")
    def ping():
        return {"pong": True}

    return app


def test_request_logging_records_method_path_status_and_duration(caplog):
    client = TestClient(_build_test_app())

    with caplog.at_level(logging.INFO, logger="richpanel.request"):
        response = client.get("/ping")

    assert response.status_code == 200
    records = [r for r in caplog.records if r.name == "richpanel.request"]
    assert len(records) == 1
    assert records[0].method == "GET"
    assert records[0].path == "/ping"
    assert records[0].status_code == 200
    assert isinstance(records[0].duration_ms, float)
