# backend/app/api/v1/reports/request_response.py
from datetime import datetime

from pydantic import BaseModel, model_validator

from app.domain.types import IST


class ReportGenerateRequest(BaseModel):
    ticket_start_at: datetime
    ticket_end_at: datetime

    @model_validator(mode="after")
    def _validate_window(self):
        if self.ticket_end_at <= self.ticket_start_at:
            raise ValueError("ticket_end_at must be after ticket_start_at")

        # A report answers "how many business hours did each agent have while
        # this ticket was open". A window extending into the future would take
        # hours nobody has worked yet and report them as though they had been --
        # scheduled capacity presented as history. The number would look
        # perfectly plausible and be wrong, which is the worst kind of wrong.
        #
        # Naive input is IST wall-clock (see app.domain.types.IST), so it is
        # compared against now() in the same zone rather than against UTC.
        now = datetime.now(IST)
        end = self.ticket_end_at
        end_ist = end.replace(tzinfo=IST) if end.tzinfo is None else end.astimezone(IST)
        if end_ist > now:
            raise ValueError(
                "a report window cannot extend into the future; "
                "ticket_end_at must not be later than the current time"
            )
        return self


class AgentHoursResponse(BaseModel):
    agent_id: int
    business_seconds: int


class ReportResponse(BaseModel):
    id: int
    ticket_start_at: datetime
    ticket_end_at: datetime
    agent_hours: list[AgentHoursResponse]
