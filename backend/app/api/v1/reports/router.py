# backend/app/api/v1/reports/router.py
from fastapi import APIRouter, Depends, status

from app.api.v1.reports.request_response import AgentHoursResponse, ReportGenerateRequest, ReportResponse
from app.errors.error import DomainValidationError
from app.services import report_service
from app.shared.pagination import PaginationParams

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])


def _to_response(result: report_service.ReportResult) -> ReportResponse:
    return ReportResponse(
        id=result.id,
        ticket_start_at=result.ticket_start_at,
        ticket_end_at=result.ticket_end_at,
        agent_hours=[
            AgentHoursResponse(agent_id=r.agent_id, business_seconds=r.business_seconds) for r in result.agent_hours
        ],
    )


@router.post("", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def generate_report(request: ReportGenerateRequest):
    try:
        result = report_service.generate_report(request.ticket_start_at, request.ticket_end_at)
    except ValueError as exc:
        raise DomainValidationError(str(exc)) from exc
    return _to_response(result)


@router.get("", response_model=list[ReportResponse])
def list_reports(pagination: PaginationParams = Depends()):
    results = report_service.list_reports(pagination.limit, pagination.offset)
    return [_to_response(r) for r in results]


@router.get("/{report_id}", response_model=ReportResponse)
def get_report(report_id: int):
    return _to_response(report_service.get_report(report_id))
