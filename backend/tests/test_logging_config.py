import json
import logging
import sys

from app.logging_config import JsonFormatter


def test_json_formatter_produces_valid_json_with_extra_fields():
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name="richpanel.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="something happened", args=(), exc_info=None,
    )
    record.duration_ms = 42.5
    record.schedule_id = 7

    parsed = json.loads(formatter.format(record))

    assert parsed["level"] == "INFO"
    assert parsed["logger"] == "richpanel.test"
    assert parsed["message"] == "something happened"
    assert parsed["duration_ms"] == 42.5
    assert parsed["schedule_id"] == 7
    assert "timestamp" in parsed


def test_json_formatter_includes_exception_info():
    formatter = JsonFormatter()
    try:
        raise ValueError("boom")
    except ValueError:
        record = logging.LogRecord(
            name="richpanel.test", level=logging.ERROR, pathname=__file__, lineno=1,
            msg="failed", args=(), exc_info=sys.exc_info(),
        )
    parsed = json.loads(formatter.format(record))
    assert "ValueError: boom" in parsed["exc_info"]
