# backend/app/main.py
import logging
import os
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.agents.router import router as agents_router
from app.api.v1.reports.router import router as reports_router
from app.api.v1.schedule_agents.router import router as schedule_agents_router
from app.api.v1.schedules.router import router as schedules_router
from app.errors.error import AppError, ConflictError, DomainValidationError, NotFoundError
from app.logging_config import configure_logging

configure_logging()

logger = logging.getLogger("richpanel")
request_logger = logging.getLogger("richpanel.request")

STATUS_BY_ERROR_TYPE = [
    (NotFoundError, 404, "not_found"),
    (ConflictError, 409, "conflict"),
    (DomainValidationError, 400, "validation_error"),
]


def register_exception_handlers(app: FastAPI) -> None:
    for error_type, status_code, error_code in STATUS_BY_ERROR_TYPE:

        def _make_handler(status_code=status_code, error_code=error_code):
            async def _handler(request: Request, exc: AppError):
                return JSONResponse(status_code=status_code, content={"error_code": error_code, "message": str(exc)})

            return _handler

        app.add_exception_handler(error_type, _make_handler())

    @app.exception_handler(RequestValidationError)
    async def _validation_error_handler(request: Request, exc: RequestValidationError):
        """FastAPI's native 422 body is `{"detail": [...]}` — a different shape
        from the `{"error_code", "message"}` envelope every other error uses.
        Normalising it here means the UI parses ONE error shape, and can still
        map each failure back onto the form control that caused it via `field`."""
        details = [
            {
                # Drop the leading "body"/"query" segment: the client cares about
                # the field path within its own payload, not FastAPI's location
                # tuple. `shifts.0.start_hours` is directly addressable in a form.
                "field": ".".join(str(part) for part in error["loc"][1:]) or ".".join(str(p) for p in error["loc"]),
                "message": error["msg"],
                "type": error["type"],
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error_code": "validation_error",
                "message": "request validation failed",
                "details": details,
            },
        )

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(request: Request, exc: Exception):
        logger.error(
            "unhandled exception",
            extra={"method": request.method, "path": request.url.path},
            exc_info=exc,
        )
        return JSONResponse(
            status_code=500, content={"error_code": "internal_error", "message": "internal server error"}
        )


def register_request_logging(app: FastAPI) -> None:
    @app.middleware("http")
    async def _log_requests(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        request_logger.info(
            "request handled",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        return response


def register_cors(app: FastAPI) -> None:
    """The UI is served from its own container on its own port, so every browser
    call to this API is cross-origin. Without this the browser blocks the
    response before any application code runs — the API simply appears dead to
    the UI. Origins are enumerated rather than wildcarded: `*` is incompatible
    with credentialed requests, and an explicit list is the safer default for a
    tool holding operational data."""
    raw = os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    origins = [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )


app = FastAPI(title="Richpanel Schedule & Resolution Time Report")
register_cors(app)
register_exception_handlers(app)
register_request_logging(app)

app.include_router(agents_router)
app.include_router(schedules_router)
app.include_router(schedule_agents_router)
app.include_router(reports_router)


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}
