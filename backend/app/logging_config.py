import json
import logging

_STANDARD_RECORD_ATTRS = set(
    logging.LogRecord(name="", level=0, pathname="", lineno=0, msg="", args=(), exc_info=None).__dict__.keys()
)


class JsonFormatter(logging.Formatter):
    """Emits one JSON object per log line. Any field passed via
    logger.info(msg, extra={...}) is merged into the top-level payload, not
    buried in an unparsed string -- this is what makes duration_ms,
    schedule_id, agent_id etc. queryable in log tooling."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = {k: v for k, v in record.__dict__.items() if k not in _STANDARD_RECORD_ATTRS}
        payload.update(extra)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
