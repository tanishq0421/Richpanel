# backend/app/main.py
import logging
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.v1.agents.router import router as agents_router
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


app = FastAPI(title="Richpanel Schedule & Resolution Time Report")
register_exception_handlers(app)
register_request_logging(app)

app.include_router(agents_router)


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}
