from fastapi import FastAPI

from app.logging_config import configure_logging

configure_logging()

app = FastAPI(title="Richpanel Schedule & Resolution Time Report")


@app.get("/health")
def health_check() -> dict:
    return {"status": "ok"}
