# backend/tests/test_exception_handlers.py
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors.error import ConflictError, DomainValidationError, NotFoundError
from app.main import register_exception_handlers


def _build_test_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/not-found")
    def raise_not_found():
        raise NotFoundError("nope")

    @app.get("/conflict")
    def raise_conflict():
        raise ConflictError("nope")

    @app.get("/invalid")
    def raise_invalid():
        raise DomainValidationError("nope")

    @app.get("/boom")
    def raise_unexpected():
        raise RuntimeError("internal secret detail")

    return app


def test_not_found_error_maps_to_404():
    client = TestClient(_build_test_app())
    response = client.get("/not-found")
    assert response.status_code == 404
    assert response.json()["error_code"] == "not_found"


def test_conflict_error_maps_to_409():
    client = TestClient(_build_test_app())
    response = client.get("/conflict")
    assert response.status_code == 409


def test_domain_validation_error_maps_to_400():
    client = TestClient(_build_test_app())
    response = client.get("/invalid")
    assert response.status_code == 400


def test_unexpected_error_maps_to_500_without_leaking_detail():
    client = TestClient(_build_test_app(), raise_server_exceptions=False)
    response = client.get("/boom")
    assert response.status_code == 500
    assert "internal secret detail" not in response.text
